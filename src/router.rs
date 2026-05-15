use std::sync::Arc;

use axum::Router;
use axum::http::header::{CONTENT_SECURITY_POLICY, HeaderName};
use axum::routing::{delete, get};
use connectrpc::Router as ConnectRouter;
use tower_http::trace::TraceLayer;

use crate::assets::{frontend_asset, index, security_header};
use crate::config::MAX_FONT_BYTES;
use crate::fonts::{delete_font, font_file, list_fonts, upload_font};
use crate::proto::lazycat::webshell::v1::CapabilityServiceExt;
use crate::service::CapabilityServiceImpl;
use crate::state::AppState;
use crate::terminal::terminal_ws;

pub fn build_app(state: Arc<AppState>) -> Router {
    let service = Arc::new(CapabilityServiceImpl::new(Arc::clone(&state)));
    let connect = service.register(ConnectRouter::new()).into_axum_router();

    Router::new()
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
        .layer(axum::extract::DefaultBodyLimit::max(MAX_FONT_BYTES))
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
        ))
}
