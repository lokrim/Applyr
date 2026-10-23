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
