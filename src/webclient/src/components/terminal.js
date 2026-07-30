/**
 * Terminal Component
 * Lazy-loaded Xterm.js integration with WebSocket PTY connection.
 *
 * Phase 3 (D2.1): each terminal tab owns its own Xterm + WebSocket, bound to
 * that tab's machineId (NOT the active machine) so terminals on different
 * machines coexist. #8: the ResizeObserver is stored on the instance and
 * disconnected on destroy, and an auth-fail path disposes the xterm and returns
 * null without polluting the `terminals` Map with a null key.
 */

import { getToken } from '../utils/storage.js';
import { getMachineClient } from '../api/machine-client.js';
import { debug } from '../utils/debug.js';

// Active terminal instances (keyed by terminalId, which lives on the tab)
const terminals = new Map();
let xtermLoaded = false;
let Terminal = null;
let FitAddon = null;

// Monotonic id counter - guarantees unique ids even when two terminals are
// created within the same millisecond.
let _termSeq = 0;
function makeTerminalId(ptyNo) {
    _termSeq += 1;
    return `terminal-${ptyNo != null ? ptyNo : _termSeq}-${Date.now()}-${_termSeq}`;
}

/**
 * Load Xterm.js (one-time initialization)
 */
async function loadXterm() {
    if (xtermLoaded) return;

    try {
        // Dynamically import Xterm.js modules (resolved via import map in index.html)
        const [xtermModule, fitAddonModule] = await Promise.all([
            import('xterm'),
            import('@xterm/addon-fit')
        ]);

        Terminal = xtermModule.Terminal;
        FitAddon = fitAddonModule.FitAddon;
        xtermLoaded = true;
        debug.log('✅ Xterm.js loaded');
    } catch (err) {
        debug.error('❌ Failed to load Xterm:', err);
        throw err;
    }
}

/**
 * Create and mount a terminal instance bound to a specific machine.
 * @param {string} containerId - DOM element ID to mount terminal
 * @param {{machineId?: string, ptyNo?: number}} [opts] - Tab machine identity + pty number
 * @returns {Promise<string|null>} Terminal session ID, or null on auth failure.
 */
export async function createTerminal(containerId, { machineId = 'self', ptyNo } = {}) {
    const container = document.getElementById(containerId);
    if (!container) {
        debug.error('Terminal container not found:', containerId);
        return null;
    }

    // Load Xterm.js if not already loaded
    try {
        await loadXterm();
    } catch (error) {
        debug.error('Failed to load Xterm.js:', error);
        return null;
    }

    // Per-tab machine identity (D2.1): resolve the client + token from the
    // tab's machineId, not the active machine, so a terminal opened on machine
    // A keeps talking to A after the active machine changes.
    const client = getMachineClient(machineId);
    const token = getToken(machineId);

    // Create Xterm instance
    const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: '"Cascadia Code", Consolas, monospace',
        theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#ffffff',
            selection: '#264f78',
        },
        rows: 24,
        cols: 80,
    });

    // Add fit addon
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Mount to DOM
    term.open(container);
    fitAddon.fit();

    // #8: auth-fail path. Not authenticated -> dispose the xterm we just created
    // and return null WITHOUT writing into the terminals Map (no null-key
    // pollution, no leaked xterm/observer). The caller leaves the tab with no
    // terminalId and the user sees the inline "Not authenticated" message.
    if (!token) {
        term.writeln('\x1b[1;31mError: Not authenticated\x1b[0m');
        term.dispose();
        return null;
    }

    const ws = connectWebSocket(term, client, token);
    if (!ws) {
        // connectWebSocket refused to connect (e.g. malformed URL) - same leak
        // hygiene as the auth-fail path: dispose, do not register.
        term.dispose();
        return null;
    }

    // --- Clipboard hotkeys (Ctrl+V / Ctrl+Shift+V paste, Ctrl+Shift+C copy) ---
    term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;

        // Ctrl+V or Ctrl+Shift+V -> paste from clipboard
        if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
            if (navigator.clipboard) {
                navigator.clipboard.readText().then(text => {
                    if (text && ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(text);
                    }
                }).catch(err => {
                    console.warn('Clipboard read denied:', err);
                });
            } else {
                console.warn('Clipboard API not available (non-secure context?)');
            }
            return false;
        }

        // Ctrl+Shift+C -> copy selection (Ctrl+C without Shift falls through to SIGINT)
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
            const selection = term.getSelection();
            if (!selection) return true; // No selection - pass through
            if (navigator.clipboard) {
                navigator.clipboard.writeText(selection).catch(err => {
                    console.warn('Clipboard write denied:', err);
                });
            } else {
                console.warn('Clipboard API not available (non-secure context?)');
            }
            return false;
        }

        return true; // All other keys pass through
    });

    const sessionId = makeTerminalId(ptyNo);

    // #8: store the ResizeObserver on the instance so destroyTerminal can
    // disconnect it (otherwise every opened terminal leaks one observer).
    const resizeObserver = new ResizeObserver(() => {
        if (container.offsetParent !== null) { // Only if visible
            fitAddon.fit();
        }
    });
    resizeObserver.observe(container);

    terminals.set(sessionId, {
        term,
        fitAddon,
        container,
        sessionId,
        ws,
        resizeObserver,
    });

    term.focus(); // Ensure focus

    debug.log('✅ Terminal created:', sessionId);
    return sessionId;
}

/**
 * Connect a WebSocket PTY for a terminal bound to `client`.
 * @param {Terminal} term - Xterm instance
 * @param {{baseUrl: string, name: string, isSelf: boolean}} client - MachineClient
 * @param {string} token - JWT for the Sec-WebSocket-Protocol auth header
 * @returns {WebSocket}
 */
function connectWebSocket(term, client, token) {
    const baseURL = client.baseUrl;
    const machineName = client.name || 'Unknown';
    // Display URL: Self's baseURL is already origin+BASE_PATH; remotes carry
    // their own full URL. Either way, baseURL is the complete display string.
    const machineUrl = baseURL || window.location.origin;

    let wsUrl;
    if (baseURL && /^https?:\/\//i.test(baseURL)) {
        // Remote machine or proxied machine with full URL (e.g. "https://railway.app/gcp")
        const url = new URL(baseURL);
        const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const pathPrefix = url.pathname.replace(/\/+$/, ''); // e.g. "/gcp" or ""
        wsUrl = `${wsProtocol}//${url.host}${pathPrefix}/api/ws/terminal?cols=${term.cols}&rows=${term.rows}`;
    } else {
        // Self machine - baseURL is a path prefix (e.g. "/car" or "")
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${wsProtocol}//${window.location.host}${baseURL}/api/ws/terminal?cols=${term.cols}&rows=${term.rows}`;
    }

    debug.log('Connecting to:', wsUrl);

    // Pass JWT via Sec-WebSocket-Protocol header for reliable auth on all browsers
    // (iOS Safari ITP can suppress cookies on WebSocket upgrade requests).
    // The server echoes back the subprotocol in the 101 response per RFC 6455.
    const ws = new WebSocket(wsUrl, [`auth-token.${token}`]);
    ws.binaryType = 'arraybuffer'; // Ensure we get ArrayBuffers, not Blobs

    ws.onopen = () => {
        debug.log('✅ WebSocket connected');
        term.writeln(`\x1b[1;32mConnected to ${machineName} (${machineUrl})\x1b[0m`);

        // Send input to backend
        term.onData(data => {
            debug.log('Term input:', JSON.stringify(data)); // Debug input
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            } else {
                console.warn('WS not open, cannot send');
            }
        });

        // Send resize to backend
        term.onResize(({ cols, rows }) => {
            debug.log('PTY resize request:', cols, rows);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
        });
    };

    ws.onmessage = (event) => {
        // Write output from backend
        const data = event.data;
        if (typeof data === 'string') {
            term.write(data);
        } else if (data instanceof ArrayBuffer) {
            term.write(new Uint8Array(data));
        } else {
            console.warn('Unknown terminal data type:', typeof data);
        }
    };

    ws.onerror = (error) => {
        debug.error('WebSocket error:', error);
        term.writeln('\x1b[1;31mConnection error\x1b[0m');
    };

    ws.onclose = () => {
        debug.log('WebSocket closed');
        term.writeln('\x1b[1;33m\nConnection closed\x1b[0m');
    };

    return ws;
}

/**
 * Destroy a terminal instance. #8: disconnect the ResizeObserver and close the
 * WebSocket so neither outlives the tab.
 * @param {string} sessionId - Terminal session ID
 */
export function destroyTerminal(sessionId) {
    const instance = terminals.get(sessionId);
    if (!instance) return;

    // #8: disconnect the ResizeObserver so it doesn't leak.
    if (instance.resizeObserver) {
        instance.resizeObserver.disconnect();
    }

    // Close WebSocket
    if (instance.ws) {
        instance.ws.close();
    }

    // Dispose Xterm
    instance.term.dispose();

    // Remove from map
    terminals.delete(sessionId);

    debug.log('🗑️ Terminal destroyed:', sessionId);
}

/**
 * Resize terminal to fit container
 * @param {string} sessionId - Terminal session ID
 */
export function resizeTerminal(sessionId) {
    const instance = terminals.get(sessionId);
    if (!instance) return;

    instance.fitAddon.fit();
}

/**
 * Get active terminal instance
 * @param {string} sessionId - Terminal session ID
 * @returns {object|null} Terminal instance
 */
export function getTerminal(sessionId) {
    return terminals.get(sessionId) || null;
}
