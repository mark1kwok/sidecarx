#!/usr/bin/env bash
set -euo pipefail

# SidecarX — One-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/pgmi-builds/sidecarx/main/install.sh | bash

REPO="pgmi-builds/sidecarx"
DEFAULT_VERSION="latest"
INSTALL_DIR="${SIDECAR_INSTALL_DIR:-$HOME/.sidecar}"
BINARY="sidecar"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[SidecarX]${NC} $1"; }
warn()  { echo -e "${RED}[SidecarX]${NC} $1"; }
header(){ echo -e "${BLUE}=== $1 ===${NC}"; }

header "SidecarX Installer"

# --- Platform Detection ---
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
    Linux)  PLATFORM="linux" ;;
    Darwin) PLATFORM="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
    *)
        warn "Unsupported OS: $OS"
        exit 1
        ;;
esac

case "$ARCH" in
    x86_64|amd64) TARGET_ARCH="x86_64" ;;
    aarch64|arm64) TARGET_ARCH="aarch64" ;;
    *)
        warn "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# --- Target Triple ---
# Only these three targets have prebuilt binaries (see README → Releases).
case "${PLATFORM}-${TARGET_ARCH}" in
    linux-x86_64)   TARGET="x86_64-unknown-linux-musl" ;;
    linux-aarch64)  TARGET="aarch64-unknown-linux-musl" ;;
    darwin-aarch64) TARGET="aarch64-apple-darwin" ;;
    *)
        warn "No prebuilt binary for ${PLATFORM}-${TARGET_ARCH} (supported: Linux x86_64/ARM64, macOS Apple Silicon)"
        exit 1
        ;;
esac

info "Detected: $OS $ARCH → $TARGET"

# --- Version ---
VERSION="${SIDECAR_VERSION:-$DEFAULT_VERSION}"

if [ "$VERSION" = "latest" ]; then
    DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/sidecar-${TARGET}"
else
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/sidecar-${TARGET}"
fi

# --- Install ---
info "Installing to: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

info "Downloading Sidecar..."
if command -v curl &>/dev/null; then
    curl -fsSL "$DOWNLOAD_URL" -o "${INSTALL_DIR}/${BINARY}"
elif command -v wget &>/dev/null; then
    wget -q "$DOWNLOAD_URL" -O "${INSTALL_DIR}/${BINARY}"
else
    warn "Need curl or wget to download"
    exit 1
fi

chmod +x "${INSTALL_DIR}/${BINARY}"

# --- Download Admin Panel ---
info "Downloading admin panel..."
ADMIN_ZIP_URL="https://github.com/${REPO}/releases/latest/download/admin.zip"
if command -v curl &>/dev/null; then
    curl -fsSL -H "Accept: application/octet-stream" "$ADMIN_ZIP_URL" -o "${INSTALL_DIR}/admin.zip" 2>/dev/null || true
elif command -v wget &>/dev/null; then
    wget -q --header="Accept: application/octet-stream" "$ADMIN_ZIP_URL" -O "${INSTALL_DIR}/admin.zip" 2>/dev/null || true
fi

if [ -f "${INSTALL_DIR}/admin.zip" ] && [ -s "${INSTALL_DIR}/admin.zip" ]; then
    if command -v unzip &>/dev/null; then
        unzip -o -q "${INSTALL_DIR}/admin.zip" -d "${INSTALL_DIR}/"
        rm -f "${INSTALL_DIR}/admin.zip"
    else
        info "unzip not found — admin panel left as admin.zip"
    fi
fi

# --- Shell PATH ---
add_to_path() {
    local rc_file="$1"
    local marker="# Sidecar PATH"
    if [ -f "$rc_file" ] && ! grep -qF "$marker" "$rc_file" 2>/dev/null; then
        echo "" >> "$rc_file"
        echo "$marker" >> "$rc_file"
        echo "export PATH=\"\$PATH:$INSTALL_DIR\"" >> "$rc_file"
        info "Added to $rc_file (restart shell or run: source $rc_file)"
    fi
}

if [ "$PLATFORM" != "windows" ]; then
    add_to_path "$HOME/.bashrc"
    add_to_path "$HOME/.zshrc"
fi

# --- Quick Start ---
echo ""
header "SidecarX Installed!"
echo ""
echo "  Binary:  ${INSTALL_DIR}/${BINARY}"
echo "  Admin:   ${INSTALL_DIR}/admin/"
echo ""
echo "  Quick start:"
echo ""
echo "    # Set a secret and run"
echo "    export SIDECAR_SECRET=my_secret_key"
echo "    export SIDECAR_PANEL_DIR=${INSTALL_DIR}/admin"
echo "    ${INSTALL_DIR}/${BINARY}"
echo ""
echo "  Then open: http://localhost:3000"
echo ""
echo "  Login with your SIDECAR_SECRET value."
echo ""
echo "  To connect multiple machines:"
echo "    Install Sidecar on each machine, then add them"
echo "    in Settings → Machines of the admin panel."
echo ""
