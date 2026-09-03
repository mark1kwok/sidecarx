/**
 * Unified Overlay Viewer
 *
 * Single entry point for all preview overlays: media (image/video/audio),
 * PDF (browser-native iframe), and Markdown (rendered HTML via sub-component).
 *
 * Replaces the former media-viewer.js, pdf-viewer.js, and md-viewer.js.
 * All existing functionality is preserved — only the entry point is unified.
 */

import { LitElement, html, nothing } from 'lit';
import { getActiveClient } from '../utils/session-manager.js';
import { classifyFile, getMediaType } from '../utils/file-types.js';
import { showToast } from '../utils/ui.js';
import { openTab } from './tab-manager.js';
import './markdown-renderer.js';
import './extended-image.js';

export class OverlayViewer extends LitElement {
    static properties = {
        _visible:   { type: Boolean, state: true },
        _fileType:  { type: String,  state: true },   // 'media' | 'pdf' | 'markdown' | 'html'
        _filePath:  { type: String,  state: true },
        _fileName:  { type: String,  state: true },
        // Media-specific
        _mediaType: { type: String,  state: true },   // 'image' | 'video' | 'audio'
        _mediaList: { type: Array,   state: true },    // [{name, path}]
        _currentIndex: { type: Number, state: true },
        _mediaError:   { type: String,  state: true },   // set when the engine can't decode/stream; shows fallback panel
        _scale:     { type: Number,  state: true },
        // HTML-specific
        _htmlContent: { type: String, state: true },   // fetched HTML text for srcdoc
    };

    // Light DOM
    createRenderRoot() { return this; }

    constructor() {
        super();
        this._visible = false;
        this._fileType = '';
        this._filePath = '';
        this._fileName = '';
        // Media state
        this._mediaType = 'image';
        this._mediaList = [];
        this._currentIndex = 0;
        this._scale = 1;
        this._htmlContent = '';
        this._touchStartX = 0;
        this._touchStartY = 0;
        this._touchOnMedia = false;
        // Bound handlers
        this._boundKeyHandler = this._handleKeyDown.bind(this);
        this._boundTouchStart = this._handleTouchStart.bind(this);
        this._boundTouchEnd = this._handleTouchEnd.bind(this);
    }

    /* ─── Public API ─── */

    /**
     * Open the overlay viewer for a file.
     * @param {string} filePath  - Full path of the file to show
     * @param {Array}  fileList  - Directory listing array (objects with .name, .is_dir)
     * @param {string|null} currentDir - Current directory path, or null when files already carry absolute paths (search mode)
     */
    open(filePath, fileList, currentDir) {
        const fileClass = classifyFile(filePath);
        this._fileType = fileClass;
        this._mediaError = null;

        if (fileClass === 'media') {
            // Build filtered media list with full paths
            this._mediaList = (fileList || [])
                .filter(f => !f.is_dir && classifyFile(f.name) === 'media')
                .map(f => ({
                    name: f.name,
                    path: currentDir == null
                        ? f.path   // search mode: file.path is already absolute
                        : currentDir === '/' ? `/${f.name}` : `${currentDir}/${f.name}`,
                }));

            // Find index of the opened file
            this._currentIndex = Math.max(0, this._mediaList.findIndex(m => m.path === filePath));
            this._showCurrent();
        } else {
            // PDF, Markdown, or HTML: just set path
            this._filePath = filePath;
            this._fileName = filePath.split('/').pop() || filePath;
        }

        this._visible = true;
        document.addEventListener('keydown', this._boundKeyHandler);

        // Touch listeners for all overlay types:
        //  - media: swipe left/right = prev/next, swipe down = close
        //  - markdown/html/pdf: edge-swipe-right = close
        document.addEventListener('touchstart', this._boundTouchStart, { passive: true });
        document.addEventListener('touchend', this._boundTouchEnd);

        // iOS SPA: position:fixed elements don't get env(safe-area-inset-top).
        this._applySafeTop();

        // Markdown: delegate rendering to sub-component after DOM is ready
        if (fileClass === 'markdown') {
            this.updateComplete.then(() => {
                const md = this.querySelector('markdown-renderer');
                if (md) md.renderFile(filePath);
            });
        }

        // HTML: fetch content via authenticated fetch, then inject via srcdoc
        if (fileClass === 'html') {
            this._htmlContent = '';
            getActiveClient().readBlob(filePath)
                .then(blob => blob.text())
                .then(text => { this._htmlContent = text; })
                .catch(err => {
                    console.error('HTML fetch failed:', err);
                    showToast('Failed to load HTML file', 'error');
                });
        }
    }

    close() {
        this._visible = false;

        // Media cleanup: pause any playing media
        if (this._fileType === 'media') {
            const vid = this.querySelector('.ov-video');
            const aud = this.querySelector('.ov-audio');
            if (vid) vid.pause();
            if (aud) aud.pause();
        }

        // Markdown cleanup: stop theme observer
        if (this._fileType === 'markdown') {
            const md = this.querySelector('markdown-renderer');
            if (md) md.destroy();
        }

        // PDF cleanup: clear iframe src
        if (this._fileType === 'pdf') {
            this._filePath = '';
        }

        // HTML cleanup: clear fetched content
        if (this._fileType === 'html') {
            this._htmlContent = '';
        }

        document.removeEventListener('keydown', this._boundKeyHandler);
        document.removeEventListener('touchstart', this._boundTouchStart);
        document.removeEventListener('touchend', this._boundTouchEnd);
    }

    /* ─── iOS safe-area fix for position:fixed overlay ─── */

    _applySafeTop() {
        const root = document.documentElement;
        const probe = document.createElement('div');
        probe.style.cssText = 'padding-top:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;';
        root.appendChild(probe);
        const val = parseFloat(getComputedStyle(probe).paddingTop) || 0;
        probe.remove();

        const bar = this.querySelector('.ov-control-bar');
        if (bar && val > 0) {
            bar.style.paddingTop = `calc(${val}px + 0.5rem)`;
        }
    }

    /* ─── Media navigation ─── */

    _prev() {
        if (this._mediaList.length === 0) return;
        this._currentIndex = (this._currentIndex - 1 + this._mediaList.length) % this._mediaList.length;
        this._showCurrent();
    }

    _next() {
        if (this._mediaList.length === 0) return;
        this._currentIndex = (this._currentIndex + 1) % this._mediaList.length;
        this._showCurrent();
    }

    _showCurrent() {
        const item = this._mediaList[this._currentIndex];
        if (!item) return;
        this._filePath = item.path;
        this._fileName = item.name;
        this._mediaType = getMediaType(item.name) || 'image';
        // Reset any previous decode error so each file gets a fresh attempt.
        this._mediaError = null;
        // Reset zoom state on navigation
        this._scale = 1;
    }

    /* ─── Event handlers ─── */

    _handleKeyDown(e) {
        if (!this._visible) return;
        if (e.key === 'Escape') {
            this.close(); e.preventDefault(); e.stopPropagation();
            return;
        }
        // Arrow keys: media only
        if (this._fileType === 'media') {
            if (e.key === 'ArrowLeft')  { this._prev(); e.preventDefault(); e.stopPropagation(); }
            else if (e.key === 'ArrowRight') { this._next(); e.preventDefault(); e.stopPropagation(); }
        }
    }

    _handleBackdropClick(e) {
        // Close when clicking anywhere not inside a protected element.
        // The selector list adapts per file type.
        if (e.target.closest(this._protectedSelector())) return;
        this.close();
    }

    _protectedSelector() {
        switch (this._fileType) {
            case 'markdown': return '.ov-control-bar, .ov-md-content';
            case 'html':     return '.ov-control-bar, .ov-html-content';
            case 'pdf':      return '.ov-control-bar, .ov-pdf-content';
            default:         return '.ov-control-bar, .ov-nav, img, video, audio';
        }
    }

    /* ─── Media touch swipe gestures ─── */

    _handleTouchStart(e) {
        if (!this._visible) return;
        if (e.touches.length !== 1) return;

        // Media: skip swipe tracking if touch started on the image element itself -
        // that touch belongs to extended-image for panning.
        if (this._fileType === 'media') {
            if (e.target.tagName === 'IMG' && e.target.closest('extended-image')) {
                this._touchOnMedia = true;
                return;
            }
            this._touchOnMedia = false;
        }

        this._touchStartX = e.touches[0].clientX;
        this._touchStartY = e.touches[0].clientY;
    }

    _handleTouchEnd(e) {
        if (!this._visible) return;

        // Media: skip swipe detection if touch started on the image
        if (this._fileType === 'media' && this._touchOnMedia) return;

        const touch = e.changedTouches[0];
        if (!touch) return;
        const deltaX = touch.clientX - this._touchStartX;
        const deltaY = touch.clientY - this._touchStartY;
        const absDX = Math.abs(deltaX);
        const absDY = Math.abs(deltaY);

        if (this._fileType === 'media') {
            // Media: horizontal swipe = prev/next, vertical swipe = close
            if (absDX > 50 && absDX > absDY) {
                if (deltaX < 0) this._next();
                else this._prev();
            } else if (absDY > 50 && absDY > absDX) {
                this.close();
            }
        } else {
            // Non-media (markdown/html/pdf): edge-swipe-right to close.
            // Touch must start near the left edge (within 40px) and swipe
            // right beyond the threshold. This mirrors the file-browser edge
            // gesture in app.js and avoids intercepting horizontal scroll
            // panning that starts mid-screen.
            if (this._touchStartX < 40 && deltaX > 50 && absDX > absDY) {
                this.close();
            }
        }
    }

    _handleMediaError(e) {
        const media = e && e.target;
        const code = media && media.error ? media.error.code : 0;
        console.error('Media preview failed:', this._fileName, 'MediaError code', code);
        if (code === 4 || code === 3) {
            // MEDIA_ERR_SRC_NOT_SUPPORTED / MEDIA_ERR_DECODE: the browser engine
            // can't demux/decode this container or codec (e.g. .mkv H.264 in
            // Chrome/Safari). The backend serves the file fine — offer download.
            this._mediaError =
                'This browser can\u2019t play this file (container or codec not supported). ' +
                'The server serves it fine — download it instead.';
        } else if (code === 2) {
            this._mediaError = 'Couldn\u2019t stream this file from the server (network error).';
        } else {
            this._mediaError = 'Unable to load this file for preview.';
        }
    }

    _clearMediaError() {
        this._mediaError = null;
    }

    async _downloadFallback() {
        const name = this._fileName;
        try {
            const blob = await getActiveClient().download(this._filePath);
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            showToast('Download started', 'success');
        } catch (err) {
            console.error('Fallback download failed:', err);
            showToast('Download failed', 'error');
        }
    }

    _renderMediaFallback() {
        return html`
            <div class="ov-media-fallback" @click=${(e) => e.stopPropagation()}>
                <span class="icon ov-media-fallback-icon">info</span>
                <p class="ov-media-fallback-msg">${this._mediaError}</p>
                <div class="ov-media-fallback-actions">
                    <button class="ov-media-fallback-btn" @click=${() => this._downloadFallback()}>
                        <span class="icon">download</span><span class="text">Download</span>
                    </button>
                    <button class="ov-media-fallback-btn" @click=${() => this._clearMediaError()}>
                        <span class="icon">refresh</span><span class="text">Retry</span>
                    </button>
                </div>
            </div>`;
    }

    _handleIframeError() {
        showToast('Unable to load PDF', 'error');
    }

    /* ─── Markdown edit ─── */

    _handleEdit() {
        if (!this._filePath) return;
        const path = this._filePath;
        const label = this._fileName;
        this.close();
        openTab('editor', { label, path });
    }

    /* ─── Render ─── */

    render() {
        if (!this._visible) return nothing;

        const showEdit = this._fileType === 'markdown' || this._fileType === 'html';

        return html`
            <div class="ov-overlay" @click=${(e) => this._handleBackdropClick(e)}>
                <!-- Control bar -->
                <div class="ov-control-bar" @click=${(e) => e.stopPropagation()}>
                    <span class="ov-filename" title=${this._fileName}>${this._fileName}</span>
                    <div class="ov-actions">
                        ${showEdit ? html`
                            <button class="ov-edit-btn"
                                ?disabled=${!this._filePath}
                                @click=${() => this._handleEdit()}
                                title="Edit in editor">
                                <span class="icon">edit</span>
                                <span class="text">Edit</span>
                            </button>
                        ` : nothing}
                        <button class="ov-close-btn" @click=${() => this.close()} title="Close">
                            <span class="icon">close</span>
                        </button>
                    </div>
                </div>

                <!-- Content area: dispatched by file type -->
                ${this._renderContent()}
            </div>
        `;
    }

    _renderContent() {
        switch (this._fileType) {
            case 'media':
                return this._renderMedia();
            case 'pdf':
                return this._renderPdf();
            case 'markdown':
                return this._renderMarkdown();
            case 'html':
                return this._renderHtml();
            default:
                return nothing;
        }
    }

    _renderMedia() {
        const src = getActiveClient().mediaURL(this._filePath, 604800);
        return html`
            <div class="ov-content">
                <button class="ov-nav ov-nav-prev" @click=${(e) => { e.stopPropagation(); this._prev(); }} title="Previous">
                    <span class="icon">chevron_left</span>
                </button>

                ${this._renderMediaElement(src)}

                <button class="ov-nav ov-nav-next" @click=${(e) => { e.stopPropagation(); this._next(); }} title="Next">
                    <span class="icon">chevron_right</span>
                </button>
            </div>
        `;
    }

    _renderMediaElement(src) {
        if (this._mediaError) return this._renderMediaFallback();
        switch (this._mediaType) {
            case 'video':
                return html`<div class="ov-media-area" @click=${(e) => e.stopPropagation()}>
                    <video class="ov-video" src=${src} crossorigin=${getActiveClient().isSelf ? undefined : "use-credentials"} controls autoplay @error=${(e) => this._handleMediaError(e)} @click=${(e) => e.stopPropagation()}></video>
                </div>`;
            case 'audio':
                return html`<div class="ov-media-area" @click=${(e) => e.stopPropagation()}>
                    <audio class="ov-audio" src=${src} crossorigin=${getActiveClient().isSelf ? undefined : "use-credentials"} controls autoplay @error=${(e) => this._handleMediaError(e)} @click=${(e) => e.stopPropagation()}></audio>
                </div>`;
            default: // image -> extended-image with fullscreen pan area
                return html`<div class="ov-media-fill">
                    <extended-image
                        .src=${src}
                        @img-error=${() => this._handleMediaError()}
                    ></extended-image>
                </div>`;
        }
    }

    _renderPdf() {
        const src = getActiveClient().mediaURL(this._filePath, 604800);
        return html`
            <div class="ov-pdf-content" @click=${(e) => e.stopPropagation()}>
                <iframe
                    class="ov-pdf-iframe"
                    src=${src}
                    @error=${() => this._handleIframeError()}
                ></iframe>
            </div>
        `;
    }

    _renderHtml() {
        return html`
            <div class="ov-html-content" @click=${(e) => e.stopPropagation()}>
                ${this._htmlContent
                    ? html`<iframe
                        class="ov-html-iframe"
                        .srcdoc=${this._htmlContent}
                        sandbox="allow-scripts allow-forms allow-popups allow-modals"
                    ></iframe>`
                    : html`<div class="ov-html-loading"><span class="icon spin">progress_activity</span> Loading…</div>`}
            </div>
        `;
    }

    _renderMarkdown() {
        return html`
            <div class="ov-md-content" @click=${(e) => e.stopPropagation()}>
                <markdown-renderer></markdown-renderer>
            </div>
        `;
    }
}

customElements.define('overlay-viewer', OverlayViewer);
