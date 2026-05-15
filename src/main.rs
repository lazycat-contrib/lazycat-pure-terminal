#![allow(refining_impl_trait)]

use std::net::SocketAddr;
use std::sync::Arc;

use tracing::info;

mod assets;
mod config;
mod embedded_frontend;
mod fonts;
mod lightos;
mod proto;
mod router;
mod service;
mod state;
mod terminal;
mod validation;

use crate::router::build_app;
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lazycat_pure_terminal=info,tower_http=info".into()),
        )
        .init();

    let state = Arc::new(AppState::new());
    let app = build_app(state);

    let addr: SocketAddr = "127.0.0.1:8080".parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(%addr, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}
