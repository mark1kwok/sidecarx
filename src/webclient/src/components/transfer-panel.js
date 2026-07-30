/**
 * TransferPanel — global transfer-queue UI. (Phase 4 - D4)
 *
 * Subscribes to `store.transfers` and renders one row per TransferJob. Hidden
 * (renders nothing) when the queue is empty. Each row shows aggregated progress
 * plus Cancel (while queued/running) and Retry (when failed). Cut/copy/move all
 * surface here as the same kind of job.
 *
 * Light DOM (createRenderRoot returns `this`) so styles come from
 * static/style.css, matching the other components.
 */

import { LitElement, html } from 'lit';
import { store } from '../utils/store.js';
import { cancelTransfer, retryTransfer } from '../utils/file-ops.js';
import { findMachineById } from '../utils/config.js';

const STATUS_LABEL = {
    queued: 'Queued',
    running: 'Running',
    completed: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
};

/** Resolve a machineId to a display label (Self / configured name / fallback id). */
function machineLabel(machineId) {
    if (!machineId || machineId === 'self') return 'Self';
    return findMachineById(machineId)?.name || machineId;
}

/** Aggregate percent from a job's {done, total} progress. */
function progressPercent(job) {
    const { done, total } = job.progress || {};
    if (!total || total <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

class TransferPanel extends LitElement {
    static properties = {
        _jobs: { state: true },
    };

    // Light DOM — styles come from static/style.css.
    createRenderRoot() {
        return this;
    }

    constructor() {
        super();
        this._jobs = [];
        this._unsub = null;
    }

    connectedCallback() {
        super.connectedCallback();
        this._jobs = store.getState().transfers;
        // subscribeSelect uses shallow-equal; transfers is a new array on every
        // job mutation, so each progress patch re-renders. Unrelated dispatches
        // return the same transfers ref and skip the callback.
        this._unsub = store.subscribeSelect(
            (s) => s.transfers,
            (transfers) => { this._jobs = transfers; },
        );
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (this._unsub) { this._unsub(); this._unsub = null; }
    }

    _onCancel(id) {
        cancelTransfer(id);
    }

    _onRetry(id) {
        retryTransfer(id);
    }

    _renderRow(job) {
        const pct = progressPercent(job);
        const running = job.status === 'running' || job.status === 'queued';
        const failed = job.status === 'failed';
        const kindLabel = job.kind === 'move' ? 'Move' : 'Copy';
        const title = `${kindLabel}: ${machineLabel(job.src?.machineId)} → ${machineLabel(job.dst?.machineId)}`;
        const { done, total } = job.progress || {};

        return html`
            <div class="transfer-row transfer-${job.status}">
                <div class="transfer-row-head">
                    <span class="transfer-title" title=${title}>${title}</span>
                    <span class="transfer-status transfer-status-${job.status}">
                        ${STATUS_LABEL[job.status] || job.status}
                    </span>
                </div>
                <div class="transfer-progress" role="progressbar"
                    aria-valuenow=${pct} aria-valuemin="0" aria-valuemax="100">
                    <div class="transfer-progress-bar" style="width: ${pct}%"></div>
                </div>
                <div class="transfer-row-foot">
                    <span class="transfer-count">${done ?? 0}/${total ?? 0} item(s)</span>
                    <span class="transfer-actions">
                        ${running
                            ? html`<button class="transfer-btn transfer-cancel"
                                @click=${() => this._onCancel(job.id)}>Cancel</button>`
                            : ''}
                        ${failed
                            ? html`<button class="transfer-btn transfer-retry"
                                @click=${() => this._onRetry(job.id)}>Retry</button>`
                            : ''}
                    </span>
                </div>
                ${job.error ? html`<div class="transfer-error">${job.error}</div>` : ''}
            </div>
        `;
    }

    render() {
        // Hidden when empty — render nothing (no .transfer-panel element).
        if (!this._jobs || this._jobs.length === 0) {
            return html``;
        }
        return html`
            <div class="transfer-panel" role="region" aria-label="Transfers">
                <div class="transfer-panel-head">
                    <span class="transfer-panel-title">Transfers</span>
                    <span class="transfer-panel-count">${this._jobs.length}</span>
                </div>
                <div class="transfer-panel-body">
                    ${this._jobs.map((j) => this._renderRow(j))}
                </div>
            </div>
        `;
    }
}

customElements.define('transfer-panel', TransferPanel);
