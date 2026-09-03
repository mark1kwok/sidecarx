/**
 * Main Application Entry Point
 * Initializes the app and loads Lit components
 */

import { loadConfigAsync, applyTheme, getActiveMachine, setActiveMachine, loadConfig, saveConfig, getMachines } from './utils/config.js';
import { debug } from './utils/debug.js';
import { showToast, showConfirmDialog } from './utils/ui.js';
import { store } from './utils/store.js';
import { ensureSession, getBrowser, getSession, getActiveMachineId, setPath, setRootDir, markAuth, markAuthExpired, setAuthLoginPromise, resolveAuthLoginPromise, getAuthQueueHead } from './utils/session-manager.js';
import * as sessionManager from './utils/session-manager.js';
import { getMachineClient, setUnauthorizedHandler } from './api/machine-client.js';
import { getMachineId } from './utils/identity.js';
import { abortTransfersForMachine } from './utils/file-ops.js';
import './components/file-browser-logic.js';
import './components/overlay-viewer.js';
import './components/transfer-panel.js';
import { initTabManager, openTab, closeTabsForMachine } from './components/tab-manager.js';
import { initSidebar, refreshSidebarState } from './components/sidebar.js';

const EMPTY_SET = new Set();

let loginOverlayInitialized = false;

/**
 * Initialize application
 */
async function init() {
    debug.log('🚀 Admin Panel starting...');

    // Phase 4: expose the store + sessionManager for supervisor verification.
    window.__sidecar = { store, sessionManager };

    // Phase 5 (D5): the single 401 path -> mark the session expired, then queue
    // re-auth for that machine only. ensureAuth is async + fire-and-forget here
    // (the 401 throws synchronously from the client); it arms a per-session
    // loginPromise so the store-driven overlay surfaces that machine in the FIFO
    // queue. markAuthExpired flips status off 'valid' first so ensureAuth does
    // not short-circuit.
    setUnauthorizedHandler((machineId) => {
        markAuthExpired(machineId);
        // Don't re-queue when user already dismissed (status=expired, no
        // loginPromise). Otherwise repeated 401s (sysStats poll, etc.) arm a
        // new loginPromise every ~10s, making the login box keep popping up
        // after every Escape (CP5b blocked-placeholder loop).
        const auth = getSession(machineId)?.auth;
        if (auth?.status === 'expired' && !auth?.loginPromise) return;
        ensureAuth(machineId).catch(() => { /* never rejects; defensive */ });
    });

    initLoginOverlay();

    // 1. Ensure the Self session, then auth Self (non-dismissible). Self needs no
    //    config — getMachineClient('self') resolves via BASE_PATH.
    ensureSession('self');
    await ensureAuth('self');

    // 2. Load config via the authenticated backend FS API into config.js (the
    //    Phase-1 operational source; store.config is a placeholder for now).
    const config = await loadConfigAsync();
    debug.log('📦 Config loaded:', config);

    applyTheme();

    // 3. Mount components, then init tab manager + sidebar.
    await loadComponents();
    initTabManager();
    await initSidebar();

    setupEventListeners();

    debug.log('✨ Admin Panel ready');
}

/**
 * Load Lit components dynamically
 */
async function loadComponents() {
    debug.log('📦 Loading components...');
    
    // Mount File Browser - replaces static HTML with dynamic Lit component
    const container = document.querySelector('.file-container');
    const existingListBox = document.querySelector('.file-list-box');
    const existingGridBox = document.querySelector('.file-grid-box');
    
    if (container) {
        // Remove static placeholder content
        if (existingListBox) existingListBox.remove();
        if (existingGridBox) existingGridBox.remove();
        
        const browser = document.createElement('file-browser-logic');
        browser.id = 'main-file-browser';
        container.appendChild(browser);
        debug.log('✅ FileBrowser mounted');
    }

    // Mount the global transfer panel (Phase 4 - D4). It self-hides when the
    // queue is empty, so it is harmless on first paint.
    if (!document.querySelector('transfer-panel')) {
        const panel = document.createElement('transfer-panel');
        panel.id = 'main-transfer-panel';
        document.body.appendChild(panel);
        debug.log('✅ TransferPanel mounted');
    }
}

/**
 * Update menu bar button states based on selection and clipboard
 */
function updateMenuBarState() {
    const btn = (action) => document.querySelector(`[data-action="${action}"]`);
    
    const selectedFiles = getBrowser(getActiveMachineId())?.selectedFiles || EMPTY_SET;
    const hasSelection = selectedFiles.size > 0;
    const selectionCount = selectedFiles.size;
    const clipboard = store.getState().clipboard;
    const hasClipboard = !!(clipboard && clipboard.source && clipboard.source.items && clipboard.source.items.length > 0);
    
    // Buttons that require selection
    const selectionBtns = ['download', 'delete', 'copy', 'copy-path', 'cut', 'move-to'];
    selectionBtns.forEach(action => {
        const b = btn(action);
        if (b) b.disabled = !hasSelection;
    });
    
    // Paste requires clipboard
    const pasteBtn = btn('paste');
    if (pasteBtn) pasteBtn.disabled = !hasClipboard;
    
    // Rename requires exactly one selected item
    const renameBtn = btn('rename');
    if (renameBtn) renameBtn.disabled = selectionCount !== 1;
    
    // Edit: single file selection only (not folders)
    const editBtn = btn('edit');
    if (editBtn) {
        let editDisabled = true;
        if (selectionCount === 1) {
            const fileName = Array.from(selectedFiles)[0];
            const innerBrowser = document.querySelector('file-browser');
            const file = innerBrowser?.files?.find(f => f.name === fileName || innerBrowser?._fullPath(f) === fileName);
            if (file && !file.is_dir) editDisabled = false;
        }
        editBtn.disabled = editDisabled;
    }
    
    // Up Level always enabled
    const upBtn = btn('up-level');
    if (upBtn) upBtn.disabled = false;
}

/**
 * Setup global event listeners
 */
function setupEventListeners() {
    const browser = document.getElementById('main-file-browser');
    const btn = (action) => document.querySelector(`[data-action="${action}"]`);
    
    // --- Toolbar Wiring (data-driven) ---
    if (browser) {
        const toolbarActions = {
            'upload':     () => browser.triggerUpload(),
            'new-file':   () => browser.createFile(),
            'new-folder': () => browser.createFolder(),
            'delete':     () => browser.triggerDelete(),
            'download':   () => browser.triggerDownload(),
            'copy':       () => browser.triggerCopy(),
            'copy-path':  () => browser.triggerCopyPath(),
            'cut':        () => browser.triggerCut(),
            'paste':      () => browser.triggerPaste(),
            'rename':     () => browser.triggerRename(),
            'move-to':    () => browser.triggerMoveTo(),
            'up-level':   () => browser.navigateUp(),
        };
        
        Object.entries(toolbarActions).forEach(([action, handler]) => {
            btn(action)?.addEventListener('click', handler);
        });
        
        // Edit (needs extra logic for folder check)
        btn('edit')?.addEventListener('click', () => {
            const selectedFiles = getBrowser(getActiveMachineId())?.selectedFiles || EMPTY_SET;
            if (selectedFiles && selectedFiles.size === 1) {
                const fileName = Array.from(selectedFiles)[0];
                const innerBrowser = browser.querySelector('file-browser');
                const file = innerBrowser?.files?.find(f => f.name === fileName || innerBrowser?._fullPath(f) === fileName);
                if (file && file.is_dir) {
                    showToast('Cannot edit a folder', 'warning');
                } else {
                    const path = fileName;
                    const label = fileName.split('/').pop() || fileName;
                    openTab('editor', { label: label, path: path, size: file?.size });
                }
            }
        });
        
        // View mode toggle — cycles list → grid → thumb
        const VIEW_CYCLE = ['list', 'grid', 'thumb'];
        const VIEW_ICONS = { list: 'view_list', grid: 'widget_small', thumb: 'grid_view' };
        const viewToggleBtn = btn('view-toggle');
        viewToggleBtn?.addEventListener('click', () => {
            const current = getBrowser(getActiveMachineId())?.viewMode || 'list';
            const next = VIEW_CYCLE[(VIEW_CYCLE.indexOf(current) + 1) % VIEW_CYCLE.length];
            browser.setViewMode(next);
            viewToggleBtn.querySelector('.icon').textContent = VIEW_ICONS[next];
        });
    }
    
    // --- Breadcrumbs ---
    if (browser) {
        // Legacy path/selection/clipboard events removed (D6); breadcrumbs + the
        // menu bar now follow the active session's state in the store.
        browser.addEventListener('app-open-file', (e) => {
            const { path, name, size } = e.detail;
            openTab('editor', { label: name, path: path, size: size });
        });

        store.subscribeSelect(
            (s) => s.sessions.get(s.activeMachineId)?.browser.currentPath,
            (path) => { updateBreadcrumbs(path); updateMenuBarState(); }
        );
        store.subscribeSelect(
            (s) => s.sessions.get(s.activeMachineId)?.browser.selectedFiles,
            () => updateMenuBarState()
        );
        store.subscribeSelect(
            (s) => s.clipboard,
            () => updateMenuBarState()
        );

        updateBreadcrumbs(browser.currentPath);
    }
    
    updateMenuBarState();

    // --- Search Input Wiring ---
    const searchInput = document.querySelector('.search-input');
    const searchBox = document.querySelector('.searchbox');
    const searchClearBtn = document.querySelector('.search-clear');
    if (searchInput && browser) {
        const innerBrowser = () => browser.querySelector('file-browser');
        let _searchDebounce = null;

        // 7.1 — Debounced client-side filter on input
        searchInput.addEventListener('input', () => {
            const query = searchInput.value;
            // 7.5 — Toggle search-active class
            if (searchBox) searchBox.classList.toggle('search-active', query.length > 0);
            clearTimeout(_searchDebounce);
            _searchDebounce = setTimeout(() => {
                const fb = innerBrowser();
                if (fb) fb.applyClientFilter(query);
            }, 150);
        });

        // 7.2 + 7.3 — Enter triggers API search, Escape clears
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const query = searchInput.value.trim();
                if (query) {
                    const fb = innerBrowser();
                    if (fb) fb.executeSearch(query);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                if (searchInput.value) {
                    searchInput.value = '';
                    if (searchBox) searchBox.classList.remove('search-active');
                    const fb = innerBrowser();
                    if (fb) fb.clearSearch();
                } else {
                    searchInput.blur();
                }
            }
        });

        // 7.4 — Clear button click
        if (searchClearBtn) {
            searchClearBtn.addEventListener('click', () => {
                searchInput.value = '';
                if (searchBox) searchBox.classList.remove('search-active');
                const fb = innerBrowser();
                if (fb) fb.clearSearch();
                searchInput.focus();
            });
        }
    }

    // Theme toggle
    const themeToggle = document.querySelector('.theme-toggle');
    const themeIcon = document.getElementById('theme-toggle-icon');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const isDark = !document.documentElement.classList.contains('dark');
            // Save to persistent config and apply dynamically (which updates meta theme-color too)
            const config = loadConfig();
            config.theme = isDark ? 'dark' : 'light';
            saveConfig(config);
            applyTheme();

            if (themeIcon) themeIcon.textContent = isDark ? 'light_mode' : 'dark_mode';
        });
        // Set initial icon state
        if (themeIcon) {
            const isDark = document.documentElement.classList.contains('dark');
            themeIcon.textContent = isDark ? 'light_mode' : 'dark_mode';
        }
    }
    
    // Sidebar toggle button
    const sidebarToggleBtn = btn('sidebar-toggle');
    if (sidebarToggleBtn) {
        sidebarToggleBtn.addEventListener('click', () => {
            document.documentElement.classList.toggle('sidebar-collapsed');
        });
    }

    // Mobile: start with sidebar collapsed
    if (window.innerWidth <= 800) {
        document.documentElement.classList.add('sidebar-collapsed');
    }

    // Mobile: backdrop click closes sidebar
    const sidebarBackdrop = document.getElementById('sidebar-backdrop');
    if (sidebarBackdrop) {
        sidebarBackdrop.addEventListener('click', () => {
            document.documentElement.classList.add('sidebar-collapsed');
        });
    }

    // Mobile: swipe gestures to open/close sidebar
    {
        let touchStartX = 0;
        let touchStartY = 0;
        const SWIPE_THRESHOLD = 50;

        document.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }, { passive: true });

        document.addEventListener('touchend', (e) => {
            const dx = e.changedTouches[0].clientX - touchStartX;
            const dy = e.changedTouches[0].clientY - touchStartY;
            // Only trigger if horizontal swipe is dominant
            if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;

            // Overlay viewer handles its own touch gestures; don't interfere.
            if (document.querySelector('overlay-viewer')?._visible) return;

            const isCollapsed = document.documentElement.classList.contains('sidebar-collapsed');
            if (dx > 0 && isCollapsed && touchStartX < 40) {
                // Swipe right from left edge: navigate up if in a non-root
                // directory within the file browser, otherwise open sidebar.
                const browser = document.getElementById('main-file-browser');
                const isOverlayOpen = document.querySelector('overlay-viewer')?._visible;
                const isFilesTab = store.getState().workspace.activeTabId === 'files';
                const rootDir = getSession(getActiveMachineId())?.connection?.rootDir ?? null;
                const currentPath = browser?.currentPath;
                const isRoot = !currentPath || currentPath === '/' ||
                               (rootDir && currentPath === rootDir);

                if (isFilesTab && !isOverlayOpen && !isRoot) {
                    browser.navigateUp();
                } else {
                    document.documentElement.classList.remove('sidebar-collapsed');
                }
            } else if (dx < 0 && !isCollapsed) {
                // Swipe left -> close sidebar
                document.documentElement.classList.add('sidebar-collapsed');
            }
        }, { passive: true });
    }

    // Callout menu: tap-toggle fallback for iOS Safari (where :focus-within is unreliable)
    document.querySelectorAll('.menu-container').forEach(container => {
        const trigger = container.querySelector('.menu-trigger');
        if (!trigger) return;
        trigger.addEventListener('click', (e) => {
            // Close any other open callout menus first
            document.querySelectorAll('.menu-container.callout-open').forEach(other => {
                if (other !== container) other.classList.remove('callout-open');
            });
            container.classList.toggle('callout-open');
        });
    });
    // Close callout menus when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.menu-container')) {
            document.querySelectorAll('.menu-container.callout-open').forEach(c => c.classList.remove('callout-open'));
        }
    });
    // Also close callout after picking an action
    document.querySelectorAll('.callout-menu button').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.closest('.menu-container')?.classList.remove('callout-open');
        });
    });
    
    // Machine info display
    updateMachineInfo();

    // Phase 5 (CP5b): the "not authenticated" placeholder over the file pane,
    // shown when the ACTIVE machine's auth is expired/required but dismissed
    // (no pending loginPromise). Store-driven; revives on re-login.
    initAuthBlockedPlaceholder();

    const logoutBtn = Array.from(document.querySelectorAll('.nav-item')).find(item => item.title === 'Logout');
    logoutBtn?.addEventListener('click', async () => {
        const activeMachine = getActiveMachine();
        const machineName = activeMachine?.name || 'Self';
        const machineId = getMachineId(activeMachine);

        // Phase 4 (D4): abort any running transfer that touches this machine so
        // it doesn't outlive its session/token (applies to both Self and remote).
        abortTransfersForMachine(machineId);

        if (activeMachine?.isSelf) {
            // Self logout (Phase 5 / CP7): clear token, flip Self's auth to
            // 'required' (so ensureAuth doesn't short-circuit on the stale
            // 'valid'), then re-auth immediately via the non-dismissible overlay.
            // No tab cleanup / auto-switch path - Self has no fallback machine.
            await getMachineClient(machineId).logout();
            markAuth(machineId, 'required');
            await ensureAuth(machineId);
            return;
        }

        // Remote logout (D7): scoped dirty-check + close ONLY this machine's
        // tabs/terminals, then auto-switch to Self. Other machines' tabs survive.
        const closed = await closeTabsForMachine(machineId);
        if (!closed) return; // user cancelled the unsaved-editor confirm
        await getMachineClient(machineId).logout();
        store.dispatch('activeMachineId/set', 'self');

        // Refresh sidebar for the now-active Self machine.
        await refreshSidebarState();

        // Verify Self auth: if its token also expired, pop the (non-dismissible)
        // Self auth box. markAuthExpired flips status off 'valid' first so
        // ensureAuth re-queues instead of short-circuiting.
        const selfStatus = await getMachineClient('self').authStatus();
        if (!selfStatus.valid) {
            markAuthExpired('self');
            await ensureAuth('self');
        }

        showToast(`Logged out from ${machineName}`, 'info');
    });

    // Legacy machine event removed (D6); follow activeMachineId in the store.
    store.subscribeSelect((s) => s.activeMachineId, () => {
        updateMachineInfo();
        showToast('Switched machine', 'success');
    });
}

function updateBreadcrumbs(path) {
    const bar = document.querySelector('.breadcrumb-list');
    if (!bar) return;
    
    bar.innerHTML = ''; // SAFE: clearing DOM before rebuilding breadcrumbs
    
    const rootDir = getSession(getActiveMachineId())?.connection?.rootDir ?? null;
    let relativePath = path;
    let isJailed = false;
    
    if (rootDir && path.startsWith(rootDir)) {
        isJailed = true;
        relativePath = path.substring(rootDir.length);
        if (!relativePath.startsWith('/')) {
            relativePath = '/' + relativePath;
        }
    }
    
    const parts = relativePath.split('/').filter(p => p);
    
    // Root
    const rootSpan = document.createElement('span');
    rootSpan.className = 'breadcrumb-item';
    rootSpan.textContent = '/';
    rootSpan.onclick = () => {
        document.getElementById('main-file-browser').currentPath = rootDir || '/';
    };
    bar.appendChild(rootSpan);
    
    let builtPath = isJailed ? rootDir : '';
    parts.forEach((part, index) => {
        if (builtPath.endsWith('/')) {
            builtPath = builtPath.substring(0, builtPath.length - 1);
        }
        builtPath += '/' + part; 
        const currentHook = builtPath;
        
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-separator icon icon-sm';
        sep.textContent = 'keyboard_arrow_right';
        bar.appendChild(sep);
        
        const item = document.createElement('span');
        if (index === parts.length - 1) {
            item.className = 'breadcrumb-current';
        } else {
            item.className = 'breadcrumb-item';
            item.onclick = () => {
                document.getElementById('main-file-browser').currentPath = currentHook;
            };
        }
        item.textContent = part;
        bar.appendChild(item);
    });
}



/**
 * Show settings modal
 */
function showSettings() {
    const overlay = document.getElementById('setting-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
    }
}

/**
 * Update machine info display in header
 */
function updateMachineInfo() {
    // Phase 3 (D7): the global header machine label is removed - each tab and
    // the Files dock entry already identify the active machine. Hide the static
    // .host-info element and its divider (index.html structure untouched).
    const hostInfoEl = document.querySelector('.host-info');
    if (!hostInfoEl) return;
    hostInfoEl.style.display = 'none';
    const divider = hostInfoEl.nextElementSibling;
    if (divider && divider.classList.contains('divider-v')) {
        divider.style.display = 'none';
    }
}

function initLoginOverlay() {
    if (loginOverlayInitialized) return;
    loginOverlayInitialized = true;

    const form = document.getElementById('login-form');
    form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        await handleLoginSubmit();
    });

    // Dismiss (remote only): Escape or outside-click resolves the queue head's
    // loginPromise with false. Self is non-dismissible (CP3/CP7) - the head's
    // isSelf flag gates it. Resolving pops the head; the store subscription
    // re-renders the next queued machine (or hides the overlay).
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const head = getAuthQueueHead();
        if (!head || head.isSelf) return;
        const overlay = document.getElementById('login-overlay');
        if (!overlay || overlay.style.display === 'none') return;
        e.preventDefault();
        resolveAuthLoginPromise(head.machineId, false);
    });

    const overlay = document.getElementById('login-overlay');
    overlay?.addEventListener('click', (e) => {
        if (e.target !== overlay) return;
        const head = getAuthQueueHead();
        if (!head || head.isSelf) return;
        resolveAuthLoginPromise(head.machineId, false);
    });

    // Store-driven render: the overlay reflects the FIFO queue head. Reactive,
    // not imperative - no caller shows/hides it directly.
    store.subscribeSelect(getAuthQueueHead, renderLoginOverlay);
    renderLoginOverlay();
}

/**
 * Render the login overlay from the current queue head. Shown when a machine
 * needs auth with an armed loginPromise; the subtitle reflects 'expired' vs
 * 'required'. Hidden when the queue is empty.
 */
function renderLoginOverlay() {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    const head = getAuthQueueHead();
    const subtitle = document.getElementById('login-subtitle');

    if (head) {
        if (subtitle) {
            subtitle.textContent = head.status === 'expired'
                ? `Session expired for ${head.name}.`
                : `Authenticate to access ${head.name}.`;
        }
        clearLoginError();
        overlay.style.display = 'flex';
        const input = document.getElementById('login-secret');
        if (input && !input.value) {
            input.value = '';
            requestAnimationFrame(() => input.focus());
        }
    } else {
        overlay.style.display = 'none';
    }
}

function showLoginError(message) {
    const el = document.getElementById('login-error');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
}

function clearLoginError() {
    const el = document.getElementById('login-error');
    if (!el) return;
    el.textContent = '';
    el.classList.remove('show');
}

async function handleLoginSubmit() {
    const head = getAuthQueueHead();
    if (!head) return false;

    const secretInput = document.getElementById('login-secret');
    const submitBtn = document.getElementById('login-submit-btn');
    const secret = secretInput?.value?.trim();

    if (!secret) {
        showLoginError('Secret is required.');
        return false;
    }

    clearLoginError();
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Signing in...';
    }

    try {
        await getMachineClient(head.machineId).login(secret);
        // Success: settle this machine's resolver (true) + mark valid. The store
        // subscription auto-renders the next queued machine (or hides). The
        // awaiting ensureAuth re-verifies and applies rootDir/path.
        resolveAuthLoginPromise(head.machineId, true);
        markAuth(head.machineId, 'valid');
        return true;
    } catch (error) {
        showLoginError(error.message || 'Authentication failed.');
        return false;
    } finally {
        if (secretInput) secretInput.value = '';
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Login';
        }
    }
}

/**
 * Ensure a machine is authenticated, queueing the per-session login overlay if
 * not. Returns true on valid auth, false on dismiss. The loginPromise lives on
 * THIS session (kills #9: no module singleton). Triggers (CP4): Self at boot,
 * switch when status !== 'valid', 401 via markAuthExpired -> ensureAuth.
 * @param {string} machineId
 * @returns {Promise<boolean>}
 */
export async function ensureAuth(machineId) {
    if (!machineId) return false;
    ensureSession(machineId);
    const client = getMachineClient(machineId);

    // Apply rootDir/currentPath to THIS machine's session (not the active one -
    // during a switch the active machine is still the previous one).
    const applyStatus = (status) => {
        setRootDir(machineId, status.root_dir || null);
        const cur = getBrowser(machineId)?.currentPath;
        if (status.root_dir && (!cur || cur === '/' || cur === '')) {
            setPath(machineId, status.root_dir);
        }
    };

    const prevStatus = getSession(machineId)?.auth?.status;
    // Trust a 'valid' status - the 401 path catches real expiry. Avoids a
    // network round-trip on every switch and prevents re-prompting.
    if (prevStatus === 'valid') return true;

    const status = await client.authStatus();
    if (status.valid) {
        markAuth(machineId, 'valid');
        applyStatus(status);
        return true;
    }

    // Need login. Message-status: keep 'expired' (was valid, then 401) else
    // 'required' (never authed / Self boot / Self logout).
    const needStatus = prevStatus === 'expired' ? 'expired' : 'required';

    // Share already-armed loginPromise on re-entrance (same-machine 401 storm).
    const existing = getSession(machineId)?.auth;
    if (existing?.loginPromise?.promise) return await existing.loginPromise.promise;

    // Arm a per-session resolver and await it. resolveAuthLoginPromise calls the
    // stored resolve(reject) handlers when the overlay submit/dismiss fires.
    let loggedIn;
    let _resolve, _reject;
    loggedIn = new Promise((resolve, reject) => { _resolve = resolve; _reject = reject; });
    markAuth(machineId, needStatus);
    setAuthLoginPromise(machineId, { promise: loggedIn, resolve: _resolve, reject: _reject });
    const result = await loggedIn;

    if (!result) return false; // dismissed

    // Re-verify (client.login throws on failure, so reaching here means the
    // submit succeeded; this confirms and applies rootDir/path).
    const verified = await client.authStatus();
    if (verified.valid) {
        markAuth(machineId, 'valid');
        applyStatus(verified);
        return true;
    }
    return false;
}

/**
 * Phase 5 (CP5b): the "not authenticated" placeholder over the file pane.
 * Shown when the ACTIVE machine's auth is expired/required with NO armed
 * loginPromise (i.e. the user dismissed the overlay while the machine was
 * already active). The re-login button re-triggers ensureAuth. On a successful
 * re-login (status flips to 'valid') the file list reloads in place (CP6).
 */
function initAuthBlockedPlaceholder() {
    const container = document.querySelector('.file-container');
    if (!container) return;

    const placeholder = document.createElement('div');
    placeholder.className = 'auth-blocked-overlay is-hidden';
    const icon = document.createElement('span');
    icon.className = 'icon icon-filled';
    icon.textContent = 'lock';
    const msg = document.createElement('p');
    msg.className = 'auth-blocked-msg';
    msg.textContent = 'Not authenticated';
    const btn = document.createElement('button');
    btn.className = 'auth-blocked-relogin';
    btn.type = 'button';
    btn.textContent = 'Re-login';
    btn.addEventListener('click', () => {
        ensureAuth(getActiveMachineId());
    });
    placeholder.append(icon, msg, btn);
    container.appendChild(placeholder);

    const readSlice = (s) => {
        const auth = s.sessions.get(s.activeMachineId)?.auth;
        return { status: auth?.status ?? null, hasPromise: !!auth?.loginPromise };
    };

    let prevStatus = null;
    let prevBlocked = false;
    const sync = ({ status, hasPromise }) => {
        const blocked = (status === 'expired' || status === 'required') && !hasPromise;
        if (blocked !== prevBlocked) {
            prevBlocked = blocked;
            placeholder.classList.toggle('is-hidden', !blocked);
        }
        // Re-login revival: when auth flips to valid after a blocked spell,
        // reload the file list so the pane recovers in place (CP6).
        if (status === 'valid' && prevStatus !== 'valid' && prevStatus !== null) {
            document.getElementById('main-file-browser')?.refresh();
        }
        prevStatus = status;
    };

    // subscribeSelect does not fire onChange at subscribe time, so seed manually.
    const initial = readSlice(store.getState());
    prevStatus = initial.status;
    prevBlocked = (initial.status === 'expired' || initial.status === 'required') && !initial.hasPromise;
    placeholder.classList.toggle('is-hidden', !prevBlocked);

    store.subscribeSelect(readSlice, sync);
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

/**
 * Fix iOS safe-area-inset-top inconsistency.
 *
 * iOS WebKit evaluates env(safe-area-inset-top) per-element at
 * computed-value time. In standalone (PWA) mode, position:fixed
 * elements get 0 while normal-flow elements get the correct inset;
 * in Safari the behaviour reverses. Defining --safe-top as
 * env(...) in :root doesn't help because CSS custom properties
 * re-evaluate env() on each element that inherits them.
 *
 * Fix: probe the actual pixel value via getComputedStyle (which
 * resolves env() to a concrete px), then set --safe-top as an
 * explicit px string -- bypassing env() entirely for all consumers.
 */
(function fixSafeAreaTop() {
    function probe() {
        const root = document.documentElement;

        // Normal-flow probe -- matches .header-bar context
        const s = document.createElement('div');
        s.style.cssText = 'padding-top:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;';
        root.appendChild(s);
        const staticVal = parseFloat(getComputedStyle(s).paddingTop) || 0;
        s.remove();

        // Fixed-position probe -- matches overlay context
        const f = document.createElement('div');
        f.style.cssText = 'padding-top:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;position:fixed;top:0;left:0;';
        root.appendChild(f);
        const fixedVal = parseFloat(getComputedStyle(f).paddingTop) || 0;
        f.remove();

        const maxVal = Math.max(staticVal, fixedVal, 0);
        if (maxVal > 0) {
            root.style.setProperty('--safe-top', maxVal + 'px');
            console.log('[fixSafeAreaTop] static=' + staticVal + ' fixed=' + fixedVal + ' -> --safe-top=' + maxVal + 'px');
        }
    }

    if (document.readyState === 'complete') probe();
    else window.addEventListener('load', probe);
    window.addEventListener('orientationchange', () => setTimeout(probe, 300));
})();
