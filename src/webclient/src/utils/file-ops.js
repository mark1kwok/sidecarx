/**
 * File operations: downloads, clipboard (copy/cut/paste), drag-drop uploads, and
 * the Phase 4 (D4) TransferJob queue.
 *
 * Clipboard (Phase 4 schema):
 *   { operation: 'copy'|'cut'|null, source: { machineId, items: [{path,isDir}] } | null }
 * Identity is machineId-only — `machineUrl` is gone. The client is resolved at
 * paste time from the machineId via `getMachineClient`.
 *
 * TransferJob: one job per paste action, pure data in the store (the live
 * AbortController lives in a module-side Map here). `pasteItems` enqueues a job
 * and fires the executor; the executor branches INTERNALLY (no cross/same split
 * at the paste boundary): same-machine → server copy/rename; cross-machine →
 * src.list expansion + src.download + dst.upload per leaf under bounded
 * concurrency. Cancel/Retry/abortTransfersForMachine drive the controllers.
 */

import { getActiveClient, getActiveMachineId } from './session-manager.js';
import { getMachineClient } from '../api/machine-client.js';
import { showToast, showUploadToast, showDownloadToast, showConfirmDialog } from './ui.js';
import { getUploadSizeLimit } from './config.js';
import { store } from './store.js';

// Clipboard lives in the store. Phase 4 (D4) shape:
//   { operation: 'copy'|'cut'|null, source: { machineId, items: [{path,isDir}] } | null }
// The old machine/machineUrl/paths patch fields are gone — identity is
// machineId-only, resolved to a client at paste time via getMachineClient.
const EMPTY_CLIPBOARD = Object.freeze({ operation: null, source: null });
function readClipboard() {
    return store.getState().clipboard || EMPTY_CLIPBOARD;
}
function writeClipboard(obj) {
    store.dispatch('clipboard/set', obj);
}

function triggerBlobDownload(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

/**
 * Compute the parent directory of `currentPath`, respecting a jail `rootDir`.
 * Returns `null` when already at root (or would escape the jail), so callers
 * can treat "no parent" uniformly. Shared by file-browser + file-browser-logic
 * navigateUp (review #20 — removes the duplicated root-guard logic).
 * @param {string} currentPath
 * @param {string|null} [rootDir]
 * @returns {string|null}
 */
export function parentPath(currentPath, rootDir = null) {
    if (!currentPath) return null;
    if (rootDir && currentPath === rootDir) return null;
    if (currentPath === '/') return null;
    const parts = currentPath.split('/').filter((p) => p);
    parts.pop();
    const next = parts.length === 0 ? '/' : '/' + parts.join('/');
    if (rootDir && next.length < rootDir.length && rootDir.startsWith(next)) return null;
    return next;
}

/**
 * Download files or folders
 * For single item: direct stream body chunk read with progress toast
 * For multiple items: batch zip stream body chunk read with indeterminate progress toast
 * @param {Array<string>} selectedPaths - Array of full paths to download
 */
export async function downloadItems(selectedPaths) {
    if (!selectedPaths || selectedPaths.length === 0) {
        showToast('No items selected for download', 'warning');
        return;
    }

    const toast = showDownloadToast();

    try {
        if (selectedPaths.length === 1) {
            const path = selectedPaths[0];
            const name = path.split('/').pop() || 'download';
            const blob = await getActiveClient().download(path, {
                onProgress: (percent, metrics) => toast.update(percent, metrics),
            });
            triggerBlobDownload(blob, name);
            toast.finish(true, 'Download complete!');
        } else {
            const blob = await getActiveClient().downloadBatch(selectedPaths, {
                onProgress: (percent, metrics) => toast.update(percent, metrics),
            });
            triggerBlobDownload(blob, 'download.zip');
            toast.finish(true, 'Download complete!');
        }
    } catch (err) {
        console.error('Download error:', err);
        toast.finish(false, `Download failed: ${err.message}`);
    }
}

/**
 * Paste (copy or move) the clipboard items into `destinationPath` on the ACTIVE
 * machine. Phase 4 (D4) uniform pipeline: this does NOT branch on same vs cross
 * machine — it snapshots the clipboard into a TransferJob, clears the clipboard,
 * and runs the job via `runJob`. The executor branches internally.
 *
 * `dst.machineId` is the active machine at paste time. Returns true when a job
 * was enqueued (or a same-dir cut no-op applied), false when there was nothing
 * to paste. The job itself runs in the background and reports progress to the
 * transfer panel via the store.
 *
 * @param {string} destinationPath - Target directory on the active machine.
 * @returns {Promise<boolean>} whether a job was enqueued.
 */
export async function pasteItems(destinationPath) {
    const clipboard = readClipboard();
    const items = clipboard?.source?.items;
    if (!items || items.length === 0) {
        showToast('Nothing to paste', 'warning');
        return false;
    }

    const srcMachineId = clipboard.source.machineId;
    const dstMachineId = getActiveMachineId();
    const operation = clipboard.operation; // 'copy' | 'cut'

    // Cut-paste to the same directory on the same machine is a silent no-op:
    // clear the clipboard and stop. (Cross-machine cut always transfers.)
    if (operation === 'cut' && srcMachineId === dstMachineId) {
        const allSamePath = items.every((item) => {
            const fileName = item.path.split('/').pop();
            const destPath = destinationPath === '/' ? `/${fileName}` : `${destinationPath}/${fileName}`;
            return item.path === destPath;
        });
        if (allSamePath) {
            writeClipboard({ ...EMPTY_CLIPBOARD });
            return true;
        }
    }

    // Snapshot the clipboard into a job, then clear it — paste consumes the
    // clipboard; the job owns its own item copy from here on.
    const job = createTransferJob({
        kind: operation === 'cut' ? 'move' : 'copy',
        srcMachineId,
        dstMachineId,
        items,
        destinationPath,
    });
    writeClipboard({ ...EMPTY_CLIPBOARD });

    showToast(`${job.kind === 'move' ? 'Move' : 'Copy'} started — ${items.length} item(s)`, 'info');

    // Fire-and-forget; the transfer panel tracks status/progress.
    runJob(job);
    return true;
}

/* ---- TransferJob (Phase 4 - D4) ---- */

/** Cooperative cancellation marker thrown when a job's signal is aborted. */
class AbortError extends Error {
    constructor(message = 'Transfer aborted') {
        super(message);
        this.name = 'AbortError';
    }
}

/**
 * Bounded-concurrency primitive reused by the cross-machine executor
 * (10 downloads / 10 uploads). Preserved from Phase 3.
 */
class Semaphore {
    constructor(n) { this.n = n; this.waiting = []; }
    async acquire() {
        if (this.n > 0) { this.n--; return; }
        await new Promise((r) => this.waiting.push(r));
    }
    release() { this.n++; const r = this.waiting.shift(); if (r) { this.n--; r(); } }
}

/** Concurrency caps for the cross-machine transfer pipeline. */
const DOWNLOAD_CONCURRENCY = 10;
const UPLOAD_CONCURRENCY = 10;
/** How long a terminal-but-successful job lingers in the panel before auto-clear. */
const TERMINAL_LINGER_MS = 5000;
/** Minimum interval between progress dispatches (avoids store/render flooding). */
const PROGRESS_THROTTLE_MS = 100;

/**
 * Live AbortControllers, keyed by job id. The store holds only pure-data jobs
 * (mirrors the editor/terminal id back-ref convention); the controller lives
 * here so cancel/retry/logout-abort can stop an in-flight job.
 */
const _controllers = new Map();
let _jobCounter = 0;

function nextJobId() {
    _jobCounter += 1;
    return `xfer-${_jobCounter}`;
}

function patchJob(id, patch) {
    store.dispatch('transfers/update', { id, patch });
}

/**
 * Build a pure-data TransferJob, register a fresh AbortController, and add it
 * to the store. Does NOT run it — the caller invokes `runJob`.
 * @param {{kind:'copy'|'move', srcMachineId:string, dstMachineId:string, items:Array, destinationPath:string}} opts
 * @returns {object} the job (pure data).
 */
function createTransferJob({ kind, srcMachineId, dstMachineId, items, destinationPath }) {
    const job = {
        id: nextJobId(),
        kind,
        src: { machineId: srcMachineId },
        dst: { machineId: dstMachineId },
        items: items.map((i) => ({ path: i.path, isDir: !!i.isDir })),
        destinationPath,
        status: 'queued',
        progress: { done: 0, total: items.length },
        error: null,
    };
    _controllers.set(job.id, new AbortController());
    store.dispatch('transfers/add', job);
    return job;
}

/**
 * Run a job to terminal status. The executor branches internally on
 * src.machineId === dst.machineId:
 *   - same-machine → server copy (kind=copy) / rename (kind=move) per item
 *   - cross-machine → src.list folder expansion + src.download + dst.upload per
 *     leaf (bounded by DOWNLOAD/UPLOAD_CONCURRENCY)
 * Cross-machine move additionally confirms source deletion after a successful
 * transfer. Abort is cooperative and NOT an atomic undo: completed items
 * (esp. same-machine server ops) remain in place.
 * @param {object} job - pure-data job from the store.
 */
async function runJob(job) {
    const controller = _controllers.get(job.id);
    const signal = controller ? controller.signal : null;

    patchJob(job.id, { status: 'running', error: null });

    try {
        if (job.src.machineId === job.dst.machineId) {
            await execSameMachine(job, signal);
        } else {
            await execCrossMachine(job, signal);
        }
        patchJob(job.id, { status: 'completed' });
        showToast(`${job.kind === 'move' ? 'Move' : 'Copy'} complete`, 'success');
        scheduleRemoval(job.id);
    } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') {
            patchJob(job.id, { status: 'cancelled' });
            showToast('Transfer cancelled — completed items were kept', 'info');
            scheduleRemoval(job.id);
        } else {
            patchJob(job.id, { status: 'failed', error: err?.message || String(err) });
            showToast(`Transfer failed: ${err?.message || err}`, 'error');
        }
    } finally {
        // Refresh the destination browser so the result is visible when it is
        // the active machine. file-browser filters by machineId itself.
        window.dispatchEvent(new CustomEvent('file-browser-refresh', {
            detail: { machineId: job.dst.machineId },
        }));
    }
}

/**
 * Same-machine executor: server-side copy/rename per item. No per-leaf network
 * hops, so progress is item-count based and abort is checked between items.
 */
async function execSameMachine(job, signal) {
    const client = getMachineClient(job.dst.machineId);
    const items = job.items;
    const total = items.length;
    let done = 0;

    for (const item of items) {
        if (signal?.aborted) throw new AbortError();
        const sourcePath = item.path;
        const fileName = sourcePath.split('/').pop();
        let destPath = job.destinationPath === '/' ? `/${fileName}` : `${job.destinationPath}/${fileName}`;

        if (sourcePath === destPath) {
            if (job.kind === 'move') {
                // Cut onto itself: a no-op move.
                done += 1;
                patchJob(job.id, { progress: { done, total } });
                continue;
            }
            destPath = _makeRenamePath(destPath);
        }

        if (job.kind === 'copy') {
            await client.copy(sourcePath, destPath);
        } else {
            await client.rename(sourcePath, destPath);
        }
        done += 1;
        patchJob(job.id, { progress: { done, total } });
    }
}

/**
 * Cross-machine executor: expand folders on the source, then download each leaf
 * from src and upload to dst under bounded concurrency. The job's signal is
 * threaded into every download/upload. On a move, confirm-delete the original
 * top-level items from src after a successful transfer.
 */
async function execCrossMachine(job, signal) {
    const srcClient = getMachineClient(job.src.machineId);
    const dstClient = getMachineClient(job.dst.machineId);

    // 1. Expand clipboard items into flat leaf entries, creating destination
    //    directories as we go (the server upload auto-creates parents per-file,
    //    but the folder skeleton + empty dirs still need explicit mkdir).
    const leaves = [];
    for (const item of job.items) {
        if (signal?.aborted) throw new AbortError();
        if (item.isDir) {
            await expandFolder(srcClient, dstClient, item.path, job.destinationPath, leaves, signal);
        } else {
            const name = item.path.split('/').pop();
            leaves.push({ srcPath: item.path, name, destDir: job.destinationPath });
        }
    }

    const total = leaves.length;
    patchJob(job.id, { progress: { done: 0, total } });
    if (total === 0) return; // only empty folders — nothing to transfer

    // 2. Pipeline: up to N concurrent downloads + N concurrent uploads,
    //    independent (not paired). The signal aborts every in-flight op.
    const dl = new Semaphore(DOWNLOAD_CONCURRENCY);
    const ul = new Semaphore(UPLOAD_CONCURRENCY);
    let done = 0;
    let lastPatch = 0;

    await Promise.all(leaves.map(async (entry) => {
        if (signal?.aborted) throw new AbortError();

        await dl.acquire();
        let blob;
        try {
            if (signal?.aborted) throw new AbortError();
            blob = await srcClient.download(entry.srcPath, { signal });
        } finally {
            dl.release();
        }

        await ul.acquire();
        try {
            if (signal?.aborted) throw new AbortError();
            await dstClient.upload(
                entry.destDir,
                [{ file: new File([blob], entry.name), name: entry.name }],
                { signal },
            );
        } finally {
            ul.release();
        }

        done += 1;
        const now = Date.now();
        if (done === total || now - lastPatch >= PROGRESS_THROTTLE_MS) {
            lastPatch = now;
            patchJob(job.id, { progress: { done, total } });
        }
    }));

    // 3. Move (cut): cross-machine deletion is irreversible — confirm first.
    if (job.kind === 'move' && job.items.length > 0) {
        const confirmed = await showConfirmDialog(
            'Delete from source?',
            `Delete ${job.items.length} item(s) from the source machine after the successful transfer?`,
        );
        if (confirmed) {
            // remove() is per-item resilient and never throws.
            await srcClient.remove(job.items.map((i) => i.path));
        }
    }
}

/**
 * Recursively expand a source directory into leaf entries, mirroring its
 * structure under destDir on the destination.
 */
async function expandFolder(srcClient, dstClient, sourceDir, destDir, leaves, signal) {
    const dirName = sourceDir.split('/').pop();
    const destFolder = destDir === '/' ? `/${dirName}` : `${destDir}/${dirName}`;
    await dstClient.mkdir(destFolder);

    const entries = await srcClient.list(sourceDir);
    for (const entry of entries) {
        if (signal?.aborted) throw new AbortError();
        const srcPath = entry.path || `${sourceDir}/${entry.name}`;
        if (entry.is_dir) {
            await expandFolder(srcClient, dstClient, srcPath, destFolder, leaves, signal);
        } else {
            leaves.push({ srcPath, name: entry.name, destDir: destFolder });
        }
    }
}

/** Auto-clear a terminal-but-successful job after a short delay (idempotent). */
function scheduleRemoval(jobId) {
    setTimeout(() => {
        const j = store.getState().transfers.find((x) => x.id === jobId);
        if (!j) return;
        // Only remove if still terminal — a retry in the window re-queues it.
        if (j.status === 'completed' || j.status === 'cancelled') {
            store.dispatch('transfers/remove', { id: jobId });
            _controllers.delete(jobId);
        }
    }, TERMINAL_LINGER_MS);
}

/**
 * Cancel a running/queued job by aborting its controller. The executor stops
 * cooperatively; already-completed items remain (NOT an atomic undo).
 */
export function cancelTransfer(jobId) {
    const controller = _controllers.get(jobId);
    if (controller && !controller.signal.aborted) controller.abort();
}

/**
 * Retry a failed/cancelled job IN PLACE: fresh AbortController, same id, reset
 * to queued, then re-run. No duplicate rows.
 */
export function retryTransfer(jobId) {
    const job = store.getState().transfers.find((j) => j.id === jobId);
    if (!job) return;
    if (job.status !== 'failed' && job.status !== 'cancelled') return;

    _controllers.set(jobId, new AbortController());
    patchJob(jobId, {
        status: 'queued',
        error: null,
        progress: { done: 0, total: job.items.length },
    });
    // Re-read so runJob sees the reset job (progress.total for cross-machine is
    // recomputed during folder expansion).
    const fresh = store.getState().transfers.find((j) => j.id === jobId);
    runJob(fresh);
}

/**
 * Abort every queued/running job that touches `machineId` (as source OR
 * destination). Used at logout so no zombie transfer outlives its machine.
 */
export function abortTransfersForMachine(machineId) {
    if (!machineId) return;
    const jobs = store.getState().transfers;
    for (const job of jobs) {
        if (job.status !== 'queued' && job.status !== 'running') continue;
        if (job.src.machineId === machineId || job.dst.machineId === machineId) {
            const controller = _controllers.get(job.id);
            if (controller && !controller.signal.aborted) controller.abort();
        }
    }
}

/**
 * Generate a renamed path with _copy suffix for same-path paste.
 * "/path/to/file.txt" → "/path/to/file_copy.txt"
 * "/path/to/folder"   → "/path/to/folder_copy"
 * @param {string} fullPath
 * @returns {string}
 */
function _makeRenamePath(fullPath) {
    const lastSlash = fullPath.lastIndexOf('/');
    const dir = fullPath.substring(0, lastSlash);
    const name = fullPath.substring(lastSlash + 1);
    const dotIndex = name.lastIndexOf('.');

    let newName;
    if (dotIndex > 0) {
        // Has extension: file.txt → file_copy.txt
        newName = name.substring(0, dotIndex) + '_copy' + name.substring(dotIndex);
    } else {
        // No extension (folder or extensionless file): folder → folder_copy
        newName = name + '_copy';
    }
    return dir ? `${dir}/${newName}` : `/${newName}`;
}

/**
 * Set the clipboard for a copy operation (Phase 4 schema).
 * @param {Array<{path: string, isDir: boolean}>} items - Items to copy
 */
export function setClipboardCopy(items) {
    writeClipboard({
        operation: 'copy',
        source: {
            machineId: getActiveMachineId(),
            items: items.map((i) => ({ path: i.path, isDir: !!i.isDir })),
        },
    });
    showToast(`${items.length} item(s) copied to clipboard`, 'success');
}

/**
 * Set the clipboard for a cut operation (Phase 4 schema).
 * @param {Array<{path: string, isDir: boolean}>} items - Items to cut
 */
export function setClipboardCut(items) {
    writeClipboard({
        operation: 'cut',
        source: {
            machineId: getActiveMachineId(),
            items: items.map((i) => ({ path: i.path, isDir: !!i.isDir })),
        },
    });
    showToast(`${items.length} item(s) cut to clipboard`, 'success');
}

/**
 * Clear the clipboard (operation + source). Does not touch cut visual markers —
 * the file browser owns those.
 */
export function clearClipboard() {
    writeClipboard({ ...EMPTY_CLIPBOARD });
}

/**
 * Move items to a destination directory.
 * Uses /api/fs/rename which handles cross-directory moves.
 * @param {Array<string>} sourcePaths - Absolute paths to move
 * @param {string} destDir - Destination directory
 * @returns {Promise<boolean>} Success
 */
export async function moveItemsToDir(sourcePaths, destDir) {
    if (!sourcePaths || sourcePaths.length === 0 || !destDir) return false;
    try {
        const cleanDest = destDir === '/' ? '' : destDir.replace(/\/+$/, '');
        const client = getActiveClient();
        let moved = 0;
        for (const sourcePath of sourcePaths) {
            const fileName = sourcePath.split('/').pop();
            const destPath = cleanDest ? `${cleanDest}/${fileName}` : `/${fileName}`;
            if (sourcePath === destPath) continue;
            await client.rename(sourcePath, destPath);
            moved++;
        }
        if (moved === 0) return true; // silent — nothing to move (same dir)
        showToast(`Moved ${moved} item(s)`, 'success');
        return true;
    } catch (err) {
        console.error('Move error:', err);
        showToast(`Move failed: ${err.message}`, 'error');
        return false;
    }
}

/**
 * Handles dropped items (files/folders) with recursive traversal.
 * Uses v0.12 path-preserving upload — server auto-creates parent dirs.
 * @param {DataTransferItemList} items
 * @param {string} currentPath
 */
export async function handleDropItems(items, currentPath) {
    // 1. Get entries from items
    const entries = [];
    for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
        if (entry) {
            entries.push(entry);
        }
    }

    if (entries.length === 0) return;

    const toast = showUploadToast();

    try {
        // 2. Traverse and collect files with relative paths
        const filesWithPaths = [];
        const cleanPath = currentPath === '/' ? '' : currentPath.replace(/\/$/, '');

        const traverse = async (entry, parentRelative) => {
            if (entry.isFile) {
                const file = await getFileFromEntry(entry);
                const relativePath = parentRelative ? `${parentRelative}/${entry.name}` : entry.name;
                filesWithPaths.push({ file, name: relativePath });
            } else if (entry.isDirectory) {
                const dirRelative = parentRelative ? `${parentRelative}/${entry.name}` : entry.name;
                const children = await readDirectoryEntries(entry);
                for (const child of children) {
                    await traverse(child, dirRelative);
                }
            }
        };

        for (const entry of entries) {
            await traverse(entry, '');
        }

        if (filesWithPaths.length === 0) {
            toast.finish(false, 'No files found to upload');
            return;
        }

        // 2b. Early size guard — reject before building FormData / XHR
        const limitMB = getUploadSizeLimit();
        const limitBytes = limitMB * 1024 * 1024;
        const totalSize = filesWithPaths.reduce((sum, f) => sum + (f.file?.size || 0), 0);
        if (totalSize > limitBytes) {
            toast.finish(false, `File too large (limit: ${limitMB >= 1024 ? (limitMB / 1024) + ' GB' : limitMB + ' MB'})`);
            return;
        }

        // 3. Single upload call — server creates parent dirs from filename paths
        const targetPath = cleanPath || '/';
        await getActiveClient().upload(targetPath, filesWithPaths, {
            onProgress: (percent, metrics) => toast.update(percent, metrics),
        });
        toast.finish(true, 'Upload complete!');

        // Notify the active machine's file browser to refresh (D6: carries machineId).
        window.dispatchEvent(new CustomEvent('file-browser-refresh', { detail: { machineId: getActiveMachineId() } }));

    } catch (err) {
        console.error(err);
        toast.finish(false, `Upload failed: ${err.message}`);
    }
}

/**
 * Convert FileSystemFileEntry to File object
 */
function getFileFromEntry(entry) {
    return new Promise((resolve, reject) => {
        entry.file(resolve, reject);
    });
}

/**
 * Read all entries from a directory reader (handles batching)
 */
function readDirectoryEntries(dirEntry) {
    return new Promise((resolve, reject) => {
        const reader = dirEntry.createReader();
        let allEntries = [];

        function read() {
            reader.readEntries((entries) => {
                if (entries.length === 0) {
                    resolve(allEntries);
                } else {
                    allEntries = allEntries.concat(entries);
                    read(); // Keep reading until empty
                }
            }, reject);
        }

        read();
    });
}
