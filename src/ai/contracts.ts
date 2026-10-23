import { z } from 'zod';
import { InspectionSchema } from '../forms/schema';
import { PreviewBindingSchema } from '../mapping/schema';
import { ErrorCodeSchema, ProviderSchema } from '../providers/contracts';

export const TaskSelectionSchema = z.strictObject({ fieldId: z.uuid(), kind: z.enum(['mapping', 'prose']), evidenceRefs: z.array(z.string().max(240)).max(6), maxWords: z.number().int().positive().max(500).nullable() });
export type TaskSelection = z.infer<typeof TaskSelectionSchema>;
export const ContextSchema = z.strictObject({
  scope: z.uuid(), revision: z.number().int().positive(),
  fields: z.array(z.strictObject({ id: z.uuid(), kind: z.enum(['mapping', 'prose']), question: z.string().max(480), type: z.string().max(20), maxChars: z.number().int().positive().max(2048), maxWords: z.number().int().positive().max(500).nullable(),
    options: z.array(z.strictObject({ id: z.string().max(64), label: z.string().max(240) })).max(30),
    evidence: z.array(z.strictObject({ ref: z.string().max(240), text: z.string().max(600) })).max(6), roleExcerpt: z.string().max(1000),
  })).min(1).max(8),
});
export type TaskContext = z.infer<typeof ContextSchema>;
export const ProposalSchema = z.strictObject({
  fieldId: z.uuid(), status: z.enum(['proposed', 'unknown', 'needs_user_input']), operation: z.enum(['map_fact', 'draft_answer', 'none']),
  factRefs: z.array(z.string().max(240)).max(6), optionId: z.string().max(64), text: z.string().max(2048),
});
export const ProposalBatchSchema = z.strictObject({ scope: z.uuid(), revision: z.number().int().positive(), proposals: z.array(ProposalSchema).min(1).max(8) });
export type Proposal = z.infer<typeof ProposalSchema>;
export const BatchSchema = z.strictObject({ id: z.uuid(), binding: PreviewBindingSchema, context: ContextSchema, proposals: z.array(ProposalSchema).max(8), model: z.string().max(160), provider: ProviderSchema });
export type ReviewBatch = z.infer<typeof BatchSchema>;
const envelope = { channel: z.literal('ai'), schemaVersion: z.literal(1), requestId: z.uuid() };
export const AiRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('PREPARE'), provider: ProviderSchema, inspection: InspectionSchema, inputVersion: z.uuid(), selections: z.array(TaskSelectionSchema).min(1).max(8), roleExcerpt: z.string().max(1000) }),
  z.strictObject({ ...envelope, type: z.literal('DECIDE'), batchId: z.uuid(), decisions: z.array(z.strictObject({ fieldId: z.uuid(), action: z.enum(['approve', 'reject']), text: z.string().max(2048), factsReviewed: z.boolean(), factRef: z.string().max(240).optional(), optionId: z.string().max(64).optional() })).min(1).max(8) }),
  z.strictObject({ ...envelope, type: z.literal('DISCARD') }),
]);
export type AiRequest = z.infer<typeof AiRequestSchema>;
export type AiIntent = AiRequest extends infer R ? R extends AiRequest ? Omit<R, 'channel' | 'schemaVersion' | 'requestId'> : never : never;
export const AiResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), requestId: z.uuid(), batch: BatchSchema.nullable(), message: z.string().max(240) }),
  z.strictObject({ ok: z.literal(false), requestId: z.uuid().nullable(), code: ErrorCodeSchema }),
]);
