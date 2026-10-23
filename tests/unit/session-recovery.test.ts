import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteDB, type IDBPDatabase } from 'idb';
import { createCheckpoint, transition, LEASE_MS, terminal } from '../../src/domain/session';
import { CheckpointSchema } from '../../src/runtime/schemas';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { CheckpointStore, StaleCheckpointError } from '../../src/storage/checkpoints';

const id = () => crypto.randomUUID(), identity = 'a'.repeat(64);
const cp = () => createCheckpoint({ tabId: 7, windowId: 1, origin: 'https://jobs.test', identity, availability: 'https' }, id(), 1000);
const lease = () => ({ owner: id(), token: id(), application: identity, expiresAt: 2000 + LEASE_MS });
let db: IDBPDatabase<ApplyrDatabase>;
afterEach(async () => { if (db) { const name = db.name; db.close(); await deleteDB(name); } });
async function setup() { db = await openDatabase(`recovery-${id()}`); const store = new CheckpointStore(db, () => 2000), initial = cp(); await store.replace(initial, { sessionId: null, revision: null }); return { store, initial }; }

describe('F10 pure lifecycle', () => {
  it('keeps phase, review scope and user submission independent', () => {
    let s = transition(cp(), { type: 'START', lease: lease() }, 2000);
    s = transition(s, { type: 'PHASE', phase: 'VALIDATING' }, 2001);
    s = transition(s, { type: 'REVIEW' }, 2002);
    expect(s).toMatchObject({ lifecycle: 'READY_FOR_REVIEW', phase: 'VALIDATING', reviewScope: 'current_step', submission: { status: 'unknown' } });
    s = transition(s, { type: 'REVIEW', scope: 'final_review' }, 2003);
    s = transition(s, { type: 'FINISH' }, 2004);
    expect(s.lifecycle).toBe('AUTOFILL_FINISHED'); expect(s.submission.status).toBe('unknown');
    s = transition(s, { type: 'REPORT_SUBMISSION' }, 2005);
    expect(s.submission).toEqual({ status: 'reported_by_user', reportedAt: 2005, source: 'user' });
    expect(CheckpointSchema.safeParse(s).success).toBe(true);
  });
  it('pause waits for a safe boundary and resume cannot execute', () => {
    const start = transition(cp(), { type: 'START', lease: lease() }, 2000);
    const requested = transition(start, { type: 'PAUSE' }, 2001);
    expect(requested.lifecycle).toBe('RUNNING'); expect(requested.pauseRequested).toBe(true);
    const paused = transition(requested, { type: 'BOUNDARY' }, 2002);
    expect(paused.lifecycle).toBe('PAUSED'); expect(paused.lease).toBeUndefined();
    const resumed = transition(paused, { type: 'RESUME' }, 2003);
    expect(resumed).toMatchObject({ lifecycle: 'QUEUED', phase: 'INSPECTING', recovery: { inspectionRequired: true } });
    expect(() => transition(resumed, { type: 'START', lease: lease() }, 2004)).toThrow();
  });
  for (const lifecycle of ['CANCELLED', 'FAILED', 'AUTOFILL_FINISHED'] as const) it(`${lifecycle} cannot resume or write`, () => {
    const s = { ...cp(), lifecycle }; expect(terminal(s)).toBe(true);
    for (const type of ['RESUME', 'START', 'PAUSE'] as const) expect(() => transition(s, { type, lease: lease() }, 2000)).toThrow();
  });
  it('restart requires deliberate reattachment and never infers submission', () => {
    const s = transition(cp(), { type: 'INTERRUPT', reason: 'restart', reattach: true }, 2000);
    expect(() => transition(s, { type: 'RESUME' }, 2001)).toThrow();
    expect(s.submission.status).toBe('unknown');
  });
});

describe('F10 durable fencing and recovery', () => {
  it('one browser/application lease is acquired transactionally by one contender', async () => {
    const { store, initial } = await setup();
    const runs = [lease(), lease()].map((l) => transition(initial, { type: 'START', lease: l }, 2000));
    const outcomes = await Promise.allSettled(runs.map((s) => store.replace(s, { sessionId: initial.id, revision: 0 })));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const current = (await store.read())!;
    await expect(store.replace({ ...current, lease: lease(), revision: current.revision + 1 }, { sessionId: current.id, revision: current.revision })).rejects.toBeInstanceOf(StaleCheckpointError);
  });
  it('expires abandoned leases without extending recovery retention or restarting', async () => {
    const { store, initial } = await setup(); const running = transition(initial, { type: 'START', lease: lease() }, 2000);
    await store.replace(running, { sessionId: initial.id, revision: 0 });
    const expired = await new CheckpointStore(db, () => 2000 + LEASE_MS).read();
    expect(expired).toMatchObject({ lifecycle: 'NEEDS_ATTENTION', recovery: { reason: 'lease_expired', inspectionRequired: true }, expiresAt: initial.expiresAt });
    expect(expired?.lease).toBeUndefined();
  });
  it('new worker fences old in-memory authority and marks paid intent uncertain', async () => {
    const { store, initial } = await setup();
    const running = { ...transition(initial, { type: 'START', lease: lease() }, 2000), aiRequest: { id: id(), status: 'pending' as const, inputVersion: id() } };
    await store.replace(running, { sessionId: initial.id, revision: 0 });
    const recovered = await store.recover(id());
    expect(recovered).toMatchObject({ lifecycle: 'NEEDS_ATTENTION', aiRequest: { status: 'uncertain' }, recovery: { inspectionRequired: true } });
    await expect(store.replace(running, { sessionId: initial.id, revision: running.revision })).rejects.toBeInstanceOf(StaleCheckpointError);
  });
  it('switching jobs parks old progress; restoring never resumes or transfers inputs', async () => {
    const { store, initial } = await setup();
    const other = cp(); await store.replace(other, { sessionId: initial.id, revision: 0 });
    const old = (await store.archived())[0]!;
    expect(old).toMatchObject({ id: initial.id, lifecycle: 'PAUSED', recovery: { reason: 'different_job', reattachRequired: true } });
    const restored = await store.restore(old.id, { sessionId: other.id, revision: other.revision });
    expect(restored).toMatchObject({ id: old.id, lifecycle: 'PAUSED', recovery: { reattachRequired: true } });
    expect(await db.get('profiles', 'snapshot')).toBeUndefined();
    expect((await store.archived()).map((c) => c.id)).toContain(other.id);
  });
  it('reopen/worker and browser restart never invent execution from a queued checkpoint', async () => {
    const { store, initial } = await setup();
    expect(await store.recover(id())).toEqual(initial);
    const restart = await store.recover(id(), true);
    expect(restart?.recovery?.reattachRequired).toBe(true);
    const name = db.name; db.close(); db = await openDatabase(name);
    expect(await new CheckpointStore(db, () => 2000).read()).toEqual(restart);
  });
});

it('F10 a restored session can be cancelled before attachment and terminal input deletion is atomic', async () => {
  const { store, initial } = await setup(), other = cp();
  await store.replace(other, { sessionId: initial.id, revision: initial.revision });
  const restored = (await store.restore(initial.id, { sessionId: other.id, revision: other.revision }))!;
  await db.put('profiles', { sensitive: true }, 'snapshot');
  const cancelled = transition(restored, { type: 'CANCEL' }, 2001);
  await store.replace(cancelled, { sessionId: restored.id, revision: restored.revision });
  expect((await store.read())?.lifecycle).toBe('CANCELLED'); expect(await db.get('profiles', 'snapshot')).toBeUndefined();
});

it('F10 interruption clears stale final-step scope but preserves the independent user submission report', () => {
  let s = transition(cp(), { type: 'REVIEW', scope: 'final_review' }, 2000);
  s = transition(s, { type: 'REPORT_SUBMISSION' }, 2001);
  s = transition(s, { type: 'INTERRUPT', reason: 'reload' }, 2002);
  expect(s.reviewScope).toBeUndefined(); expect(s.submission.status).toBe('reported_by_user');
});

it('F10 explicit fatal failure retains a bounded checkpoint, releases authority and cannot imply submission', () => {
  const running = transition(cp(), { type: 'START', lease: lease() }, 2000);
  expect(() => transition(running, { type: 'START', lease: lease() }, 2001)).toThrow();
  const failed = transition(running, { type: 'FAIL', reason: 'storage_unavailable' }, 2002);
  expect(failed).toMatchObject({ lifecycle: 'FAILED', recovery: { reason: 'storage_unavailable' }, submission: { status: 'unknown' } });
  expect(failed.lease).toBeUndefined(); expect(failed.expiresAt).toBe(running.expiresAt);
});
