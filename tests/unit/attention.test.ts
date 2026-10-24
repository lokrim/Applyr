import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteDB, type IDBPDatabase } from 'idb';
import { createCheckpoint, transition } from '../../src/domain/session';
import { CheckpointSchema, RequestSchema } from '../../src/runtime/schemas';
import { accessQueue, inspectionQueue, pending, usableCorrections, draftQueue } from '../../src/attention/queue';
import { AttentionService } from '../../src/attention/service';
import { AttentionAlerts, openAttentionAlert, badgeStatus, parseAlerts, type AlertState } from '../../src/browser/attention-alerts';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { CheckpointStore } from '../../src/storage/checkpoints';
import { ProfileStore } from '../../src/storage/profiles';
import type { PageAccessService } from '../../src/runtime/page-access';
import type { FormSnapshot, Inspection } from '../../src/forms/schema';
import type { MappingInput } from '../../src/mapping/rules';

const uuid = () => crypto.randomUUID(), hash = 'a'.repeat(64);
function field(p: Partial<FormSnapshot['fields'][number]> = {}): FormSnapshot['fields'][number] { return { id: uuid(), label: 'Email', labelSource: 'label', context: [], type: 'email', autocomplete: 'email', required: true, executable: true, category: 'short_answer', filePurpose: null, constraints: { min: '', max: '', step: '', minLength: '', maxLength: '', pattern: '', accept: '', multiple: false }, options: [], current: { fingerprint: hash, present: false }, validation: { valid: false, flags: ['valueMissing'], ariaInvalid: false, errorPresent: false }, ...p }; }
function setup(fields = [field()]) {
  const cp = createCheckpoint({ tabId: 7, windowId: 1, origin: 'https://jobs.test', identity: hash, availability: 'https' }, uuid(), Date.now());
  cp.access = { status: 'ready', classification: 'application', reason: 'application', frames: [] };
  const formId = uuid();
  const inspection: Inspection = { sessionId: cp.id, tabId: 7, frameId: 0, browserDocumentId: 'browser-doc', snapshot: { schemaVersion: 1, identity: hash, document: uuid(), revision: 1, status: 'stable', selectedForm: formId, forms: [{ id: formId, label: 'Application', fieldCount: fields.length }], fields, unsupported: [], observation: { mutations: 0, scans: 3, bounded: true } } };
  const input: MappingInput = { sessionId: cp.id, version: uuid(), source: 'replacement', document: { data: { profile_version: 1 }, notes: '', answerBodies: {} }, expiresAt: Date.now() + 100000 };
  return { cp, inspection, input };
}
let db: IDBPDatabase<ApplyrDatabase> | undefined;
afterEach(async () => { if (db) { const name = db.name; db.close(); db = undefined; await deleteDB(name); } });

describe('durable attention observations', () => {
  it('batches missing and conflicting facts, eligibility, required declarations, unsupported and validation', async () => {
    const yes = { label: 'Yes', disabled: false, fingerprint: hash }, no = { ...yes, label: 'No', fingerprint: 'b'.repeat(64) };
    const s = setup([field(), field({ label: 'Work arrangement', type: 'select', autocomplete: '', options: [yes, no] }), field({ label: 'Are you authorized to work in US?', type: 'select', autocomplete: '', category: 'sensitive', executable: false, options: [yes, no] }), field({ label: 'I certify these answers', type: 'checkbox', category: 'declaration', executable: false }), field({ label: 'Website', type: 'url', current: { present: true, fingerprint: hash }, validation: { valid: false, flags: ['customError'], ariaInvalid: true, errorPresent: true } })]);
    s.input.document.data.preferences = { work_arrangements: ['onsite', 'remote'] };
    s.inspection.snapshot.unsupported.push({ code: 'custom_control', label: 'Manual widget' });
    const q = await inspectionQueue(s.cp, s.inspection, s.input);
    expect(q.items.map((i) => i.code)).toEqual(['missing', 'ambiguous', 'eligibility', 'consent', 'validation', 'unsupported']);
    expect(q.items.find((i) => i.code === 'consent')).toMatchObject({ correctable: false, status: 'open', required: true });
    expect(q.items.find((i) => i.code === 'eligibility')).toMatchObject({ correctable: true, inputKind: 'boolean' });
    s.cp.attention = q; expect(await inspectionQueue(s.cp, s.inspection, s.input)).toEqual(q);
  });
  it('preserves item ID and only advances blocker revision for a meaningful observation', async () => {
    const s = setup(); const q = await inspectionQueue(s.cp, s.inspection, s.input); s.cp.attention = q;
    s.inspection.snapshot.revision++;
    const same = await inspectionQueue(s.cp, s.inspection, s.input);
    expect(same.items[0]!.id).toBe(q.items[0]!.id); expect(same.items[0]!.revision).toBe(q.items[0]!.revision);
    s.cp.attention = same; s.inspection.snapshot.fields[0]!.validation = { valid: false, flags: ['customError'], ariaInvalid: true, errorPresent: true };
    const changed = await inspectionQueue(s.cp, s.inspection, s.input);
    expect(changed.items[0]!.id).toBe(q.items[0]!.id); expect(changed.items[0]!.revision).toBeGreaterThan(q.items[0]!.revision);
  });
  it('a manually checked declaration only resolves after a valid fresh observation', async () => {
    const s = setup([field({ category: 'declaration', executable: false, type: 'checkbox', label: 'I attest' })]);
    s.cp.attention = await inspectionQueue(s.cp, s.inspection, s.input);
    expect(s.cp.attention.items[0]!.status).toBe('open');
    const f = s.inspection.snapshot.fields[0]!; f.current.present = true; f.validation = { valid: true, flags: [], ariaInvalid: false, errorPresent: false };
    expect((await inspectionQueue(s.cp, s.inspection, s.input)).items[0]!.status).toBe('resolved');
  });
  it.each(['login', 'otp', 'captcha', 'authentication'] as const)('keeps %s manual and generic', async (code) => {
    const s = setup([]); s.inspection.snapshot.unsupported = [{ code, label: 'No auth values read' }];
    const q = await inspectionQueue(s.cp, s.inspection, s.input);
    expect(q.items[0]).toMatchObject({ code, question: 'Authentication or challenge', correctable: false, status: 'open' });
    s.cp.access = { status: 'needs_attention', classification: 'login_challenge', challenge: code, reason: 'login_challenge', frames: [] };
    expect(accessQueue(s.cp)?.items[0]?.code).toBe(code);
  });
  it('reports rejected/unverified uploads without treating selected bytes as acceptance', async () => {
    const s = setup([field({ type: 'file', category: 'file', filePurpose: 'resume', current: { present: true, fingerprint: hash }, validation: { valid: true, flags: [], ariaInvalid: false, errorPresent: false } })]);
    expect((await inspectionQueue(s.cp, s.inspection, s.input)).items[0]).toMatchObject({ code: 'upload', status: 'open', correctable: false });
    s.inspection.snapshot.fields[0]!.validation.ariaInvalid = true;
    expect((await inspectionQueue(s.cp, s.inspection, s.input)).items[0]!.code).toBe('upload');
  });
  it('invalidates old target fields on navigation and rejects malformed attention data', async () => {
    const s = setup(); s.cp.attention = await inspectionQueue(s.cp, s.inspection, s.input);
    s.cp.access = { ...s.cp.access!, status: 'needs_attention', reason: 'navigation' };
    const q = accessQueue(s.cp)!;
    expect(q.items.some((i) => i.code === 'navigation' && pending(i))).toBe(true);
    expect(q.items.find((i) => i.target)?.status).toBe('stale');
    expect(CheckpointSchema.safeParse({ ...s.cp, attention: { ...q, arbitrarySecret: 'denied' } }).success).toBe(false);
    expect(RequestSchema.safeParse({ schemaVersion: 1, requestId: uuid(), sessionId: s.cp.id, revision: 0, type: 'SHOW_ATTENTION', selector: '#password' }).success).toBe(false);
  });
});

describe('reviewed answer persistence and guards', () => {
  async function service() {
    const s = setup(); db = await openDatabase(`attention-${uuid()}`);
    const store = new CheckpointStore(db); await store.replace(s.cp, { sessionId: null, revision: null });
    const profiles = new ProfileStore(db); const input = await profiles.freeze(s.cp.id, { source: 'replacement', document: s.input.document }, null);
    const access = { inspect: vi.fn(async () => ({ checkpoint: (await store.read())!, inspection: s.inspection })), verify: vi.fn(async (cp) => cp) } as unknown as PageAccessService;
    const activate = vi.fn(async () => {}), mark = vi.fn(async () => true);
    const svc = new AttentionService({ database: async () => db!, access, changed: vi.fn(), activate, mark });
    const cp = await svc.observe((await store.read())!, s.inspection);
    const answer = (itemRevision = cp.attention!.items[0]!.revision) => ({ schemaVersion: 1 as const, requestId: uuid(), type: 'ATTENTION_ANSWERS' as const, sessionId: cp.id, revision: cp.revision, answers: [{ itemId: cp.attention!.items[0]!.id, itemRevision, value: 'alex@example.test', eligibilityConfirmed: false }] });
    return { ...s, cp, store, profiles, svc, activate, mark, input, answer };
  }
  it('saves a batch only after reinspection, never modifies the profile or the page', async () => {
    const s = await service(); const result = await s.svc.answers(s.answer());
    const item = result.checkpoint.attention!.items[0]!;
    expect(item).toMatchObject({ status: 'answer_ready', correction: { value: 'alex@example.test' } });
    expect((await s.profiles.read()).snapshot).toEqual(s.input); expect((await s.profiles.read()).saved).toBeNull();
    expect(s.activate).not.toHaveBeenCalled();
    expect(usableCorrections(result.checkpoint, s.inspection, s.input)).toHaveLength(1);
    const name = db!.name; db!.close(); db = await openDatabase(name);
    const reopened = (await new CheckpointStore(db).read())!;
    expect(reopened.attention!.items[0]!.correction?.value).toBe('alex@example.test');
    expect(transition(reopened, { type: 'PAUSE' }, Date.now()).attention).toEqual(reopened.attention);
    expect(transition(reopened, { type: 'CANCEL' }, Date.now()).attention!.items[0]!.correction).toBeUndefined();
  });
  it.each(['stale revision', 'remount', 'changed semantics', 'invalid answer'] as const)('rejects %s without an answer/field effect', async (failure) => {
    const s = await service(); const request = s.answer(failure === 'stale revision' ? 999 : undefined);
    if (failure === 'remount') s.inspection.snapshot.fields[0]!.id = uuid();
    if (failure === 'changed semantics') s.inspection.snapshot.fields[0]!.label = 'Password';
    if (failure === 'invalid answer') request.answers[0]!.value = 'not-email';
    await expect(s.svc.answers(request)).rejects.toThrow();
    expect((await s.store.read())!.attention!.items[0]!.correction).toBeUndefined();
  });
  it('Show field rejects stale focus and changed frame/document; Return rejects changed identity', async () => {
    const s = await service(); const b = { sessionId: s.cp.id, revision: s.cp.revision };
    s.inspection.snapshot.document = uuid();
    await expect(s.svc.show(b, s.cp.attention!.items[0]!.id)).rejects.toThrow(); expect(s.activate).not.toHaveBeenCalled();
  });
  it('profile deletion strips temporary answers from current and retained ledgers', async () => {
    const s = await service(); const saved = await s.profiles.saveDefault(s.input.document, null); await s.svc.answers(s.answer());
    await s.profiles.deleteDefault(saved.version);
    expect((await s.store.read())!.attention).toBeUndefined();
  });
});

describe('generic badge and optional notification batches', () => {
  async function alerts(enabled = true, permission = true, supported = true) {
    const s = setup([field(), field({ label: 'First name', autocomplete: 'given-name', type: 'text' })]); s.cp.attention = await inspectionQueue(s.cp, s.inspection, s.input);
    let state: AlertState = { enabled, seen: [], links: [] };
    const create = vi.fn(async () => {}), badge = vi.fn(async () => {}), clear = vi.fn(async () => {});
    const deps = { read: async () => state, write: async (v: AlertState) => { state = v; }, permission: vi.fn(async () => permission), create: supported ? create : undefined, badge, clear };
    return { ...s, deps, create, badge, clear, state: () => state, alerts: new AttentionAlerts(deps) };
  }
  it('off by default, requests no permission and still updates the badge', async () => {
    expect(parseAlerts(undefined).enabled).toBe(false);
    const s = await alerts(false); await s.alerts.refresh(s.cp); expect(s.deps.permission).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled(); expect(s.badge).toHaveBeenCalledWith({ text: '!', title: 'applyr: needs attention' });
  });
  it('batches several blockers, deduplicates concurrent refresh/reopen and emits only generic text', async () => {
    const s = await alerts(); await Promise.all([s.alerts.refresh(s.cp), s.alerts.refresh(s.cp)]);
    await new AttentionAlerts(s.deps).refresh(s.cp); expect(s.create).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(s.create.mock.calls); expect(payload).not.toMatch(/Email|First name|alex|jobs\.test/);
    expect(s.state().links[0]?.sessionId).toBe(s.cp.id); expect(s.state().seen).toHaveLength(2);
    s.cp.attention!.items[0]!.revision++; await s.alerts.refresh(s.cp); expect(s.create).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])('denial/revocation disables optional alerts and leaves queue/badge usable (%s)', async (wasEnabled) => {
    const s = await alerts(wasEnabled, false); await s.alerts.refresh(s.cp);
    expect(s.create).not.toHaveBeenCalled(); expect(s.state().enabled).toBe(false); expect(badgeStatus(s.cp).text).toBe('!'); expect(s.cp.attention!.items).toHaveLength(2);
  });
  it('unsupported API and delivery errors do not fail the queue', async () => {
    const s = await alerts(true, true, false); await expect(s.alerts.refresh(s.cp)).resolves.toBeUndefined();
    const a = await alerts(); a.create.mockRejectedValue(new Error('OS blocked')); await a.alerts.refresh(a.cp); await a.alerts.refresh(a.cp); expect(a.create).toHaveBeenCalledTimes(1);
  });
  it('badge uses only fixed generic statuses, never personal text', () => {
    const s = setup(); s.cp.target.role = 'PRIVATE_ROLE';
    for (const lifecycle of ['RUNNING', 'PAUSED', 'NEEDS_ATTENTION', 'READY_FOR_REVIEW', 'AUTOFILL_FINISHED', 'CANCELLED'] as const) expect(JSON.stringify(badgeStatus({ ...s.cp, lifecycle }))).not.toMatch(/PRIVATE|jobs|Email|alex/);
    expect(badgeStatus({ ...s.cp, lifecycle: 'CANCELLED' }).text).toBe('');
  });
});


describe('review obligation and notification session routing', () => {
  it('persists draft-review obligations without unapproved text or automatic fact promotion', () => {
    const s = setup(); const batchId = uuid();
    const q = draftQueue(s.cp, batchId, [{ id: uuid(), question: 'Why this role?' }]);
    expect(q.items[0]).toMatchObject({ code: 'draft', status: 'open', correctable: false });
    expect(q.items[0]!.correction).toBeUndefined();
    expect(q.items[0]!.action).toContain('may incur a new charge');
  });
  it('notification click selects its own parked session with reattachment required and no execution', async () => {
    db = await openDatabase(`notification-route-${uuid()}`); const store = new CheckpointStore(db);
    const a = setup().cp, b = setup().cp;
    await store.replace(a, { sessionId: null, revision: null }); await store.replace(b, { sessionId: a.id, revision: a.revision });
    const token = uuid(), open = vi.fn(async () => {});
    const deps = { state: async () => ({ enabled: true, seen: [], links: [{ token, sessionId: a.id }] }), current: () => store.read(), archived: () => store.archived(), restore: (id: string, expected: { sessionId: string; revision: number }) => store.restore(id, expected), open };
    expect(await openAttentionAlert('untrusted-id', deps)).toBe(false); expect(open).not.toHaveBeenCalled();
    expect(await openAttentionAlert(`applyr-${token}`, deps)).toBe(true);
    expect(await store.read()).toMatchObject({ id: a.id, lifecycle: 'PAUSED', recovery: { reattachRequired: true, inspectionRequired: true } });
    expect((await store.archived()).some((c) => c.id === b.id)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('frame-wide attention reinspection', () => {
  async function embedded(code: 'custom_control' | 'captcha' = 'custom_control', multipleForms = false) {
    const s = setup([]), frame = { origin: 'https://embed.test', url: 'https://embed.test/apply', identity: 'b'.repeat(64) };
    s.cp.access!.frames = [frame];
    s.inspection.frameId = 9; s.inspection.snapshot.identity = frame.identity;
    if (multipleForms) s.inspection.snapshot.forms.push({ id: uuid(), label: 'Other application form', fieldCount: 2 });
    s.inspection.snapshot.unsupported = [{ code, label: 'Embedded manual area' }];
    db = await openDatabase(`frame-attention-${uuid()}`); const store = new CheckpointStore(db);
    await store.replace(s.cp, { sessionId: null, revision: null });
    const inspect = vi.fn(async () => ({ checkpoint: (await new CheckpointStore(db!).read())!, inspection: s.inspection }));
    const probe = vi.fn(async () => (await new CheckpointStore(db!).read())!);
    const access = { inspect, probe } as unknown as PageAccessService;
    const svc = new AttentionService({ database: async () => db!, access, changed: vi.fn(), activate: vi.fn(), mark: vi.fn() });
    const cp = await svc.observe((await store.read())!, s.inspection);
    return { ...s, cp, store, frame, inspect, probe, svc };
  }
  it.each(['custom_control', 'captcha'] as const)('rechecks %s in its own frame after manual completion and reopen', async (code) => {
    const s = await embedded(code), item = s.cp.attention!.items.find((i) => i.key.startsWith('area:'))!;
    expect(item.target).toBeUndefined();
    expect(item).toHaveProperty('context.frameId', 9);
    const name = db!.name; db!.close(); db = await openDatabase(name);
    const cp = (await new CheckpointStore(db).read())!;
    s.inspection.snapshot.unsupported = []; s.inspection.snapshot.revision++;
    const result = await s.svc.reinspect({ sessionId: cp.id, revision: cp.revision }, item.id);
    expect(s.inspect).toHaveBeenCalledWith({ sessionId: cp.id, revision: cp.revision }, s.frame.origin, s.frame.identity, undefined);
    expect(result.checkpoint.attention!.items.find((i) => i.id === item.id)?.status).toBe('stale');
  });
  it.each(['tab', 'frame', 'browser document', 'registry document', 'identity', 'missing frame', 'legacy', 'permission', 'unstable', 'stale selection'] as const)('rejects %s mismatch without retiring the blocker or falling back to root', async (kind) => {
    const s = await embedded(), item = s.cp.attention!.items.find((i) => i.key.startsWith('area:'))!;
    if (kind === 'tab') item.context!.tabId++;
    if (kind === 'missing frame') s.cp.access!.frames = [];
    if (kind === 'legacy') item.context = undefined;
    await s.store.replace(s.cp, { sessionId: s.cp.id, revision: s.cp.revision });
    if (kind === 'frame') s.inspection.frameId++;
    if (kind === 'browser document') s.inspection.browserDocumentId = 'reloaded';
    if (kind === 'registry document') s.inspection.snapshot.document = uuid();
    if (kind === 'identity') s.inspection.snapshot.identity = 'c'.repeat(64);
    if (kind === 'unstable') s.inspection.snapshot.status = 'unstable';
    if (kind === 'stale selection') s.inspection.snapshot.status = 'stale_selection';
    if (kind === 'permission') s.inspect.mockRejectedValue(new Error('ACCESS_UNAVAILABLE'));
    await expect(s.svc.reinspect({ sessionId: s.cp.id, revision: s.cp.revision }, item.id)).rejects.toThrow();
    expect((await s.store.read())!.attention!.items.find((i) => i.id === item.id)!.status).toBe('open');
    if (['tab', 'missing frame', 'legacy'].includes(kind)) expect(s.inspect).not.toHaveBeenCalled();
    else expect(s.inspect.mock.calls[0]).toEqual([{ sessionId: s.cp.id, revision: s.cp.revision }, s.frame.origin, s.frame.identity, undefined]);
  });
  it('top-level inspection cannot retire embedded areas and navigation invalidates area context', async () => {
    const s = await embedded(), item = s.cp.attention!.items.find((i) => i.key.startsWith('area:'))!;
    const root = setup([]).inspection; root.sessionId = s.cp.id; root.tabId = s.cp.target.tabId;
    const q = await inspectionQueue(s.cp, root, null);
    expect(q.items.find((i) => i.id === item.id)?.status).toBe('open');
    s.cp.access = { ...s.cp.access!, status: 'needs_attention', reason: 'navigation' };
    expect(accessQueue(s.cp)!.items.find((i) => i.id === item.id)?.status).toBe('stale');
    expect(CheckpointSchema.safeParse({ ...s.cp, attention: { ...q, items: q.items.map((i) => ({ ...i, context: i.context ? { ...i.context, secret: 'denied' } : undefined })) } }).success).toBe(false);
  });

  it('rechecks access in the recorded embedded context rather than probing the top page', async () => {
    const s = await embedded(), item = s.cp.attention!.items.find((i) => i.key.startsWith('area:'))!;
    s.cp.access = { ...s.cp.access!, status: 'needs_attention', reason: 'frame_permission' };
    await s.store.replace(s.cp, { sessionId: s.cp.id, revision: s.cp.revision });
    await s.svc.reinspect({ sessionId: s.cp.id, revision: s.cp.revision }, item.id);
    expect(s.probe).toHaveBeenCalledWith({ sessionId: s.cp.id, revision: s.cp.revision }, s.frame.origin, s.frame.identity);
    expect(s.inspect).not.toHaveBeenCalled();
  });

  it('retains an explicit multi-form selection when rechecking an embedded area', async () => {
    const s = await embedded('custom_control', true), item = s.cp.attention!.items.find((i) => i.key.startsWith('area:'))!;
    await s.svc.reinspect({ sessionId: s.cp.id, revision: s.cp.revision }, item.id);
    expect(s.inspect).toHaveBeenCalledWith({ sessionId: s.cp.id, revision: s.cp.revision }, s.frame.origin, s.frame.identity, { formId: s.inspection.snapshot.selectedForm, document: s.inspection.snapshot.document, revision: 1 });
  });

});
