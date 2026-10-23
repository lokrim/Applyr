import type { IDBPDatabase } from 'idb';
import type { SessionCheckpoint } from '../domain/session';
import { CheckpointSchema } from '../runtime/schemas';
import type { ApplyrDatabase } from './database';

const CURRENT = 'current';
export class StaleCheckpointError extends Error {}

export class CheckpointStore {
  constructor(private readonly database: IDBPDatabase<ApplyrDatabase>, private readonly now = Date.now) {}

  async read(): Promise<SessionCheckpoint | null> {
    const transaction = this.database.transaction(['checkpoints', 'profiles'], 'readwrite');
    const checkpoints = transaction.objectStore('checkpoints');
    const raw = await checkpoints.get(CURRENT);
    const parsed = CheckpointSchema.safeParse(raw);
    const checkpoint = parsed.success && parsed.data.expiresAt > this.now() ? parsed.data : null;
    if (raw !== undefined && !checkpoint) await checkpoints.delete(CURRENT);
    if (!checkpoint) await transaction.objectStore('profiles').delete('snapshot');
    await transaction.done;
    return checkpoint;
  }

  // Compare-and-swap in a single IDB transaction prevents two UI surfaces replacing newer state.
  async replace(next: SessionCheckpoint | null, expected: { sessionId: string | null; revision: number | null }) {
    if (next) CheckpointSchema.parse(next);
    const transaction = this.database.transaction(['checkpoints', 'profiles'], 'readwrite');
    const checkpoints = transaction.objectStore('checkpoints');
    const raw = await checkpoints.get(CURRENT);
    const parsed = CheckpointSchema.safeParse(raw);
    const current = parsed.success && parsed.data.expiresAt > this.now() ? parsed.data : null;
    if ((current?.id ?? null) !== expected.sessionId || (current?.revision ?? null) !== expected.revision) {
      if (raw !== undefined && !current) { await checkpoints.delete(CURRENT); await transaction.objectStore('profiles').delete('snapshot'); }
      await transaction.done;
      throw new StaleCheckpointError();
    }
    if (next) await checkpoints.put(next, CURRENT);
    else await checkpoints.delete(CURRENT);
    if (!next || next.id !== current?.id) await transaction.objectStore('profiles').delete('snapshot');
    await transaction.done;
    return next;
  }
}
