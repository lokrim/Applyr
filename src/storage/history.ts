import { z } from 'zod';
import { CheckpointStore } from './checkpoints';
import { ErrorCodeSchema } from '../providers/contracts';
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import type { ApplyrDatabase } from './database';
import type { LOCAL_STORES } from './documents';
import type { SessionCheckpoint } from '../domain/session';
import { terminal } from '../domain/session';
import { CheckpointSchema } from '../runtime/schemas';
import { displayText, sanitizedUrl } from '../browser/addresses';
import { pending } from '../attention/queue';
import { AttentionCode } from '../attention/schema';
import { ActionResultSchema } from '../forms/operations';

export const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const time = z.number().int().nonnegative(), uuid = z.uuid();
export const HistorySchema = z.strictObject({
  schemaVersion: z.literal(1), id: uuid, url: z.string().max(4096).refine((v) => canonicalJobUrl(v) === v).nullable(), company: z.string().max(180).nullable(), role: z.string().max(180).nullable(),
  createdAt: time, updatedAt: time, endedAt: time.nullable(), expiresAt: time.nullable(),
  state: z.enum(['QUEUED', 'RUNNING', 'NEEDS_ATTENTION', 'PAUSED', 'READY_FOR_REVIEW', 'AUTOFILL_FINISHED', 'CANCELLED', 'FAILED', 'EXPIRED']),
  profileVersions: z.array(uuid).max(100), documentVersions: z.array(uuid).max(100),
  providers: z.array(z.strictObject({ provider: z.enum(['openai', 'claude', 'gemini']), model: z.string().max(160) })).max(100),
  providerErrors: z.array(ErrorCodeSchema).max(20),
  blockers: z.array(AttentionCode).max(30), errors: z.array(ActionResultSchema.shape.code).max(30),
  submission: z.strictObject({ status: z.enum(['unknown', 'reported_by_user']), reportedAt: time.optional(), source: z.literal('user').optional() }).refine((s) => s.status === 'reported_by_user' ? s.reportedAt !== undefined && s.source === 'user' : s.reportedAt === undefined && s.source === undefined),
}).refine((h) => h.createdAt <= h.updatedAt && (h.endedAt === null ? h.expiresAt === null && !['EXPIRED', 'CANCELLED', 'FAILED', 'AUTOFILL_FINISHED'].includes(h.state) : h.expiresAt === h.endedAt + HISTORY_TTL_MS));
export type HistoryEntry = z.infer<typeof HistorySchema>;
type Tx = IDBPTransaction<ApplyrDatabase, typeof LOCAL_STORES, 'readwrite'>;
export function canonicalJobUrl(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const url = new URL(sanitizedUrl(new URL(raw)));
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].slice(-100);
export async function saveHistory(tx: Tx, cp: SessionCheckpoint, expired = false) {
  const parsed = HistorySchema.safeParse(await tx.objectStore('history').get(cp.id));
  const old = parsed.success ? parsed.data : null;
  const snapshot = await tx.objectStore('profiles').get('snapshot') as { sessionId?: unknown; version?: unknown } | undefined;
  const profile = snapshot?.sessionId === cp.id && uuid.safeParse(snapshot.version).success ? snapshot.version as string : cp.autofill?.inputVersion;
  const documents = await tx.objectStore('documents').getAll() as { sessionId?: unknown; inputVersion?: unknown }[];
  const doc = documents.find((d) => d.sessionId === cp.id && uuid.safeParse(d.inputVersion).success)?.inputVersion as string | undefined ?? cp.autofill?.documentInput?.inputVersion;
  const endedAt = old?.endedAt ?? (terminal(cp) ? cp.updatedAt : expired ? cp.expiresAt : null);
  const entry: HistoryEntry = {
    schemaVersion: 1, id: cp.id, url: canonicalJobUrl(cp.target.url), company: displayText(cp.target.company), role: displayText(cp.target.role),
    createdAt: cp.createdAt, updatedAt: cp.updatedAt, endedAt, expiresAt: endedAt === null ? null : endedAt + HISTORY_TTL_MS,
    state: expired && !terminal(cp) ? 'EXPIRED' : cp.lifecycle,
    profileVersions: union(old?.profileVersions ?? [], profile ? [profile] : []), documentVersions: union(old?.documentVersions ?? [], doc ? [doc] : []),
    providers: [...new Map([...(old?.providers ?? []), ...(cp.providers ?? [])].map((p) => [`${p.provider}:${p.model}`, { provider: p.provider, model: displayText(p.model)?.slice(0, 160) ?? 'Unknown' }])).values()].slice(-100),
    providerErrors: [...new Set([...(old?.providerErrors ?? []), ...(cp.providerError ? [cp.providerError] : [])])],
    blockers: [...new Set([...(cp.attention?.items.filter(pending).map((i) => i.code) ?? []), ...(expired || cp.recovery?.inspectionRequired || cp.recovery?.reattachRequired ? ['recovery' as const] : [])])],
    errors: [...new Set(cp.autofill?.operations.flatMap((o) => o.result && o.result.status !== 'accepted' ? [o.result.code] : []) ?? [])], submission: { ...cp.submission },
  };
  await tx.objectStore('history').put(HistorySchema.parse(entry), cp.id);
}
// Runs in the same transaction as physical sensitive-copy removal. Viewing never renews expiry.
export async function purgeHistory(tx: Tx, now: number) {
  const current = CheckpointSchema.safeParse(await tx.objectStore('checkpoints').get('current'));
  for (const key of await tx.objectStore('checkpoints').getAllKeys()) {
    const p = CheckpointSchema.safeParse(await tx.objectStore('checkpoints').get(key));
    if (!p.success) { await tx.objectStore('checkpoints').delete(key); continue; }
    if (key !== 'current' && current.success && p.data.id === current.data.id) { await tx.objectStore('checkpoints').delete(key); continue; }
    await saveHistory(tx, p.data, p.data.expiresAt <= now);
    if (p.data.expiresAt <= now) { await tx.objectStore('checkpoints').delete(key); if (key === 'current') await tx.objectStore('profiles').delete('snapshot'); }
  }
  for (const key of await tx.objectStore('history').getAllKeys()) {
    const p = HistorySchema.safeParse(await tx.objectStore('history').get(key));
    if (!p.success || (p.data.expiresAt !== null && p.data.expiresAt <= now)) await tx.objectStore('history').delete(key);
  }
}
export class HistoryStore {
  constructor(private db: IDBPDatabase<ApplyrDatabase>, private now = Date.now) {}
  async read() {
    await new CheckpointStore(this.db, this.now).read();
    return (await this.db.getAll('history')).flatMap((r) => { const p = HistorySchema.safeParse(r); return p.success ? [p.data] : []; }).sort((a, b) => b.createdAt - a.createdAt);
  }
  async duplicates(url: string | null | undefined) {
    const canonical = canonicalJobUrl(url);
    return canonical ? (await this.read()).filter((h) => h.url === canonical) : [];
  }
  async export() { return JSON.stringify({ schemaVersion: 1, applications: await this.read() }, null, 2); }
  async diagnostics() {
    const entries = await this.read();
    // Fixed categories and counts only. No IDs, URLs, questions, answers or model strings.
    return JSON.stringify({ schemaVersion: 1, applications: entries.length, states: entries.map((h) => h.state), errors: [...new Set(entries.flatMap((h) => h.errors))], providerErrors: [...new Set(entries.flatMap((h) => h.providerErrors))], blockers: [...new Set(entries.flatMap((h) => h.blockers))] }, null, 2);
  }
}
