use axum::{
    body::Body,
    extract::Query,
    http::{header, Response},
};
use image::DynamicImage;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::utils::ApiError;

// ── Constants ──────────────────────────────────────────────────────────────

const THUMB_SIZE: u32 = 512;
const SMALL_FILE_THRESHOLD: u64 = 100 * 1024; // 100 KB
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_IMAGE_SIZE: u64 = 100 * 1024 * 1024; // 100 MB

// ── Supported Extensions (Lowercase) ───────────────────────────────────────

const SUPPORTED_IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "ico", "avif", "heic", "heif", "heifs", "jxl", "svg", "raw", "cr2", "cr3", "nef", "arw", "rw2"
];

const SUPPORTED_VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "webm", "avi", "mov", "wmv", "m4v", "3gp", "flv", "ts", "m2ts", "mts", "dat", "vob", "mpg", "mpeg", "mpe", "rm", "rmvb", "prores", "h264", "h265", "hevc"
];

fn is_image_ext(ext: &str) -> bool {
    SUPPORTED_IMAGE_EXTS.contains(&ext)
}

fn is_video_ext(ext: &str) -> bool {
    SUPPORTED_VIDEO_EXTS.contains(&ext)
}

fn is_supported_ext(ext: &str) -> bool {
    is_image_ext(ext) || is_video_ext(ext)
}

fn get_mime_by_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "heifs" => "image/heif-sequence",
        "jxl" => "image/jxl",
        "svg" => "image/svg+xml",
        "raw" => "image/x-raw",
        "cr2" => "image/x-canon-cr2",
        "cr3" => "image/x-canon-cr3",
        "nef" => "image/x-nikon-nef",
        "arw" => "image/x-sony-arw",
        "rw2" => "image/x-panasonic-rw2",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "flv" => "video/x-flv",
        "mov" => "video/quicktime",
        "wmv" => "video/x-ms-wmv",
        "m4v" => "video/x-m4v",
        "3gp" => "video/3gpp",
        "ts" | "m2ts" | "mts" => "video/mp2t",
        "dat" => "video/mpeg",
        "vob" => "video/dvd",
        "mpg" | "mpeg" | "mpe" => "video/mpeg",
        "rm" | "rmvb" => "application/vnd.rn-realmedia",
        "prores" => "video/quicktime",
        "h264" => "video/h264",
        "h265" | "hevc" => "video/hevc",
        _ => "application/octet-stream",
    }
}

// ── Query parameter ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ThumbnailQuery {
    pub path: String,
    pub cache: Option<u64>,
}

// ── Freedesktop cache logic ───────────────────────────────────────────────

use std::sync::atomic::{AtomicBool, Ordering};

static CACHE_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn disable_cache() {
    CACHE_ENABLED.store(false, Ordering::SeqCst);
}

pub fn is_cache_enabled() -> bool {
    CACHE_ENABLED.load(Ordering::SeqCst)
}

fn get_cache_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
        PathBuf::from(xdg).join("thumbnails").join("x-large")
    } else {
        dirs_home().join(".cache").join("thumbnails").join("x-large")
    }
}

fn get_fail_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
        PathBuf::from(xdg).join("thumbnails").join("fail").join("sidecar")
    } else {
        dirs_home().join(".cache").join("thumbnails").join("fail").join("sidecar")
    }
}

/// Return the user's home directory.
fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn canonical_file_uri(path: &Path) -> String {
    let path_str = path.to_string_lossy();
    let encoded: String = path_str
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '/' || c == '-' || c == '_' || c == '.' || c == '~' {
                c.to_string()
            } else {
                let mut buf = [0; 4];
                c.encode_utf8(&mut buf)
                    .as_bytes()
                    .iter()
                    .map(|b| format!("%{:02X}", b))
                    .collect()
            }
        })
        .collect();
    format!("file://{}", encoded)
}

fn compute_cache_path(source_path: &Path) -> PathBuf {
    let uri = canonical_file_uri(source_path);
    let digest = md5::compute(uri.as_bytes());
    let hex = format!("{:x}", digest);
    get_cache_dir().join(format!("{}.png", hex))
}

fn compute_fail_path(source_path: &Path) -> PathBuf {
    let uri = canonical_file_uri(source_path);
    let digest = md5::compute(uri.as_bytes());
    let hex = format!("{:x}", digest);
    get_fail_dir().join(format!("{}.png", hex))
}

pub fn ensure_cache_dir() -> std::io::Result<()> {
    let dir = get_cache_dir();
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn ensure_fail_dir() -> std::io::Result<()> {
    let dir = get_fail_dir();
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_failure_cache(source_path: &Path, mtime: u64, size: u64, mime: &str) {
    if !is_cache_enabled() {
        return;
    }
    if let Err(e) = ensure_fail_dir() {
        tracing::warn!("Failed to create fail cache directory: {}", e);
        return;
    }
    let img = DynamicImage::ImageRgba8(image::RgbaImage::new(1, 1));
    let uri = canonical_file_uri(source_path);
    match encode_thumb_png(&img, &uri, mtime, size, mime) {
        Ok(png_data) => {
            let fail_path = compute_fail_path(source_path);
            if let Err(e) = write_cache_file(&fail_path, &png_data) {
                tracing::warn!("Failed to write failure cache file: {}", e);
            } else {
                tracing::debug!("Successfully cached generation failure for {}", source_path.display());
            }
        }
        Err(e) => {
            tracing::warn!("Failed to encode failure PNG: {}", e);
        }
    }
}

fn write_cache_file(cache_path: &Path, data: &[u8]) -> std::io::Result<()> {
    std::fs::write(cache_path, data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(cache_path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

// ── PNG metadata (tEXt chunks) ────────────────────────────────────────────

fn encode_thumb_png(
    img: &DynamicImage,
    uri: &str,
    mtime: u64,
    size: u64,
    mime: &str,
) -> Result<Vec<u8>, ApiError> {
    // Resize to fit within 512×512 preserving aspect ratio
    let thumb = img.resize(
        THUMB_SIZE,
        THUMB_SIZE,
        image::imageops::FilterType::Lanczos3,
    );
    let rgba = thumb.to_rgba8();
    let (w, h) = rgba.dimensions();

    let mut buf: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buf, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Best);
        encoder
            .add_text_chunk("Thumb::URI".to_string(), uri.to_string())
            .map_err(|e| ApiError::Internal(format!("PNG text chunk error: {}", e)))?;
        encoder
            .add_text_chunk("Thumb::MTime".to_string(), mtime.to_string())
            .map_err(|e| ApiError::Internal(format!("PNG text chunk error: {}", e)))?;
        encoder
            .add_text_chunk("Thumb::Size".to_string(), size.to_string())
            .map_err(|e| ApiError::Internal(format!("PNG text chunk error: {}", e)))?;
        encoder
            .add_text_chunk("Thumb::Mimetype".to_string(), mime.to_string())
            .map_err(|e| ApiError::Internal(format!("PNG text chunk error: {}", e)))?;

        let mut writer = encoder
            .write_header()
            .map_err(|e| ApiError::Internal(format!("PNG header error: {}", e)))?;
        writer
            .write_image_data(&rgba)
            .map_err(|e| ApiError::Internal(format!("PNG write error: {}", e)))?;
    }
    Ok(buf)
}

fn read_thumb_mtime(cache_path: &Path) -> Option<u64> {
    let file = std::fs::File::open(cache_path).ok()?;
    let decoder = png::Decoder::new(file);
    let reader = decoder.read_info().ok()?;
    let info = reader.info();
    for chunk in &info.uncompressed_latin1_text {
        if chunk.keyword == "Thumb::MTime" {
            return chunk.text.parse::<u64>().ok();
        }
    }
    None
}

// ── Image thumbnail generation ────────────────────────────────────────────

async fn generate_image_thumbnail(source_path: PathBuf) -> Result<DynamicImage, ApiError> {
    tokio::task::spawn_blocking(move || {
        let data = std::fs::read(&source_path)
            .map_err(|e| ApiError::Internal(format!("Failed to read image file: {}", e)))?;
        image::load_from_memory(&data)
            .map_err(|e| ApiError::Internal(format!("Failed to decode image: {}", e)))
    })
    .await
    .map_err(|e| ApiError::Internal(format!("Blocking task failed: {}", e)))?
}

// ── Video frame extraction ────────────────────────────────────────────────

async fn extract_video_frame(source_path: &Path) -> Result<DynamicImage, ApiError> {
    use tokio::process::Command;

    let child = Command::new("ffmpeg")
        .args([
            "-i",
            &source_path.display().to_string(),
            "-ss",
            "00:00:01",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ApiError::Internal(
                    "ffmpeg not installed — required for video thumbnails".to_string(),
                )
            } else {
                ApiError::Internal(format!("Failed to spawn ffmpeg: {}", e))
            }
        })?;

    // Apply timeout — use select to keep ownership of child for kill
    let output = tokio::select! {
        result = child.wait_with_output() => {
            result.map_err(|e| ApiError::Internal(format!("ffmpeg process error: {}", e)))?
        }
        _ = tokio::time::sleep(FFMPEG_TIMEOUT) => {
            // Timeout — kill is best-effort since child may have been consumed
            return Err(ApiError::Internal(
                "ffmpeg timed out after 10 seconds".to_string(),
            ));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::Internal(format!(
            "ffmpeg failed (exit {}): {}",
            output.status, stderr
        )));
    }

    // Decode the PNG frame from stdout
    let frame_data = output.stdout;
    tokio::task::spawn_blocking(move || {
        image::load_from_memory(&frame_data)
            .map_err(|e| ApiError::Internal(format!("Failed to decode ffmpeg frame: {}", e)))
    })
    .await
    .map_err(|e| ApiError::Internal(format!("Blocking task failed: {}", e)))?
}

// ── Main handler ──────────────────────────────────────────────────────────

pub async fn thumbnail(Query(params): Query<ThumbnailQuery>) -> Result<Response<Body>, ApiError> {
    // Compute Cache-Control header from query parameter
    let cache_header = match params.cache {
        Some(0) => "no-cache, no-store, must-revalidate".to_string(),
        Some(seconds) => format!("private, max-age={}, immutable", seconds),
        None => "private, max-age=604800, immutable".to_string(),
    };

    let source_path = PathBuf::from(&params.path);

    // Skip thumbnail generation and serve directly if requested file resides in the thumbnails cache to avoid infinite loops
    let path_str = source_path.to_string_lossy();
    if path_str.contains(".cache/thumbnails")
        || source_path.starts_with(get_cache_dir())
        || source_path.starts_with(get_fail_dir())
    {
        match tokio::fs::read(&source_path).await {
            Ok(data) => {
                let len = data.len();
                let ext = source_path
                    .extension()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_ascii_lowercase())
                    .unwrap_or_default();
                let mime_str = if ext.is_empty() { "image/png" } else { get_mime_by_ext(&ext) };
                return Response::builder()
                    .header(header::CONTENT_TYPE, mime_str)
                    .header(header::CONTENT_LENGTH, len)
                    .header(header::CACHE_CONTROL, &cache_header)
                    .body(Body::from(data))
                    .map_err(|e| ApiError::Internal(format!("Response build error: {}", e)));
            }
            Err(_) => {
                return Err(ApiError::NotFound(format!(
                    "Cached file not found or inaccessible: {}",
                    params.path
                )));
            }
        }
    }

    let ext = source_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    // 1. Static extension match (Early Fail - 0 Disk I/O)
    if !is_supported_ext(&ext) {
        return Err(ApiError::BadRequest(format!(
            "File type not supported for thumbnailing: .{}",
            ext
        )));
    }

    // 2. Strict file existence and metadata check
    let metadata = match tokio::fs::metadata(&source_path).await {
        Ok(m) => m,
        Err(_) => {
            // No file existence -> return 400 Bad Request directly without writing failure cache
            return Err(ApiError::BadRequest(format!(
                "File not found: {}",
                params.path
            )));
        }
    };

    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let file_size = metadata.len();
    let mime_str = get_mime_by_ext(&ext);

    // 3. Cache Lookups (Normal and Fail)
    let cache_enabled = is_cache_enabled();
    if cache_enabled {
        // A. Check normal cache
        let cache_path = compute_cache_path(&source_path);
        if cache_path.exists() {
            if let Some(cached_mtime) = read_thumb_mtime(&cache_path) {
                if cached_mtime == mtime {
                    // Cache hit — serve cached thumbnail
                    let data = tokio::fs::read(&cache_path).await.map_err(|e| {
                        ApiError::Internal(format!("Failed to read cached thumbnail: {}", e))
                    })?;
                    let len = data.len();
                    return Response::builder()
                        .header(header::CONTENT_TYPE, "image/png")
                        .header(header::CONTENT_LENGTH, len)
                        .header(header::CACHE_CONTROL, &cache_header)
                        .body(Body::from(data))
                        .map_err(|e| ApiError::Internal(format!("Response build error: {}", e)));
                }
            }
        }

        // B. Check failure cache
        let fail_path = compute_fail_path(&source_path);
        if fail_path.exists() {
            if let Some(failed_mtime) = read_thumb_mtime(&fail_path) {
                if failed_mtime == mtime {
                    tracing::debug!("Thumbnail generation previously failed and cached for {}", source_path.display());
                    return Err(ApiError::NotFound(
                        "Thumbnail generation previously failed for this file".to_string()
                    ));
                }
            }
        }
    }

    // 4. Small File Passthrough (Image size < 100KB)
    if is_image_ext(&ext) && file_size < SMALL_FILE_THRESHOLD {
        let data = tokio::fs::read(&source_path)
            .await
            .map_err(|e| ApiError::Internal(format!("Failed to read file: {}", e)))?;
        let len = data.len();
        return Response::builder()
            .header(header::CONTENT_TYPE, mime_str)
            .header(header::CONTENT_LENGTH, len)
            .header(header::CACHE_CONTROL, &cache_header)
            .body(Body::from(data))
            .map_err(|e| ApiError::Internal(format!("Response build error: {}", e)));
    }

    // 5. Size Limit Protection
    if is_image_ext(&ext) && file_size > MAX_IMAGE_SIZE {
        write_failure_cache(&source_path, mtime, file_size, mime_str);
        return Err(ApiError::NotFound(
            "Source file too large for thumbnail generation".to_string(),
        ));
    }

    // 6. Generate Thumbnail
    let img_result = if is_video_ext(&ext) {
        extract_video_frame(&source_path).await
    } else {
        generate_image_thumbnail(source_path.clone()).await
    };

    let img = match img_result {
        Ok(image) => image,
        Err(e) => {
            write_failure_cache(&source_path, mtime, file_size, mime_str);
            // Return 404 Not Found on generation failure to let frontend gracefully degrade
            return Err(ApiError::NotFound(format!(
                "Failed to generate thumbnail: {}",
                e
            )));
        }
    };

    // 7. Encode PNG with metadata
    let uri = canonical_file_uri(&source_path);
    let png_data = match encode_thumb_png(&img, &uri, mtime, file_size, mime_str) {
        Ok(data) => data,
        Err(e) => {
            write_failure_cache(&source_path, mtime, file_size, mime_str);
            return Err(ApiError::NotFound(format!(
                "Failed to encode thumbnail: {}",
                e
            )));
        }
    };

    // 8. Write to cache (best-effort)
    if cache_enabled {
        let cache_path = compute_cache_path(&source_path);
        let cache_data = png_data.clone();
        let cache_target = cache_path.clone();
        if let Err(e) =
            tokio::task::spawn_blocking(move || write_cache_file(&cache_target, &cache_data))
                .await
                .unwrap_or_else(|e| Err(std::io::Error::new(std::io::ErrorKind::Other, e)))
        {
            tracing::warn!("Failed to write thumbnail cache: {}", e);
        }
    }

    // Serve the generated thumbnail
    let len = png_data.len();
    Response::builder()
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CONTENT_LENGTH, len)
        .header(header::CACHE_CONTROL, &cache_header)
        .body(Body::from(png_data))
        .map_err(|e| ApiError::Internal(format!("Response build error: {}", e)))
}
