import { z } from 'zod';
import type { FormSnapshot } from './schema';
import { PreviewBindingSchema, ProposedValueSchema } from '../mapping/schema';

const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ActionResultSchema = z.strictObject({
  operationId: id, fieldId: id,
  status: z.enum(['accepted', 'rejected', 'unverified', 'skipped_user_change', 'unsupported']),
  code: z.enum(['persisted_valid', 'site_error', 'value_rejected', 'stale_control', 'user_change', 'manual_control', 'cancelled', 'unknown_effect', 'selected_only', 'upload_rejected', 'transfer_invalid']),
  selectedBytes: z.boolean().nullable(), siteAcceptance: z.enum(['not_applicable', 'unverified', 'rejected']),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
export const OperationSchema = z.strictObject({
  id, fieldId: id, kind: z.enum(['field', 'upload']), binding: PreviewBindingSchema,
  approvedDraft: z.boolean().optional(),
  recoverySignature: hash.optional(),
  recovery: z.union([ProposedValueSchema, z.strictObject({ kind: z.literal('file'), name: z.string().max(255), mime: z.string().max(128), size: z.number().int().positive(), lastModified: z.number().int().nonnegative(), digest: hash })]).optional(),
  precondition: hash, intentAt: z.number().int().nonnegative(), result: ActionResultSchema.nullable(),
});
export const AutofillSchema = z.strictObject({
  id, inputVersion: id, documentInput: z.strictObject({ id, inputVersion: id }).nullable().optional(), status: z.enum(['running', 'review', 'cancelled', 'interrupted', 'paused']),
  operations: z.array(OperationSchema).max(100),
  requiredUnresolved: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative(),
});
export type Autofill = z.infer<typeof AutofillSchema>;

const base = { operationId: id, runId: id, fieldId: id, binding: PreviewBindingSchema, precondition: hash };
export const ContentOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('write'), value: ProposedValueSchema, eligibilityApproved: z.boolean() }),
  z.strictObject({ ...base, type: z.literal('begin'), file: z.strictObject({ name: z.string().min(1).max(255), mime: z.string().max(128), size: z.number().int().positive().max(10 * 1024 * 1024), lastModified: z.number().int().nonnegative(), digest: hash }) }),
  z.strictObject({ ...base, type: z.literal('chunk'), offset: z.number().int().nonnegative(), bytes: z.array(z.number().int().min(0).max(255)).min(1).max(64 * 1024) }),
  z.strictObject({ ...base, type: z.literal('commit') }),
  z.strictObject({ ...base, type: z.literal('verify') }),
  z.strictObject({ ...base, type: z.literal('observe'), expected: OperationSchema.shape.recovery }),
  z.strictObject({ ...base, type: z.literal('cancel') }),
  z.strictObject({ ...base, type: z.literal('clear') }),
]);
export type ContentOperation = z.infer<typeof ContentOperationSchema>;

// Persist a digest of semantics, never a DOM reference or current page value.
export async function recoverySignature(field: FormSnapshot['fields'][number]) {
  const bytes = new TextEncoder().encode(JSON.stringify([field.id, field.label, field.labelSource, field.context, field.type, field.autocomplete, field.required, field.executable, field.category, field.filePurpose, field.constraints, field.options, field.radioGroup ? [field.radioGroup.primary, field.radioGroup.label] : null, ...(field.control ? [field.control] : [])]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
