import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { openDatabase } from '../../src/storage/database';
import { CheckpointStore } from '../../src/storage/checkpoints';
import { AttentionService } from '../../src/attention/service';
import type { PageAccessService } from '../../src/runtime/page-access';
import { AdapterSchema, adapterCapabilities, adapterDescription } from '../../src/adapters/schema';
import { createCheckpoint, finalReviewReady, reviewReady, transition } from '../../src/domain/session';
import { FormSnapshotSchema, type Inspection } from '../../src/forms/schema';
import { FieldReviewSchema, observeReview } from '../../src/review';

const id = () => crypto.randomUUID(), hash = 'a'.repeat(64);
function fixture() {
  const cp = createCheckpoint({ tabId: 1, windowId: 1, origin: 'https://fiction.test', availability: 'https', identity: hash }, id(), 1);
  cp.access = { status: 'ready', classification: 'application', reason: 'application', frames: [] };
  cp.autofill = { id: id(), inputVersion: id(), status: 'review', operations: [], requiredUnresolved: 0, unsupported: 0 };
  const form = id();
  const inspection: Inspection = { sessionId: cp.id, tabId: 1, frameId: 0, browserDocumentId: 'doc', snapshot: {
    schemaVersion: 1, identity: hash, document: id(), revision: 1, status: 'stable', selectedForm: form, forms: [{ id: form, label: 'Application', fieldCount: 1 }],
    step: { signature: hash, hasNext: true }, fields: [{ id: id(), label: 'Email', labelSource: 'label', context: [], type: 'email', autocomplete: '', executable: true, category: 'short_answer', filePurpose: null, required: true,
      constraints: { min: '', max: '', step: '', minLength: '', maxLength: '', pattern: '', accept: '', multiple: false }, options: [], current: { present: true, fingerprint: hash }, validation: { valid: true, flags: [], ariaInvalid: false, errorPresent: false } }],
    unsupported: [], observation: { bounded: true, scans: 3, mutations: 0 },
  } };
  return { cp, inspection };
}
describe('bounded compatibility and step evidence', () => {
  it('enumerates each honest tier and evidence without full/live support', () => {
    for (const [id, c] of Object.entries(adapterCapabilities)) {
      const a = AdapterSchema.parse({ id, version: '1.0.0', recognition: id === 'generic' ? 'generic' : 'host_path_form', evidence: 'owned_fixtures_only' });
      expect(adapterDescription(a)).toContain(c.fixtures); expect(adapterDescription(a)).toContain(c.tier);
      expect(c.manual.length).toBeGreaterThan(0);
    }
    for (const id of ['ashby', 'smartrecruiters', 'workable', 'workday'] as const) expect(adapterCapabilities[id].tier).toBe('experimental');
    expect(AdapterSchema.safeParse({ id: 'workday', version: '1.0.0', recognition: 'generic', evidence: 'owned_fixtures_only' }).success).toBe(false);
  });
  it('blocks final scope when Next is observed even if current controls are valid', async () => {
    const { cp, inspection } = fixture(); cp.review = await observeReview(cp, inspection);
    expect(reviewReady(cp)).toBe(true); expect(finalReviewReady(cp)).toBe(false);
    expect(transition(cp, { type: 'REVIEW' }, 2).reviewScope).toBe('current_step');
    expect(() => transition(cp, { type: 'REVIEW', scope: 'final_review' }, 2)).toThrow();
    inspection.snapshot.step!.hasNext = false; cp.review = await observeReview(cp, inspection);
    expect(finalReviewReady(cp)).toBe(true); expect(transition(cp, { type: 'REVIEW', scope: 'final_review' }, 3).submission.status).toBe('unknown');
  });
  it('deduplicates same-step observations, detects return branches and scopes trails to registry documents', async () => {
    const { cp, inspection } = fixture(), frozen = cp.autofill!.inputVersion, target = cp.target;
    cp.review = await observeReview(cp, inspection); cp.review = await observeReview(cp, inspection);
    expect(cp.review.areas[0]!.step!.trail).toEqual([hash]);
    inspection.snapshot.step!.signature = 'b'.repeat(64); cp.review = await observeReview(cp, inspection);
    expect(cp.review.areas[0]!.step!.loop).toBe(false);
    inspection.snapshot.step!.signature = hash; cp.review = await observeReview(cp, inspection);
    expect(cp.review.areas[0]!.step!.loop).toBe(true); expect(reviewReady(cp)).toBe(false);
    expect(cp.review.areas[0]!.manual).toContain('Repeated branch or step limit reached. Assistance paused; complete the branch manually.');
    expect(cp.target).toBe(target); expect(cp.autofill!.inputVersion).toBe(frozen);
    inspection.snapshot.document = id(); cp.review = await observeReview(cp, inspection); expect(cp.review.areas[0]!.step!.loop).toBe(false);
    expect(FieldReviewSchema.safeParse(cp.review).success).toBe(true);
  });
  it('invalidates stale final scope on a newly visible Next or a changed complete step, and persists loop pause', async () => {
    const { cp, inspection } = fixture(); cp.expiresAt = Date.now() + 86400000;
    inspection.snapshot.step!.hasNext = false; cp.review = await observeReview(cp, inspection);
    const db = await openDatabase(`compatibility-${id()}`), store = new CheckpointStore(db);
    const service = new AttentionService({ database: async () => db, access: {} as PageAccessService, changed: () => {}, mark: async () => true, activate: async () => {} });
    try {
      await store.replace(transition(cp, { type: 'REVIEW', scope: 'final_review' }, Date.now()), { sessionId: null, revision: null });
      inspection.snapshot.step!.hasNext = true;
      let observed = await service.observe((await store.read())!, inspection); expect(observed.reviewScope).toBeUndefined();
      inspection.snapshot.step!.hasNext = false; observed = await service.observe(observed, inspection);
      observed = transition(observed, { type: 'REVIEW', scope: 'final_review' }, Date.now());
      await store.replace(observed, { sessionId: observed.id, revision: observed.revision - 1 });
      inspection.snapshot.fields[0]!.id = id(); observed = await service.observe(observed, inspection);
      expect(reviewReady(observed)).toBe(true); expect(observed.reviewScope).toBeUndefined();
      observed = transition(observed, { type: 'REVIEW', scope: 'final_review' }, Date.now());
      await store.replace(observed, { sessionId: observed.id, revision: observed.revision - 1 });
      inspection.snapshot.step!.signature = 'b'.repeat(64); observed = await service.observe(observed, inspection);
      expect(reviewReady(observed)).toBe(true); expect(observed.reviewScope).toBeUndefined();
      inspection.snapshot.step!.signature = hash; observed = await service.observe(observed, inspection);
      expect(observed.lifecycle).toBe('PAUSED'); expect(observed.recovery?.reason).toBe('branch_loop');
      expect((await store.read())?.lifecycle).toBe('PAUSED'); expect(observed.autofill!.inputVersion).toBe(cp.autofill!.inputVersion);
    } finally { const name = db.name; db.close(); await deleteDB(name); }
  });
  it('keeps earlier manual outcomes visible when that step disappears', async () => {
    const { cp, inspection } = fixture(); inspection.snapshot.unsupported = [{ code: 'manual_upload', label: 'First step upload' }];
    cp.review = await observeReview(cp, inspection); inspection.snapshot.step!.signature = 'b'.repeat(64); inspection.snapshot.unsupported = [];
    cp.review = await observeReview(cp, inspection); expect(cp.review.areas[0]!.manual).toContain('First step upload'); expect(reviewReady(cp)).toBe(false);
    inspection.snapshot.document = id(); cp.review = await observeReview(cp, inspection); expect(cp.review.areas[0]!.manual).toEqual([]);
  });
  it('does not erase a disappeared required question when a later step is complete', async () => {
    const { cp, inspection } = fixture(); inspection.snapshot.fields[0]!.current.present = false; inspection.snapshot.fields[0]!.validation.valid = false;
    cp.review = await observeReview(cp, inspection);
    inspection.snapshot.fields = [{ ...inspection.snapshot.fields[0]!, id: id(), label: 'City', current: { present: true, fingerprint: hash }, validation: { valid: true, flags: [], ariaInvalid: false, errorPresent: false } }];
    inspection.snapshot.step = { signature: 'b'.repeat(64), hasNext: false };
    cp.review = await observeReview(cp, inspection); expect(cp.review.items[0]!.status).toBe('manual');
    expect(cp.review.areas[0]!.manual).toContain('Earlier step: Email (unresolved); verify manually.');
    expect(finalReviewReady(cp)).toBe(false);
  });
  it('bounds unique step exploration and retains specific unsupported outcomes', async () => {
    const { cp, inspection } = fixture();
    for (let n = 0; n < 13; n++) { inspection.snapshot.step!.signature = n.toString(16).padStart(64, '0'); cp.review = await observeReview(cp, inspection); }
    expect(cp.review!.areas[0]!.step!.trail).toHaveLength(12); expect(cp.review!.areas[0]!.step!.loop).toBe(true);
    inspection.snapshot.unsupported = [{ code: 'manual_upload', label: 'Drive upload' }, { code: 'repeated_history', label: 'Education history' }];
    expect(FormSnapshotSchema.safeParse(inspection.snapshot).success).toBe(true);
    cp.review = await observeReview(cp, inspection); expect(cp.review.areas[0]!.manual).toEqual(expect.arrayContaining(['Drive upload', 'Education history']));
    expect(JSON.stringify(cp.review)).not.toContain('value@');
  });
});
