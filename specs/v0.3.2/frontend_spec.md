# Design and Specifications: Web Admin Panel Frontend

**Version:** 0.3.2

## 1. Project Overview
A Single Page Application (SPA) admin panel serving as a File Browser, Terminal, and Code Editor. It is a pure static frontend (source in `src/webclient/`) that connects to the Rust-based HTTP API sidecar backend which provides filesystem, terminal, and auth capabilities.

## 2. Architecture & Tech Stack
*   **Core**: HTML5, Lit Components (Light DOM) + Vanilla JS.
*   **Styling**: Custom CSS with CSS Variables (single `style.css`).
*   **Icons**: Google Material Symbols Rounded.
*   **Build**: Application code is bundled via `esbuild`. Assets like Monaco and Xterm.js are loaded via CDN.

## 3. Core Design Principles
| Principle | Specification | Reason |
|-----------|---------------|--------|
| **Inline Login Overlay** | Authentication happens inside `index.html` via a full-screen `login-overlay`. | Keeps UX in one SPA surface. |
| **No Routing** | No hash-based or history routing. | Simplifies state management. |
| **Config Storage** | `./admin_cfg.json` loaded/saved via backend API. Stores machine definitions. | Protects config behind auth. |
| **Token Storage** | `localStorage` stores JWT per machine: `auth_token_<name>`. | Independent sessions per machine. |
| **Cookie Auth** | Hybrid usage. Media/Thumbnails rely on `HttpOnly` cookies. | Browser-native resource loading. |
| **Fetch URL Auth (Remote WebKit)** | `fetchToken` (single `signature.key`) is stored per machine and appended as `?token=` only for remote WebKit media URLs. | Avoids cross-site cookie breakage on Safari while keeping URL auth narrow. |

## 4. UI/UX Features (v0.1.7)

### 4.1 Search (Hybrid)
*   **Client-side Filter**: Typing in the search field filters the currently visible directory listing (debounced 150ms).
*   **Backend API Search**: Pressing `Enter` triggers a recursive glob search via `GET /api/fs/search` (query wrapped as `*query*`).
*   **UX**: API search forces list view. Clear (×) or `Esc` restores previous view and path.

### 4.2 Media Viewer Interactions
*   **Overlay**: Full-screen backdrop for images, video, and audio.
*   **Zoom**: Scroll to zoom (0.25x - 10x); double-click to toggle 1x/2x.
*   **Mobile**: Horizontal swipe for navigation; vertical swipe to close.
*   **Backdrop**: Click outside media element to close.
*   **Event Guard**: `e.stopPropagation()` on key events ensures no background file navigation.

### 4.3 Terminal Hotkeys
*   **Copy/Paste**: Handled via `term.attachCustomKeyEventHandler()`.
*   **Paste**: `Ctrl+V` and `Ctrl+Shift+V` read from `navigator.clipboard.readText()`.
*   **Copy**: `Ctrl+Shift+C` writes `term.getSelection()` to `navigator.clipboard.writeText()`.
*   **SIGINT**: `Ctrl+C` (no shift) is **not** intercepted; sent verbatim to PTY.

### 4.4 Settings Modal (Machines Management)
*   **Scope**: Unified "Machines" section only (replaces legacy Theme/Favorites/Icons settings).
*   **Persistence**: Edits are gathered and saved to `admin_cfg.json` via backend.
*   **UI**: Readonly rows toggle to editable on click/focus.

## 5. Component Specifications

### 5.1 Global Layout
*   Sidebar (collapsible), Header, and Main Content area.
*   **Login Overlay**: mandatory on startup; dismissible on machine switch if not already authed.

### 5.2 Header
*   Sidebar toggle, Search field, Machine Status, and Theme toggle.

### 5.3 Sidebar
*   **Machine Menu**: Switch between Self and remote instances. Hard reset of tabs on switch.
*   **Favorites**: Per-machine pinned locations (migration handled for legacy flat arrays).
*   **Folder Tree**: Click chevron to expand (lazy load); click row to navigate.

### 5.4 File Browser
*   **View Modes**: List, Grid, Thumb. Icons update based on mode.
*   **Thumbnails**: Lazy-loaded `<img>` with Material Icon fallback on error.
*   **Operations**: Drag-and-drop move; external drop upload (path-preserving).
*   **Shortcuts**: Arrows (Nav), Enter (Open), Delete, F2 (Rename), Backspace (Up Level).

### 5.5 File Upload Logic
*   **Path-Preserving**: Recursively traverses dropped folders.
*   **Relative Paths**: Collects relative paths (e.g., `folder/file.txt`) and sends them in a single multipart request.
*   **API Usage**: Calls `POST /api/fs/upload?path=...` with 3-arg `FormData.append`.

### 5.6 Tool Management (Tabs)
*   **Terminal**: Singleton per machine. Subprotocol auth via `auth-token.<jwt>`.
*   **Editor**: Multi-instance Monaco. Dirty-state tracking. Warns before close if unsaved.

### 5.7 Authentication Handling (Frontend Side)
*   **Login**: Sends password to `/api/auth/login`, stores JWT and optional `fetchToken` in `localStorage`, and handles `credentials: 'include'` for cookies.
*   **Resolution**: Always tries `Authorization: Bearer` header first, then relies on cookie for media/WS.
*   **Subprotocol**: WebSocket constructor uses `['auth-token.' + token]` as second argument.
*   **Media URL Fallback**: Appends `?token=<fetchToken>` only when machine is remote, browser is WebKit, and fetch token exists.
