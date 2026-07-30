# SidecarX

> **X** stands for Cross — cross-machine file operations.

A lightweight, high-performance Rust server for multi-machine file management. Connect to any number of remote machines from a single browser tab — copy, paste, move files across machines with drag-and-drop.

[![Rust](https://img.shields.io/badge/Rust-2021-orange)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue)]()

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/mark1kwok/sidecarX/main/install.sh | bash
```

Or download the binary directly for your platform from [Releases](https://github.com/mark1kwok/sidecarX/releases).

| Platform | Binary |
|----------|--------|
| Linux (x86_64) | `sidecar-x86_64-unknown-linux-musl` |
| Linux (ARM64) | `sidecar-aarch64-unknown-linux-musl` |
| macOS (Apple Silicon) | `sidecar-aarch64-apple-darwin` |
| macOS (Intel) | `sidecar-x86_64-apple-darwin` |
| Windows (x86_64) | `sidecar-x86_64-pc-windows-msvc.exe` |

### One Binary

The backend is a single statically-linked binary (musl on Linux). No runtime, no database, no Docker required:

```bash
./sidecar
# Server starts at http://localhost:3000
```

The admin panel SPA loads a few well-known open-source libraries from CDN (Monaco Editor, xterm.js, Lit). See [Open Source Components](#open-source-components).

## Why SidecarX?

Traditional file browsers manage files on a single machine. SidecarX lets you manage **multiple machines from one interface**:

- **Cross-machine copy/paste** — Select files on machine A, paste to machine B. No SCP, no rsync, no terminal.
- **Cross-machine drag-and-drop** — Drag files from one server to another in the same browser window.
- **Unified workspace** — Open editors and terminals across different machines, all in one tab dock.
- **Multi-machine config** — Define all your servers in a single `admin_cfg.json`. Switch machines with one click.
- **Live Demo →** [demo.sidecarx.dev](https://demo.sidecarx.dev)

## Features

### File Management
- Browse, search, upload, download, rename, delete
- Drag-and-drop upload (files and folders)
- Grid and list views with sorting
- Thumbnail previews (images + video via ffmpeg)
- Batch download as ZIP
- Markdown and HTML file viewers

### Code Editor
- Monaco-powered editor with syntax highlighting
- View and Edit modes
- Full path display in editor header

### Terminal
- WebSocket PTY terminal (xterm.js)
- Resize-aware, multiple sessions
- Runs `$SHELL` or `/bin/bash`

### Multi-Machine (the "X" factor)
- Connect to any number of remote Sidecar instances
- Per-machine authentication and session management
- Cross-machine clipboard for copy/paste/move operations
- Transfer queue with progress tracking
- Works across HTTP and HTTPS origins

### Security
- JWT authentication (HS256)
- Cookie-based + Bearer token auth
- Root directory jailing (`SIDECAR_ROOT_DIR`)
- Path traversal protection
- Configurable upload size limits

## Configuration

Set via environment variables or `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `SIDECAR_PORT` | `3000` | Server port |
| `SIDECAR_HOST` | `0.0.0.0` | Bind address |
| `SIDECAR_SECRET` | — | JWT signing secret (**required in production**) |
| `SIDECAR_PANEL_DIR` | `./admin` | Admin panel static files directory |
| `SIDECAR_ROOT_DIR` | — | Jail directory for sandboxed file operations |
| `SIDECAR_UPLOAD_LIMIT` | `1024` | Upload size limit in MB |
| `SIDECAR_ENV_FILE` | `.env` | Path to env file |

## Build from Source

```bash
# Clone
git clone https://github.com/mark1kwok/sidecarX.git
cd sidecarX

# Build backend (Rust)
cargo build --release --manifest-path src/server/Cargo.toml

# Build frontend
cd src/webclient && npm install && node scripts/build-js.js

# Run
SIDECAR_SECRET=dev_secret SIDECAR_PANEL_DIR=./admin ./src/server/target/release/sidecar
```

### Cross-Compile

```bash
# Linux (static musl)
cargo build --release --target x86_64-unknown-linux-musl --manifest-path src/server/Cargo.toml

# macOS
cargo build --release --target aarch64-apple-darwin --manifest-path src/server/Cargo.toml

# Windows (requires cross-compilation toolchain)
cargo build --release --target x86_64-pc-windows-msvc --manifest-path src/server/Cargo.toml
```

## API Reference

### Authentication

```bash
# Login — returns JWT token (7d expiry)
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"secret":"your_secret"}' | jq -r '.token')

# Check token validity
curl -s http://localhost:3000/api/auth/status \
  -H "Authorization: Bearer $TOKEN"

# Logout
curl -s -X POST http://localhost:3000/api/auth/logout
```

### File System

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fs/list?path=` | GET | List directory contents |
| `/api/fs/read?path=` | GET | Read file inline |
| `/api/fs/write?path=` | PUT | Write raw body to file |
| `/api/fs/download?path=` | GET | Download file or directory (ZIP) |
| `/api/fs/download-batch` | POST | Batch download as ZIP |
| `/api/fs/upload?path=` | POST | Upload files (multipart) |
| `/api/fs/mkdir` | POST | Create directory (recursive) |
| `/api/fs/rename` | POST | Rename/move file or directory |
| `/api/fs/copy` | POST | Copy file or directory |
| `/api/fs/remove` | DELETE | Delete file or directory |
| `/api/fs/search?path=&pattern=` | GET | Search by glob pattern |
| `/api/fs/thumbnail?path=` | GET | Generate 256px PNG thumbnail |

### Terminal

```
ws://localhost:3000/api/ws/terminal?cols=80&rows=24
```

## Deployment

### Docker

```bash
docker build -t sidecar .
docker run -p 3000:3000 \
  -e SIDECAR_SECRET=your_production_secret \
  sidecar
```

### systemd

```ini
[Unit]
Description=Sidecar Server
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/sidecar
ExecStart=/opt/sidecar/sidecar
Restart=on-failure
Environment=SIDECAR_PORT=3000
Environment=SIDECAR_SECRET=your_production_secret

[Install]
WantedBy=multi-user.target
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Rust (2021 edition) |
| Web Framework | Axum 0.7 |
| Runtime | Tokio |
| Auth | `jsonwebtoken` (HS256) |
| Terminal | `portable-pty` |
| File Search | `walkdir` + `glob` |
| Static Files | `tower-http` (ServeDir) |
| Frontend | Vanilla JS SPA + Lit Web Components |
| Editor | Monaco Editor |
| Terminal (UI) | xterm.js |

## Optional Dependencies

- **ffmpeg** — Required for video thumbnail generation. Image thumbnails work without it.

```bash
# Debian/Ubuntu
apt-get update && apt-get install -y ffmpeg

# macOS
brew install ffmpeg
```

## Security

- **Change `SIDECAR_SECRET`** in production — never use the default
- **Use HTTPS** — deploy behind a TLS-terminating reverse proxy (nginx, Caddy)
- **Bind to localhost** (`SIDECAR_HOST=127.0.0.1`) if only accessed internally
- **No sudo escalation** — runs as the current OS user
- **Path-traversal protection** — rejects `..`, absolute paths, null bytes
- **Cookie security** — `HttpOnly`, `Path=/api`, conditional `Secure`/`SameSite`
- **Root jailing** — `SIDECAR_ROOT_DIR` sandboxes all file operations

## Open Source Components

The admin panel is built on these excellent projects:

| Library | License | Role |
|---------|---------|------|
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | MIT | Code editor |
| [xterm.js](https://github.com/xtermjs/xterm.js) | MIT | Terminal emulator |
| [Lit](https://github.com/lit/lit) | BSD-3-Clause | Web Components |
| [marked](https://github.com/markedjs/marked) | MIT | Markdown rendering |
| [Material Symbols](https://fonts.google.com/icons) | Apache 2.0 | Icons |
| [Roboto](https://fonts.google.com/specimen/Roboto) | OFL | Font |

Thank you to all maintainers.

## License

Apache 2.0 © 2026 SidecarX Contributors

## Links

- Website: [sidecarx.dev](https://sidecarx.dev)
- Live Demo: [demo.sidecarx.dev](https://demo.sidecarx.dev)
- GitHub: [github.com/mark1kwok/sidecarX](https://github.com/mark1kwok/sidecarX)
