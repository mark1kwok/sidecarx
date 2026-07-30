# Admin Panel - Quick Start

## 🚀 Start Development

### 1. Start Dev Server (Frontend)
```bash
cd src/webclient
npx serve . -p 8080
```

Opens at **http://localhost:8080**

### 2. Start Sidecar (Backend API)
```bash
# From project root
cargo build --release --manifest-path src/server/Cargo.toml
./target/release/sidecar
```

API runs at **http://localhost:3000**

### 3. First Time Setup
1. Open http://localhost:8080
2. Click **Settings** in sidebar
3. Update machine secret (default: empty)
4. Click **Save**
5. Reload page

---

## 📁 Project Structure

```
sidecar/
├── frontend/                   # Admin Panel SPA (served as /admin/)
│   ├── index.html              # Main page (no build needed)
│   ├── static/
│   │   ├── style.css           # All CSS (custom design system)
│   │   └── setting.css         # Settings modal CSS
│   ├── src/
│   │   ├── app.js              # Main entry point
│   │   ├── api/                # API client (auth, fs)
│   │   ├── components/         # Lit components
│   │   └── utils/              # Config, storage utilities
│   └── scripts/
│       └── build-js.js         # Production bundler (esbuild)
├── src/                        # Rust backend source
├── Cargo.toml
└── Dockerfile
```

---

## 📝 Current Status

✅ **Done**
- HTML/CSS structure
- Config management (localStorage)
- Auth/Session handling
- API client (file system operations)
- Dev server with CORS

🚧 **Next Steps**
- File browser Lit component
- Terminal integration (Xterm.js)
- Editor integration (Monaco)
- Settings modal functionality

---

## 📚 Documentation

- [../spec/frontend_spec.md](../spec/frontend_spec.md) - Frontend design specification
- [../spec/sidecar_api.md](../spec/sidecar_api.md) - Backend API docs
- [../spec/sidecar_backend_spec.md](../spec/sidecar_backend_spec.md) - Backend spec

---

## 🛠️ Tech Stack

- **Frontend**: HTML5, Custom CSS, Lit (Web Components)
- **Icons**: Google Material Symbols Rounded
- **Fonts**: Open Sans / Inter
- **Backend**: Rust sidecar (HTTP API)
- **Storage**: localStorage (config), sessionStorage (tokens)

---

## 💡 Key Features

- 🌓 Dark mode (light/dark/system)
- 📁 File browser (list/grid views)
- 💻 Terminal (Xterm.js, multiple sessions)
- ✏️ Code editor (Monaco)
- ⚙️ Multi-machine management
- 🔒 JWT authentication
- 📱 Responsive design

---

## 🐛 Troubleshooting

### CORS errors
- Ensure dev server is running with CORS enabled
- Check sidecar allows cross-origin requests

### Module import errors
- Make sure `<script type="module">` is present
- Check file paths include `.js` extension

### Config not saving
- Check browser localStorage is enabled
- Clear: `localStorage.clear()` in DevTools Console

---

## 📞 Support

For questions, check the implementation guide or review existing documentation files.
