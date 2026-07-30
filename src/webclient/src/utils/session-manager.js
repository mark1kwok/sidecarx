/**
 * SessionManager — action creators + selectors over the `sessions` slice.
 *
 * Owns NO state of its own: everything routes through the store's dispatch /
 * select. This is the only module unmigrated components should reach for to
 * obtain the active machine's client (`getActiveClient`) or to mutate a
 * session's browser context.
 */

import { store } from './store.js';
import { getMachineClient } from '../api/machine-client.js';
import { findMachineById } from './config.js';

function activeMachineId() {
    return store.getState().activeMachineId;
}

/** @returns {string} the active machineId. */
export function getActiveMachineId() {
    return activeMachineId();
}

/** @returns {MachineClient} the active machine's cached client. */
export function getActiveClient() {
    return getMachineClient(activeMachineId());
}

/** Set the active machine (dispatches activeMachineId/set). */
export function setActiveMachine(machineId) {
    store.dispatch('activeMachineId/set', machineId);
}

/** Build a fresh, pure-data MachineSession (no live objects). */
function makeSession(machineId, machine) {
    return {
        identity: {
            machineId,
            name: machine?.name ?? machineId,
            baseUrl: machine?.url ?? null,
            isSelf: !!machine?.isSelf,
        },
        auth: { status: 'unknown', loginPromise: null },
        connection: { rootDir: null },
        browser: {
            currentPath: '/',
            files: [],
            selectedFiles: new Set(),
            viewMode: 'list',
            sortBy: 'name',
            sortOrder: 'asc',
            search: { mode: null, query: '', results: [], clientFilter: '' },
        },
        ptyCounter: 0,
    };
}

/**
 * Ensure a session exists for machineId (idempotent). Returns the session.
 * @param {string} machineId
 */
export function ensureSession(machineId) {
    const existing = store.getState().sessions.get(machineId);
    if (existing) return existing;
    const machine = machineId === 'self'
        ? { name: 'Self', isSelf: true }
        : findMachineById(machineId);
    const session = makeSession(machineId, machine);
    store.dispatch('session/ensure', { machineId, session });
    return session;
}

/** @returns {MachineSession|null} the session for machineId. */
export function getSession(machineId) {
    return store.getState().sessions.get(machineId) || null;
}

/** @returns {MachineSession|null} the active machine's session. */
export function getActiveSession() {
    return getSession(activeMachineId());
}

/** @returns {object|null} the browser sub-state for machineId. */
export function getBrowser(machineId) {
    const session = getSession(machineId);
    return session ? session.browser : null;
}

/* ---- Browser context mutators (all dispatch) ---- */

export function setPath(machineId, path) {
    store.dispatch('session/setPath', { machineId, path });
}

/** Replace a session's loaded file listing (the `browser.files` slice). */
export function setFiles(machineId, files) {
    store.dispatch('session/setFiles', { machineId, files });
}

export function setSelection(machineId, selection) {
    store.dispatch('session/setSelection', { machineId, selection });
}

export function setViewMode(machineId, viewMode) {
    store.dispatch('session/setViewMode', { machineId, viewMode });
}

export function setSort(machineId, sortBy, sortOrder) {
    store.dispatch('session/setSort', { machineId, sortBy, sortOrder });
}

export function setSearch(machineId, search) {
    store.dispatch('session/setSearch', { machineId, search });
}

export function setRootDir(machineId, rootDir) {
    store.dispatch('session/setRootDir', { machineId, rootDir });
}

/* ---- Auth (Phase 5 / D5) ---- */

/**
 * Set a session's auth status, optionally setting/clearing its loginPromise in
 * the same dispatch. `loginPromise` omitted -> unchanged; `null` -> clear a
 * settled resolver; `{resolve, reject}` -> arm a new one.
 * @param {string} machineId
 * @param {string} status - 'unknown'|'checking'|'valid'|'required'|'expired'
 * @param {{resolve: Function, reject: Function} | null} [loginPromise]
 */
export function markAuth(machineId, status, loginPromise) {
    const payload = { machineId, status };
    if (loginPromise !== undefined) payload.loginPromise = loginPromise;
    store.dispatch('session/markAuth', payload);
}

/**
 * Mark a session's auth expired (401 path). Pure dispatch - the store
 * subscription in app.js drives the re-login overlay; no side-effect callback.
 */
export function markAuthExpired(machineId) {
    store.dispatch('session/markAuth', { machineId, status: 'expired' });
}

/**
 * Arm a per-session login resolver (kills #9: one resolver per machine, not a
 * module singleton). Stored on `session.auth.loginPromise` - the one sanctioned
 * non-serializable store value (D5).
 * @param {string} machineId
 * @param {{resolve: Function, reject: Function}} promise - live handlers.
 */
export function setAuthLoginPromise(machineId, promise) {
    store.dispatch('session/markAuth', { machineId, loginPromise: promise });
}

/**
 * Settle the head machine's login promise (resolve only - never reject), then
 * clear it from the session so the queue advances. `success=true` on a
 * submitted login; `false` on dismiss. No-op when no promise is armed.
 * @param {string} machineId
 * @param {boolean} success
 */
export function resolveAuthLoginPromise(machineId, success) {
    const session = getSession(machineId);
    const promise = session?.auth?.loginPromise;
    if (!promise) return;
    promise.resolve(success);
    store.dispatch('session/markAuth', { machineId, loginPromise: null });
}

/**
 * Derive the FIFO login queue's head by scanning sessions (insertion order).
 * The queue is NOT a separate structure - it is every session whose auth is in
 * the need-login bucket (`required`/`expired`) with an armed `loginPromise`.
 * @returns {{machineId: string, name: string, isSelf: boolean, status: string} | null}
 */
export function getAuthQueueHead() {
    const sessions = store.getState().sessions;
    for (const [machineId, session] of sessions) {
        const auth = session?.auth;
        if (!auth || !auth.loginPromise) continue;
        if (auth.status === 'required' || auth.status === 'expired') {
            const identity = session.identity || {};
            return {
                machineId,
                name: identity.name ?? machineId,
                isSelf: !!identity.isSelf,
                status: auth.status,
            };
        }
    }
    return null;
}

/* ---- Terminals ---- */

/**
 * Allocate the next pty number for a machine (monotonic per session).
 * @returns {number} the new pty number.
 */
export function nextPtyNo(machineId) {
    const session = getSession(machineId);
    const n = (session?.ptyCounter ?? 0) + 1;
    store.dispatch('session/setPtyCounter', { machineId, ptyCounter: n });
    return n;
}
