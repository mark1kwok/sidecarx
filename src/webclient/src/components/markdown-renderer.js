/**
 * Markdown Renderer - Headless render sub-component for the Overlay Viewer.
 *
 * Extracted from the former md-viewer.js. Handles the full Markdown rendering
 * pipeline (marked + DOMPurify + highlight.js + Mermaid + MathJax + theme
 * observer). Does NOT manage overlay visibility or control bar — the parent
 * OverlayViewer handles those.
 *
 * Lifecycle:
 *   1. Parent calls renderFile(path)  → fetches text, runs pipeline
 *   2. Parent calls destroy()         → stops theme observer, cancels async
 */

import { LitElement, html, nothing } from 'lit';
import { marked, Renderer as MarkedRenderer } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import { getActiveClient } from '../utils/session-manager.js';

// ── CDN URLs (classic global scripts, lazy-loaded) ──────────────────────────
// marked / highlight.js / dompurify are BUNDLED (Phase 6 #4) - no longer loaded
// from CDN. Only the heavy lazy-load libs (Mermaid, MathJax) and the markdown
// stylesheet remain on CDN. Mermaid + MathJax carry SRI (Phase 6 #4 stopgap).
const CDN = {
    // github-markdown-css ships separate light/dark variants
    mdCssLight: 'https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.3.0/github-markdown-light.min.css',
    mdCssDark:  'https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.3.0/github-markdown-dark.min.css',
    mermaid:  'https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.min.js',
    mathjax:  'https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-mml-chtml.min.js',
};

// Subresource Integrity (Phase 6 #4) for the remaining classic CDN scripts.
// sha384 base64 of the exact CDN asset; the browser refuses to execute on a
// byte-for-byte mismatch (supply-chain tampering). Computed via:
//   curl -fsSL <url> | openssl dgst -sha384 -binary | openssl base64 -A
const SRI = {
    mermaid: 'sha384-yQ4mmBBT+vhTAwjFH0toJXNYJ6O4usWnt6EPIdWwrRvx2V/n5lXuDZQwQFeSFydF',
    mathjax: 'sha384-M5jmNxKC9EVnuqeMwRHvFuYUE8Hhp0TgBruj/GZRkYtiMrCRgH7yvv5KY+Owi7TW',
};

// DOMPurify config - matches the reference viewer (mjx-container for MathJax,
// input for GFM task lists, data-original-code for mermaid source preservation).
const SANITIZE_OPTIONS = {
    ADD_TAGS: ['mjx-container', 'input'],
    ADD_ATTR: ['id', 'class', 'style', 'align', 'type', 'checked', 'disabled',
               'data-original-code', 'role', 'aria-labelledby', 'aria-describedby'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

// Maximum file size accepted by the viewer (mirrors the editor guard).
const MAX_SIZE = 1024 * 1024;

// Module-level loaders shared across instances.
const _loadedScripts = new Set();
let _markedConfigured = false;
let _lastMermaidTheme = null;
let _mdCssLink = null;     // currently-loaded github-markdown-css <link> element
let _mdCssUrl = null;      // its URL

function loadScript(url, integrity) {
    if (_loadedScripts.has(url)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        // SRI (Phase 6 #4): bind integrity + crossorigin so the browser
        // verifies the script hash before executing. crossorigin="anonymous"
        // is required for the integrity check to fire on cross-origin loads.
        if (integrity) {
            s.integrity = integrity;
            s.crossOrigin = 'anonymous';
        }
        s.onload = () => { _loadedScripts.add(url); resolve(); };
        s.onerror = () => reject(new Error('Failed to load: ' + url));
        document.head.appendChild(s);
    });
}

// Load the github-markdown-css variant matching the current theme, swapping
// out the opposite variant's <link> so both never apply at once.
function loadMarkdownCss() {
    const wantDark = isDarkTheme();
    const wantUrl = wantDark ? CDN.mdCssDark : CDN.mdCssLight;
    if (_mdCssUrl === wantUrl && _mdCssLink) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = wantUrl;
        l.onload = () => {
            // Remove the previous variant so light/dark don't conflict.
            if (_mdCssLink && _mdCssLink !== l) _mdCssLink.remove();
            _mdCssLink = l;
            _mdCssUrl = wantUrl;
            resolve();
        };
        l.onerror = () => reject(new Error('Failed to load style: ' + wantUrl));
        document.head.appendChild(l);
    });
}

function isDarkTheme() {
    return document.documentElement.classList.contains('dark');
}

export class MarkdownRenderer extends LitElement {
    static properties = {
        _loading:  { type: Boolean, state: true },
        _error:    { type: String,  state: true },
    };

    // Light DOM - styles come from style.css + github-markdown-css
    createRenderRoot() { return this; }

    constructor() {
        super();
        this._filePath = '';
        this._loading = false;
        this._error = '';
        this._rawMarkdown = '';
        this._renderGen = 0;          // increments per renderFile() to discard stale renders
        this._themeObserver = null;   // MutationObserver on <html> class for theme swaps
    }

    /* ─── Public API ─── */

    /**
     * Fetch and render a Markdown file.
     * Called by the parent OverlayViewer.
     * @param {string} filePath - Full path of the .md file to render.
     */
    async renderFile(filePath) {
        this._renderGen += 1;
        this._error = '';
        this._startThemeObserver();

        this._filePath = filePath;
        this._loading = true;

        try {
            const blob = await getActiveClient().readBlob(filePath);
            if (blob.size > MAX_SIZE) {
                this._loading = false;
                this._error = `File too large (${(blob.size / 1024 / 1024).toFixed(1)} MB). Maximum is 1 MB.`;
                return;
            }
            const text = await blob.text();
            // Guard against a newer renderFile() superseding this one during await.
            if (this._filePath !== filePath) return;
            this._rawMarkdown = text;
            this._loading = false;
            await this._render();
        } catch (err) {
            if (this._filePath !== filePath) return;
            this._loading = false;
            this._error = err.message || 'Failed to load file';
        }
    }

    /**
     * Stop the theme observer and reset state. Called by parent on close().
     */
    destroy() {
        this._stopThemeObserver();
        this._rawMarkdown = '';
        this._error = '';
        this._filePath = '';
    }

    /* ─── Theme observer ─── */

    _startThemeObserver() {
        if (this._themeObserver) return;
        // applyTheme() toggles the .dark class on <html>; observe that so the
        // viewer re-renders Mermaid/MathJax and swaps the markdown CSS variant.
        this._themeObserver = new MutationObserver(() => {
            if (this._rawMarkdown) {
                this._render();
            }
        });
        this._themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    _stopThemeObserver() {
        if (this._themeObserver) {
            this._themeObserver.disconnect();
            this._themeObserver = null;
        }
    }

    /* ─── Rendering pipeline ─── */

    async _render() {
        const myGen = this._renderGen;
        // Wait for Lit to commit the .ov-md-body element into the DOM (state
        // changes like _loading=false are applied asynchronously).
        await this.updateComplete;
        if (myGen !== this._renderGen) return;
        const body = this.querySelector('.ov-md-body');
        if (!body) return;

        if (!this._rawMarkdown) {
            body.innerHTML = ''; // SAFE: clearing
            return;
        }

        try {
            // marked/highlight.js/dompurify are bundled imports (Phase 6 #4) -
            // no await needed; _ensureLibs only loads the markdown stylesheet.
            await this._ensureLibs();
            if (myGen !== this._renderGen) return; // superseded
            this._configureMarked();

            const html = marked.parse(this._rawMarkdown);
            const safe = DOMPurify.sanitize(html, SANITIZE_OPTIONS);
            body.innerHTML = safe; // SAFE: DOMPurify-sanitized (SANITIZE_OPTIONS)

            // Post-process: Mermaid diagrams, then MathJax.
            await this._processMermaid(body, myGen);
            if (myGen !== this._renderGen) return;
            await this._processMath(body, myGen);
        } catch (err) {
            if (myGen !== this._renderGen) return;
            console.warn('Markdown render failed:', err);
            // SAFE: build the error node with createElement + textContent so a
            // malicious/corrupt err.message can't inject markup.
            body.replaceChildren();
            const p = document.createElement('p');
            p.className = 'ov-md-error';
            p.textContent = `Failed to render: ${err.message}`;
            body.appendChild(p);
        }
    }

    async _ensureLibs() {
        // marked / highlight.js / dompurify are bundled imports - always
        // available, no network. Only the github-markdown-css stylesheet is
        // loaded (from CDN) and theme-swapped here.
        await loadMarkdownCss();
    }

    _configureMarked() {
        if (_markedConfigured) return;
        _markedConfigured = true;

        const renderer = new MarkedRenderer();

        // Code block override: mermaid -> .mermaid div, math -> display math,
        // everything else -> highlight.js.
        renderer.code = function (code, language) {
            if (language === 'mermaid') {
                const id = 'mermaid-diagram-' + Math.random().toString(36).substr(2, 9);
                const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<div class="mermaid-container"><div class="mermaid" id="${id}" data-original-code="${encodeURIComponent(code)}">${escaped}</div></div>`;
            }
            if (language === 'math') {
                return `<div class="math-block">$$\n${code}\n$$</div>`;
            }
            const valid = hljs.getLanguage(language) ? language : 'plaintext';
            const highlighted = hljs.highlight(code, { language: valid }).value;
            return `<pre><code class="hljs ${valid}">${highlighted}</code></pre>`;
        };

        marked.setOptions({
            gfm: true,
            breaks: true,
            pedantic: false,
            sanitize: false,
            smartypants: false,
            xhtml: false,
            headerIds: true,
            mangle: false,
            renderer,
        });
    }

    async _processMermaid(root, myGen) {
        const nodes = root.querySelectorAll('.mermaid');
        if (nodes.length === 0) return;

        await loadScript(CDN.mermaid, SRI.mermaid);
        if (myGen !== this._renderGen) return;

        const theme = isDarkTheme() ? 'dark' : 'default';
        if (_lastMermaidTheme !== theme) {
            window.mermaid.initialize({
                startOnLoad: false,
                theme,
                securityLevel: 'strict',
                flowchart: { useMaxWidth: true, htmlLabels: true },
                fontSize: 16,
            });
            _lastMermaidTheme = theme;
        }
        try {
            await window.mermaid.init(undefined, nodes);
        } catch (e) {
            console.warn('Mermaid rendering failed:', e);
        }
    }

    async _processMath(root, myGen) {
        const raw = this._rawMarkdown || '';
        const hasMath = /\$\$|\$[^$]|\\\(|\\\[/.test(raw) || /```math\b/.test(raw);
        if (!hasMath) return;

        if (!window.MathJax) {
            // Pre-configure before loading so MathJax picks up delimiters.
            window.MathJax = {
                tex: {
                    inlineMath: [['$', '$'], ['\\(', '\\)']],
                    displayMath: [['$$', '$$'], ['\\[', '\\]']],
                    processEscapes: true,
                },
                options: { a11y: { inTabOrder: false } },
            };
            await loadScript(CDN.mathjax, SRI.mathjax);
        }
        if (myGen !== this._renderGen) return;
        try {
            await window.MathJax.typesetPromise([root]);
        } catch (e) {
            console.warn('MathJax typesetting failed:', e);
        }
    }

    /* ─── Render ─── */

    render() {
        return html`
            ${this._loading
                ? html`<div class="ov-md-status"><span class="icon spin">progress_activity</span> Loading…</div>`
                : this._error
                    ? html`<div class="ov-md-status ov-md-status-error"><span class="icon">error</span> ${this._error}</div>`
                    : html`<div class="ov-md-body markdown-body"></div>`}
        `;
    }
}

customElements.define('markdown-renderer', MarkdownRenderer);
