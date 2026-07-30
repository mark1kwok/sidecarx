````markdown
# Sidecar API Documentation

**Version:** 0.1.8

A lightweight, high-performance file system, terminal API, and reverse proxy written in Rust. Deploy as a container wrapper for your web applications (AI chatbots, Telegram bots, admin panels) to provide secure file management, remote terminal access, and unified routing.

## What's New in v0.1.8

- **Token-only Media Fetch Auth**: Login now returns a single `fetchToken` (format: `signature.key`) for URL media auth; separate `fetchKey` is removed.
- **URL Fallback Scope**: URL token fallback applies only to `/admin/api/fs/read` and `/admin/api/fs/thumbnail`, and only when Authorization/cookie auth is absent.
- **Media MIME Guard**: URL-authenticated `/admin/api/fs/read` is restricted to `image/*`, `video/*`, `audio/*`, `application/pdf`.
- **Partitioned Auth Cookie**: HTTPS cookie policy now includes `Partitioned` with `Secure; SameSite=None`.

## What's New in v0.1.7

- **Terminal Hotkeys**: Copy (`Ctrl+Shift+C`) and paste (`Ctrl+V` / `Ctrl+Shift+V`) keyboard shortcuts added to the terminal panel. Ctrl+C is preserved as SIGINT. Right-click shows the browser's native context menu.
- **Client-Side File Filter**: The file browser search input filters the current directory listing by case-insensitive name substring as the user types (no API call, 150 ms debounce). Empty input restores the full listing.
- **API File Search**: Pressing Enter in the search input triggers a backend glob search (`GET /admin/api/fs/search`) with the query wrapped as `*query*`. Results display in list view; pressing Escape or the × button exits search mode and reloads the current directory.
- **Media Viewer Interactions**: Image zoom via scroll wheel (0.25×–10×) and double-click toggle (1× ↔ 2×). Touch swipe gestures for navigation (left/right) and close (up/down). Key events no longer propagate from the viewer to the file browser.
- **Settings Modal Rewrite**: Settings modal now shows only a Machines management section (add/edit/remove remote sidecar machines). Theme, Favorites, and File Type Icons sections removed.
- **`admin_cfg.json` Persistence**: Admin panel configuration (machines list, theme, favorites, etc.) is stored as `admin_cfg.json` in the sidecar working directory. Loaded via `GET /admin/api/fs/read` and saved via `PUT /admin/api/fs/write` — no separate config API endpoint needed.

## What's New in v0.1.6c

- **WebSocket Terminal Auth via Subprotocol**: Terminal WebSocket now authenticates via `Sec-WebSocket-Protocol: auth-token.<jwt>` (the 2nd argument to the browser `WebSocket()` constructor), fixing iOS Safari ITP-suppressed cookie issues.
- **Updated Auth Resolution Order**: `Authorization: Bearer` header → `Sec-WebSocket-Protocol: auth-token.<token>` (WebSocket only) → `Cookie: token=` → 401 Unauthorized.

## What's New in v0.1.6b

- **WebSocket Proxy Rewritten as Raw TCP Tunnel**: WS proxying now uses `hyper::upgrade` + `tokio::io::copy_bidirectional` for maximum transparency and efficiency. Bidirectional close propagation fully preserved.
- **WSS Upstream TLS Support**: Added `tokio-rustls` + `webpki-roots` for TLS when proxying to `wss://` upstream services.

## What's New in v0.1.6a

- **X-Forwarded-Proto Cookie Policy**: Cookie `Secure` and `SameSite` flags are now determined by `X-Forwarded-Proto: https` (de-facto standard set by Railway, nginx, Caddy, AWS ALB) or `X-Forwarded-Ssl: on` (alternative). Replaces the previous `Origin`-header-scheme detection (v0.1.5). HTTP or unknown → `SameSite=Lax`; HTTPS → `Secure; SameSite=None`.

## What's New in v0.1.5

- **Origin-Scheme Cookie Attributes** _(superseded by v0.1.6a)_: Cookie `Secure` and `SameSite` flags were determined by the `Origin` header's scheme. Replaced in v0.1.6a by `X-Forwarded-Proto`/`X-Forwarded-Ssl` detection.
- **Proxy Set-Cookie Path Rewriting**: `Set-Cookie` headers from upstream have their `Path=` attribute prepended with the route prefix (e.g., `Path=/admin/api` → `Path=/car/admin/api` for route `/car`). Ensures cookies are scoped correctly behind proxy paths.
- **Proxy Multi-Value Header Preservation**: Response header forwarding now uses `append` instead of `insert`, preserving all values for multi-value headers like `Set-Cookie`.

## What's New in v0.1.4c

- **Thumbnail Generation**: New `GET /admin/api/fs/thumbnail` endpoint generates 256×256 PNG thumbnails for images (JPEG, PNG, WebP, etc.) and videos (MP4, MKV, etc. via optional `ffmpeg`). Cached per freedesktop.org standard (`~/.cache/thumbnails/large/`).
- **HTTPS Proxy Support**: Reverse proxy can now forward to `https://` upstream services via `hyper-rustls`.
- **Proxy Location Header Rewriting**: `Location` redirect headers from upstream are rewritten to prepend the route prefix, keeping redirects correct behind the proxy path.
- **`cache=0` Support**: `GET /admin/api/fs/read` and `GET /admin/api/fs/thumbnail` now return `Cache-Control: no-cache, no-store, must-revalidate` when `?cache=0` is specified.
- **Configurable Upload Limit**: Upload size limit is now configurable via `SIDECAR_UPLOAD_LIMIT` env var (default 1024 MB, shared by upload and write endpoints).

## What's New in v0.1.4b

- **Proxy Prefix Stripping**: Reverse proxy now strips the matched route prefix before forwarding to upstream (e.g., route `/icon` + request `/icon/logo.png` → upstream receives `/logo.png`). Route paths are normalized at config load time (trailing slashes stripped).
- **Streaming ZIP Downloads**: Directory and batch downloads now stream ZIP archives via `async_zip` with a 128 MB bounded duplex buffer — memory usage no longer grows with archive size.
- **Early 413 Rejection**: Upload (`POST /fs/upload`) and write (`PUT /fs/write`) check `Content-Length` before reading body. Requests exceeding the configured limit are rejected immediately with HTTP 413.
- **Streaming Upload/Write**: Upload and write endpoints now stream data directly to disk via `tokio::io::copy` — memory usage is O(chunk-size) instead of O(file-size).

## What's New in v0.1.4a

- **Hybrid Cookie Auth**: Login now sets an `HttpOnly` auth cookie alongside the JWT response — browsers auto-attach it on subsequent requests (including WebSocket upgrades)
- **Conditional Cookie Attributes**: HTTP requests get `SameSite=Lax` (no `Secure`); HTTPS requests get `SameSite=None; Secure`. Detection method upgraded in v0.1.6a to use `X-Forwarded-Proto`/`X-Forwarded-Ssl` headers (previously used `Origin` header scheme).
- **Auth Resolution Order**: `Authorization: Bearer` header → `Cookie: token=` → 401 Unauthorized
- **Logout Endpoint**: New `POST /admin/api/auth/logout` clears the auth cookie (no auth required, uses same conditional cookie attributes)
- **CORS Credentials**: Dynamic origin echo (`Access-Control-Allow-Origin` mirrors request `Origin`) with `Access-Control-Allow-Credentials: true` and `Vary: Origin`
- **Cache Headers**: `GET /admin/api/fs/read` and `GET /admin/api/fs/thumbnail` accept `?cache=<seconds>` — controls `Cache-Control` response header (see Cache Behavior below)
- **BREAKING**: `?token=` query parameter auth removed from all endpoints (including WebSocket terminal)

## What's New in v0.1.3

- **Read File Endpoint**: New `GET /admin/api/fs/read` streams file content with detected MIME type — ideal for in-browser viewing and editor integration (Monaco, CodeMirror)
- **Write File Endpoint**: New `PUT /admin/api/fs/write` accepts raw request body and writes to disk — parent directories are created automatically
- **CORS Authorization Fix**: Replaced wildcard `Any` allowed headers with explicit list (`Authorization`, `Content-Type`, `Accept`) to eliminate browser deprecation warnings
- **Upload Body Limit**: Configurable via `SIDECAR_UPLOAD_LIMIT` env var (default 1024 MB)
- **Upload Auto-Create Directory**: Upload endpoint now creates the target directory automatically if it doesn't exist (previously returned 404)

## What's New in v0.1.2

- **File Search Endpoint**: New `GET /admin/api/fs/search` for recursive glob-based file/directory search with depth limits
- **Upload Path Preservation**: Uploaded filenames can include subdirectory paths (e.g., `docs/readme.md`); parent directories are created automatically
- **Upload Path-Traversal Protection**: Filenames are validated to reject `..` components, absolute paths, null bytes, and empty segments
- **Static Serving Fix**: Removed SPA fallback — missing files under `/admin/*` now correctly return 404 instead of `index.html`
- **Trailing-Slash Redirect**: `/admin` (no slash) now 301-redirects to `/admin/` for correct relative asset resolution
- **Proxy Fallback Fix**: Unmatched proxy paths now return 404 instead of redirecting to `/admin/`; only `/` redirects to `/admin/`

## Quick Start

### 1. Deploy the Binary

Copy the `sidecar` binary to your project:

```bash
cp sidecar /path/to/your/project/
chmod +x /path/to/your/project/sidecar
```

### 2. Configure Environment

Create a `.env` file in the same directory as the binary:

```bash
# Port to listen on
SIDECAR_PORT=3000

# Interface (0.0.0.0 for all, 127.0.0.1 for localhost only)
SIDECAR_HOST=0.0.0.0

# Secret key for JWT authentication (CHANGE THIS!)
SIDECAR_SECRET=change_me_to_something_secure

# Directory for admin panel static files (default: ./panel)
SIDECAR_PANEL_DIR=./admin

# Path to proxy configuration file (default: ./proxy.json)
SIDECAR_PROXY_CONFIG=./proxy.json

# Single file upload size limit in MB (default: 1024)
SIDECAR_UPLOAD_LIMIT=1024
```

### 3. Configure Proxy Routes (Optional)

Create a `proxy.json` file to route requests to upstream services:

```json
{
  "routes": [
    { "path": "/", "upstream": "http://localhost:8080" },
    { "path": "/api/v2", "upstream": "http://localhost:3001" }
  ]
}
```

**Route Matching:** Uses longest-prefix matching. `/api/v2/users` matches `/api/v2` over `/`.

### 4. Prepare Admin Panel (Optional)

Place your SPA files in the panel directory:

```
panel/
├── index.html
├── style.css
├── app.js
└── static/
    └── ...
```

### 5. Run the Server

```bash
./sidecar
```

The server will be available at `http://localhost:3000` (or your configured host/port).

---

## URL Structure

| Path | Handler | Description |
|------|---------|-------------|
| `/admin/api/*` | API Routes | Backend API endpoints (auth, file system, terminal) |
| `/admin/*` | Static Files | Admin Panel static files (404 for unknown paths) |
| `/*` | Reverse Proxy | Forwards to upstream based on `proxy.json` |

**Route Priority:** API (exclusive) → Static (exclusive) → Proxy (404 if no route; `/` redirects to `/admin/`)

---

## Authentication

All API endpoints (except `/admin/api/auth/login` and `/admin/api/auth/logout`) require a valid JWT token.

**Auth Resolution Order (v0.1.8):** The server checks for a token in this order:
1. `Authorization: Bearer <token>` header
2. `Cookie: token=<token>` cookie
3. `Sec-WebSocket-Protocol: auth-token.<token>` (WebSocket connections only)
4. URL fallback query `token=<fetch-token>` (allowed only on `/admin/api/fs/read` and `/admin/api/fs/thumbnail`)
5. If none is present → `401 Unauthorized`

### Login

**Endpoint:** `POST /admin/api/auth/login`

**Request:**
```json
{
  "secret": "your_super_secret_key_here"
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "fetchToken": "<hmac-signature>.<base64-exp-jwt>"
}
```

**Response Headers (v0.1.6a):**

Cookie security attributes are determined by forwarded protocol headers set by the upstream proxy (Railway, nginx, Caddy, AWS ALB, etc.):

- **HTTP / unknown** (no `X-Forwarded-Proto` or `X-Forwarded-Ssl: on`):
```
Set-Cookie: token=<jwt>; Path=/admin/api; HttpOnly; SameSite=Lax
```
- **HTTPS** (`X-Forwarded-Proto: https` or `X-Forwarded-Ssl: on`):
```
Set-Cookie: token=<jwt>; Path=/admin/api; HttpOnly; Secure; SameSite=None; Partitioned
```

**Token Expiry:** 7 days

**Cookie Attributes:**
| Attribute | HTTP / unknown | HTTPS (X-Forwarded) | Purpose |
|-----------|---------------|---------------------|--------|
| `Path` | `/admin/api` | `/admin/api` | Cookie scoped to API routes only |
| `HttpOnly` | Yes | Yes | Not accessible via JavaScript (XSS protection) |
| `Secure` | No | Yes | Only sent over HTTPS (required for `SameSite=None`) |
| `SameSite` | `Lax` | `None` | Lax works over HTTP; None allows cross-origin sends |
| `Partitioned` | No | Yes | Enables CHIPS partitioned cookie storage in supporting browsers |

### Logout

**Endpoint:** `POST /admin/api/auth/logout`

**Auth Required:** No

**Response:**
```json
{
  "success": true
}
```

**Response Headers:**

Cookie attributes match the login behavior (determined by `X-Forwarded-Proto`/`X-Forwarded-Ssl` headers):
- **HTTP / unknown**: `Set-Cookie: token=; Path=/admin/api; Max-Age=0; HttpOnly; SameSite=Lax`
- **HTTPS (X-Forwarded)**: `Set-Cookie: token=; Path=/admin/api; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`

**Notes:** Clears the auth cookie by setting `Max-Age=0`. No authentication required.

### Check Auth Status

**Endpoint:** `GET /admin/api/auth/status`

**Headers:**
```
Authorization: Bearer <token>
```

Or: Auth cookie (automatically attached by browser after login).

**Response (valid token):**
```json
{
  "valid": true,
  "exp": 1738540800
}
```

**Response (invalid/missing token):** `401 Unauthorized`

### Using the Token

Include the token in the `Authorization` header for all subsequent requests:

```
Authorization: Bearer <token>
```

Alternatively, if logged in via browser, the auth cookie is sent automatically — no manual token handling needed.

### URL Media Fetch Token (v0.1.8)

For remote WebKit media fetching, login also provides a deterministic fetch token:

- `fetchToken = signature.key`
- `signature = HMAC-SHA256(base64(server_secret) + referer + key)`
- `key = base64(exp_jwt)`

URL fallback accepts only this single query parameter:

```
GET /admin/api/fs/read?path=...&token=<fetchToken>
GET /admin/api/fs/thumbnail?path=...&token=<fetchToken>
```

Validation requires:
- endpoint is allowed (`/fs/read` or `/fs/thumbnail`)
- no valid Authorization/cookie/ws auth already present
- token format is valid (`signature.key`)
- embedded expiry key is not expired
- signature matches request `Referer`

---

## File System API

### List Directory

**Endpoint:** `GET /admin/api/fs/list?path=/absolute/path`

**Response:**
```json
[
  {
    "name": "documents",
    "is_dir": true,
    "size": 4096,
    "modified": 1705248000,
    "perms": "rwxr-xr-x"
  },
  {
    "name": "config.json",
    "is_dir": false,
    "size": 1024,
    "modified": 1705247000,
    "perms": "rw-r--r--"
  }
]
```

**Notes:**
- Results are sorted: directories first, then alphabetically
- Includes hidden files (dotfiles)
- `modified` is Unix timestamp (seconds)
- Search results include an additional `path` field (absolute path)

---

### Read File (Inline)

**Endpoint:** `GET /admin/api/fs/read?path=/absolute/path/to/file`

**Query Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `path` | Yes | - | Absolute path to the file to read |
| `cache` | No | - | Cache duration in seconds (v0.1.4a) |

**Response:** File content streamed with detected MIME type (no `Content-Disposition: attachment` header).

**Headers:**
```
Content-Type: text/plain (or detected MIME type)
Content-Length: 2048
```

**Cache Behavior (v0.1.4a+):**

| `cache` param | `Cache-Control` header |
|---|---|
| Absent | No header (browser default) |
| `0` | `no-cache, no-store, must-revalidate` |
| `3600` (positive) | `private, max-age=3600, immutable` |

> **Note:** `/fs/thumbnail` differs — when `cache` is absent, it defaults to `private, max-age=604800, immutable` (1 week) since thumbnails are expensive to generate.

**Example (curl):**
```bash
# Read file (no caching)
curl -s "http://localhost:3000/admin/api/fs/read?path=/home/user/code/main.rs" \
  -H "Authorization: Bearer $TOKEN"

# Read file with 1-hour cache
curl -s "http://localhost:3000/admin/api/fs/read?path=/home/user/code/main.rs&cache=3600" \
  -H "Authorization: Bearer $TOKEN"
```

**Notes:**
- Unlike `/fs/download`, the response has no `Content-Disposition: attachment` header — browsers will display the content inline rather than triggering a download
- MIME type is auto-detected from the file extension (e.g., `.rs` → `text/x-rust`, `.json` → `application/json`)
- Ideal for editor integration (Monaco, CodeMirror) and in-browser file viewing
- Returns 400 if `path` is missing, 404 if file doesn't exist, 400 if path is a directory
- The `cache` parameter is fully opt-in; omitting it preserves default no-cache behavior

---

### Write File

**Endpoint:** `PUT /admin/api/fs/write?path=/absolute/path/to/file`

**Content-Type:** Any (raw request body is written as-is)

**Example (curl):**
```bash
# Write text content
curl -X PUT "http://localhost:3000/admin/api/fs/write?path=/home/user/code/main.rs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary @main.rs

# Write from stdin
echo 'hello world' | curl -X PUT "http://localhost:3000/admin/api/fs/write?path=/home/user/hello.txt" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary @-
```

**Response:**
```json
{
  "success": true,
  "path": "/home/user/code/main.rs",
  "size": 2048
}
```

**Notes:**
- Request body is streamed directly to disk via `tokio::io::copy` (v0.1.4b: O(chunk-size) memory, binary-safe)
- Parent directories are created automatically if they don't exist
- Overwrites existing files without warning
- Returns 400 if `path` is missing, contains null bytes, or points to an existing directory
- **Early 413 rejection (v0.1.4b):** If `Content-Length` header exceeds the configured upload limit (`SIDECAR_UPLOAD_LIMIT`, default 1024 MB), returns HTTP 413 immediately without reading body
- Maximum body size: configurable via `SIDECAR_UPLOAD_LIMIT` (shared limit with upload endpoint)
- `size` in response is obtained from file metadata after writing

---

### Download File

**Endpoint:** `GET /admin/api/fs/download?path=/absolute/path/to/file`

**Response:** File stream with appropriate MIME type

**Headers:**
```
Content-Type: application/octet-stream (or detected MIME type)
Content-Disposition: attachment; filename="filename.ext"
```

---

### Download Directory (as ZIP)

**Endpoint:** `GET /admin/api/fs/download?path=/absolute/path/to/directory`

**Response:** Streamed ZIP file containing the directory contents

---

### Batch Download (Multiple Files/Folders)

**Endpoint:** `POST /admin/api/fs/download-batch`

**Request:**
```json
[
  "/path/to/file1.txt",
  "/path/to/folder",
  "/path/to/file2.pdf"
]
```

**Response:** Streamed ZIP file containing all requested items

---

### Upload Files

**Endpoint:** `POST /admin/api/fs/upload?path=/target/directory`

**Content-Type:** `multipart/form-data`

**Example (curl):**
```bash
curl -X POST "http://localhost:3000/admin/api/fs/upload?path=/home/user/uploads" \
  -H "Authorization: Bearer <token>" \
  -F "file1=@document.pdf" \
  -F "file2=@image.png"
```

**Response:**
```json
{
  "success": true,
  "uploaded": ["document.pdf", "image.png"]
}
```

**Notes:**
- Supports multiple files in a single request
- Overwrites existing files with the same name
- **Streaming to disk (v0.1.4b):** Each file is streamed directly to disk via `tokio::io::copy` — O(chunk-size) memory per file instead of buffering entire files
- **Early 413 rejection (v0.1.4b):** If `Content-Length` header exceeds the configured upload limit (`SIDECAR_UPLOAD_LIMIT`, default 1024 MB), returns HTTP 413 immediately without reading body
- Maximum body size: configurable via `SIDECAR_UPLOAD_LIMIT` (default 1024 MB)
- **Auto-create target directory (v0.1.3):** Target directory is created automatically if it doesn't exist (previously returned 404)
- **Subdirectory paths supported (v0.1.2):** Filenames can include relative paths (e.g., `docs/readme.md`). Parent directories are created automatically.
- **Path-traversal protection:** Filenames with `..`, absolute paths (`/`), null bytes, or empty segments are rejected with 400 Bad Request.

---

### Create Directory

**Endpoint:** `POST /admin/api/fs/mkdir`

**Request:**
```json
{
  "path": "/absolute/path/to/new/directory"
}
```

**Response:**
```json
{
  "success": true,
  "path": "/absolute/path/to/new/directory"
}
```

**Notes:** Creates parent directories if they don't exist (like `mkdir -p`)

---

### Rename / Move

**Endpoint:** `POST /admin/api/fs/rename`

**Request:**
```json
{
  "from": "/path/to/original",
  "to": "/path/to/destination"
}
```

**Response:**
```json
{
  "success": true,
  "from": "/path/to/original",
  "to": "/path/to/destination"
}
```

**Notes:** Works for both files and directories

---

### Copy

**Endpoint:** `POST /admin/api/fs/copy`

**Request:**
```json
{
  "from": "/path/to/source",
  "to": "/path/to/destination"
}
```

**Response:**
```json
{
  "success": true,
  "from": "/path/to/source",
  "to": "/path/to/destination"
}
```

**Notes:** Recursive copy for directories

---

### Delete

**Endpoint:** `DELETE /admin/api/fs/remove`

**Request:**
```json
{
  "path": "/path/to/delete"
}
```

**Response:**
```json
{
  "success": true,
  "path": "/path/to/delete"
}
```

**⚠️ Warning:** Recursive delete for directories. Use with caution!

---

### Search Files/Directories

**Endpoint:** `GET /admin/api/fs/search?path=/root/dir&pattern=*.rs`

**Query Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `path` | Yes | - | Root directory to search from |
| `pattern` | Yes | - | Glob pattern matched against file/directory names |
| `max_depth` | No | 10 | Maximum recursion depth (clamped to 50) |

**Response:**
```json
{
  "matches": [
    {
      "name": "main.rs",
      "path": "/root/dir/src/main.rs",
      "is_dir": false,
      "size": 2048,
      "modified": 1705248000,
      "perms": "rw-r--r--"
    },
    {
      "name": "lib.rs",
      "path": "/root/dir/src/lib.rs",
      "is_dir": false,
      "size": 512,
      "modified": 1705247000,
      "perms": "rw-r--r--"
    }
  ],
  "total": 2
}
```

**Notes:**
- Pattern matching is case-insensitive
- Pattern matches against the filename only (last path component), not the full path
- Directories can match (returned with `is_dir: true`)
- Inaccessible entries (permission denied) are silently skipped
- `max_depth` defaults to 10 if not specified; values above 50 are clamped to 50
- Missing `path` or `pattern` returns 400 Bad Request
- Non-existent `path` returns 404; non-directory `path` returns 400

---

### Generate Thumbnail (v0.1.4c)

**Endpoint:** `GET /admin/api/fs/thumbnail?path=/absolute/path/to/file`

**Query Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Absolute path to the source image or video file |
| `cache` | No | Cache duration in seconds (default: 604800 = 1 week) |

**Supported Image Types:** JPEG, PNG, GIF, WebP, BMP, TIFF, AVIF, ICO

**Supported Video Types:** MP4, MKV, WebM, AVI, MOV, FLV, WMV, M4V, 3GP (requires `ffmpeg` — optional, install separately)

**Response (generated thumbnail):**
- `Content-Type: image/png`
- `Content-Length: <bytes>`
- `Cache-Control`: controlled by `?cache` param (default: `private, max-age=604800, immutable`)
- Body: 256×256 px PNG thumbnail (aspect ratio preserved, Lanczos3 downscale)

**Response (small file passthrough):**
- For images < 50 KB with web-compatible MIME types (JPEG, PNG, GIF, WebP)
- `Content-Type: <original MIME type>`
- `Content-Length: <bytes>`
- `Cache-Control`: controlled by `?cache` param (default: `private, max-age=604800, immutable`)
- Body: Original file bytes (no generation, no cache entry)

**Cache Behavior:**

| `cache` param | `Cache-Control` header |
|---|---|
| Absent | `private, max-age=604800, immutable` (1 week default) |
| `0` | `no-cache, no-store, must-revalidate` |
| `3600` (positive) | `private, max-age=3600, immutable` |

> Unlike `/fs/read` (no header when absent), thumbnails default to 1-week cache since they are expensive to generate.

**Caching (freedesktop.org Thumbnail Managing Standard):**
- Thumbnails cached at `$XDG_CACHE_HOME/thumbnails/large/<MD5>.png` (default `~/.cache/thumbnails/large/`)
- Cache key: MD5 hex digest of canonical file URI (`file:///absolute/path`)
- Cache validation: `Thumb::MTime` in PNG tEXt chunk compared against source file mtime
- Stale cache entries are regenerated automatically on next request
- Directory permissions: `0700`; file permissions: `0600`

**Error Responses:**
| Status | Condition |
|--------|-----------|
| 400 | Missing `path` parameter |
| 400 | Unsupported file type (e.g., `.txt`, `.pdf`) |
| 401 | Not authenticated |
| 404 | File does not exist |
| 500 | Source image file > 100 MB |
| 500 | `ffmpeg` not installed (video thumbnails only) |
| 500 | `ffmpeg` timeout (> 10 seconds) |

**Examples:**

```bash
# Image thumbnail
curl -s http://localhost:3000/admin/api/fs/thumbnail?path=/home/user/photo.jpg \
  -H "Authorization: Bearer $TOKEN" --output thumb.png

# Video thumbnail (requires ffmpeg)
curl -s http://localhost:3000/admin/api/fs/thumbnail?path=/home/user/video.mp4 \
  -H "Authorization: Bearer $TOKEN" --output thumb.png
```

---

## System API

### System Stats
`GET /admin/api/sys/stats`

Returns the current hardware utilization statistics including RAM and Disk space.

**Headers:**
- `Authorization: Bearer <token>`
OR
- `Cookie: token=<token>`

**Response (200 OK):**
```json
{
  "ram_total": 33177698304,
  "ram_used": 15474323456,
  "ram_available": 17703374848,
  "disk_total": 244615962624,
  "disk_used": 105655762944,
  "disk_available": 138960199680
}
```

## Terminal WebSocket API

### Connect to Terminal

**Endpoint:** `GET /admin/api/ws/terminal?cols=80&rows=24`

**Protocol:** WebSocket

**Authentication (v0.1.6c):** Primary: `Sec-WebSocket-Protocol: auth-token.<jwt>` subprotocol header (passed as 2nd arg to browser `WebSocket()` constructor). Fallback: `Authorization: Bearer` header or auth cookie. The `?token=` query parameter has been **removed**.

**Query Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `cols`    | No       | 80      | Terminal width in columns |
| `rows`    | No       | 24      | Terminal height in rows |

**Example (JavaScript):**
```javascript
// JWT passed via Sec-WebSocket-Protocol header (reliable on all browsers including iOS Safari)
const token = localStorage.getItem('auth_token_default');
const ws = new WebSocket(
  `ws://localhost:3000/admin/api/ws/terminal?cols=120&rows=40`,
  [`auth-token.${token}`]
);

ws.onopen = () => {
  console.log("Terminal connected");
};

ws.onmessage = (event) => {
  // event.data contains terminal output (binary)
  const output = new TextDecoder().decode(event.data);
  console.log(output);
};

// Send input to terminal
ws.send("ls -la\n");

ws.onclose = () => {
  console.log("Terminal disconnected");
};
```

**Notes:**
- Spawns a PTY running the user's default shell (`$SHELL` or `/bin/bash`)
- Bidirectional text communication
- Send keyboard input as text messages
- Receive terminal output as binary messages

### Terminal Keyboard Shortcuts (v0.1.7)

The following shortcuts are handled by the browser-side terminal panel:

| Shortcut | Action |
|----------|--------|
| `Ctrl+V` | Paste clipboard text into PTY |
| `Ctrl+Shift+V` | Paste clipboard text into PTY (Linux convention) |
| `Ctrl+Shift+C` | Copy current terminal selection to clipboard (no-op if nothing selected) |
| `Ctrl+C` | SIGINT (`\x03`) — passed through to PTY unchanged |

**Notes:**
- Clipboard operations use `navigator.clipboard` API (requires a secure context or explicit permission)
- If `navigator.clipboard` is unavailable, clipboard operations silently fail with a console warning
- Right-click shows the browser's native context menu (not intercepted)

---

## Reverse Proxy

Sidecar can act as a reverse proxy to route requests to upstream services based on `proxy.json` configuration.

### Configuration (`proxy.json`)

```json
{
  "routes": [
    { "path": "/", "upstream": "http://localhost:8080" },
    { "path": "/api/v2", "upstream": "http://localhost:3001" },
    { "path": "/db", "upstream": "http://localhost:5432" }
  ]
}
```

### Route Matching

- **Longest prefix wins**: `/api/v2/users` matches `/api/v2` over `/`
- **Route path normalization (v0.1.4b)**: Trailing slashes are stripped at config load time (`/icon/` → `/icon`)
- **Root route `/`**: Catches all unmatched paths (if configured)
- **No match + no root**: Returns 404 (except `/` which redirects to `/admin/`)

### Prefix Stripping (v0.1.4b)

The matched route prefix is stripped from the request path before forwarding to upstream, similar to nginx `proxy_pass` with a trailing slash:

| Route Path | Request | Upstream Receives |
|-----------|---------|-------------------|
| `/icon` | `/icon` | `/` |
| `/icon` | `/icon/logo.png` | `/logo.png` |
| `/icon` | `/icon?q=1` | `/?q=1` |
| `/icon` | `/icon/sub?q=1` | `/sub?q=1` |
| `/` | `/anything` | `/anything` (passthrough) |

### Proxy Behavior

| Feature | Behavior |
|---------|----------|
| HTTP Methods | All methods forwarded (GET, POST, PUT, DELETE, etc.) |
| Headers | All headers forwarded except hop-by-hop; multi-value headers (e.g., `Set-Cookie`) preserved via `append` |
| Authorization | Forwarded to upstream (upstream handles its own auth) |
| Request Body | Streamed to upstream |
| Response | Streamed back to client |
| Timeout | 30 seconds (returns 504 Gateway Timeout) |
| Connection Failure | Returns 502 Bad Gateway |
| Set-Cookie Path | `Path=` attribute prepended with route prefix (v0.1.5) |

### WebSocket Proxying (v0.1.6b)

WebSocket connections are automatically proxied to upstream as a raw TCP tunnel (`hyper::upgrade` + `tokio::io::copy_bidirectional`):

```javascript
// Connects to ws://localhost:8080/ws/chat via Sidecar
const ws = new WebSocket("ws://localhost:3000/ws/chat");
```

- Raw bidirectional byte piping (no framing overhead)
- Close propagation in both directions (client ↔ upstream)
- Supports `wss://` upstream via `tokio-rustls` + `webpki-roots`
- Returns 502 if upstream WebSocket unavailable

---

## Static File Serving (Admin Panel)

Sidecar serves static files from the configured panel directory at `/admin`.

### Static File Behavior (v0.1.2)

Static files are served directly. Missing files return 404 (no SPA fallback).

| Request | Response |
|---------|----------|
| `/admin` | 301 Redirect → `/admin/` |
| `/admin/` | `panel/index.html` |
| `/admin/style.css` | `panel/style.css` |
| `/admin/nonexistent` | 404 Not Found |
| `/admin/login.html` | `panel/login.html` |

### Security

- Directory traversal protection (handled by `tower-http`)
- Requests like `/admin/../etc/passwd` return 400/404

---

## Error Responses

All errors return JSON with consistent format:

```json
{
  "error": true,
  "status": 404,
  "message": "Path not found: /nonexistent/path"
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 400  | Bad Request - Missing or invalid parameters, invalid API path |
| 401  | Unauthorized - Invalid or missing token |
| 403  | Forbidden - Permission denied (OS level) |
| 404  | Not Found - File or path doesn't exist |
| 413  | Payload Too Large - Content-Length exceeds 1 GB limit |
| 500  | Internal Server Error - Unexpected failure |
| 502  | Bad Gateway - Upstream connection failed |
| 504  | Gateway Timeout - Upstream response timeout |

---

## Security Considerations

1. **Change the default secret** - Never use the default `SIDECAR_SECRET` in production
2. **Use HTTPS** - Put behind a reverse proxy (nginx, Caddy) with TLS — required for `Secure` cookie flag
3. **Bind to localhost** - Set `SIDECAR_HOST=127.0.0.1` if only accessed locally
4. **Runs as current user** - No sudo escalation; respects OS file permissions
5. **Upstream auth isolation** - Sidecar's JWT uses `SIDECAR_SECRET`; upstream apps have their own auth
6. **Cookie security** - `HttpOnly` (no JS access), `Secure` (HTTPS only, via `X-Forwarded-Proto`), `SameSite=None` (cross-origin), `Path=/admin/api` (API-scoped, not leaked to proxy routes)
7. **No tokens in URLs** - `?token=` query param removed; eliminates token leakage via server logs, Referer headers, and browser history

---

## Integration Examples

### Python (requests)
```python
import requests

BASE_URL = "http://localhost:3000"

# Login
resp = requests.post(f"{BASE_URL}/admin/api/auth/login", json={"secret": "your_secret"})
token = resp.json()["token"]

headers = {"Authorization": f"Bearer {token}"}

# Check auth status
status = requests.get(f"{BASE_URL}/admin/api/auth/status", headers=headers)
print(status.json())  # {"valid": true, "exp": 1738540800}

# List directory
files = requests.get(f"{BASE_URL}/admin/api/fs/list", params={"path": "/home/user"}, headers=headers)
print(files.json())

# Upload file
with open("document.pdf", "rb") as f:
    requests.post(f"{BASE_URL}/admin/api/fs/upload", params={"path": "/uploads"}, files={"file": f}, headers=headers)
```

### Node.js (fetch)
```javascript
const BASE_URL = "http://localhost:3000";

// Login
const loginResp = await fetch(`${BASE_URL}/admin/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ secret: "your_secret" })
});
const { token } = await loginResp.json();

// Check auth status
const statusResp = await fetch(`${BASE_URL}/admin/api/auth/status`, {
  headers: { Authorization: `Bearer ${token}` }
});
console.log(await statusResp.json()); // {valid: true, exp: 1738540800}

// List directory
const listResp = await fetch(`${BASE_URL}/admin/api/fs/list?path=/home/user`, {
  headers: { Authorization: `Bearer ${token}` }
});
const files = await listResp.json();
console.log(files);
```

### cURL
```bash
# Login
TOKEN=$(curl -s -X POST http://localhost:3000/admin/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"secret":"your_secret"}' | jq -r '.token')

# Check auth status
curl -s "http://localhost:3000/admin/api/auth/status" \
  -H "Authorization: Bearer $TOKEN" | jq

# List directory
curl -s "http://localhost:3000/admin/api/fs/list?path=/home/user" \
  -H "Authorization: Bearer $TOKEN" | jq

# Download file
curl -O -J "http://localhost:3000/admin/api/fs/download?path=/home/user/file.txt" \
  -H "Authorization: Bearer $TOKEN"

# Upload file
curl -X POST "http://localhost:3000/admin/api/fs/upload?path=/uploads" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@localfile.txt"
```

---

## Running as a Service (systemd)

Create `/etc/systemd/system/sidecar.service`:

```ini
[Unit]
Description=Sidecar File System API
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/sidecar
ExecStart=/path/to/sidecar/sidecar
Restart=on-failure
Environment=SIDECAR_PORT=3000
Environment=SIDECAR_HOST=127.0.0.1
Environment=SIDECAR_SECRET=your_production_secret
Environment=SIDECAR_PANEL_DIR=/path/to/panel
Environment=SIDECAR_PROXY_CONFIG=/path/to/proxy.json

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable sidecar
sudo systemctl start sidecar
```

---

## Migration from v0.1.0

If upgrading from v0.1.0, update your API calls:

| Old Path (v0.1.0) | New Path (v0.1.1) |
|-------------------|-------------------|
| `/api/auth/login` | `/admin/api/auth/login` |
| `/api/fs/list` | `/admin/api/fs/list` |
| `/api/fs/download` | `/admin/api/fs/download` |
| `/api/fs/upload` | `/admin/api/fs/upload` |
| `/api/fs/mkdir` | `/admin/api/fs/mkdir` |
| `/api/fs/rename` | `/admin/api/fs/rename` |
| `/api/fs/copy` | `/admin/api/fs/copy` |
| `/api/fs/remove` | `/admin/api/fs/remove` |
| `/api/ws/terminal` | `/admin/api/ws/terminal` |

**New endpoints in v0.1.1:**
- `GET /admin/api/auth/status` - Check JWT validity

**New endpoints in v0.1.2:**
- `GET /admin/api/fs/search` - Recursive file/directory search by glob pattern

**New endpoints in v0.1.3:**
- `GET /admin/api/fs/read` - Stream file content inline (no download header)
- `PUT /admin/api/fs/write` - Write raw request body to a file

**New endpoints in v0.1.4a:**
- `POST /admin/api/auth/logout` - Clear auth cookie

**New features in v0.1.7:**
- Terminal copy/paste hotkeys: `Ctrl+Shift+C` (copy), `Ctrl+V` / `Ctrl+Shift+V` (paste)
- Client-side file browser filter (debounced, no API call)
- API file search via Enter key in search input (`GET /admin/api/fs/search`)
- Media viewer zoom (scroll/double-click) and swipe gesture navigation
- Settings modal rewritten as machines-only manager
- `admin_cfg.json` loaded/saved via existing `/fs/read` and `/fs/write` endpoints

**Behavior changes in v0.1.6c:**
- WebSocket terminal auth now supports `Sec-WebSocket-Protocol: auth-token.<jwt>` as primary method
- Auth resolution order updated: `Authorization` header → `Sec-WebSocket-Protocol` → `Cookie` → 401

**Behavior changes in v0.1.6b:**
- WebSocket proxy rewritten as raw TCP tunnel (`hyper::upgrade` + `tokio::io::copy_bidirectional`)
- Proxy now supports `wss://` upstream TLS via `tokio-rustls` + `webpki-roots`

**Behavior changes in v0.1.6a:**
- Cookie `Secure`/`SameSite` detection changed from `Origin` header scheme to `X-Forwarded-Proto`/`X-Forwarded-Ssl` headers
- Fixes cross-origin auth for remote machines accessed through HTTP proxies

**New endpoints in v0.1.4c:**
- `GET /admin/api/fs/thumbnail` — Generate/cache 256×256 PNG thumbnail for images and videos

**Behavior changes in v0.1.4c:**
- Reverse proxy now supports `https://` upstream targets
- Proxy rewrites upstream `Location` headers to prepend the route prefix
- `?cache=0` on `/fs/read` and `/fs/thumbnail` returns `no-cache, no-store, must-revalidate`
- Upload size limit configurable via `SIDECAR_UPLOAD_LIMIT` env var (default 1024 MB)

**Behavior changes in v0.1.5:**
- Set-Cookie `Path=` attribute from upstream is now prepended with the route prefix
- Multi-value response headers (e.g. `Set-Cookie`) preserved via append instead of overwrite

**Behavior changes in v0.1.4b:**
- Matched route prefix stripped before forwarding to upstream
- ZIP downloads streamed via `async_zip` (constant memory)
- Early 413 rejection before reading body if `Content-Length` exceeds limit
- Upload and write stream directly to disk (constant memory)

**Behavior changes in v0.1.4a:**
- **BREAKING**: `?token=` query parameter auth removed from all endpoints (including WebSocket terminal)
- Login now sets an `HttpOnly` auth cookie alongside the JSON response
- Auth resolution: `Authorization` header → `Cookie: token=` → 401
- CORS: dynamic origin echo with `Access-Control-Allow-Credentials: true` and `Vary: Origin`
- `GET /admin/api/fs/read` accepts optional `?cache=<seconds>` for `Cache-Control` headers

**Behavior changes in v0.1.3:**
- CORS now uses explicit allowed headers instead of wildcard `Any`
- Upload/write body limit raised from 2 MB to 1 GB
- Upload auto-creates target directory if missing

**Behavior changes in v0.1.2:**
- Upload now preserves subdirectory paths in filenames (previously flattened)
- `/admin/unknown` returns 404 instead of `index.html` (SPA fallback removed)
- Unmatched proxy paths return 404 instead of redirecting to `/admin/`
- `/admin` (no trailing slash) now 301-redirects to `/admin/`

````
