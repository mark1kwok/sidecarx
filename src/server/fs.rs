use async_zip::tokio::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
use axum::{
    body::Body,
    extract::{Multipart, Query},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio_util::compat::TokioAsyncReadCompatExt;
use tokio_util::io::{ReaderStream, StreamReader};

use crate::utils::{ApiError, validate_path_safety};

/// Sniff the real MIME type from the first bytes of a file.
/// Falls back to extension-based guess if magic-byte detection fails.
fn sniff_mime(path: &Path, buf: &[u8]) -> String {
    if let Some(kind) = infer::get(buf) {
        return kind.mime_type().to_string();
    }
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string()
}

/// Query parameters for path-based operations
#[derive(Debug, Deserialize)]
pub struct PathQuery {
    pub path: String,
}

/// Query parameters for read endpoint (path + optional cache)
#[derive(Debug, Deserialize)]
pub struct ReadQuery {
    pub path: String,
    pub cache: Option<u64>,
}

fn is_url_auth_request(headers: &HeaderMap) -> bool {
    headers
        .get("x-sidecar-url-auth")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "1")
        .unwrap_or(false)
}

fn is_url_auth_mime_allowed(mime_type: &str) -> bool {
    mime_type.starts_with("image/")
        || mime_type.starts_with("video/")
        || mime_type.starts_with("audio/")
        || mime_type == "application/pdf"
}

/// File entry in directory listing
#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
    pub perms: String,
}

/// Request body for mkdir
#[derive(Debug, Deserialize)]
pub struct MkdirRequest {
    pub path: String,
}

/// Request body for rename/move
#[derive(Debug, Deserialize)]
pub struct RenameRequest {
    pub from: String,
    pub to: String,
}

/// Request body for copy
#[derive(Debug, Deserialize)]
pub struct CopyRequest {
    pub from: String,
    pub to: String,
}

/// Request body for remove
#[derive(Debug, Deserialize)]
pub struct RemoveRequest {
    pub path: String,
}

/// Convert Unix permissions to rwx string
fn format_permissions(mode: u32) -> String {
    let mut result = String::with_capacity(9);

    // Owner permissions
    result.push(if mode & 0o400 != 0 { 'r' } else { '-' });
    result.push(if mode & 0o200 != 0 { 'w' } else { '-' });
    result.push(if mode & 0o100 != 0 { 'x' } else { '-' });

    // Group permissions
    result.push(if mode & 0o040 != 0 { 'r' } else { '-' });
    result.push(if mode & 0o020 != 0 { 'w' } else { '-' });
    result.push(if mode & 0o010 != 0 { 'x' } else { '-' });

    // Other permissions
    result.push(if mode & 0o004 != 0 { 'r' } else { '-' });
    result.push(if mode & 0o002 != 0 { 'w' } else { '-' });
    result.push(if mode & 0o001 != 0 { 'x' } else { '-' });

    result
}



/// List directory contents
pub async fn list(Query(params): Query<PathQuery>) -> Result<Json<Vec<FileEntry>>, ApiError> {
    let path = PathBuf::from(&params.path);
    validate_path_safety(&path)?;

    let metadata = std::fs::metadata(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ApiError::NotFound(format!("Path not found: {}", params.path))
        } else {
            ApiError::Internal(format!("Failed to read metadata: {}", e))
        }
    })?;

    if !metadata.is_dir() {
        return Err(ApiError::BadRequest(format!(
            "Path is not a directory: {}",
            params.path
        )));
    }

    let mut entries = Vec::new();
    let mut dir = fs::read_dir(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            ApiError::Forbidden(format!("Permission denied: {}", params.path))
        } else {
            ApiError::Internal(format!("Failed to read directory: {}", e))
        }
    })?;

    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to read directory entry: {}", e)))?
    {
        let metadata = entry
            .metadata()
            .await
            .map_err(|e| ApiError::Internal(format!("Failed to read metadata: {}", e)))?;

        let modified = metadata
            .modified()
            .map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0)
            })
            .unwrap_or(0);

        let mode = metadata.permissions().mode();

        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: None,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified,
            perms: format_permissions(mode),
        });
    }

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(Json(entries))
}

/// Download a file or directory (as ZIP)
pub async fn download(Query(params): Query<PathQuery>) -> Result<Response, ApiError> {
    let path = PathBuf::from(&params.path);
    validate_path_safety(&path)?;

    let metadata = std::fs::metadata(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ApiError::NotFound(format!("Path not found: {}", params.path))
        } else {
            ApiError::Internal(format!("Failed to read metadata: {}", e))
        }
    })?;

    if metadata.is_file() {
        // Read first bytes for magic-byte MIME sniffing
        let header_bytes = {
            let mut buf = [0u8; 128];
            let mut f = std::fs::File::open(&path).map_err(|e| {
                ApiError::Internal(format!("Failed to open file for sniffing: {}", e))
            })?;
            use std::io::Read;
            let n = f.read(&mut buf).unwrap_or(0);
            buf[..n].to_vec()
        };

        // Stream the file directly
        let file = tokio::fs::File::open(&path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                ApiError::Forbidden(format!("Permission denied: {}", params.path))
            } else {
                ApiError::Internal(format!("Failed to open file: {}", e))
            }
        })?;

        let metadata = file
            .metadata()
            .await
            .map_err(|e| ApiError::Internal(format!("Failed to read metadata: {}", e)))?;

        let mime_type = sniff_mime(&path, &header_bytes);

        let filename = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".to_string());

        let stream = ReaderStream::new(file);
        let body = Body::from_stream(stream);

        Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime_type)
            .header(header::CONTENT_LENGTH, metadata.len())
            .header(
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", filename),
            )
            .body(body)
            .unwrap())
    } else if metadata.is_dir() {
        // Create ZIP for directory
        create_zip_response(&[path]).await
    } else {
        Err(ApiError::BadRequest(format!(
            "Path is neither a file nor a directory: {}",
            params.path
        )))
    }
}

/// Download multiple files/directories as ZIP
pub async fn download_batch(Json(paths): Json<Vec<String>>) -> Result<Response, ApiError> {
    if paths.is_empty() {
        return Err(ApiError::BadRequest("No paths provided".to_string()));
    }

    let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();

    // Verify all paths are safe and exist
    for path in &path_bufs {
        validate_path_safety(path)?;

        let metadata = std::fs::metadata(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ApiError::NotFound(format!("Path not found: {}", path.display()))
            } else {
                ApiError::Internal(format!("Failed to read metadata: {}", e))
            }
        })?;

        if !metadata.is_file() && !metadata.is_dir() {
            return Err(ApiError::BadRequest(format!(
                "Path is neither a file nor a directory: {}",
                path.display()
            )));
        }
    }

    create_zip_response(&path_bufs).await
}

/// Create a ZIP file from multiple paths and return as streaming response
async fn create_zip_response(paths: &[PathBuf]) -> Result<Response, ApiError> {
    let (write_half, read_half) = tokio::io::duplex(134_217_728); // 128 MB

    let paths = paths.to_vec();
    tokio::spawn(async move {
        if let Err(e) = write_zip_to_stream(paths, write_half).await {
            tracing::error!("ZIP streaming error: {}", e);
            // write_half is dropped here, terminating the stream
        }
    });

    let body = Body::from_stream(ReaderStream::new(read_half));

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"download.zip\"",
        )
        .body(body)
        .unwrap())
}

/// Type alias for the ZIP writer backed by a duplex stream
type DuplexZipWriter = ZipFileWriter<tokio::io::DuplexStream>;

/// Write ZIP entries to a stream asynchronously
async fn write_zip_to_stream(
    paths: Vec<PathBuf>,
    writer: tokio::io::DuplexStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut zip_writer = ZipFileWriter::with_tokio(writer);

    for path in &paths {
        if path.is_file() {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            add_file_to_zip_async(&mut zip_writer, path, &name).await?;
        } else if path.is_dir() {
            let prefix = path.file_name().unwrap().to_string_lossy().to_string();
            add_dir_to_zip_async(&mut zip_writer, path, &prefix).await?;
        }
    }

    zip_writer.close().await?;
    Ok(())
}

/// Add a single file to the ZIP archive asynchronously
async fn add_file_to_zip_async(
    zip_writer: &mut DuplexZipWriter,
    path: &Path,
    name: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let entry = ZipEntryBuilder::new(name.to_string().into(), Compression::Deflate);
    let mut entry_writer = zip_writer.write_entry_stream(entry).await?;

    let file = tokio::fs::File::open(path).await?;
    let mut compat_file = file.compat();
    futures::io::copy(&mut compat_file, &mut entry_writer).await?;
    entry_writer.close().await?;

    Ok(())
}

/// Add a directory to the ZIP archive recursively (iterative traversal)
async fn add_dir_to_zip_async(
    zip_writer: &mut DuplexZipWriter,
    root: &Path,
    prefix: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), prefix.to_string())];

    while let Some((dir_path, dir_prefix)) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&dir_path).await?;
        let mut sub_dirs = Vec::new();

        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let entry_name = format!("{}/{}", dir_prefix, entry.file_name().to_string_lossy());

            if entry_path.is_file() {
                add_file_to_zip_async(zip_writer, &entry_path, &entry_name).await?;
            } else if entry_path.is_dir() {
                sub_dirs.push((entry_path, entry_name));
            }
        }

        // Push sub-directories in reverse order to process them in original order
        for sub_dir in sub_dirs.into_iter().rev() {
            stack.push(sub_dir);
        }
    }

    Ok(())
}

/// Read file content inline (no Content-Disposition: attachment)
pub async fn read(
    headers: HeaderMap,
    Query(params): Query<ReadQuery>,
) -> Result<Response, ApiError> {
    let path = PathBuf::from(&params.path);
    validate_path_safety(&path)?;
    let url_auth = is_url_auth_request(&headers);

    let metadata = std::fs::metadata(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ApiError::NotFound(format!("Path not found: {}", params.path))
        } else {
            ApiError::Internal(format!("Failed to read metadata: {}", e))
        }
    })?;

    if !metadata.is_file() {
        return Err(ApiError::BadRequest(format!(
            "Path is not a regular file: {}",
            params.path
        )));
    }

    // Read first bytes for magic-byte MIME sniffing
    let header_bytes = {
        let mut buf = [0u8; 128];
        let mut f = std::fs::File::open(&path)
            .map_err(|e| ApiError::Internal(format!("Failed to open file for sniffing: {}", e)))?;
        use std::io::Read;
        let n = f.read(&mut buf).unwrap_or(0);
        buf[..n].to_vec()
    };

    let file = tokio::fs::File::open(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            ApiError::Forbidden(format!("Permission denied: {}", params.path))
        } else {
            ApiError::Internal(format!("Failed to open file: {}", e))
        }
    })?;

    let metadata = file
        .metadata()
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to read metadata: {}", e)))?;

    let mime_type = sniff_mime(&path, &header_bytes);

    if url_auth && !is_url_auth_mime_allowed(&mime_type) {
        return Err(ApiError::Forbidden(format!(
            "URL-authenticated read is restricted to media/PDF MIME types, got: {}",
            mime_type
        )));
    }

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::CONTENT_LENGTH, metadata.len());

    // Add Cache-Control header if cache parameter is present
    if let Some(seconds) = params.cache {
        if seconds > 0 {
            builder = builder.header(
                header::CACHE_CONTROL,
                format!("private, max-age={}, immutable", seconds),
            );
        } else {
            builder = builder.header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate");
        }
    }

    Ok(builder.body(body).unwrap())
}

/// Write file content via PUT (raw body, streamed to disk)
pub async fn write(
    headers: HeaderMap,
    Query(params): Query<PathQuery>,
    axum::Extension(limit): axum::Extension<UploadLimitBytes>,
    body: Body,
) -> Result<Json<serde_json::Value>, ApiError> {
    check_content_length(&headers, limit.0)?;

    let path = PathBuf::from(&params.path);
    validate_path_safety(&path)?;

    // Validate path doesn't contain null bytes
    if params.path.contains('\0') {
        return Err(ApiError::BadRequest("Path contains null bytes".to_string()));
    }

    // Reject if path exists and is not a regular file
    if path.exists() {
        let metadata = std::fs::metadata(&path)
            .map_err(|e| ApiError::Internal(format!("Failed to read metadata: {}", e)))?;
        if !metadata.is_file() {
            return Err(ApiError::BadRequest(format!(
                "Path already exists and is not a regular file: {}",
                params.path
            )));
        }
    }

    // Create parent directories if they don't exist
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).await.map_err(|e| {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    ApiError::Forbidden(format!(
                        "Permission denied creating directories: {}",
                        parent.display()
                    ))
                } else {
                    ApiError::Internal(format!("Failed to create parent directories: {}", e))
                }
            })?;
        }
    }

    // Stream body directly to file
    let mut file = tokio::fs::File::create(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            ApiError::Forbidden(format!("Permission denied: {}", path.display()))
        } else {
            ApiError::Internal(format!("Failed to create file: {}", e))
        }
    })?;

    let stream = body
        .into_data_stream()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
    let mut reader = StreamReader::new(stream);

    use tokio::io::AsyncReadExt;
    let mut limited_reader = reader.take(limit.0 + 1);

    let copied = tokio::io::copy(&mut limited_reader, &mut file).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            ApiError::Forbidden(format!("Permission denied: {}", path.display()))
        } else {
            ApiError::Internal(format!("Failed to write file: {}", e))
        }
    })?;

    if copied > limit.0 {
        drop(file);
        let _ = tokio::fs::remove_file(&path).await;
        return Err(ApiError::PayloadTooLarge(format!(
            "File size limit exceeded ({} MB max)",
            limit.0 / 1024 / 1024
        )));
    }

    // Get file size from metadata after writing
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to read file metadata: {}", e)))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "path": params.path,
        "size": metadata.len()
    })))
}

/// Validate an upload filename for path-traversal attacks
fn validate_upload_filename(filename: &str) -> Result<(), ApiError> {
    // Reject null bytes
    if filename.contains('\0') {
        return Err(ApiError::BadRequest(
            "Filename contains null bytes".to_string(),
        ));
    }

    // Reject absolute paths
    if filename.starts_with('/') {
        return Err(ApiError::BadRequest(
            "Filename must not be an absolute path".to_string(),
        ));
    }

    // Reject .. components and empty segments
    for component in filename.split('/') {
        if component == ".." {
            return Err(ApiError::BadRequest(
                "Filename contains '..' path component".to_string(),
            ));
        }
        if component.is_empty() {
            return Err(ApiError::BadRequest(
                "Filename contains empty path segment".to_string(),
            ));
        }
    }

    Ok(())
}

/// Upload limit in bytes, passed via Extension from main
#[derive(Clone, Copy)]
pub struct UploadLimitBytes(pub u64);

/// Check Content-Length header and reject requests exceeding the configured limit
fn check_content_length(headers: &HeaderMap, limit_bytes: u64) -> Result<(), ApiError> {
    if let Some(content_length) = headers.get(header::CONTENT_LENGTH) {
        if let Ok(length_str) = content_length.to_str() {
            if let Ok(length) = length_str.parse::<u64>() {
                if length > limit_bytes {
                    let limit_mb = limit_bytes / (1024 * 1024);
                    return Err(ApiError::PayloadTooLarge(format!(
                        "Request body exceeds {} MB limit",
                        limit_mb
                    )));
                }
            }
        }
    }
    Ok(())
}

/// Upload files to a directory (streamed to disk)
pub async fn upload(
    headers: HeaderMap,
    Query(params): Query<PathQuery>,
    axum::Extension(limit): axum::Extension<UploadLimitBytes>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, ApiError> {
    check_content_length(&headers, limit.0)?;

    let target_dir = PathBuf::from(&params.path);
    validate_path_safety(&target_dir)?;

    // Auto-create target directory if it doesn't exist
    if !target_dir.exists() {
        fs::create_dir_all(&target_dir).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                ApiError::Forbidden(format!(
                    "Permission denied creating directory: {}",
                    params.path
                ))
            } else {
                ApiError::Internal(format!("Failed to create target directory: {}", e))
            }
        })?;
    }

    if !target_dir.is_dir() {
        return Err(ApiError::BadRequest(format!(
            "Target path is not a directory: {}",
            params.path
        )));
    }

    let mut uploaded_files = Vec::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("Failed to read multipart field: {}", e)))?
    {
        let filename = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unnamed".to_string());

        // Validate filename for path traversal
        validate_upload_filename(&filename)?;

        let file_path = target_dir.join(&filename);

        // Canonicalize the target directory and verify the resolved path stays under it
        let canonical_target = target_dir.canonicalize().map_err(|e| {
            ApiError::Internal(format!("Failed to resolve target directory: {}", e))
        })?;

        // Create parent directories if the filename contains subdirectory components
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).await.map_err(|e| {
                ApiError::Internal(format!("Failed to create parent directories: {}", e))
            })?;
        }

        // After creating dirs, canonicalize the file's parent and verify it's under target
        let canonical_parent = file_path
            .parent()
            .ok_or_else(|| ApiError::Internal("Invalid file path".to_string()))?
            .canonicalize()
            .map_err(|e| ApiError::Internal(format!("Failed to resolve file path: {}", e)))?;

        if !canonical_parent.starts_with(&canonical_target) {
            return Err(ApiError::BadRequest(format!(
                "Path traversal detected in filename: {}",
                filename
            )));
        }

        // Stream multipart field directly to file
        let mut file = tokio::fs::File::create(&file_path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                ApiError::Forbidden(format!("Permission denied: {}", file_path.display()))
            } else {
                ApiError::Internal(format!("Failed to create file: {}", e))
            }
        })?;

        let stream = field.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
        let mut reader = StreamReader::new(stream);

        use tokio::io::AsyncReadExt;
        let mut limited_reader = reader.take(limit.0 + 1);

        let copied = tokio::io::copy(&mut limited_reader, &mut file)
            .await
            .map_err(|e| ApiError::Internal(format!("Failed to stream file to disk: {}", e)))?;

        if copied > limit.0 {
            drop(file);
            let _ = tokio::fs::remove_file(&file_path).await;
            return Err(ApiError::PayloadTooLarge(format!(
                "File size limit exceeded ({} MB max)",
                limit.0 / 1024 / 1024
            )));
        }

        uploaded_files.push(filename);
    }

    Ok(Json(serde_json::json!({
        "success": true,
        "uploaded": uploaded_files
    })))
}

/// Create a directory
pub async fn mkdir(Json(payload): Json<MkdirRequest>) -> Result<Json<serde_json::Value>, ApiError> {
    let path = PathBuf::from(&payload.path);
    validate_path_safety(&path)?;

    if path.exists() {
        return Err(ApiError::BadRequest(format!(
            "Path already exists: {}",
            payload.path
        )));
    }

    fs::create_dir_all(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            ApiError::Forbidden(format!("Permission denied: {}", payload.path))
        } else {
            ApiError::Internal(format!("Failed to create directory: {}", e))
        }
    })?;

    Ok(Json(serde_json::json!({
        "success": true,
        "path": payload.path
    })))
}

/// Rename or move a file/directory
pub async fn rename(
    Json(payload): Json<RenameRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let from_path = PathBuf::from(&payload.from);
    let to_path = PathBuf::from(&payload.to);

    validate_path_safety(&from_path)?;
    validate_path_safety(&to_path)?;

    if !from_path.exists() {
        return Err(ApiError::NotFound(format!(
            "Source path not found: {}",
            payload.from
        )));
    }

    if to_path.exists() {
        return Err(ApiError::BadRequest(format!(
            "Destination already exists: {}",
            payload.to
        )));
    }

    // Ensure parent directory exists
    if let Some(parent) = to_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).await.map_err(|e| {
                ApiError::Internal(format!("Failed to create parent directory: {}", e))
            })?;
        }
    }

    fs::rename(&from_path, &to_path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            ApiError::Forbidden(format!("Permission denied"))
        } else {
            ApiError::Internal(format!("Failed to rename: {}", e))
        }
    })?;

    Ok(Json(serde_json::json!({
        "success": true,
        "from": payload.from,
        "to": payload.to
    })))
}

/// Copy a file or directory
pub async fn copy(Json(payload): Json<CopyRequest>) -> Result<Json<serde_json::Value>, ApiError> {
    let from_path = PathBuf::from(&payload.from);
    let to_path = PathBuf::from(&payload.to);

    validate_path_safety(&from_path)?;
    validate_path_safety(&to_path)?;

    if !from_path.exists() {
        return Err(ApiError::NotFound(format!(
            "Source path not found: {}",
            payload.from
        )));
    }

    if to_path.exists() {
        return Err(ApiError::BadRequest(format!(
            "Destination already exists: {}",
            payload.to
        )));
    }

    // Ensure parent directory exists
    if let Some(parent) = to_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).await.map_err(|e| {
                ApiError::Internal(format!("Failed to create parent directory: {}", e))
            })?;
        }
    }

    if from_path.is_file() {
        fs::copy(&from_path, &to_path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                ApiError::Forbidden(format!("Permission denied"))
            } else {
                ApiError::Internal(format!("Failed to copy file: {}", e))
            }
        })?;
    } else {
        // Recursive directory copy
        copy_dir_recursive(&from_path, &to_path).await?;
    }

    Ok(Json(serde_json::json!({
        "success": true,
        "from": payload.from,
        "to": payload.to
    })))
}

/// Recursively copy a directory
async fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), ApiError> {
    fs::create_dir_all(to)
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to create directory: {}", e)))?;

    let mut entries = fs::read_dir(from).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            ApiError::Forbidden(format!("Permission denied: {}", from.display()))
        } else {
            ApiError::Internal(format!("Failed to read directory: {}", e))
        }
    })?;

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to read directory entry: {}", e)))?
    {
        let entry_path = entry.path();
        let dest_path = to.join(entry.file_name());

        if entry_path.is_file() {
            fs::copy(&entry_path, &dest_path).await.map_err(|e| {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    ApiError::Forbidden(format!("Permission denied: {}", entry_path.display()))
                } else {
                    ApiError::Internal(format!("Failed to copy file: {}", e))
                }
            })?;
        } else if entry_path.is_dir() {
            Box::pin(copy_dir_recursive(&entry_path, &dest_path)).await?;
        }
    }

    Ok(())
}

/// Remove a file or directory
pub async fn remove(
    Json(payload): Json<RemoveRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let path = PathBuf::from(&payload.path);
    validate_path_safety(&path)?;

    if !path.exists() {
        return Err(ApiError::NotFound(format!(
            "Path not found: {}",
            payload.path
        )));
    }

    if path.is_file() {
        fs::remove_file(&path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                ApiError::Forbidden(format!("Permission denied: {}", payload.path))
            } else {
                ApiError::Internal(format!("Failed to remove file: {}", e))
            }
        })?;
    } else {
        fs::remove_dir_all(&path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                ApiError::Forbidden(format!("Permission denied: {}", payload.path))
            } else {
                ApiError::Internal(format!("Failed to remove directory: {}", e))
            }
        })?;
    }

    Ok(Json(serde_json::json!({
        "success": true,
        "path": payload.path
    })))
}

/// Query parameters for file search
#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub path: Option<String>,
    pub pattern: Option<String>,
    pub max_depth: Option<usize>,
}

/// Search response
#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub matches: Vec<FileEntry>,
    pub total: usize,
}

/// Search files and directories by glob pattern
pub async fn search(Query(params): Query<SearchQuery>) -> Result<Json<SearchResponse>, ApiError> {
    // Validate required parameters
    let root_path = params
        .path
        .as_deref()
        .ok_or_else(|| ApiError::BadRequest("Missing required parameter: path".to_string()))?;

    let pattern_str = params
        .pattern
        .as_deref()
        .ok_or_else(|| ApiError::BadRequest("Missing required parameter: pattern".to_string()))?;

    let root = PathBuf::from(root_path);
    validate_path_safety(&root)?;

    // Validate root path exists
    if !root.exists() {
        return Err(ApiError::NotFound(format!("Path not found: {}", root_path)));
    }

    // Validate root path is a directory
    if !root.is_dir() {
        return Err(ApiError::BadRequest(format!(
            "Path is not a directory: {}",
            root_path
        )));
    }

    // Parse glob pattern (case-insensitive matching)
    let pattern = glob::Pattern::new(pattern_str)
        .map_err(|e| ApiError::BadRequest(format!("Invalid glob pattern: {}", e)))?;
    let match_opts = glob::MatchOptions {
        case_sensitive: false,
        ..Default::default()
    };

    // Default max_depth to 10, clamp to 50
    let max_depth = params.max_depth.unwrap_or(10).min(50);

    // Walk directory tree and collect matches
    let matches: Vec<FileEntry> = tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();

        let walker = walkdir::WalkDir::new(&root)
            .max_depth(max_depth)
            .into_iter();

        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue, // Skip permission errors and other inaccessible entries
            };

            // Skip the root directory itself
            if entry.path() == root {
                continue;
            }

            let name = entry.file_name().to_string_lossy();
            if !pattern.matches_with(&name, match_opts) {
                continue;
            }

            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue, // Skip entries where metadata is inaccessible
            };

            let modified = metadata
                .modified()
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0)
                })
                .unwrap_or(0);

            let mode = metadata.permissions().mode();

            results.push(FileEntry {
                name: name.to_string(),
                path: Some(entry.path().to_string_lossy().to_string()),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
                modified,
                perms: format_permissions(mode),
            });
        }

        results
    })
    .await
    .map_err(|e| ApiError::Internal(format!("Search task failed: {}", e)))?;

    let total = matches.len();

    Ok(Json(SearchResponse { matches, total }))
}
