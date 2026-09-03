/**
 * Tab Manager (Phase 3 rewrite)
 *
 * Workspace is global (D2): `workspace.openTabs` holds editor/terminal tabs
 * ONLY, each carrying its own `machineId`; the File Browser is a singleton pane
 * re-rendered from the active session (NOT a tab). `activeTabId ∈ openTabs ∪
 * {'files'}`. Tab shape:
 *   { id, type, machineId, label,
 *     editor?:   { path, isNew, editorId },
 *     terminal?: { terminalId, ptyNo } }
 * Live objects (Monaco models / WebSocket PTYs) stay in editor.js / terminal.js
 * keyed by id; tabs hold ids only. Rendered XSS-safe via createElement/
 * textContent (#2). Switching machine dispatches `activeMachineId/set` only -
 * tabs are untouched (D7).
 */

import { createTerminal, destroyTerminal } from './terminal.js';
import { createEditor, destroyEditor, saveEditor, isEditorDirty, setEditorReadOnly, isEditorReadOnly } from './editor.js';
import { store } from '../utils/store.js';
import { getActiveMachineId, nextPtyNo } from '../utils/session-manager.js';
import { findMachineById } from '../utils/config.js';
import { debug } from '../utils/debug.js';
import { showConfirmDialog } from '../utils/ui.js';
import { EDITOR_OPEN_MAX_BYTES, editorOpenAllowed, notifyEditorOpenRefused } from '../utils/editor-open-gate.js';

// #25: single read-only regex. A file is editable by default only for these
// extensions; everything else opens read-only (toggle to edit).
const EDITABLE_EXTENSIONS = /\.(md|markdown|html?|xhtml)$/i;
function isReadOnlyPath(path, isNew) {
    if (!path || isNew) return false;
    return !EDITABLE_EXTENSIONS.test(path);
}

let tabIdCounter = 0;
let tabListenersInitialized = false;
// Race guard: tabs whose live object is mid-creation. (Initialized-ness is
// derived from tab.editor.editorId / tab.terminal.terminalId presence, so this
// Set only guards the async creation window.)
const _initializing = new Set();

/** Resolve a machineId to its display name (Self -> 'Self'). */
function machineIdToName(machineId) {
    return findMachineById(machineId)?.name ?? 'Self';
}

/**
 * Initialize Tab Manager: wire store subscriptions + the dock click delegate,
 * then render the initial state.
 */
export function initTabManager() {
    // openTabs changed -> rebuild the dynamic tab buttons.
    store.subscribeSelect(
        (s) => s.workspace.openTabs,
        (tabs) => renderTabs(tabs),
    );
    // activeTabId changed -> update active classes, show workspace, lazy-load.
    store.subscribeSelect(
        (s) => s.workspace.activeTabId,
        (id) => onActiveTabChanged(id),
    );
    // activeMachineId changed -> relabel the Files dock entry (D2).
    store.subscribeSelect(
        (s) => s.activeMachineId,
        (id) => updateFilesDockLabel(id),
    );

    setupTabListeners();

    // subscribeSelect does not fire for the initial value - render explicitly.
    const { workspace } = store.getState();
    updateFilesDockLabel(store.getState().activeMachineId);
    renderTabs(workspace.openTabs);
    onActiveTabChanged(workspace.activeTabId);

    debug.log('🗂️ Tab Manager initialized');
}

/**
 * Render all dynamic tabs from the store. The Files dock entry is static HTML
 * (non-closeable); only its label is updated here. Tab labels use textContent
 * (#2 - a filename may contain HTML).
 */
function renderTabs(tabs) {
    const container = document.querySelector('.tab-dock-outline');
    if (!container) {
        console.error('renderTabs: .tab-dock-outline not found!');
        return;
    }

    const openTabs = tabs || store.getState().workspace.openTabs;
    const activeTabId = store.getState().workspace.activeTabId;

    // Files dock active state (label is owned by updateFilesDockLabel).
    const filesTab = document.getElementById('tab-files');
    if (filesTab) filesTab.classList.toggle('active', activeTabId === 'files');

    // Remove old dynamic tabs (keep the static Files tab).
    container.querySelectorAll('.tab-item:not(#tab-files)').forEach((tab) => tab.remove());

    // Add dynamic tabs (terminal, editor) - built with createElement/textContent.
    for (const tab of openTabs) {
        const isActive = tab.id === activeTabId;
        const iconText = tab.type === 'terminal' ? 'terminal' : 'edit';

        const tabElement = document.createElement('div');
        tabElement.className = `tab-item${isActive ? ' active' : ''}`;
        tabElement.dataset.tabId = tab.id;

        const btn = document.createElement('button');
        btn.className = 'tab';
        const icon = document.createElement('span');
        icon.className = 'icon icon-sm';
        icon.textContent = iconText;
        const text = document.createElement('span');
        text.className = 'tab-text';
        text.textContent = tab.label; // #2: inert text, never parsed as markup
        btn.append(icon, text);

        const close = document.createElement('span');
        close.className = 'tab-close icon icon-sm';
        close.dataset.tabId = tab.id;
        close.textContent = 'cancel';

        tabElement.append(btn, close);
        container.appendChild(tabElement);
    }
}

/**
 * Update the Files dock entry label to show the Material `folder_open` icon
 * followed by the active machine name (D2). The icon span stays visible.
 */
function updateFilesDockLabel(machineId) {
    const filesTab = document.getElementById('tab-files');
    if (!filesTab) return;
    const name = machineIdToName(machineId);
    const textEl = filesTab.querySelector('.tab-text');
    if (textEl) textEl.textContent = name;
    const iconEl = filesTab.querySelector('.icon');
    if (iconEl) {
        iconEl.style.display = '';
        iconEl.textContent = 'folder_open';
    }
}

/**
 * Setup the dock click delegate (bound once): tab select + close.
 */
function setupTabListeners() {
    if (tabListenersInitialized) return;
    const container = document.querySelector('.tab-dock-outline');
    if (!container) return;

    container.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('.tab-close');
        if (closeBtn) {
            e.stopPropagation();
            const tabId = closeBtn.dataset.tabId;
            if (tabId) closeTab(tabId);
            return;
        }
        const tabItem = e.target.closest('.tab-item');
        if (!tabItem) return;
        const tabId = tabItem.dataset.tabId;
        if (tabId) switchTab(tabId);
    });

    tabListenersInitialized = true;
}

/**
 * Switch to a tab (dispatch only; the activeTabId subscription drives UI).
 */
export function switchTab(tabId) {
    const exists = tabId === 'files'
        || store.getState().workspace.openTabs.some((t) => t.id === tabId);
    if (!exists) return;
    store.dispatch('workspace/setActiveTab', tabId);
}

/**
 * Active tab changed: update dock active classes, show the workspace, and
 * lazy-load the terminal/editor on first activation.
 */
function onActiveTabChanged(tabId) {
    document.querySelectorAll('.tab-item').forEach((item) => {
        item.classList.toggle('active', item.dataset.tabId === tabId);
    });
    showWorkspace(tabId);
    initializeWorkspaceContent(tabId);
}

/**
 * Show the workspace for a tab, hide all others.
 */
function showWorkspace(tabId) {
    // Hide every workspace container (static + dynamic).
    document.querySelectorAll('.workspace-container').forEach((ws) => {
        ws.classList.add('workspace-hidden');
        ws.classList.remove('workspace-visible');
    });

    let targetId;
    if (tabId === 'files') {
        targetId = 'workspace-file';
    } else {
        const tab = store.getState().workspace.openTabs.find((t) => t.id === tabId);
        targetId = tab ? `workspace-${tab.type}-${tab.id}` : 'workspace-file';
    }

    const target = document.getElementById(targetId);
    if (target) {
        target.classList.remove('workspace-hidden');
        target.classList.add('workspace-visible');
    } else {
        // Fallback to the Files pane.
        const files = document.getElementById('workspace-file');
        if (files) {
            files.classList.remove('workspace-hidden');
            files.classList.add('workspace-visible');
        }
    }
}

/**
 * Open a new tab (or switch to an existing editor for the same machine+path).
 * @param {string} type - 'terminal' | 'editor' | 'files'
 * @param {object} [options] - { label, path, isNew, machineId }
 * @returns {string} tab ID
 */
export function openTab(type, options = {}) {
    const machineId = options.machineId || getActiveMachineId();
    const machineName = machineIdToName(machineId);

    if (type === 'terminal') {
        // D2.1: multi-terminal - no singleton. Each open creates a new tab with
        // its own ptyNo + WS connection.
        const ptyNo = nextPtyNo(machineId);
        const id = `terminal-${++tabIdCounter}`;
        const tab = {
            id,
            type: 'terminal',
            machineId,
            label: `${machineName}-${ptyNo}`,
            terminal: { terminalId: null, ptyNo },
        };
        createTerminalWorkspace(tab);
        store.dispatch('workspace/openTab', tab);
        return id;
    }

    if (type === 'editor') {
        const path = options.path || null;
        const isNew = !!options.isNew;
        const createEditorTab = () => {
            // Dedup by machineId::path - only for an existing file with a path.
            // A "new file" (no path / isNew) always opens a fresh tab.
            if (path && !isNew) {
                const existing = store.getState().workspace.openTabs.find((t) =>
                    t.type === 'editor' && t.machineId === machineId && t.editor && t.editor.path === path);
                if (existing) {
                    switchTab(existing.id);
                    return existing.id;
                }
            }
            const id = `editor-${++tabIdCounter}`;
            const filename = options.label || (path ? path.split('/').pop() : 'Untitled');
            const tab = {
                id,
                type: 'editor',
                machineId,
                label: filename,
                editor: { path, isNew, editorId: null },
            };
            createEditorWorkspace(tab);
            store.dispatch('workspace/openTab', tab);
            return id;
        };
        // Fail-safe size gate (editor/file-open): decide BEFORE any content
        // fetch. Callers holding the FileEntry pass options.size (sync
        // fast-path); otherwise resolve via a metadata-only listing.
        if (path && !isNew) {
            if (typeof options.size === 'number') {
                if (options.size > EDITOR_OPEN_MAX_BYTES) {
                    notifyEditorOpenRefused(path.split('/').pop(), options.size);
                    return null;
                }
                return createEditorTab();
            }
            editorOpenAllowed({ machineId, path }).then((res) => {
                if (res.allowed) createEditorTab();
                else notifyEditorOpenRefused(path.split('/').pop(), null);
            });
            return null;
        }
        return createEditorTab();
    }

    if (type === 'files') {
        switchTab('files');
        return 'files';
    }

    return null;
}

/**
 * Close a single tab. Destroys its live object + workspace container, then
 * dispatches (the reducer picks the active fallback).
 */
export async function closeTab(tabId) {
    const tab = store.getState().workspace.openTabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Dirty-check editor tabs before closing.
    if (tab.type === 'editor' && tab.editor && tab.editor.editorId && isEditorDirty(tab.editor.editorId)) {
        const confirmed = await showConfirmDialog(
            'Unsaved Changes',
            `File "${tab.label}" has unsaved changes. Close anyway?`,
        );
        if (!confirmed) return;
    }

    destroyTabLiveObject(tab);
    removeWorkspaceElement(tab);

    store.dispatch('workspace/closeTab', tabId);
}

/**
 * Close every tab belonging to machineId (D7/logout). Dirty-check is scoped to
 * that machine's editor tabs; other machines' tabs/terminals survive.
 * @returns {Promise<boolean>} false if the user cancelled the dirty confirm.
 */
export async function closeTabsForMachine(machineId) {
    const tabs = store.getState().workspace.openTabs.filter((t) => t.machineId === machineId);
    if (tabs.length === 0) return true;

    const dirtyEditors = tabs.filter((t) =>
        t.type === 'editor' && t.editor && t.editor.editorId && isEditorDirty(t.editor.editorId));
    if (dirtyEditors.length > 0) {
        const confirmed = await showConfirmDialog(
            'Unsaved Changes',
            `${dirtyEditors.length} unsaved editor(s) on this machine will be closed. Continue?`,
        );
        if (!confirmed) return false;
    }

    for (const tab of tabs) {
        destroyTabLiveObject(tab);
        removeWorkspaceElement(tab);
    }

    // Reducer removes the tabs and falls activeTabId back to 'files' if the
    // active tab belonged to this machine.
    store.dispatch('workspace/closeTabsForMachine', machineId);
    return true;
}

/** Destroy the live object (terminal/editor) a tab owns, if any. */
function destroyTabLiveObject(tab) {
    if (tab.type === 'terminal' && tab.terminal && tab.terminal.terminalId) {
        destroyTerminal(tab.terminal.terminalId);
    } else if (tab.type === 'editor' && tab.editor && tab.editor.editorId) {
        destroyEditor(tab.editor.editorId);
    }
}

/** Remove the tab's workspace container from the DOM. */
function removeWorkspaceElement(tab) {
    const ws = document.getElementById(`workspace-${tab.type}-${tab.id}`);
    if (ws) ws.remove();
}

/**
 * Get the currently active tab (or null for the Files sentinel).
 */
export function getActiveTab() {
    const { workspace } = store.getState();
    return workspace.openTabs.find((t) => t.id === workspace.activeTabId) || null;
}

/**
 * Create the workspace container for an editor tab. #2: built with
 * createElement/textContent so a tainted filename renders as inert text; the
 * header shows `filename @ <machine>`.
 */
function createEditorWorkspace(tab) {
    const main = document.querySelector('.main-panel');
    const tabDock = document.querySelector('.tab-dock');
    if (!main || !tabDock) {
        console.error('createEditorWorkspace: .main-panel/.tab-dock not found');
        return;
    }

    const workspaceId = `workspace-editor-${tab.id}`;
    const editorContentId = `editor-content-${tab.id}`;
    const readOnly = isReadOnlyPath(tab.editor.path, tab.editor.isNew);
    const fullPath = tab.editor.path || tab.label;
    const machineName = machineIdToName(tab.machineId);

    const workspace = document.createElement('div');
    workspace.className = 'workspace-container';
    workspace.id = workspaceId;
    workspace.style.display = 'none';

    const tool = document.createElement('div');
    tool.className = 'tool-container';

    const menuBar = document.createElement('div');
    menuBar.className = 'tool-menu-bar';

    const leading = document.createElement('div');
    leading.className = 'leading-block';
    const pathLabel = document.createElement('span');
    pathLabel.className = 'editor-path-label';
    pathLabel.textContent = `${fullPath} @ ${machineName}`; // full path + machine
    leading.appendChild(pathLabel);

    const trailing = document.createElement('div');
    trailing.className = 'trailing-block';

    const statusMsg = document.createElement('span');
    statusMsg.className = 'editor-status-message';
    statusMsg.setAttribute('aria-live', 'polite');

    const modeBtn = document.createElement('button');
    modeBtn.className = 'editor-mode-toggle';
    modeBtn.title = readOnly ? 'Read-only (Click to Edit)' : 'Edit Mode (Click to Lock)';
    const modeIcon = document.createElement('span');
    modeIcon.className = 'icon';
    modeIcon.textContent = readOnly ? 'edit_off' : 'edit';
    modeBtn.appendChild(modeIcon);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'editor-save';
    saveBtn.title = 'Save (Ctrl+S)';
    if (readOnly) saveBtn.disabled = true;
    const saveIcon = document.createElement('span');
    saveIcon.className = 'icon';
    saveIcon.textContent = 'save';
    saveBtn.appendChild(saveIcon);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'editor-close';
    closeBtn.title = 'Close';
    closeBtn.dataset.tabId = tab.id;
    const closeIcon = document.createElement('span');
    closeIcon.className = 'icon';
    closeIcon.textContent = 'cancel';
    closeBtn.appendChild(closeIcon);
    closeBtn.addEventListener('click', () => closeTab(tab.id));

    trailing.append(statusMsg, modeBtn, saveBtn, closeBtn);
    menuBar.append(leading, trailing);

    const content = document.createElement('div');
    content.className = 'tool-content editor-content';
    content.id = editorContentId;
    content.dataset.tabId = tab.id;
    content.dataset.path = tab.editor.path || '';

    tool.append(menuBar, content);
    workspace.appendChild(tool);

    main.insertBefore(workspace, tabDock);
    debug.log('✅ Editor workspace created:', workspaceId);
}

/**
 * Create the workspace container for a terminal tab (per-tab, D2.1). Header
 * shows `ptyN @ <machine>`; close button wired to closeTab.
 */
function createTerminalWorkspace(tab) {
    const main = document.querySelector('.main-panel');
    const tabDock = document.querySelector('.tab-dock');
    if (!main || !tabDock) {
        console.error('createTerminalWorkspace: .main-panel/.tab-dock not found');
        return;
    }

    const workspaceId = `workspace-terminal-${tab.id}`;
    const contentId = `terminal-content-${tab.id}`;
    const machineName = machineIdToName(tab.machineId);
    const title = `Terminal at ${machineName} - ${tab.terminal.ptyNo}`;

    const workspace = document.createElement('div');
    workspace.className = 'workspace-container';
    workspace.id = workspaceId;
    workspace.style.display = 'none';

    const tool = document.createElement('div');
    tool.className = 'tool-container';

    const menuBar = document.createElement('div');
    menuBar.className = 'tool-menu-bar';

    const leading = document.createElement('div');
    leading.className = 'leading-block';
    const titleEl = document.createElement('span');
    titleEl.className = 'terminal-title';
    titleEl.textContent = title; // #2: inert text
    leading.appendChild(titleEl);

    const trailing = document.createElement('div');
    trailing.className = 'trailing-block';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'terminal-close';
    closeBtn.title = 'Close';
    const closeIcon = document.createElement('span');
    closeIcon.className = 'icon';
    closeIcon.textContent = 'cancel';
    closeBtn.appendChild(closeIcon);
    closeBtn.addEventListener('click', () => closeTab(tab.id));
    trailing.appendChild(closeBtn);

    const content = document.createElement('div');
    content.className = 'tool-content';
    content.id = contentId;

    menuBar.append(leading, trailing);
    tool.append(menuBar, content);
    workspace.appendChild(tool);

    main.insertBefore(workspace, tabDock);
    debug.log('✅ Terminal workspace created:', workspaceId);
}

/**
 * Lazy-load terminal/editor content when a tab is first activated. Idempotent:
 * skips tabs whose live object already exists; the `_initializing` Set guards
 * the async creation window against re-entry.
 */
async function initializeWorkspaceContent(tabId) {
    if (tabId === 'files') return;
    const tab = store.getState().workspace.openTabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Already initialized?
    if (tab.type === 'editor' && tab.editor && tab.editor.editorId) return;
    if (tab.type === 'terminal' && tab.terminal && tab.terminal.terminalId) return;
    if (_initializing.has(tabId)) return;
    _initializing.add(tabId);

    debug.log('Initializing workspace content for:', tabId, tab.type);
    try {
        if (tab.type === 'terminal') {
            const containerId = `terminal-content-${tab.id}`;
            const terminalId = await createTerminal(containerId, {
                machineId: tab.machineId,
                ptyNo: tab.terminal.ptyNo,
            });
            if (terminalId) {
                store.dispatch('workspace/setTerminalId', { tabId, terminalId });
                debug.log('✅ Terminal initialized:', terminalId);
            }
        } else if (tab.type === 'editor') {
            const containerId = `editor-content-${tab.id}`;
            const readOnly = isReadOnlyPath(tab.editor.path, tab.editor.isNew);
            const editorId = await createEditor(containerId, tab.editor.path, {
                machineId: tab.machineId,
                readOnly,
            });
            if (editorId) {
                store.dispatch('workspace/setEditorId', { tabId, editorId });
                wireEditorButtons(tab.id, editorId);
                debug.log('✅ Editor initialized:', editorId);
            } else {
                console.error('Editor failed to initialize for:', tab.id);
            }
        }
    } catch (error) {
        console.error('❌ Failed to initialize workspace content:', error);
    } finally {
        _initializing.delete(tabId);
    }
}

/**
 * Wire the save + read-only toggle buttons for an editor workspace.
 */
function wireEditorButtons(tabId, editorId) {
    const scope = document.getElementById(`workspace-editor-${tabId}`);
    if (!scope) return;

    const saveBtn = scope.querySelector('.editor-save');
    saveBtn?.addEventListener('click', () => saveEditor(editorId));

    const toggleBtn = scope.querySelector('.editor-mode-toggle');
    toggleBtn?.addEventListener('click', () => {
        const nextReadOnly = !isEditorReadOnly(editorId);
        setEditorReadOnly(editorId, nextReadOnly);

        const iconEl = toggleBtn.querySelector('.icon');
        if (iconEl) iconEl.textContent = nextReadOnly ? 'edit_off' : 'edit';
        toggleBtn.title = nextReadOnly ? 'Read-only (Click to Edit)' : 'Edit Mode (Click to Lock)';
        if (saveBtn) saveBtn.disabled = nextReadOnly;

        debug.log(`Editor ${editorId} mode toggled. ReadOnly: ${nextReadOnly}`);
    });
}
