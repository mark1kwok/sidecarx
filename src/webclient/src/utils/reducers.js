/**
 * Root reducer + slice reducers for the v0.4.0 store.
 *
 * Immutability contract: every slice returns a NEW value when its action fires
 * and the SAME reference otherwise — so unrelated dispatches preserve nested
 * identity (workspace.openTabs array, session.browser.selectedFiles Set, …).
 * That identity preservation is what lets the Phase-1 compat shim expose live
 * references that unmigrated components still mutate in place (push/splice,
 * Set.add, tab-field writes) while reads keep seeing them.
 *
 * Pure functions only — no module state, no side effects, no imports.
 */

/**
 * PATCH one existing session immutably via `mapper(prev) -> next`. No-ops when
 * the session is absent — callers must `session/ensure` first. (Creation is a
 * different operation; routing it through here was the original bug, because
 * the `!prev` guard no-oped the very action meant to create.)
 */
function updateSession(sessions, machineId, mapper) {
    const prev = sessions.get(machineId);
    if (!prev) return sessions; // not ensured yet — patch is a no-op
    const next = mapper(prev);
    if (next === prev) return sessions;
    const nextMap = new Map(sessions);
    nextMap.set(machineId, next);
    return nextMap;
}

/** Immutably patch a session's `browser` sub-object. */
function patchBrowser(session, patch) {
    return { ...session, browser: { ...session.browser, ...patch } };
}

function configSlice(config, action) {
    if (action.type === 'config/set') return action.payload;
    return config;
}

function sessionsSlice(sessions, action) {
    const { type, payload } = action;
    switch (type) {
        case 'session/ensure': {
            // CREATE (not patch): insert the session if absent. Must bypass
            // updateSession — its !prev guard no-ops creation.
            if (sessions.has(payload.machineId)) return sessions;
            const ensured = new Map(sessions);
            ensured.set(payload.machineId, payload.session);
            return ensured;
        }
        case 'session/setPath':
            return updateSession(sessions, payload.machineId,
                (s) => patchBrowser(s, { currentPath: payload.path }));
        case 'session/setFiles':
            return updateSession(sessions, payload.machineId,
                (s) => patchBrowser(s, { files: payload.files }));
        case 'session/setSelection':
            return updateSession(sessions, payload.machineId,
                (s) => patchBrowser(s, { selectedFiles: payload.selection }));
        case 'session/setViewMode':
            return updateSession(sessions, payload.machineId,
                (s) => patchBrowser(s, { viewMode: payload.viewMode }));
        case 'session/setSort':
            return updateSession(sessions, payload.machineId,
                (s) => patchBrowser(s, {
                    sortBy: payload.sortBy ?? s.browser.sortBy,
                    sortOrder: payload.sortOrder ?? s.browser.sortOrder,
                }));
        case 'session/setSearch':
            return updateSession(sessions, payload.machineId,
                (s) => patchBrowser(s, { search: payload.search }));
        case 'session/setRootDir':
            return updateSession(sessions, payload.machineId,
                (s) => ({ ...s, connection: { ...s.connection, rootDir: payload.rootDir } }));
        case 'session/setPtyCounter':
            return updateSession(sessions, payload.machineId,
                (s) => ({ ...s, ptyCounter: payload.ptyCounter }));
        case 'session/markAuth':
            // Phase 5 (D5): patch `auth.status` and/or `auth.loginPromise`
            // independently. `loginPromise` is the ONE non-serializable store
            // value (live {resolve, reject} handlers) - the auth flow needs it
            // on the session so each machine gets its own resolver (kills #9).
            // Callers omit a field to leave it unchanged; pass `loginPromise:
            // null` to clear a settled resolver.
            return updateSession(sessions, payload.machineId,
                (s) => {
                    const auth = { ...s.auth };
                    if ('status' in payload) auth.status = payload.status;
                    if ('loginPromise' in payload) auth.loginPromise = payload.loginPromise;
                    return { ...s, auth };
                });
        default:
            return sessions;
    }
}

function activeMachineIdSlice(activeMachineId, action) {
    if (action.type === 'activeMachineId/set') return action.payload;
    return activeMachineId;
}

function workspaceSlice(workspace, action) {
    const { type, payload } = action;
    switch (type) {
        case 'workspace/setTabs':
            return { ...workspace, openTabs: payload };
        case 'workspace/setActiveTab':
            return { ...workspace, activeTabId: payload };
        case 'workspace/patch':
            return { ...workspace, ...payload };
        case 'workspace/openTab':
            // Append the tab and activate it. Editor dedup (machineId::path) is
            // the caller's responsibility; terminals always open fresh (D2.1).
            return { ...workspace, openTabs: [...workspace.openTabs, payload], activeTabId: payload.id };
        case 'workspace/closeTab': {
            const idx = workspace.openTabs.findIndex((t) => t.id === payload);
            if (idx === -1) return workspace;
            const nextTabs = workspace.openTabs.filter((t) => t.id !== payload);
            let nextActive = workspace.activeTabId;
            if (workspace.activeTabId === payload) {
                // Fall back to the adjacent remaining tab, else the Files pane.
                const fallback = nextTabs[Math.max(0, idx - 1)];
                nextActive = fallback ? fallback.id : 'files';
            }
            return { ...workspace, openTabs: nextTabs, activeTabId: nextActive };
        }
        case 'workspace/closeTabsForMachine': {
            // D7/logout: close every tab belonging to machineId. Other machines'
            // tabs survive. If the active tab was one of them, fall back to Files.
            const nextTabs = workspace.openTabs.filter((t) => t.machineId !== payload);
            if (nextTabs.length === workspace.openTabs.length) return workspace;
            const activeRemoved = workspace.openTabs.some(
                (t) => t.id === workspace.activeTabId && t.machineId === payload,
            );
            return {
                ...workspace,
                openTabs: nextTabs,
                activeTabId: activeRemoved ? 'files' : workspace.activeTabId,
            };
        }
        case 'workspace/setEditorId': {
            // Live-object id back-reference (the Monaco model stays in editor.js).
            const idx = workspace.openTabs.findIndex((t) => t.id === payload.tabId);
            if (idx === -1) return workspace;
            const tab = workspace.openTabs[idx];
            if (!tab.editor) return workspace;
            const nextTabs = workspace.openTabs.slice();
            nextTabs[idx] = { ...tab, editor: { ...tab.editor, editorId: payload.editorId } };
            return { ...workspace, openTabs: nextTabs };
        }
        case 'workspace/setTerminalId': {
            // Live-object id back-reference (the WebSocket PTY stays in terminal.js).
            const idx = workspace.openTabs.findIndex((t) => t.id === payload.tabId);
            if (idx === -1) return workspace;
            const tab = workspace.openTabs[idx];
            if (!tab.terminal) return workspace;
            const nextTabs = workspace.openTabs.slice();
            nextTabs[idx] = { ...tab, terminal: { ...tab.terminal, terminalId: payload.terminalId } };
            return { ...workspace, openTabs: nextTabs };
        }
        default:
            return workspace;
    }
}

function clipboardSlice(clipboard, action) {
    if (action.type === 'clipboard/set') return action.payload;
    return clipboard;
}

/**
 * Transfers slice (Phase 4 - D4). One TransferJob per paste action. Jobs are
 * pure data here - the live AbortController lives in a module-side Map in
 * file-ops.js (mirrors the editor/terminal id back-ref convention: the store
 * never holds live objects). Actions:
 *   - 'transfers/add'    payload: job            -> append
 *   - 'transfers/update' payload: {id, patch}    -> merge patch into the job
 *   - 'transfers/remove' payload: {id}           -> drop the job
 *   - 'transfers/clear'  (no payload)            -> empty the queue
 */
function transfersSlice(transfers, action) {
    const { type, payload } = action;
    switch (type) {
        case 'transfers/add':
            return [...transfers, payload];
        case 'transfers/update': {
            const idx = transfers.findIndex((j) => j.id === payload.id);
            if (idx === -1) return transfers;
            const prev = transfers[idx];
            const next = { ...prev, ...payload.patch };
            return transfers.map((j, i) => (i === idx ? next : j));
        }
        case 'transfers/remove': {
            const idx = transfers.findIndex((j) => j.id === payload.id);
            if (idx === -1) return transfers;
            return transfers.filter((j) => j.id !== payload.id);
        }
        case 'transfers/clear':
            return [];
        default:
            return transfers;
    }
}

/**
 * Compose all slice reducers into a single root reducer.
 * @param {object} state - current state (always defined; store seeds it).
 * @param {{type: string, payload?: any}} action - action object.
 * @returns {object} new state (or the same ref if nothing changed).
 */
export function rootReducer(state, action) {
    const next = {
        config: configSlice(state.config, action),
        sessions: sessionsSlice(state.sessions, action),
        activeMachineId: activeMachineIdSlice(state.activeMachineId, action),
        workspace: workspaceSlice(state.workspace, action),
        clipboard: clipboardSlice(state.clipboard, action),
        transfers: transfersSlice(state.transfers, action),
    };
    // Avoid returning a new top-level object when no slice actually changed.
    if (
        next.config === state.config
        && next.sessions === state.sessions
        && next.activeMachineId === state.activeMachineId
        && next.workspace === state.workspace
        && next.clipboard === state.clipboard
        && next.transfers === state.transfers
    ) {
        return state;
    }
    return next;
}
