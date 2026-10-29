import type { IDBPDatabase } from 'idb';
import { observeReview } from '../review';
import type { ApplyrDatabase } from '../storage/database';
import { CheckpointStore, StaleCheckpointError } from '../storage/checkpoints';
import { ProfileStore } from '../storage/profiles';
import type { PageAccessService } from '../runtime/page-access';
import { transition, terminal, reviewReady, type SessionCheckpoint } from '../domain/session';
import type { SessionCorrection } from '../mapping/schema';
import type { Inspection } from '../forms/schema';
import { createDryRun, previewBinding } from '../mapping/rules';
import { recoverySignature } from '../forms/operations';
import { inspectionQueue, pending } from './queue';
import type { AttentionTarget } from './schema';
import type { Request } from '../runtime/schemas';

type Binding = { sessionId: string; revision: number };
export class AttentionService {
  constructor(private readonly deps: { database: () => Promise<IDBPDatabase<ApplyrDatabase>>; access: PageAccessService; changed: () => void; mark: (target: AttentionTarget, fields: string[], show: boolean) => Promise<boolean>; activate: (cp: SessionCheckpoint) => Promise<void> }) {}
  private async current(b: Binding) {
    const cp = await new CheckpointStore(await this.deps.database()).read();
    if (!cp || cp.id !== b.sessionId || cp.revision !== b.revision) throw new StaleCheckpointError();
    if (terminal(cp) || cp.lifecycle === 'RUNNING') throw new Error('ACCESS_UNAVAILABLE');
    return cp;
  }
  async observe(cp: SessionCheckpoint, inspection: Inspection) {
    if (terminal(cp)) return cp;
    const db = await this.deps.database(), input = (await new ProfileStore(db).read()).snapshot;
    const attention = await inspectionQueue(cp, inspection, input?.sessionId === cp.id ? input : null);
    const review = cp.autofill ? await observeReview(cp, inspection) : undefined;
    let next = cp;
    if (JSON.stringify(cp.attention) !== JSON.stringify(attention) || JSON.stringify(cp.review) !== JSON.stringify(review)) {
      const gate = inspection.snapshot.unsupported.some((i) => ['login', 'otp', 'captcha', 'authentication'].includes(i.code));
      next = { ...(gate ? transition(cp, { type: 'INTERRUPT', reason: 'manual_challenge' }, Date.now()) : { ...cp, revision: cp.revision + 1, updatedAt: Date.now() }), attention, review, autofill: cp.autofill && review ? { ...cp.autofill, requiredUnresolved: review.items.filter((i) => i.required && !['accepted', 'manual'].includes(i.status)).length, unsupported: review.areas.reduce((n, a) => n + a.unsupported, 0) } : undefined };
      if (next.reviewScope === 'final_review' && !reviewReady(next)) next.reviewScope = undefined;
      await new CheckpointStore(db).replace(next, { sessionId: cp.id, revision: cp.revision });
      this.deps.changed();
    }
    return next;
  }

  async reinspect(b: Binding, itemId?: string) {
    let cp = await this.current(b);
    const item = cp.attention?.items.find((i) => i.id === itemId);
    if (itemId && (!item || !pending(item))) throw new Error('ACCESS_UNAVAILABLE');
    const context = item?.context ?? item?.target;
    // Legacy embedded area records have no independently validated context.
    // Require explicit frame inspection rather than silently observing the root.
    if (!context && item?.key.startsWith('area:') && !item.key.startsWith('area:0:')) throw new Error('ACCESS_UNAVAILABLE');
    if (context && context.tabId !== cp.target.tabId) throw new Error('ACCESS_UNAVAILABLE');
    const frame = context?.frameId ? cp.access?.frames.find((f) => f.identity === context.identity) : undefined;
    if (context && (context.frameId ? !frame : context.identity !== cp.target.identity)) throw new Error('ACCESS_UNAVAILABLE');
    if (cp.access?.status !== 'ready') cp = await this.deps.access.probe(b, frame?.origin, frame?.identity);
    if (cp.access?.status !== 'ready') return { checkpoint: cp };
    const selection = context?.formId && item?.context?.multipleForms ? { formId: context.formId, document: context.document, revision: context.revision } : undefined;
    const observed = await this.deps.access.inspect({ sessionId: cp.id, revision: cp.revision }, frame?.origin, frame?.identity, selection);
    const fresh = observed.inspection;
    if (context && (fresh.snapshot.status !== 'stable' || fresh.tabId !== context.tabId || fresh.frameId !== context.frameId || fresh.browserDocumentId !== context.browserDocumentId || fresh.snapshot.identity !== context.identity || fresh.snapshot.document !== context.document)) throw new Error('ACCESS_UNAVAILABLE');
    return { ...observed, checkpoint: await this.observe(cp, observed.inspection) };
  }
  async answers(message: Extract<Request, { type: 'ATTENTION_ANSWERS' }>) {
    const cp = await this.current(message), selected = message.answers.map((a) => cp.attention?.items.find((i) => i.id === a.itemId));
    if (new Set(message.answers.map((a) => a.itemId)).size !== message.answers.length || selected.some((i, n) => !i?.correctable || !i.target || i.revision !== message.answers[n]!.itemRevision || !pending(i))) throw new Error('ACCESS_UNAVAILABLE');
    const first = selected[0]!.target!;
    if (selected.some((i) => i!.target!.frameId !== first.frameId || i!.target!.document !== first.document)) throw new Error('ACCESS_UNAVAILABLE');
    const frame = first.frameId ? cp.access?.frames.find((f) => f.identity === first.identity) : undefined;
    if (first.frameId && !frame) throw new Error('ACCESS_UNAVAILABLE');
    const { inspection } = await this.deps.access.inspect(message, frame?.origin, frame?.identity);
    const input = (await new ProfileStore(await this.deps.database()).read()).snapshot;
    if (!input || input.sessionId !== cp.id) throw new Error('ACCESS_UNAVAILABLE');
    const existing = cp.attention?.items.flatMap((i) => i.correction ? [i.correction] : []) ?? [];
    const corrections: SessionCorrection[] = [];
    for (let n = 0; n < selected.length; n++) {
      const item = selected[n]!, a = message.answers[n]!, t = item.target!;
      const field = inspection.snapshot.fields.find((f) => f.id === t.fieldId);
      if (!field || t.tabId !== cp.target.tabId || inspection.snapshot.identity !== t.identity || inspection.frameId !== t.frameId || inspection.browserDocumentId !== t.browserDocumentId || inspection.snapshot.document !== t.document || inspection.snapshot.revision !== t.revision || await recoverySignature(field) !== t.signature) throw new Error('ACCESS_UNAVAILABLE');
      corrections.push({ binding: previewBinding(inspection, input), fieldId: field.id, currentFingerprint: field.current.fingerprint, value: a.value, eligibilityConfirmed: a.eligibilityConfirmed });
    }
    const combined = [...existing.filter((c) => !corrections.some((x) => x.fieldId === c.fieldId)), ...corrections];
    const preview = createDryRun(inspection, input, combined);
    if (corrections.some((c) => preview.items.find((i) => i.fieldId === c.fieldId)?.state !== 'proposed')) throw new Error('ACCESS_UNAVAILABLE');
    const withAnswers = { ...cp, attention: { ...cp.attention!, items: cp.attention!.items.map((i) => {
      const correction = corrections.find((c) => c.fieldId === i.target?.fieldId);
      return correction ? { ...i, status: 'answer_ready' as const, correction } : i;
    }) } };
    const attention = await inspectionQueue(withAnswers, inspection, input);
    const next = { ...cp, attention, revision: cp.revision + 1, updatedAt: Date.now() };
    await new CheckpointStore(await this.deps.database()).replace(next, message); this.deps.changed();
    return { checkpoint: next, inspection };
  }
  async show(b: Binding, itemId?: string, fieldId?: string) {
    const cp = await this.current(b);
    const verified = await this.deps.access.verify(cp);
    if (verified.revision !== cp.revision || cp.recovery?.reattachRequired || !cp.target.identity || !cp.target.origin) throw new Error('ACCESS_UNAVAILABLE');
    if (itemId || fieldId) {
      const item = cp.attention?.items.find((i) => i.id === itemId && pending(i));
      const t = item?.target ?? cp.review?.items.find((i) => i.fieldId === fieldId)?.target;
      if (!t || t.tabId !== cp.target.tabId || (t.frameId !== 0 && !cp.access?.frames.some((f) => f.identity === t.identity))) throw new Error('ACCESS_UNAVAILABLE');
      const frame = t.frameId ? cp.access?.frames.find((f) => f.identity === t.identity) : undefined;
      const { inspection } = await this.deps.access.inspect(b, frame?.origin, frame?.identity);
      const f = inspection.snapshot.fields.find((f) => f.id === t.fieldId);
      if (!f || inspection.snapshot.document !== t.document || inspection.frameId !== t.frameId || inspection.browserDocumentId !== t.browserDocumentId || inspection.snapshot.revision !== t.revision || await recoverySignature(f) !== t.signature) throw new Error('ACCESS_UNAVAILABLE');
      if (!await this.deps.mark(t, [t.fieldId], true)) throw new Error('ACCESS_UNAVAILABLE');
    }
    // Activation follows an explicit Return/Show click only. No field.focus().
    try { await this.current(b); await this.deps.activate(cp); return cp; }
    catch (error) {
      const target = cp.attention?.items.find((i) => i.id === itemId)?.target;
      if (target) await this.deps.mark(target, [], false).catch(() => false);
      throw error;
    }
  }
}
