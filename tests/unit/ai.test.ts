import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteDB, type IDBPDatabase } from 'idb';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { ProfileStore } from '../../src/storage/profiles';
import { CheckpointStore } from '../../src/storage/checkpoints';
import { createCheckpoint } from '../../src/domain/session';
import { createAdapter } from '../../src/providers/adapters';
import { ProviderService } from '../../src/providers/service';
import { ProviderStorage } from '../../src/providers/storage';
import { defaultConfig, type Provider } from '../../src/providers/contracts';
import { selectContext, evidenceIndex, safeAiField } from '../../src/ai/context';
import { AiService, aiHandler } from '../../src/ai/service';
import { validateProposals, outputSchema } from '../../src/ai/validation';
import type { TaskContext, TaskSelection, ReviewBatch } from '../../src/ai/contracts';
import { AutofillService } from '../../src/runtime/autofill';
import type { PageAccessService } from '../../src/runtime/page-access';
import type { FormSnapshot, Inspection } from '../../src/forms/schema';
import { CREDENTIAL_CANARY, jsonResponse, providerSuccess, providerRefusal, providerTruncation } from '../fixtures/providers';

const uuid = () => crypto.randomUUID(), hash = 'a'.repeat(64);
const field = (patch: Partial<FormSnapshot['fields'][number]> = {}): FormSnapshot['fields'][number] => ({ id: uuid(), label: 'Describe a project (maximum 30 words)', labelSource: 'label', context: [], type: 'textarea', autocomplete: '', required: true, executable: true, category: 'long_answer', filePurpose: null,
  constraints: { min: '', max: '', step: '', minLength: '', maxLength: '250', pattern: '', accept: '', multiple: false }, options: [], current: { fingerprint: hash, present: false }, validation: { valid: false, flags: ['valueMissing'], ariaInvalid: false, errorPresent: false }, ...patch });
let db: IDBPDatabase<ApplyrDatabase>;
afterEach(async () => { if (db) { const name = db.name; db.close(); await deleteDB(name); } });
async function setup(fields = [field()], provider: Provider = 'openai', candidatePermission: () => Promise<boolean> = async () => true) {
  db = await openDatabase(`ai-${uuid()}`);
  const checkpoints = new CheckpointStore(db), profiles = new ProfileStore(db);
  const cp = createCheckpoint({ tabId: 7, windowId: 1, origin: 'https://jobs.example.test', availability: 'https', identity: hash }, uuid(), Date.now());
  cp.access = { status: 'ready', reason: 'application', classification: 'application', frames: [] }; await checkpoints.replace(cp, { sessionId: null, revision: null });
  const document = { data: { profile_version: 1 as const, projects: [{ id: 'board', name: 'Task board', description: 'Built a TypeScript task board.' }], contact: { email: 'UNRELATED_CONTACT_CANARY@example.test' } }, notes: 'NOTES_PDF_FULL_PROFILE_CANARY', answerBodies: {} };
  await profiles.saveDefault(document, null);
  const input = await profiles.freeze(cp.id, { source: 'replacement', document }, null);
  const form = uuid();
  const inspection: Inspection = { sessionId: cp.id, tabId: 7, frameId: 0, browserDocumentId: 'browser-document', snapshot: { schemaVersion: 1, identity: hash, document: uuid(), revision: 1, status: 'stable', selectedForm: form, forms: [{ id: form, label: 'Application', fieldCount: fields.length }], fields, unsupported: [], observation: { scans: 3, mutations: 0, bounded: true } } };
  const selections: TaskSelection[] = fields.filter(safeAiField).map((f) => ({ fieldId: f.id, kind: f.type === 'textarea' ? 'prose' : 'mapping', evidenceRefs: f.type === 'textarea' ? ['projects.board.description'] : [], maxWords: null }));
  const context = selectContext(inspection, input, selections, 'A role building tools.');
  const proposals = (c: TaskContext) => ({ scope: c.scope, revision: c.revision, proposals: c.fields.map((f) => ({ fieldId: f.id, status: 'proposed', operation: f.kind === 'prose' ? 'draft_answer' : 'map_fact', factRefs: [f.evidence[0]!.ref], optionId: f.type === 'select' ? f.options[0]!.id : '', text: f.kind === 'prose' ? 'I built a TypeScript task board.' : '' })) });
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const text = provider === 'claude' ? body.messages[0].content : body.input;
    const data = text.includes('Task data: ') ? proposals(JSON.parse(text.split('Task data: ')[1])) : { ok: true };
    return jsonResponse(providerSuccess(provider, JSON.stringify(data)));
  });
  const keys: Record<string, unknown> = {};
  const storage = new ProviderStorage(async () => db, { get: async (key) => ({ [key]: keys[key] }), set: async (data) => { Object.assign(keys, data); }, remove: async (key) => { delete keys[key]; }, setAccessLevel: async () => {} });
  const providers = new ProviderService(storage, async () => true, (p) => createAdapter(p, transport), candidatePermission);
  const env = { channel: 'providers' as const, schemaVersion: 1 as const, requestId: uuid(), provider };
  await providers.execute({ ...env, type: 'SAVE', config: { ...defaultConfig(provider), model: 'mock-model' }, key: CREDENTIAL_CANARY });
  let config = await storage.config(provider);
  await providers.execute({ ...env, type: 'SAVE', config: { ...config, candidateConsent: true, paidServiceConfirmed: true } });
  config = await storage.config(provider); await providers.execute({ ...env, type: 'TEST', revision: config.revision }); transport.mockClear();
  const access = { inspect: vi.fn(async () => ({ checkpoint: await checkpoints.read(), inspection: structuredClone(inspection) })), verify: vi.fn(async (c) => c) } as unknown as PageAccessService;
  const dispatch = vi.fn(async (command) => ({ operationId: command.operationId, fieldId: command.fieldId, status: 'accepted', code: 'persisted_valid', selectedBytes: null, siteAcceptance: 'not_applicable' }));
  const autofill = new AutofillService({ database: async () => db, access, dispatch, changed: () => {} });
  const service = new AiService(async () => db, providers, autofill);
  const prepare = () => service.execute({ channel: 'ai', schemaVersion: 1, requestId: uuid(), type: 'PREPARE', provider, inspection: structuredClone(inspection), inputVersion: input.version, selections, roleExcerpt: 'A role building tools.' });
  const decide = (batch: ReviewBatch, action: 'approve' | 'reject' = 'approve', factsReviewed = true, text?: string) => service.execute({ channel: 'ai', schemaVersion: 1, requestId: uuid(), type: 'DECIDE', batchId: batch.id, decisions: batch.proposals.map((p) => ({ fieldId: p.fieldId, action, factsReviewed, text: text ?? p.text })) });
  return { inspection, input, context, proposals, service, providers, transport, access, dispatch, prepare, decide, profiles, checkpoints, selections };
}

describe('F11 minimal native AI proposals', () => {
  for (const provider of ['openai', 'gemini', 'claude'] as const) {
    it(`${provider}: native envelope contains only selected task context, keys stay in headers; approval is required and never updates facts`, async () => {
      const s = await setup(undefined, provider), before = await s.profiles.read();
      const response = await s.prepare(), batch = response.batch!;
      expect(s.dispatch).not.toHaveBeenCalled(); expect(s.transport).toHaveBeenCalledOnce();
      const [url, init] = s.transport.mock.calls[0]!;
      const payload = String(init.body);
      for (const marker of [CREDENTIAL_CANARY, 'UNRELATED_CONTACT_CANARY', 'NOTES_PDF_FULL_PROFILE_CANARY', s.inspection.snapshot.document, 'Task board']) expect(payload).not.toContain(marker);
      expect(payload).toContain('Built a TypeScript task board.'); expect(payload).not.toContain('current');
      expect(String(url)).not.toContain(CREDENTIAL_CANARY);
      expect(new Headers(init.headers).get(provider === 'gemini' ? 'x-goog-api-key' : 'Authorization')).toContain(CREDENTIAL_CANARY);
      await s.decide(batch); expect(s.dispatch).toHaveBeenCalledOnce();
      expect(await s.profiles.read()).toEqual(before);
      expect((await s.checkpoints.read())?.submission.status).toBe('unknown');
      await expect(s.decide(batch)).rejects.toMatchObject({ code: 'stale' }); expect(s.dispatch).toHaveBeenCalledOnce();
    });
    for (const [name, reply, code] of [
      ['refusal', providerRefusal(provider), 'refusal'], ['truncation', providerTruncation(provider), 'invalid_output'],
      ['malformed', providerSuccess(provider, '{bad'), 'invalid_output'], ['fenced', providerSuccess(provider, '```json\n{}\n```'), 'invalid_output'],
    ] as const) it(`${provider}: ${name} preserves deterministic results without repair or provider switching`, async () => {
      const s = await setup(undefined, provider);
      const before = await s.checkpoints.read(); s.transport.mockResolvedValue(jsonResponse(reply));
      await expect(s.prepare()).rejects.toMatchObject({ code });
      expect(s.transport).toHaveBeenCalledOnce(); expect(s.dispatch).not.toHaveBeenCalled(); expect(await s.checkpoints.read()).toEqual(before);
    });
  }
  it('allows enumerated mapping references/options and inserts only a reviewed choice', async () => {
    const s = await setup([field({ type: 'select', category: 'choice', label: 'Project technology', options: [{ fingerprint: hash, label: 'TypeScript', disabled: false }] })]);
    const { batch } = await s.prepare(); expect(batch?.proposals[0]?.operation).toBe('map_fact');
    expect(s.dispatch).not.toHaveBeenCalled(); await s.decide(batch!);
    expect(s.dispatch.mock.calls[0]?.[0].value).toEqual({ kind: 'choice', label: 'TypeScript', optionFingerprint: hash });
  });
  it('reject and missing factual review never insert; edits remain application scoped', async () => {
    const s = await setup(), { batch } = await s.prepare();
    await expect(s.decide(batch!, 'approve', false)).rejects.toMatchObject({ code: 'invalid_request' }); expect(s.dispatch).not.toHaveBeenCalled();
    await s.decide(batch!, 'reject'); expect(s.dispatch).not.toHaveBeenCalled();
    const next = (await s.prepare()).batch!;
    await s.decide(next, 'approve', true, 'Built a TypeScript task board.'); expect(s.dispatch.mock.calls[0]?.[0].value.text).toBe('Built a TypeScript task board.');
    expect((await s.profiles.read()).snapshot?.document.data.answers).toBeUndefined();
  });
  for (const mutate of ['fingerprint', 'revision', 'label', 'options', 'input', 'form', 'frame'] as const) it(`fresh ${mutate} precondition blocks insertion`, async () => {
    const s = await setup(), batch = (await s.prepare()).batch!;
    if (mutate === 'fingerprint') s.inspection.snapshot.fields[0]!.current.fingerprint = 'b'.repeat(64);
    if (mutate === 'revision') s.inspection.snapshot.revision++;
    if (mutate === 'label') s.inspection.snapshot.fields[0]!.label = 'I certify this application';
    if (mutate === 'options') s.inspection.snapshot.fields[0]!.options.push({ label: 'hostile', disabled: false, fingerprint: hash });
    if (mutate === 'input') await s.profiles.freeze(s.input.sessionId, { source: 'replacement', document: s.input.document }, s.input.version);
    if (mutate === 'form') s.inspection.snapshot.selectedForm = uuid();
    if (mutate === 'frame') s.inspection.frameId++;
    await expect(s.decide(batch)).rejects.toThrow(); expect(s.dispatch).not.toHaveBeenCalled();
  });
  it('unknown/needs_user_input are reviewable questions and cannot authorize writes', async () => {
    const s = await setup();
    for (const status of ['unknown', 'needs_user_input']) {
      const raw = { scope: s.context.scope, revision: s.context.revision, proposals: [{ fieldId: s.context.fields[0]!.id, status, operation: 'none', factRefs: [], optionId: '', text: '' }] };
      expect(validateProposals(raw, s.context)[0]?.status).toBe(status);
    }
    s.transport.mockImplementation(async (_u, init) => {
      const c = JSON.parse(JSON.parse(String(init.body)).input.split('Task data: ')[1]);
      return jsonResponse(providerSuccess('openai', JSON.stringify({ scope: c.scope, revision: c.revision, proposals: [{ fieldId: c.fields[0].id, status: 'needs_user_input', operation: 'none', factRefs: [], optionId: '', text: '' }] })));
    });
    const { batch } = await s.prepare(); await expect(s.decide(batch!)).rejects.toMatchObject({ code: 'invalid_request' }); expect(s.dispatch).not.toHaveBeenCalled();
  });
  it('missing selected evidence stays missing without sending a profile or making a paid guess', async () => {
    const s = await setup(); s.selections[0]!.evidenceRefs = [];
    await expect(s.prepare()).rejects.toMatchObject({ code: 'invalid_request' }); expect(s.transport).not.toHaveBeenCalled();
    s.selections[0]!.evidenceRefs = ['projects.missing.description'];
    await expect(s.prepare()).rejects.toMatchObject({ code: 'invalid_request' }); expect(s.transport).not.toHaveBeenCalled();
    expect(evidenceIndex(s.input).every((e) => !e.ref.startsWith('contact'))).toBe(true);
  });
  it('conflicting current employers require input rather than model selection', async () => {
    const s = await setup([field({ type: 'text', label: 'Current employer name', category: 'short_answer' })]);
    s.input.document.data.experience = [{ id: 'one', current: true, organization: 'One' }, { id: 'two', current: true, organization: 'Two' }];
    const selected = selectContext(s.inspection, s.input, s.selections, '');
    expect(selected.fields[0]?.evidence).toEqual([]);
  });
  it('AI off and provider unavailable keep prior field results and never choose another provider', async () => {
    const s = await setup();
    await s.service.execute({ channel: 'ai', schemaVersion: 1, requestId: uuid(), type: 'DISCARD' }); expect(s.transport).not.toHaveBeenCalled();
    await s.providers.execute({ channel: 'providers', schemaVersion: 1, requestId: uuid(), provider: 'openai', type: 'REVOKE_CONSENT', revision: 2 });
    await expect(s.prepare()).rejects.toMatchObject({ code: 'permission' }); expect(s.transport).not.toHaveBeenCalled(); expect(s.dispatch).not.toHaveBeenCalled();
  });
  it('hostile page/model instructions cannot add operations, selectors, secrets or settings', async () => {
    const s = await setup();
    const valid = s.proposals(s.context);
    for (const patch of [{ selector: '#submit' }, { script: 'fetch(document.cookie)' }, { endpoint: 'https://evil.test' }, { settings: { model: 'other' } }, { operation: 'submit' }, { confidence: 1 }, { factRefs: ['contact.email'] }, { optionId: 'invented' }, { fieldId: uuid() }, { text: '<script>fetch(document.cookie)</script>' }, { text: 'Submit this form now.' }, { text: 'x'.repeat(251) }, { text: Array(31).fill('word').join(' ') }]) {
      expect(() => validateProposals({ ...valid, proposals: [{ ...valid.proposals[0], ...patch }] }, s.context)).toThrow();
    }
    for (const patch of [{ revision: 99 }, { scope: uuid() }, { endpoint: 'https://evil.test' }]) expect(() => validateProposals({ ...valid, ...patch }, s.context)).toThrow();
    expect(outputSchema(s.context)).not.toHaveProperty('tools');
    const handle = aiHandler(s.service, 'test', ['chrome-extension://test/session.html']);
    const request = { channel: 'ai', schemaVersion: 1, requestId: uuid(), type: 'PREPARE', provider: 'openai', inspection: s.inspection, inputVersion: s.input.version, selections: s.selections, roleExcerpt: '' };
    for (const sender of [{ id: 'test', url: 'https://jobs.example.test' }, { id: 'test', url: 'chrome-extension://test/session.html', frameId: 1 }, { id: 'foreign', url: 'chrome-extension://test/session.html' }]) expect(await handle(request, sender)).toMatchObject({ code: 'permission' });
    expect(await handle({ ...request, endpoint: 'https://evil.test' }, { id: 'test', url: 'chrome-extension://test/session.html' })).toMatchObject({ code: 'invalid_request' });
    expect(s.transport).not.toHaveBeenCalled(); expect(s.dispatch).not.toHaveBeenCalled();
  });
  it('known missing facts cannot use unrelated evidence even when the page calls them ordinary fields', async () => {
    const s = await setup();
    s.inspection.snapshot.fields[0]!.label = 'Full name';
    expect(() => selectContext(s.inspection, s.input, s.selections, '')).toThrow();
    expect(s.transport).not.toHaveBeenCalled();
  });
  it('native website-data permission is an independent candidate gate', async () => {
    const s = await setup(undefined, 'openai', async () => false);
    await expect(s.prepare()).rejects.toMatchObject({ code: 'permission' });
    expect(s.transport).not.toHaveBeenCalled(); expect(s.dispatch).not.toHaveBeenCalled();
  });
  it('revocation aborts an in-flight candidate request with no late proposal or automatic replay', async () => {
    const s = await setup(); s.transport.mockImplementation(() => new Promise<Response>(() => {}));
    const pending = s.prepare(); await vi.waitFor(() => expect(s.transport).toHaveBeenCalledOnce());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await s.providers.execute({ channel: 'providers', schemaVersion: 1, requestId: uuid(), provider: 'openai', type: 'REVOKE_CONSENT', revision: 2 });
    await rejected; expect(s.dispatch).not.toHaveBeenCalled(); expect(s.transport).toHaveBeenCalledOnce();
  });
  it('a malicious context/response cannot copy the selected credential into body or draft', async () => {
    const s = await setup();
    s.inspection.snapshot.fields[0]!.label = `Explain project ${CREDENTIAL_CANARY}`;
    await expect(s.prepare()).rejects.toMatchObject({ code: 'invalid_request' }); expect(s.transport).not.toHaveBeenCalled();
    s.inspection.snapshot.fields[0]!.label = 'Describe a project';
    s.transport.mockResolvedValue(jsonResponse(providerSuccess('openai', CREDENTIAL_CANARY)));
    await expect(s.prepare()).rejects.toMatchObject({ code: 'invalid_output' }); expect(s.dispatch).not.toHaveBeenCalled();
  });
  it('failure retains already accepted operation results and explicit retry sends selected evidence only', async () => {
    const s = await setup(); await s.decide((await s.prepare()).batch!);
    const before = await s.checkpoints.read();
    s.transport.mockResolvedValue(jsonResponse(providerRefusal('openai')));
    await expect(s.prepare()).rejects.toMatchObject({ code: 'refusal' });
    expect(await s.checkpoints.read()).toEqual(before); expect(s.dispatch).toHaveBeenCalledOnce();
    expect(s.transport).toHaveBeenCalledTimes(2);
  });
  it('evidence from a different selected field and invalid user-edited options are rejected locally', async () => {
    const s = await setup([field({ label: 'Project technology', type: 'select', category: 'choice', options: [{ fingerprint: hash, label: 'TypeScript', disabled: false }] })]);
    const c = structuredClone(s.context), extra = { ...structuredClone(c.fields[0]!), id: uuid(), evidence: [{ ref: 'projects.board.name', text: 'Task board' }] };
    c.fields.push(extra); const raw = s.proposals(c); raw.proposals[0]!.factRefs = [extra.evidence[0]!.ref];
    expect(() => validateProposals(raw, c)).toThrow();
    const batch = (await s.prepare()).batch!;
    await expect(s.service.execute({ channel: 'ai', schemaVersion: 1, requestId: uuid(), type: 'DECIDE', batchId: batch.id, decisions: [{ fieldId: batch.proposals[0]!.fieldId, action: 'approve', text: '', factsReviewed: true, optionId: 'invented' }] })).rejects.toMatchObject({ code: 'invalid_output' });
    expect(s.dispatch).not.toHaveBeenCalled();
  });
  it('rejects demographics, consequential declarations, incidental secrets and existing answers before context selection', async () => {
    for (const label of ['Gender', 'API key', 'Are you authorized to work?', 'Expected salary', 'I agree to terms', 'Date of birth', 'Visa sponsorship']) expect(safeAiField(field({ label }))).toBe(false);
    expect(safeAiField(field({ current: { present: true, fingerprint: hash } }))).toBe(false);
    const s = await setup();
    s.selections[0]!.evidenceRefs = ['contact.email'];
    expect(() => selectContext(s.inspection, s.input, s.selections, '')).toThrow();
  });
});
