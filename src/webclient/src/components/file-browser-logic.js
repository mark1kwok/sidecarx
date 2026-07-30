import {LitElement, html} from 'lit';
import './file-browser.js';
import { handleDropItems, downloadItems, pasteItems, setClipboardCopy, setClipboardCut, clearClipboard, moveItemsToDir, parentPath } from '../utils/file-ops.js';
import { getActiveClient, getActiveMachineId, getBrowser, getSession, setPath, setViewMode, setSelection, setSearch } from '../utils/session-manager.js';
import { store } from '../utils/store.js';
import { showToast, showUploadToast, showMoveToDialog, formatSize } from '../utils/ui.js';
import { classifyFile } from '../utils/file-types.js';

// Empty browser search slice, used when navigation clears search state.
const DEFAULT_SEARCH = Object.freeze({ mode: null, query: '', results: [], clientFilter: '' });

export class FileBrowserLogic extends LitElement {
    static properties = {
        currentPath: { type: String },
        active: { type: Boolean },
        viewMode: { type: String }
    };

    // Use Light DOM - styles come from style.css
    createRenderRoot() {
        return this;
    }

    constructor() {
        super();
        this.currentPath = '/';
        this.active = false;
        this.viewMode = 'list';
        this._lastMachineId = null;
        this._unsubStore = null;

        // Seed from the active session's browser slice. Self is ensured + authed
        // before this component mounts, so the slice already has rootDir/path.
        const slice = getBrowser(getActiveMachineId());
        const session = getSession(getActiveMachineId());
        this.currentPath = slice?.currentPath || session?.connection?.rootDir || '/';
        this.viewMode = slice?.viewMode || 'list';
    }

    connectedCallback() {
        super.connectedCallback();
        this._lastMachineId = getActiveMachineId();
        // Track the active session's path/viewMode (and machine switches). On a
        // switch we restore this panel's props from the target slice and reload
        // the child (D3 — no root reset); same-machine changes are reflected back
        // into our props so external mutations (e.g. sidebar tree nav) track.
        this._unsubStore = store.subscribeSelect(
            (s) => {
                const mid = s.activeMachineId;
                const browser = s.sessions.get(mid)?.browser;
                return { mid, path: browser?.currentPath, viewMode: browser?.viewMode };
            },
            ({ mid, path, viewMode }) => this._onSliceChanged(mid, path, viewMode),
        );
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (this._unsubStore) { this._unsubStore(); this._unsubStore = null; }
    }

    firstUpdated() {
        // The one initial load. (#22 — the child no longer self-loads on connect;
        // updated()'s guard skips the initial cycle since props already match.)
        this._refreshBrowser();
    }

    _onSliceChanged(mid, path, viewMode) {
        if (mid !== this._lastMachineId) {
            // Machine switch: restore path/viewMode from the target session and
            // reload the child for the new machine. No reset to root, no tab
            // close (D3/D7).
            this._lastMachineId = mid;
            const session = getSession(mid);
            this.currentPath = path || session?.connection?.rootDir || '/';
            this.viewMode = viewMode || 'list';
            this._refreshBrowser();
            return;
        }
        // Same machine: reflect external slice changes into our props so they
        // stay in sync. updated()'s guard prevents a dispatch echo.
        if (path !== undefined && path !== this.currentPath) this.currentPath = path;
        if (viewMode !== undefined && viewMode !== this.viewMode) this.viewMode = viewMode;
    }

    updated(changedProperties) {
        const id = getActiveMachineId();
        const slice = getBrowser(id);
        if (changedProperties.has('currentPath')) {
            // Only dispatch + reload when OUR value diverges from the slice (a
            // genuine external/user navigation). During a switch the subscription
            // sets the property FROM the slice, so they match and this is a no-op
            // — avoiding a redundant dispatch, a selection clear, and a double fetch.
            if (slice && this.currentPath !== slice.currentPath) {
                setPath(id, this.currentPath);
                // Navigation clears selection + search for this session; the child
                // re-syncs from the now-empty slice during its reload.
                setSelection(id, new Set());
                setSearch(id, { ...DEFAULT_SEARCH });
                this._refreshBrowser();
            }
        }
        if (changedProperties.has('viewMode')) {
            if (slice && this.viewMode !== slice.viewMode) {
                setViewMode(id, this.viewMode);
            }
        }
    }

    render() {
        // Light DOM - renders directly, file-browser also uses Light DOM
        return html`
            <file-browser
                .currentPath=${this.currentPath}
                .viewMode=${this.viewMode}
                @navigate=${this._handleNavigate}
                @open-file=${this._handleOpenFile}
                @upload-drop=${this._handleUploadDrop}
                @clipboard-action=${this._handleClipboardAction}
                @internal-move=${this._handleInternalMove}
            ></file-browser>
        `;
    }

    /* Public Methods for External Controls */
    
    refresh() {
        this._refreshBrowser();
    }

    /**
     * Force reload the file list (even if path hasn't changed).
     * Used after machine switch to reload at the same path.
     */
    reload() {
        this._refreshBrowser();
    }

    setViewMode(mode) {
        this.viewMode = mode;
    }

    createFolder() {
        // Light DOM: use this.querySelector instead of shadowRoot
        const browser = this.querySelector('file-browser');
        if (browser) browser.startCreation('folder');
    }

    createFile() {
        const browser = this.querySelector('file-browser');
        if (browser) browser.startCreation('file');
    }

    triggerUpload() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = async () => {
            if (input.files.length > 0) {
                const toast = showUploadToast();
                try {
                    await getActiveClient().upload(this.currentPath, input.files, {
                        onProgress: (percent, metrics) => toast.update(percent, metrics),
                    });
                    toast.finish(true, 'Upload complete');
                    this.refresh();
                } catch (e) {
                    toast.finish(false, e.message || 'Upload failed');
                }
            }
        };
        input.click();
    }

    triggerFolderUpload() {
        const input = document.createElement('input');
        input.type = 'file';
        input.setAttribute('webkitdirectory', '');
        input.onchange = async () => {
            if (!input.files || input.files.length === 0) {
                showToast('No files found to upload', 'warning');
                return;
            }
            const toast = showUploadToast();
            try {
                // Build path-preserving file list from webkitRelativePath
                const filesWithPaths = Array.from(input.files).map(file => ({
                    file,
                    name: file.webkitRelativePath || file.name,
                }));
                await getActiveClient().upload(this.currentPath, filesWithPaths, {
                    onProgress: (percent, metrics) => toast.update(percent, metrics),
                });
                toast.finish(true, 'Folder upload complete');
                this.refresh();
            } catch (e) {
                toast.finish(false, `Folder upload failed: ${e.message}`);
            }
        };
        input.click();
    }
    
    triggerDelete() {
        const browser = this.querySelector('file-browser');
        if (browser) browser._deleteSelected();
    }
    
    triggerDownload() {
        const selectedPaths = this._getSelectedFullPaths();
        if (selectedPaths.length > 0) {
            downloadItems(selectedPaths);
        }
    }
    
    triggerCopy() {
        const items = this._getSelectedItems();
        if (items.length > 0) {
            setClipboardCopy(items);
            // Clear any lingering cut markers — the clipboard holds only one
            // operation at a time; a copy replaces a prior cut.
            const browser = this.querySelector('file-browser');
            if (browser) browser.clearCutMarkers();
        }
    }

    triggerCopyPath() {
        const selectedPaths = this._getSelectedFullPaths();
        if (selectedPaths.length === 0) return;
        const text = selectedPaths.join('\n');

        // Use a textarea+execCommand fallback — the async clipboard API loses
        // the user-gesture context through Lit's event dispatch chain.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();

        let ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (_) { /* ignored */ }
        document.body.removeChild(ta);

        if (ok) {
            showToast(
                selectedPaths.length === 1 ? 'Path copied to clipboard' : `${selectedPaths.length} paths copied to clipboard`,
                'success');
        } else {
            showToast('Failed to copy path', 'error');
        }
    }

    triggerCut() {
        const items = this._getSelectedItems();
        if (items.length > 0) {
            setClipboardCut(items);
            // Add visual indicator for cut items (markCutItems still expects plain paths)
            const browser = this.querySelector('file-browser');
            if (browser) browser.markCutItems(items.map(i => i.path));
        }
    }
    
    async triggerPaste() {
        const enqueued = await pasteItems(this.currentPath);
        if (enqueued) {
            // Clear cut visual markers; the clipboard is consumed. The
            // destination list refreshes via the 'file-browser-refresh' event
            // when the transfer job lands (same-machine is near-instant;
            // cross-machine tracks in the transfer panel).
            const browser = this.querySelector('file-browser');
            if (browser) browser.clearCutMarkers();
        }
    }
    
    triggerRename() {
        const browser = this.querySelector('file-browser');
        const sel = getBrowser(getActiveMachineId())?.selectedFiles;
        if (browser && sel && sel.size === 1) {
            browser._startRename(Array.from(sel)[0]);
        }
    }

    async triggerMoveTo() {
        const selectedPaths = this._getSelectedFullPaths();
        if (selectedPaths.length === 0) return;
        const destDir = await showMoveToDialog(this.currentPath);
        if (!destDir) return;
        try {
            const client = getActiveClient();
            for (const sourcePath of selectedPaths) {
                const fileName = sourcePath.split('/').pop();
                const cleanDest = destDir === '/' ? '' : destDir.replace(/\/+$/, '');
                const destPath = cleanDest ? `${cleanDest}/${fileName}` : `/${fileName}`;
                if (sourcePath === destPath) continue;
                await client.rename(sourcePath, destPath);
            }
            showToast(`Moved ${selectedPaths.length} item(s)`, 'success');
            this.refresh();
        } catch (err) {
            showToast(`Move failed: ${err.message}`, 'error');
        }
    }

    navigateUp() {
        const rootDir = getSession(getActiveMachineId())?.connection?.rootDir || null;
        const next = parentPath(this.currentPath, rootDir); // #20: shared root guard
        if (next === null) return; // already at root / jail root
        this.currentPath = next;
    }

    _getSelectedFullPaths() {
        const sel = getBrowser(getActiveMachineId())?.selectedFiles;
        if (!sel || sel.size === 0) return [];
        return Array.from(sel);
    }

    /**
     * Get selected items as {path, isDir} objects by looking up the file-browser's file list.
     * Clipboard operations use this to avoid server round-trips for type detection.
     */
    _getSelectedItems() {
        const paths = this._getSelectedFullPaths();
        if (paths.length === 0) return [];
        const browser = this.querySelector('file-browser');
        const files = browser ? (browser.searchMode === 'api' ? browser._displayFiles : browser.files) : [];
        const fullPath = (f) => browser
            ? browser._fullPath(f)
            : (this.currentPath === '/' ? `/${f.name}` : `${this.currentPath}/${f.name}`);
        return paths.map(p => {
            const file = files.find(f => fullPath(f) === p);
            return { path: p, isDir: file ? !!file.is_dir : false };
        });
    }

    /* Internal Handlers */

    _refreshBrowser() {
        const browser = this.querySelector('file-browser');
        if (browser) browser.loadFiles();
    }

    _handleNavigate(e) {
        this.currentPath = e.detail.path;
    }

    async _handleUploadDrop(e) {
        const items = e.detail.items;
        await handleDropItems(items, this.currentPath);
        this.refresh();
    }

    _handleOpenFile(e) {
        const { file, path } = e.detail;
        const fileClass = classifyFile(file.name);

        // Media, PDF, Markdown, HTML -> unified overlay viewer
        if (fileClass === 'media' || fileClass === 'pdf' || fileClass === 'markdown' || fileClass === 'html') {
            const viewer = document.querySelector('overlay-viewer');
            if (viewer) {
                // Media needs fileList + currentDir for prev/next navigation.
                // PDF and Markdown don't use them but accept the params harmlessly.
                const browser = this.querySelector('file-browser');
                const fileList = browser
                    ? (browser.searchMode === 'api' ? browser._displayFiles : browser.files)
                    : [];
                const currentDir = (browser?.searchMode === 'api') ? null : this.currentPath;
                viewer.open(path, fileList, currentDir);
            }
            return;
        }

        // Editor - apply size guard
        const MAX_SIZE = 1024 * 1024;
        if (file.size > MAX_SIZE) {
            showToast(`File too large (${formatSize(file.size)}).`, 'warning');
            return;
        }

        this.dispatchEvent(new CustomEvent('app-open-file', {
            bubbles: true,
            composed: true,
            detail: {
                path: path,
                name: file.name,
                size: file.size,
                type: 'file'
            }
        }));
    }
    
    _handleClipboardAction(e) {
        const { operation } = e.detail;
        switch (operation) {
            case 'copy':
                this.triggerCopy();
                break;
            case 'cut':
                this.triggerCut();
                break;
            case 'paste':
                this.triggerPaste();
                break;
        }
    }

    async _handleInternalMove(e) {
        const { paths, destDir } = e.detail;
        if (!paths || paths.length === 0 || !destDir) return;
        const success = await moveItemsToDir(paths, destDir);
        if (success) {
            const browser = this.querySelector('file-browser');
            if (browser) browser.loadFiles();
        }
    }
}

customElements.define('file-browser-logic', FileBrowserLogic);
