import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { ProfileStateError, ProfileStore } from '../../src/storage/profiles';
import { CheckpointStore } from '../../src/storage/checkpoints';
import { createCheckpoint, RECOVERY_TTL_MS } from '../../src/domain/session';
import type { ProfileDocument } from '../../src/profile/schema';

const id = 'da295600-6e98-4ab1-a651-9405353b222a';
const target = { tabId: 17, windowId: 1, origin: 'https://example.org', availability: 'https' as const };
const empty = { sessionId: null, revision: null };
const document = (name?: string): ProfileDocument => ({ data: { profile_version: 1, ...(name === undefined ? {} : { identity: { legal_name: name } }) }, notes: '', answerBodies: {} });

describe('saved default / frozen session isolation in versioned IndexedDB', () => {
  let database: IDBPDatabase<ApplyrDatabase>;
  let name: string;
  let now: number;
  let profiles: ProfileStore;
  beforeEach(async () => { now = 1000; name = `profiles-${crypto.randomUUID()}`; database = await openDatabase(name); profiles = new ProfileStore(database, () => now); await new CheckpointStore(database, () => now).replace(createCheckpoint(target, id, now), empty); });
  afterEach(async () => { database.close(); await deleteDB(name); });

  it('explicitly migrates an existing v1 database while preserving its checkpoint', async () => {
    database.close(); await deleteDB(name);
    const previous = await openDB(name, 1, { upgrade(db) { db.createObjectStore('checkpoints'); } });
    const checkpoint = createCheckpoint(target, id, now);
    await previous.put('checkpoints', checkpoint, 'current'); previous.close();
    database = await openDatabase(name);
    expect(database.version).toBe(3); expect(await new CheckpointStore(database, () => now).read()).toEqual(checkpoint);
    expect(await new ProfileStore(database, () => now).read()).toEqual({ saved: null, snapshot: null });
  });

  it('keeps editing inputs, default writes and frozen inputs independent; refresh requires a deliberate new version', async () => {
    const original = document('Fictional Original');
    const saved = await profiles.saveDefault(original, null);
    expect((await profiles.read()).snapshot).toBeNull();
    const frozen = await profiles.freeze(id, { source: 'saved', savedVersion: saved.version }, null);
    original.data.identity!.legal_name = 'Unsaved edit';
    expect((await profiles.read()).saved?.document.data.identity?.legal_name).toBe('Fictional Original');
    const next = await profiles.saveDefault(document('Fictional Updated'), saved.version);
    let state = await profiles.read();
    expect(state.saved?.version).toBe(next.version); expect(state.snapshot).toEqual(frozen);
    now += 100;
    const refreshed = await profiles.freeze(id, { source: 'saved', savedVersion: next.version }, frozen.version);
    state = await profiles.read();
    expect(refreshed.version).not.toBe(frozen.version); expect(refreshed.document).toEqual(next.document);
    expect(refreshed.requiresReinspection).toBe(true); expect(state.snapshot?.savedVersion).toBe(next.version);
    expect(refreshed.expiresAt).toBe(now + RECOVERY_TTL_MS);
    await expect(profiles.freeze(id, { source: 'saved', savedVersion: next.version }, frozen.version)).rejects.toBeInstanceOf(ProfileStateError);
  });

  it('a whole session replacement never inherits missing default facts or saves itself', async () => {
    const defaultDocument = document('Fictional Default'); defaultDocument.data.contact = { email: 'default@example.com' };
    const saved = await profiles.saveDefault(defaultDocument, null);
    const replacement = document(); replacement.data.preferences = { relocation: false };
    const selected = await profiles.freeze(id, { source: 'replacement', document: replacement }, null);
    expect(selected.document).toEqual(replacement); expect(selected.document.data).not.toHaveProperty('contact'); expect(selected.document.data).not.toHaveProperty('identity'); expect(selected.savedVersion).toBeNull();
    expect((await profiles.read()).saved).toEqual(saved);
    // Proposing is a UI-only diff. An explicit save changes the default but not selection.
    await profiles.saveDefault(replacement, saved.version);
    expect((await profiles.read()).snapshot).toEqual(selected);
    database.close(); database = await openDatabase(name);
    expect((await new ProfileStore(database, () => now).read()).snapshot).toEqual(selected);
  });

  it('rejects stale and concurrent default/snapshot writes and old saved-version selections', async () => {
    const attempts = await Promise.allSettled([profiles.saveDefault(document('A'), null), profiles.saveDefault(document('B'), null)]);
    expect(attempts.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    const saved = (await profiles.read()).saved!;
    const next = await profiles.saveDefault(document('C'), saved.version);
    await expect(profiles.freeze(id, { source: 'saved', savedVersion: saved.version }, null)).rejects.toBeInstanceOf(ProfileStateError);
    const selections = await Promise.allSettled([profiles.freeze(id, { source: 'saved', savedVersion: next.version }, null), profiles.freeze(id, { source: 'replacement', document: document() }, null)]);
    expect(selections.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    await expect(profiles.deleteDefault(saved.version)).rejects.toBeInstanceOf(ProfileStateError);
  });

  it('views do not renew recovery; expiry purges snapshot bytes and preserves explicitly saved defaults', async () => {
    const saved = await profiles.saveDefault(document('Default'), null);
    const frozen = await profiles.freeze(id, { source: 'saved', savedVersion: saved.version }, null);
    now = frozen.expiresAt - 1; expect((await profiles.read()).snapshot?.expiresAt).toBe(frozen.expiresAt);
    now = frozen.expiresAt; expect(await profiles.read()).toEqual({ saved, snapshot: null });
    expect(await database.get('profiles', 'snapshot')).toBeUndefined();
    await expect(profiles.freeze(id, { source: 'saved', savedVersion: saved.version }, null)).rejects.toBeInstanceOf(ProfileStateError);
  });

  it('checkpoint removal/replacement and profile deletion purge sensitive recovery copies', async () => {
    let saved = await profiles.saveDefault(document('Default'), null);
    await profiles.freeze(id, { source: 'saved', savedVersion: saved.version }, null);
    const checkpoints = new CheckpointStore(database, () => now);
    await checkpoints.replace(null, { sessionId: id, revision: 1 });
    expect(await database.get('profiles', 'snapshot')).toBeUndefined();
    await checkpoints.replace(createCheckpoint(target, id, now), empty);
    await profiles.freeze(id, { source: 'replacement', document: document() }, null);
    await profiles.deleteDefault(saved.version);
    expect(await profiles.read()).toEqual({ saved: null, snapshot: null });
    saved = await profiles.saveDefault(document('Again'), null);
    await profiles.freeze(id, { source: 'saved', savedVersion: saved.version }, null);
    await checkpoints.replace(createCheckpoint(target, crypto.randomUUID(), now), { sessionId: id, revision: 2 });
    expect(await database.get('profiles', 'snapshot')).toBeUndefined();
  });

  it('rejects malformed writes and purges invalid/corrupt disk records', async () => {
    const invalid = document(); invalid.data.contact = { phone: 12 } as never;
    await expect(profiles.saveDefault(invalid, null)).rejects.toThrow(/Repair/);
    await expect(profiles.freeze(id, { source: 'replacement', document: invalid }, null)).rejects.toThrow(/Repair/);
    await database.put('profiles', { schemaVersion: 99 }, 'default');
    await database.put('profiles', { schemaVersion: 99 }, 'snapshot');
    expect(await profiles.read()).toEqual({ saved: null, snapshot: null });
    expect(await database.getAll('profiles')).toEqual([]);
  });
});
