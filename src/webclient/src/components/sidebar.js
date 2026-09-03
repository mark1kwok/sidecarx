/**
 * Sidebar Component
 * Handles Sidebar navigation, Folder Tree, and Machine switching.
 */

import { loadConfigAsync } from '../utils/config.js';
import { loadConfig, saveConfig, applyTheme, getMachines, getActiveMachine, setActiveMachine, getFavoritesForMachine, removeFavorite, normalizeConfig } from '../utils/config.js';
import { getActiveClient, getActiveMachineId, getSession } from '../utils/session-manager.js';
import { getMachineId } from '../utils/identity.js';
import { store } from '../utils/store.js';
import { debug } from '../utils/debug.js';
import { openTab } from './tab-manager.js';
import { showToast } from '../utils/ui.js';
import { ensureAuth } from '../app.js';

export async function initSidebar() {
    debug.log('Initializing Sidebar...');
    const config = await loadConfigAsync();

    renderFavourites();
    initFolderTree();
    initUtilities();
    initSettingsOverlay(config);
    renderMachines();
    initLogoutMobileClose();
    initSysStats();

    // D7: a machine switch is a single activeMachineId dispatch; rebuild the
    // sidebar (tree/favorites/machines) for the newly active machine here.
    store.subscribeSelect((s) => s.activeMachineId, () => {
        refreshSidebarState();
    });
}

/**
 * Refresh sidebar state (favorites, folder tree, machines).
 * Called after machine switch or logout fallback.
 */
export async function refreshSidebarState() {
    renderFavourites();
    await initFolderTree();
    renderMachines();
}

/**
 * Close sidebar on mobile viewports (≤800px).
 * No-op on desktop where sidebar is always visible.
 */
function closeSidebarMobile() {
    if (window.innerWidth > 800) return;
    document.documentElement.classList.add('sidebar-collapsed');
}

/**
 * Wire logout button to close sidebar on mobile.
 */
function initLogoutMobileClose() {
    const logoutBtn = Array.from(document.querySelectorAll('.nav-item')).find(item => item.title === 'Logout');
    logoutBtn?.addEventListener('click', () => closeSidebarMobile());
}

/**
 * Render Favorites Section
 */
function renderFavourites() {
    const container = document.querySelector('#sidebar-favorites');
    if (!container) return;

    const activeMachine = getActiveMachine();
    const favorites = getFavoritesForMachine(activeMachine?.name || 'Self');

    // Clear existing items (keep title)
    const title = container.querySelector('.nav-section-title');
    container.innerHTML = ''; // SAFE: clearing DOM
    if (title) container.appendChild(title);

    favorites.forEach(fav => {
        const item = document.createElement('div');
        item.className = 'nav-item';
        item.tabIndex = 0;
        // #2: build with createElement + textContent so a favorite label that
        // contains HTML (e.g. an XSS payload pinned as a folder name) renders
        // as inert text, not markup.
        const iconSpan = document.createElement('span');
        iconSpan.className = 'icon';
        iconSpan.textContent = fav.icon || 'folder';
        const textSpan = document.createElement('span');
        textSpan.className = 'text';
        textSpan.textContent = fav.label;
        const pinSpan = document.createElement('span');
        pinSpan.className = 'icon icon-sm pin-button pinned';
        pinSpan.textContent = 'kid_star';
        item.append(iconSpan, textSpan, pinSpan);

        item.addEventListener('click', (e) => {
            // pin-button has its own handler; ignore clicks that bubbled from it
            if (e.target.closest('.pin-button')) return;
            navigateTo(fav.path);
            closeSidebarMobile();
        });

        // Star icon click -> unpin (stopPropagation to avoid navigation)
        pinSpan.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const machineName = activeMachine?.name || 'Self';
            removeFavorite(machineName, fav.path);
            renderFavourites(); // (D6) legacy favorites event removed
        });

        container.appendChild(item);
    });
}

/**
 * Initialize Folder Tree
 */

async function initFolderTree() {
    const container = document.querySelector('.folder-tree');
    if (!container) return;

    container.innerHTML = ''; // SAFE: clearing DOM before re-rendering tree

    // Create root item
    const rootUL = document.createElement('ul');
    container.appendChild(rootUL);

    const rootDir = getSession(getActiveMachineId())?.connection?.rootDir || '/';
    const rootItem = createTreeItem('/', rootDir, true);
    rootUL.appendChild(rootItem);

    // Auto-expand root only on screens 950px or taller
    if (window.innerHeight >= 950) {
        await toggleTreeItem(rootItem, rootDir, true);
    }
}

/**
 * Create a tree item element
 * @param {string} name - Display name
 * @param {string} path - Full path
 * @param {boolean} isDir - Is directory
 */
function createTreeItem(name, path, isDir) {
    if (!isDir) return null; // We only show folders in tree

    const tree_node = document.createElement('li');
    // #2: createElement + textContent — `name` is a directory name and may
    // contain HTML characters.
    const btn = document.createElement('button');
    const chevron = document.createElement('span');
    chevron.className = 'icon icon-sm chevron';
    chevron.textContent = 'keyboard_arrow_right';
    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.textContent = name;
    btn.append(chevron, textSpan);
    tree_node.appendChild(btn);

    tree_node.dataset.path = path;
    
    const childContainer = document.createElement('ul');
    childContainer.className = 'tree-children';
    childContainer.style.display = 'none';

    tree_node.appendChild(childContainer);

    // Click on row -> Navigate
    tree_node.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // If clicking chevron, toggle expand
        // Separate Listener for chevron if needed, but closest check handles it.
        if (e.target.closest('.chevron')) {
            toggleTreeItem(tree_node, path);
        } else {
            // Navigate
            navigateTo(path);
            closeSidebarMobile();
            // Tree structure (expand/collapse) solely controlled by chevron click
            // Click on tree-item row (outside chevron), just lead the workspace-file nav to it
        }
    });
    
    return tree_node;
}

/**
 * Toggle tree item expansion
 * @param {HTMLElement} tree_node - The wrapper element containing button and ul
 * @param {string} path - Path to list
 * @param {boolean} forceExpand - If true, force expand
 */
async function toggleTreeItem(tree_node, path, forceExpand = false) {
    const childContainer = tree_node.querySelector('.tree-children');
    const chevron = tree_node.querySelector('.chevron');
    
    const isExpanded = childContainer.style.display !== 'none';
    
    if (isExpanded && !forceExpand) {
        // Collapse
        childContainer.style.display = 'none';
        chevron.innerText = 'keyboard_arrow_right';
        return;
    }
    
    // Expand
    childContainer.style.display = 'block';
    chevron.innerText = 'keyboard_arrow_down';
    
    // Load children if empty
    if (childContainer.children.length === 0) {
        try {
            const items = await getActiveClient().list(path);
            // Sort: folders first, then name
            items.sort((a, b) => {
                if (a.is_dir !== b.is_dir) return b.is_dir ? 1 : -1;
                return a.name.localeCompare(b.name);
            });
            
            items.forEach(item => {
                if (item.is_dir) {
                    const childPath = path === '/' ? `/${item.name}` : `${path}/${item.name}`;
                    const childNode = createTreeItem(item.name, childPath, true);
                    childContainer.appendChild(childNode);
                }
            });
        } catch (err) {
            console.error('Tree load failed:', err);
            // Later to change error handling with toast message with error details, e.g. no permission
            // Static error placeholder — built with createElement for consistency.
            childContainer.replaceChildren();
            const li = document.createElement('li');
            const btn = document.createElement('button');
            const ic = document.createElement('span');
            ic.className = 'icon icon-sm chevron';
            ic.textContent = 'exclamation';
            const tx = document.createElement('span');
            tx.className = 'text';
            tx.textContent = 'Error Loading';
            btn.append(ic, tx);
            li.appendChild(btn);
            childContainer.appendChild(li);
        }
    }
}

/**
 * Navigate workspace to path
 */
function navigateTo(path) {
    const fileBrowser = document.getElementById('main-file-browser') || document.querySelector('file-browser-logic');
    if (fileBrowser) {
        fileBrowser.currentPath = path;
    }
    // Switch to the Files dock entry (by id, so it survives the label change to
    // `📁 <machine>`) if it isn't already active.
    const filesTab = document.getElementById('tab-files');
    if (filesTab && !filesTab.classList.contains('active')) {
        filesTab.click();
    }
}

/**
 * Initialize Utilities (Terminal/Editor)
 */
function initUtilities() {
    const utils = document.querySelectorAll('#sidebar-utilities .nav-item');
    utils.forEach(item => {
        item.addEventListener('click', async () => {
            const action = item.dataset.action;
            closeSidebarMobile();
            if (action === 'terminal') {
                openTab('terminal');
            } else if (action === 'editor') {
                // Generate timestamped filename
                const now = new Date();
                const pad = (n) => String(n).padStart(2, '0');
                const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
                const filename = `Untitled_${timestamp}.md`;
                const filePath = `/tmp/${filename}`;

                try {
                    // Upload empty file to create it on the backend
                    const emptyBlob = new File([''], filename, { type: 'text/plain; charset=utf-8' });
                    await getActiveClient().upload('/tmp', [{ file: emptyBlob, name: filename }]);
                    openTab('editor', { label: filename, path: filePath, isNew: true });
                } catch (err) {
                    // Fallback: open in-memory blank editor
                    showToast('Could not create temp file, opening in-memory editor', 'warning');
                    openTab('editor', { label: filename });
                }
            }
        });
    });
}

/**
 * Initialize System Stats widget with polling.
 * Fetches CPU, RAM and Disk usage every 10 seconds and updates the sidebar bars.
 */
function initSysStats() {
    const cpuBar  = document.getElementById('stats-cpu-bar');
    const cpuText = document.getElementById('stats-cpu-text');
    const ramBar  = document.getElementById('stats-ram-bar');
    const ramText = document.getElementById('stats-ram-text');
    const diskBar  = document.getElementById('stats-disk-bar');
    const diskText = document.getElementById('stats-disk-text');

    if (!ramBar || !diskBar || !cpuBar) return;

    function fmtBytes(bytes) {
        if (bytes >= 1099511627776) return (bytes / 1099511627776).toFixed(1) + 'TB';
        if (bytes >= 1073741824)    return (bytes / 1073741824).toFixed(1) + 'GB';
        if (bytes >= 1048576)       return (bytes / 1048576).toFixed(0) + 'MB';
        return (bytes / 1024).toFixed(0) + 'KB';
    }

    async function refresh() {
        try {
            const s = await getActiveClient().sysStats();

            const cpuPct  = s.cpu_usage !== undefined ? Math.round(s.cpu_usage) : 0;
            const ramPct  = s.ram_total  > 0 ? Math.round(s.ram_used  / s.ram_total  * 100) : 0;
            const diskPct = s.disk_total > 0 ? Math.round(s.disk_used / s.disk_total * 100) : 0;

            cpuBar.style.width  = cpuPct  + '%';
            ramBar.style.width  = ramPct  + '%';
            diskBar.style.width = diskPct + '%';

            // Colour the bar red when usage > 85%
            cpuBar.classList.toggle('stats-bar-warn',  cpuPct  > 85);
            ramBar.classList.toggle('stats-bar-warn',  ramPct  > 85);
            diskBar.classList.toggle('stats-bar-warn', diskPct > 85);

            cpuText.textContent  = `${cpuPct}%`;
            ramText.textContent  = `${fmtBytes(s.ram_used)} / ${fmtBytes(s.ram_total)}`;
            diskText.textContent = `${fmtBytes(s.disk_used)} / ${fmtBytes(s.disk_total)}`;
        } catch {
            cpuText.textContent  = 'N/A';
            ramText.textContent  = 'N/A';
            diskText.textContent = 'N/A';
        }
    }

    refresh();
    setInterval(refresh, 10000);

    // Refresh immediately when the active machine changes (D6: replaces a legacy event).
    store.subscribeSelect((s) => s.activeMachineId, refresh);
}

/**
 * Initialize Settings Overlay
 */
function initSettingsOverlay(config) {
    const overlay = document.getElementById('setting-overlay');
    const openBtn = document.getElementById('btn-settings');
    const cancelBtn = overlay?.querySelector('.btn-secondary');
    const saveBtn = overlay?.querySelector('.btn-primary');
    const closeBtn = overlay?.querySelector('.settings-close');

    if (!overlay || !openBtn) return;

    const closeModal = () => { overlay.style.display = 'none'; };

    openBtn.addEventListener('click', () => {
        closeSidebarMobile();
        overlay.style.display = 'flex';
        populateSettings(config);
    });

    cancelBtn?.addEventListener('click', closeModal);
    closeBtn?.addEventListener('click', closeModal);

    // Close on overlay background click
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });

    // Add Machine button — appended after the list items inside .settings-list
    const addBtn = overlay.querySelector('.settings-add-btn');
    addBtn?.addEventListener('click', () => {
        const list = overlay.querySelector('.settings-list');
        if (list) {
            // Insert before "Add Machine" button
            list.insertBefore(createMachineItem({ url: '', name: '' }), addBtn);
        }
    });

    saveBtn?.addEventListener('click', () => {
        const formData = normalizeConfig(gatherSettingsData());
        const saved = saveConfig(formData);
        if (saved) {
            renderMachines();
            showToast('Settings saved', 'info');
            closeModal();
        }
    });
}

/**
 * Populate settings form with current config (machines only)
 */
function populateSettings(config) {
    const list = document.querySelector('#setting-overlay .settings-list');
    if (!list) return;

    // Clear everything except the Add button
    list.querySelectorAll('.settings-item').forEach(el => el.remove());

    const addBtn = list.querySelector('.settings-add-btn');
    config.machines.filter(m => !m.isSelf).forEach(machine => {
        const item = createMachineItem(machine);
        if (addBtn) {
            list.insertBefore(item, addBtn);
        } else {
            list.appendChild(item);
        }
    });

    // Ensure Add Machine button exists (create once if missing)
    if (!addBtn) {
        const btn = document.createElement('button');
        btn.className = 'settings-add-btn';
        btn.innerHTML = '<span class="icon">add</span> Add Machine'; // SAFE: static UI string
        list.appendChild(btn);
    }
}

/**
 * Create a machine item for settings (click-to-edit readonly inputs)
 */
function createMachineItem(machine) {
    const div = document.createElement('div');
    div.className = 'settings-item';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'settings-input';
    nameInput.placeholder = 'Name';
    nameInput.value = machine.name || '';
    nameInput.readOnly = true;

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'settings-input';
    urlInput.placeholder = 'URL (e.g. http://host:3000)';
    urlInput.value = machine.url || '';
    urlInput.readOnly = true;

    // Click-to-edit: remove readonly on focus, restore on blur
    [nameInput, urlInput].forEach(input => {
        input.addEventListener('focus', () => { input.readOnly = false; });
        input.addEventListener('blur', () => { input.readOnly = true; });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'settings-delete';
    delBtn.innerHTML = '<span class="icon icon-sm">delete</span>'; // SAFE: static UI string
    delBtn.addEventListener('click', () => div.remove());

    div.append(nameInput, urlInput, delBtn);
    return div;
}

/**
 * Gather machines data from settings form
 */
function gatherSettingsData() {
    const config = loadConfig();
    const overlay = document.getElementById('setting-overlay');

    const machineItems = overlay?.querySelectorAll('.settings-item') || [];
    const machines = Array.from(machineItems).map(item => {
        const inputs = item.querySelectorAll('.settings-input');
        return {
            name: inputs[0]?.value?.trim() || '',
            url: inputs[1]?.value?.trim() || ''
        };
    }).filter(m => m.name && m.url);

    return { ...config, machines };
}

/**
 * Render Sidebar Machines Menu
 */
let switchingMachine = false; // Guard flag to prevent concurrent switch attempts

function renderMachines() {
    const config = loadConfig();
    const machines = getMachines();
    const activeMachine = getActiveMachine();
    const container = document.querySelector('#sidebar-machines');
    const menu = container?.querySelector('.account-menu');
    const expandIcon = container?.querySelector('.expand-icon');
    const labelEl = container?.querySelector('.machine-label');
    
    if (!container || !menu) return;

    if (labelEl) {
        labelEl.textContent = activeMachine?.name || 'Machine';
    }

    // as the content sits at the left of the chevron, and expands above the container, use left arrow and up arrow.
    const closeMenu = () => {
        container.classList.remove('active');
        if (expandIcon) expandIcon.innerText = 'keyboard_arrow_left';
        menu.style.display = 'none';
    };

    const openMenu = () => {
        container.classList.add('active');
        if (expandIcon) expandIcon.innerText = 'keyboard_arrow_up';
        menu.style.display = 'block';
    };

    // Toggle Menu (bind once)
    if (!container.dataset.menuToggleBound) {
        container.addEventListener('click', (e) => {
            if (e.target.closest('.account-menu')) return;

            if (container.classList.contains('active')) {
                closeMenu();
            } else {
                openMenu();
            }
        });

        // Outside-click dismiss for the machine menu
        document.addEventListener('click', (e) => {
            if (!container.classList.contains('active')) return;
            if (!container.contains(e.target)) {
                closeMenu();
            }
        });

        container.dataset.menuToggleBound = 'true';
    }

    // Populate Menu
    menu.replaceChildren();
    const activeId = store.getState().activeMachineId;
    machines.forEach((machine) => {
        const item = document.createElement('div');
        const isActive = getMachineId(machine) === activeId; // store-based (ADR-0001)
        item.className = 'menu-item';
        // #2: textContent — machine.name is free-form and may contain HTML.
        const label = document.createElement('span');
        label.className = 'text';
        label.textContent = machine.name;
        item.appendChild(label);
        if (isActive) {
            const check = document.createElement('span');
            check.className = 'icon icon-sm check';
            check.textContent = 'check';
            item.appendChild(check);
        }

        item.addEventListener('click', async () => {
            // Clicking active machine is a no-op — just close menu
            if (isActive) {
                closeMenu();
                return;
            }

            // Guard against concurrent switches
            if (switchingMachine) return;
            switchingMachine = true;

            try {
                debug.log(`Switching to machine: ${machine.name}`);

                // Auth-check the TARGET machine BEFORE committing the switch.
                // ensureAuth waits on a per-session login resolver (D5): if the
                // target's auth is unknown it probes; if invalid it shows the
                // (dismissible for remote) overlay and awaits. Dismiss ->
                // resolve(false) -> switch cancelled, activeMachineId unchanged.
                const authOk = await ensureAuth(getMachineId(machine));
                if (!authOk) {
                    debug.log(`Auth failed/aborted for ${machine.name} — switch cancelled`);
                    closeMenu();
                    return;
                }

                // D7: a switch is a single activeMachineId dispatch. Workspace
                // tabs are NOT touched (each carries its own machineId), and the
                // file browser restores the target session's context on its own
                // (D3 — no reset to root). The sidebar rebuilds for the new
                // machine via the activeMachineId subscription in initSidebar.
                setActiveMachine(machine.name);

                closeMenu();
                closeSidebarMobile();
            } finally {
                switchingMachine = false;
            }
        });
        menu.appendChild(item);
    });
}


