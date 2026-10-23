import 'fake-indexeddb/auto';
import { openDB, deleteDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { ProviderStorage, type TrustedSession } from '../../src/providers/storage';
import { ProviderService, providerHandler } from '../../src/providers/service';
import { ProviderFailure, defaultConfig, type Provider } from '../../src/providers/contracts';
import { createAdapter } from '../../src/providers/adapters';
import { CREDENTIAL_CANARY, jsonResponse, providerSuccess } from '../fixtures/providers';

const options = 'chrome-extension://test/options.html';
const sender = { id: 'test', url: options, frameId: 0, tab: { url: options } };
const envelope = (provider: Provider) => ({ channel: 'providers' as const, schemaVersion: 1 as const, requestId: crypto.randomUUID(), provider });
function memorySession() {
  const data: Record<string, unknown> = {};
  const session: TrustedSession = {
    get: vi.fn(async (key) => ({ [key]: data[key] })),
    set: vi.fn(async (items) => { Object.assign(data, items); }),
    remove: vi.fn(async (key) => { delete data[key]; }),
    setAccessLevel: vi.fn(async () => {}),
  };
  return { data, session };
}
describe('F11 credential and consent isolation', () => {
  let db: IDBPDatabase<ApplyrDatabase>, name: string, storage: ProviderStorage, service: ProviderService, mem: ReturnType<typeof memorySession>;
  const transport = vi.fn(), contains = vi.fn();
  beforeEach(async () => {
    name = `provider-${crypto.randomUUID()}`; db = await openDatabase(name); mem = memorySession();
    storage = new ProviderStorage(async () => db, mem.session); contains.mockResolvedValue(true); transport.mockImplementation(async () => jsonResponse(providerSuccess('openai')));
    service = new ProviderService(storage, contains, (p) => createAdapter(p, transport));
  });
  afterEach(async () => { vi.resetAllMocks(); db.close(); await deleteDB(name); });
  const status = (p: Provider = 'openai') => service.execute({ ...envelope(p), type: 'STATUS' });
  const save = (p: Provider = 'openai', extra = {}) => service.execute({ ...envelope(p), type: 'SAVE', config: { ...defaultConfig(p), model: 'fixture-model', ...extra }, key: CREDENTIAL_CANARY });
  it('migrates v3 without touching profile/document/checkpoint data', async () => {
    db.close(); await deleteDB(name);
    const old = await openDB(name, 3, { upgrade(d) { for (const n of ['checkpoints', 'profiles', 'documents', 'documentBlobs', 'documentLinks']) d.createObjectStore(n); } });
    await old.put('profiles', { fixture: true }, 'default'); old.close(); db = await openDatabase(name);
    expect(db.version).toBe(4); expect(await db.get('profiles', 'default')).toEqual({ fixture: true }); expect(await db.count('providerCredentials')).toBe(0);
  });
  it('loads no network or candidate storage and returns honest unverified status without credentials', async () => {
    await db.put('profiles', { name: 'F11_PRIVATE_PROFILE' }, 'default');
    expect(await status()).toMatchObject({ hasKey: false, status: { state: 'unverified', capability: null } });
    const tested = await service.execute({ ...envelope('openai'), type: 'TEST', revision: 0 });
    expect(tested).toMatchObject({ hasKey: false, status: { state: 'error', code: 'auth', capability: null } });
    expect(JSON.stringify(tested)).not.toContain('F11_PRIVATE_PROFILE'); expect(transport).not.toHaveBeenCalled();
  });
  it('defaults to trusted session only and never exposes a key, suffix or raw provider data in responses', async () => {
    const saved = await save(); expect(saved.hasKey).toBe(true); expect(saved.config.remember).toBe(false);
    expect(mem.session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(await db.count('providerCredentials')).toBe(0); expect(mem.data['provider-key:openai']).toBe(CREDENTIAL_CANARY);
    const verified = await service.execute({ ...envelope('openai'), type: 'TEST', revision: 1 });
    expect(verified.status.state).toBe('verified');
    for (const value of [saved, verified, await status(), await db.getAll('providerSettings'), await db.getAll('checkpoints'), await db.getAll('profiles')]) expect(JSON.stringify(value)).not.toContain(CREDENTIAL_CANARY);
  });
  it('remembers only by explicit opt-in, restores after browser session loss, and demotes back to session-only', async () => {
    await save('openai', { remember: true }); expect(await db.get('providerCredentials', 'openai')).toBe(CREDENTIAL_CANARY);
    const nextMem = memorySession(), restored = new ProviderStorage(async () => db, nextMem.session);
    const nextService = new ProviderService(restored, contains, (p) => createAdapter(p, transport));
    expect(await nextService.execute({ ...envelope('openai'), type: 'STATUS' })).toMatchObject({ hasKey: true, status: { state: 'unverified' } });
    await nextService.execute({ ...envelope('openai'), type: 'SAVE', config: { ...(await restored.config('openai')), remember: false } });
    expect(await db.count('providerCredentials')).toBe(0); expect(nextMem.data['provider-key:openai']).toBe(CREDENTIAL_CANARY);
    const browserRestart = new ProviderService(new ProviderStorage(async () => db, memorySession().session), contains);
    expect((await browserRestart.execute({ ...envelope('openai'), type: 'STATUS' })).hasKey).toBe(false);
  });
  it.each(['REMOVE_KEY', 'REVOKE_CONSENT'] as const)('%s aborts current fetch, clears both copies and consent, and prevents further calls', async (type) => {
    await save('openai', { remember: true });
    const c = (await status()).config;
    await service.execute({ ...envelope('openai'), type: 'SAVE', config: { ...c, candidateConsent: true } });
    let signal: AbortSignal | undefined;
    transport.mockImplementation(async (_url, init) => { signal = init.signal; return new Promise<Response>(() => {}); });
    const testing = service.execute({ ...envelope('openai'), type: 'TEST', revision: 2 });
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect((await service.execute({ ...envelope('openai'), type, revision: 2 })).hasKey).toBe(false);
    await testing; expect(signal!.aborted).toBe(true); expect(await db.count('providerCredentials')).toBe(0); expect(mem.data).toEqual({});
    expect((await status()).config.candidateConsent).toBe(false);
    await service.execute({ ...envelope('openai'), type: 'TEST', revision: 3 }); expect(transport).toHaveBeenCalledTimes(1); expect(await service.candidateReady('openai')).toBe(false);
  });
  it('revocation from a stale view dominates newer settings and prevents a queued stale save from restoring the key', async () => {
    await save('openai', { remember: true });
    const stale = (await status()).config;
    await service.execute({ ...envelope('openai'), type: 'SAVE', config: { ...stale, candidateConsent: true } });
    const removed = await service.execute({ ...envelope('openai'), type: 'REVOKE_CONSENT', revision: stale.revision });
    expect(removed).toMatchObject({ hasKey: false, config: { candidateConsent: false, revision: 3 } });
    await expect(service.execute({ ...envelope('openai'), type: 'SAVE', config: stale, key: CREDENTIAL_CANARY })).rejects.toMatchObject({ code: 'stale' });
    expect(await db.count('providerCredentials')).toBe(0); expect(mem.data).toEqual({});
    await service.execute({ ...envelope('openai'), type: 'TEST', revision: 3 }); expect(transport).not.toHaveBeenCalled();
  });
  it('revocation while permissions are awaiting prevents dispatch and late verification', async () => {
    await save(); let resolve!: (value: boolean) => void; contains.mockImplementation(() => new Promise<boolean>((r) => { resolve = r; }));
    const pending = service.execute({ ...envelope('openai'), type: 'TEST', revision: 1 });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    await service.execute({ ...envelope('openai'), type: 'REMOVE_KEY', revision: 1 }); resolve(true); await pending;
    expect(transport).not.toHaveBeenCalled(); expect((await status()).status.state).toBe('unverified');
  });
  it('permission removal and explicit cancellation abort requests with no automatic replay', async () => {
    await save(); transport.mockImplementation(() => new Promise<Response>(() => {}));
    const pending = service.execute({ ...envelope('openai'), type: 'TEST', revision: 1 }); await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    service.revokePermissions(); await pending; expect((await status()).status.state).toBe('unverified');
    contains.mockResolvedValue(false); await service.execute({ ...envelope('openai'), type: 'TEST', revision: 1 }); expect((await status()).status.code).toBe('permission'); expect(transport).toHaveBeenCalledOnce();
  });
  it('prevents concurrent paid probes and rejects stale saves and cross-provider configuration', async () => {
    await save(); transport.mockImplementation(() => new Promise<Response>(() => {}));
    const pending = service.execute({ ...envelope('openai'), type: 'TEST', revision: 1 });
    await expect(service.execute({ ...envelope('openai'), type: 'TEST', revision: 1 })).rejects.toMatchObject({ code: 'busy' });
    await service.execute({ ...envelope('openai'), type: 'CANCEL', revision: 1 }); await pending;
    await expect(save()).rejects.toMatchObject({ code: 'stale' });
    await expect(service.execute({ ...envelope('openai'), type: 'SAVE', config: { ...defaultConfig('claude'), revision: 1 } })).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('requires provider-specific saved consent and Gemini paid confirmation, then invalidates on identity change', async () => {
    transport.mockImplementation(async (url) => jsonResponse(providerSuccess(String(url).includes('googleapis') ? 'gemini' : 'openai')));
    await save('gemini'); await service.execute({ ...envelope('gemini'), type: 'TEST', revision: 1 });
    expect(await service.candidateReady('gemini')).toBe(false);
    const handler = providerHandler(service, 'test', options);
    expect(await handler({ ...envelope('gemini'), type: 'SAVE', config: { ...(await status('gemini')).config, candidateConsent: true } }, sender)).toMatchObject({ code: 'invalid_request' });
    await service.execute({ ...envelope('gemini'), type: 'SAVE', config: { ...(await status('gemini')).config, candidateConsent: true, paidServiceConfirmed: true } });
    await service.execute({ ...envelope('gemini'), type: 'TEST', revision: 2 });
    expect(await service.candidateReady('gemini')).toBe(true); expect(await service.candidateReady('openai')).toBe(false);
    await service.execute({ ...envelope('gemini'), type: 'SAVE', config: { ...(await status('gemini')).config, model: 'another-fixture-model' } });
    expect(await service.candidateReady('gemini')).toBe(false); expect((await status('gemini')).config.candidateConsent).toBe(false);
  });
  it('rejects content, other extension surfaces, nested/foreign senders and credential-read requests before storage', async () => {
    const handle = providerHandler(service, 'test', options), execute = vi.spyOn(service, 'execute');
    const request = { ...envelope('openai'), type: 'STATUS' };
    for (const invalid of [{ id: 'test', url: 'https://jobs.example', tab: { url: 'https://jobs.example' } }, { id: 'test', url: 'chrome-extension://test/session.html' }, { ...sender, frameId: 1 }, { ...sender, id: 'foreign' }, { ...sender, url: `${options}?key=bad` }]) expect(await handle(request, invalid)).toMatchObject({ ok: false, code: 'permission' });
    expect(await handle({ ...request, type: 'GET_KEY' }, sender)).toMatchObject({ code: 'invalid_request' }); expect(execute).not.toHaveBeenCalled();
  });
  it('fails closed on session restriction or storage errors with redacted responses', async () => {
    mem.session.setAccessLevel = async () => { throw new Error(CREDENTIAL_CANARY); };
    const handle = providerHandler(service, 'test', options);
    const result = await handle({ ...envelope('openai'), type: 'SAVE', config: { ...defaultConfig('openai'), model: 'fixture-model' }, key: CREDENTIAL_CANARY }, sender);
    expect(result).toMatchObject({ ok: false, code: 'storage' }); expect(JSON.stringify(result)).not.toContain(CREDENTIAL_CANARY); expect(transport).not.toHaveBeenCalled();
  });
  it('attempts both removals on partial deletion failure and disables further requests', async () => {
    await save('openai', { remember: true });
    vi.mocked(mem.session.remove).mockRejectedValue(new Error(CREDENTIAL_CANARY));
    await expect(service.execute({ ...envelope('openai'), type: 'REMOVE_KEY', revision: 1 })).rejects.toBeInstanceOf(ProviderFailure);
    expect(await db.count('providerCredentials')).toBe(0);
    expect((await status()).hasKey).toBe(false);
    await service.execute({ ...envelope('openai'), type: 'TEST', revision: 1 }); expect(transport).not.toHaveBeenCalled();
  });
  it('purges invalid credential/config records and rejects secrets pasted into model/workspace', async () => {
    await save();
    await expect(service.execute({ ...envelope('openai'), type: 'SAVE', config: { ...(await status()).config, model: CREDENTIAL_CANARY } })).rejects.toMatchObject({ code: 'invalid_request' });
    await db.put('providerSettings', { schemaVersion: 99 }, 'openai');
    expect((await status()).hasKey).toBe(false); expect(mem.data).toEqual({});
    const request = { ...envelope('claude'), type: 'SAVE', config: { ...defaultConfig('claude'), workspace: 'bad\r\nheader' }, key: CREDENTIAL_CANARY };
    expect(await providerHandler(service, 'test', options)(request, sender)).toMatchObject({ code: 'invalid_request' });
  });
  it('does not revive a session-only key or a verified capability after a fresh browser session', async () => {
    await save(); await service.execute({ ...envelope('openai'), type: 'TEST', revision: 1 });
    const restarted = new ProviderService(new ProviderStorage(async () => db, memorySession().session), contains);
    expect(await restarted.execute({ ...envelope('openai'), type: 'STATUS' })).toMatchObject({ hasKey: false, status: { state: 'unverified' } });
  });
  it('clearing a saved consent checkbox clears credentials instead of retaining transmission authority', async () => {
    await save(); await service.execute({ ...envelope('openai'), type: 'SAVE', config: { ...(await status()).config, candidateConsent: true } });
    const result = await service.execute({ ...envelope('openai'), type: 'SAVE', config: { ...(await status()).config, candidateConsent: false } });
    expect(result).toMatchObject({ hasKey: false, config: { candidateConsent: false, remember: false } }); expect(mem.data).toEqual({});
  });
});
