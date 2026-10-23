import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { deleteDB, type IDBPDatabase } from 'idb';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { CheckpointStore } from '../../src/storage/checkpoints';
import { ProfileStore } from '../../src/storage/profiles';
import { createCheckpoint } from '../../src/domain/session';
import { AutofillService } from '../../src/runtime/autofill';
import type { PageAccessService } from '../../src/runtime/page-access';
import { ActionResultSchema, ContentOperationSchema, type ContentOperation } from '../../src/forms/operations';
import type { Inspection, FormSnapshot } from '../../src/forms/schema';
import { createDryRun, previewBinding } from '../../src/mapping/rules';
import { RequestSchema, type Request } from '../../src/runtime/schemas';
import { createCoordinator } from '../../src/runtime/coordinator';

let db: IDBPDatabase<ApplyrDatabase>;
afterEach(async () => { if (db) { const name = db.name; db.close(); await deleteDB(name); } });
const hash = 'a'.repeat(64), other = 'b'.repeat(64);
const uuid = () => crypto.randomUUID();
function field(patch: Partial<FormSnapshot['fields'][number]> = {}): FormSnapshot['fields'][number] {
  return { id: uuid(), label: 'Email', labelSource: 'label', context: [], type: 'email', autocomplete: 'email', required: true, executable: true, category: 'short_answer', filePurpose: null, constraints: { min: '', max: '', step: '', minLength: '', maxLength: '', pattern: '', accept: '', multiple: false }, options: [], current: { fingerprint: hash, present: false }, validation: { valid: false, flags: ['valueMissing'], ariaInvalid: false, errorPresent: false }, ...patch };
}
async function setup(fields = [field()]) {
  db = await openDatabase(`autofill-${uuid()}`);
  const store = new CheckpointStore(db), cp = createCheckpoint({ tabId: 7, windowId: 1, origin: 'https://example.test', availability: 'https', identity: hash }, uuid(), Date.now());
  cp.access = { status: 'ready', reason: 'application', classification: 'application', frames: [] };
  await store.replace(cp, { sessionId: null, revision: null });
  const input = await new ProfileStore(db).freeze(cp.id, { source: 'replacement', document: { data: { profile_version: 1, reviewed_on: '2026-10-23', contact: { email: 'fiction@example.test' }, preferences: { relocation: false }, eligibility: [{ country_code: 'US', work_authorized: false, confirmed_on: '2026-10-23' }] }, notes: '', answerBodies: {} } }, null);
  const formId = uuid();
  const inspection: Inspection = { sessionId: cp.id, tabId: 7, frameId: 0, browserDocumentId: 'native-doc', snapshot: { schemaVersion: 1, identity: hash, document: uuid(), revision: 1, status: 'stable', selectedForm: formId, forms: [{ id: formId, label: 'Application', fieldCount: fields.length }], fields, unsupported: [], observation: { scans: 3, mutations: 0, bounded: true } } };
  const access = { inspect: vi.fn(async () => ({ checkpoint: (await store.read())!, inspection: structuredClone(inspection) })), verify: vi.fn(async (cp) => cp) } as unknown as PageAccessService;
  const effects: ContentOperation[] = [];
  const dispatch = vi.fn<(command: ContentOperation) => Promise<unknown>>(async (command) => {
    expect((await store.read())?.autofill?.operations.find((o) => o.id === command.operationId)?.result).toBeNull();
    effects.push(command);
    return { operationId: command.operationId, fieldId: command.fieldId, status: 'accepted', code: 'persisted_valid', selectedBytes: null, siteAcceptance: 'not_applicable' };
  });
  const service = new AutofillService({ database: async () => db, access, dispatch, changed: () => {} });
  const request = (): Extract<Request, { type: 'START_AUTOFILL' }> => ({ schemaVersion: 1, requestId: uuid(), type: 'START_AUTOFILL', runId: uuid(), sessionId: cp.id, revision: cp.revision + 1, inputVersion: input.version, inspection: structuredClone(inspection), corrections: [], resume: null });
  return { store, input, inspection, access, effects, dispatch, service, request };
}

it('persists intent before dispatch and result afterwards; deduplicates same run and in-flight requests', async () => {
  const s = await setup(); const request = s.request();
  const pending = s.service.start(request);
  await vi.waitFor(() => expect(s.dispatch).toHaveBeenCalledOnce());
  await s.service.start(request); await pending;
  expect(s.effects).toHaveLength(1);
  const result = await s.store.read(); expect(result?.autofill?.operations[0]?.result?.status).toBe('accepted'); expect(result?.submission.status).toBe('unknown');
  await s.service.start(request); expect(s.dispatch).toHaveBeenCalledOnce();
});

it('fails closed for stale snapshot, input version, wrong frame and unapproved resume before an effect', async () => {
  const s = await setup();
  for (const request of [
    { ...s.request(), inputVersion: uuid() },
    { ...s.request(), inspection: { ...s.inspection, frameId: 9 } },
    { ...s.request(), inspection: { ...s.inspection, snapshot: { ...s.inspection.snapshot, revision: 2 } } },
  ]) await expect(s.service.start(request)).rejects.toThrow();
  expect(s.effects).toEqual([]);
});

it('a remounted application form requires fresh user inspection rather than inheriting Start authorization', async () => {
  const s = await setup(); const request = s.request();
  s.inspection.snapshot.selectedForm = uuid();
  s.inspection.snapshot.forms[0]!.id = s.inspection.snapshot.selectedForm;
  await expect(s.service.start(request)).rejects.toThrow('ACCESS_UNAVAILABLE');
  expect(s.effects).toEqual([]);
});

it('consent stays manual and eligibility cannot execute until exact session confirmation', async () => {
  const choice = [{ label: 'Yes', fingerprint: hash, disabled: false }, { label: 'No', fingerprint: other, disabled: false }];
  const eligibility = field({ label: 'Are you authorized to work in US?', autocomplete: '', type: 'select', category: 'sensitive', executable: false, options: choice });
  const consent = field({ label: 'I agree to privacy terms', type: 'checkbox', category: 'declaration', executable: false, options: choice.slice(0, 1) });
  const s = await setup([eligibility, consent]);
  const request = s.request(); await s.service.start(request); expect(s.effects).toEqual([]);
  const next = { ...s.request(), revision: (await s.store.read())!.revision };
  next.corrections = [{ binding: previewBinding(s.inspection, s.input), fieldId: eligibility.id, currentFingerprint: hash, value: false, eligibilityConfirmed: true }, { binding: previewBinding(s.inspection, s.input), fieldId: consent.id, currentFingerprint: hash, value: true, eligibilityConfirmed: true }];
  await s.service.start(next);
  expect(s.effects).toHaveLength(1); expect(s.effects[0]).toMatchObject({ fieldId: eligibility.id, eligibilityApproved: true, value: { label: 'No' } });
});

it('uncertain external effects retain a result and cannot be blindly dispatched again', async () => {
  const s = await setup(); s.dispatch.mockRejectedValueOnce(new Error('lost reply'));
  await s.service.start(s.request()); const cp = (await s.store.read())!;
  expect(cp.autofill?.operations[0]?.result).toMatchObject({ status: 'unverified', code: 'unknown_effect' });
  await s.service.start({ ...s.request(), revision: cp.revision }); expect(s.dispatch).toHaveBeenCalledOnce();
});

it('strict command and result schemas cap byte chunks, metadata, extra selectors and statuses', async () => {
  const s = await setup(); const f = s.inspection.snapshot.fields[0]!;
  const base = { operationId: uuid(), runId: uuid(), fieldId: f.id, binding: previewBinding(s.inspection, s.input), precondition: hash };
  const chunk = { ...base, type: 'chunk', offset: 0, bytes: [1] };
  expect(ContentOperationSchema.safeParse(chunk).success).toBe(true);
  for (const change of [{ bytes: Array(65537).fill(0) }, { bytes: [-1] }, { bytes: [256] }, { offset: -1 }, { selector: '#submit' }, { type: 'submit' }]) expect(ContentOperationSchema.safeParse({ ...chunk, ...change }).success).toBe(false);
  expect(ContentOperationSchema.safeParse({ ...base, type: 'begin', file: { name: 'a.pdf', mime: 'application/pdf', size: 10 * 1024 * 1024 + 1, lastModified: 1, digest: hash } }).success).toBe(false);
  expect(ActionResultSchema.safeParse({ operationId: uuid(), fieldId: f.id, status: 'success' }).success).toBe(false);
  expect(RequestSchema.safeParse({ ...s.request(), type: 'UPLOAD', bytes: [1] }).success).toBe(false);
});

it('trusted packaged Start intent is required; website and lookalike senders are rejected', async () => {
  const s = await setup(); const pages = { popup: 'chrome-extension://test/popup.html', session: 'chrome-extension://test/session.html', options: 'chrome-extension://test/options.html' };
  const coordinator = createCoordinator({ extensionId: 'test', pages, store: async () => s.store, target: async () => (await s.store.read())!.target, now: Date.now, uuid, access: s.access, autofill: s.service });
  for (const url of ['https://example.test', `${pages.session}?fake=1`]) expect(await coordinator(s.request(), { id: 'test', url })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  expect(s.effects).toEqual([]);
  expect(await coordinator(s.request(), { id: 'test', url: pages.popup })).toMatchObject({ ok: true });
  expect(s.effects).toHaveLength(1);
});

it('native radio group maps one actual option and preserves an existing group selection', async () => {
  const first = field({ label: 'Yes', type: 'radio', autocomplete: '', category: 'choice', options: [{ label: 'Yes', fingerprint: hash, disabled: false }, { label: 'No', fingerprint: other, disabled: false }] });
  first.radioGroup = { primary: first.id, label: 'Willing to relocate', present: false };
  const second = { ...structuredClone(first), id: uuid(), label: 'No' };
  const s = await setup([first, second]);
  const preview = createDryRun(s.inspection, s.input);
  expect(preview.counts.proposed).toBe(1); expect(preview.items[0]?.proposal?.value).toMatchObject({ label: 'No', optionFingerprint: other }); expect(preview.items[1]?.state).toBe('skipped');
  first.current.present = true; second.current.present = true;
  expect(createDryRun(s.inspection, s.input).counts.proposed).toBe(0);
});

it('lost upload reply is reinspected and verified without dispatching the bytes or commit again', async () => {
  const f = field({ label: 'Resume PDF', type: 'file', autocomplete: '', category: 'file', filePurpose: 'resume' });
  const s = await setup([f]); const { DocumentStore } = await import('../../src/storage/documents');
  const docs = new DocumentStore(db);
  const selected = await docs.start(s.inspection.sessionId, { source: 'replacement', file: new File(['%PDF-1.7\nfiction'], 'fictional.pdf', { type: 'application/pdf' }) }, null);
  const types: string[] = []; let inspectionsBeforeCommit = 0;
  s.dispatch.mockImplementation(async (command) => {
    expect((await s.store.read())?.autofill?.operations[0]?.result).toBeNull(); types.push(command.type);
    if (command.type === 'commit') { inspectionsBeforeCommit = vi.mocked(s.access.inspect).mock.calls.length; throw new Error('lost commit reply'); }
    if (command.type === 'verify') {
      expect(vi.mocked(s.access.inspect).mock.calls.length).toBeGreaterThan(inspectionsBeforeCommit);
      return { operationId: command.operationId, fieldId: command.fieldId, status: 'unverified', code: 'selected_only', selectedBytes: true, siteAcceptance: 'unverified' };
    }
    return { ready: true };
  });
  const request = { ...s.request(), revision: (await s.store.read())!.revision, resume: { id: selected.document.id, inputVersion: selected.document.inputVersion } };
  await s.service.start(request);
  expect(types.filter((t) => t === 'commit')).toHaveLength(1); expect(types.filter((t) => t === 'chunk')).toHaveLength(1); expect(types).toContain('verify');
  expect((await s.store.read())?.autofill?.operations[0]?.result).toMatchObject({ selectedBytes: true, status: 'unverified' });
  await s.service.start({ ...request, runId: uuid(), revision: (await s.store.read())!.revision });
  expect(types.filter((t) => t === 'commit')).toHaveLength(1);
});

it('cancellation during byte transfer clears it, prevents commit and deletes temporary inputs', async () => {
  const s = await setup([field({ label: 'Resume PDF', type: 'file', autocomplete: '', category: 'file', filePurpose: 'resume' })]);
  const { DocumentStore } = await import('../../src/storage/documents'); const docs = new DocumentStore(db);
  const selected = await docs.start(s.inspection.sessionId, { source: 'replacement', file: new File(['%PDF-1.7\nfiction'], 'fictional.pdf', { type: 'application/pdf' }) }, null);
  let release!: () => void; const waiting = new Promise<void>((r) => { release = r; }); const types: string[] = [];
  s.dispatch.mockImplementation(async (command) => { types.push(command.type); if (command.type === 'chunk') await waiting; return { ready: true }; });
  const request = { ...s.request(), revision: (await s.store.read())!.revision, resume: { id: selected.document.id, inputVersion: selected.document.inputVersion } };
  const running = s.service.start(request); await vi.waitFor(() => expect(types).toContain('chunk'));
  await s.service.cancel(request.sessionId, request.runId); release(); await running;
  expect(types).toContain('cancel'); expect(types).toContain('clear'); expect(types).not.toContain('commit');
  expect((await s.store.read())?.autofill?.status).toBe('cancelled'); expect((await docs.read()).document).toBeNull(); expect((await new ProfileStore(db).read()).snapshot).toBeNull();
});

it('F10 pause at the first delivered operation persists acceptance and prevents subsequent writes; resume only inspects', async () => {
  const s = await setup([field(), field({ type: 'tel', label: 'Phone', autocomplete: 'tel' })]);
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  s.dispatch.mockImplementation(async (command) => { s.effects.push(command); await gate; return { operationId: command.operationId, fieldId: command.fieldId, status: 'accepted', code: 'persisted_valid', selectedBytes: null, siteAcceptance: 'not_applicable' }; });
  const running = s.service.start(s.request()); await vi.waitFor(() => expect(s.dispatch).toHaveBeenCalledOnce());
  const cp = (await s.store.read())!; await s.service.pause(cp.id, cp.revision);
  expect((await s.store.read())?.pauseRequested).toBe(true);
  release(); await running;
  const paused = (await s.store.read())!;
  expect(paused.lifecycle).toBe('PAUSED'); expect(paused.autofill?.status).toBe('paused');
  expect(paused.autofill?.operations[0]?.result?.status).toBe('accepted'); expect(s.dispatch).toHaveBeenCalledOnce();
  const before = vi.mocked(s.access.inspect).mock.calls.length;
  const resumed = await s.service.resume(paused.id, paused.revision);
  expect(resumed.lifecycle).toBe('QUEUED'); expect(vi.mocked(s.access.inspect).mock.calls.length).toBeGreaterThan(before); expect(s.dispatch).toHaveBeenCalledOnce();
});

it('F10 durable lease rejects a second service instance and expires into read-only recovery', async () => {
  const s = await setup(); let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  s.dispatch.mockImplementation(async (command) => { await gate; return { operationId: command.operationId, fieldId: command.fieldId, status: 'accepted', code: 'persisted_valid', selectedBytes: null, siteAcceptance: 'not_applicable' }; });
  const running = s.service.start(s.request()); await vi.waitFor(() => expect(s.dispatch).toHaveBeenCalledOnce());
  const second = new AutofillService({ database: async () => db, access: s.access, dispatch: s.dispatch, changed: () => {} });
  const current = (await s.store.read())!;
  await expect(second.start({ ...s.request(), revision: current.revision })).rejects.toThrow();
  await s.store.recover(second.owner);
  release(); await running;
  expect(s.dispatch).toHaveBeenCalledOnce();
  const recovered = (await s.store.read())!; expect(recovered.lifecycle).toBe('NEEDS_ATTENTION');
  expect(recovered.autofill?.operations[0]?.result?.status).toBe('accepted');
});

for (const observed of ['accepted', 'skipped_user_change'] as const) it(`F10 intent without result is observed as ${observed} with no write replay`, async () => {
  const s = await setup(); await s.service.start(s.request());
  let cp = (await s.store.read())!;
  cp = { ...cp, revision: cp.revision + 1, lifecycle: 'NEEDS_ATTENTION', recovery: { reason: 'worker_interrupted', inspectionRequired: true, reattachRequired: false }, autofill: { ...cp.autofill!, status: 'interrupted', operations: cp.autofill!.operations.map((o) => ({ ...o, result: null })) } };
  await s.store.replace(cp, { sessionId: cp.id, revision: cp.revision - 1 });
  s.dispatch.mockImplementation(async (command) => {
    expect(command.type).toBe('observe');
    return { operationId: command.operationId, fieldId: command.fieldId, status: observed, code: observed === 'accepted' ? 'persisted_valid' : 'user_change', selectedBytes: null, siteAcceptance: 'not_applicable' };
  });
  const result = await s.service.resume(cp.id, cp.revision);
  expect(result.autofill?.operations[0]?.result?.status).toBe(observed);
  expect(s.dispatch.mock.calls.map(([c]) => c.type)).toEqual(['write', 'observe']);
  await s.service.start({ ...s.request(), revision: result.revision });
  expect(s.dispatch.mock.calls.map(([c]) => c.type)).toEqual(['write', 'observe']);
});

it('F10 remounted document keeps an unknown effect and never resolves it against a different field', async () => {
  const s = await setup(); await s.service.start(s.request());
  let cp = (await s.store.read())!;
  cp = { ...cp, revision: cp.revision + 1, lifecycle: 'NEEDS_ATTENTION', autofill: { ...cp.autofill!, status: 'interrupted', operations: cp.autofill!.operations.map((o) => ({ ...o, result: null })) } };
  await s.store.replace(cp, { sessionId: cp.id, revision: cp.revision - 1 });
  s.inspection.snapshot.document = uuid(); s.inspection.snapshot.fields[0]!.id = uuid();
  const resumed = await s.service.resume(cp.id, cp.revision);
  expect(resumed.autofill?.operations[0]?.result).toMatchObject({ status: 'unverified', code: 'unknown_effect' }); expect(s.dispatch).toHaveBeenCalledOnce();
});

it('F10 recovery after missing/deleted inputs requires reselection without observation or fallback', async () => {
  const s = await setup(); await s.service.start(s.request());
  const cp = (await s.store.read())!; await db.delete('profiles', 'snapshot');
  await expect(s.service.resume(cp.id, cp.revision)).rejects.toThrow('ACCESS_UNAVAILABLE'); expect(s.dispatch).toHaveBeenCalledOnce();
});

it('F10 cancel after accepted result cannot revive the session or lose acceptance; temporary recovery values clear', async () => {
  const s = await setup(); await s.service.start(s.request());
  const cp = (await s.store.read())!; await s.service.cancel(cp.id, cp.autofill!.id);
  const cancelled = (await s.store.read())!;
  expect(cancelled.lifecycle).toBe('CANCELLED'); expect(cancelled.autofill?.operations[0]?.result?.status).toBe('accepted'); expect(cancelled.autofill?.operations[0]?.recovery).toBeUndefined();
  await expect(s.service.resume(cp.id, cancelled.revision)).rejects.toThrow();
  await expect(s.service.start({ ...s.request(), revision: cancelled.revision })).rejects.toThrow(); expect(s.dispatch).toHaveBeenCalledOnce();
});

it('F10 an accepted result arriving after a job switch is merged into its parked ledger exactly once', async () => {
  const s = await setup(); let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  s.dispatch.mockImplementation(async (command) => { await gate; return { operationId: command.operationId, fieldId: command.fieldId, status: 'accepted', code: 'persisted_valid', selectedBytes: null, siteAcceptance: 'not_applicable' }; });
  const running = s.service.start(s.request()); await vi.waitFor(() => expect(s.dispatch).toHaveBeenCalledOnce());
  const old = (await s.store.read())!;
  const next = createCheckpoint({ ...old.target, tabId: 90, identity: other }, uuid(), Date.now());
  await s.store.replace(next, { sessionId: old.id, revision: old.revision }); release(); await running;
  const parked = (await s.store.archived()).find((cp) => cp.id === old.id)!;
  expect(parked.lifecycle).toBe('PAUSED'); const result = parked.autofill!.operations[0]!.result!; expect(result.status).toBe('accepted');
  await s.store.recordResult(old.id, old.autofill!.id, { ...result, status: 'rejected', code: 'site_error' });
  expect((await s.store.archived()).find((cp) => cp.id === old.id)?.autofill?.operations[0]?.result).toEqual(result);
  expect((await s.store.read())?.id).toBe(next.id); expect((await s.store.read())?.autofill).toBeUndefined(); expect(s.dispatch).toHaveBeenCalledOnce();
});

it('F10 termination after intent but before any page effect inspects the empty control and never blindly replays', async () => {
  const s = await setup();
  s.dispatch.mockImplementationOnce(async () => { const cp = (await s.store.read())!; expect(cp.autofill?.operations[0]?.result).toBeNull(); await s.store.recover(uuid()); throw new Error('worker stopped before delivery'); });
  await s.service.start(s.request()); const cp = (await s.store.read())!;
  expect(s.effects).toEqual([]); expect(cp.autofill?.operations[0]?.result?.code).toBe('unknown_effect');
  const recovery = new AutofillService({ database: async () => db, access: s.access, dispatch: s.dispatch, changed: () => {} });
  s.dispatch.mockImplementation(async (command) => { expect(command.type).toBe('observe'); return { operationId: command.operationId, fieldId: command.fieldId, status: 'unverified', code: 'unknown_effect', selectedBytes: null, siteAcceptance: 'not_applicable' }; });
  const resumed = await recovery.resume(cp.id, cp.revision);
  await recovery.start({ ...s.request(), revision: resumed.revision });
  expect(s.dispatch.mock.calls.map(([c]) => c.type)).toEqual(['write', 'observe']); expect(s.effects).toEqual([]);
});

for (const stop of ['PAUSE_SESSION', 'CANCEL_SESSION'] as const) it(`F10 ${stop} tolerates newer progress revisions in the same session`, async () => {
  const s = await setup(); const start = s.request();
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  s.dispatch.mockImplementation(async (command) => { if (command.type === 'write') await gate; return { operationId: command.operationId, fieldId: command.fieldId, status: 'accepted', code: 'persisted_valid', selectedBytes: null, siteAcceptance: 'not_applicable' }; });
  const pending = s.service.start(start); await vi.waitFor(() => expect(s.dispatch).toHaveBeenCalledOnce());
  const pages = { popup: 'chrome-extension://test/popup.html', session: 'chrome-extension://test/session.html', options: 'chrome-extension://test/options.html' };
  const coordinator = createCoordinator({ extensionId: 'test', pages, store: async () => s.store, target: async () => (await s.store.read())!.target, now: Date.now, uuid, access: s.access, autofill: s.service });
  const response = await coordinator({ schemaVersion: 1, requestId: uuid(), type: stop, sessionId: start.sessionId, revision: start.revision }, { id: 'test', url: pages.session });
  expect(response.ok).toBe(true); release(); await pending;
  expect((await s.store.read())?.lifecycle).toBe(stop === 'PAUSE_SESSION' ? 'PAUSED' : 'CANCELLED');
  expect(s.dispatch.mock.calls.filter(([c]) => c.type === 'write')).toHaveLength(1);
});

it('F10 a relabelled control cannot satisfy a prior intent during recovery', async () => {
  const s = await setup(); await s.service.start(s.request()); let cp = (await s.store.read())!;
  cp = { ...cp, revision: cp.revision + 1, lifecycle: 'NEEDS_ATTENTION', autofill: { ...cp.autofill!, status: 'interrupted', operations: cp.autofill!.operations.map((o) => ({ ...o, result: null })) } };
  await s.store.replace(cp, { sessionId: cp.id, revision: cp.revision - 1 });
  s.inspection.snapshot.fields[0]!.label = 'Unrelated replacement question';
  const resumed = await s.service.resume(cp.id, cp.revision);
  expect(resumed.autofill?.operations[0]?.result?.code).toBe('unknown_effect'); expect(s.dispatch).toHaveBeenCalledOnce();
});

it('F10 cancellation after reinspection cannot append a new intent or recovery value', async () => {
  const s = await setup(); let calls = 0;
  vi.mocked(s.access.inspect).mockImplementation(async () => {
    if (++calls === 2) { const cp = (await s.store.read())!; await s.service.cancel(cp.id, cp.autofill!.id); }
    return { checkpoint: (await s.store.read())!, inspection: structuredClone(s.inspection) };
  });
  await s.service.start(s.request()); const cp = await s.store.read();
  expect(cp?.lifecycle).toBe('CANCELLED'); expect(cp?.autofill?.operations).toEqual([]); expect(s.dispatch).not.toHaveBeenCalled();
});
