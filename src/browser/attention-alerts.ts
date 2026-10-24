import type { SessionCheckpoint } from '../domain/session';
import { terminal } from '../domain/session';
import { pending } from '../attention/queue';

export interface AlertState { enabled: boolean; seen: string[]; links: { token: string; sessionId: string }[] }
export function parseAlerts(raw: unknown): AlertState {
  const v = raw as Partial<AlertState> | null;
  return { enabled: v?.enabled === true, seen: Array.isArray(v?.seen) ? v.seen.filter((x): x is string => typeof x === 'string' && /^[a-f0-9-]+:\d+$/.test(x)).slice(-400) : [], links: Array.isArray(v?.links) ? v.links.filter((x) => typeof x?.token === 'string' && /^[a-f0-9-]{36}$/.test(x.token) && typeof x.sessionId === 'string' && /^[a-f0-9-]{36}$/.test(x.sessionId)).slice(-40) : [] };
}
export function badgeStatus(cp: SessionCheckpoint | null) {
  const attention = !cp || terminal(cp) ? false : cp.attention?.items.some(pending) || cp.lifecycle === 'NEEDS_ATTENTION';
  return attention ? { text: '!', title: 'applyr: needs attention' } : cp?.lifecycle === 'RUNNING' ? { text: '…', title: 'applyr: working' } : cp?.lifecycle === 'PAUSED' ? { text: 'II', title: 'applyr: paused' } : cp?.lifecycle === 'READY_FOR_REVIEW' ? { text: 'R', title: 'applyr: review on website' } : { text: '', title: 'applyr' };
}
export class AttentionAlerts {
  private tail = Promise.resolve();
  constructor(private readonly deps: {
    read: () => Promise<AlertState>; write: (state: AlertState) => Promise<void>;
    permission: () => Promise<boolean>; badge: (status: ReturnType<typeof badgeStatus>) => Promise<void>;
    create?: (id: string, options: { title: string; message: string }) => Promise<void>;
    clear?: (id: string) => Promise<unknown>;
  }) {}
  refresh(cp: SessionCheckpoint | null) {
    const work = this.tail.then(async () => {
      await this.deps.badge(badgeStatus(cp)).catch(() => {});
      const state = await this.deps.read();
      if (!state.enabled) return;
      if (!await this.deps.permission().catch(() => false)) {
        await this.deps.write({ ...state, enabled: false });
        for (const link of state.links) await this.deps.clear?.(`applyr-${link.token}`).catch(() => {});
        return;
      }
      if (!cp || terminal(cp)) return;
      const keys = cp.attention?.items.filter((i) => i.status === 'open').map((i) => `${i.id}:${i.revision}`) ?? [];
      if (!keys.some((key) => !state.seen.includes(key)) || !this.deps.create) return;
      const token = crypto.randomUUID();
      // Claim the batch before delivery. A worker crash cannot duplicate it.
      await this.deps.write({ ...state, seen: [...state.seen.filter((old) => !keys.some((key) => key.split(':')[0] === old.split(':')[0])), ...keys].slice(-400), links: [...state.links, { token, sessionId: cp.id }].slice(-40) });
      await this.deps.create(`applyr-${token}`, { title: 'applyr needs attention', message: 'Open your session to review items that need your action.' }).catch(() => { /* Queue and badge remain usable if OS/API delivery fails. */ });
    });
    this.tail = work.catch(() => {}); return work;
  }
}

// Notification clicks select a saved session only; they never execute/resume it.
export async function openAttentionAlert(id: string, deps: {
  state: () => Promise<AlertState>; current: () => Promise<SessionCheckpoint | null>;
  archived: () => Promise<SessionCheckpoint[]>;
  restore: (id: string, expected: { sessionId: string; revision: number }) => Promise<SessionCheckpoint | null>;
  open: (cp: SessionCheckpoint) => Promise<void>;
}) {
  const link = (await deps.state()).links.find((l) => id === `applyr-${l.token}`);
  if (!link) return false;
  let cp = await deps.current();
  if (cp && cp.id !== link.sessionId) {
    const saved = (await deps.archived()).find((c) => c.id === link.sessionId);
    if (saved && !terminal(saved)) cp = await deps.restore(saved.id, { sessionId: cp.id, revision: cp.revision });
  }
  if (cp?.id !== link.sessionId) return false;
  await deps.open(cp); return true;
}
