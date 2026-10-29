import { z } from 'zod';
import type { IDBPDatabase } from 'idb';
import type { ApplyrDatabase } from './database';
import { CheckpointSchema } from '../runtime/schemas';
import { RECOVERY_TTL_MS, terminal, transition } from '../domain/session';
import { validateProfileDocument } from '../profile/markdown';
import type { ProfileDocument } from '../profile/schema';
import { LOCAL_STORES, purgeDocumentRecords, renewSessionInputs } from './documents';

const documentSchema = z.custom<ProfileDocument>((value) => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'answerBodies,data,notes') return false;
  try { return Boolean(validateProfileDocument(value as ProfileDocument).document); } catch { return false; }
});
const version = z.string().uuid();
const time = z.number().int().nonnegative();
const SavedSchema = z.strictObject({ schemaVersion: z.literal(1), version, document: documentSchema, savedAt: time });
export const ProfileSnapshotSchema = z.strictObject({ schemaVersion: z.literal(1), version, sessionId: version, document: documentSchema,
  source: z.enum(['saved', 'replacement']), savedVersion: version.nullable(), frozenAt: time, lastActivityAt: time.optional(), expiresAt: time, requiresReinspection: z.literal(true) })
  .refine((s) => s.frozenAt <= (s.lastActivityAt ?? s.frozenAt) && (s.lastActivityAt ?? s.frozenAt) < s.expiresAt && s.expiresAt - (s.lastActivityAt ?? s.frozenAt) <= RECOVERY_TTL_MS && (s.source === 'saved') === (s.savedVersion !== null));
export type SavedProfile = z.infer<typeof SavedSchema>;
export type ProfileSnapshot = z.infer<typeof ProfileSnapshotSchema>;
export class ProfileStateError extends Error {
  constructor() { super('Profile state changed or expired. Reload profile state before trying again.'); }
}

// Accessed only by packaged extension pages/background. No profile messaging API or
// storage.local copy is introduced. Every read is validated, every write is atomic.
export class ProfileStore {
  constructor(private readonly database: IDBPDatabase<ApplyrDatabase>, private readonly now = Date.now, private readonly uuid = () => crypto.randomUUID()) {}

  async read() {
    const tx = this.database.transaction(LOCAL_STORES, 'readwrite');
    const rawDefault = await tx.objectStore('profiles').get('default');
    const rawSnapshot = await tx.objectStore('profiles').get('snapshot');
    const saved = SavedSchema.safeParse(rawDefault);
    const snapshot = ProfileSnapshotSchema.safeParse(rawSnapshot);
    const checkpoint = CheckpointSchema.safeParse(await tx.objectStore('checkpoints').get('current'));
    await purgeDocumentRecords(tx, checkpoint.success && checkpoint.data.expiresAt > this.now() ? checkpoint.data.id : null, this.now());
    const selected = snapshot.success && checkpoint.success && checkpoint.data.id === snapshot.data.sessionId && checkpoint.data.expiresAt > this.now() && snapshot.data.expiresAt > this.now() ? snapshot.data : null;
    if (rawDefault !== undefined && !saved.success) await tx.objectStore('profiles').delete('default');
    if (rawSnapshot !== undefined && !selected) await tx.objectStore('profiles').delete('snapshot');
    await tx.done;
    return { saved: saved.success ? saved.data : null, snapshot: selected };
  }

  async saveDefault(document: ProfileDocument, expectedVersion: string | null): Promise<SavedProfile> {
    await this.read();
    const checked = validateProfileDocument(document).document;
    if (!checked) throw new Error('Repair profile validation errors before saving.');
    const tx = this.database.transaction('profiles', 'readwrite');
    const old = SavedSchema.safeParse(await tx.store.get('default'));
    if ((old.success ? old.data.version : null) !== expectedVersion) { await tx.done; throw new ProfileStateError(); }
    const next: SavedProfile = { schemaVersion: 1, version: this.uuid(), document: checked, savedAt: this.now() };
    await tx.store.put(next, 'default'); await tx.done;
    return next;
  }

  async freeze(sessionId: string, selection: { source: 'saved'; savedVersion: string } | { source: 'replacement'; document: ProfileDocument }, expectedSnapshot: string | null): Promise<ProfileSnapshot> {
    await this.read();
    const replacement = selection.source === 'replacement' ? validateProfileDocument(selection.document).document : null;
    if (selection.source === 'replacement' && !replacement) throw new Error('Repair the selected profile before freezing.');
    const tx = this.database.transaction(LOCAL_STORES, 'readwrite');
    const profiles = tx.objectStore('profiles');
    const checkpoint = CheckpointSchema.safeParse(await tx.objectStore('checkpoints').get('current'));
    const old = ProfileSnapshotSchema.safeParse(await profiles.get('snapshot'));
    const active = old.success && checkpoint.success && old.data.sessionId === checkpoint.data.id && old.data.expiresAt > this.now() ? old.data : null;
    if (!checkpoint.success || terminal(checkpoint.data) || checkpoint.data.id !== sessionId || checkpoint.data.expiresAt <= this.now() || (active?.version ?? null) !== expectedSnapshot) { await tx.done; throw new ProfileStateError(); }
    const saved = SavedSchema.safeParse(await profiles.get('default'));
    if (selection.source === 'saved' && (!saved.success || saved.data.version !== selection.savedVersion)) { await tx.done; throw new ProfileStateError(); }
    const frozenAt = this.now();
    const next: ProfileSnapshot = {
      schemaVersion: 1, version: this.uuid(), sessionId, source: selection.source, savedVersion: selection.source === 'saved' ? selection.savedVersion : null,
      document: replacement ?? (saved.success ? saved.data.document : undefined)!, frozenAt, lastActivityAt: frozenAt, expiresAt: frozenAt + RECOVERY_TTL_MS, requiresReinspection: true,
    };
    // Explicit activity renews the checkpoint too; simply viewing state never does.
    await tx.objectStore('checkpoints').put({ ...checkpoint.data, revision: checkpoint.data.revision + 1, updatedAt: frozenAt, lastActivityAt: frozenAt, expiresAt: next.expiresAt }, 'current');
    await profiles.put(next, 'snapshot');
    await renewSessionInputs(tx, sessionId, frozenAt, next.expiresAt); await tx.done;
    return next;
  }

  async deleteDefault(expectedVersion: string) {
    const tx = this.database.transaction(LOCAL_STORES, 'readwrite');
    const old = SavedSchema.safeParse(await tx.objectStore('profiles').get('default'));
    if (!old.success || old.data.version !== expectedVersion) { await tx.done; throw new ProfileStateError(); }
    // Delete sensitive recovery copies too, including a session-only replacement.
    await tx.objectStore('profiles').clear();
    // Delete temporary approval/value copies too; retain only the result ledger.
    const checkpoints = tx.objectStore('checkpoints');
    for (const key of await checkpoints.getAllKeys()) {
      const parsed = CheckpointSchema.safeParse(await checkpoints.get(key));
      if (!parsed.success) continue;
      const cp = parsed.data;
      const next = terminal(cp) ? { ...cp, revision: cp.revision + 1, updatedAt: this.now() } : transition(cp, { type: 'INTERRUPT', reason: 'input_deleted' }, this.now());
      next.approval = undefined;
      next.attention = undefined; next.review = undefined;
      if (next.autofill) next.autofill = { ...next.autofill, status: next.autofill.status === 'running' ? 'interrupted' : next.autofill.status, operations: next.autofill.operations.map((op) => ({ ...op, recovery: undefined })) };
      await checkpoints.put(next, key);
    }
    await tx.done;
  }
}
