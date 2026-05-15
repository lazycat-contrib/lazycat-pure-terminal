#![allow(refining_impl_trait)]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::thread;
use std::time::Duration;

use anyhow::{Context as AnyhowContext, anyhow};
use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, HOST, ORIGIN};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get};
use buffa::MessageField;
use connectrpc::{
    ConnectError, RequestContext, Response as ConnectResponse, Router as ConnectRouter,
    ServiceResult,
};
use futures::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;
use tracing::{debug, info, warn};
use uuid::Uuid;

#[allow(clippy::all, clippy::pedantic, warnings)]
pub mod proto {
    connectrpc::include_generated!();
}

mod embedded_frontend {
    include!(concat!(env!("OUT_DIR"), "/frontend_assets.rs"));
}

use proto::lazycat::webshell::v1::{
    Capability, CapabilityService, CapabilityServiceExt, CloseSessionResponse,
    ConfigurePluginResponse, ControlLease, CreateSessionResponse, GetProviderResponse, Instance,
    InvokePluginResponse, ListInstancesResponse, ListPluginsResponse, ListSessionsResponse,
    OwnedCloseSessionRequestView, OwnedConfigurePluginRequestView, OwnedCreateSessionRequestView,
    OwnedGetProviderRequestView, OwnedInvokePluginRequestView, OwnedListInstancesRequestView,
    OwnedListPluginsRequestView, OwnedListSessionsRequestView, OwnedReleaseControlRequestView,
    OwnedRequestControlRequestView, PluginDescriptor, ProviderDescriptor, ReleaseControlResponse,
    RequestControlResponse, Session,
};

const APP_ID: &str = "cloud.lazycat.webshell.pure-terminal";
const APP_NAME: &str = "Pure Terminal";
const LIGHTOSCTL: &str = "/lzcinit/lightosctl";
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 32;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 200;
const MAX_FONT_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_FONT_DIR: &str = "/lzcapp/var/fonts";

#[derive(Clone)]
struct AppState {
    sessions: Arc<RwLock<HashMap<String, SessionRecord>>>,
    plugins: Arc<RwLock<HashMap<String, PluginRecord>>>,
}

#[derive(Clone, Debug)]
struct SessionRecord {
    id: String,
    selector: String,
    status: String,
    cols: u16,
    rows: u16,
    control: Option<ControlLease>,
    metadata: HashMap<String, String>,
}

#[derive(Clone, Debug)]
struct PluginRecord {
    id: String,
    kind: String,
    display_name: String,
    description: String,
    scopes: Vec<String>,
    accepted_content_types: Vec<String>,
    produced_content_types: Vec<String>,
    input_schema_json: String,
    output_schema_json: String,
    enabled: bool,
    metadata: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    session_id: Option<String>,
    name: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Debug, Deserialize)]
struct LightOsInstance {
    #[serde(default)]
    name: String,
    #[serde(default)]
    owner_deploy_id: String,
    #[serde(default)]
    status: String,
}

#[derive(Debug, Deserialize)]
struct FontUploadQuery {
    filename: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontMetadata {
    id: String,
    label: String,
    family: String,
    mime_type: String,
    size: u64,
    filename: String,
    extension: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FontDescriptor {
    id: String,
    label: String,
    family: String,
    mime_type: String,
    size: u64,
    url: String,
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lazycat_pure_terminal=info,tower_http=info".into()),
        )
        .init();

    let state = Arc::new(AppState {
        sessions: Arc::new(RwLock::new(HashMap::new())),
        plugins: Arc::new(RwLock::new(builtin_plugins())),
    });

    let service = Arc::new(CapabilityServiceImpl {
        state: Arc::clone(&state),
    });
    let connect = service.register(ConnectRouter::new()).into_axum_router();

    let app = Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/healthz", get(|| async { "ok" }))
        .route("/ws/terminal", get(terminal_ws))
        .route("/assets/{*path}", get(frontend_asset))
        .route("/api/fonts", get(list_fonts).post(upload_font))
        .route("/api/fonts/{id}", delete(delete_font))
        .route("/api/fonts/{id}/file", get(font_file))
        .with_state(state)
        .merge(connect)
        .layer(DefaultBodyLimit::max(MAX_FONT_BYTES))
        .layer(TraceLayer::new_for_http())
        .layer(security_header(
            HeaderName::from_static("x-content-type-options"),
            "nosniff",
        ))
        .layer(security_header(
            HeaderName::from_static("referrer-policy"),
            "no-referrer",
        ))
        .layer(security_header(
            HeaderName::from_static("x-frame-options"),
            "SAMEORIGIN",
        ))
        .layer(security_header(
            CONTENT_SECURITY_POLICY,
            "default-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data: blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'self'",
        ));

    let addr: SocketAddr = "127.0.0.1:8080".parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn security_header(name: HeaderName, value: &'static str) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value))
}

async fn index() -> Response {
    match embedded_asset("index.html") {
        Some(asset) => Html(String::from_utf8_lossy(asset).into_owned()).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "frontend assets are not embedded; run npm run build before cargo build",
        )
            .into_response(),
    }
}

async fn frontend_asset(Path(path): Path<String>) -> Response {
    let path = format!("assets/{path}");
    let Some(asset) = embedded_asset_response(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    asset
}

fn embedded_asset(path: &str) -> Option<&'static [u8]> {
    embedded_frontend::FRONTEND_ASSETS
        .iter()
        .find_map(|(asset_path, bytes)| (*asset_path == path).then_some(*bytes))
}

fn embedded_asset_response(path: &str) -> Option<Response> {
    let bytes = embedded_asset(path)?;
    let content_type = mime_guess::from_path(path).first_or_octet_stream();
    let content_type = HeaderValue::from_str(content_type.essence_str()).ok()?;

    let mut response = Response::new(Body::from(Bytes::from_static(bytes)));
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, content_type);
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    Some(response)
}

async fn list_fonts() -> Response {
    match read_font_metadata().await {
        Ok(fonts) => Json(
            fonts
                .into_iter()
                .map(FontMetadata::descriptor)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to list fonts: {err}"),
        )
            .into_response(),
    }
}

async fn upload_font(
    headers: HeaderMap,
    Query(query): Query<FontUploadQuery>,
    body: Bytes,
) -> Response {
    match store_font(&headers, &query.filename, body).await {
        Ok(font) => (StatusCode::CREATED, Json(font.descriptor())).into_response(),
        Err(FontError::BadRequest(message)) => (StatusCode::BAD_REQUEST, message).into_response(),
        Err(FontError::Io(err)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to store font: {err}"),
        )
            .into_response(),
    }
}

async fn delete_font(Path(id): Path<String>) -> Response {
    match remove_font(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(FontError::BadRequest(message)) => (StatusCode::BAD_REQUEST, message).into_response(),
        Err(FontError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(FontError::Io(err)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to delete font: {err}"),
        )
            .into_response(),
    }
}

async fn font_file(Path(id): Path<String>) -> Response {
    match read_font_file(&id).await {
        Ok((metadata, bytes)) => font_response(&metadata, bytes),
        Err(FontError::BadRequest(message)) => (StatusCode::BAD_REQUEST, message).into_response(),
        Err(FontError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(FontError::Io(err)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read font: {err}"),
        )
            .into_response(),
    }
}

fn font_response(metadata: &FontMetadata, bytes: Bytes) -> Response {
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&metadata.mime_type) {
        headers.insert(CONTENT_TYPE, value);
    }
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response
}

#[derive(Debug)]
enum FontError {
    BadRequest(String),
    Io(std::io::Error),
}

impl From<std::io::Error> for FontError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl FontMetadata {
    fn descriptor(self) -> FontDescriptor {
        FontDescriptor {
            url: format!("/api/fonts/{}/file", self.id),
            id: self.id,
            label: self.label,
            family: self.family,
            mime_type: self.mime_type,
            size: self.size,
        }
    }
}

async fn read_font_metadata() -> std::io::Result<Vec<FontMetadata>> {
    let dir = ensure_font_dir().await?;
    let mut fonts = Vec::new();
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let bytes = tokio::fs::read(&path).await?;
        match serde_json::from_slice::<FontMetadata>(&bytes) {
            Ok(metadata) if valid_font_id(&metadata.id) => fonts.push(metadata),
            Ok(_) | Err(_) => warn!(path = %path.display(), "ignored invalid font metadata"),
        }
    }
    fonts.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(fonts)
}

async fn store_font(
    headers: &HeaderMap,
    filename: &str,
    body: Bytes,
) -> Result<FontMetadata, FontError> {
    let extension = validate_font_filename(filename)?;
    if body.is_empty() || body.len() > MAX_FONT_BYTES {
        return Err(FontError::BadRequest(
            "font must be between 1 byte and 10 MB".to_owned(),
        ));
    }

    let mime_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("application/octet-stream");
    validate_font_mime(mime_type)?;

    let id = Uuid::new_v4().to_string();
    let metadata = FontMetadata {
        id: id.clone(),
        label: font_label(filename),
        family: format!("PureTerminal-{id}"),
        mime_type: mime_type.to_owned(),
        size: u64::try_from(body.len()).unwrap_or(u64::MAX),
        filename: sanitize_font_filename(filename),
        extension,
    };

    let dir = ensure_font_dir().await?;
    tokio::fs::write(font_data_path(&dir, &metadata), body).await?;
    let metadata_bytes = serde_json::to_vec_pretty(&metadata)
        .map_err(|err| std::io::Error::other(err.to_string()))?;
    tokio::fs::write(font_metadata_path(&dir, &metadata.id), metadata_bytes).await?;
    Ok(metadata)
}

async fn remove_font(id: &str) -> Result<(), FontError> {
    validate_font_id(id)?;
    let dir = ensure_font_dir().await?;
    let metadata = read_single_font_metadata(&dir, id).await?;
    let _ = tokio::fs::remove_file(font_data_path(&dir, &metadata)).await;
    tokio::fs::remove_file(font_metadata_path(&dir, id)).await?;
    Ok(())
}

async fn read_font_file(id: &str) -> Result<(FontMetadata, Bytes), FontError> {
    validate_font_id(id)?;
    let dir = ensure_font_dir().await?;
    let metadata = read_single_font_metadata(&dir, id).await?;
    let bytes = tokio::fs::read(font_data_path(&dir, &metadata)).await?;
    Ok((metadata, Bytes::from(bytes)))
}

async fn read_single_font_metadata(dir: &FsPath, id: &str) -> Result<FontMetadata, FontError> {
    let bytes = tokio::fs::read(font_metadata_path(dir, id)).await?;
    serde_json::from_slice::<FontMetadata>(&bytes)
        .map_err(|err| FontError::Io(std::io::Error::other(err.to_string())))
}

async fn ensure_font_dir() -> std::io::Result<PathBuf> {
    let dir = font_dir();
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

fn font_dir() -> PathBuf {
    std::env::var_os("PURE_TERMINAL_FONT_DIR")
        .map_or_else(|| PathBuf::from(DEFAULT_FONT_DIR), PathBuf::from)
}

fn font_metadata_path(dir: &FsPath, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn font_data_path(dir: &FsPath, metadata: &FontMetadata) -> PathBuf {
    dir.join(format!("{}.{}", metadata.id, metadata.extension))
}

fn validate_font_filename(filename: &str) -> Result<String, FontError> {
    let filename = filename.trim();
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err(FontError::BadRequest("invalid font filename".to_owned()));
    }
    let extension = filename
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .ok_or_else(|| FontError::BadRequest("font filename must have an extension".to_owned()))?;
    if !matches!(extension.as_str(), "woff2" | "woff" | "ttf" | "otf") {
        return Err(FontError::BadRequest(
            "only .woff, .woff2, .ttf, and .otf are allowed".to_owned(),
        ));
    }
    Ok(extension)
}

fn validate_font_mime(mime_type: &str) -> Result<(), FontError> {
    if matches!(
        mime_type,
        "font/woff2"
            | "font/woff"
            | "font/ttf"
            | "font/otf"
            | "application/font-woff"
            | "application/font-woff2"
            | "application/x-font-ttf"
            | "application/x-font-otf"
            | "application/octet-stream"
    ) {
        return Ok(());
    }
    Err(FontError::BadRequest(format!(
        "unsupported font MIME type: {mime_type}"
    )))
}

fn validate_font_id(id: &str) -> Result<(), FontError> {
    if valid_font_id(id) {
        Ok(())
    } else {
        Err(FontError::BadRequest("invalid font id".to_owned()))
    }
}

fn valid_font_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-')
}

fn font_label(filename: &str) -> String {
    let stem = filename.rsplit_once('.').map_or(filename, |(stem, _)| stem);
    let clean = stem
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, ' ' | '.' | '-' | '_') {
                value
            } else {
                ' '
            }
        })
        .collect::<String>();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        "Uploaded Font".to_owned()
    } else {
        clean
    }
}

fn sanitize_font_filename(filename: &str) -> String {
    filename
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_'))
        .collect::<String>()
}

async fn terminal_ws(
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

struct TerminalTarget {
    session_id: String,
    selector: String,
    cols: u16,
    rows: u16,
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

type SpawnedTerminal = (
    Box<dyn MasterPty + Send>,
    std::sync::mpsc::Sender<WriterCommand>,
    mpsc::UnboundedReceiver<PtyEvent>,
    Box<dyn portable_pty::ChildKiller + Send + Sync>,
);

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

struct CapabilityServiceImpl {
    state: Arc<AppState>,
}

impl CapabilityServiceImpl {
    fn sessions_read(
        &self,
    ) -> Result<RwLockReadGuard<'_, HashMap<String, SessionRecord>>, ConnectError> {
        self.state
            .sessions
            .read()
            .map_err(|_| ConnectError::internal("session store lock poisoned"))
    }

    fn sessions_write(
        &self,
    ) -> Result<RwLockWriteGuard<'_, HashMap<String, SessionRecord>>, ConnectError> {
        self.state
            .sessions
            .write()
            .map_err(|_| ConnectError::internal("session store lock poisoned"))
    }
}

impl CapabilityService for CapabilityServiceImpl {
    async fn list_instances(
        &self,
        _ctx: RequestContext,
        _request: OwnedListInstancesRequestView,
    ) -> ServiceResult<ListInstancesResponse> {
        let instances = list_instances().await?;
        ConnectResponse::ok(ListInstancesResponse {
            instances,
            ..Default::default()
        })
    }

    async fn get_provider(
        &self,
        _ctx: RequestContext,
        _request: OwnedGetProviderRequestView,
    ) -> ServiceResult<GetProviderResponse> {
        ConnectResponse::ok(GetProviderResponse {
            provider: MessageField::some(provider_descriptor()),
            ..Default::default()
        })
    }

    async fn create_session(
        &self,
        _ctx: RequestContext,
        request: OwnedCreateSessionRequestView,
    ) -> ServiceResult<CreateSessionResponse> {
        let selector = request
            .selector
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ConnectError::invalid_argument("selector is required"))?;
        validate_selector(selector)?;
        let cols = normalize_dimension(request.cols, DEFAULT_COLS, MAX_COLS, "cols")?;
        let rows = normalize_dimension(request.rows, DEFAULT_ROWS, MAX_ROWS, "rows")?;
        let id = Uuid::new_v4().to_string();
        let record = SessionRecord {
            id: id.clone(),
            selector: selector.to_owned(),
            status: "ready".to_owned(),
            cols,
            rows,
            control: None,
            metadata: request
                .metadata
                .iter()
                .map(|entry| (entry.0.to_owned(), entry.1.to_owned()))
                .collect(),
        };
        let session = record.to_proto();
        self.sessions_write()?.insert(id, record);
        ConnectResponse::ok(CreateSessionResponse {
            session: MessageField::some(session),
            ..Default::default()
        })
    }

    async fn close_session(
        &self,
        _ctx: RequestContext,
        request: OwnedCloseSessionRequestView,
    ) -> ServiceResult<CloseSessionResponse> {
        let session_id = required_field(request.session_id, "session_id")?;
        let mut sessions = self.sessions_write()?;
        let Some(record) = sessions.get_mut(session_id) else {
            return Err(ConnectError::not_found("session not found"));
        };
        "closed".clone_into(&mut record.status);
        ConnectResponse::ok(CloseSessionResponse {
            session_id: Some(session_id.to_owned()),
            status: Some(record.status.clone()),
            ..Default::default()
        })
    }

    async fn list_sessions(
        &self,
        _ctx: RequestContext,
        request: OwnedListSessionsRequestView,
    ) -> ServiceResult<ListSessionsResponse> {
        let selector = request
            .selector
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let sessions = self.sessions_read()?;
        let sessions = sessions
            .values()
            .filter(|session| selector.is_none_or(|value| session.selector == value))
            .map(SessionRecord::to_proto)
            .collect();
        ConnectResponse::ok(ListSessionsResponse {
            sessions,
            ..Default::default()
        })
    }

    async fn list_plugins(
        &self,
        _ctx: RequestContext,
        _request: OwnedListPluginsRequestView,
    ) -> ServiceResult<ListPluginsResponse> {
        let plugins = self
            .state
            .plugins
            .read()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?
            .values()
            .map(PluginRecord::to_proto)
            .collect();
        ConnectResponse::ok(ListPluginsResponse {
            plugins,
            ..Default::default()
        })
    }

    async fn configure_plugin(
        &self,
        _ctx: RequestContext,
        request: OwnedConfigurePluginRequestView,
    ) -> ServiceResult<ConfigurePluginResponse> {
        let plugin_id = required_field(request.plugin_id, "plugin_id")?;
        let mut plugins = self
            .state
            .plugins
            .write()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?;
        let Some(plugin) = plugins.get_mut(plugin_id) else {
            return Err(ConnectError::not_found("plugin not found"));
        };
        plugin.enabled = request.enabled.unwrap_or(false);
        for entry in &request.metadata {
            plugin
                .metadata
                .insert(entry.0.to_owned(), entry.1.to_owned());
        }
        ConnectResponse::ok(ConfigurePluginResponse {
            plugin: MessageField::some(plugin.to_proto()),
            ..Default::default()
        })
    }

    async fn invoke_plugin(
        &self,
        _ctx: RequestContext,
        request: OwnedInvokePluginRequestView,
    ) -> ServiceResult<InvokePluginResponse> {
        let plugin_id = required_field(request.plugin_id, "plugin_id")?;
        let plugins = self
            .state
            .plugins
            .read()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?;
        let Some(plugin) = plugins.get(plugin_id) else {
            return Err(ConnectError::not_found(format!(
                "plugin is not registered: {plugin_id}"
            )));
        };
        if !plugin.enabled {
            return Err(ConnectError::failed_precondition(format!(
                "plugin is disabled: {plugin_id}"
            )));
        }
        ConnectResponse::ok(InvokePluginResponse {
            invocation_id: Some(Uuid::new_v4().to_string()),
            status: Some("accepted".to_owned()),
            content_type: Some("application/json".to_owned()),
            payload: Some(
                serde_json::to_vec(&serde_json::json!({
                    "status": "pending-implementation",
                    "pluginId": plugin_id,
                    "operation": request.operation.unwrap_or("default")
                }))
                .map_err(|err| ConnectError::internal(err.to_string()))?,
            ),
            ..Default::default()
        })
    }

    async fn request_control(
        &self,
        _ctx: RequestContext,
        request: OwnedRequestControlRequestView,
    ) -> ServiceResult<RequestControlResponse> {
        let session_id = required_field(request.session_id, "session_id")?;
        let actor_id = request.actor_id.unwrap_or("anonymous").trim();
        let actor_kind = request.actor_kind.unwrap_or("human").trim();
        if actor_id.is_empty() || actor_kind.is_empty() {
            return Err(ConnectError::invalid_argument(
                "actor_id and actor_kind must not be empty",
            ));
        }

        let lease = ControlLease {
            lease_id: Some(Uuid::new_v4().to_string()),
            actor_id: Some(actor_id.to_owned()),
            actor_kind: Some(actor_kind.to_owned()),
            status: Some("active".to_owned()),
            ..Default::default()
        };
        let mut sessions = self.sessions_write()?;
        let Some(session) = sessions.get_mut(session_id) else {
            return Err(ConnectError::not_found("session not found"));
        };
        session.control = Some(lease.clone());
        ConnectResponse::ok(RequestControlResponse {
            lease: MessageField::some(lease),
            ..Default::default()
        })
    }

    async fn release_control(
        &self,
        _ctx: RequestContext,
        request: OwnedReleaseControlRequestView,
    ) -> ServiceResult<ReleaseControlResponse> {
        let session_id = required_field(request.session_id, "session_id")?;
        let lease_id = required_field(request.lease_id, "lease_id")?;
        let mut sessions = self.sessions_write()?;
        let Some(session) = sessions.get_mut(session_id) else {
            return Err(ConnectError::not_found("session not found"));
        };
        let current = session
            .control
            .as_ref()
            .and_then(|lease| lease.lease_id.as_deref());
        if current != Some(lease_id) {
            return Err(ConnectError::failed_precondition(
                "lease_id does not match active control lease",
            ));
        }
        session.control = None;
        ConnectResponse::ok(ReleaseControlResponse {
            session_id: Some(session_id.to_owned()),
            status: Some("released".to_owned()),
            ..Default::default()
        })
    }
}

impl SessionRecord {
    fn to_proto(&self) -> Session {
        Session {
            id: Some(self.id.clone()),
            selector: Some(self.selector.clone()),
            status: Some(self.status.clone()),
            cols: Some(i32::from(self.cols)),
            rows: Some(i32::from(self.rows)),
            control: self
                .control
                .clone()
                .map_or_else(MessageField::none, MessageField::some),
            metadata: self.metadata.clone(),
            ..Default::default()
        }
    }
}

impl PluginRecord {
    fn to_proto(&self) -> PluginDescriptor {
        PluginDescriptor {
            id: Some(self.id.clone()),
            kind: Some(self.kind.clone()),
            display_name: Some(self.display_name.clone()),
            description: Some(self.description.clone()),
            scopes: self.scopes.clone(),
            accepted_content_types: self.accepted_content_types.clone(),
            produced_content_types: self.produced_content_types.clone(),
            input_schema_json: Some(self.input_schema_json.clone()),
            output_schema_json: Some(self.output_schema_json.clone()),
            enabled: Some(self.enabled),
            metadata: self.metadata.clone(),
            ..Default::default()
        }
    }
}

fn mark_session_status(state: &AppState, session_id: &str, status: &str) {
    let Ok(mut sessions) = state.sessions.write() else {
        return;
    };
    if let Some(session) = sessions.get_mut(session_id) {
        status.clone_into(&mut session.status);
    }
}

fn provider_descriptor() -> ProviderDescriptor {
    ProviderDescriptor {
        id: Some(APP_ID.to_owned()),
        display_name: Some(APP_NAME.to_owned()),
        version: Some(env!("CARGO_PKG_VERSION").to_owned()),
        capabilities: vec![
            Capability {
                id: Some("terminal.session".to_owned()),
                kind: Some("session".to_owned()),
                display_name: Some("Terminal sessions".to_owned()),
                description: Some("Create and control terminal sessions for selected LightOS instances".to_owned()),
                transports: vec!["connect".to_owned(), "websocket".to_owned()],
                schema_json: Some(r#"{"dataPlane":"ws:/ws/terminal","controlPlane":"connect:lazycat.webshell.v1.CapabilityService"}"#.to_owned()),
                ..Default::default()
            },
            Capability {
                id: Some("plugin.invoke".to_owned()),
                kind: Some("plugin".to_owned()),
                display_name: Some("Generic plugin invocation".to_owned()),
                description: Some("Opaque plugin descriptors and payloads for future file transfer, remote shell, AI control, and human operation extensions".to_owned()),
                transports: vec!["connect".to_owned()],
                schema_json: Some(r#"{"pluginId":"string","operation":"string","contentType":"string","payload":"bytes","metadata":"map<string,string>"}"#.to_owned()),
                ..Default::default()
            },
            Capability {
                id: Some("control.lease".to_owned()),
                kind: Some("control".to_owned()),
                display_name: Some("Control leases".to_owned()),
                description: Some("Coordinate human, AI, and system actors without encoding actor-specific behavior in the terminal protocol".to_owned()),
                transports: vec!["connect".to_owned()],
                schema_json: Some(r#"{"actorId":"string","actorKind":"human|ai|system|custom","status":"active|released"}"#.to_owned()),
                ..Default::default()
            },
        ],
        ..Default::default()
    }
}

fn builtin_plugins() -> HashMap<String, PluginRecord> {
    [
        PluginRecord {
            id: "file-transfer".to_owned(),
            kind: "transfer".to_owned(),
            display_name: "File Transfer Adapter".to_owned(),
            description: "Generic adapter placeholder for sz/rz and tssh-style uploads and downloads.".to_owned(),
            scopes: vec!["session".to_owned(), "filesystem".to_owned()],
            accepted_content_types: vec![
                "application/json".to_owned(),
                "application/octet-stream".to_owned(),
            ],
            produced_content_types: vec![
                "application/json".to_owned(),
                "application/octet-stream".to_owned(),
            ],
            input_schema_json: r#"{"operation":"upload|download|attach","path":"string","transport":"sz-rz|tssh|custom","payload":"bytes"}"#.to_owned(),
            output_schema_json: r#"{"jobId":"string","status":"queued|running|complete|failed","message":"string"}"#.to_owned(),
            enabled: true,
            metadata: HashMap::from([
                ("builtin".to_owned(), "true".to_owned()),
                ("stage".to_owned(), "reserved".to_owned()),
            ]),
        },
        PluginRecord {
            id: "ai-control".to_owned(),
            kind: "control".to_owned(),
            display_name: "AI Shell Control".to_owned(),
            description: "Generic control plugin placeholder for future AI-assisted shell delegation and supervision.".to_owned(),
            scopes: vec!["session".to_owned(), "control".to_owned()],
            accepted_content_types: vec!["application/json".to_owned()],
            produced_content_types: vec!["application/json".to_owned()],
            input_schema_json: r#"{"mode":"observe|suggest|operate","leaseId":"string","prompt":"string"}"#.to_owned(),
            output_schema_json: r#"{"invocationId":"string","status":"accepted|running|complete|failed"}"#.to_owned(),
            enabled: false,
            metadata: HashMap::from([
                ("builtin".to_owned(), "true".to_owned()),
                ("stage".to_owned(), "reserved".to_owned()),
            ]),
        },
    ]
    .into_iter()
    .map(|plugin| (plugin.id.clone(), plugin))
    .collect()
}

async fn list_instances() -> Result<Vec<Instance>, ConnectError> {
    let output = run_lightosctl(["ps"]).await?;
    let mut items: Vec<LightOsInstance> = serde_json::from_slice(&output)
        .map_err(|err| ConnectError::internal(format!("invalid lightosctl ps JSON: {err}")))?;
    items.sort_by_key(|item| item.status != "running");
    Ok(items
        .into_iter()
        .filter_map(|item| {
            if item.name.trim().is_empty() || item.owner_deploy_id.trim().is_empty() {
                return None;
            }
            Some(Instance {
                selector: Some(format!("{}@{}", item.name, item.owner_deploy_id)),
                name: Some(item.name),
                owner_deploy_id: Some(item.owner_deploy_id),
                status: Some(item.status),
                ..Default::default()
            })
        })
        .collect())
}

async fn run_lightosctl<const N: usize>(args: [&str; N]) -> Result<Vec<u8>, ConnectError> {
    let mut command = tokio::process::Command::new(LIGHTOSCTL);
    command.args(args);
    let output = timeout(Duration::from_secs(8), command.output())
        .await
        .map_err(|_| ConnectError::deadline_exceeded("lightosctl timed out"))?
        .map_err(|err| ConnectError::unavailable(format!("failed to run lightosctl: {err}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ConnectError::failed_precondition(format!(
            "lightosctl failed: {detail}"
        )));
    }
    Ok(output.stdout)
}

fn validate_selector(selector: &str) -> Result<(), ConnectError> {
    let selector = selector.trim();
    let Some((name, owner_deploy_id)) = selector.split_once('@') else {
        return Err(ConnectError::invalid_argument(
            "selector must have shape <name>@<owner_deploy_id>",
        ));
    };
    if selector.matches('@').count() != 1
        || name.trim().is_empty()
        || owner_deploy_id.trim().is_empty()
        || selector.contains('/')
        || selector.contains('\\')
        || selector.chars().any(char::is_control)
    {
        return Err(ConnectError::invalid_argument(
            "selector must have shape <name>@<owner_deploy_id>",
        ));
    }
    Ok(())
}

fn required_field<'a>(value: Option<&'a str>, name: &str) -> Result<&'a str, ConnectError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ConnectError::invalid_argument(format!("{name} is required")))
}

fn normalize_dimension(
    value: Option<i32>,
    default_value: u16,
    max_value: u16,
    name: &str,
) -> Result<u16, ConnectError> {
    let value = value.unwrap_or(i32::from(default_value));
    if value <= 0 || value > i32::from(max_value) {
        return Err(ConnectError::invalid_argument(format!(
            "{name} must be between 1 and {max_value}"
        )));
    }
    u16::try_from(value)
        .map_err(|_| ConnectError::invalid_argument(format!("{name} is out of range")))
}

fn validate_size(cols: u16, rows: u16) -> anyhow::Result<()> {
    if cols == 0 || cols > MAX_COLS || rows == 0 || rows > MAX_ROWS {
        return Err(anyhow!(
            "terminal size must be between 1x1 and {MAX_COLS}x{MAX_ROWS}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_selector_shape() {
        assert!(validate_selector("demo@owner").is_ok());
        assert!(validate_selector("").is_err());
        assert!(validate_selector("demo").is_err());
        assert!(validate_selector("@owner").is_err());
        assert!(validate_selector("demo@").is_err());
        assert!(validate_selector("demo@owner@extra").is_err());
        assert!(validate_selector("demo/../x@owner").is_err());
    }

    #[test]
    fn validates_origin_host_match() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("example.test"));
        headers.insert(ORIGIN, HeaderValue::from_static("https://example.test"));
        assert!(origin_allowed(&headers));

        headers.insert(ORIGIN, HeaderValue::from_static("https://other.test"));
        assert!(!origin_allowed(&headers));
    }

    #[test]
    fn validates_font_upload_boundaries() {
        assert_eq!(
            validate_font_filename("JetBrainsMono.woff2").unwrap(),
            "woff2"
        );
        assert!(validate_font_filename("../bad.woff2").is_err());
        assert!(validate_font_filename("not-a-font.txt").is_err());
        assert!(validate_font_mime("font/woff2").is_ok());
        assert!(validate_font_mime("text/html").is_err());
        assert!(validate_font_id("1d76747b-88ff-449f-9e19-cc89fb1a7a67").is_ok());
        assert!(validate_font_id("../escape").is_err());
    }
}
