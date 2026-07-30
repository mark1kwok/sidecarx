/**
 * Machine identity — the single source of machineId derivation. (ADR-0001)
 *
 * `machineId` is the stable key for all per-machine state (sessions, tabs,
 * clipboard, transfers). It is the slug of the machine's display name, except
 * for Self whose machineId is the literal string `'self'`.
 *
 * `machine.name` is BANNED as a map key outside of display text — every
 * sessions/Tab/clipboard/TransferJob machineId derivation routes through
 * `getMachineId`.
 *
 * Note: the slug is PURE here (lowercase + whitespace→`_`, empty→`'default'`).
 * The deliberate `'self'`→`'default'` *storage-key* asymmetry lives in
 * `storageKeyFor` (storage.js), NOT here — keep the two concerns separate.
 */

/**
 * Slug a machine name into a stable key segment.
 * Lowercase, runs of whitespace → single underscore, empty → `'default'`.
 * Does NOT map `'self'` → `'default'`; that is storage.js's job.
 * @param {string} [name] - Raw machine name (may contain spaces/case).
 * @returns {string} Slugified key.
 */
export function normalizeMachineKey(name = 'default') {
    const key = String(name || 'default')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
    return key || 'default';
}

/**
 * The single machineId accessor. (ADR-0001)
 * Self (`machine.isSelf`) → literal `'self'`; otherwise the slug of the name.
 * @param {{name?: string, isSelf?: boolean}} [machine] - Machine config object.
 * @returns {string} machineId.
 */
export function getMachineId(machine) {
    if (!machine || machine.isSelf) return 'self';
    return normalizeMachineKey(machine.name);
}
