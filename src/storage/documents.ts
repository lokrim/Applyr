import { z } from 'zod';
import { purgeHistory } from './history';
import { ProfileSnapshotSchema } from './profiles';
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import type { ApplyrDatabase } from './database';
import type { DocumentRef } from '../domain/document';
import { RECOVERY_TTL_MS, terminal } from '../domain/session';
import { CheckpointSchema } from '../runtime/schemas';
import { DocumentError, MAX_PDF_BYTES, pdfDigest, selectPdf } from '../documents/pdf';

export const LOCAL_STORES = ['checkpoints', 'profiles', 'documents', 'documentBlobs', 'documentLinks', 'history'] as const;
type Transaction = IDBPTransaction<ApplyrDatabase, typeof LOCAL_STORES, 'readwrite'>;
const uuid = z.string().uuid();
const time = z.number().int().nonnegative();
export const DocumentRefSchema: z.ZodType<DocumentRef> = z.strictObject({
  schemaVersion: z.literal(1), id: uuid, kind: z.literal('resume'), digest: z.string().regex(/^[a-f0-9]{64}$/),
  filename: z.string().min(1).regex(/\.pdf$/i), mime: z.enum(['', 'application/pdf']), size: z.number().int().positive().max(MAX_PDF_BYTES),
  lastModified: time, inputVersion: uuid, blobRef: uuid, scope: z.enum(['session', 'saved']), sessionId: uuid.nullable(), expiresAt: time.nullable(),
}).refine((r) => r.scope === 'saved' ? r.sessionId === null && r.expiresAt === null : r.sessionId !== null && r.expiresAt !== null);
const SessionSchema = z.strictObject({
  schemaVersion: z.literal(1), sessionId: uuid, version: uuid, documentId: uuid.nullable(),
  status: z.enum(['started', 'needs_reselection', 'cancelled', 'finished']), expiresAt: time,
  requiresReinspection: z.literal(true),
}).refine((s) => (s.status === 'started') === (s.documentId !== null));
export type DocumentSession = z.infer<typeof SessionSchema>;
export interface DocumentState { saved: DocumentRef | null; session: DocumentSession | null; document: DocumentRef | null }
export type DocumentSelection = { source: 'replacement'; file: File } | { source: 'saved'; id: string; inputVersion: string };

// Shared by checkpoint removal/replacement and document operations: atomic reference cleanup.
export async function purgeDocumentRecords(tx: Transaction, sessionId: string | null, now: number) {
  await purgeHistory(tx, now);
  const rawProfile = await tx.objectStore('profiles').get('snapshot');
  const profile = ProfileSnapshotSchema.safeParse(rawProfile);
  if (rawProfile !== undefined && (!profile.success || profile.data.sessionId !== sessionId || profile.data.expiresAt <= now)) await tx.objectStore('profiles').delete('snapshot');
  const documents = tx.objectStore('documents');
  const blobs = tx.objectStore('documentBlobs');
  const links = tx.objectStore('documentLinks');
  const valid = new Map<string, DocumentRef>();
  for (const key of await documents.getAllKeys()) {
    const parsed = DocumentRefSchema.safeParse(await documents.get(key));
    const ref = parsed.success ? parsed.data : null;
    const blob = ref ? await blobs.get(ref.blobRef) : null;
    if (ref && ref.id === key && blob instanceof Blob && blob.size === ref.size && (ref.scope === 'saved' || (ref.sessionId === sessionId && ref.expiresAt! > now && ref.expiresAt! <= now + RECOVERY_TTL_MS))) valid.set(key, ref);
    else await documents.delete(key);
  }
  const defaultId = await links.get('default');
  if (typeof defaultId !== 'string' || valid.get(defaultId)?.scope !== 'saved') await links.delete('default');
  const parsedSession = SessionSchema.safeParse(await links.get('session'));
  let session = parsedSession.success && parsedSession.data.sessionId === sessionId && parsedSession.data.expiresAt > now && parsedSession.data.expiresAt <= now + RECOVERY_TTL_MS ? parsedSession.data : null;
  if (!session) await links.delete('session');
  else if (session.documentId && (valid.get(session.documentId)?.scope !== 'session' || valid.get(session.documentId)?.sessionId !== sessionId)) {
    session = { ...session, version: crypto.randomUUID(), documentId: null, status: 'needs_reselection' };
    await links.put(session, 'session');
  }
  const retainedBlobs = new Set<string>();
  for (const [key, ref] of valid) {
    if ((ref.scope === 'saved' && key !== defaultId) || (ref.scope === 'session' && key !== session?.documentId)) await documents.delete(key);
    else retainedBlobs.add(ref.blobRef);
  }
  for (const key of await blobs.getAllKeys()) if (!retainedBlobs.has(key)) await blobs.delete(key);
}

// Renew only still-eligible inputs, in the same transaction as explicit activity.
// Purge first so a legacy desynchronized expiry can never be revived.
export async function renewSessionInputs(tx: Transaction, sessionId: string, at: number, expiresAt: number) {
  await purgeDocumentRecords(tx, sessionId, at);
  const profile = ProfileSnapshotSchema.safeParse(await tx.objectStore('profiles').get('snapshot'));
  if (profile.success && profile.data.sessionId === sessionId) await tx.objectStore('profiles').put({ ...profile.data, expiresAt, lastActivityAt: at }, 'snapshot');
  for (const key of await tx.objectStore('documents').getAllKeys()) {
    const document = DocumentRefSchema.safeParse(await tx.objectStore('documents').get(key));
    if (document.success && document.data.scope === 'session' && document.data.sessionId === sessionId) await tx.objectStore('documents').put({ ...document.data, expiresAt }, key);
  }
  const link = SessionSchema.safeParse(await tx.objectStore('documentLinks').get('session'));
  if (link.success && link.data.sessionId === sessionId) await tx.objectStore('documentLinks').put({ ...link.data, expiresAt }, 'session');
}

function storageError(error: unknown): never {
  if (error instanceof DocumentError) throw error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new DocumentError('QUOTA');
  throw new DocumentError('STORAGE');
}

export class DocumentStore {
  constructor(private readonly database: IDBPDatabase<ApplyrDatabase>, private readonly now = Date.now, private readonly uuid = () => crypto.randomUUID()) {}

  private async clean(tx: Transaction) {
    const checkpoint = CheckpointSchema.safeParse(await tx.objectStore('checkpoints').get('current'));
    const active = checkpoint.success && checkpoint.data.expiresAt > this.now() ? checkpoint.data : null;
    await purgeDocumentRecords(tx, active?.id ?? null, this.now());
    return active;
  }

  private async transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T> {
    let tx: Transaction | undefined;
    try {
      tx = this.database.transaction(LOCAL_STORES, 'readwrite');
      // Handle rejection immediately, including synthetic quota aborts in tests.
      void tx.done.catch(() => {});
      const result = await action(tx);
      await tx.done;
      return result;
    } catch (error) {
      try { tx?.abort(); } catch { /* May already be complete/aborted. */ }
      await tx?.done.catch(() => {});
      return storageError(error);
    }
  }

  async read(): Promise<DocumentState> {
    return this.transaction(async (tx) => {
      await this.clean(tx);
      const links = tx.objectStore('documentLinks');
      const defaultId = await links.get('default');
      const saved = typeof defaultId === 'string' ? DocumentRefSchema.safeParse(await tx.objectStore('documents').get(defaultId)) : null;
      const session = SessionSchema.safeParse(await links.get('session'));
      const document = session.success && session.data.documentId ? DocumentRefSchema.safeParse(await tx.objectStore('documents').get(session.data.documentId)) : null;
      return { saved: saved?.success ? saved.data : null, session: session.success ? session.data : null, document: document?.success ? document.data : null };
    });
  }

  async readBytes(id: string, inputVersion: string): Promise<File> {
    const entry = await this.transaction(async (tx) => {
      await this.clean(tx);
      const ref = DocumentRefSchema.safeParse(await tx.objectStore('documents').get(id));
      if (!ref.success || ref.data.inputVersion !== inputVersion) return null;
      const blob = await tx.objectStore('documentBlobs').get(ref.data.blobRef);
      if (!(blob instanceof Blob)) return null;
      return { ref: ref.data, blob };
    });
    if (!entry) throw new DocumentError('UNAVAILABLE');
    try {
      if (await pdfDigest(await entry.blob.arrayBuffer()) !== entry.ref.digest) throw new DocumentError('UNAVAILABLE');
      return new File([entry.blob], entry.ref.filename, { type: entry.ref.mime, lastModified: entry.ref.lastModified });
    } catch {
      await this.deleteDocument(id, inputVersion);
      throw new DocumentError('UNAVAILABLE');
    }
  }

  private ref(file: File, digest: string, scope: 'session' | 'saved', sessionId: string | null, blobRef: string = this.uuid()): DocumentRef {
    return { schemaVersion: 1, id: this.uuid(), kind: 'resume', digest, filename: file.name, mime: file.type, size: file.size, lastModified: file.lastModified,
      inputVersion: this.uuid(), blobRef, scope, sessionId, expiresAt: scope === 'session' ? this.now() + RECOVERY_TTL_MS : null };
  }

  private async putDefault(tx: Transaction, ref: DocumentRef, expectedId: string | null) {
    const old = await tx.objectStore('documentLinks').get('default');
    if ((old ?? null) !== expectedId) throw new DocumentError('STALE');
    // Replacement releases the default reference only; a running session retains its version.
    if (typeof old === 'string') await tx.objectStore('documents').delete(old);
    await tx.objectStore('documents').put(ref, ref.id);
    await tx.objectStore('documentLinks').put(ref.id, 'default');
  }

  async saveDefault(file: File, expectedId: string | null) {
    const selected = await selectPdf([file]);
    const ref = this.ref(file, selected.digest, 'saved', null);
    return this.transaction(async (tx) => {
      await this.clean(tx);
      await this.putDefault(tx, ref, expectedId);
      await tx.objectStore('documentBlobs').put(file.slice(), ref.blobRef);
      await this.clean(tx);
      return ref;
    });
  }

  async start(sessionId: string, selection: DocumentSelection, expectedSessionVersion: string | null, saveReusable?: { expectedId: string | null }) {
    const file = selection.source === 'replacement' ? selection.file : await this.readBytes(selection.id, selection.inputVersion);
    const selected = await selectPdf([file]);
    return this.transaction(async (tx) => {
      const checkpoint = await this.clean(tx);
      const links = tx.objectStore('documentLinks');
      const old = SessionSchema.safeParse(await links.get('session'));
      if (!checkpoint || terminal(checkpoint) || checkpoint.id !== sessionId || (old.success ? old.data.version : null) !== expectedSessionVersion || (old.success && ['finished', 'cancelled'].includes(old.data.status))) throw new DocumentError('STALE');
      let blobRef: string | undefined;
      if (selection.source === 'saved') {
        const saved = DocumentRefSchema.safeParse(await tx.objectStore('documents').get(selection.id));
        if (!saved.success || saved.data.scope !== 'saved' || saved.data.inputVersion !== selection.inputVersion || await links.get('default') !== selection.id) throw new DocumentError('STALE');
        blobRef = saved.data.blobRef;
      }
      const ref = this.ref(file, selected.digest, 'session', sessionId, blobRef);
      if (!blobRef) await tx.objectStore('documentBlobs').put(file.slice(), ref.blobRef);
      if (saveReusable) await this.putDefault(tx, this.ref(file, selected.digest, 'saved', null, ref.blobRef), saveReusable.expectedId);
      await tx.objectStore('documents').put(ref, ref.id);
      const session: DocumentSession = { schemaVersion: 1, sessionId, version: this.uuid(), documentId: ref.id, status: 'started', expiresAt: ref.expiresAt!, requiresReinspection: true };
      await links.put(session, 'session');
      await tx.objectStore('checkpoints').put({ ...checkpoint, revision: checkpoint.revision + 1, updatedAt: ref.expiresAt! - RECOVERY_TTL_MS, lastActivityAt: ref.expiresAt! - RECOVERY_TTL_MS, expiresAt: ref.expiresAt }, 'current');
      await renewSessionInputs(tx, sessionId, ref.expiresAt! - RECOVERY_TTL_MS, ref.expiresAt!);
      await this.clean(tx);
      return { session, document: ref };
    });
  }

  async end(sessionId: string, expectedVersion: string, status: 'cancelled' | 'finished') {
    return this.transaction(async (tx) => {
      await this.clean(tx);
      const current = SessionSchema.safeParse(await tx.objectStore('documentLinks').get('session'));
      if (!current.success || current.data.sessionId !== sessionId || current.data.version !== expectedVersion || ['finished', 'cancelled'].includes(current.data.status)) throw new DocumentError('STALE');
      await tx.objectStore('documentLinks').put({ ...current.data, version: this.uuid(), status, documentId: null }, 'session');
      await tx.objectStore('profiles').delete('snapshot');
      await this.clean(tx);
    });
  }

  async deleteDocument(id: string, inputVersion: string) {
    return this.transaction(async (tx) => {
      const ref = DocumentRefSchema.safeParse(await tx.objectStore('documents').get(id));
      if (!ref.success || ref.data.inputVersion !== inputVersion) throw new DocumentError('STALE');
      const affectedSessions = new Set<string>();
      // Deliberate deletion invalidates all references to these same stored bytes, including shared saved/session refs.
      for (const key of await tx.objectStore('documents').getAllKeys()) {
        const other = DocumentRefSchema.safeParse(await tx.objectStore('documents').get(key));
        if (other.success && other.data.blobRef === ref.data.blobRef) { if (other.data.sessionId) affectedSessions.add(other.data.sessionId); await tx.objectStore('documents').delete(key); }
      }
      await tx.objectStore('documentBlobs').delete(ref.data.blobRef);
      for (const key of await tx.objectStore('checkpoints').getAllKeys()) {
        const p = CheckpointSchema.safeParse(await tx.objectStore('checkpoints').get(key));
        if (!p.success) continue;
        const cp = p.data;
        if (!affectedSessions.has(cp.id) && !cp.autofill?.operations.some((o) => o.kind === 'upload' && o.recovery?.kind === 'file' && o.recovery.digest === ref.data.digest)) continue;
        const next = terminal(cp) ? { ...cp, revision: cp.revision + 1 } : { ...cp, revision: cp.revision + 1, lifecycle: 'NEEDS_ATTENTION' as const, lease: undefined, reviewScope: undefined, recovery: { reason: 'document_deleted', inspectionRequired: true, reattachRequired: false } };
        next.approval = undefined; next.review = undefined;
        if (next.autofill) next.autofill = { ...next.autofill, status: next.autofill.status === 'running' ? 'interrupted' : next.autofill.status, operations: next.autofill.operations.map((o) => o.kind === 'upload' ? { ...o, recovery: undefined } : o) };
        await tx.objectStore('checkpoints').put(next, key);
      }
      await this.clean(tx);
    });
  }
}
