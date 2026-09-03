/**
 * Editor open gate — the single fail-safe size check for opening files in
 * the code editor (openspec: editor/file-open). Enforced at the one funnel
 * every editor open passes through (openTab('editor')), BEFORE any content
 * fetch: a refused file must never have its bytes transferred.
 */
import { getMachineClient } from '../api/machine-client.js';
import { showToast } from './ui.js';

/** Fail-safe open limit (frontend-only; backend read API stays unlimited). */
export const EDITOR_OPEN_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Resolve the byte size of a file WITHOUT fetching its content — one
 * metadata-class call: the directory listing of the parent.
 * @returns {Promise<number|null>} size in bytes, or null when unresolvable.
 */
async function resolveSizeViaParent(machineId, path) {
    try {
        const client = getMachineClient(machineId);
        const name = path.split('/').pop();
        const parent = path.slice(0, path.length - name.length - 1) || '/';
        const entries = await client.list(parent);
        const hit = (entries || []).find((e) => e.name === name);
        return hit && typeof hit.size === 'number' ? hit.size : null;
    } catch {
        return null;
    }
}

/**
 * Decide whether an editor open may proceed. NEVER fetches file content.
 * @param {{machineId: string, path: string, size?: number}} opts
 * @returns {Promise<{allowed: boolean, bytes: number|null}>}
 */
export async function editorOpenAllowed({ machineId, path, size }) {
    let bytes = typeof size === 'number' ? size : null;
    if (bytes === null && path) bytes = await resolveSizeViaParent(machineId, path);
    if (bytes !== null && bytes > EDITOR_OPEN_MAX_BYTES) {
        return { allowed: false, bytes };
    }
    return { allowed: true, bytes };
}

/** Shared refusal UX for the gate. bytes may be null (unresolved). */
export function notifyEditorOpenRefused(fileName, bytes) {
    const limitMb = EDITOR_OPEN_MAX_BYTES / (1024 * 1024);
    const sizeTxt =
        typeof bytes === 'number' ? ` (${(bytes / (1024 * 1024)).toFixed(1)} MB > ${limitMb} MB)` : ` (> ${limitMb} MB)`;
    showToast(`File too large${sizeTxt}. Use download instead.`, 'warning');
}
