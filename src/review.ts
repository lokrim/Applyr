import { z } from 'zod';
import type { SessionCheckpoint } from './domain/session';
import { reviewReady } from './domain/session';
import type { Inspection } from './forms/schema';
import { recoverySignature } from './forms/operations';
import { AttentionTargetSchema } from './attention/schema';
import { pending } from './attention/queue';

export const FieldReviewSchema = z.strictObject({
  at: z.number().int().nonnegative(),
  areas: z.array(z.strictObject({ frameId: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative() })).max(16),
  items: z.array(z.strictObject({
    fieldId: z.uuid(), label: z.string().max(240), required: z.boolean(), upload: z.boolean(), approvedDraft: z.boolean(),
    status: z.enum(['accepted', 'manual', 'rejected', 'unverified', 'unresolved']),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/), target: AttentionTargetSchema,
  })).max(400),
});
export type FieldReview = z.infer<typeof FieldReviewSchema>;
// Only observations and labels, never answer values, become temporary review data.
export async function observeReview(cp: SessionCheckpoint, inspection: Inspection): Promise<FieldReview> {
  const s = inspection.snapshot;
  const items: FieldReview['items'] = [];
  for (const f of s.fields) {
    if (f.radioGroup && f.radioGroup.primary !== f.id) continue;
    const op = cp.autofill?.operations.findLast((o) => o.fieldId === f.id && o.binding.document === s.document && o.binding.frameId === inspection.frameId);
    const old = cp.review?.items.find((i) => i.fieldId === f.id && i.target.document === s.document);
    const valid = s.status === 'stable' && (f.radioGroup?.present ?? f.current.present) && f.validation.valid !== false && !f.validation.ariaInvalid && !f.validation.errorPresent;
    const signature = await recoverySignature(f);
    const accepted = op?.result?.status === 'accepted' && op.result.code === 'persisted_valid' && op.recoverySignature === signature && op.kind === 'field' && valid && (!old || (cp.review!.at <= op.intentAt) || (old.status === 'accepted' && old.fingerprint === f.current.fingerprint));
    const status = f.type === 'file' ? (op?.result?.status === 'rejected' ? 'rejected' : op || f.current.present || f.required ? 'unverified' : 'unresolved')
      : accepted ? 'accepted' : valid ? 'manual' : op?.result?.status === 'rejected' ? 'rejected' : op ? 'unverified' : 'unresolved';
    items.push({ fieldId: f.id, label: (f.radioGroup?.label || f.label || 'Unlabelled field').slice(0, 240), required: f.required, upload: f.type === 'file', approvedDraft: accepted && !!op?.approvedDraft, status, fingerprint: f.current.fingerprint,
      target: { tabId: inspection.tabId, frameId: inspection.frameId, browserDocumentId: inspection.browserDocumentId, identity: s.identity, document: s.document, revision: s.revision, formId: s.selectedForm, fieldId: f.id, signature } });
  }
  return { at: Date.now(), areas: [...cp.review?.areas.filter((a) => a.frameId !== inspection.frameId) ?? [], { frameId: inspection.frameId, unsupported: s.unsupported.length + Number(s.status !== 'stable') }], items: [...cp.review?.items.filter((i) => i.target.frameId !== inspection.frameId) ?? [], ...items].slice(0, 400) };
}
export function reviewSummary(cp: SessionCheckpoint) {
  const rows = cp.review?.items ?? [];
  const blockers = cp.attention?.items.filter(pending) ?? [];
  // Legacy results remain visible, but never establish final readiness.
  const results = cp.autofill?.operations.filter((o, n, all) => all.findLastIndex((x) => x.fieldId === o.fieldId && x.binding.document === o.binding.document) === n) ?? [];
  return {
    accepted: cp.review ? rows.filter((i) => i.status === 'accepted').length : results.filter((o) => o.kind === 'field' && o.result?.status === 'accepted' && o.result.code === 'persisted_valid').length,
    manual: rows.filter((i) => i.status === 'manual').length,
    drafts: rows.filter((i) => i.status === 'accepted' && i.approvedDraft).length,
    required: cp.review ? rows.filter((i) => i.required && !['accepted', 'manual'].includes(i.status)).length : cp.autofill?.requiredUnresolved ?? new Set(blockers.filter((i) => i.required && i.target).map((i) => i.target!.fieldId)).size,
    uncertain: blockers.filter((i) => ['ambiguous', 'eligibility', 'draft'].includes(i.code)).length,
    uploads: cp.review ? rows.filter((i) => i.upload && ['rejected', 'unverified'].includes(i.status)).length : results.filter((o) => o.kind === 'upload').length,
    ready: reviewReady(cp),
  };
}
