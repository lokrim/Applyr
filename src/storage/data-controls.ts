import type { IDBPDatabase } from 'idb';
import type { ApplyrDatabase } from './database';
import { LOCAL_STORES, purgeDocumentRecords } from './documents';
import { CheckpointSchema } from '../runtime/schemas';
import { terminal, transition } from '../domain/session';
import { purgeHistory, saveHistory } from './history';

export type DeletionScope = 'profile' | 'history' | 'all';
// Callers invalidate in-memory work before entering this transaction. All retained
// history is allowlisted; saved documents and credentials obey independent choices.
export async function deleteLocalData(db: IDBPDatabase<ApplyrDatabase>, scope: DeletionScope, now = Date.now()) {
  if (scope === 'all') {
    const stores = [...LOCAL_STORES, 'providerSettings', 'providerCredentials'] as const;
    const tx = db.transaction(stores, 'readwrite');
    for (const name of stores) await tx.objectStore(name).clear();
    await tx.done; return;
  }
  const tx = db.transaction(LOCAL_STORES, 'readwrite');
  if (scope === 'history') {
    await tx.objectStore('checkpoints').clear();
    await tx.objectStore('history').clear();
    await tx.objectStore('profiles').delete('snapshot');
    await purgeDocumentRecords(tx, null, now);
  } else {
    await purgeHistory(tx, now);
    await tx.objectStore('profiles').clear();
    for (const key of await tx.objectStore('checkpoints').getAllKeys()) {
      const p = CheckpointSchema.safeParse(await tx.objectStore('checkpoints').get(key));
      if (!p.success) { await tx.objectStore('checkpoints').delete(key); continue; }
      const cp = p.data;
      const next = terminal(cp) ? { ...cp, revision: cp.revision + 1 } : transition(cp, { type: 'INTERRUPT', reason: 'input_deleted' }, now);
      next.approval = undefined; next.review = undefined; next.attention = undefined;
      if (next.autofill) next.autofill = { ...next.autofill, status: next.autofill.status === 'running' ? 'interrupted' : next.autofill.status, operations: next.autofill.operations.map((o) => ({ ...o, recovery: undefined })) };
      await tx.objectStore('checkpoints').put(next, key); await saveHistory(tx, next);
    }
  }
  await tx.done;
}
