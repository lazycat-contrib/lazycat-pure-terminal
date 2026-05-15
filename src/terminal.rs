use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context as AnyhowContext, anyhow};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{debug, warn};
use uuid::Uuid;

use crate::config::{DEFAULT_COLS, DEFAULT_ROWS, LIGHTOSCTL};
use crate::state::{AppState, mark_session_status};
use crate::validation::{validate_selector, validate_size};

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    session_id: Option<String>,
    name: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum TerminalServerMessage<'a> {
    Ready {
        session_id: &'a str,
        selector: &'a str,
        cols: u16,
        rows: u16,
    },
    Error {
        message: String,
    },
    ProcessExit {
        exit_code: i32,
        message: Option<String>,
    },
}

enum PtyEvent {
    Output(Vec<u8>),
    Exit {
        exit_code: i32,
        message: Option<String>,
    },
    Error(String),
}

enum WriterCommand {
    Input(Vec<u8>),
    Close,
}

struct TerminalTarget {
    session_id: String,
    selector: String,
    cols: u16,
    rows: u16,
}

type SpawnedTerminal = (
    Box<dyn MasterPty + Send>,
    std::sync::mpsc::Sender<WriterCommand>,
    mpsc::UnboundedReceiver<PtyEvent>,
    Box<dyn portable_pty::ChildKiller + Send + Sync>,
);

pub async fn terminal_ws(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<TerminalQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "invalid websocket origin").into_response();
    }

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_terminal_socket(socket, state, query).await {
            warn!(error = %err, "terminal websocket ended with error");
        }
    })
}

async fn handle_terminal_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    query: TerminalQuery,
) -> anyhow::Result<()> {
    let terminal = resolve_terminal_target(&state, &query)?;
    let (master, writer_tx, mut event_rx, killer) = spawn_terminal(&terminal)?;
    let master = Arc::new(Mutex::new(master));

    let (mut sender, mut receiver) = socket.split();
    send_control(
        &mut sender,
        &TerminalServerMessage::Ready {
            session_id: &terminal.session_id,
            selector: &terminal.selector,
            cols: terminal.cols,
            rows: terminal.rows,
        },
    )
    .await?;

    let mut killer = Some(killer);
    loop {
        tokio::select! {
            Some(event) = event_rx.recv() => {
                match event {
                    PtyEvent::Output(data) => {
                        if sender.send(Message::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    PtyEvent::Exit { exit_code, message } => {
                        send_control(&mut sender, &TerminalServerMessage::ProcessExit { exit_code, message }).await?;
                        break;
                    }
                    PtyEvent::Error(message) => {
                        send_control(&mut sender, &TerminalServerMessage::Error { message }).await?;
                        break;
                    }
                }
            }
            Some(message) = receiver.next() => {
                match message? {
                    Message::Binary(data) => {
                        let _ = writer_tx.send(WriterCommand::Input(data.to_vec()));
                    }
                    Message::Text(text) => {
                        if !handle_terminal_control_message(&text, &master)? {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        let _ = sender.send(Message::Pong(payload)).await;
                    }
                    Message::Pong(_) => {}
                }
            }
            else => break,
        }
    }

    let _ = writer_tx.send(WriterCommand::Close);
    if let Some(mut child_killer) = killer.take()
        && let Err(err) = child_killer.kill()
    {
        debug!(error = %err, "terminal child was already closed");
    }
    mark_session_status(&state, &terminal.session_id, "closed");
    Ok(())
}

fn handle_terminal_control_message(
    text: &str,
    master: &Arc<Mutex<Box<dyn MasterPty + Send>>>,
) -> anyhow::Result<bool> {
    if let Some(rest) = text.strip_prefix("resize:") {
        let (cols, rows) = parse_resize_payload(rest)?;
        resize_pty(master, cols, rows)?;
        return Ok(true);
    }

    match serde_json::from_str::<TerminalClientMessage>(text) {
        Ok(TerminalClientMessage::Input { data }) => {
            let _ = data;
            warn!(
                "ignored JSON terminal input message; terminal input must use binary websocket frames"
            );
            Ok(true)
        }
        Ok(TerminalClientMessage::Resize { cols, rows }) => {
            resize_pty(master, cols, rows)?;
            Ok(true)
        }
        Ok(TerminalClientMessage::Close) => Ok(false),
        Err(_) => {
            warn!(message = ?text, "ignored non-control websocket text frame");
            Ok(true)
        }
    }
}

fn parse_resize_payload(rest: &str) -> anyhow::Result<(u16, u16)> {
    let (cols, rows) = rest
        .split_once(',')
        .ok_or_else(|| anyhow!("resize message must be resize:<cols>,<rows>"))?;
    let cols = cols.trim().parse::<u16>()?;
    let rows = rows.trim().parse::<u16>()?;
    validate_size(cols, rows)?;
    Ok((cols, rows))
}

fn resize_pty(
    master: &Arc<Mutex<Box<dyn MasterPty + Send>>>,
    cols: u16,
    rows: u16,
) -> anyhow::Result<()> {
    validate_size(cols, rows)?;
    let master = master.lock().map_err(|_| anyhow!("pty lock poisoned"))?;
    master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    Ok(())
}

async fn send_control(
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    message: &TerminalServerMessage<'_>,
) -> anyhow::Result<()> {
    let text = serde_json::to_string(message)?;
    sender.send(Message::Text(text.into())).await?;
    Ok(())
}

fn resolve_terminal_target(
    state: &AppState,
    query: &TerminalQuery,
) -> anyhow::Result<TerminalTarget> {
    if let Some(session_id) = query
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let sessions = state
            .sessions
            .read()
            .map_err(|_| anyhow!("session store lock poisoned"))?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("unknown session id"))?;
        let cols = query.cols.unwrap_or(session.cols);
        let rows = query.rows.unwrap_or(session.rows);
        validate_size(cols, rows)?;
        return Ok(TerminalTarget {
            session_id: session.id.clone(),
            selector: session.selector.clone(),
            cols,
            rows,
        });
    }

    let selector = query
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("name or session_id is required"))?;
    validate_selector(selector).map_err(|err| anyhow!(err.message.unwrap_or_default()))?;
    let cols = query.cols.unwrap_or(DEFAULT_COLS);
    let rows = query.rows.unwrap_or(DEFAULT_ROWS);
    validate_size(cols, rows)?;
    Ok(TerminalTarget {
        session_id: Uuid::new_v4().to_string(),
        selector: selector.to_owned(),
        cols,
        rows,
    })
}

fn spawn_terminal(target: &TerminalTarget) -> anyhow::Result<SpawnedTerminal> {
    let pty_system = NativePtySystem::default();
    let pair = pty_system.openpty(PtySize {
        rows: target.rows,
        cols: target.cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut command = CommandBuilder::new(LIGHTOSCTL);
    command.arg("exec");
    command.arg("-ti");
    command.arg(&target.selector);
    command.arg("/bin/sh");
    command.arg("-lc");
    command.arg(shell_bootstrap_script());
    command.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(command)
        .with_context(|| format!("failed to start {LIGHTOSCTL} exec"))?;
    let killer = child.clone_killer();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let (writer_tx, writer_rx) = std::sync::mpsc::channel::<WriterCommand>();
    let (event_tx, event_rx) = mpsc::unbounded_channel::<PtyEvent>();

    let output_tx = event_tx.clone();
    thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if output_tx.send(PtyEvent::Output(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = output_tx.send(PtyEvent::Error(err.to_string()));
                    break;
                }
            }
        }
    });

    thread::spawn(move || {
        for command in writer_rx {
            match command {
                WriterCommand::Input(data) => {
                    if let Err(err) = writer.write_all(&data) {
                        warn!(error = %err, "failed to write terminal input");
                        break;
                    }
                    if let Err(err) = writer.flush() {
                        warn!(error = %err, "failed to flush terminal input");
                        break;
                    }
                }
                WriterCommand::Close => break,
            }
        }
    });

    thread::spawn(move || {
        let result = child.wait();
        let event = match result {
            Ok(status) => PtyEvent::Exit {
                exit_code: i32::try_from(status.exit_code()).unwrap_or(i32::MAX),
                message: status.signal().map(ToOwned::to_owned),
            },
            Err(err) => PtyEvent::Exit {
                exit_code: -1,
                message: Some(err.to_string()),
            },
        };
        let _ = event_tx.send(event);
    });

    Ok((pair.master, writer_tx, event_rx, killer))
}

fn shell_bootstrap_script() -> &'static str {
    "if [ -f /run/catlink/shell-env.sh ]; then . /run/catlink/shell-env.sh; fi\nexec \"${SHELL:-/bin/sh}\""
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return true;
    };
    let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    origin
        .parse::<Uri>()
        .ok()
        .and_then(|uri| uri.authority().map(|authority| authority.as_str() == host))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use axum::http::header::{HOST, ORIGIN};
    use axum::http::{HeaderMap, HeaderValue};

    use super::origin_allowed;

    #[test]
    fn validates_origin_host_match() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("example.test"));
        headers.insert(ORIGIN, HeaderValue::from_static("https://example.test"));
        assert!(origin_allowed(&headers));

        headers.insert(ORIGIN, HeaderValue::from_static("https://other.test"));
        assert!(!origin_allowed(&headers));
    }
}
