import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { openDatabase, type ApplyrDatabase } from '../../src/storage/database';
import { DocumentRefSchema, DocumentStore } from '../../src/storage/documents';
import { MAX_PDF_BYTES, pdfDigest, selectPdf } from '../../src/documents/pdf';
import { createCheckpoint, RECOVERY_TTL_MS } from '../../src/domain/session';
import { CheckpointStore } from '../../src/storage/checkpoints';
import { syntheticPdf } from '../fixtures/pdf';

const id = 'da295600-6e98-4ab1-a651-9405353b222a';
const target = { tabId: 17, windowId: 1, origin: 'https://example.org', availability: 'https' as const };
const pdf = (label = 'original', type = 'application/pdf') => new File([syntheticPdf(label)], `${label}.PDF`, { type, lastModified: 12345 });

describe('bounded PDF selection', () => {
  it('checks exact selection count, extension, nonempty MIME and header; allows empty MIME', async () => {
    for (const files of [[], [pdf(), pdf()], [new File([], 'empty.pdf')], [new File(['text'], 'wrong.pdf', { type: 'application/pdf' })], [new File([syntheticPdf()], 'wrong.txt', { type: 'application/pdf' })], [pdf('bad-mime', 'text/plain')], [new File([new Uint8Array(MAX_PDF_BYTES + 1)], 'large.pdf')]]) {
      await expect(selectPdf(files)).rejects.toMatchObject({ code: 'INVALID_PDF' });
    }
    const file = pdf('empty-mime', '');
    expect((await selectPdf([file])).file).toBe(file);
    const maximum = new File(['%PDF-', new Uint8Array(MAX_PDF_BYTES - 5)], 'maximum.pdf');
    expect((await selectPdf([maximum])).file.size).toBe(MAX_PDF_BYTES);
  });
  it('preserves the exact file and original digest, including binary bytes, without rewriting', async () => {
    const file = new File([syntheticPdf(), new Uint8Array([0, 255, 128, 13, 10])], 'Fictional résumé.PDF', { type: 'application/pdf', lastModified: 123 });
    const selected = await selectPdf([file]);
    expect(selected.file).toBe(file);
    expect(selected.digest).toBe(await pdfDigest(await file.arrayBuffer()));
    expect(new Uint8Array(await selected.file.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()));
  });
  it('reports unreadable source bytes as reselection without exposing errors', async () => {
    const file = pdf(); vi.spyOn(file, 'slice').mockImplementation(() => { throw new Error('private path'); });
    await expect(selectPdf([file])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('scoped local documents in IndexedDB', () => {
  let database: IDBPDatabase<ApplyrDatabase>, name: string, now: number, documents: DocumentStore;
  beforeEach(async () => {
    now = 1000; name = `documents-${crypto.randomUUID()}`; database = await openDatabase(name);
    documents = new DocumentStore(database, () => now);
    await new CheckpointStore(database, () => now).replace(createCheckpoint(target, id, now), { sessionId: null, revision: null });
  });
  afterEach(async () => { vi.restoreAllMocks(); database.close(); await deleteDB(name); });
  const replacement = (file = pdf()) => ({ source: 'replacement' as const, file });

  it('migrates v2 preserving profiles and checkpoint; adds separate scoped stores', async () => {
    database.close(); await deleteDB(name);
    const old = await openDB(name, 2, { upgrade(db) { db.createObjectStore('checkpoints'); db.createObjectStore('profiles'); } });
    const checkpoint = createCheckpoint(target, id, now);
    await old.put('checkpoints', checkpoint, 'current'); await old.put('profiles', { sentinel: true }, 'fixture'); old.close();
    database = await openDatabase(name);
    expect(database.version).toBe(5); expect(await database.get('profiles', 'fixture')).toEqual({ sentinel: true });
    expect(await new CheckpointStore(database, () => now).read()).toEqual(checkpoint);
    expect(await database.count('documentBlobs')).toBe(0);
  });

  it('selection alone stores nothing; Start binds original bytes/name/type/version, including empty MIME', async () => {
    const file = pdf('original', ''); const selected = await selectPdf([file]);
    expect(await documents.read()).toEqual({ saved: null, session: null, document: null });
    expect(await database.count('documentBlobs')).toBe(0);
    const started = await documents.start(id, replacement(file), null);
    const read = await documents.readBytes(started.document.id, started.document.inputVersion);
    expect(read.name).toBe(file.name); expect(read.type).toBe(''); expect(read.lastModified).toBe(file.lastModified);
    expect(await read.arrayBuffer()).toEqual(await file.arrayBuffer()); expect(started.document.digest).toBe(selected.digest);
    expect(started.document).toMatchObject({ scope: 'session', sessionId: id, expiresAt: now + RECOVERY_TTL_MS, kind: 'resume' });
    expect((await documents.read()).saved).toBeNull();
    expect(DocumentRefSchema.safeParse({ ...started.document, kind: 'cover_letter' }).success).toBe(false);
    database.close(); database = await openDatabase(name);
    expect((await new DocumentStore(database, () => now).read()).document).toEqual(started.document);
  });

  it('default replacement keeps the running version and collects the old bytes only after finish', async () => {
    const saved = await documents.saveDefault(pdf('saved'), null);
    const start = await documents.start(id, { source: 'saved', id: saved.id, inputVersion: saved.inputVersion }, null);
    expect(start.document.blobRef).toBe(saved.blobRef); expect(start.document.inputVersion).not.toBe(saved.inputVersion);
    expect(await database.count('documentBlobs')).toBe(1);
    const next = await documents.saveDefault(pdf('updated'), saved.id);
    expect((await documents.read()).document).toEqual(start.document); expect(await database.count('documentBlobs')).toBe(2);
    await documents.end(id, start.session.version, 'finished');
    expect((await documents.read()).saved).toEqual(next); expect((await documents.read()).document).toBeNull();
    expect(await database.count('documentBlobs')).toBe(1);
    await expect(documents.start(id, replacement(), (await documents.read()).session!.version)).rejects.toMatchObject({ code: 'STALE' });
  });

  it('explicit session replacement leaves the default unchanged and releases prior unsaved bytes', async () => {
    const saved = await documents.saveDefault(pdf('default'), null);
    const first = await documents.start(id, replacement(pdf('session-a')), null);
    now += 50;
    const next = await documents.start(id, replacement(pdf('session-b')), first.session.version);
    expect(next.document.inputVersion).not.toBe(first.document.inputVersion);
    expect(next.document.expiresAt).toBe(now + RECOVERY_TTL_MS);
    expect((await documents.read()).saved).toEqual(saved); expect(await database.count('documentBlobs')).toBe(2);
    await expect(documents.readBytes(first.document.id, first.document.inputVersion)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it.each(['cancelled', 'finished'] as const)('%s releases temporary refs but retains shared explicitly saved bytes', async (status) => {
    const start = await documents.start(id, replacement(), null, { expectedId: null });
    const saved = (await documents.read()).saved!;
    expect(saved.blobRef).toBe(start.document.blobRef); expect(await database.count('documentBlobs')).toBe(1);
    await documents.end(id, start.session.version, status);
    expect((await documents.read()).session?.status).toBe(status);
    expect((await documents.read()).saved).toEqual(saved); expect(await database.count('documents')).toBe(1);
    expect(await documents.readBytes(saved.id, saved.inputVersion)).toBeInstanceOf(File);
  });

  it('cancellation of an unsaved-only session removes every blob', async () => {
    const start = await documents.start(id, replacement(), null);
    await documents.end(id, start.session.version, 'cancelled');
    expect(await database.count('documentBlobs')).toBe(0); expect(await database.count('documents')).toBe(0);
  });

  it('expiry is not renewed by reads and retains only deliberately saved defaults', async () => {
    const saved = await documents.saveDefault(pdf('default'), null);
    const start = await documents.start(id, replacement(), null);
    now = start.session.expiresAt - 1;
    expect((await documents.read()).session?.expiresAt).toBe(start.session.expiresAt);
    now++;
    expect(await documents.read()).toEqual({ saved, document: null, session: null });
    expect(await database.count('documentBlobs')).toBe(1); expect(await database.get('documentBlobs', start.document.blobRef)).toBeUndefined();
  });

  it.each(['remove', 'replace'] as const)('checkpoint %s atomically purges session refs and preserves defaults', async (action) => {
    const saved = await documents.saveDefault(pdf('default'), null);
    await documents.start(id, replacement(), null);
    const checkpoints = new CheckpointStore(database, () => now);
    const current = (await checkpoints.read())!;
    await checkpoints.replace(action === 'remove' ? null : createCheckpoint(target, crypto.randomUUID(), now), { sessionId: id, revision: current.revision });
    expect(await documents.read()).toEqual({ saved, session: null, document: null }); expect(await database.count('documentBlobs')).toBe(1);
  });

  it('explicit deletion of shared saved bytes invalidates the running session; never substitutes a default', async () => {
    const saved = await documents.saveDefault(pdf(), null);
    const start = await documents.start(id, { source: 'saved', id: saved.id, inputVersion: saved.inputVersion }, null);
    await documents.deleteDocument(saved.id, saved.inputVersion);
    expect(await database.count('documentBlobs')).toBe(0);
    expect(await documents.read()).toMatchObject({ saved: null, document: null, session: { status: 'needs_reselection', documentId: null } });
    const nextSaved = await documents.saveDefault(pdf('other'), null);
    expect((await documents.read()).document).toBeNull();
    await expect(documents.start(id, replacement(), start.session.version)).rejects.toMatchObject({ code: 'STALE' });
    const next = await documents.start(id, { source: 'saved', id: nextSaved.id, inputVersion: nextSaved.inputVersion }, (await documents.read()).session!.version);
    expect(next.document.digest).toBe(nextSaved.digest);
  });

  it('session-only deletion leaves an independent default intact', async () => {
    const saved = await documents.saveDefault(pdf('default'), null);
    const start = await documents.start(id, replacement(), null);
    await documents.deleteDocument(start.document.id, start.document.inputVersion);
    expect((await documents.read()).saved).toEqual(saved);
    expect((await documents.read()).session?.status).toBe('needs_reselection');
  });

  it.each(['missing', 'corrupt'] as const)('%s bytes invalidate references and require reselection', async (mode) => {
    const start = await documents.start(id, replacement(), null);
    if (mode === 'missing') await database.delete('documentBlobs', start.document.blobRef);
    else await database.put('documentBlobs', new Blob([new Uint8Array(start.document.size)]), start.document.blobRef);
    await expect(documents.readBytes(start.document.id, start.document.inputVersion)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect((await documents.read()).session?.status).toBe('needs_reselection');
    expect(await database.count('documentBlobs')).toBe(0);
  });

  it('stale, concurrent and wrong-session operations fail without modifying the chosen version', async () => {
    const attempts = await Promise.allSettled([documents.start(id, replacement(pdf('a')), null), documents.start(id, replacement(pdf('b')), null)]);
    expect(attempts.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    const current = await documents.read();
    await expect(documents.start(crypto.randomUUID(), replacement(), current.session!.version)).rejects.toMatchObject({ code: 'STALE' });
    await expect(documents.end(id, crypto.randomUUID(), 'cancelled')).rejects.toMatchObject({ code: 'STALE' });
    expect(await documents.read()).toEqual(current);
    const saved = await documents.saveDefault(pdf(), null);
    await documents.saveDefault(pdf('new'), saved.id);
    await expect(documents.start(id, { source: 'saved', id: saved.id, inputVersion: saved.inputVersion }, current.session!.version)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('quota failure rolls back combined reusable save and session start; retry uses the same source bytes', async () => {
    const saved = await documents.saveDefault(pdf('default'), null);
    const originalPut = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'documentLinks' && args[1] === 'session') throw new DOMException('private details', 'QuotaExceededError');
      return originalPut.apply(this, args);
    });
    const file = pdf('retry');
    await expect(documents.start(id, replacement(file), null, { expectedId: saved.id })).rejects.toMatchObject({ code: 'QUOTA' });
    fault.mockRestore();
    expect(await documents.read()).toEqual({ saved, document: null, session: null }); expect(await database.count('documentBlobs')).toBe(1);
    const start = await documents.start(id, replacement(file), null);
    expect(start.document.digest).toBe(await pdfDigest(await file.arrayBuffer()));
  });

  it('purges malformed metadata and orphan bytes; closed storage returns a bounded error', async () => {
    await database.put('documents', { schemaVersion: 9 }, 'bad');
    await database.put('documentBlobs', new Blob(['private']), 'orphan');
    await documents.read(); expect(await database.count('documents')).toBe(0); expect(await database.count('documentBlobs')).toBe(0);
    database.close(); await expect(documents.read()).rejects.toMatchObject({ code: 'STORAGE' });
  });
});
