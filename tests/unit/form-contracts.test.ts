import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDB, type IDBPDatabase } from 'idb';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { CheckpointStore } from '../../src/storage/checkpoints';
import { createCheckpoint, type SessionCheckpoint } from '../../src/domain/session';
import { capturedTarget } from '../../src/browser/targets';
import { initialAccess, PageAccessService } from '../../src/runtime/page-access';
import { createCoordinator } from '../../src/runtime/coordinator';
import { FormSnapshotSchema, type FormSnapshot } from '../../src/forms/schema';
import { RequestSchema } from '../../src/runtime/schemas';

const id = 'da295600-6e98-4ab1-a651-9405353b222a';
const pages = { popup: 'chrome-extension://test/popup.html', session: 'chrome-extension://test/session.html', options: 'chrome-extension://test/options.html' };
const sender = { id: 'test', url: pages.session };

describe('ephemeral read-only inspection contracts', () => {
  let database: IDBPDatabase<ApplyrDatabase>, name: string, store: CheckpointStore, checkpoint: SessionCheckpoint, snapshot: FormSnapshot, service: PageAccessService;
  const target = vi.fn(), inspect = vi.fn(), contains = vi.fn();
  const binding = () => ({ sessionId: checkpoint.id, revision: checkpoint.revision });
  const request = () => ({ schemaVersion: 1, requestId: id, type: 'INSPECT_FORM', ...binding() });
  const handle = () => createCoordinator({ extensionId: 'test', pages, store: async () => store, target, access: service, now: () => 2_000, uuid: () => id });
  beforeEach(async () => {
    vi.resetAllMocks(); name = `inspection-${crypto.randomUUID()}`; database = await openDatabase(name); store = new CheckpointStore(database, () => 2_000);
    checkpoint = createCheckpoint(await capturedTarget({ id: 7, windowId: 1, url: 'https://jobs.example/apply?id=one' }), id, 1_000);
    checkpoint.access = { ...initialAccess(checkpoint.target), status: 'ready', classification: 'application', reason: 'application' };
    await store.replace(checkpoint, { sessionId: null, revision: null }); target.mockResolvedValue(checkpoint.target);
    snapshot = { schemaVersion: 1, identity: checkpoint.target.identity!, document: id, revision: 1, status: 'stable', selectedForm: id, forms: [{ id, label: 'Application', fieldCount: 0 }], fields: [], unsupported: [], observation: { mutations: 0, scans: 3, bounded: true } };
    inspect.mockResolvedValue({ result: snapshot, documentId: 'browser-document', frameId: 0 });
    service = new PageAccessService({ store: async () => store, target, inspect, probe: vi.fn(), contains, createTab: vi.fn(), changed: vi.fn(), now: () => 2_000, uuid: () => id, allowLoopback: false });
  });
  afterEach(async () => { database.close(); await deleteDB(name); });

  it('returns a validated snapshot bound to session/tab/frame/document without checkpoint persistence or renewed retention', async () => {
    expect(await handle()(request(), sender)).toMatchObject({ ok: true, checkpoint, inspection: { sessionId: id, tabId: 7, frameId: 0, browserDocumentId: 'browser-document', snapshot } });
    expect(await store.read()).toEqual(checkpoint);
    expect(JSON.stringify(await database.getAll('checkpoints'))).not.toContain('snapshot');
  });
  it('rejects page senders, extra selectors, wrong sessions and stale checkpoint revisions before injection', async () => {
    expect(await handle()(request(), { id: 'test', url: 'https://jobs.example', tab: { url: 'https://jobs.example' } })).toMatchObject({ code: 'FORBIDDEN' });
    expect(await handle()({ ...request(), selector: 'input' }, sender)).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(await handle()({ ...request(), revision: 99 }, sender)).toMatchObject({ code: 'STALE_CHECKPOINT' });
    expect(await handle()({ ...request(), sessionId: crypto.randomUUID() }, sender)).toMatchObject({ code: 'STALE_CHECKPOINT' });
    expect(inspect).not.toHaveBeenCalled();
  });
  it.each(['closed', 'navigation', 'restart', 'permission', 'reload'] as const)('blocks %s observations until page access is restored', async (reason) => {
    await service.event(7, reason); checkpoint = (await store.read())!;
    expect(await handle()(request(), sender)).toMatchObject({ code: 'ACCESS_UNAVAILABLE' }); expect(inspect).not.toHaveBeenCalled();
  });
  it('denies undiscovered/ungranted frames before injection, rechecks grants after results, and accepts the exact same-origin frame', async () => {
    const frame = { url: 'https://embed.example/application', origin: 'https://embed.example', identity: 'a'.repeat(64) };
    checkpoint.access!.frames = [frame]; await store.replace(checkpoint, binding());
    await expect(service.inspect(binding(), 'https://unknown.example', frame.identity)).rejects.toThrow('ACCESS_UNAVAILABLE');
    contains.mockResolvedValue(false); await expect(service.inspect(binding(), frame.origin, frame.identity)).rejects.toThrow('ACCESS_UNAVAILABLE'); expect(inspect).not.toHaveBeenCalled();
    contains.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    inspect.mockResolvedValue({ result: { ...snapshot, identity: frame.identity }, frameId: 2 });
    await expect(service.inspect(binding(), frame.origin, frame.identity)).rejects.toThrow('ACCESS_UNAVAILABLE');
    const same = { ...frame, url: 'https://jobs.example/application', origin: 'https://jobs.example' }; checkpoint.access!.frames = [same]; await store.replace(checkpoint, binding()); contains.mockClear();
    expect((await service.inspect(binding(), same.origin, same.identity)).inspection).toMatchObject({ frameId: 2, snapshot: { identity: frame.identity } }); expect(contains).not.toHaveBeenCalled();
  });
  it('drops changed-job and concurrent checkpoint results', async () => {
    target.mockResolvedValueOnce(checkpoint.target).mockResolvedValueOnce({ ...checkpoint.target, identity: 'b'.repeat(64) });
    await expect(service.inspect(binding())).rejects.toThrow('ACCESS_UNAVAILABLE');
    target.mockResolvedValue(checkpoint.target); inspect.mockImplementation(async () => { await service.event(7, 'reload'); return { result: snapshot, frameId: 0 }; });
    expect(await handle()(request(), sender)).toMatchObject({ code: 'STALE_CHECKPOINT' });
  });
  it('sanitizes failed injection and rejects malformed/foreign results without storing any contents', async () => {
    inspect.mockRejectedValueOnce(new Error('AUTH_CANARY at secret URL')); expect(await handle()(request(), sender)).toMatchObject({ code: 'ACCESS_UNAVAILABLE' });
    for (const result of [{ ...snapshot, password: 'AUTH_CANARY' }, { ...snapshot, identity: 'c'.repeat(64) }, { ...snapshot, observation: { mutations: 0, scans: 1, bounded: false } }]) {
      inspect.mockResolvedValue({ result, frameId: 0 }); expect(await handle()(request(), sender)).toMatchObject({ code: 'ACCESS_UNAVAILABLE' });
    }
    expect(await store.read()).toEqual(checkpoint);
  });
  it('allows only opaque selection IDs/revision and rejects value-bearing or unbounded snapshot contracts', () => {
    expect(RequestSchema.safeParse({ ...request(), selection: { formId: id, document: id, revision: 1 } }).success).toBe(true);
    for (const selection of [{ formId: 'css-selector', document: id, revision: 1 }, { formId: id, document: id, revision: 0 }, { formId: id, document: id, revision: 1, value: 'secret' }]) expect(RequestSchema.safeParse({ ...request(), selection }).success).toBe(false);
    expect(FormSnapshotSchema.safeParse({ ...snapshot, fields: Array(101).fill({}) }).success).toBe(false);
  });
});
