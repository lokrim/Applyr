import { draftQueue } from '../attention/queue';
import type { IDBPDatabase } from 'idb';
import type { ApplyrDatabase } from '../storage/database';
import { transition, terminal, LEASE_MS, type SessionCheckpoint } from '../domain/session';
import { ProfileStore } from '../storage/profiles';
import { CheckpointStore } from '../storage/checkpoints';
import { previewBinding } from '../mapping/rules';
import { ProviderFailure } from '../providers/contracts';
import type { ProviderService } from '../providers/service';
import type { AutofillService } from '../runtime/autofill';
import type { Inspection } from '../forms/schema';
import { trustedPage, type Sender } from '../security/sender';
import { AiRequestSchema, type AiRequest, type ReviewBatch } from './contracts';
import { selectContext } from './context';
import { validateProposals, valueFor } from './validation';

export class AiService {
  private batch: { review: ReviewBatch; inspection: Inspection; expiresAt: number; checkpointRevision: number } | null = null;
  private pending: AbortController | null = null;
  constructor(private database: () => Promise<IDBPDatabase<ApplyrDatabase>>, private providers: ProviderService, private autofill: AutofillService, private changed: () => void = () => {}) {}
  discard() { this.pending?.abort(); this.pending = null; this.batch = null; }
  async execute(request: AiRequest) {
    if (request.type === 'DISCARD') { this.discard();
      const store = new CheckpointStore(await this.database()), cp = await store.read();
      if (cp?.attention?.items.some((i) => i.key.startsWith('draft:') && i.status === 'open')) {
        await store.replace({ ...cp, revision: cp.revision + 1, updatedAt: Date.now(), attention: { ...cp.attention, revision: cp.attention.revision + 1, items: cp.attention.items.map((i) => i.key.startsWith('draft:') ? { ...i, status: 'stale', revision: i.revision + Number(i.status !== 'stale') } : i) } }, { sessionId: cp.id, revision: cp.revision }); this.changed();
      }
      return { batch: null, message: 'AI is off. Deterministic autofill remains available.' }; }
    if (request.type === 'PREPARE') {
      if (this.pending) throw new ProviderFailure('busy');
      this.batch = null;
      const controller = new AbortController(); this.pending = controller;
      let durable: { sessionId: string; previous: SessionCheckpoint } | null = null;
      try {
        const db = await this.database(), cp = await new CheckpointStore(db).read();
        const input = (await new ProfileStore(db).read()).snapshot;
        if (!input || !cp || terminal(cp) || cp.lifecycle === 'PAUSED' || cp.lease || cp.recovery?.inspectionRequired || cp.recovery?.reattachRequired || cp.aiRequest?.id === request.requestId || cp.providerRequests?.some((r) => r.id === request.requestId) || (cp.providerRequests?.length ?? 0) >= 100 || cp.id !== request.inspection.sessionId || cp.target.tabId !== request.inspection.tabId || input.version !== request.inputVersion || cp.access?.status !== 'ready' || cp.autofill?.status === 'running' || cp.autofill?.status === 'cancelled') throw new ProviderFailure('stale');
        const context = selectContext(request.inspection, input, request.selections, request.roleExcerpt);
        // No evidence means an explicit local question, never a speculative paid request.
        if (context.fields.some((f) => !f.evidence.length)) throw new ProviderFailure('invalid_request');
        const store = new CheckpointStore(db);
        const preparing = { ...transition(cp, { type: 'START', lease: { owner: this.autofill.owner, token: request.requestId, application: cp.target.identity ?? '', expiresAt: Date.now() + LEASE_MS } }, Date.now()), phase: 'PREPARING' as const, aiRequest: { id: request.requestId, status: 'pending' as const, inputVersion: input.version } };
        preparing.providerRequests = [...cp.providerRequests ?? [], preparing.aiRequest];
        await store.replace(preparing, { sessionId: cp.id, revision: cp.revision });
        durable = { sessionId: cp.id, previous: cp };
        const result = await this.providers.propose(request.provider, context, controller.signal, async () => {
          const frozen = (await new ProfileStore(db).read()).snapshot, checkpoint = await new CheckpointStore(db).read();
          return frozen?.version === input.version && checkpoint?.id === cp.id && checkpoint.revision === preparing.revision && checkpoint.lifecycle === 'RUNNING' && !checkpoint.pauseRequested;
        });
        const latest = (await new ProfileStore(db).read()).snapshot, current = await new CheckpointStore(db).read();
        if (controller.signal.aborted || latest?.version !== input.version || current?.id !== cp.id || current.revision !== preparing.revision || current.lifecycle !== 'RUNNING' || current.pauseRequested) throw new ProviderFailure('stale');
        const review: ReviewBatch = { id: crypto.randomUUID(), binding: previewBinding(request.inspection, input), context, proposals: validateProposals({ scope: context.scope, revision: context.revision, proposals: result.proposals }, context), model: result.model, provider: request.provider };
        const completed = { ...current, revision: current.revision + 1, updatedAt: Date.now(), lifecycle: cp.lifecycle, phase: cp.phase, lease: undefined, providerRequests: current.providerRequests?.map((r) => r.id === request.requestId ? { ...r, status: 'completed' as const } : r), aiRequest: { ...preparing.aiRequest, status: 'completed' as const } };
        const questions = review.context.fields.filter((f) => review.proposals.some((p) => p.fieldId === f.id));
        completed.attention = draftQueue(completed, review.id, questions);
        await store.replace(completed, { sessionId: cp.id, revision: current.revision }); durable = null;
        this.batch = { review, inspection: request.inspection, checkpointRevision: completed.revision, expiresAt: Math.min(input.expiresAt, Date.now() + 15 * 60_000) };
        this.changed();
        return { batch: review, message: 'Review source facts and wording. Nothing has been inserted.' };
      } catch (e) {
        if (durable) {
          const store = new CheckpointStore(await this.database()), cp = await store.read();
          if (cp?.id === durable.sessionId && cp.lease?.token === request.requestId && cp.aiRequest?.id === request.requestId && cp.aiRequest.status === 'pending') {
            await store.replace({ ...cp, revision: cp.revision + 1, updatedAt: Date.now(), lifecycle: durable.previous.lifecycle, phase: durable.previous.phase, reviewScope: durable.previous.reviewScope, lease: undefined, recovery: { reason: 'provider_request_uncertain', inspectionRequired: false, reattachRequired: false }, providerRequests: cp.providerRequests?.map((r) => r.id === request.requestId ? { ...r, status: 'uncertain' as const } : r), aiRequest: { ...cp.aiRequest, status: 'uncertain' } }, { sessionId: cp.id, revision: cp.revision });
          }
        }
        throw e;
      } finally { if (this.pending === controller) this.pending = null; }
    }
    const saved = this.batch;
    if (!saved || request.batchId !== saved.review.id || saved.expiresAt <= Date.now() || new Set(request.decisions.map((d) => d.fieldId)).size !== request.decisions.length) throw new ProviderFailure('stale');
    const db = await this.database(), store = new CheckpointStore(db), checkpoint = await store.read();
    const input = (await new ProfileStore(db).read()).snapshot;
    if (!checkpoint || checkpoint.id !== saved.inspection.sessionId || checkpoint.revision !== saved.checkpointRevision || terminal(checkpoint) || checkpoint.lifecycle === 'PAUSED' || input?.version !== saved.review.binding.inputVersion || checkpoint.approval?.batchId === saved.review.id) throw new ProviderFailure('stale');
    const values = request.decisions.flatMap((d) => {
      const p = saved.review.proposals.find((p) => p.fieldId === d.fieldId);
      if (!p || (d.action === 'approve' && (!d.factsReviewed || p.status !== 'proposed'))) throw new ProviderFailure('invalid_request');
      if (d.action === 'reject') return [];
      const edited = p.operation === 'map_fact' ? { ...p, factRefs: [d.factRef ?? p.factRefs[0]!], optionId: d.optionId ?? p.optionId } : p;
      validateProposals({ scope: saved.review.context.scope, revision: saved.review.context.revision, proposals: saved.review.proposals.map((proposal) => proposal.fieldId === p.fieldId ? edited : proposal) }, saved.review.context);
      return [{ fieldId: p.fieldId, value: valueFor(edited, saved.review.context, d.text) }];
    });
    // Consume BEFORE awaiting insertion: duplicate decisions never replay a write.
    this.batch = null;
    const attention = checkpoint.attention ? { ...checkpoint.attention, revision: checkpoint.attention.revision + 1, items: checkpoint.attention.items.map((i) => i.key.startsWith(`draft:${saved.review.id}:`) ? { ...i, status: 'resolved' as const, revision: i.revision + 1 } : i) } : undefined;
    await store.replace({ ...checkpoint, attention, revision: checkpoint.revision + 1, updatedAt: Date.now(), approval: { batchId: saved.review.id, inputVersion: saved.review.binding.inputVersion, document: saved.review.binding.document, revision: saved.review.binding.revision, at: Date.now(), decisions: request.decisions.map((d) => ({ fieldId: d.fieldId, action: d.action, text: values.find((v) => v.fieldId === d.fieldId)?.value.kind === 'text' ? d.text : '' })) } }, { sessionId: checkpoint.id, revision: checkpoint.revision });
    if (values.length) {
      try { await this.autofill.applyApproved(saved.inspection, saved.review.binding.inputVersion, values); }
      catch (error) {
        const current = await store.read();
        if (current?.id === checkpoint.id && current.approval?.batchId === saved.review.id && !terminal(current) && current.lifecycle !== 'PAUSED') {
          await store.replace(transition(current, { type: 'INTERRUPT', reason: 'approval_changed' }, Date.now()), { sessionId: current.id, revision: current.revision });
          this.changed();
        }
        throw error;
      }
    }
    this.changed();
    return { batch: null, message: values.length ? 'Approved values processed. Review saved field results and the website. Reinspect before another batch.' : 'Proposals rejected. No page values changed.' };
  }
}
export function aiHandler(service: AiService, extensionId: string, pages: string[]) {
  return async (raw: unknown, sender: Sender) => {
    if (!trustedPage(sender, extensionId, pages)) return { ok: false, requestId: null, code: 'permission' };
    const parsed = AiRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, requestId: null, code: 'invalid_request' };
    try { return { ok: true, requestId: parsed.data.requestId, ...await service.execute(parsed.data) }; }
    catch (e) { return { ok: false, requestId: parsed.data.requestId, code: e instanceof ProviderFailure ? e.code : 'stale' }; }
  };
}
