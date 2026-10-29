import type { IDBPDatabase } from 'idb';
import { HistoryStore, purgeHistory, saveHistory } from './history';
import { RECOVERY_TTL_MS, transition, terminal, type SessionCheckpoint } from '../domain/session';
import { CheckpointSchema } from '../runtime/schemas';
import { ActionResultSchema, type ActionResult } from '../forms/operations';
import type { ApplyrDatabase } from './database';
import { LOCAL_STORES, purgeDocumentRecords, renewSessionInputs } from './documents';

import { accessQueue } from '../attention/queue';
const CURRENT = 'current';
export class StaleCheckpointError extends Error {}

export class CheckpointStore {
  constructor(private readonly database: IDBPDatabase<ApplyrDatabase>, private readonly now = Date.now) {}

  async assertNewRun(url: string | null | undefined, separateRun = false) {
    if (!separateRun && (await new HistoryStore(this.database, this.now).duplicates(url)).length) throw new Error('DUPLICATE_APPLICATION');
  }

  async activity(id: string) {
    const tx = this.database.transaction(LOCAL_STORES, 'readwrite');
    await purgeHistory(tx, this.now());
    const p = CheckpointSchema.safeParse(await tx.objectStore('checkpoints').get(CURRENT));
    if (!p.success || p.data.id !== id) { await tx.done; throw new StaleCheckpointError(); }
    const cp = p.data;
    if (terminal(cp)) { await tx.done; return cp; }
    const at = this.now(), expiresAt = at + RECOVERY_TTL_MS;
    const next = { ...cp, revision: cp.revision + 1, updatedAt: at, lastActivityAt: at, expiresAt };
    await tx.objectStore('checkpoints').put(next, CURRENT);
    await renewSessionInputs(tx, id, at, expiresAt);
    await saveHistory(tx, next); await tx.done; return next;
  }

  async read(): Promise<SessionCheckpoint | null> {
    const transaction = this.database.transaction(LOCAL_STORES, 'readwrite');
    await purgeHistory(transaction, this.now());
    const checkpoints = transaction.objectStore('checkpoints');
    const raw = await checkpoints.get(CURRENT);
    const parsed = CheckpointSchema.safeParse(raw);
    let checkpoint = parsed.success && parsed.data.expiresAt > this.now() ? parsed.data : null;
    if (checkpoint?.lease && checkpoint.lease.expiresAt <= this.now() && !terminal(checkpoint)) {
      checkpoint = transition(checkpoint, { type: 'INTERRUPT', reason: 'lease_expired' }, this.now());
      if (checkpoint.autofill?.status === 'running') checkpoint.autofill = { ...checkpoint.autofill, status: 'interrupted' };
      await checkpoints.put(checkpoint, CURRENT);
    }
    for (const key of await checkpoints.getAllKeys()) {
      if (key === CURRENT) continue;
      const archived = CheckpointSchema.safeParse(await checkpoints.get(key));
      if (!archived.success || archived.data.expiresAt <= this.now()) await checkpoints.delete(key);
    }
    if (raw !== undefined && !checkpoint) await checkpoints.delete(CURRENT);
    if (!checkpoint) await transaction.objectStore('profiles').delete('snapshot');
    await purgeDocumentRecords(transaction, checkpoint?.id ?? null, this.now());
    await transaction.done;
    return checkpoint;
  }

  // Compare-and-swap in a single IDB transaction prevents two UI surfaces replacing newer state.
  async replace(next: SessionCheckpoint | null, expected: { sessionId: string | null; revision: number | null }) {
    if (next) { next = { ...next, attention: accessQueue(next) }; CheckpointSchema.parse(next); }
    const transaction = this.database.transaction(LOCAL_STORES, 'readwrite');
    await purgeHistory(transaction, this.now());
    const checkpoints = transaction.objectStore('checkpoints');
    const raw = await checkpoints.get(CURRENT);
    const parsed = CheckpointSchema.safeParse(raw);
    const current = parsed.success && parsed.data.expiresAt > this.now() ? parsed.data : null;
    if ((current?.id ?? null) !== expected.sessionId || (current?.revision ?? null) !== expected.revision) {
      if (raw !== undefined && !current) { await checkpoints.delete(CURRENT); await transaction.objectStore('profiles').delete('snapshot'); }
      await purgeDocumentRecords(transaction, current?.id ?? null, this.now());
      await transaction.done;
      throw new StaleCheckpointError();
    }
    if (next?.lifecycle === 'RUNNING' && (!next.lease || next.lease.application !== next.target.identity || (current?.lease && current.lease.expiresAt > this.now() && current.lease.token !== next.lease.token))) {
      await transaction.done; throw new StaleCheckpointError();
    }
    if (next && next.id !== current?.id && next.recovery?.reason === 'restore') {
      const source = CheckpointSchema.safeParse(await checkpoints.get(`paused:${next.id}`));
      if (!source.success || source.data.revision !== next.revision - 1) { await transaction.done; throw new StaleCheckpointError(); }
    }
    if (current && next && next.id !== current.id) {
      // Switching jobs parks the old ledger. Its temporary inputs are released;
      // restoring it always requires reselection and explicit reattachment.
      const archived = terminal(current) ? current : { ...transition(current, { type: 'INTERRUPT', reason: 'different_job', reattach: true }, this.now()), lifecycle: 'PAUSED' as const, autofill: current.autofill ? { ...current.autofill, status: 'paused' as const } : undefined };
      archived.approval = undefined;
      archived.attention = undefined; archived.review = undefined;
      if (archived.autofill) archived.autofill = { ...archived.autofill, operations: archived.autofill.operations.map((o) => ({ ...o, recovery: undefined })) };
      await checkpoints.put(archived, `paused:${current.id}`);
    }
    if (next) {
      await checkpoints.put(next, CURRENT);
      await checkpoints.delete(`paused:${next.id}`);
      if (next.lastActivityAt && next.lastActivityAt !== current?.lastActivityAt) {
        await renewSessionInputs(transaction, next.id, next.lastActivityAt, next.expiresAt);
      }
      await saveHistory(transaction, next);
    }
    else await checkpoints.delete(CURRENT);
    const ended = next && ['CANCELLED', 'AUTOFILL_FINISHED'].includes(next.lifecycle);
    if (!next || next.id !== current?.id || ended) await transaction.objectStore('profiles').delete('snapshot');
    await purgeDocumentRecords(transaction, ended ? null : next?.id ?? null, this.now());
    await transaction.done;
    return next;
  }

  async recordResult(sessionId: string, runId: string, value: ActionResult) {
    const result = ActionResultSchema.parse(value);
    const tx = this.database.transaction(LOCAL_STORES, 'readwrite');
    await purgeHistory(tx, this.now());
    const checkpoints = tx.objectStore('checkpoints');
    const current = CheckpointSchema.safeParse(await checkpoints.get(CURRENT));
    const key = current.success && current.data.id === sessionId ? CURRENT : `paused:${sessionId}`;
    const parsed = key === CURRENT ? current : CheckpointSchema.safeParse(await checkpoints.get(key));
    const cp = parsed.success && parsed.data.expiresAt > this.now() ? parsed.data : null;
    const op = cp?.autofill?.id === runId ? cp.autofill.operations.find((o) => o.id === result.operationId && o.fieldId === result.fieldId) : undefined;
    // Exactly one result can resolve an intent. Duplicate/stale responses cannot
    // overwrite an accepted observation, revive execution or affect another job.
    if (cp?.autofill && op && !op.result) {
      const review = cp.review ? { ...cp.review, items: cp.review.items.map((row) => {
        if (row.fieldId !== op.fieldId || row.target.document !== op.binding.document || row.target.signature !== op.recoverySignature) return row;
        const accepted = op.kind === 'field' && result.status === 'accepted' && result.code === 'persisted_valid';
        return { ...row, status: accepted ? 'accepted' as const : result.status === 'rejected' ? 'rejected' as const : 'unverified' as const, approvedDraft: accepted && !!op.approvedDraft };
      }) } : undefined;
      const next = { ...cp, review, revision: cp.revision + 1, updatedAt: this.now(), autofill: { ...cp.autofill, operations: cp.autofill.operations.map((o) => o.id === op.id ? { ...o, result } : o) } };
      await checkpoints.put(next, key); await saveHistory(tx, next);
    }
    await tx.done;
  }

  async archived() {
    await this.read();
    const all = await this.database.getAll('checkpoints');
    const current = await this.read();
    return all.flatMap((raw) => { const p = CheckpointSchema.safeParse(raw); return p.success && p.data.id !== current?.id ? [p.data] : []; });
  }
  async restore(id: string, expected: { sessionId: string | null; revision: number | null }) {
    const raw = await this.database.get('checkpoints', `paused:${id}`), parsed = CheckpointSchema.safeParse(raw);
    if (!parsed.success || parsed.data.expiresAt <= this.now() || terminal(parsed.data)) throw new StaleCheckpointError();
    const cp = { ...transition(parsed.data, { type: 'INTERRUPT', reason: 'restore', reattach: true }, this.now()), lifecycle: 'PAUSED' as const };
    return this.replace(cp, expected);
  }
  async recover(owner: string, restart = false) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const cp = await this.read();
      if (!cp || terminal(cp) || (!restart && cp.lease?.owner === owner) || (!restart && !cp.lease && cp.aiRequest?.status !== 'pending' && cp.autofill?.status !== 'running')) return cp;
      const next = transition(cp, { type: 'INTERRUPT', reason: restart ? 'restart' : 'worker_interrupted', reattach: restart }, this.now());
      if (next.autofill?.status === 'running') next.autofill = { ...next.autofill, status: 'interrupted' };
      try { return await this.replace(next, { sessionId: cp.id, revision: cp.revision }); }
      catch (e) { if (!(e instanceof StaleCheckpointError) || attempt === 3) throw e; }
    }
  }
}
