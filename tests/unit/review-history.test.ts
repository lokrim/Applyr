import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { createCheckpoint, RECOVERY_TTL_MS, reviewReady, transition, type SessionCheckpoint } from '../../src/domain/session';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { CheckpointStore } from '../../src/storage/checkpoints';
import { HistoryStore, HISTORY_TTL_MS, canonicalJobUrl } from '../../src/storage/history';
import { deleteLocalData } from '../../src/storage/data-controls';
import { DocumentStore } from '../../src/storage/documents';
import { ProfileStore } from '../../src/storage/profiles';
import { recoverySignature } from '../../src/forms/operations';
import { observeReview, reviewSummary } from '../../src/review';
import { AttentionCode } from '../../src/attention/schema';
import { inspectionQueue } from '../../src/attention/queue';
import { previewBinding, type MappingInput } from '../../src/mapping/rules';
import type { FormSnapshot, Inspection } from '../../src/forms/schema';
import { syntheticPdf } from '../fixtures/pdf';
import { createCoordinator } from '../../src/runtime/coordinator';

const id = () => crypto.randomUUID(), hash = 'a'.repeat(64), detail = 'P12_DETAILED_ANSWER_CANARY', key = 'P12_KEY_CANARY';
const profile = () => ({ data: { profile_version: 1 as const, contact: { email: 'fiction@example.test' } }, notes: detail, answerBodies: {} });
function field(p: Partial<FormSnapshot['fields'][number]> = {}): FormSnapshot['fields'][number] {
  return { id: id(), label: 'Email', labelSource: 'label', context: [], type: 'email', autocomplete: 'email', required: true, executable: true, category: 'short_answer', filePurpose: null, constraints: { min: '', max: '', step: '', minLength: '', maxLength: '', pattern: '', accept: '', multiple: false }, options: [], current: { fingerprint: hash, present: true }, validation: { valid: true, flags: [], ariaInvalid: false, errorPresent: false }, ...p };
}
function fixture(fields = [field()]) {
  const cp = createCheckpoint({ tabId: 7, windowId: 1, origin: 'https://jobs.test', url: 'https://jobs.test/apply?job_id=17', availability: 'https', identity: hash, company: 'Fictional Company', role: 'Engineer' }, id(), 1000);
  cp.access = { status: 'ready', classification: 'application', reason: 'application', frames: [] };
  const form = id();
  const inspection: Inspection = { sessionId: cp.id, tabId: 7, frameId: 0, browserDocumentId: 'browser-doc', snapshot: { schemaVersion: 1, identity: hash, document: id(), revision: 1, status: 'stable', selectedForm: form, forms: [{ id: form, label: 'Application', fieldCount: fields.length }], fields, unsupported: [], observation: { mutations: 0, scans: 3, bounded: true } } };
  const input: MappingInput = { sessionId: cp.id, version: id(), source: 'replacement', document: profile(), expiresAt: 1000 + RECOVERY_TTL_MS };
  cp.autofill = { id: id(), inputVersion: input.version, status: 'review', requiredUnresolved: 0, unsupported: 0, operations: [] };
  return { cp, inspection, input };
}
async function operation(s: ReturnType<typeof fixture>, n: number, status: 'accepted' | 'rejected' | 'unverified', draft = false) {
  const f = s.inspection.snapshot.fields[n]!, operationId = id();
  return { id: operationId, fieldId: f.id, kind: f.type === 'file' ? 'upload' as const : 'field' as const, approvedDraft: draft, binding: previewBinding(s.inspection, s.input), precondition: hash, recoverySignature: await recoverySignature(f), intentAt: 1100, recovery: { kind: 'text' as const, text: detail }, result: { operationId, fieldId: f.id, status, code: status === 'accepted' ? 'persisted_valid' as const : status === 'rejected' ? 'value_rejected' as const : 'unknown_effect' as const, selectedBytes: null, siteAcceptance: 'not_applicable' as const } };
}

describe('verified field review and final-readiness boundary', () => {
  it('counts accepted values/drafts once, manual values separately, rejects failed setters/rerenders and uploads', async () => {
    const s = fixture([field(), field({ label: 'Existing phone', type: 'tel' }), field({ label: 'Draft', type: 'textarea' }), field({ label: 'Rejected', current: { fingerprint: hash, present: false }, validation: { valid: false, flags: ['valueMissing'], ariaInvalid: false, errorPresent: false } }), field({ label: 'Resume', type: 'file', category: 'file' })]);
    s.cp.autofill!.operations = [await operation(s, 0, 'accepted'), await operation(s, 2, 'accepted', true), await operation(s, 3, 'rejected', true), await operation(s, 4, 'unverified')];
    s.cp.review = await observeReview(s.cp, s.inspection);
    expect(reviewSummary(s.cp)).toMatchObject({ accepted: 2, manual: 1, drafts: 1, required: 2, uploads: 1, ready: false });
    expect(() => transition(s.cp, { type: 'REVIEW', scope: 'final_review' }, 1200)).toThrow();
    // A later invalidated accepted field must leave accepted counts.
    s.inspection.snapshot.fields[0]!.validation.ariaInvalid = true;
    s.cp.review = await observeReview(s.cp, s.inspection);
    expect(reviewSummary(s.cp).accepted).toBe(1);
  });
  it('remounted and changed fields cannot inherit acceptance; manual valid observations stay distinct', async () => {
    const s = fixture(); s.cp.autofill!.operations = [await operation(s, 0, 'accepted')];
    s.cp.review = await observeReview(s.cp, s.inspection); expect(reviewSummary(s.cp).accepted).toBe(1);
    s.inspection.snapshot.fields[0]!.label = 'Relabelled question';
    s.cp.review = await observeReview(s.cp, s.inspection); expect(reviewSummary(s.cp).accepted).toBe(0);
    s.inspection.snapshot.fields[0]!.current.fingerprint = 'b'.repeat(64);
    s.cp.review = await observeReview(s.cp, s.inspection); expect(reviewSummary(s.cp)).toMatchObject({ accepted: 0, manual: 1 });
    s.inspection.snapshot.fields[0]!.id = id();
    s.inspection.snapshot.fields[0]!.current.present = false;
    s.cp.review = await observeReview(s.cp, s.inspection); expect(reviewSummary(s.cp)).toMatchObject({ accepted: 0, manual: 0, ready: false });
  });
  for (const code of AttentionCode.options) it(`seeded ${code} blocker prevents final-ready, even with valid native values`, async () => {
    const s = fixture(); s.cp.review = await observeReview(s.cp, s.inspection);
    s.cp.attention = { version: 1, revision: 1, items: [{ id: id(), key: code, revision: 1, code, question: 'Synthetic blocker', reason: 'Needs review', action: 'Complete manually', required: false, status: 'open', sourcePath: null, inputKind: 'text', correctable: false }] };
    expect(reviewReady(s.cp)).toBe(false); expect(reviewSummary(s.cp).required).toBe(0); expect(() => transition(s.cp, { type: 'REVIEW', scope: 'final_review' }, 1200)).toThrow();
  });
  it('unused optional file slots are not counted as attempted or unverified uploads', async () => {
    const s = fixture([field(), field({ type: 'file', required: false, category: 'file', current: { present: false, fingerprint: hash } })]);
    s.cp.review = await observeReview(s.cp, s.inspection);
    expect(reviewSummary(s.cp)).toMatchObject({ uploads: 0, manual: 1, ready: true });
  });
  it('requires stable supported inspection and current page access', async () => {
    const s = fixture(); s.cp.review = await observeReview(s.cp, s.inspection);
    for (const change of [{ access: { ...s.cp.access!, status: 'needs_attention' as const } }, { recovery: { reason: 'input_deleted', inspectionRequired: true, reattachRequired: false } }]) expect(reviewReady({ ...s.cp, ...change })).toBe(false);
    s.inspection.snapshot.unsupported = [{ code: 'custom_control', label: 'Manual area' }]; s.cp.review = await observeReview(s.cp, s.inspection); expect(reviewReady(s.cp)).toBe(false);
  });
  it('requires fresh evidence and explicit final choice; finish and submission never imply each other', async () => {
    const s = fixture(); expect(reviewReady(s.cp)).toBe(false);
    s.cp.review = await observeReview(s.cp, s.inspection);
    expect(reviewReady(s.cp)).toBe(true);
    let cp = transition(s.cp, { type: 'REVIEW' }, 1200); expect(cp.reviewScope).toBe('current_step');
    cp = transition(cp, { type: 'REVIEW', scope: 'final_review' }, 1300);
    cp = transition(cp, { type: 'FINISH' }, 1400); expect(cp.submission.status).toBe('unknown');
    cp = transition(cp, { type: 'REPORT_SUBMISSION' }, 1500);
    expect(cp.submission).toEqual({ status: 'reported_by_user', source: 'user', reportedAt: 1500 });
    expect(transition({ ...s.cp, lifecycle: 'READY_FOR_REVIEW' }, { type: 'REPORT_SUBMISSION' }, 1500).lifecycle).toBe('READY_FOR_REVIEW');
  });
});

describe('minimal history, retention and independent deletion', () => {
  let db: IDBPDatabase<ApplyrDatabase>, now: number, store: CheckpointStore, history: HistoryStore, cp: SessionCheckpoint;
  beforeEach(async () => { now = 2000; db = await openDatabase(`p12-${id()}`); store = new CheckpointStore(db, () => now); history = new HistoryStore(db, () => now); cp = fixture().cp; await store.replace(cp, { sessionId: null, revision: null }); });
  afterEach(async () => { const name = db.name; db.close(); await deleteDB(name); });
  it('migrates v4 to v5 without losing stored data', async () => {
    const name = `v4-${id()}`;
    const old = await openDB(name, 4, { upgrade(d) { for (const s of ['checkpoints', 'profiles', 'documents', 'documentBlobs', 'documentLinks', 'providerSettings', 'providerCredentials']) d.createObjectStore(s); } });
    await old.put('providerCredentials', key, 'openai'); old.close();
    const upgraded = await openDatabase(name); expect(upgraded.version).toBe(5); expect(await upgraded.get('providerCredentials', 'openai')).toBe(key); expect(await upgraded.count('history')).toBe(0); upgraded.close(); await deleteDB(name);
  });
  it('canonicalizes tracking/secrets/order while preserving distinct job query identities', async () => {
    expect(canonicalJobUrl('https://jobs.test/apply?utm_source=x&token=SECRET&job_id=17#secret')).toBe(cp.target.url);
    expect(canonicalJobUrl('https://jobs.test/apply?job_id=18')).not.toBe(cp.target.url);
    expect(canonicalJobUrl('https://jobs.test/apply?id=4&job_id=17')).toBe(canonicalJobUrl('https://jobs.test/apply?job_id=17&id=4'));
    await expect(store.assertNewRun('https://jobs.test/apply?job_id=17&utm_campaign=x')).rejects.toThrow('DUPLICATE_APPLICATION');
    await expect(store.assertNewRun(cp.target.url, true)).resolves.toBeUndefined();
    await expect(store.assertNewRun('https://jobs.test/apply?job_id=18')).resolves.toBeUndefined();
  });
  it('blocks duplicate capture at the trusted coordinator, before replacing/executing', async () => {
    const pages = { popup: 'chrome-extension://test/popup.html', session: 'chrome-extension://test/session.html', options: 'chrome-extension://test/options.html' };
    const handler = createCoordinator({ extensionId: 'test', pages, store: async () => store, target: async () => cp.target, now: () => now, uuid: id });
    const intent = { schemaVersion: 1, requestId: id(), type: 'CAPTURE_TARGET', sessionId: cp.id, revision: cp.revision, tabId: 7 };
    expect(await handler(intent, { id: 'test', url: pages.popup })).toMatchObject({ ok: false, code: 'DUPLICATE_APPLICATION' });
    expect((await store.read())?.id).toBe(cp.id);
    expect(await handler({ ...intent, separateRun: true }, { id: 'test', url: pages.popup })).toMatchObject({ ok: true });
    expect((await history.read())).toHaveLength(2);
  });
  it('late verified results update a pre-effect review row without reviving a cancelled session', async () => {
    const s = fixture([field({ current: { fingerprint: hash, present: false }, validation: { valid: false, flags: ['valueMissing'], ariaInvalid: false, errorPresent: false } })]);
    const op = await operation(s, 0, 'accepted');
    s.cp.autofill!.operations = [{ ...op, result: null }]; s.cp.review = await observeReview(s.cp, s.inspection);
    const current = (await store.read())!;
    await store.replace(s.cp, { sessionId: current.id, revision: current.revision });
    await store.replace(transition(s.cp, { type: 'CANCEL' }, now), { sessionId: s.cp.id, revision: s.cp.revision });
    await store.recordResult(s.cp.id, s.cp.autofill!.id, op.result);
    const cancelled = (await store.read())!;
    expect(cancelled.lifecycle).toBe('CANCELLED'); expect(reviewSummary(cancelled).accepted).toBe(1); expect(cancelled.autofill!.operations[0]!.recovery).toBeUndefined();
  });
  it('exports only minimal allowlisted metadata and fixed-category diagnostics', async () => {
    const s = fixture(); cp.autofill!.operations = [await operation(s, 0, 'accepted', true)];
    cp.approval = { batchId: id(), inputVersion: id(), document: id(), revision: 1, at: now, decisions: [{ fieldId: id(), action: 'approve', text: detail }] };
    cp.providers = [{ provider: 'openai', model: 'fixture-model' }];
    await db.put('providerCredentials', key, 'openai');
    await store.replace({ ...cp, revision: 1 }, { sessionId: cp.id, revision: 0 });
    const text = await history.export(), diagnostics = await history.diagnostics();
    expect(text).toContain('fixture-model'); expect(diagnostics).not.toContain('fixture-model');
    for (const result of [text, diagnostics]) for (const denied of [detail, key, 'precondition', 'recovery', 'answerBodies', 'fieldId', 'fileBytes']) expect(result).not.toContain(denied);
  });
  it('purges sensitive recovery on access at seven days and minimal incomplete history after another 30', async () => {
    const profiles = new ProfileStore(db, () => now); await profiles.saveDefault(profile(), null); await profiles.freeze(cp.id, { source: 'saved', savedVersion: (await profiles.read()).saved!.version }, null);
    const docs = new DocumentStore(db, () => now), file = new File([syntheticPdf()], 'fiction.pdf', { type: 'application/pdf' });
    await docs.start(cp.id, { source: 'replacement', file }, null, { expectedId: null });
    await db.put('providerCredentials', key, 'openai');
    const expiresAt = (await store.read())!.expiresAt; now = expiresAt;
    expect(await store.read()).toBeNull(); expect(await db.get('profiles', 'snapshot')).toBeUndefined(); expect((await docs.read()).document).toBeNull();
    expect((await profiles.read()).saved).not.toBeNull(); expect((await docs.read()).saved).not.toBeNull(); expect(await db.get('providerCredentials', 'openai')).toBe(key);
    expect((await history.read())[0]).toMatchObject({ state: 'EXPIRED', endedAt: expiresAt, expiresAt: expiresAt + HISTORY_TTL_MS });
    now += HISTORY_TTL_MS; expect(await history.read()).toEqual([]);
  });
  it('terminal retention starts at the first terminal time; viewing/reporting does not prolong history', async () => {
    cp = transition(cp, { type: 'CANCEL' }, now); await store.replace(cp, { sessionId: cp.id, revision: 0 });
    const end = now; now += 1000;
    await store.replace(transition(cp, { type: 'REPORT_SUBMISSION' }, now), { sessionId: cp.id, revision: cp.revision });
    const h = (await history.read())[0]!; expect(h.expiresAt).toBe(end + HISTORY_TTL_MS); expect(h.submission.source).toBe('user');
    now = end + HISTORY_TTL_MS; expect(await history.read()).toEqual([]);
  });
  it('only explicit activity renews temporary retention, including frozen input and document copies', async () => {
    const profiles = new ProfileStore(db, () => now); await profiles.freeze(cp.id, { source: 'replacement', document: profile() }, null);
    const docs = new DocumentStore(db, () => now); await docs.start(cp.id, { source: 'replacement', file: new File([syntheticPdf()], 'fiction.pdf', { type: 'application/pdf' }) }, null);
    const old = (await store.read())!.expiresAt; now += 1000;
    expect((await store.read())!.expiresAt).toBe(old); await history.read(); expect((await profiles.read()).snapshot!.expiresAt).toBe(old);
    await store.activity(cp.id);
    expect((await profiles.read()).snapshot!.expiresAt).toBe(now + RECOVERY_TTL_MS); expect((await docs.read()).document!.expiresAt).toBe(now + RECOVERY_TTL_MS);
  });
  it('profile/document selection renews eligible copies together without changing pinned document versions', async () => {
    const profiles = new ProfileStore(db, () => now), docs = new DocumentStore(db, () => now);
    await profiles.freeze(cp.id, { source: 'replacement', document: profile() }, null);
    now += 1000;
    const selected = await docs.start(cp.id, { source: 'replacement', file: new File([syntheticPdf()], 'fiction.pdf', { type: 'application/pdf' }) }, null);
    expect((await profiles.read()).snapshot!.expiresAt).toBe(now + RECOVERY_TTL_MS);
    now += 1000; const version = (await profiles.read()).snapshot!.version;
    await profiles.freeze(cp.id, { source: 'replacement', document: profile() }, version);
    const document = (await docs.read()).document!;
    expect(document.inputVersion).toBe(selected.document.inputVersion); expect(document.expiresAt).toBe(now + RECOVERY_TTL_MS);
    expect((await profiles.read()).snapshot!.expiresAt).toBe(document.expiresAt);
  });
  it('storage access and new document selection purge an expired legacy profile copy instead of renewing it', async () => {
    const profiles = new ProfileStore(db, () => now), docs = new DocumentStore(db, () => now);
    const frozen = await profiles.freeze(cp.id, { source: 'replacement', document: profile() }, null);
    const latest = (await store.read())!;
    // Simulate a valid older checkpoint whose later activity extended only its own expiry.
    await db.put('checkpoints', { ...latest, updatedAt: frozen.expiresAt - 1000, lastActivityAt: frozen.expiresAt - 1000, expiresAt: frozen.expiresAt + 1000 }, 'current');
    now = frozen.expiresAt;
    await docs.start(cp.id, { source: 'replacement', file: new File([syntheticPdf()], 'fresh.pdf', { type: 'application/pdf' }) }, null);
    expect(await db.get('profiles', 'snapshot')).toBeUndefined();
    await store.activity(cp.id); expect((await profiles.read()).snapshot).toBeNull();
    expect((await docs.read()).document).not.toBeNull();
  });
  it('profile deletion removes all sensitive parked/current copies while keeping saved documents/history/keys', async () => {
    const profiles = new ProfileStore(db, () => now); await profiles.saveDefault(profile(), null); await profiles.freeze(cp.id, { source: 'replacement', document: profile() }, null);
    const docs = new DocumentStore(db, () => now); await docs.saveDefault(new File([syntheticPdf()], 'fiction.pdf', { type: 'application/pdf' }), null);
    const s = fixture(); cp = (await store.read())!; cp.autofill!.operations = [await operation(s, 0, 'accepted')]; cp.attention = await inspectionQueue(cp, s.inspection, s.input);
    cp.approval = { batchId: id(), inputVersion: id(), document: id(), revision: 1, at: now, decisions: [{ fieldId: id(), action: 'approve', text: detail }] };
    await store.replace({ ...cp, revision: cp.revision + 1 }, { sessionId: cp.id, revision: cp.revision });
    await db.put('providerCredentials', key, 'openai');
    await deleteLocalData(db, 'profile', now);
    expect(await db.getAll('profiles')).toEqual([]); expect(JSON.stringify(await db.getAll('checkpoints'))).not.toContain(detail);
    expect((await store.read())!.recovery?.inspectionRequired).toBe(true); expect((await history.read())[0]!.blockers).toContain('recovery'); expect((await docs.read()).saved).not.toBeNull(); expect((await history.read())).toHaveLength(1); expect(await db.get('providerCredentials', 'openai')).toBe(key);
  });
  it('history deletion cascades unsaved recovery but retains saved defaults and keys; late results cannot recreate it', async () => {
    const profiles = new ProfileStore(db, () => now); await profiles.saveDefault(profile(), null); await profiles.freeze(cp.id, { source: 'replacement', document: profile() }, null);
    const docs = new DocumentStore(db, () => now); await docs.start(cp.id, { source: 'replacement', file: new File([syntheticPdf()], 'fiction.pdf', { type: 'application/pdf' }) }, null, { expectedId: null });
    await db.put('providerCredentials', key, 'openai'); await deleteLocalData(db, 'history', now);
    expect(await store.read()).toBeNull(); expect(await history.read()).toEqual([]); expect((await profiles.read()).snapshot).toBeNull(); expect((await profiles.read()).saved).not.toBeNull(); expect((await docs.read()).saved).not.toBeNull(); expect((await docs.read()).document).toBeNull(); expect(await db.get('providerCredentials', 'openai')).toBe(key);
    const s = fixture(), op = await operation(s, 0, 'accepted'); await store.recordResult(cp.id, cp.autofill!.id, op.result); expect(await history.read()).toEqual([]);
  });
  it('deleting shared saved document bytes invalidates its bound session without deleting profile/history', async () => {
    const profiles = new ProfileStore(db, () => now); await profiles.freeze(cp.id, { source: 'replacement', document: profile() }, null);
    const docs = new DocumentStore(db, () => now); await docs.start(cp.id, { source: 'replacement', file: new File([syntheticPdf()], 'fiction.pdf', { type: 'application/pdf' }) }, null, { expectedId: null });
    const saved = (await docs.read()).saved!; await docs.deleteDocument(saved.id, saved.inputVersion);
    expect((await store.read())!.recovery?.reason).toBe('document_deleted'); expect((await docs.read()).saved).toBeNull(); expect((await docs.read()).document).toBeNull(); expect((await profiles.read()).snapshot).not.toBeNull(); expect(await history.read()).toHaveLength(1);
  });
  it('can deliberately select a retained parked session when the current slot was forgotten', async () => {
    const other = createCheckpoint({ ...cp.target, url: 'https://jobs.test/apply?job_id=18' }, id(), now);
    await store.replace(other, { sessionId: cp.id, revision: cp.revision });
    await store.replace(null, { sessionId: other.id, revision: other.revision });
    const restored = await store.restore(cp.id, { sessionId: null, revision: null });
    expect(restored).toMatchObject({ lifecycle: 'PAUSED', recovery: { reattachRequired: true } }); expect(restored!.lease).toBeUndefined();
    expect(await db.get('checkpoints', `paused:${cp.id}`)).toBeUndefined();
    expect((await history.read()).find((h) => h.id === cp.id)?.state).toBe('PAUSED');
  });
  it('all deletion clears every database store', async () => {
    await db.put('providerCredentials', key, 'openai'); await db.put('providerSettings', { private: detail }, 'openai');
    await deleteLocalData(db, 'all', now);
    for (const name of db.objectStoreNames) expect(await db.count(name)).toBe(0);
  });
});
