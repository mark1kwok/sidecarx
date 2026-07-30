/**
 * Extended Image Viewer
 *
 * Ported from filebrowser's ExtendedImage.vue to Lit.
 * Provides pan, pinch-zoom, wheel-zoom, and double-tap/click zoom cycle.
 *
 * Source: https://github.com/filebrowser/filebrowser/blob/fe7efb2e6afe66774cd86a5b0a03033bd514d0c0/frontend/src/components/files/ExtendedImage.vue
 */

import { LitElement, html } from 'lit';

export class ExtendedImage extends LitElement {
    static properties = {
        src: { type: String },
        _scale: { type: Number, state: true },
    };

    // Light DOM
    createRenderRoot() { return this; }

    constructor() {
        super();
        this.src = '';
        this._scale = 1;
        this._lastX = null;
        this._lastY = null;
        this._inDrag = false;
        this._touches = 0;
        this._lastTouchDistance = null;
        this._moveDisabled = false;
        this._disabledTimer = null;
        this._imageLoaded = false;
        this._maxScale = 4;
        this._minScale = 0.25;
        this._zoomStep = 0.25;
        this._moveDisabledTime = 200;
        this._position = {
            center: { x: 0, y: 0 },
            relative: { x: 0, y: 0 },
        };
        this._resizeRaf = null;
    }

    /** Expose current zoom level for parent (swipe guard). */
    get scale() {
        return this._scale;
    }

    /* ─── Lifecycle ─── */

    connectedCallback() {
        super.connectedCallback();
        window.addEventListener('resize', this._onResize);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        window.removeEventListener('resize', this._onResize);
        document.removeEventListener('mouseup', this._onDocumentMouseUp);
        if (this._disabledTimer) clearTimeout(this._disabledTimer);
        if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    }

    updated(changedProps) {
        if (changedProps.has('src')) {
            const img = this.querySelector('.ov-img-ext');
            if (img) {
                img.src = this.src;
                // Reset zoom and position for new image
                this._scale = 1;
                this._setZoom();
                img.classList.remove('ov-img-ext-ready');
                img.classList.add('ov-img-ext-center');
                this._imageLoaded = false;
            }
        }
    }

    /* ─── Image load ─── */

    _onLoad() {
        this._imageLoaded = true;
        const img = this.querySelector('.ov-img-ext');
        if (!img) return;

        img.classList.remove('ov-img-ext-center');
        this._setCenter();
        img.classList.add('ov-img-ext-ready');

        document.addEventListener('mouseup', this._onDocumentMouseUp);

        // Compute dynamic maxScale from natural dimensions
        let realSize = img.naturalWidth;
        let displaySize = img.offsetWidth;
        if (img.naturalHeight > img.naturalWidth) {
            realSize = img.naturalHeight;
            displaySize = img.offsetHeight;
        }
        const fullScale = realSize / displaySize;
        this._maxScale = fullScale + 4;
    }

    /* ─── Resize (throttled via rAF) ─── */

    _onResize = () => {
        if (this._resizeRaf) return;
        this._resizeRaf = requestAnimationFrame(() => {
            this._resizeRaf = null;
            if (this._imageLoaded) {
                this._setCenter();
                this._doMove(this._position.relative.x, this._position.relative.y);
            }
        });
    };

    /* ─── Positioning ─── */

    _setCenter() {
        const container = this.querySelector('.ov-img-container');
        const img = this.querySelector('.ov-img-ext');
        if (!container || !img) return;

        this._position.center.x = Math.floor((container.clientWidth - img.clientWidth) / 2);
        this._position.center.y = Math.floor((container.clientHeight - img.clientHeight) / 2);
        img.style.left = this._position.center.x + 'px';
        img.style.top = this._position.center.y + 'px';
    }

    _doMove(x, y) {
        const img = this.querySelector('.ov-img-ext');
        if (!img) return;
        const style = img.style;
        const posX = this._pxStringToNumber(style.left) + x;
        const posY = this._pxStringToNumber(style.top) + y;
        style.left = posX + 'px';
        style.top = posY + 'px';

        this._position.relative.x = Math.abs(this._position.center.x - posX);
        this._position.relative.y = Math.abs(this._position.center.y - posY);
        if (posX < this._position.center.x) this._position.relative.x *= -1;
        if (posY < this._position.center.y) this._position.relative.y *= -1;
    }

    /* ─── Mouse drag (pan) ─── */

    _mousedownStart(e) {
        if (e.button !== 0) return;
        this._lastX = null;
        this._lastY = null;
        this._inDrag = true;
        e.preventDefault();
    }

    _mouseMove(e) {
        if (!this._inDrag) return;
        this._doMove(e.movementX, e.movementY);
        e.preventDefault();
    }

    _mouseUp(e) {
        if (this._inDrag) e.preventDefault();
        this._inDrag = false;
    }

    _onDocumentMouseUp = () => {
        this._inDrag = false;
    };

    /* ─── Touch ─── */

    _touchStart(e) {
        const img = this.querySelector('.ov-img-ext');
        this._touchOnImage = img && (e.target === img);
        // For backdrop single-finger touches, don't process or preventDefault.
        // iOS Safari won't synthesize click events if preventDefault is called
        // on touchstart/touchmove, which breaks backdrop-tap-to-close.
        if (!this._touchOnImage && e.targetTouches.length < 2) {
            return;
        }
        this._lastX = null;
        this._lastY = null;
        this._lastTouchDistance = null;
        this._panning = false;
        if (e.targetTouches.length < 2) {
            setTimeout(() => { this._touches = 0; }, 300);
            this._touches++;
            if (this._touches > 1) {
                this._zoomAuto(e);
            }
        }
        e.preventDefault();
    }

    _touchEnd(e) {
        // Prevent overlay swipe when we were actively handling pinch or pan
        if (this._lastTouchDistance !== null || this._panning) {
            e.stopPropagation();
            this._lastTouchDistance = null;
            this._panning = false;
        }
    }

    _touchMove(e) {
        // Backdrop single-finger: don't process or preventDefault (preserve click synthesis)
        if (!this._touchOnImage && e.targetTouches.length < 2) return;
        e.preventDefault();
        if (this._lastX === null) {
            this._lastX = e.targetTouches[0].pageX;
            this._lastY = e.targetTouches[0].pageY;
            return;
        }
        const img = this.querySelector('.ov-img-ext');
        if (!img) return;

        const step = img.width / 5;

        if (e.targetTouches.length === 2) {
            // Pinch zoom - always active
            this._moveDisabled = true;
            if (this._disabledTimer) clearTimeout(this._disabledTimer);
            this._disabledTimer = setTimeout(() => { this._moveDisabled = false; }, this._moveDisabledTime);

            const p1 = e.targetTouches[0];
            const p2 = e.targetTouches[1];
            const touchDistance = Math.sqrt(
                Math.pow(p2.pageX - p1.pageX, 2) + Math.pow(p2.pageY - p1.pageY, 2)
            );
            if (!this._lastTouchDistance) {
                this._lastTouchDistance = touchDistance;
                return;
            }
            this._scale += (touchDistance - this._lastTouchDistance) / step;
            this._lastTouchDistance = touchDistance;
            this._setZoom();
        } else if (e.targetTouches.length === 1) {
            // Single-finger pan - only when touch started on the image.
            // If touch started on backdrop area, let it bubble for swipe nav/close.
            if (!this._touchOnImage) return;
            if (this._moveDisabled) return;
            this._panning = true;
            const x = e.targetTouches[0].pageX - (this._lastX ?? 0);
            const y = e.targetTouches[0].pageY - (this._lastY ?? 0);
            if (Math.abs(x) >= step && Math.abs(y) >= step) return;
            this._lastX = e.targetTouches[0].pageX;
            this._lastY = e.targetTouches[0].pageY;
            this._doMove(x, y);
        }
    }

    /* ─── Wheel zoom ─── */

    _wheelMove(e) {
        this._scale += -Math.sign(e.deltaY) * this._zoomStep;
        this._setZoom();
        e.preventDefault();
    }

    /* ─── Double-click / double-tap zoom cycle (1 -> 2 -> 4 -> 1) ─── */

    _zoomAuto(e) {
        switch (this._scale) {
            case 1: this._scale = 2; break;
            case 2: this._scale = 4; break;
            default:
            case 4: this._scale = 1; this._setCenter(); break;
        }
        this._setZoom();
        e.preventDefault();
    }

    /* ─── Zoom control ─── */

    _setZoom() {
        this._scale = this._scale < this._minScale ? this._minScale : this._scale;
        this._scale = this._scale > this._maxScale ? this._maxScale : this._scale;
        const img = this.querySelector('.ov-img-ext');
        if (img) img.style.transform = `scale(${this._scale})`;
    }

    /* ─── Helpers ─── */

    _pxStringToNumber(s) {
        return +s.replace('px', '');
    }

    /* ─── Render ─── */

    render() {
        return html`
            <div class="ov-img-container"
                @touchstart=${(e) => this._touchStart(e)}
                @touchmove=${(e) => this._touchMove(e)}
                @touchend=${(e) => this._touchEnd(e)}
                @dblclick=${(e) => this._zoomAuto(e)}
                @mousedown=${(e) => this._mousedownStart(e)}
                @mousemove=${(e) => this._mouseMove(e)}
                @mouseup=${(e) => this._mouseUp(e)}
                @wheel=${(e) => this._wheelMove(e)}
            >
                <img class="ov-img-ext ov-img-ext-center"
                    @load=${() => this._onLoad()}
                    @error=${() => this.dispatchEvent(new CustomEvent('img-error', { bubbles: true, composed: true }))}
                    alt="">
            </div>
        `;
    }
}

customElements.define('extended-image', ExtendedImage);
