# Sidecar - Project Plan and Specification

**Version:** 0.1.8

## Overview

Sidecar is a lightweight, high-performance Rust server designed to be deployed as a **container wrapper** for your main applications. It provides:

1. **Backend API** - Authenticated file system access and remote terminal
2. **Admin Panel SPA** - Static file serving with client-side routing support
3. **Reverse Proxy** - Route requests to upstream services (main app)

**Use Case:** Deploy Sidecar alongside containerized apps (AI chatbots, PDF utilities, web services) to provide a unified entry point with built-in admin capabilities.

## Version History

| Version | Description |
|---------|-------------|
| v0.1.0  | Backend API only (file system, terminal, auth) |
| v0.1.1  | + Admin Panel SPA serving, Reverse Proxy, WebSocket proxy |
| v0.1.2  | + File search endpoint, upload path preservation, routing bug fixes |
| v0.1.3  | + File read/write endpoints, CORS fix, upload body limit & auto-create dir |
| v0.1.4a | + Cookie auth (hybrid), logout endpoint, CORS credentials, cache headers, **BREAKING**: remove `?token=` query param auth |
| v0.1.4b | + Proxy prefix stripping, streaming ZIP downloads (`async_zip`), early 413 rejection, streaming upload/write to disk |
| v0.1.4c | + Media file thumbnail generation, HTTPS proxy (`hyper-rustls`), Location header rewriting, cache=0 support, configurable upload limit, optional `ffmpeg` |
| v0.1.5  | + Proxy cookie/header fixes: Set-Cookie Path rewriting, multi-value header preservation, Origin-scheme-based cookie attributes (replaces host comparison) |
| v0.1.6a | + Cookie policy: `X-Forwarded-Proto`/`X-Forwarded-Ssl` replaces Origin-scheme detection (fixes cross-origin remote machine auth); WS cookie forwarding attempt (broken — superseded by v0.1.6b) |
| v0.1.6b | + WebSocket proxy rewritten as raw TCP tunnel (`hyper::upgrade` + `tokio::io::copy_bidirectional`); `tokio-rustls` + `webpki-roots` for wss:// upstream TLS support |
| v0.1.6c | + WebSocket terminal auth via `Sec-WebSocket-Protocol` subprotocol header (fixes iOS Safari ITP cookie suppression); auth resolution: Bearer header → subprotocol → cookie → 401 |
| v0.1.7  | + Terminal copy/paste hotkeys, client-side & API file search, media viewer interactions (zoom/swipe), settings modal rewrite (machines-only), `admin_cfg.json` persistence |
| v0.1.8  | + Token-only media fetch auth (`fetchToken = signature.key`) for remote WebKit clients, URL fallback on `/fs/read` and `/fs/thumbnail`, MIME guard for URL-auth reads, HTTPS cookies include `Partitioned` |

---

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │              Sidecar Server              │
                    │                                         │
  Client Request ──►│  /admin/api/*  → Backend API            │
                    │  /admin/*      → Static SPA Files       │
                    │  /*            → Reverse Proxy ──────────┼──► Main App
                    │                   (proxy.json)          │    (upstream)
                    └─────────────────────────────────────────┘
```

### Route Priority

1. **`/admin/api/*`** - API endpoints (exclusive, no fallback)
2. **`/admin`** - 301 redirect to `/admin/`
3. **`/admin/*`** - Static files (404 for missing files, no SPA fallback)
4. **`/*`** - Proxy to upstream per `proxy.json` (404 if no route; `/` redirects to `/admin/`)

---

## Core Philosophy

- **Single Binary:** OS-Agnostic Compiled Rust executable (`x86_64-unknown-linux-musl`), no runtime dependencies
- **Stateless:** No database, purely functional (filesystem is the state)
- **Secure:** Single-user JWT authentication via environment secret
- **Minimal Footprint:** Runs as current OS user, no `sudo` escalation
- **Configuration-driven:** Proxy routes via JSON file

---

## Technology Stack

| Component | Technology |
|-----------|------------|
| Language | Rust (2021 edition) |
| Web Framework | Axum 0.7 (REST + WebSocket) |
| Runtime | Tokio |
| Authentication | `jsonwebtoken` (HS256) |
| Serialization | `serde_json` |
| Compression | `async_zip` (streaming, async) |
| Terminal | `portable-pty` |
| Static Files | `tower-http` (ServeDir) |
| Proxy | `hyper-util` + `hyper-rustls` (HTTP/HTTPS client) |
| WebSocket Proxy | `hyper::upgrade` + `tokio::io::copy_bidirectional` (raw TCP tunnel); `tokio-rustls` + `webpki-roots` |
| File Search | `walkdir` (traversal), `glob` (pattern matching) |
| Thumbnails | `image` (decode/resize), `png` (tEXt metadata), `md5` (cache key) |

---

## Configuration

### Environment Variables (`.env`)

```bash
# Server binding
SIDECAR_PORT=3000
SIDECAR_HOST=0.0.0.0

# Authentication (CHANGE IN PRODUCTION!)
SIDECAR_SECRET=change_me_to_something_secure

# Static file serving
SIDECAR_PANEL_DIR=./admin

# Proxy configuration
SIDECAR_PROXY_CONFIG=./proxy.json

# Single file upload size limit in MB (default: 1024)
SIDECAR_UPLOAD_LIMIT=1024
```

### Proxy Configuration (`proxy.json`)

It configures upstream endpoints the proxy connects to, or local directories to serve, or HTTP redirects. Note `/` path can be mapped, or will fall back to returning a default configuration if missing.

```json
{
  "routes": [
    { "path": "/admin", "serve_dir": "./admin" },
    { "path": "/", "redirect": "/admin" },
    { "path": "/api/v2", "upstream": "http://localhost:3001" }
  ]
}
```

**Route Matching:** Longest-prefix wins. `/api/v2/users` matches `/api/v2` over `/`.

---

## API Documentation

### 1. Authentication

The backend implements a hybrid authentication scheme supporting both headers and cookies.

**Resolution Order (v0.1.8):**
1. `Authorization: Bearer <token>` header
2. `Cookie: token=<token>` cookie
3. `Sec-WebSocket-Protocol: auth-token.<token>` (WebSocket only)
4. URL fallback `token=<fetchToken>` on `/admin/api/fs/read` and `/admin/api/fs/thumbnail`
5. If none → `401 Unauthorized`

#### Login
`POST /admin/api/auth/login`
**Request:** `{"secret": "..."}`
**Response:** `{"token": "...", "fetchToken": "<hmac-signature>.<base64-exp-jwt>"}`
**Headers:** Sets `Set-Cookie: token=...; HttpOnly; Path=/admin/api`.
- HTTPS origin (or `X-Forwarded-Proto: https`): `Secure; SameSite=None; Partitioned`
- HTTP origin: `SameSite=Lax`

#### Logout
`POST /admin/api/auth/logout`
**Response:** `{"success": true}` (Clears the auth cookie)

#### Status
`GET /admin/api/auth/status`
**Response:** `{"valid": true, "exp": 1738540800}`

---

### 2. File System API

#### List Directory
`GET /admin/api/fs/list?path=/absolute/path`
**Response:** Array of `FileEntry` `{name, is_dir, size, modified, perms}`. Directories first, then alphabetical.

#### Read File (Inline)
`GET /admin/api/fs/read?path=/absolute/path`
**Query Params:** `cache` (seconds, optional).
**Response:** Raw content streamed with detected MIME type. No `Content-Disposition`.
**Cache Control:** `?cache=3600` → `Cache-Control: private, max-age=3600, immutable`.

#### Write File
`PUT /admin/api/fs/write?path=/absolute/path`
**Behavior:** Raw body is streamed to disk. Auto-creates parent directories. Overwrites existing.
**Limit:** Early 413 rejection if exceeding `SIDECAR_UPLOAD_LIMIT`.

#### Upload Files
`POST /admin/api/fs/upload?path=/target/dir`
**Content-Type:** `multipart/form-data`.
**Behavior:** Multiple files supported. Preserves subdirectories in filenames (e.g., `docs/readme.md`). Target directory auto-created.

#### Search
`GET /admin/api/fs/search?path=/root&pattern=*.rs&max_depth=10`
**Behavior:** Recursive glob-based search. `max_depth` clamped at 50. Returns `{matches, total}`.

#### Thumbnail
`GET /admin/api/fs/thumbnail?path=/absolute/path`
**Response:** 256px PNG.
**Support:** Images (JPEG, PNG, WebP, etc.) and Videos (MP4, MKV via optional `ffmpeg`).
**Caching:** `$XDG_CACHE_HOME/thumbnails/large/` (mtime-validated).
**Small File Passthrough:** Images < 50 KB served directly.

#### ZIP Operations
- `GET /admin/api/fs/download?path=...`: Single file or full directory as ZIP.
- `POST /admin/api/fs/download-batch`: `["/path1", "/path2"]` as ZIP.
**Streaming:** Duplex buffer (128 MB) ensures O(1) memory usage regardless of ZIP size.

#### FS Mutations
- `POST /admin/api/fs/mkdir`: `{"path": "..."}` (recursive `mkdir -p`)
- `POST /admin/api/fs/rename`: `{"from": "...", "to": "..."}`
- `POST /admin/api/fs/copy`: `{"from": "...", "to": "..."}`
- `DELETE /admin/api/fs/remove`: `{"path": "..."}` (recursive delete)

---

### 3. System API

#### System Stats
`GET /admin/api/sys/stats`
**Response:** JSON payload with RAM metrics (total, used, available) and Disk space metrics (total, used, available) in bytes.
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

---

### 4. Terminal & Console

#### WebSocket Terminal
`GET /admin/api/ws/terminal?cols=80&rows=24`
**Behavior:** Spawns PTY running `$SHELL`.
**v0.1.7 Features:**
- **Auth:** Supports `Sec-WebSocket-Protocol` subprotocol for token passthrough.
- **PTY:** Bidirectional text communication (input) and binary output.

---

### 4. Reverse Proxy & Static Serving

#### Reverse Proxy
- **Longest prefix matching.**
- **Prefix stripping:** `/route/path` → `/path` before forwarding.
- **Header preservation:** Appends multi-value headers (like `Set-Cookie`).
- **Location/Cookie Path Rewriting:** Prepends route prefix to upstream redirect/cookie paths.
- **WebSocket Proxying:** Raw TCP tunnel (v0.1.6b) for maximum transparency and efficiency.

#### Static Serving
- Serves from `SIDECAR_PANEL_DIR` at `/admin`.
- `/admin` (no slash) redirects to `/admin/`.
- No SPA fallback (404 for missing assets).

---

## Security Considerations

1. **`SIDECAR_SECRET`**: Must be unique in production.
2. **HTTPS**: Mandatory for `Secure` cookie attributes.
3. **OS Permissions**: Sidecar respects the underlying OS user's access rights.
4. **Cookie Policies**: `HttpOnly`, API-scoped path, and dynamic `SameSite` based on transport.
5. **No Token in URL**: Prevents leakage via Referer/Logs.
6. **Path Traversal**: Sanitization on all FS endpoints (rejects `..`, absolute paths in filenames, etc.).

---

## Error Handling

Standardized JSON error format:
```json
{
  "error": true,
  "status": 404,
  "message": "File not found"
}
```

| Code | Meaning |
|------|---------|
| 400 | Bad Request (invalid params) |
| 401 | Unauthorized (JWT failed) |
| 403 | Forbidden (OS Permission Denied) |
| 404 | Not Found |
| 413 | Payload Too Large (>1 GB) |
| 502 | Bad Gateway (Proxy failure) |
| 504 | Gateway Timeout |

---

## Deployment & Service

### Systemd Service
```ini
[Service]
ExecStart=/path/to/sidecar
Environment=SIDECAR_PORT=3000
Environment=SIDECAR_SECRET=your_secret
# ... (other env vars)
```

### Docker
```dockerfile
FROM debian:bookworm-slim
COPY sidecar .
COPY admin/ ./admin/
CMD ["./sidecar"]
```
