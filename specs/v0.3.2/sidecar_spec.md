# Sidecar - Specification & API Documentation

**Version:** 0.3.2

## Overview

Sidecar is a lightweight, high-performance Rust server designed to be deployed as a standalone agent alongside your applications (e.g., containerized tools, chatbots, or admin interfaces). It provides secure, stateless, authenticated file management, remote terminal access, and system monitoring in a single static binary.

With **v0.3.0+**, Sidecar operates as a standalone agent with its reverse-proxy engine removed to achieve maximum minimalism and security. It serves its built-in admin Single Page Application (SPA) natively, sandboxes operations using optional root-jailing, and provides real-time system stats.

### Core Philosophy

- **Single Binary:** Fully self-contained compiled Rust executable, running without external runtime dependencies or database.
- **Stateless:** The underlying OS filesystem serves as the state. No database or disk overhead.
- **Secure by Default:** Single-user authentication using a master password (`SIDECAR_SECRET`) with hybrid JWT and cookie protection.
- **Minimal Footprint:** Runs as a standard OS user without `sudo` elevation.
- **Traverse- & Jail-Protected:** Full path-traversal prevention, strict byte/DoS limits, and optional jail-root restriction.

---

## Architecture & Routing

```
                    ┌─────────────────────────────────────────┐
                    │              Sidecar Server              │
                    │                                         │
                    │  /api/*        → Backend API            │
                    │  /*            → Static SPA Files       │
                    └─────────────────────────────────────────┘
```

The router normalizes paths and enforces strict route matching:

1. **`/api/*`** — API and control endpoints (exclusive, returns JSON error on miss).
2. **`/admin` / `/admin/`** — Permanent temporary redirect to the root `/` (for backward-compatible pathing).
3. **`/*`** — Static files fallback serving the Admin Panel SPA. Any unmatched path serves `index.html` at the root, supporting HTML5 client-side routing natively.

---

## Configuration Reference

Sidecar can be configured through local environment variables or a `.env` file placed in the working directory:

| Variable | Default | Description |
|----------|---------|-------------|
| `SIDECAR_PORT` | `3000` | Port the API listens on. |
| `SIDECAR_HOST` | `0.0.0.0` | Bind address (`127.0.0.1` limits access to local loopback). |
| `SIDECAR_SECRET` | `change_me_to_something_secure` | Master password used for login and JWT signing. (**Change this in production!**) |
| `SIDECAR_PANEL_DIR` | `./admin` | Path to the directory containing static admin panel SPA assets. |
| `SIDECAR_ROOT_DIR` | `None` | Jail directory. If set, restricts all filesystem operations strictly within this path. |
| `SIDECAR_UPLOAD_LIMIT` | `1024` | Single file upload and raw write size limit in Megabytes (MB). |

---

## Authentication & Security

Sidecar enforces a robust multi-layered authentication schema for all API endpoints (excluding `/api/auth/login` and `/api/auth/logout`).

### 1. Same-OS Loopback Auth Bypass (v0.3.0+)
If the incoming connection originates directly from a local loopback IP address (`127.0.0.1` or `::1`) **and** carries **no** proxy-forwarding headers (such as `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Ssl`, `Forwarded`, or `Via`), the backend automatically bypasses authentication. This assumes that a client already executing code on the same operating system has implicit full access to local resources.

### 2. Hybrid Auth Resolution Order (Remote Clients)
When loopback bypass is not active, the backend searches for a valid JWT token in this exact order:

1. **Header**: `Authorization: Bearer <token>`
2. **WebSocket**: `Sec-WebSocket-Protocol: auth-token.<token>` (WebSocket connections only)
3. **Cookie**: `Cookie: token=<token>`
4. **URL Fallback**: `token=<fetchToken>` (Restricted solely to `/api/fs/read` and `/api/fs/thumbnail`)
5. If none is valid → **`401 Unauthorized`**

---

## API Documentation

All API endpoints return JSON responses. Errors follow a standardized layout:
```json
{
  "error": true,
  "status": 401,
  "message": "Invalid credentials"
}
```

---

### 1. Authentication Endpoints

#### Login
- **Endpoint:** `POST /api/auth/login`
- **Request Body:**
  ```json
  {
    "secret": "your_configured_secret"
  }
  ```
- **Response Body:**
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "fetchToken": "<hmac-signature>.<base64-exp-jwt>"
  }
  ```
- **Cookies Set:** Sets `HttpOnly; Path=/api; Max-Age=604800` (7 days).
  - On HTTPS (or if `X-Forwarded-Proto: https` is set): `Secure; SameSite=None; Partitioned`
  - On HTTP: `SameSite=Lax`

#### Logout
- **Endpoint:** `POST /api/auth/logout`
- **Response Body:**
  ```json
  {
    "success": true
  }
  ```
- **Cookies Set:** Clears the cookie by setting `Max-Age=0` (`Path=/api`).

#### Status Check
- **Endpoint:** `GET /api/auth/status`
- **Response Body (authenticated):**
  ```json
  {
    "valid": true,
    "exp": 1738540800,
    "root_dir": null
  }
  ```

---

### 2. File System API

All file operations are validated against path-traversal attacks (e.g. `..`, null bytes, absolute paths in filenames) and jailed to `SIDECAR_ROOT_DIR` if configured.

#### List Directory
- **Endpoint:** `GET /api/fs/list?path=<absolute_path>`
- **Response Body:**
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
      "name": "project.zip",
      "is_dir": false,
      "size": 1450284,
      "modified": 1705247000,
      "perms": "rw-r--r--"
    }
  ]
  ```
- **Notes:** Directories are sorted first, followed by files alphabetically.

#### Read File (Inline)
- **Endpoint:** `GET /api/fs/read?path=<absolute_path>`
- **Query Params:** `cache` (optional cache duration in seconds. If `?cache=0` is passed, returns anti-cache headers: `no-cache, no-store, must-revalidate`).
- **Response:** Raw binary file content streamed with dynamically detected `Content-Type` MIME headers. No attachment trigger.
- **URL Auth Security:** If relying on the URL-embedded token fallback (`?token=<fetchToken>`), reads are restricted to media MIME types (`image/*`, `video/*`, `audio/*`, `application/pdf`).

#### Write File (Raw Body Streaming)
- **Endpoint:** `PUT /api/fs/write?path=<absolute_path>`
- **Behavior:** Accepts raw binary data in the request body and streams it directly to disk (using a memory footprint of $O(\text{chunk})$. Automatically creates parent directories if missing.
- **DoS Protection:** Rejects the connection instantly (with HTTP 413) if `Content-Length` exceeds the configured `SIDECAR_UPLOAD_LIMIT`.

#### Upload Files (Multipart)
- **Endpoint:** `POST /api/fs/upload?path=<destination_directory>`
- **Content-Type:** `multipart/form-data`
- **Behavior:** Accepts multiple files in a multipart body. Supports subdirectory preservation (e.g., uploading `logs/today.log` will build the path `/destination/logs/today.log`).
- **DoS Protection:** Enforces `SIDECAR_UPLOAD_LIMIT` check.

#### Search Files
- **Endpoint:** `GET /api/fs/search?path=<root_path>&pattern=<glob_pattern>`
- **Behavior:** Recursively traversals directories starting at `path` using `walkdir`, matching names against the glob `pattern`.
- **Response Body:**
  ```json
  {
    "matches": [
      {
        "name": "auth.rs",
        "path": "/workspace/src/auth.rs",
        "is_dir": false,
        "size": 29599,
        "modified": 1705247800,
        "perms": "rw-r--r--"
      }
    ],
    "total": 1
  }
  ```

#### Generate Thumbnail
- **Endpoint:** `GET /api/fs/thumbnail?path=<absolute_path>`
- **Response:** Returns a standard 256px PNG representation of an image or video file.
- **Cache Mechanics:** Validated under Freedesktop thumbnail standards (`~/.cache/thumbnails/x-large/`). Small images (<50 KB) bypass generation and are returned directly to optimize performance.
- **Security Guard (v0.3.2+):** Enforces thumbnail-loop protection to prevent generating thumbnails of thumbnails recursively. Includes standard URL percent-encoding on embedded tEXt metadata to prevent panics when handling non-ASCII/Unicode filepaths.
- **Dependencies:** Video thumbnail generation requires `ffmpeg` to be present on the host system PATH.

#### Streaming ZIP Downloads
- **Single File/Directory Download:** `GET /api/fs/download?path=<absolute_path>`
- **Batch Download:** `POST /api/fs/download-batch` with request body `["/path1", "/path2"]`
- **Behavior:** Compresses and streams files directly as a ZIP archive using a bounded 128 MB duplex buffer. Memory footprint is strictly $O(1)$ and does not scale with file or directory size.

#### Directory & File Mutations
- **Create Directory:** `POST /api/fs/mkdir` -> `{"path": "/absolute/path"}`
- **Rename / Move:** `POST /api/fs/rename` -> `{"from": "/old/path", "to": "/new/path"}`
- **Copy:** `POST /api/fs/copy` -> `{"from": "/src/path", "to": "/dest/path"}`
- **Delete:** `DELETE /api/fs/remove` -> `{"path": "/absolute/path"}` (recursive delete)

---

### 3. System Stats API

#### System Stats
- **Endpoint:** `GET /api/sys/stats`
- **Response Body:**
  ```json
  {
    "cpu_usage": 12.45,
    "ram_total": 17179869184,
    "ram_used": 8589934592,
    "ram_available": 8589934592,
    "disk_total": 250103451648,
    "disk_used": 120051625984,
    "disk_available": 130051825664
  }
  ```
- **Metrics Description:**
  - `cpu_usage`: Percentage representation of overall CPU utilization (from v0.3.1+).
  - `ram_*` and `disk_*`: Standard byte counts.

---

### 4. Terminal & Shell Connection

#### WebSocket PTY Terminal
- **Endpoint:** `GET /api/ws/terminal?cols=<columns>&rows=<rows>`
- **Protocol:** WebSocket Upgrade
- **Behavior:** Spawns a pseudoterminal (PTY) running the current user's default `$SHELL` (or `sh` fallback).
- **Control Frame Schema:** Spawns binary stream and handles real-time window resizing.
  - Send **text** frames to write keys and commands directly to the terminal PTY.
  - Send **binary** frames structured under a control schema to request window resizing:
    - Control frame structure: `[1, cols_lsb, cols_msb, rows_lsb, rows_msb]`
  - Receives output from terminal PTY streamed as standard UTF-8 text frames.
