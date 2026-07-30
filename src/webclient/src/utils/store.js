/**
 * Hand-rolled, zero-dependency Redux-style store. (D6)
 *
 * Exposes a singleton `store`: getState / dispatch / subscribe / select /
 * subscribeSelect (shallow-equal). dispatch runs rootReducer, which returns a
 * new state object on change (or the same ref when nothing changed).
 */

import { rootReducer } from './reducers.js';

/**
 * Seed state. Phase 3 (D2): the File Browser is a singleton pane, NOT a tab —
 * `workspace.openTabs` holds editor/terminal tabs ONLY, and `activeTabId` is a
 * tab id or the sentinel `'files'`. `config` is a placeholder — config.js
 * remains the operational source; the store.config slice is populated for
 * schema fidelity but is not authoritative until a later phase migrates config.
 */
const initialState = {
    config: {
        machines: [],
        theme: 'light',
        favorites: { _default: [] },
        fileTypes: [],
        upload_size_limit: 1024,
    },
    sessions: new Map(),
    activeMachineId: 'self',
    workspace: {
        // Phase 3 (D2): the File Browser is a singleton pane, NOT a tab.
        // openTabs ⊆ {editor, terminal}; activeTabId is a tab id or 'files'.
        openTabs: [],
        activeTabId: 'files',
    },
    // Phase 4 (D4): clipboard is { operation, source }. `source` is null when
    // empty, else { machineId, items: [{path,isDir}] }. The old machine/
    // machineUrl/paths fields are gone - identity is machineId-only.
    clipboard: { operation: null, source: null },
    transfers: [],
};

/**
 * Shallow-equal (primitives, same-ref objects/arrays/Set/Map, 1-level objects).
 *
 * Vanilla `Object.keys()` cannot enumerate Set/Map entries — two Sets with
 * different content compare as equal (keys=[] for both). This breaks every
 * `subscribeSelect` that watches a Set-valued slice (selection, search results,
 * etc.). Set/Map comparison below is O(n) reference-equality per entry.
 */
function shallowEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;

    // Set: compare by size then per-element reference — no deep recursion
    // because Sets in the store hold primitives (paths) or plain-object refs.
    if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) return false;
        for (const item of a) {
            if (!b.has(item)) return false;
        }
        return true;
    }

    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (a[k] !== b[k]) return false;
    }
    return true;
}

/**
 * Create a store instance. (Exported for testing; the app uses the singleton.)
 * @param {object} [state] - initial state.
 * @returns {{getState, dispatch, subscribe, select, subscribeSelect}}
 */
export function createStore(state = initialState) {
    let currentState = state;
    const listeners = new Set();

    function getState() {
        return currentState;
    }

    function dispatch(type, payload) {
        const action = (typeof type === 'string') ? { type, payload } : type;
        const next = rootReducer(currentState, action);
        if (next !== currentState) {
            currentState = next;
            for (const listener of listeners) {
                try {
                    listener(currentState);
                } catch (err) {
                    // A subscriber must never break the dispatch loop.
                    console.error('[store] subscriber threw:', err);
                }
            }
        }
        return action;
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function select(selector) {
        return selector(currentState);
    }

    function subscribeSelect(selector, onChange) {
        let prev = selector(currentState);
        const unsub = subscribe((s) => {
            const nextVal = selector(s);
            if (!shallowEqual(prev, nextVal)) {
                prev = nextVal;
                onChange(nextVal);
            }
        });
        return unsub;
    }

    return { getState, dispatch, subscribe, select, subscribeSelect };
}

/** Singleton store used by the app. */
export const store = createStore();
