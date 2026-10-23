import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDB, type IDBPDatabase } from 'idb';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { CheckpointStore, StaleCheckpointError } from '../../src/storage/checkpoints';
import { createCheckpoint } from '../../src/domain/session';
import { createCoordinator } from '../../src/runtime/coordinator';

const id = 'da295600-6e98-4ab1-a651-9405353b222a';
const target = { tabId: 17, windowId: 1, origin: 'https://example.org', availability: 'https' as const };
const record = createCheckpoint(target, id, 1_000);
const pages = { popup: 'chrome-extension://test/popup.html', session: 'chrome-extension://test/session.html', options: 'chrome-extension://test/options.html' };
const empty = { sessionId: null, revision: null };
const binding = { sessionId: id, revision: 0 };
const envelope = { schemaVersion: 1, requestId: id };

describe('versioned IndexedDB checkpoints and coordinator', () => {
  let database: IDBPDatabase<ApplyrDatabase>;
  let name: string;
  let store: CheckpointStore;
  beforeEach(async () => {
    name = `test-${crypto.randomUUID()}`;
    database = await openDatabase(name);
    store = new CheckpointStore(database, () => 2_000);
  });
  afterEach(async () => { database.close(); await deleteDB(name); });

  it('migrates a new database to v4 and recovers after closing the connection', async () => {
    expect(database.version).toBe(4);
    expect(Array.from(database.objectStoreNames)).toEqual(['checkpoints', 'documentBlobs', 'documentLinks', 'documents', 'profiles', 'providerCredentials', 'providerSettings']);
    expect(await store.read()).toBeNull();
    await store.replace(record, empty);
    database.close();
    database = await openDatabase(name);
    expect(await new CheckpointStore(database, () => 2_000).read()).toEqual(record);
  });

  it('physically removes expired and invalid records without extending retention on reads', async () => {
    await store.replace(record, empty);
    expect((await store.read())?.expiresAt).toBe(record.expiresAt);
    expect(await new CheckpointStore(database, () => record.expiresAt).read()).toBeNull();
    expect(await database.get('checkpoints', 'current')).toBeUndefined();
    for (const raw of [{ ...record, schemaVersion: 99 }, { ...record, credential: 'canary' }]) {
      await database.put('checkpoints', raw, 'current');
      expect(await store.read()).toBeNull();
      expect(await database.get('checkpoints', 'current')).toBeUndefined();
    }
  });

  it('serializes concurrent mutations and rejects stale id/revision and stale deletion', async () => {
    const attempts = await Promise.allSettled([store.replace(record, empty), store.replace(record, empty)]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(store.replace(null, { ...binding, revision: 1 })).rejects.toBeInstanceOf(StaleCheckpointError);
    expect(await store.read()).toEqual(record);
    await store.replace(null, binding);
    expect(await store.read()).toBeNull();
  });

  it('validates sender, schema and popup-only capture before privileged work', async () => {
    let targetReads = 0;
    let storageReads = 0;
    const handle = createCoordinator({
      extensionId: 'test', pages,
      store: async () => { storageReads++; return store; },
      target: async () => { targetReads++; return target; },
      now: () => 2_000, uuid: () => id,
    });
    const capture = { ...envelope, ...empty, type: 'CAPTURE_TARGET', tabId: 17 };
    expect(await handle(capture, { id: 'test', url: 'https://evil.invalid' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await handle(capture, { id: 'test', url: pages.session })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await handle({ ...capture, script: 'canary' }, { id: 'test', url: pages.popup })).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(targetReads).toBe(0);
    expect(storageReads).toBe(0);
    expect(await handle(capture, { id: 'test', url: pages.popup })).toMatchObject({ ok: true, checkpoint: { target } });
    expect(await handle(capture, { id: 'test', url: pages.popup })).toMatchObject({ ok: false, code: 'STALE_CHECKPOINT' });
    expect(await handle({ ...envelope, ...empty, type: 'GET_STATE' }, { id: 'test', url: pages.options })).toMatchObject({ ok: true, checkpoint: { target } });
  });

  it('returns bounded errors without raw exception details or secrets', async () => {
    const handle = createCoordinator({
      extensionId: 'test', pages, store: async () => { throw new Error('secret-canary'); },
      target: async () => target, now: () => 2_000, uuid: () => id,
    });
    const response = await handle({ ...envelope, ...empty, type: 'GET_STATE' }, { id: 'test', url: pages.session });
    expect(response).toEqual({ schemaVersion: 1, requestId: id, ok: false, code: 'STORAGE_UNAVAILABLE' });
  });
});
