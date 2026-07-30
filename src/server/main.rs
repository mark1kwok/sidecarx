mod auth;
mod fs;
mod sys;
mod terminal;
mod thumb;
mod utils;

use axum::{
    extract::DefaultBodyLimit,
    http::{header, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{delete, get, post, put},
    Router,
};
use std::net::SocketAddr;
use tower_http::{cors::CorsLayer, trace::TraceLayer, services::ServeDir};

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::auth::{auth_middleware, auth_status, login, logout};
use crate::fs::{
    copy, download, download_batch, list, mkdir, read, remove, rename, search, upload, write,
    UploadLimitBytes,
};
use crate::terminal::ws_terminal;
use crate::thumb::thumbnail;

async fn admin_redirect(headers: axum::http::HeaderMap) -> axum::response::Redirect {
    if let Some(prefix) = headers.get("x-forwarded-prefix").and_then(|v| v.to_str().ok()) {
        let clean_prefix = prefix.trim_end_matches('/');
        if !clean_prefix.is_empty() {
            return axum::response::Redirect::temporary(&format!("{}/", clean_prefix));
        }
    }
    axum::response::Redirect::temporary("/")
}

#[tokio::main]
async fn main() {


    // Load environment variables from .env file.
    // dotenvy::from_path does NOT override already-set env vars, so priority is:
    //   real env var  >>  .env file  >>  Rust hardcoded default
    // This makes .env act as a user-friendly config file while env vars stay in control.
    let env_path = std::env::var("SIDECAR_ENV_FILE").unwrap_or_else(|_| ".env".to_string());
    let env_load_result = dotenvy::from_path(&env_path);

    // Initialize tracing AFTER .env load so RUST_LOG set in .env takes effect.
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "sidecar=debug,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Report .env loading outcome now that tracing is ready.
    match env_load_result {
        Ok(_) => tracing::info!("Loaded config from '{}'", env_path),
        Err(dotenvy::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::info!(
                "No .env file at '{}' — using env vars and built-in defaults",
                env_path
            );
        }
        Err(ref e) => tracing::warn!("Could not read config file '{}': {}", env_path, e),
    }

    // Get configuration from environment
    let port: u16 = std::env::var("SIDECAR_PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse()
        .expect("SIDECAR_PORT must be a valid port number");

    let host: String = std::env::var("SIDECAR_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());

    // Ensure SIDECAR_SECRET is set
    if std::env::var("SIDECAR_SECRET").is_err() {
        tracing::warn!("SIDECAR_SECRET not set, using default. THIS IS INSECURE!");
    }

    // Bootstrap thumbnail cache directory
    if let Err(e) = thumb::ensure_cache_dir() {
        tracing::warn!("Failed to create thumbnail cache directory: {}", e);
        thumb::disable_cache();
    }

    let admin_panel_dir = std::env::var("SIDECAR_PANEL_DIR").unwrap_or_else(|_| "./admin".to_string());
    tracing::info!("Admin panel directory: '{}'", admin_panel_dir);

    // Read upload size limit from environment (default 1024 MB)
    let upload_limit_mb: u64 = std::env::var("SIDECAR_UPLOAD_LIMIT")
        .unwrap_or_else(|_| "1024".to_string())
        .parse()
        .expect("SIDECAR_UPLOAD_LIMIT must be a valid number in MB");
    let upload_limit_bytes = upload_limit_mb * 1024 * 1024;
    tracing::info!("Upload limit: {} MB", upload_limit_mb);

    // Build CORS layer — echo origin for credentials support
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::mirror_request())
        .allow_methods(tower_http::cors::AllowMethods::mirror_request())
        .allow_credentials(true)
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT]);

    // Handler for invalid API paths (returns 400 Bad Request)
    async fn invalid_api_handler() -> impl IntoResponse {
        (StatusCode::BAD_REQUEST, "Invalid API endpoint")
    }

    // Public API routes (no auth required) - nested under /api
    let public_api_routes = Router::new()
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout));

    // Routes that need large body limits (configurable via SIDECAR_UPLOAD_LIMIT)
    let large_body_routes = Router::new()
        .route("/fs/upload", post(upload))
        .route("/fs/write", put(write))
        .layer(DefaultBodyLimit::disable())
        .layer(axum::Extension(UploadLimitBytes(upload_limit_bytes)));

    // Protected API routes (auth required) - nested under /api
    let protected_api_routes = Router::new()
        // Auth status (validates token)
        .route("/auth/status", get(auth_status))
        // File System Read
        .route("/fs/list", get(list))
        .route("/fs/read", get(read))
        .route("/fs/download", get(download))
        .route("/fs/download-batch", post(download_batch))
        // File System Write (upload and write handled in large_body_routes)
        .route("/fs/mkdir", post(mkdir))
        .route("/fs/rename", post(rename))
        .route("/fs/copy", post(copy))
        .route("/fs/remove", delete(remove))
        // File Search
        .route("/fs/search", get(search))
        // File Thumbnail
        .route("/fs/thumbnail", get(thumbnail))
        // System Stats
        .route("/sys/stats", get(crate::sys::get_sys_stats))
        // Terminal WebSocket
        .route("/ws/terminal", get(ws_terminal))
        // Merge large body routes
        .merge(large_body_routes)
        // Apply auth middleware to all protected routes
        .layer(middleware::from_fn(auth_middleware));

    // Combined API routes with fallback for invalid paths
    let api_routes = Router::new()
        .merge(public_api_routes)
        .merge(protected_api_routes)
        .fallback(invalid_api_handler);

    // Combine all routes with priority:
    // 1. /api/* - API endpoints (exclusive, no fallback to static)
    // 2. Static files fallback at root /
    let index_file = format!("{}/index.html", admin_panel_dir);
    let serve_dir = ServeDir::new(&admin_panel_dir)
        .fallback(tower_http::services::ServeFile::new(index_file));

    let app = Router::new()
        .nest("/api", api_routes)
        .route("/admin", get(admin_redirect))
        .route("/admin/", get(admin_redirect))
        .route("/admin/*key", get(admin_redirect))
        .fallback_service(serve_dir)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    // Parse address
    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .expect("Invalid address");

    tracing::info!("Sidecar API listening on {}", addr);

    // Start server
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}
