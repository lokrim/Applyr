import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDB, type IDBPDatabase } from 'idb';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { CheckpointStore, StaleCheckpointError } from '../../src/storage/checkpoints';
import { ProfileStore } from '../../src/storage/profiles';
import { createCheckpoint, type SessionCheckpoint } from '../../src/domain/session';
import { PageAccessService, initialAccess, permissionMatches } from '../../src/runtime/page-access';
import { capturedTarget } from '../../src/browser/targets';
import { addressIdentity, parseApplicationUrl, sanitizedUrl } from '../../src/browser/addresses';
import { createCoordinator } from '../../src/runtime/coordinator';

const id = 'da295600-6e98-4ab1-a651-9405353b222a';
const otherId = 'da295600-6e98-4ab1-a651-9405353b222b';
const pages = { popup: 'chrome-extension://test/popup.html', session: 'chrome-extension://test/session.html', options: 'chrome-extension://test/options.html' };
const sender = { id: 'test', url: pages.session };
const envelope = { schemaVersion: 1, requestId: id };

describe('page identity and scoped read-only access', () => {
  let database: IDBPDatabase<ApplyrDatabase>, name: string, store: CheckpointStore;
  let checkpoint: SessionCheckpoint;
  let service: PageAccessService;
  const target = vi.fn(), probe = vi.fn(), contains = vi.fn(), createTab = vi.fn(), changed = vi.fn();
  const binding = () => ({ sessionId: checkpoint.id, revision: checkpoint.revision });
  beforeEach(async () => {
    vi.resetAllMocks(); name = `access-${crypto.randomUUID()}`; database = await openDatabase(name);
    store = new CheckpointStore(database, () => 2_000);
    checkpoint = createCheckpoint(await capturedTarget({ id: 7, windowId: 1, url: 'https://jobs.example/apply?id=one&token=secret&utm_source=tracking#secret', title: 'Engineer — token=secret' }), id, 1_000);
    checkpoint.access = initialAccess(checkpoint.target);
    await store.replace(checkpoint, { sessionId: null, revision: null });
    target.mockResolvedValue(checkpoint.target); contains.mockResolvedValue(false); createTab.mockResolvedValue({ id: 8, windowId: 1 });
    probe.mockResolvedValue({ result: { classification: 'application', identity: checkpoint.target.identity, role: 'Engineer', company: 'Fictional', frames: [] }, documentId: 'document-1' });
    service = new PageAccessService({ store: async () => store, target, probe, contains, createTab, changed, now: () => 2_000, uuid: () => otherId, allowLoopback: false });
  });
  afterEach(async () => { database.close(); await deleteDB(name); });

  it('keeps only sanitized metadata and retains job identifiers while distinguishing opaque query/hash identities', async () => {
    expect(checkpoint.target.url).toBe('https://jobs.example/apply?id=one');
    expect(checkpoint.target.title).toBe('Engineer — [redacted]');
    expect(JSON.stringify(checkpoint)).not.toContain('secret');
    expect(await addressIdentity('https://jobs.example/apply?id=two')).not.toBe(checkpoint.target.identity);
    expect(await addressIdentity('https://jobs.example/#/jobs/one')).not.toBe(await addressIdentity('https://jobs.example/#/jobs/two'));
    expect(sanitizedUrl(new URL('https://u:p@example.org/auth/private?token=private&id=123#private'))).toBe('https://example.org/auth/[redacted]?id=123');
  });

  it.each(['application', 'listing', 'login_challenge', 'irrelevant', 'restricted', 'uncertain'] as const)('records honest %s classification without candidate data', async (classification) => {
    probe.mockResolvedValue({ result: { classification, identity: checkpoint.target.identity, role: null, company: null, frames: [] } });
    const next = await service.probe(binding());
    expect(next.access?.classification).toBe(classification);
    expect(next.lifecycle).toBe(classification === 'application' ? 'QUEUED' : 'NEEDS_ATTENTION');
    expect(probe).toHaveBeenCalledWith(7, checkpoint.target.identity, undefined);
    expect(next.expiresAt).toBe(checkpoint.expiresAt);
    expect(createTab).not.toHaveBeenCalled();
  });

  it('rejects stale, wrong-session, forged, generic and non-popup capture messages before page work', async () => {
    const handle = createCoordinator({ extensionId: 'test', pages, store: async () => store, target, access: service, now: () => 2_000, uuid: () => otherId });
    const request = { ...envelope, ...binding(), type: 'PROBE_TARGET' };
    expect(await handle(request, { id: 'test', url: 'https://jobs.example', tab: { url: 'https://jobs.example' } })).toMatchObject({ code: 'FORBIDDEN' });
    expect(await handle({ ...request, sessionId: otherId }, sender)).toMatchObject({ code: 'STALE_CHECKPOINT' });
    expect(await handle({ ...request, revision: 33 }, sender)).toMatchObject({ code: 'STALE_CHECKPOINT' });
    expect(await handle({ ...request, frameId: 2 }, sender)).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(await handle({ ...request, frameOrigin: 'https://*' }, sender)).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(await handle({ ...request, frameOrigin: 'https://embed.example/path' }, sender)).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(await handle({ ...request, type: 'FETCH', url: 'https://provider.invalid' }, sender)).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(await handle({ ...request, type: 'CAPTURE_TARGET', tabId: 9 }, sender)).toMatchObject({ code: 'FORBIDDEN' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not consult the active tab; switching or closing an unrelated tab cannot change binding', async () => {
    await service.event(99, 'closed');
    expect(await store.read()).toEqual(checkpoint);
    const next = await service.probe(binding());
    expect(next.target.tabId).toBe(7);
    expect(target.mock.calls.every(([tabId]) => tabId === 7)).toBe(true);
  });

  it.each(['https://jobs.example/apply?id=two', 'https://other.example/apply?id=one'])('pauses on a different job/redirect %s, with sticky attention even after going back', async (url) => {
    target.mockResolvedValue(await capturedTarget({ id: 7, windowId: 1, url }));
    checkpoint = await service.probe(binding());
    expect(checkpoint.access?.reason).toBe('navigation');
    expect(probe).not.toHaveBeenCalled();
    target.mockResolvedValue(checkpoint.target);
    await service.event(7, 'reload'); await service.revoked(['https://jobs.example/*']);
    expect((await store.read())?.access?.reason).toBe('navigation');
    expect((await service.probe(binding())).access?.reason).toBe('navigation');
  });

  it('marks target closure, restart, reload and revoked access visibly and preserves local inputs', async () => {
    const snapshot = await new ProfileStore(database, () => 2_000).freeze(checkpoint.id, {
      source: 'replacement', document: { data: { profile_version: 1 }, notes: 'retained', answerBodies: {} },
    }, null);
    await service.event(7, 'closed');
    checkpoint = (await store.read())!;
    expect(checkpoint.access?.reason).toBe('closed');
    expect(await database.get('profiles', 'snapshot')).toEqual(snapshot);
    await service.event(null, 'restart'); expect((await store.read())?.access?.reason).toBe('restart');
  });

  it('handles denied/revoked access without leaking browser errors or requesting more access', async () => {
    probe.mockRejectedValue(new Error('https://secret.invalid/?token=canary'));
    checkpoint = await service.probe(binding());
    expect(checkpoint.access?.reason).toBe('permission');
    expect(JSON.stringify(checkpoint)).not.toContain('canary');
    await service.revoked(['https://unrelated.example/*']); expect((await store.read())?.revision).toBe(checkpoint.revision);
    await service.revoked(['https://jobs.example/*']); expect((await store.read())?.revision).toBe(checkpoint.revision + 1);
    expect(contains).not.toHaveBeenCalled();
  });

  it('requires the discovered exact frame origin and explicit browser grant, then fails closed on inaccessible frames', async () => {
    const frame = { url: 'https://embed.example/application', origin: 'https://embed.example', identity: 'a'.repeat(64) };
    probe.mockResolvedValue({ result: { classification: 'uncertain', identity: checkpoint.target.identity, role: null, company: null, frames: [frame] } });
    checkpoint = await service.probe(binding()); probe.mockClear();
    await expect(service.probe(binding(), 'https://unrelated.example')).rejects.toThrow('ACCESS_UNAVAILABLE');
    checkpoint = await service.probe(binding(), frame.origin, frame.identity);
    expect(checkpoint.access?.reason).toBe('frame_permission'); expect(probe).not.toHaveBeenCalled();
    expect(contains).toHaveBeenCalledWith(frame.origin);
    contains.mockResolvedValue(true); probe.mockRejectedValue(new Error('unrelated cross-origin frame denied'));
    checkpoint = await service.probe(binding(), frame.origin, frame.identity);
    expect(checkpoint.access?.reason).toBe('frame_unavailable');
    expect(probe).toHaveBeenCalledWith(7, frame.identity, frame);
  });

  it.each([false, true])('inspects only the discovered frame after access, same origin = %s', async (sameOrigin) => {
    const origin = sameOrigin ? 'https://jobs.example' : 'https://embed.example';
    const frame = { url: `${origin}/application`, origin, identity: 'a'.repeat(64) };
    probe.mockResolvedValue({ result: { classification: 'uncertain', identity: checkpoint.target.identity, role: null, company: null, frames: [frame] } });
    checkpoint = await service.probe(binding());
    contains.mockResolvedValue(true);
    probe.mockResolvedValue({ result: { classification: 'application', identity: frame.identity, role: null, company: null, frames: [] } });
    const next = await service.probe(binding(), origin, frame.identity);
    expect(next.access?.status).toBe('ready');
    expect(next.target.identity).toBe(checkpoint.target.identity);
    expect(next.access?.frames).toEqual([frame]);
    if (sameOrigin) expect(contains).not.toHaveBeenCalled();
    else expect(contains).toHaveBeenCalledExactlyOnceWith(origin);
    await service.revoked([`${origin}/*`]);
    expect((await store.read())?.access?.reason).toBe(sameOrigin ? 'permission' : 'frame_permission');
  });

  it('discards a probe if the target navigates between the precheck and result', async () => {
    const nextJob = await capturedTarget({ id: 7, windowId: 1, url: 'https://jobs.example/apply?id=two' });
    target.mockResolvedValueOnce(checkpoint.target).mockResolvedValueOnce(nextJob);
    expect((await service.probe(binding())).access?.reason).toBe('navigation');
  });

  it('selects the exact discovered embed when two applications share an origin', async () => {
    const frames = [
      { url: 'https://embed.example/application?id=one', origin: 'https://embed.example', identity: 'a'.repeat(64) },
      { url: 'https://embed.example/application?id=two', origin: 'https://embed.example', identity: 'b'.repeat(64) },
    ];
    probe.mockResolvedValue({ result: { classification: 'uncertain', identity: checkpoint.target.identity, role: null, company: null, frames } });
    checkpoint = await service.probe(binding()); contains.mockResolvedValue(true); probe.mockClear();
    await expect(service.probe(binding(), frames[1]!.origin, 'c'.repeat(64))).rejects.toThrow('ACCESS_UNAVAILABLE');
    expect(probe).not.toHaveBeenCalled();
    probe.mockResolvedValue({ result: { classification: 'application', identity: frames[1]!.identity, role: null, company: null, frames: [] } });
    await service.probe(binding(), frames[1]!.origin, frames[1]!.identity);
    expect(probe).toHaveBeenCalledExactlyOnceWith(7, frames[1]!.identity, frames[1]);
  });

  it('persists reload/revocation attention without renewing expiry and recovers only through a fresh probe', async () => {
    await service.event(7, 'reload'); checkpoint = (await store.read())!;
    expect(checkpoint).toMatchObject({ lifecycle: 'NEEDS_ATTENTION', access: { reason: 'reload' } });
    checkpoint = await service.probe(binding());
    await service.revoked(['https://jobs.example/*']); checkpoint = (await store.read())!;
    expect(checkpoint.access?.reason).toBe('permission');
    expect(checkpoint.expiresAt).toBe(1_000 + 7 * 86400_000);
    database.close(); database = await openDatabase(name); store = new CheckpointStore(database, () => 2_000);
    expect((await store.read())?.access?.reason).toBe('permission');
    probe.mockRejectedValue(new Error('access revoked'));
    expect((await service.probe(binding())).lifecycle).toBe('NEEDS_ATTENTION');
  });

  it('rejects malformed/mismatched results and concurrent navigation before accepting a probe', async () => {
    probe.mockResolvedValue({ result: { classification: 'application', identity: checkpoint.target.identity, password: 'forbidden' } });
    expect((await service.probe(binding())).access?.reason).toBe('navigation');
  });

  it('uses CAS to reject a probe that races another input/checkpoint mutation', async () => {
    probe.mockImplementation(async () => {
      await store.replace({ ...checkpoint, revision: 1 }, binding());
      return { result: { classification: 'application', identity: checkpoint.target.identity, role: null, company: null, frames: [] } };
    });
    await expect(service.probe(binding())).rejects.toBeInstanceOf(StaleCheckpointError);
    expect((await store.read())?.access?.status).toBe('unprobed');
  });

  it('retries passive state reads that race browser events without weakening mutation CAS', async () => {
    const verify = vi.spyOn(service, 'verify').mockRejectedValueOnce(new StaleCheckpointError()).mockResolvedValue(checkpoint);
    const handle = createCoordinator({ extensionId: 'test', pages, store: async () => store, target, access: service, now: () => 2_000, uuid: () => otherId });
    expect(await handle({ ...envelope, type: 'GET_STATE', sessionId: null, revision: null }, sender)).toMatchObject({ ok: true, checkpoint: { id } });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(probe).not.toHaveBeenCalled();
    verify.mockRestore();
  });

  it('only opens on explicit intent, creates a new tab/binding and releases old temporary inputs', async () => {
    await database.put('profiles', { localCanary: 'old-job' }, 'snapshot');
    const next = await service.open(binding(), 'https://new.example/apply?id=two');
    expect(createTab).toHaveBeenCalledExactlyOnceWith('https://new.example/apply?id=two');
    expect(next).toMatchObject({ id: otherId, target: { tabId: 8, origin: 'https://new.example' }, access: { reason: 'permission' } });
    expect(await database.get('profiles', 'snapshot')).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(contains).not.toHaveBeenCalled();
  });

  it('validates before tab creation and rejects stale opens', async () => {
    for (const url of ['http://jobs.example/a', 'javascript:alert(1)', 'file:///a', 'https://u:p@example.org', 'https://addons.mozilla.org/a', 'https://example.org/a.pdf']) await expect(service.open(binding(), url)).rejects.toThrow('INVALID_URL');
    await expect(service.open({ ...binding(), revision: 9 }, 'https://new.example')).rejects.toBeInstanceOf(StaleCheckpointError);
    expect(createTab).not.toHaveBeenCalled();
  });

  it('limits HTTP to explicitly enabled development loopback and exact origin patterns', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(parseApplicationUrl(`http://${host}:1234/job`, true).protocol).toBe('http:');
    for (const url of ['http://localhost/job', 'http://127.0.0.2/job', 'http://localhost.evil/job']) expect(() => parseApplicationUrl(url)).toThrow();
    expect(() => parseApplicationUrl('http://localhost.evil/job', true)).toThrow();
    expect(permissionMatches('https://*.example/*', 'https://jobs.example')).toBe(true);
    expect(permissionMatches('https://jobs.example/*', 'https://jobs.example.evil')).toBe(false);
  });
});
