use std::collections::HashMap;
use std::sync::Arc;

use anyhow::anyhow;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::warn;
use uuid::Uuid;

use crate::config::{DEFAULT_COLS, DEFAULT_ROWS};
use crate::state::{
    AppState, bool_flag, default_session_command, host_from_selector, mark_session_status,
};
use crate::terminal_manager::{ManagedTerminal, TerminalEvent, TerminalSpec};
use crate::validation::{validate_selector, validate_size};

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    session_id: Option<String>,
    name: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    restart: Option<String>,
    replay: Option<String>,
    tab_id: Option<String>,
    pane_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum TerminalClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    RestartPolicy { enabled: bool },
    SessionPlacement { tab_id: String, pane_id: String },
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

struct TerminalAttachTarget {
    spec: TerminalSpec,
    allow_spawn: bool,
    replay: bool,
}

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
    let target = resolve_terminal_target(&state, &query)?;
    let ready_cols = target.spec.cols;
    let ready_rows = target.spec.rows;
    let terminal = state.terminals.open(target.spec, target.allow_spawn)?;
    mark_session_status(&state, terminal.session_id(), "running");

    let (mut sender, mut receiver) = socket.split();
    send_control(
        &mut sender,
        &TerminalServerMessage::Ready {
            session_id: terminal.session_id(),
            selector: terminal.selector(),
            cols: ready_cols,
            rows: ready_rows,
        },
    )
    .await?;

    if target.replay {
        let (frames, _) = terminal.replay_snapshot();
        for frame in frames {
            if sender
                .send(Message::Binary(frame.data.into()))
                .await
                .is_err()
            {
                return Ok(());
            }
        }
    }

    let mut event_rx = terminal.subscribe();
    loop {
        tokio::select! {
            event = event_rx.recv() => {
                match event {
                    Ok(TerminalEvent::Output(frame)) => {
                        if sender.send(Message::Binary(frame.data.into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(TerminalEvent::Exit(info)) => {
                        mark_session_status(&state, terminal.session_id(), "exited");
                        state.terminals.forget(terminal.session_id());
                        send_control(
                            &mut sender,
                            &TerminalServerMessage::ProcessExit {
                                exit_code: info.exit_code,
                                message: info.message,
                            },
                        )
                        .await?;
                        break;
                    }
                    Ok(TerminalEvent::Error(message)) => {
                        send_control(&mut sender, &TerminalServerMessage::Error { message }).await?;
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            Some(message) = receiver.next() => {
                match message? {
                    Message::Binary(data) => {
                        terminal.write_input(data.to_vec());
                    }
                    Message::Text(text) => {
                        if !handle_terminal_control_message(&state, &text, &terminal)? {
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

    Ok(())
}

fn handle_terminal_control_message(
    state: &AppState,
    text: &str,
    terminal: &ManagedTerminal,
) -> anyhow::Result<bool> {
    if let Some(rest) = text.strip_prefix("resize:") {
        let (cols, rows) = parse_resize_payload(rest)?;
        terminal.resize(cols, rows)?;
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
            terminal.resize(cols, rows)?;
            Ok(true)
        }
        Ok(TerminalClientMessage::RestartPolicy { enabled }) => {
            set_session_restartable(state, terminal.session_id(), enabled)?;
            Ok(true)
        }
        Ok(TerminalClientMessage::SessionPlacement { tab_id, pane_id }) => {
            set_session_placement(state, terminal.session_id(), &tab_id, &pane_id)?;
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
) -> anyhow::Result<TerminalAttachTarget> {
    let restart = parse_query_bool(query.restart.as_deref(), "restart")?;
    let replay = parse_query_bool(query.replay.as_deref(), "replay")?.unwrap_or(true);
    if let Some(session_id) = query
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let mut snapshot = None;
        let (spec, status) = {
            let mut sessions = state
                .sessions
                .write()
                .map_err(|_| anyhow!("session store lock poisoned"))?;
            let session = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("unknown session id"))?;
            let cols = query.cols.unwrap_or(session.cols);
            let rows = query.rows.unwrap_or(session.rows);
            validate_size(cols, rows)?;
            if let Some(restartable) = restart {
                session.set_restartable(restartable);
            }
            if let Some(tab_id) = metadata_value(query.tab_id.as_deref()) {
                session.metadata.insert("tabId".to_owned(), tab_id);
            }
            if let Some(pane_id) = metadata_value(query.pane_id.as_deref()) {
                session.metadata.insert("paneId".to_owned(), pane_id);
            }
            let spec = session.terminal_spec(cols, rows);
            let status = session.status.clone();
            if restart.is_some() || query.tab_id.is_some() || query.pane_id.is_some() {
                snapshot = Some(sessions.clone());
            }
            (spec, status)
        };
        if let Some(snapshot) = snapshot {
            state.persist_sessions_snapshot(&snapshot)?;
        }
        return Ok(TerminalAttachTarget {
            spec,
            allow_spawn: restart.unwrap_or(false) || status == "running",
            replay,
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
    let host = host_from_selector(selector);
    let (command, args) = default_session_command(selector);
    Ok(TerminalAttachTarget {
        spec: TerminalSpec {
            session_id: Uuid::new_v4().to_string(),
            host,
            selector: selector.to_owned(),
            command,
            args,
            cols,
            rows,
        },
        allow_spawn: true,
        replay,
    })
}

fn set_session_restartable(
    state: &AppState,
    session_id: &str,
    restartable: bool,
) -> anyhow::Result<()> {
    let snapshot = {
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| anyhow!("session store lock poisoned"))?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("unknown session id"))?;
        session.set_restartable(restartable);
        sessions.clone()
    };
    state.persist_sessions_snapshot(&snapshot)?;
    Ok(())
}

fn set_session_placement(
    state: &AppState,
    session_id: &str,
    tab_id: &str,
    pane_id: &str,
) -> anyhow::Result<()> {
    let mut metadata = HashMap::new();
    if let Some(tab_id) = metadata_value(Some(tab_id)) {
        metadata.insert("tabId".to_owned(), tab_id);
    }
    if let Some(pane_id) = metadata_value(Some(pane_id)) {
        metadata.insert("paneId".to_owned(), pane_id);
    }
    if metadata.is_empty() {
        return Ok(());
    }
    let snapshot = {
        let mut sessions = state
            .sessions
            .write()
            .map_err(|_| anyhow!("session store lock poisoned"))?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("unknown session id"))?;
        session.metadata.extend(metadata);
        sessions.clone()
    };
    state.persist_sessions_snapshot(&snapshot)?;
    Ok(())
}

fn metadata_value(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    Some(value.to_owned())
}

fn parse_query_bool(value: Option<&str>, name: &str) -> anyhow::Result<Option<bool>> {
    value
        .map(|value| bool_flag(value).ok_or_else(|| anyhow!("{name} must be a boolean")))
        .transpose()
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
