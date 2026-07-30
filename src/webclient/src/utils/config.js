/**
 * Configuration Management Utility
 * Loads config via backend FS API
 * Falls back to defaults if not found
 * Saves config back via write API on mutation
 */

import { debug } from './debug.js';
import { getToken } from './storage.js';
import { showToast } from './ui.js';
import { getMachineId } from './identity.js';
import { store } from './store.js';

/**
 * Detect proxy path prefix from current URL.
 * If served at /car/admin/, returns "/car".
 * If served at /admin/, returns "".
 */
export const BASE_PATH = (() => {
    const path = window.location.pathname;
    // Strip trailing filename like index.html if present
    const cleanPath = path.endsWith('.html') || path.endsWith('.js')
        ? path.substring(0, path.lastIndexOf('/'))
        : path;
    // Strip trailing slash
    return cleanPath.replace(/\/+$/, '');
})();

// Config file path — relative to the backend sidecar CWD,
// NOT relative to the static assets (i.e. the URL of index.html,
// which in full is http://domain/admin/index.html).
const CONFIG_FILE_PATH = './admin_cfg.json';

// In-memory config (loaded once at startup)
let _config = null;

const SELF_MACHINE = {
    name: 'Self',
    isSelf: true,
};

// Default configuration (used as fallback)
const DEFAULT_CONFIG = {
    theme: 'light', // 'light', 'dark', 'system'
    machines: [],
    favorites: {
        _default: [{ icon: 'home', path: '/', label: 'Home' },
                   { icon: 'group', path: '/home', label: 'Users' }]
    },
    fileTypes: [ ],
    upload_size_limit: 1024, // MB (default 1 GB)
};

export function normalizeConfig(source = {}) {
    const merged = { ...DEFAULT_CONFIG, ...source };
    const remoteMachines = (Array.isArray(source.machines) ? source.machines : []).filter(Boolean);

    // Key machines by machineId (ADR-0001). Two DIFFERENT names that slug to
    // the same machineId is a config error — surface it to the user AND reject
    // the colliding duplicate (keep the first), never silently last-wins merge.
    // Within one slug + identical name, last-wins (mirrors the old name dedup).
    const byId = new Map();
    const collisions = [];
    for (const m of remoteMachines) {
        if (!m.name) continue;
        const id = getMachineId(m);
        const prev = byId.get(id);
        if (prev && prev.name !== m.name) {
            // Collision: two distinct names slug to the same machineId.
            // REJECT the later one (do not overwrite); keep the first machine.
            collisions.push(`'${prev.name}' / '${m.name}' → id "${id}"`);
            continue;
        }
        byId.set(id, m);
    }
    if (collisions.length > 0) {
        const msg = `Machine name collision (names slug to the same id): ${collisions.join('; ')}. Rename one in Settings.`;
        console.error('⚠️ ' + msg);
        showToast(msg, 'error');
    }
    merged.machines = [SELF_MACHINE, ...byId.values()];

    // Ensure _default favorites are always present (shallow spread loses them
    // when source.favorites exists with machine-specific keys only)
    if (!merged.favorites?._default) {
        merged.favorites = { ...merged.favorites, _default: DEFAULT_CONFIG.favorites._default };
    }

    return merged;
}

/**
 * Find a machine config by its machineId. (ADR-0001 — reverse of getMachineId.)
 * Returns the Self machine for machineId 'self'. Used by session-manager /
 * machine-client to resolve a machineId back to its display config.
 * @param {string} machineId
 * @returns {object|null}
 */
export function findMachineById(machineId) {
    return getMachines().find((m) => getMachineId(m) === machineId) || null;
}

function toPersistedConfig(config) {
    const persisted = { ...config };
    // Strip runtime-only fields
    persisted.machines = (config.machines || []).filter(machine => !machine.isSelf);
    // Strip _default favorites (hardcoded in DEFAULT_CONFIG, restored by normalizeConfig)
    if (persisted.favorites) {
        const { _default, ...rest } = persisted.favorites;
        persisted.favorites = rest;
    }
    return persisted;
}

/**
 * Load config via backend FS API (async, call once at startup).
 * Requires a valid Self-machine auth token (call after Self auth).
 * Falls back to DEFAULT_CONFIG if fetch fails.
 * @returns {Promise<Object>} Configuration object
 */
export async function loadConfigAsync(forceReload = false) {
    if (_config && !forceReload) {
        return _config; // Already loaded
    }

    try {
        const token = getToken('default');
        const url = `${BASE_PATH}/api/fs/read?path=${encodeURIComponent(CONFIG_FILE_PATH)}`;
        const response = await fetch(url, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        });
        if (response.ok) {
            const fileConfig = await response.json();
            _config = normalizeConfig(fileConfig);
            debug.log('📦 Config loaded via API:', CONFIG_FILE_PATH);
        } else {
            console.warn('⚠️ Config not found via API, using defaults');
            _config = normalizeConfig();
        }
    } catch (error) {
        console.warn('⚠️ Failed to load config via API, using defaults:', error.message);
        _config = normalizeConfig();
    }

    return _config;
}

/**
 * Get current config (sync, must call loadConfigAsync first)
 * @returns {Object} Configuration object
 */
export function loadConfig() {
    if (!_config) {
        console.warn('⚠️ Config not loaded yet, returning defaults');
        return normalizeConfig();
    }
    return _config;
}

/**
 * Save config — updates in-memory immediately, then persists
 * to backend via write API (fire-and-forget).
 * Always uses Self-machine auth token since config lives on the hosting machine.
 * @param {Object} config - Configuration object
 * @returns {boolean} true (in-memory save always succeeds)
 */
export function saveConfig(config) {
    _config = config;

    // Fire-and-forget async upload to backend
    _persistToBackend(toPersistedConfig(config));
    return true;
}

/**
 * Persist config JSON to backend via write API (PUT /fs/write).
 * Uses Self-machine token (key 'default') regardless of active machine,
 * because admin_cfg.json lives on the machine hosting this SPA.
 * @param {Object} persistedConfig - Config with runtime fields stripped
 */
async function _persistToBackend(persistedConfig) {
    try {
        const token = getToken('default'); // Always Self-machine token
        const json = JSON.stringify(persistedConfig, null, 2);

        const url = `${BASE_PATH}/api/fs/write?path=${encodeURIComponent(CONFIG_FILE_PATH)}`;
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                'Content-Type': 'application/json',
            },
            body: json,
        });

        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
        debug.log('💾 Config saved to backend:', CONFIG_FILE_PATH);
    } catch (error) {
        console.error('Failed to persist config:', error);
        showToast(`Config save failed: ${error.message}`, 'error');
    }
}

/**
 * Get active machine configuration. Resolves from the store's activeMachineId
 * (ADR-0001); falls back to the first machine (Self) if the id isn't in config
 * yet (e.g. before config load).
 * @returns {Object|null} Active machine config
 */
export function getActiveMachine() {
    const id = store.getState().activeMachineId;
    return findMachineById(id) || loadConfig().machines[0] || null;
}

/**
 * Set active machine by name string. Name-based legacy signature retained for
 * callers (sidebar/app); translates to a machineId dispatch into the store.
 * @param {string} name - Machine name (e.g. 'Self', 'gcp-dev1')
 * @returns {Object|null} Active machine after update
 */
export function setActiveMachine(name) {
    const config = loadConfig();
    const machine = config.machines.find(m => m.name === name);
    if (!machine) {
        return getActiveMachine(); // Invalid name, keep current
    }
    store.dispatch('activeMachineId/set', getMachineId(machine));
    return getActiveMachine();
}

/**
 * Get favorites for a specific machine.
 * Returns _default entries plus any machine-specific entries.
 * @param {string} name - Machine name
 * @returns {Array} Combined favorites
 */
export function getFavoritesForMachine(name) {
    const config = loadConfig();
    const favs = config.favorites || {};
    const defaults = favs._default || [];
    // Use machine-specific list if it exists, otherwise fall back to _default
    return favs[name] ? favs[name] : defaults;
}

/**
 * Get full machine list (includes Self at index 0)
 * @returns {Array}
 */
export function getMachines() {
    return loadConfig().machines || [];
}

/**
 * Resolve machine base URL.
 * For Self machines, returns the detected proxy path prefix (e.g. "/car" or "").
 * For remote machines, returns the full URL with trailing slashes stripped.
 * @param {Object} machine
 * @returns {string} Base URL or path prefix
 */
export function getMachineBaseURL(machine = getActiveMachine()) {
    if (!machine || machine.isSelf) return BASE_PATH;
    return machine.url.replace(/\/+$/, '');
}

/**
 * Get upload size limit in MB from config.
 * @returns {number} Limit in MB (default 1024 = 1 GB)
 */
export function getUploadSizeLimit() {
    const config = loadConfig();
    const val = config.upload_size_limit;
    return (typeof val === 'number' && val > 0) ? val : DEFAULT_CONFIG.upload_size_limit;
}

/**
 * Apply theme based on config
 */
export function applyTheme() {
    const config = loadConfig();
    const html = document.documentElement;
    let isDark = false;
    
    if (config.theme === 'system') {
        // Use system preference
        const supportsMatchMedia = typeof window.matchMedia === 'function';
        const prefersDark = supportsMatchMedia
            ? window.matchMedia('(prefers-color-scheme: dark)').matches
            : false;
        html.classList.toggle('dark', prefersDark);
        isDark = prefersDark;
    } else {
        isDark = config.theme === 'dark';
        html.classList.toggle('dark', isDark);
    }

    // Retrieve active background color token dynamically from CSS
    const primaryBgColor = getComputedStyle(html).getPropertyValue('--bg-primary').trim() || (isDark ? '#141414' : '#f5f5f5');

    // Update window chrome background color (theme-color meta tag)
    let themeMeta = document.getElementById('theme-meta');
    if (!themeMeta) {
        themeMeta = document.createElement('meta');
        themeMeta.id = 'theme-meta';
        themeMeta.name = 'theme-color';
        document.head.appendChild(themeMeta);
    }
    themeMeta.setAttribute('content', primaryBgColor);
}

// System color scheme change listener (updates PWA theme-color dynamically on system preference changes)
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        try {
            const config = loadConfig();
            if (config && config.theme === 'system') {
                applyTheme();
            }
        } catch (e) {
            // Ignore if config not fully initialized yet
        }
    });
}


/**
 * Add a favorite for a specific machine.
 * If no machine-specific key exists, materializes _default list first.
 * Lazy materialization means we don't modify the config object until the first mutation.
 * User could always keep the default set untill add/remove from the default.
 * @param {string} machineName - Machine name (e.g. 'Self', 'gcp-dev1')
 * @param {string} path - Absolute path to pin
 * @param {string} folderName - Display label (folder name)
 */
export function addFavorite(machineName, path, folderName) {
    const config = loadConfig();
    const favs = config.favorites || {};

    // Resolve the working list for this machine
    let list = favs[machineName];
    if (!list) {
        // Materialize defaults on first mutation
        list = [...(favs._default || [])];
    }

    // Duplicate check
    if (list.some(f => f.path === path)) return;

    list.push({ icon: 'folder', path, label: folderName });
    config.favorites[machineName] = list;
    _config = config;
    saveConfig(config);
    // (D6) legacy favorites event removed; callers refresh locally.
}

/**
 * Remove a favorite for a specific machine.
 * Lazy materialization means we don't modify the config object until the first mutation.
 * User could always keep the default set untill add/remove from the default.
 * If the list becomes empty, deletes the machine key so _default fallback returns.
 * @param {string} machineName - Machine name
 * @param {string} path - Path to unpin
 */
export function removeFavorite(machineName, path) {
    const config = loadConfig();
    const favs = config.favorites || {};
    let list = favs[machineName];
    if (!list) {
        // Materialize defaults on first mutation
        list = [...(favs._default || [])];
    }

    const idx = list.findIndex(f => f.path === path);
    if (idx === -1) return;

    list.splice(idx, 1);
    if (list.length === 0) {
        delete config.favorites[machineName];
    } else {
        config.favorites[machineName] = list;
    }
    _config = config;
    saveConfig(config);
}

/**
 * Check if a path is in the favorites for a machine.
 * @param {string} machineName - Machine name
 * @param {string} path - Path to check
 * @returns {boolean}
 */
export function isFavorite(machineName, path) {
    const list = getFavoritesForMachine(machineName);
    return list.some(f => f.path === path);
}

/**
 * Get file icon and color for extension
 * @param {string} filename - File name
 * @param {boolean} isDirectory - Is directory
 * @returns {Object} {icon, color}
 */
export function getFileIcon(filename, isDirectory) {
    if (isDirectory) {
        return { icon: 'folder', color: '#fbbf24' };
    }
    
    const config = loadConfig();
    const ext = '.' + filename.split('.').pop().toLowerCase();
    
    // Find matching file type (exact match or wildcard)
    const fileType = config.fileTypes.find(ft => ft.extension === ext);
    const defaultType = config.fileTypes.find(ft => ft.extension === '*');
    
    if (fileType) {
        return { icon: fileType.icon, color: fileType.color };
    }
    return defaultType 
        ? { icon: defaultType.icon, color: defaultType.color }
        : { icon: 'description', color: '#868686' };
}
