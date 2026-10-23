import { z } from 'zod';

const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PreviewBindingSchema = z.strictObject({
  sessionId: id, tabId: z.number().int().nonnegative(), frameId: z.number().int().nonnegative(),
  browserDocumentId: z.string().max(240).nullable(), identity: hash, document: id,
  revision: z.number().int().positive(), inputVersion: id,
});
export const ProposedValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().min(1).max(2048) }),
  z.strictObject({ kind: z.literal('choice'), label: z.string().max(240), optionFingerprint: hash }),
  z.strictObject({ kind: z.literal('checked'), checked: z.boolean(), optionFingerprint: hash }),
]);
export const FieldProposalSchema = z.strictObject({
  schemaVersion: z.literal(1), fieldId: id, binding: PreviewBindingSchema,
  source: z.strictObject({ kind: z.enum(['saved', 'replacement', 'session']), path: z.string().max(240), inputVersion: id, reviewedOn: z.string().max(10).nullable() }),
  value: ProposedValueSchema, explanation: z.string().max(600),
  precondition: z.strictObject({ currentFingerprint: hash, mustBeEmpty: z.literal(true), reinspectionRequired: z.literal(true) }),
  approval: z.enum(['ordinary', 'session_confirmation', 'session_approved']),
  submission: z.literal('manual_only'),
});
export const SessionCorrectionSchema = z.strictObject({
  binding: PreviewBindingSchema, fieldId: id, currentFingerprint: hash,
  value: z.union([z.string().min(1).max(2048), z.boolean(), z.number().finite().nonnegative()]),
  eligibilityConfirmed: z.boolean(),
});
export type PreviewBinding = z.infer<typeof PreviewBindingSchema>;
export type FieldProposal = z.infer<typeof FieldProposalSchema>;
export type SessionCorrection = z.infer<typeof SessionCorrectionSchema>;
export type ProposedValue = z.infer<typeof ProposedValueSchema>;
export type FieldState = 'proposed' | 'skipped' | 'missing' | 'review' | 'unsupported';
export interface PreviewItem {
  fieldId: string; label: string; required: boolean; state: FieldState; reason: string;
  sourcePath: string | null; eligibility: boolean; proposal?: FieldProposal;
  correctable: boolean; inputKind: 'boolean' | 'number' | 'text';
}
export interface DryRun {
  binding: PreviewBinding; items: PreviewItem[];
  counts: Record<FieldState, number> & { inspected: number; unsupportedAreas: number; requiredUnresolved: number };
}
