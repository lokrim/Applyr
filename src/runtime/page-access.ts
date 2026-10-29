import type { PageAccess, SessionCheckpoint, TargetReference } from '../domain/session';
import { createCheckpoint, transition, terminal } from '../domain/session';
import { displayText, originPattern, parseApplicationUrl, sanitizedUrl } from '../browser/addresses';
import { ProbeSchema } from './schemas';
import { CheckpointStore, StaleCheckpointError } from '../storage/checkpoints';
import { FormSnapshotSchema, InspectionSchema, type FormSelection } from '../forms/schema';

type Binding = { sessionId: string | null; revision: number | null };
export interface PageDependencies {
  store: () => Promise<CheckpointStore>;
  target: (tabId: number) => Promise<TargetReference>;
  probe: (tabId: number, identity: string, frame?: { url: string; identity: string }) => Promise<{ result: unknown; documentId?: string } | null>;
  inspect?: (tabId: number, identity: string, frame?: { url: string; identity: string }, selection?: FormSelection) => Promise<{ result: unknown; documentId?: string; frameId: number } | null>;
  contains: (origin: string) => Promise<boolean>;
  createTab: (url: string) => Promise<{ id?: number; windowId: number }>;
  now: () => number;
  uuid: () => string;
  changed: () => void;
  allowLoopback: boolean;
}

export function initialAccess(target: TargetReference): PageAccess {
  const restricted = !target.origin;
  return { status: restricted ? 'needs_attention' : 'unprobed', classification: restricted ? 'restricted' : 'uncertain', reason: restricted ? 'restricted' : 'unprobed', frames: [] };
}

export class PageAccessService {
  constructor(private readonly deps: PageDependencies) {}

  private async current(binding: Binding) {
    const checkpoint = await (await this.deps.store()).read();
    if (!checkpoint || checkpoint.id !== binding.sessionId || checkpoint.revision !== binding.revision) throw new StaleCheckpointError();
    return checkpoint;
  }

  private async write(checkpoint: SessionCheckpoint, access: PageAccess, target = checkpoint.target) {
    const blocked = access.status === 'needs_attention' && !terminal(checkpoint);
    const next: SessionCheckpoint = { ...(blocked ? transition(checkpoint, { type: 'INTERRUPT', reason: access.reason, reattach: ['restart', 'navigation', 'closed'].includes(access.reason) }, this.deps.now()) : { ...checkpoint, revision: checkpoint.revision + 1, updatedAt: this.deps.now() }), target, access };
    if (blocked && next.autofill?.status === 'running') next.autofill = { ...next.autofill, status: 'interrupted' };
    const saved = await (await this.deps.store()).replace(next, { sessionId: checkpoint.id, revision: checkpoint.revision });
    this.deps.changed(); return saved!;
  }

  private attention(checkpoint: SessionCheckpoint, reason: PageAccess['reason']) {
    return this.write(checkpoint, { ...(checkpoint.access ?? initialAccess(checkpoint.target)), status: 'needs_attention', reason });
  }

  async verify(checkpoint: SessionCheckpoint): Promise<SessionCheckpoint> {
    // Restart/changed-application blockers require deliberate new attachment.
    if (['restart', 'navigation', 'closed'].includes(checkpoint.access?.reason ?? '')) return checkpoint;
    let target: TargetReference;
    try { target = await this.deps.target(checkpoint.target.tabId); }
    catch { return this.attention(checkpoint, 'closed'); }
    if (!checkpoint.target.identity) return checkpoint; // Legacy setup: re-invoke before probing.
    if (target.availability === 'unavailable') return checkpoint.access?.reason === 'permission' ? checkpoint : this.attention(checkpoint, 'permission');
    if (target.identity !== checkpoint.target.identity || target.origin !== checkpoint.target.origin) return this.attention(checkpoint, 'navigation');
    return checkpoint;
  }

  async probe(binding: Binding, frameOrigin?: string, frameIdentity?: string): Promise<SessionCheckpoint> {
    let checkpoint = await this.current(binding);
    checkpoint = await this.verify(checkpoint);
    if (['restart', 'navigation', 'closed'].includes(checkpoint.access?.reason ?? '')) return checkpoint;
    const target = checkpoint.target;
    if (!target.origin) return this.attention(checkpoint, 'restricted');
    if (!target.identity) return this.attention(checkpoint, 'restart');
    let frame;
    if (frameOrigin) {
      originPattern(frameOrigin, this.deps.allowLoopback);
      frame = checkpoint.access?.frames.find((candidate) => candidate.origin === frameOrigin && candidate.identity === frameIdentity);
      if (!frame) throw new Error('ACCESS_UNAVAILABLE');
      if (frameOrigin !== target.origin && !await this.deps.contains(frameOrigin)) return this.attention(checkpoint, 'frame_permission');
    }
    try {
      // executeScript is the authority for activeTab. contains() alone cannot prove
      // a temporary grant. No grant is borrowed from the currently active tab.
      const injected = await this.deps.probe(target.tabId, frame?.identity ?? target.identity, frame);
      const parsed = ProbeSchema.safeParse(injected?.result);
      if (!parsed.success || parsed.data.identity !== (frame?.identity ?? target.identity)) return this.attention(checkpoint, frame ? 'frame_unavailable' : 'navigation');
      const observed = await this.deps.target(target.tabId);
      if (observed.identity !== target.identity || observed.origin !== target.origin) return this.attention(checkpoint, 'navigation');
      const result = parsed.data;
      const frames = result.frames.flatMap((candidate) => {
        try {
          const url = parseApplicationUrl(candidate.url, this.deps.allowLoopback);
          return url.origin === candidate.origin ? [{ ...candidate, url: sanitizedUrl(url) }] : [];
        } catch { return []; }
      });
      const ready = result.classification === 'application';
      return this.write(checkpoint, { status: ready ? 'ready' : 'needs_attention', classification: result.classification, challenge: result.challenge, reason: frames.some((f) => f.origin !== target.origin) ? 'frame_permission' : result.classification, frames: frame ? checkpoint.access?.frames ?? [] : frames, inspectedAt: this.deps.now(), ...(injected?.documentId ? { documentId: injected.documentId } : {}) }, {
        ...target, title: target.title ?? observed.title ?? null, role: target.role ?? displayText(result.role), company: target.company ?? displayText(result.company),
      });
    } catch (error) {
      if (error instanceof StaleCheckpointError) throw error;
      // Never expose browser exceptions containing an address or page contents.
      return this.attention(checkpoint, frame ? 'frame_unavailable' : 'permission');
    }
  }

  async edit(binding: Binding, role: string, company: string) {
    const checkpoint = await this.current(binding);
    return this.write(checkpoint, checkpoint.access ?? initialAccess(checkpoint.target), { ...checkpoint.target, role: displayText(role), company: displayText(company) });
  }

  async inspect(binding: Binding, frameOrigin?: string, frameIdentity?: string, selection?: FormSelection) {
    const checkpoint = await this.verify(await this.current(binding));
    if (!this.deps.inspect || !checkpoint.target.identity || !checkpoint.target.origin || ['restart', 'navigation', 'closed', 'permission', 'reload'].includes(checkpoint.access?.reason ?? '')) throw new Error('ACCESS_UNAVAILABLE');
    const frame = frameOrigin ? checkpoint.access?.frames.find((f) => f.origin === frameOrigin && f.identity === frameIdentity) : undefined;
    if (frameOrigin && (!frame || (frameOrigin !== checkpoint.target.origin && !await this.deps.contains(frameOrigin)))) throw new Error('ACCESS_UNAVAILABLE');
    let injected;
    try { injected = await this.deps.inspect(checkpoint.target.tabId, frame?.identity ?? checkpoint.target.identity, frame, selection); }
    catch { throw new Error('ACCESS_UNAVAILABLE'); }
    const snapshot = FormSnapshotSchema.safeParse(injected?.result);
    if (!snapshot.success || snapshot.data.identity !== (frame?.identity ?? checkpoint.target.identity)) throw new Error('ACCESS_UNAVAILABLE');
    await this.current(binding); // Discard a result racing a checkpoint/tab event.
    const observed = await this.deps.target(checkpoint.target.tabId);
    if (observed.identity !== checkpoint.target.identity || observed.origin !== checkpoint.target.origin) throw new Error('ACCESS_UNAVAILABLE');
    if (frame && frame.origin !== checkpoint.target.origin && !await this.deps.contains(frame.origin)) throw new Error('ACCESS_UNAVAILABLE');
    // Snapshots never enter checkpoints, IndexedDB, preferences, or history.
    return { checkpoint, inspection: InspectionSchema.parse({ sessionId: checkpoint.id, tabId: checkpoint.target.tabId, frameId: injected!.frameId, browserDocumentId: injected!.documentId ?? null, snapshot: snapshot.data }) };
  }


  async reattach(binding: Binding, tabId: number) {
    const cp = await this.current(binding), target = await this.deps.target(tabId);
    if (terminal(cp) || !cp.target.identity || target.identity !== cp.target.identity || target.origin !== cp.target.origin) throw new Error('ACCESS_UNAVAILABLE');
    const next = { ...transition(cp, { type: 'INTERRUPT', reason: 'reattached' }, this.deps.now()), target, access: initialAccess(target) };
    await (await this.deps.store()).replace(next, { sessionId: cp.id, revision: cp.revision });
    this.deps.changed();
    return this.probe({ sessionId: next.id, revision: next.revision });
  }

  async open(binding: Binding, raw: string, separateRun = false) {
    const store = await this.deps.store();
    const old = await store.read();
    if ((old?.id ?? null) !== binding.sessionId || (old?.revision ?? null) !== binding.revision) throw new StaleCheckpointError();
    let url: URL;
    try { url = parseApplicationUrl(raw, this.deps.allowLoopback); } catch { throw new Error('INVALID_URL'); }
    await store.assertNewRun(url.href, separateRun);
    const tab = await this.deps.createTab(url.href);
    if (tab.id === undefined) throw new Error('TAB_UNAVAILABLE');
    // The requested URL is the binding even if loading is still in flight. A
    // redirect is detected on update/verification and never silently adopted.
    const { capturedTarget } = await import('../browser/targets');
    const target = await capturedTarget({ ...tab, url: url.href }, this.deps.allowLoopback);
    const next = createCheckpoint(target, this.deps.uuid(), this.deps.now());
    next.access = { ...initialAccess(target), status: 'needs_attention', reason: 'permission' };
    next.lifecycle = 'NEEDS_ATTENTION';
    await store.replace(next, binding); this.deps.changed(); return next;
  }

  async event(tabId: number | null, reason: PageAccess['reason']) {
    // CAS retries protect tab/permission events from an in-flight input save.
    for (let attempt = 0; attempt < 3; attempt++) {
      const checkpoint = await (await this.deps.store()).read();
      if (!checkpoint || (tabId !== null && checkpoint.target.tabId !== tabId)) return;
      // A passive missing-tab read and onRemoved can observe the same closure.
      // Once durably blocked, duplicate terminal access events must not churn
      // the revision while a user explicitly opens or reattaches a target.
      if (checkpoint.access?.status === 'needs_attention' && checkpoint.access.reason === reason && ['closed', 'restart'].includes(reason)) return;
      if (['closed', 'restart', 'navigation'].includes(checkpoint.access?.reason ?? '') && !['closed', 'restart'].includes(reason)) return;
      try { await this.attention(checkpoint, reason); return; }
      catch (error) { if (!(error instanceof StaleCheckpointError)) throw error; }
    }
  }

  async revoked(origins: readonly string[]) {
    const checkpoint = await (await this.deps.store()).read();
    if (!checkpoint) return;
    const root = checkpoint.target.origin;
    if (root && origins.some((pattern) => permissionMatches(pattern, root))) await this.event(checkpoint.target.tabId, 'permission');
    else if (origins.some((pattern) => checkpoint.access?.frames.some((frame) => permissionMatches(pattern, frame.origin)))) await this.event(checkpoint.target.tabId, 'frame_permission');
  }
}

export function permissionMatches(pattern: string, origin: string) {
  if (pattern === '<all_urls>') return true;
  const match = /^(\*|https?):\/\/(\*|\*\.[^/]+|[^/]+)\/\*$/.exec(pattern);
  if (!match) return false;
  const url = new URL(origin);
  const host = match[2]!;
  return (match[1] === '*' || `${match[1]}:` === url.protocol) && (host === '*' || host === url.host || host === url.hostname || (host.startsWith('*.') && (url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)))));
}
