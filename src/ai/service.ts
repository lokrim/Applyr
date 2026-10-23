import type { IDBPDatabase } from 'idb';
import type { ApplyrDatabase } from '../storage/database';
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
  private batch: { review: ReviewBatch; inspection: Inspection; expiresAt: number } | null = null;
  private pending: AbortController | null = null;
  constructor(private database: () => Promise<IDBPDatabase<ApplyrDatabase>>, private providers: ProviderService, private autofill: AutofillService) {}
  discard() { this.pending?.abort(); this.pending = null; this.batch = null; }
  async execute(request: AiRequest) {
    if (request.type === 'DISCARD') { this.discard(); return { batch: null, message: 'AI is off. Deterministic autofill remains available.' }; }
    if (request.type === 'PREPARE') {
      if (this.pending) throw new ProviderFailure('busy');
      this.batch = null;
      const controller = new AbortController(); this.pending = controller;
      try {
        const db = await this.database(), cp = await new CheckpointStore(db).read();
        const input = (await new ProfileStore(db).read()).snapshot;
        if (!input || !cp || cp.id !== request.inspection.sessionId || cp.target.tabId !== request.inspection.tabId || input.version !== request.inputVersion || cp.access?.status !== 'ready' || cp.autofill?.status === 'running' || cp.autofill?.status === 'cancelled') throw new ProviderFailure('stale');
        const context = selectContext(request.inspection, input, request.selections, request.roleExcerpt);
        // No evidence means an explicit local question, never a speculative paid request.
        if (context.fields.some((f) => !f.evidence.length)) throw new ProviderFailure('invalid_request');
        const result = await this.providers.propose(request.provider, context, controller.signal, async () => {
          const frozen = (await new ProfileStore(db).read()).snapshot, checkpoint = await new CheckpointStore(db).read();
          return frozen?.version === input.version && checkpoint?.id === cp.id && checkpoint.revision === cp.revision;
        });
        const latest = (await new ProfileStore(db).read()).snapshot, current = await new CheckpointStore(db).read();
        if (controller.signal.aborted || latest?.version !== input.version || current?.id !== cp.id || current.revision !== cp.revision) throw new ProviderFailure('stale');
        const review: ReviewBatch = { id: crypto.randomUUID(), binding: previewBinding(request.inspection, input), context, proposals: validateProposals({ scope: context.scope, revision: context.revision, proposals: result.proposals }, context), model: result.model, provider: request.provider };
        this.batch = { review, inspection: request.inspection, expiresAt: Math.min(input.expiresAt, Date.now() + 15 * 60_000) };
        return { batch: review, message: 'Review source facts and wording. Nothing has been inserted.' };
      } finally { if (this.pending === controller) this.pending = null; }
    }
    const saved = this.batch;
    if (!saved || request.batchId !== saved.review.id || saved.expiresAt <= Date.now() || new Set(request.decisions.map((d) => d.fieldId)).size !== request.decisions.length) throw new ProviderFailure('stale');
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
    if (values.length) await this.autofill.applyApproved(saved.inspection, saved.review.binding.inputVersion, values);
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
