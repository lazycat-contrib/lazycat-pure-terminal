use std::path::{Path as FsPath, PathBuf};

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tracing::warn;
use uuid::Uuid;

use crate::config::{DEFAULT_FONT_DIR, MAX_FONT_BYTES};

#[derive(Debug, Deserialize)]
pub struct FontUploadQuery {
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

pub async fn list_fonts() -> Response {
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

pub async fn upload_font(
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

pub async fn delete_font(Path(id): Path<String>) -> Response {
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

pub async fn font_file(Path(id): Path<String>) -> Response {
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

#[cfg(test)]
mod tests {
    use super::{validate_font_filename, validate_font_id, validate_font_mime};

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
