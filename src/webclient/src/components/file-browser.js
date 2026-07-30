import {LitElement, html} from 'lit';
import { getActiveClient, getActiveMachineId, getBrowser, getSession, setSelection, setFiles, setSort, setSearch } from '../utils/session-manager.js';
import { getFileIcon, isFavorite, addFavorite, removeFavorite, getActiveMachine } from '../utils/config.js';
import { showToast, formatSize, showConfirmDialog } from '../utils/ui.js';
import { hasThumbnail } from '../utils/file-types.js';
import { parentPath } from '../utils/file-ops.js';

// Default (empty) browser search slice — used when clearing search/navigation.
const DEFAULT_SEARCH = Object.freeze({ mode: null, query: '', results: [], clientFilter: '' });

export class FileBrowser extends LitElement {
    static properties = {
        currentPath: { type: String },
        viewMode: { type: String }, // 'list' | 'grid' | 'thumb'
        files: { type: Array },
        selectedPaths: { type: Object }, // Set<string>
        isLoading: { type: Boolean },
        sortField: { type: String }, // 'name', 'size', 'modified'
        sortDirection: { type: String }, // 'asc', 'desc'
        newItem: { type: Object }, // { type: 'file'|'folder', name: '' } - in-memory creation
        searchMode: { type: String }, // null | 'api'
        _clientFilter: { type: String }, // client-side filter query
    };

    // Use Light DOM so global style.css applies
    createRenderRoot() {
        return this;
    }

    constructor() {
        super();
        this.files = [];
        this.selectedPaths = new Set();
        this.viewMode = 'list';
        this.sortField = 'name';
        this.sortDirection = 'asc';
        this.isLoading = false;
        this.lastSelectedPath = null; // For shift-click range selection
        this.newItem = null; // { type, name } for inline creation
        this._renameCancelSet = new Set();
        // Search state (mirrored from the session slice; the slice is authoritative).
        this.searchMode = null;
        this._clientFilter = '';
        this._searchResults = [];
        // Cut-marker full paths; render checks membership. (#18 — no mutation of
        // file objects, and matched by full path rather than basename.)
        this._cutPaths = null;
    }

    connectedCallback() {
        super.connectedCallback();
        // No loadFiles() here — the parent (file-browser-logic) drives the
        // initial load from its connectedCallback, which avoids a double fetch
        // on first paint (#22). The file-browser-refresh event still triggers a
        // reload when a paste/upload lands for the active machine.
        this.addEventListener('keydown', this._handleKeyDown);

        // file-browser-refresh now carries { machineId }; ignore when it targets
        // a machine other than the active one (D6).
        this._boundRefresh = (e) => {
            const targetMachine = e?.detail?.machineId;
            if (targetMachine && targetMachine !== getActiveMachineId()) return;
            this.loadFiles();
        };
        window.addEventListener('file-browser-refresh', this._boundRefresh);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this.removeEventListener('keydown', this._handleKeyDown);
        window.removeEventListener('file-browser-refresh', this._boundRefresh);
    }

    /**
     * Effective render view: API search always renders as a flat list (the
     * results carry absolute paths that only make sense in list form). Derived
     * from searchMode (synced from the slice) so the forced-list behaviour
     * survives machine switches without mutating the user's chosen viewMode.
     */
    get _effectiveViewMode() {
        return this.searchMode === 'api' ? 'list' : (this.viewMode || 'list');
    }

    async loadFiles() {
        const machineId = getActiveMachineId();
        const slice = getBrowser(machineId);
        // The slice is the single source of truth for currentPath; read it here
        // (not this.currentPath) so a load fired during a switch fetches the
        // restored path even before the Lit property binding has propagated.
        const path = slice?.currentPath ?? this.currentPath;
        if (!path) return;
        this.currentPath = path; // keep the render-time property in sync

        // Sync durable context (sort/selection/search) FROM the slice first.
        // Navigation clears the slice upstream (file-browser-logic.updated), so
        // a navigate renders with empty selection; a switch renders with the
        // restored per-machine selection/search.
        this._syncContextFromSlice();
        this.isLoading = true;
        this.files = []; // drop stale listing immediately

        try {
            const items = await getActiveClient().list(path);
            const sorted = this._sortFiles(items);
            setFiles(machineId, sorted);
            this.files = sorted;
        } catch (err) {
            showToast(`Failed to load: ${err.message}`, 'error');
            setFiles(machineId, []);
            this.files = [];
        } finally {
            this.isLoading = false;
            this.requestUpdate();
        }
    }

    /**
     * Restore durable browser context (sort, selection, search) and the global
     * search input from the active session's slice. Called at the start of
     * loadFiles so the fetch sorts by the restored key and machine switches
     * preserve per-machine selection/search/view.
     */
    _syncContextFromSlice() {
        const slice = getBrowser(getActiveMachineId());
        if (!slice) return;
        this.sortField = slice.sortBy;
        this.sortDirection = slice.sortOrder;
        this.selectedPaths = new Set(slice.selectedFiles);
        this.lastSelectedPath = null;
        const search = slice.search || DEFAULT_SEARCH;
        this.searchMode = search.mode ?? null;
        this._clientFilter = search.clientFilter ?? '';
        this._searchResults = search.results ?? [];
        // Restore the global search input so per-session search survives switches.
        const searchInput = document.querySelector('.search-input');
        const searchBox = document.querySelector('.searchbox');
        if (searchInput) searchInput.value = search.query || '';
        if (searchBox) searchBox.classList.toggle('search-active', search.mode === 'api' || !!search.clientFilter);
    }

    /**
     * Resolve full path for a file entry.
     * In search mode, use the absolute path from results; otherwise build from currentPath.
     */
    _fullPath(file) {
        return (this.searchMode === 'api' && file.path)
            ? file.path
            : this.currentPath === '/' ? `/${file.name}` : `${this.currentPath}/${file.name}`;
    }

    _sortFiles(files) {
        // #19: sort a COPY — never mutate the server-returned array (or the
        // session slice's array, which may be the same reference).
        return [...files].sort((a, b) => {
            // Always folders first
            if (a.is_dir !== b.is_dir) return b.is_dir ? 1 : -1;
            
            let valA = a[this.sortField];
            let valB = b[this.sortField];
            
            // Case insensitive name sort
            if (this.sortField === 'name') {
                valA = valA.toLowerCase();
                valB = valB.toLowerCase();
            }

            if (valA < valB) return this.sortDirection === 'asc' ? -1 : 1;
            if (valA > valB) return this.sortDirection === 'asc' ? 1 : -1;
            return 0;
        });
    }

    /* --- Search --- */

    get _displayFiles() {
        if (this.searchMode === 'api') return this._searchResults;
        if (this._clientFilter) {
            const q = this._clientFilter.toLowerCase();
            return this.files.filter(f => f.name.toLowerCase().includes(q));
        }
        return this.files;
    }

    /**
     * Merge a patch into the active session's search slice and mirror it locally
     * for render. Centralizes per-machine search persistence (D3).
     */
    _applySearch(patch) {
        const machineId = getActiveMachineId();
        const slice = getBrowser(machineId);
        const prev = slice?.search || DEFAULT_SEARCH;
        const next = { ...prev, ...patch };
        setSearch(machineId, next);
        this.searchMode = next.mode ?? null;
        this._clientFilter = next.clientFilter ?? '';
        this._searchResults = next.results ?? [];
        const searchBox = document.querySelector('.searchbox');
        if (searchBox) searchBox.classList.toggle('search-active', next.mode === 'api' || !!next.clientFilter);
        this.requestUpdate();
    }

    applyClientFilter(query) {
        this._applySearch({ clientFilter: query || '', query: query || '' });
    }

    async executeSearch(query) {
        if (!query) return;
        const pattern = `*${query}*`;
        this.isLoading = true;
        try {
            const res = await getActiveClient().search(this.currentPath, pattern);
            this._applySearch({ mode: 'api', query, results: res.matches || [], clientFilter: '' });
        } catch (err) {
            showToast(`Search failed: ${err.message}`, 'error');
        } finally {
            this.isLoading = false;
        }
    }

    clearSearch() {
        this._applySearch({ ...DEFAULT_SEARCH });
        const searchInput = document.querySelector('.search-input');
        if (searchInput) searchInput.value = '';
        this.loadFiles();
    }

    /* --- Rendering --- */

    render() {
        // _effectiveViewMode forces 'list' during API search (results carry
        // absolute paths). Light DOM - uses classes from style.css.
        const vm = this._effectiveViewMode;
        return html`
            <div class="surface-card file-list-box" tabindex="0" style="display: ${vm === 'list' ? 'flex' : 'none'};"
                @click=${this._handleBackgroundClick}
                @dragover=${this._handleDragOver}
                @dragleave=${this._handleDragLeave}
                @drop=${this._handleDrop}>
                ${this._renderHeader()}
                <ul data-role="file-listing">
                    ${this._displayFiles.map((file, index) => this._renderRow(file, index))}
                    ${this.newItem && vm === 'list' ? this._renderNewItemRow() : ''}
                </ul>
            </div>
            <div class="file-grid-box" tabindex="0" style="display: ${vm === 'grid' ? 'flex' : 'none'};"
                 @click=${this._handleBackgroundClick}
                 @dragover=${this._handleDragOver}
                 @dragleave=${this._handleDragLeave}
                 @drop=${this._handleDrop}>
                ${this._displayFiles.map((file, index) => this._renderCard(file, index))}
                ${this.newItem && vm === 'grid' ? this._renderNewItemCard() : ''}
            </div>
            <div class="file-thumb-box" tabindex="0" style="display: ${vm === 'thumb' ? 'grid' : 'none'};"
                 @click=${this._handleBackgroundClick}
                 @dragover=${this._handleDragOver}
                 @dragleave=${this._handleDragLeave}
                 @drop=${this._handleDrop}>
                ${this._displayFiles.map((file, index) => this._renderThumbCard(file, index))}
                ${this.newItem && vm === 'thumb' ? this._renderNewItemThumbCard() : ''}
            </div>
        `;
    }

    _renderHeader() {
        const renderSortIcon = (field) => {
            if (this.sortField !== field) return '';
            return html`<span class="icon sort-icon">${this.sortDirection === 'asc' ? 'keyboard_double_arrow_down' : 'keyboard_double_arrow_up'}</span>`;
        };
        
        return html`
            <div class="list-header">
                <div class="list-checkbox" title="Select All" @click=${this._toggleSelectAll}>
                    <span class="icon icon-sm checkbox">${this.selectedPaths.size === this._displayFiles.length && this._displayFiles.length > 0 ? 'check_circle' : 'circle'}</span>
                </div>
                <div class="list-icon"></div>
                <div class="list-name" title="Sort by Name" @click=${() => this._changeSort('name')}>
                    Name ${renderSortIcon('name')}
                </div>
                <div class="list-metadata" title="Sort by Size" @click=${() => this._changeSort('size')}>
                    Size ${renderSortIcon('size')}
                </div>
                <div class="list-metadata" title="Sort by Modified Date" @click=${() => this._changeSort('modified')}>
                    Modified ${renderSortIcon('modified')}
                </div>
            </div>
        `;
    }

    _renderRow(file, index) {
        const fullPath = this._fullPath(file);
        const isSelected = this.selectedPaths.has(fullPath);
        const { icon, color } = getFileIcon(file.name, file.is_dir);
        const cutClass = this._cutPaths?.has(fullPath) ? 'cut-pending' : '';
        const machine = getActiveMachine();
        const machineName = machine?.name || 'Self';
        const pinned = file.is_dir && isFavorite(machineName, fullPath);
        const displayName = (this.searchMode === 'api' && file.path) ? file.path : file.name;
        
        return html`
            <li class="list-row ${isSelected ? 'selected' : ''} ${cutClass}"
                 tabindex="0"
                 data-index="${index}"
                 data-name="${file.name}"
                 draggable="true"
                 @click=${(e) => this._handleItemClick(e, file, index)}
                 @dblclick=${(e) => this._handleItemDblClick(e, file)}
                 @contextmenu=${(e) => this._handleContextMenu(e, file)}
                 @dragstart=${(e) => this._handleItemDragStart(e, file)}
                 @dragover=${(e) => this._handleItemDragOver(e, file)}
                 @dragleave=${(e) => this._handleItemDragLeave(e, file)}
                 @drop=${(e) => this._handleItemDrop(e, file)}
                 @dragend=${(e) => this._handleItemDragEnd(e)}>
                
                <div class="list-checkbox">
                    <span class="icon icon-sm checkbox">${isSelected ? 'check_circle' : 'circle'}</span>
                </div>
                <div class="list-icon">
                    ${!file.is_dir && hasThumbnail(file.name)
                           ? html`<img class="list-thumb-img" src="${getActiveClient().thumbURL(fullPath)}" loading="lazy" crossorigin=${getActiveClient().isSelf ? undefined : "use-credentials"} alt="" @error=${(e) => this._handleThumbError(e)}>
                               <span class="icon" style="display:none; color: ${color}">${icon}</span>`
                        : html`<span class="icon ${file.is_dir ? 'icon-filled' : ''}" style="color: ${color}">${icon}</span>`
                    }
                </div>
                <div class="list-name ${this.searchMode === 'api' ? 'search-result-path' : ''}">
                    ${file._isRenaming 
                        ? html`<input class="rename-input new-item-name" 
                                      type="text"
                                      autocomplete="off"
                                      .value=${file.name} 
                                      @click=${e => e.stopPropagation()} 
                                      @keydown=${e => this._handleRenameKey(e, file)}
                                      @blur=${e => this._submitRename(file, e.target.value)}>` 
                        : displayName
                    }
                    ${file.is_dir ? html`<span class="icon icon-sm pin-button ${pinned ? 'pinned' : ''}" title="${pinned ? 'Unpin from Sidebar' : 'Pin to Sidebar'}" @click=${(e) => this._handlePinClick(e, file, fullPath)}>kid_star</span>` : ''}
                </div>
                <div class="list-metadata">${formatSize(file.size)}</div>
                <div class="list-metadata">${this._formatModified(file.modified)}</div>
            </li>
        `;
    }

    _renderNewItemRow() {
        const { icon, color } = getFileIcon('', this.newItem.type === 'folder');
        return html`
            <li class="list-row selected">
                <div class="list-checkbox"><span class="icon icon-sm checkbox">check_circle</span></div>
                <div class="list-icon"><span class="icon ${this.newItem.type === 'folder' ? 'icon-filled' : ''}" style="color: ${color}">${icon}</span></div>
                <div class="list-name">
                    <input class="new-item-input new-item-name" 
                           type="text"
                           autocomplete="off"
                           placeholder="New ${this.newItem.type}"
                           @click=${e => e.stopPropagation()}
                           @keydown=${e => this._handleNewItemKey(e)}
                           @blur=${e => this._submitNewItem(e.target.value)}>
                </div>
                <div class="list-metadata">-</div>
                <div class="list-metadata">-</div>
            </li>
        `;
    }

    _renderCard(file, index) {
        const fullPath = this._fullPath(file);
        const isSelected = this.selectedPaths.has(fullPath);
        const { icon, color } = getFileIcon(file.name, file.is_dir);
        const cutClass = this._cutPaths?.has(fullPath) ? 'cut-pending' : '';
        const machine = getActiveMachine();
        const machineName = machine?.name || 'Self';
        const pinned = file.is_dir && isFavorite(machineName, fullPath);
        
        return html`
            <div class="grid-card ${isSelected ? 'selected' : ''} ${cutClass}"
                 tabindex="0"
                 data-index="${index}"
                 draggable="true"
                 @click=${(e) => this._handleItemClick(e, file, index)}
                 @dblclick=${(e) => this._handleItemDblClick(e, file)}
                 @dragstart=${(e) => this._handleItemDragStart(e, file)}
                 @dragover=${(e) => this._handleItemDragOver(e, file)}
                 @dragleave=${(e) => this._handleItemDragLeave(e, file)}
                 @drop=${(e) => this._handleItemDrop(e, file)}
                 @dragend=${(e) => this._handleItemDragEnd(e)}>
                 
                <div class="grid-icon">
                    ${!file.is_dir && hasThumbnail(file.name)
                           ? html`<img class="grid-thumb-img" src="${getActiveClient().thumbURL(fullPath)}" loading="lazy" crossorigin=${getActiveClient().isSelf ? undefined : "use-credentials"} alt="" @error=${(e) => this._handleThumbError(e)}>
                               <span class="icon icon-thumb" style="display:none; color: ${color};">${icon}</span>`
                        : html`<span class="icon ${file.is_dir ? 'icon-filled' : ''} icon-thumb" style="color: ${color};">${icon}</span>`
                    }
                </div>
                <div class="grid-info">
                    <div class="grid-name">
                         ${file._isRenaming 
                            ? html`<input class="rename-input new-item-name" 
                                      type="text"
                                      autocomplete="off"
                                      .value=${file.name} 
                                      @click=${e => e.stopPropagation()} 
                                      @keydown=${e => this._handleRenameKey(e, file)}
                                      @blur=${e => this._submitRename(file, e.target.value)}>` 
                            : file.name
                        }
                    </div>
                    <div class="grid-metadata">${formatSize(file.size)}</div>
                    <div class="grid-metadata">${this._formatModified(file.modified)}</div>
                </div>
                ${file.is_dir ? html`<span class="icon icon-sm pin-button ${pinned ? 'pinned' : ''}" title="${pinned ? 'Unpin from Sidebar' : 'Pin to Sidebar'}" @click=${(e) => this._handlePinClick(e, file, fullPath)}>kid_star</span>` : ''}
                <span class="icon icon-sm checkbox">${isSelected ? 'check_circle' : 'circle'}</span>
            </div>
        `;
    }

    _renderNewItemCard() {
         const { icon, color } = getFileIcon('', this.newItem.type === 'folder');
         return html`
            <div class="grid-card selected">
                <div class="grid-icon">
                    <span class="icon ${this.newItem.type === 'folder' ? 'icon-filled' : ''} icon-thumb" style="color: ${color};">${icon}</span>
                </div>
                <div class="grid-info">
                    <div class="grid-name">
                         <input class="new-item-input new-item-name" 
                           type="text"
                           autocomplete="off"
                           placeholder="New ${this.newItem.type}"
                           @click=${e => e.stopPropagation()}
                           @keydown=${e => this._handleNewItemKey(e)}
                           @blur=${e => this._submitNewItem(e.target.value)}>
                    </div>
                    <div class="grid-metadata">-</div>
                    <div class="grid-metadata">-</div>
                </div>
                ${this.newItem.type === 'folder' ? html`<span class="icon icon-sm pin-button">kid_star</span>` : ''}
                <span class="icon icon-sm checkbox">check_circle</span>
            </div>
         `;
    }

    _renderThumbCard(file, index) {
        const fullPath = this._fullPath(file);
        const isSelected = this.selectedPaths.has(fullPath);
        const { icon, color } = getFileIcon(file.name, file.is_dir);
        const cutClass = this._cutPaths?.has(fullPath) ? 'cut-pending' : '';
        const machine = getActiveMachine();
        const machineName = machine?.name || 'Self';
        const pinned = file.is_dir && isFavorite(machineName, fullPath);
        const eligible = !file.is_dir && hasThumbnail(file.name);
        
        return html`
            <div class="thumb-card ${isSelected ? 'selected' : ''} ${cutClass}"
                 tabindex="0"
                 data-index="${index}"
                 draggable="true"
                 @click=${(e) => this._handleItemClick(e, file, index)}
                 @dblclick=${(e) => this._handleItemDblClick(e, file)}
                 @contextmenu=${(e) => this._handleContextMenu(e, file)}
                 @dragstart=${(e) => this._handleItemDragStart(e, file)}
                 @dragover=${(e) => this._handleItemDragOver(e, file)}
                 @dragleave=${(e) => this._handleItemDragLeave(e, file)}
                 @drop=${(e) => this._handleItemDrop(e, file)}
                 @dragend=${(e) => this._handleItemDragEnd(e)}>
                <div class="thumb-image ${eligible ? '' : 'thumb-icon-only'}">
                    ${eligible
                           ? html`<img src="${getActiveClient().thumbURL(fullPath)}" loading="lazy" crossorigin=${getActiveClient().isSelf ? undefined : "use-credentials"} alt="" @error=${(e) => this._handleThumbError(e)}>
                               <span class="icon icon-filled icon-thumb-lg thumb-fallback" style="display:none; color:${color};">${icon}</span>`
                        : html`<span class="icon ${file.is_dir ? 'icon-filled' : ''} icon-thumb-lg" style="color: ${color};">${icon}</span>`
                    }
                </div>
                <div class="thumb-name-overlay">
                    ${file._isRenaming 
                        ? html`<input class="rename-input new-item-name" 
                                      type="text"
                                      autocomplete="off"
                                      .value=${file.name} 
                                      @click=${e => e.stopPropagation()} 
                                      @keydown=${e => this._handleRenameKey(e, file)}
                                      @blur=${e => this._submitRename(file, e.target.value)}>` 
                        : file.name
                    }
                </div>
                ${file.is_dir ? html`<span class="icon icon-sm pin-button ${pinned ? 'pinned' : ''}" title="${pinned ? 'Unpin from Sidebar' : 'Pin to Sidebar'}" @click=${(e) => this._handlePinClick(e, file, fullPath)}>kid_star</span>` : ''}
            </div>
        `;
    }

    _renderNewItemThumbCard() {
        const { icon, color } = getFileIcon('', this.newItem.type === 'folder');
        return html`
            <div class="thumb-card selected">
                <div class="thumb-image thumb-icon-only">
                    <span class="icon ${this.newItem.type === 'folder' ? 'icon-filled' : ''} icon-thumb-lg" style="color: ${color};">${icon}</span>
                </div>
                <div class="thumb-name-overlay">
                    <input class="new-item-input new-item-name" 
                           type="text"
                           autocomplete="off"
                           placeholder="New ${this.newItem.type}"
                           @click=${e => e.stopPropagation()}
                           @keydown=${e => this._handleNewItemKey(e)}
                           @blur=${e => this._submitNewItem(e.target.value)}>
                </div>
                ${this.newItem.type === 'folder' ? html`<span class="icon icon-sm pin-button">kid_star</span>` : ''}
            </div>
        `;
    }

    _handleThumbError(e) {
        const img = e.target;
        img.style.display = 'none';
        const fallback = img.nextElementSibling;
        if (fallback) fallback.style.display = '';
    }

    /* --- Interaction Handlers --- */

    _handleItemClick(e, file, index) {
        e.stopPropagation(); // Prevent background click clearing
        const fullPath = this._fullPath(file);

        if (e.ctrlKey || e.metaKey) {
            // Toggle
            if (this.selectedPaths.has(fullPath)) {
                this.selectedPaths.delete(fullPath);
            } else {
                this.selectedPaths.add(fullPath);
                this.lastSelectedPath = index;
            }
        } else if (e.shiftKey && this.lastSelectedPath !== null) {
            // Range — #6: operate over the DISPLAYED list, not this.files, so a
            // range selection only spans visible items during a search/filter.
            const display = this._displayFiles;
            const start = Math.min(this.lastSelectedPath, index);
            const end = Math.max(this.lastSelectedPath, index);
            this.selectedPaths.clear();
            for (let i = start; i <= end; i++) {
                this.selectedPaths.add(this._fullPath(display[i]));
            }
        } else {
            // Single select
            this.selectedPaths.clear();
            this.selectedPaths.add(fullPath);
            this.lastSelectedPath = index;
        }
        this.requestUpdate();
        this._emitSelectionChange();
    }

    _handleBackgroundClick(e) {
        // Clear selection if clicked on empty space (works for both list and grid containers)
        if (e.target === e.currentTarget) {
            this.selectedPaths.clear();
            this.lastSelectedPath = null;
            this._cancelRename(); // Also cancel any active stuff
            this.requestUpdate();
            this._emitSelectionChange();
            // Keep focus within the file browser so keyboard shortcuts remain active
            e.currentTarget.focus();
        }
    }

    _handleItemDblClick(e, file) {
        e.stopPropagation();
        // #17: _fullPath resolves '/name' at root (not '//name') and uses the
        // absolute path from search results when in API search mode.
        const fullPath = this._fullPath(file);
        if (file.is_dir) {
            if (this.searchMode) this.clearSearch();
            this.dispatchEvent(new CustomEvent('navigate', { detail: { path: fullPath } }));
        } else {
            this.dispatchEvent(new CustomEvent('open-file', { detail: { file, path: fullPath } }));
        }
    }

    _handleKeyDown(e) {
        // Defensive guard: don't process keys when overlay viewer is open
        if (document.querySelector('overlay-viewer')?._visible) return;

        // Handle global keys when container or item is focused
        // Arrow navigation could be implemented natively by browser focus, but typically needs logic
        
        switch (e.key) {
            case 'Delete':
                this._deleteSelected();
                break;
            case 'F2':
                if (this.selectedPaths.size === 1) {
                    this._startRename(Array.from(this.selectedPaths)[0]);
                }
                break;
            case 'a':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this._toggleSelectAll(true);
                }
                break;
            case 'c':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this._dispatchClipboardEvent('copy');
                }
                break;
            case 'x':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this._dispatchClipboardEvent('cut');
                }
                break;
            case 'v':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this._dispatchClipboardEvent('paste');
                }
                break;
            case 'Enter':
                if (this.selectedPaths.size === 1) {
                    const fullPath = Array.from(this.selectedPaths)[0];
                    const file = this._displayFiles.find(f => this._fullPath(f) === fullPath);
                    if (file) this._handleItemDblClick(e, file);
                }
                break;
            case 'ArrowDown':
                e.preventDefault();
                this._navigateSelection(1, e.shiftKey);
                break;
            case 'ArrowRight':
                e.preventDefault();
                this._navigateSelection(1, e.shiftKey);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this._navigateSelection(-1, e.shiftKey);
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this._navigateSelection(-1, e.shiftKey);
                break;
            case 'Home':
                e.preventDefault();
                this._jumpToEdge('first', e.shiftKey);
                break;
            case 'End':
                e.preventDefault();
                this._jumpToEdge('last', e.shiftKey);
                break;
            case 'Backspace':
                e.preventDefault();
                this._navigateUp();
                break;
        }
    }
    
    /**
     * Dispatch clipboard event to parent for handling
     */
    _dispatchClipboardEvent(operation) {
        this.dispatchEvent(new CustomEvent('clipboard-action', { 
            bubbles: true, 
            composed: true, 
            detail: { operation } 
        }));
    }
    
    /**
     * Navigate selection up or down
     * @param {number} direction - 1 for down, -1 for up
     * @param {boolean} extendSelection - Whether to extend selection (Shift key)
     */
    _navigateSelection(direction, extendSelection) {
        // #6: navigate within the DISPLAYED list, not this.files, so arrow keys
        // only reach visible items during a search/filter.
        const display = this._displayFiles;
        if (display.length === 0) return;

        // Get current index
        let currentIndex = -1;
        if (this.lastSelectedPath !== null) {
            currentIndex = this.lastSelectedPath;
        } else if (this.selectedPaths.size > 0) {
            const lastPath = Array.from(this.selectedPaths).pop();
            currentIndex = display.findIndex(f => this._fullPath(f) === lastPath);
        }

        // Calculate new index
        let newIndex;
        if (currentIndex === -1) {
            newIndex = direction === 1 ? 0 : display.length - 1;
        } else {
            newIndex = Math.max(0, Math.min(display.length - 1, currentIndex + direction));
        }

        const newFile = display[newIndex];
        const newFullPath = this._fullPath(newFile);

        if (extendSelection && this.lastSelectedPath !== null) {
            // Extend selection range
            const start = Math.min(this.lastSelectedPath, newIndex);
            const end = Math.max(this.lastSelectedPath, newIndex);
            // Keep anchor, extend range
            for (let i = start; i <= end; i++) {
                this.selectedPaths.add(this._fullPath(display[i]));
            }
        } else {
            // Single select
            this.selectedPaths.clear();
            this.selectedPaths.add(newFullPath);
            this.lastSelectedPath = newIndex;
        }

        this.requestUpdate();
        this._emitSelectionChange();

        // Scroll into view
        this._scrollToIndex(newIndex);
    }

    /**
     * Jump to first or last item
     */
    _jumpToEdge(edge, extendSelection) {
        // #6: edges are over the DISPLAYED list.
        const display = this._displayFiles;
        if (display.length === 0) return;

        const targetIndex = edge === 'first' ? 0 : display.length - 1;
        const targetFile = display[targetIndex];
        const targetFullPath = this._fullPath(targetFile);

        if (extendSelection && this.lastSelectedPath !== null) {
            const start = Math.min(this.lastSelectedPath, targetIndex);
            const end = Math.max(this.lastSelectedPath, targetIndex);
            for (let i = start; i <= end; i++) {
                this.selectedPaths.add(this._fullPath(display[i]));
            }
        } else {
            this.selectedPaths.clear();
            this.selectedPaths.add(targetFullPath);
            this.lastSelectedPath = targetIndex;
        }

        this.requestUpdate();
        this._emitSelectionChange();
        this._scrollToIndex(targetIndex);
    }

    /**
     * Navigate to parent directory. #20: shares the parentPath root guard with
     * file-browser-logic.navigateUp.
     */
    _navigateUp() {
        const rootDir = getSession(getActiveMachineId())?.connection?.rootDir || null;
        const next = parentPath(this.currentPath, rootDir);
        if (next === null) return; // already at root / jail root
        this.dispatchEvent(new CustomEvent('navigate', { detail: { path: next } }));
    }
    
    /**
     * Scroll a file item into view
     */
    _scrollToIndex(index) {
        requestAnimationFrame(() => {
            const item = this.querySelector(`[data-index="${index}"]`);
            if (item) {
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                item.focus();
            }
        });
    }

    /* --- Actions --- */
    
    async startCreation(type) {
        this.newItem = { type, name: '' };
        this.requestUpdate();
        this._focusInlineInput('.new-item-input');
    }
    
    /**
     * Mark items as cut (visual feedback). #18: store full cut paths and match
     * by full path in render — do NOT mutate file objects, and do not match by
     * basename (which would mis-mark same-named files in different dirs during
     * a search).
     * @param {Array<string>} paths - Full paths of cut items
     */
    markCutItems(paths) {
        this._cutPaths = new Set(paths || []);
        this.requestUpdate();
    }

    /**
     * Clear cut visual markers from all items.
     */
    clearCutMarkers() {
        this._cutPaths = null;
        this.requestUpdate();
    }
    
    async _submitNewItem(name) {
        if (!this.newItem) return;
        
        const type = this.newItem.type;
        this.newItem = null; // Clear immediately
        
        if (!name || name.trim() === '') {
            this.requestUpdate();
            return; 
        }

        try {
            const targetPath = this.currentPath === '/' ? `/${name}` : `${this.currentPath}/${name}`;
            if (type === 'folder') {
                await getActiveClient().mkdir(targetPath);
            } else {
                const emptyFile = new File([""], name, { type: "text/plain;charset=utf-8" });
                await getActiveClient().upload(this.currentPath, [emptyFile]);
            }
            this.loadFiles();
        } catch (err) {
            showToast(err.message, 'error');
            this.requestUpdate();
        }
    }

    _handleNewItemKey(e) {
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.target.blur(); // Triggers _submitNewItem
        } else if (e.key === 'Escape') {
            this.newItem = null;
            this.requestUpdate();
        }
    }

    async _startRename(fileName) {
        // Search the DISPLAYED list so rename works in API-search mode too.
        const file = this._displayFiles.find(f => f.name === fileName || this._fullPath(f) === fileName);
        if (file) {
            file._isRenaming = true;
            this.requestUpdate();
            this._focusInlineInput('.rename-input');
        }
    }

    _cancelRename() {
        this._displayFiles.forEach(f => f._isRenaming = false);
        this.newItem = null;
    }

    async _submitRename(file, newName) {
        if (this._renameCancelSet.has(file.name)) {
            this._renameCancelSet.delete(file.name);
            file._isRenaming = false;
            this.requestUpdate();
            return;
        }

        file._isRenaming = false;
        if (newName && newName !== file.name) {
             try {
                const oldPath = this.currentPath === '/' ? `/${file.name}` : `${this.currentPath}/${file.name}`;
                const newPath = this.currentPath === '/' ? `/${newName}` : `${this.currentPath}/${newName}`;
                await getActiveClient().rename(oldPath, newPath);
                this.loadFiles();
            } catch (err) {
                showToast(err.message, 'error');
                this.requestUpdate(); // redraw original name
            }
        } else {
            this.requestUpdate();
        }
    }

    _handleRenameKey(e, file) {
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.target.blur();
        } else if (e.key === 'Escape') {
            this._renameCancelSet.add(file.name);
            file._isRenaming = false;
            this.requestUpdate();
        }
    }

    async _deleteSelected() {
        if (this.selectedPaths.size === 0) return;
        
        const confirmed = await showConfirmDialog('Delete?', `Delete ${this.selectedPaths.size} item(s)?`);
        if (!confirmed) return;
        
        const paths = Array.from(this.selectedPaths);
        
        try {
            await getActiveClient().remove(paths);
            this.selectedPaths.clear();
            this.loadFiles();
             showToast('Items deleted', 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    _toggleSelectAll(forceState) {
        const display = this._displayFiles;
        if (forceState === true || this.selectedPaths.size < display.length) {
            display.forEach(f => this.selectedPaths.add(this._fullPath(f)));
        } else {
            this.selectedPaths.clear();
        }
        this.requestUpdate();
        this._emitSelectionChange();
    }

    _changeSort(field) {
        if (this.sortField === field) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortDirection = 'asc';
        }
        // Persist the sort to the active session slice and keep slice.files
        // sorted by the current key (invariant: slice.files is sorted by
        // slice.sortBy/sortOrder, so a switch-back renders already-sorted files).
        const id = getActiveMachineId();
        const sorted = this._sortFiles(this.files);
        setSort(id, this.sortField, this.sortDirection);
        setFiles(id, sorted);
        this.files = sorted;
        this.requestUpdate();
    }
    
    /* --- Helpers --- */
    
    _emitSelectionChange() {
        // Push selection to the active session's browser slice (D3 — per-machine
        // selection). The legacy selection event was removed (D6); app.js
        // subscribes to the store to update the menu bar / breadcrumbs.
        setSelection(getActiveMachineId(), new Set(this.selectedPaths));
    }

    async _focusInlineInput(selector) {
        await this.updateComplete;
        requestAnimationFrame(() => {
            const vm = this._effectiveViewMode;
            const containerClass = vm === 'grid' ? '.file-grid-box'
                : vm === 'thumb' ? '.file-thumb-box'
                : '.file-list-box';
            const container = this.querySelector(containerClass);
            container?.querySelector(selector)?.focus();
        });
    }

    _formatModified(timestamp) {
        if (!timestamp) return '-';
        const date = new Date(timestamp * 1000);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}/${month}/${day}, ${hours}:${minutes}`;
    }
    
    /* --- Drag & Drop --- */
    _handleDragOver(e) {
        e.preventDefault();
        e.currentTarget.classList.add('drag-over');
    }

    _handleDragLeave(e) {
        e.currentTarget.classList.remove('drag-over');
    }

    _handleDrop(e) {
        e.preventDefault();
        e.stopPropagation(); // Prevent bubbling to parent elements
        e.currentTarget.classList.remove('drag-over');

        // Internal file move: check for custom MIME type first
        if (e.dataTransfer.types.includes('application/x-sidecar-paths')) {
            const json = e.dataTransfer.getData('application/x-sidecar-paths');
            if (json) {
                try {
                    const paths = JSON.parse(json);
                    this.dispatchEvent(new CustomEvent('internal-move', {
                        detail: { paths, destDir: this.currentPath }
                    }));
                } catch (_) { /* malformed drag data — ignore */ }
            }
            return;
        }

        // External OS file upload
        const items = e.dataTransfer.items;
        if (items) {
             this.dispatchEvent(new CustomEvent('upload-drop', { detail: { items } }));
        }
    }

    /* --- Internal Drag & Drop (file move) --- */

    _handleItemDragStart(e, file) {
        const fullPath = this._fullPath(file);
        // Drag selected item → drag the whole selection; else drag just this item.
        // Zero state mutation: no selectedPaths changes, no requestUpdate().
        // dataTransfer carries paths — drop handler reads dataTransfer, not selectedPaths.
        // This avoids DOM rebuild during dragstart which can cancel the drag in some engines.
        const paths = this.selectedPaths.has(fullPath)
            ? Array.from(this.selectedPaths)
            : [fullPath];
        e.dataTransfer.setData('application/x-sidecar-paths', JSON.stringify(paths));
        e.dataTransfer.effectAllowed = 'move';
        e.stopPropagation();
    }

    _handleItemDragOver(e, file) {
        if (!file.is_dir) return;
        if (!e.dataTransfer.types.includes('application/x-sidecar-paths')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        e.currentTarget.classList.add('drag-target');
    }

    _handleItemDragLeave(e, file) {
        if (!file.is_dir) return;
        e.currentTarget.classList.remove('drag-target');
    }

    _handleItemDrop(e, file) {
        if (!file.is_dir) return;
        if (!e.dataTransfer.types.includes('application/x-sidecar-paths')) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.remove('drag-target');

        const json = e.dataTransfer.getData('application/x-sidecar-paths');
        if (!json) return;
        try {
            const paths = JSON.parse(json);
            const destDir = this._fullPath(file);
            // Don't drop on itself or on a child of itself
            const filtered = paths.filter(p => {
                if (p === destDir) return false; // can't move onto itself
                if (destDir.startsWith(p + '/')) return false; // can't move into own child
                return true;
            });
            if (filtered.length === 0) return;
            this.dispatchEvent(new CustomEvent('internal-move', {
                detail: { paths: filtered, destDir }
            }));
        } catch (_) { /* malformed drag data — ignore */ }
    }

    _handleItemDragEnd(e) {
        // Clean up any lingering drag-target highlights
        this.querySelectorAll('.drag-target').forEach(el => el.classList.remove('drag-target'));
    }

    _handleContextMenu(e, file) {
        // Placeholder for context menu
        // e.preventDefault();
    }

    /**
     * Handle pin/unpin click on a directory's star icon.
     * Toggles favorite state and re-renders.
     */
    _handlePinClick(e, file, fullPath) {
        e.stopPropagation();
        e.preventDefault();
        const machine = getActiveMachine();
        const machineName = machine?.name || 'Self';
        if (isFavorite(machineName, fullPath)) {
            removeFavorite(machineName, fullPath);
        } else {
            addFavorite(machineName, fullPath, file.name);
        }
        // (D6) legacy favorites event removed; refresh pin state locally.
        this.requestUpdate();
    }
}

customElements.define('file-browser', FileBrowser);
