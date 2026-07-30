/**
 * MachineClient — the single machine-bound API surface. (D1)
 *
 * Folds the former api/{client,fs,sys,auth}.js into one cached client per
 * machineId. `baseUrl` is bound at construction; the token is read FRESH on
 * every call (re-login takes effect with no rebuild). 401 converges on a single
 * path: clearToken → onUnauthorized(machineId) → throw UnauthorizedError (#11).
 *
 * The client module imports NO store. The 401 hook is injected once from app.js
 * boot via `setUnauthorizedHandler` (wired to sessionManager.markAuthExpired).
 *
 * Phase 4 removed the machine-agnostic `downloadFromUrl`/`listFromUrl` helpers:
 * cross-machine transfers now use `getMachineClient(srcMachineId)` and
 * `getMachineClient(dstMachineId)` directly (D4 uniform pipeline).
 */

import { getToken, saveToken, clearToken, saveFetchCredentials, getFetchCredentials } from '../utils/storage.js';
import { getMachines, BASE_PATH, getUploadSizeLimit } from '../utils/config.js';
import { getMachineId } from '../utils/identity.js';

/** Thrown by every method on HTTP 401 (after clearToken + onUnauthorized). */
export class UnauthorizedError extends Error {
    constructor(machineName) {
        super(machineName ? `Authentication required for ${machineName}` : 'Authentication required');
        this.name = 'UnauthorizedError';
    }
}

let _onUnauthorized = null;
/**
 * Inject the single 401 hook (called once from app.js boot). The hook receives
 * the machineId whose token just expired.
 * @param {(machineId: string) => void} fn
 */
export function setUnauthorizedHandler(fn) {
    _onUnauthorized = typeof fn === 'function' ? fn : null;
}

/** The single literal 401 check — every method routes through this (#11). */
function isUnauthorized(status) {
    return status === 401;
}

/** Resolve a machineId into the descriptor needed to build a client. */
function resolveDescriptor(machineId) {
    if (machineId === 'self') {
        // Self needs no config - boot auth works before admin_cfg.json loads.
        // baseUrl is the FULL origin + path prefix so every URL (media, thumb,
        // API) is absolute - identical to remote machines. isSelf is kept only
        // for the auth-fallback path and the WebKit fetch-token skip.
        return { machineId: 'self', name: 'Self', baseUrl: window.location.origin + BASE_PATH, isSelf: true };
    }
    const machine = getMachines().find((m) => getMachineId(m) === machineId);
    if (!machine) throw new Error(`Unknown machine: ${machineId}`);
    return {
        machineId,
        name: machine.name,
        baseUrl: String(machine.url || '').replace(/\/+$/, ''),
        isSelf: false,
    };
}

const _clientCache = new Map();
/**
 * Get (or create+cache) the MachineClient for a machineId. (D1)
 * @param {string} machineId
 * @returns {MachineClient}
 */
export function getMachineClient(machineId) {
    let client = _clientCache.get(machineId);
    if (!client) {
        client = new MachineClient(resolveDescriptor(machineId));
        _clientCache.set(machineId, client);
    }
    return client;
}

/** Drop the cached client for a machineId (e.g. after its config URL changes). */
export function resetMachineClient(machineId) {
    _clientCache.delete(machineId);
}

/** Read a streaming response body chunk-by-chunk, reporting progress. */
async function readStreamWithProgress(response, onProgress) {
    if (!onProgress) return response.blob();
    const totalHeader = response.headers.get('content-length');
    const total = totalHeader ? parseInt(totalHeader, 10) : null;
    const lengthComputable = total !== null && !isNaN(total) && total > 0;
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            onProgress(
                lengthComputable ? (loaded / total) * 100 : Number.NaN,
                { loaded, total, lengthComputable, timestamp: Date.now() },
            );
        }
        return new Blob(chunks, {
            type: response.headers.get('content-type') || 'application/octet-stream',
        });
    } finally {
        // #12: always release the reader lock so the body stream isn't leaked.
        reader.releaseLock?.();
    }
}

class MachineClient {
    constructor(descriptor) {
        this.machineId = descriptor.machineId;
        this.name = descriptor.name;
        this.baseUrl = descriptor.baseUrl;
        this.isSelf = !!descriptor.isSelf;
    }

    /** Token read fresh on every call — re-login takes effect immediately. */
    _token() {
        return getToken(this.machineId);
    }

    _headers(extra = {}) {
        const token = this._token();
        const headers = { ...extra };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
    }

    /** The single 401 side-effect: clearToken → onUnauthorized → UnauthorizedError. */
    _unauthorized() {
        clearToken(this.machineId);
        if (_onUnauthorized) _onUnauthorized(this.machineId);
        return new UnauthorizedError(this.name);
    }

    /** JSON request with the unified error/401 handling (mirrors legacy apiRequest). */
    async _json(endpoint, options = {}) {
        const headers = this._headers({ 'Content-Type': 'application/json', ...options.headers });
        const response = await fetch(`${this.baseUrl}${endpoint}`, { ...options, headers });
        if (isUnauthorized(response.status)) throw this._unauthorized();

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            // Non-JSON body
            if (!response.ok) {
                throw new Error(text || response.statusText || `Request failed (${response.status})`);
            }
            return text;
        }
        if (data && data.error) {
            throw new Error(data.message || 'API request failed');
        }
        if (!response.ok) {
            throw new Error(data.message || `Request failed (${response.status})`);
        }
        return data;
    }

    /* ---- Filesystem ---- */

    /** List directory contents. */
    list(path) {
        return this._json(`/api/fs/list?path=${encodeURIComponent(path)}`);
    }

    /** Read a file as a Blob. */
    async readBlob(path, { signal } = {}) {
        const response = await fetch(`${this.baseUrl}/api/fs/read?path=${encodeURIComponent(path)}`, {
            headers: this._headers(),
            signal,
        });
        if (isUnauthorized(response.status)) throw this._unauthorized();
        if (!response.ok) throw new Error(`Read failed: ${response.statusText}`);
        return response.blob();
    }

    /** Read a file as text. */
    async readText(path, { signal } = {}) {
        const blob = await this.readBlob(path, { signal });
        return blob.text();
    }

    /** Write content to a file (PUT /fs/write). Parent dirs auto-created. */
    async write(path, content, { signal } = {}) {
        const response = await fetch(`${this.baseUrl}/api/fs/write?path=${encodeURIComponent(path)}`, {
            method: 'PUT',
            headers: this._headers({ 'Content-Type': 'text/plain' }),
            body: content,
            signal,
        });
        if (isUnauthorized(response.status)) throw this._unauthorized();
        if (!response.ok) throw new Error(`Write failed: ${response.statusText}`);
        return response.json();
    }

    /** Create a directory. */
    mkdir(path) {
        return this._json('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ path }) });
    }

    /** Rename / move. */
    rename(from, to) {
        return this._json('/api/fs/rename', { method: 'POST', body: JSON.stringify({ from, to }) });
    }

    /** Copy. */
    copy(from, to) {
        return this._json('/api/fs/copy', { method: 'POST', body: JSON.stringify({ from, to }) });
    }

    /**
     * Remove multiple items (per-item, resilient). Returns one result per path,
     * never throws on a single-item failure (mirrors legacy deleteBatch).
     * @param {string[]} paths
     */
    async remove(paths) {
        const results = [];
        for (const path of paths) {
            try {
                await this._json('/api/fs/remove', { method: 'DELETE', body: JSON.stringify({ path }) });
                results.push({ path, success: true });
            } catch (error) {
                results.push({ path, success: false, error: error.message });
            }
        }
        return results;
    }

    /** Glob search. */
    search(path, pattern, maxDepth) {
        let endpoint = `/api/fs/search?path=${encodeURIComponent(path)}&pattern=${encodeURIComponent(pattern)}`;
        if (maxDepth != null) endpoint += `&max_depth=${maxDepth}`;
        return this._json(endpoint);
    }

    /** Download a single file/folder (streamed, with progress + abort). */
    async download(path, { onProgress, signal } = {}) {
        const response = await fetch(`${this.baseUrl}/api/fs/download?path=${encodeURIComponent(path)}`, {
            headers: this._headers(),
            signal,
        });
        if (isUnauthorized(response.status)) throw this._unauthorized();
        if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
        return readStreamWithProgress(response, onProgress);
    }

    /** Download multiple files as a ZIP (streamed, with progress + abort). */
    async downloadBatch(paths, { onProgress, signal } = {}) {
        const response = await fetch(`${this.baseUrl}/api/fs/download-batch`, {
            method: 'POST',
            headers: this._headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(paths),
            signal,
        });
        if (isUnauthorized(response.status)) throw this._unauthorized();
        if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
        return readStreamWithProgress(response, onProgress);
    }

    /**
     * Upload files (multipart). #5: loadend wraps JSON.parse in try/catch so a
     * non-JSON 2xx rejects instead of throwing out of the callback. #12: an
     * optional `{signal}` aborts the XHR.
     * @param {string} targetPath
     * @param {Array} files - File objects or {file, name} path-preserving items.
     * @param {{onProgress?, signal?}} [opts]
     */
    upload(targetPath, files, { onProgress, signal } = {}) {
        const formData = new FormData();
        let totalSize = 0;
        for (const item of files) {
            if (item instanceof File) {
                formData.append('files', item);
                totalSize += item.size;
            } else if (item && item.file) {
                formData.append('files', item.file, item.name);
                totalSize += item.file.size;
            }
        }

        // Client-side size pre-check (server 413 resets the connection → status 0).
        const limitMB = getUploadSizeLimit();
        const limitBytes = limitMB * 1024 * 1024;
        if (totalSize > limitBytes) {
            const label = limitMB >= 1024 ? `${limitMB / 1024} GB` : `${limitMB} MB`;
            return Promise.reject(new Error(`File too large (limit: ${label})`));
        }

        const url = `${this.baseUrl}/api/fs/upload?path=${encodeURIComponent(targetPath)}`;
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();

            const onAbort = () => xhr.abort();
            if (signal) {
                if (signal.aborted) { reject(new Error('Upload aborted')); return; }
                signal.addEventListener('abort', onAbort);
            }

            xhr.upload.addEventListener('progress', (e) => {
                if (!onProgress) return;
                const percent = e.lengthComputable && e.total > 0
                    ? (e.loaded / e.total) * 100
                    : Number.NaN;
                onProgress(percent, {
                    loaded: e.loaded,
                    total: e.total,
                    lengthComputable: e.lengthComputable,
                    timestamp: Date.now(),
                });
            });

            xhr.addEventListener('loadend', () => {
                if (signal) signal.removeEventListener('abort', onAbort);
                if (xhr.status >= 200 && xhr.status < 300) {
                    // #5: a non-JSON 2xx must reject, not throw out of the handler.
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch {
                        reject(new Error('Upload returned a non-JSON response'));
                    }
                } else if (isUnauthorized(xhr.status)) {
                    reject(this._unauthorized());
                } else if (xhr.status === 413) {
                    reject(new Error('File too large (server limit: 1 GB)'));
                } else if (xhr.status === 0) {
                    reject(new Error('Upload failed: Network error'));
                } else {
                    reject(new Error(`Upload failed: ${xhr.statusText}`));
                }
            });

            xhr.open('POST', url);
            xhr.setRequestHeader('Authorization', `Bearer ${this._token()}`);
            xhr.send(formData);
        });
    }

    /* ---- Media URLs (cookie/fetch-token auth for <img>/<video>/<iframe>) ---- */

    /**
     * Append the fetch-token query param for ALL remote machines.
     *
     * The backend sets its auth cookie with Path=/api, which won't be sent by the
     * browser when the sidecar is behind a reverse proxy with a path prefix (e.g.
     * /adm/api/fs/read — the cookie path /api doesn't match /adm/api/...). The
     * fetch-token in the URL (already supported by the backend for img/media
     * fallback) sidesteps both the cookie-path mismatch and WebKit third-party
     * cookie restrictions, so we use it for every remote machine regardless of
     * browser engine.
     */
    _appendFetchAuth(url) {
        // Self is same-origin — cookies + Bearer all work, no token needed.
        if (this.isSelf) return url;
        const creds = getFetchCredentials(this.machineId);
        if (!creds || !creds.fetchToken) return url;
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}token=${encodeURIComponent(creds.fetchToken)}`;
    }

    /** Direct browser-usable URL for reading a file. */
    mediaURL(path, cacheSecs = 0) {
        let url = `${this.baseUrl}/api/fs/read?path=${encodeURIComponent(path)}`;
        if (cacheSecs > 0) url += `&cache=${cacheSecs}`;
        return this._appendFetchAuth(url);
    }

    /** Direct browser-usable URL for a thumbnail. */
    thumbURL(path, cacheSecs = 604800) {
        const url = `${this.baseUrl}/api/fs/thumbnail?path=${encodeURIComponent(path)}&cache=${cacheSecs}`;
        return this._appendFetchAuth(url);
    }

    /* ---- System + Auth ---- */

    /** System stats (RAM/disk/CPU). */
    sysStats() {
        return this._json('/api/sys/stats');
    }

    /**
     * Check auth status. Does NOT throw on 401 — returns {valid:false} so the
     * caller (ensureAuth) can decide whether to show the overlay.
     */
    async authStatus() {
        const token = this._token();
        if (!token) return { valid: false };
        try {
            const response = await fetch(`${this.baseUrl}/api/auth/status`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            if (!response.ok) {
                clearToken(this.machineId);
                return { valid: false };
            }
            return await response.json();
        } catch (error) {
            console.error('Auth status check failed:', error);
            return { valid: false };
        }
    }

    /** Login with a secret; persists token + fetch credentials. */
    async login(secret) {
        if (!secret) throw new Error('Secret is required');
        const response = await fetch(`${this.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ secret }),
        });
        const data = await response.json();
        if (data && data.error) throw new Error(data.message || 'Login failed');
        saveToken(data.token, this.machineId);
        saveFetchCredentials(data.fetchToken, this.machineId);
        return data;
    }

    /** Logout: clear the HttpOnly cookie (best-effort) then the client JWT. */
    async logout() {
        try {
            await fetch(`${this.baseUrl}/api/auth/logout`, { method: 'POST', credentials: 'include' });
        } catch {
            // Silently ignore — always clear the client-side JWT.
        }
        clearToken(this.machineId);
    }
}
