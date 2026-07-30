use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

/// API Error types with automatic status code mapping
#[derive(Debug, Error)]
pub enum ApiError {
    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Not Found: {0}")]
    NotFound(String),

    #[error("Bad Request: {0}")]
    BadRequest(String),

    #[error("Payload Too Large: {0}")]
    PayloadTooLarge(String),

    #[error("Internal Server Error: {0}")]
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            ApiError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            ApiError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg.clone()),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            ApiError::PayloadTooLarge(msg) => (StatusCode::PAYLOAD_TOO_LARGE, msg.clone()),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
        };

        let body = Json(json!({
            "error": true,
            "status": status.as_u16(),
            "message": message
        }));

        let mut response = (status, body).into_response();

        // For 413 Payload Too Large, signal connection close so the response
        // reaches the client even when the request body is not fully consumed
        if status == StatusCode::PAYLOAD_TOO_LARGE {
            response
                .headers_mut()
                .insert(header::CONNECTION, HeaderValue::from_static("close"));
        }

        response
    }
}

/// Convert std::io::Error to ApiError
impl From<std::io::Error> for ApiError {
    fn from(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => ApiError::NotFound(err.to_string()),
            std::io::ErrorKind::PermissionDenied => ApiError::Forbidden(err.to_string()),
            std::io::ErrorKind::AlreadyExists => ApiError::BadRequest(err.to_string()),
            _ => ApiError::Internal(err.to_string()),
        }
    }
}

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static ROOT_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

pub fn get_canonical_root() -> Option<&'static PathBuf> {
    ROOT_DIR.get_or_init(|| {
        if let Ok(dir_str) = std::env::var("SIDECAR_ROOT_DIR") {
            if dir_str.trim().is_empty() {
                None
            } else {
                match std::fs::canonicalize(&dir_str) {
                    Ok(path) => {
                        tracing::info!("Root jail enabled: canonical path is {:?}", path);
                        Some(path)
                    }
                    Err(e) => {
                        tracing::error!("Failed to canonicalize SIDECAR_ROOT_DIR '{}': {}. Root jail disabled!", dir_str, e);
                        None
                    }
                }
            }
        } else {
            None
        }
    }).as_ref()
}

/// Validate that a path does not escape SIDECAR_ROOT_DIR or access forbidden virtual paths.
pub fn validate_path_safety(path: &Path) -> Result<(), ApiError> {
    // Check for explicit '..' components in target path to block directory traversal attempts early
    for component in path.components() {
        if component == std::path::Component::ParentDir {
            return Err(ApiError::Forbidden(
                "Directory traversal via '..' is forbidden".to_string(),
            ));
        }
    }

    // Resolve target path to its absolute/canonical path
    let canonical_path = if path.exists() {
        std::fs::canonicalize(path)?
    } else {
        // Walk up ancestors to find the nearest existing parent directory
        let mut nearest_existing = None;
        for ancestor in path.ancestors() {
            if ancestor.exists() {
                nearest_existing = Some(std::fs::canonicalize(ancestor)?);
                break;
            }
        }
        match nearest_existing {
            Some(p) => p,
            None => {
                // Default fallback if no ancestors exist (extremely rare on Unix)
                std::fs::canonicalize(".")?
            }
        }
    };

    // Block access to system virtual directories
    if canonical_path.starts_with("/dev")
        || canonical_path.starts_with("/proc")
        || canonical_path.starts_with("/sys")
    {
        return Err(ApiError::Forbidden(
            "Access to system virtual directories is forbidden".to_string(),
        ));
    }

    Ok(())
}

