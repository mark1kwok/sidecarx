/**
 * Storage Utility
 * Handles auth tokens keyed by machineId. Uses localStorage to keep independent
 * tokens per machine.
 *
 * The Self machine is deliberately asymmetric (ADR-0001): its machineId and its
 * storage-key suffix differ. That mapping is centralized in `storageKeyFor` so
 * already-issued token keys stay byte-for-byte compatible.
 */

import { normalizeMachineKey } from './identity.js';

const TOKEN_KEY_PREFIX = 'auth_token_';
const TOKEN_EXPIRY_KEY_PREFIX = 'auth_token_expiry_';
const FETCH_TOKEN_KEY_PREFIX = 'fetch_token_';
/** Hours an auth token is considered valid client-side (mirrors JWT lifetime). */
const TOKEN_EXPIRY_HOURS = 168;

/**
 * The single home of the Self-machine storage-key asymmetry. (ADR-0001)
 * Accepts a machineId (or a raw machine name — slugged first), and returns the
 * storage-key suffix. Byte-identical to the legacy slug behaviour.
 * @param {string} machineId - machineId (or machine name; slugged defensively).
 * @returns {string} Storage-key suffix.
 */
export function storageKeyFor(machineId = 'default') {
    const key = normalizeMachineKey(machineId);
    return key === 'self' ? 'default' : key;
}

function getTokenKey(machineId = 'default') {
    return `${TOKEN_KEY_PREFIX}${storageKeyFor(machineId)}`;
}

function getExpiryKey(machineId = 'default') {
    return `${TOKEN_EXPIRY_KEY_PREFIX}${storageKeyFor(machineId)}`;
}

function getFetchTokenKey(machineId = 'default') {
    return `${FETCH_TOKEN_KEY_PREFIX}${storageKeyFor(machineId)}`;
}

/**
 * Store auth token with a client-side expiry stamp (checked by `getToken`).
 * @param {string} token - JWT token
 * @param {string} [machineId] - machineId (or machine name)
 */
export function saveToken(token, machineId = 'default') {
    const expiry = Date.now() + (TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
    localStorage.setItem(getTokenKey(machineId), token);
    localStorage.setItem(getExpiryKey(machineId), expiry.toString());
}

/**
 * Get auth token if valid
 * @param {string} [machineId] - machineId (or machine name)
 * @returns {string|null} Token or null if expired/missing
 */
export function getToken(machineId = 'default') {
    const token = localStorage.getItem(getTokenKey(machineId));
    const expiry = localStorage.getItem(getExpiryKey(machineId));

    if (!token || !expiry) {
        return null;
    }

    if (Date.now() > parseInt(expiry)) {
        clearToken(machineId);
        return null;
    }

    return token;
}

/**
 * Clear auth token
 * @param {string} [machineId] - machineId (or machine name)
 */
export function clearToken(machineId = 'default') {
    localStorage.removeItem(getTokenKey(machineId));
    localStorage.removeItem(getExpiryKey(machineId));
    clearFetchCredentials(machineId);
}

/**
 * Check if user is authenticated
 * @param {string} [machineId]
 * @returns {boolean}
 */
export function isAuthenticated(machineId = 'default') {
    return getToken(machineId) !== null;
}

/**
 * Clear all machine auth tokens
 */
export function clearAllTokens() {
    const keys = Object.keys(localStorage);
    keys.forEach((key) => {
        if (
            key.startsWith(TOKEN_KEY_PREFIX)
            || key.startsWith(TOKEN_EXPIRY_KEY_PREFIX)
            || key.startsWith(FETCH_TOKEN_KEY_PREFIX)
            || key.startsWith('fetch_key_')
            || key.startsWith('fetch_expiry_')
        ) {
            localStorage.removeItem(key);
        }
    });
}

/**
 * Store fetch token credentials. (#10 / Phase 5: a dead third parameter that
 * was never wired to an expiry check (and no caller passed) was dropped. The
 * fetch token lives until `clearFetchCredentials` / `clearToken`.)
 * @param {string} fetchToken
 * @param {string} [machineId]
 */
export function saveFetchCredentials(fetchToken, machineId = 'default') {
    if (!fetchToken) {
        clearFetchCredentials(machineId);
        return;
    }

    localStorage.setItem(getFetchTokenKey(machineId), fetchToken);
}

/**
 * Retrieve fetch credentials if still valid.
 * @param {string} [machineId]
 * @returns {{fetchToken: string} | null}
 */
export function getFetchCredentials(machineId = 'default') {
    const fetchToken = localStorage.getItem(getFetchTokenKey(machineId));

    if (!fetchToken) {
        return null;
    }

    return { fetchToken };
}

/**
 * Clear fetch token credentials.
 * @param {string} [machineId]
 */
export function clearFetchCredentials(machineId = 'default') {
    const key = storageKeyFor(machineId);
    localStorage.removeItem(getFetchTokenKey(machineId));
    localStorage.removeItem(`fetch_key_${key}`);
    localStorage.removeItem(`fetch_expiry_${key}`);
}
