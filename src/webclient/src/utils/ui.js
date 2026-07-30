/**
 * UI Utilities
 * Shared UI functions like toast notifications, confirm dialogs, and formatters
 */

let _dialogResolver = null;

// ---- Dialog Helpers ----

function _openMsgOverlay(htmlContent, focusSelector) {
    const overlay = document.getElementById('msg-overlay');
    if (!overlay) return null;

    const card = overlay.querySelector('.msg-card');
    if (!card) return null;

    card.innerHTML = htmlContent; // SAFE: htmlContent is caller-provided static HTML (confirm dialog, rename prompt, etc.)

    // #13: bind overlay dismiss listeners ONCE, not per-open. The cancel button is
    // recreated each open (innerHTML replaces it), so we MUST bind per-open there.
    // But the overlay backdrop + Escape listeners are stable DOM elements.
    const cancelBtn = card.querySelector('#msg-cancel-btn');
    cancelBtn?.addEventListener('click', () => {
        _closeMsgOverlay();
        if (_dialogResolver) { _dialogResolver(null); _dialogResolver = null; }
    });

    // Backdrop click — bind once per overlay lifetime.
    if (!overlay._msgBackdropBound) {
        overlay._msgBackdropBound = true;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                _closeMsgOverlay();
                if (_dialogResolver) { _dialogResolver(null); _dialogResolver = null; }
            }
        });
    }

    // Escape key — use a single handler, registered once.

    const onKey = (e) => {
        if (e.key === 'Escape') {
            _closeMsgOverlay();
            document.removeEventListener('keydown', onKey);
            if (_dialogResolver) { _dialogResolver(null); _dialogResolver = null; }
        }
    };
    document.addEventListener('keydown', onKey);

    overlay.classList.remove('is-hidden');
    overlay.style.display = 'flex';

    if (focusSelector) {
        requestAnimationFrame(() => card.querySelector(focusSelector)?.focus());
    }

    return card;
}

function _closeMsgOverlay() {
    const overlay = document.getElementById('msg-overlay');
    if (overlay) {
        overlay.classList.add('is-hidden');
        overlay.style.display = '';
    }
}

/**
 * Show an in-app confirm dialog.
 */
export function showConfirmDialog(title, message) {
    return new Promise((resolve) => {
        _dialogResolver = resolve;

        const card = _openMsgOverlay(`
            <h4 class="msg-title">${title}</h4>
            <span class="msg-content">${message}</span>
            <div class="msg-button-group">
                <button id="msg-cancel-btn">Cancel</button>
                <button id="msg-confirm-btn" class="primary">Confirm</button>
            </div>
        `, '#msg-confirm-btn');

        if (!card) { resolve(false); return; }

        card.querySelector('#msg-confirm-btn')?.addEventListener('click', () => {
            _closeMsgOverlay();
            _dialogResolver = null;
            resolve(true);
        });
    });
}

/**
 * Show a "Move To" dialog with a destination path input.
 * @param {string} currentPath — pre-fill value
 * @returns {Promise<string|null>} destination path or null if cancelled
 */
export function showMoveToDialog(currentPath) {
    return new Promise((resolve) => {
        _dialogResolver = resolve;

        const card = _openMsgOverlay(`
            <h4 class="msg-title">Move To</h4>
            <div class="msg-content msg-input-group">
                <input class="msg-input" id="msg-move-input" type="text"
                       value="${currentPath || '/'}"
                       placeholder="Destination path..."
                       autocomplete="off" spellcheck="false">
            </div>
            <div class="msg-button-group">
                <button id="msg-cancel-btn">Cancel</button>
                <button id="msg-confirm-btn" class="primary">Move</button>
            </div>
        `, '#msg-move-input');

        if (!card) { resolve(null); return; }

        const input = card.querySelector('#msg-move-input');

        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                _closeMsgOverlay();
                _dialogResolver = null;
                resolve(input.value.trim() || null);
            }
        });

        card.querySelector('#msg-confirm-btn')?.addEventListener('click', () => {
            _closeMsgOverlay();
            _dialogResolver = null;
            resolve(input?.value.trim() || null);
        });
    });
}

// ---- Format Helpers ----

export function formatSize(bytes) {
    if (!bytes || bytes === 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return bytes.toFixed(1) + ' ' + units[i];
}

export function formatDate(timestamp) {
    if (!timestamp) return '-';
    return new Date(timestamp * 1000).toLocaleString();
}

function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
    return value || fallback;
}

// ---- Toast ----

export function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icon = type === 'success' ? 'check_circle' :
                 type === 'error' ? 'error' : 'info';
    const colorVar = type === 'success' ? 'toast-success' :
                     type === 'error' ? 'toast-error' : 'toast-info';

    const toast = document.createElement('div');
    toast.className = 'toast-card';
    // SAFE: icon/colorVar from validated type switch (success|error|info), message via textContent
    toast.innerHTML = `
        <div class="toast-icon">
            <span class="icon icon-filled" style="color: var(--${colorVar});">${icon}</span>
        </div>
        <div class="toast-content">
            <span class="toast-message" style="white-space: normal; word-break: break-word;">${message}</span>
        </div>
    `;

    container.appendChild(toast);
    container.style.display = 'flex';

    setTimeout(() => {
        toast.remove();
        if (container.children.length === 0) container.style.display = 'none';
    }, 3000);
}

// ---- Progress Toast Factory ----

function fmtBytes(value, fallback) {
    if (!Number.isFinite(value) || value < 0) return fallback;
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let i = 0;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    const precision = i === 0 ? 0 : 1;
    return `${size.toFixed(precision)}${units[i]}`;
}

function fmtEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--';
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${Math.ceil(seconds % 60)}s`;
}

function createProgressToast(type, opts) {
    const container = document.getElementById('toast-container');
    if (!container) return { update() {}, finish() {} };

    const toast = document.createElement('div');
    toast.className = `toast-card toast-${type}`;
    // SAFE: icon/colorVar from validated type switch (success|error|info)
    toast.innerHTML = `
        <div class="toast-icon">
            <span class="icon icon-filled" style="color: var(--${opts.iconColorVar});">${opts.icon}</span>
        </div>
        <div class="toast-content toast-${type}-content">
            <span class="toast-title">${opts.titleDefault}</span>
            <span class="toast-message">--% • - / --</span>
            <span class="toast-meta">Speed: -- • ETA: --</span>
        </div>
        <div class="toast-progress">
            <div class="toast-progress-fill"></div>
        </div>
    `;

    container.appendChild(toast);
    container.style.display = 'flex';

    const iconEl = toast.querySelector('.toast-icon .icon');
    const titleEl = toast.querySelector('.toast-title');
    const msgEl = toast.querySelector('.toast-message');
    const metaEl = toast.querySelector('.toast-meta');
    const fillEl = toast.querySelector('.toast-progress-fill');

    const UPDATE_INTERVAL_MS = 250;
    const createdAt = Date.now();
    let lastUpdateTime = 0;
    let prevLoaded = null;
    let prevTimestamp = null;

    return {
        update(percent, metrics = {}) {
            const now = Date.now();
            const rawPct = Number.isFinite(percent) ? percent : null;
            const boundedPct = rawPct == null ? null : Math.min(100, Math.max(0, Math.round(rawPct)));
            const isFinal = boundedPct === 100;
            if (!isFinal && now - lastUpdateTime < UPDATE_INTERVAL_MS) return;
            lastUpdateTime = now;

            const loaded = Number.isFinite(metrics.loaded) ? metrics.loaded : null;
            const total = Number.isFinite(metrics.total) ? metrics.total : null;
            const lengthComputable = !!metrics.lengthComputable && total != null && total > 0;
            const loadedText = fmtBytes(loaded, '-');
            const totalText = lengthComputable ? fmtBytes(total, '--') : '--';
            const pctText = boundedPct == null ? '--' : String(boundedPct);

            if (msgEl) {
                msgEl.textContent = (type === 'download' && !lengthComputable)
                    ? `Streaming • ${loadedText}`
                    : `${pctText}% • ${loadedText} / ${totalText}`;
            }
            if (fillEl) {
                if (type === 'download' && !lengthComputable) {
                    fillEl.className = 'toast-progress-fill indeterminate';
                    fillEl.style.width = '100%';
                } else {
                    fillEl.className = 'toast-progress-fill';
                    fillEl.style.width = `${boundedPct ?? 0}%`;
                }
            }

            const eventTime = Number.isFinite(metrics.timestamp) ? metrics.timestamp : now;
            const elapsedMs = eventTime - createdAt;
            let speed = null;
            if (loaded != null && prevLoaded != null && prevTimestamp != null) {
                const dB = loaded - prevLoaded;
                const dT = eventTime - prevTimestamp;
                if (dB >= 0 && dT > 0) speed = (dB / dT) * 1000;
            }
            prevLoaded = loaded;
            prevTimestamp = eventTime;

            if (metaEl) {
                if (elapsedMs >= 2000 && speed && speed > 0) {
                    const speedText = `${fmtBytes(speed, '--')}/s`;
                    let etaText = '--';
                    if (lengthComputable && loaded != null && total != null && total >= loaded) {
                        etaText = fmtEta((total - loaded) / speed);
                    }
                    metaEl.textContent = (type === 'download' && !lengthComputable)
                        ? `Speed: ${speedText}`
                        : `Speed: ${speedText} • ETA: ${etaText}`;
                } else {
                    metaEl.textContent = 'Speed: -- • ETA: --';
                }
            }
        },

        // Set the status message text without changing progress.
        message(text) {
            if (msgEl) msgEl.textContent = text;
        },

        finish(success, message) {
            const okColor = cssVar('toast-success', '#0b5a08');
            const errColor = cssVar('toast-error', '#b10e1c');
            if (iconEl) {
                iconEl.textContent = success ? 'check_circle' : 'error';
                iconEl.style.color = success ? okColor : errColor;
            }
            if (msgEl) msgEl.textContent = '';
            if (titleEl) titleEl.textContent = message || (success ? 'Done' : 'Failed');
            if (metaEl) metaEl.textContent = '';
            if (fillEl) {
                fillEl.className = 'toast-progress-fill';
                fillEl.style.width = '100%';
                fillEl.style.backgroundColor = success ? okColor : errColor;
            }
            setTimeout(() => {
                toast.remove();
                if (container.children.length === 0) container.style.display = 'none';
            }, 3000);
        }
    };
}

export function showUploadToast() {
    return createProgressToast('upload', { icon: 'upload', iconColorVar: 'toast-info', titleDefault: 'Uploading...' });
}

export function showDownloadToast() {
    return createProgressToast('download', { icon: 'download', iconColorVar: 'toast-info', titleDefault: 'Downloading...' });
}
