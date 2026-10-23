import { z } from 'zod';

const text = z.string().max(240);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
export const SelectionSchema = z.strictObject({ formId: id, document: id, revision: z.number().int().positive() });
export const FormSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: hash, document: id, revision: z.number().int().positive(),
  status: z.enum(['stable', 'unstable', 'selection_required', 'stale_selection']),
  selectedForm: id.nullable(),
  forms: z.array(z.strictObject({ id, label: text, fieldCount: z.number().int().nonnegative() })).max(20),
  fields: z.array(z.strictObject({
    id, label: text, labelSource: z.enum(['label', 'aria', 'placeholder', 'missing']),
    context: z.array(text).max(5), type: z.enum(['text', 'email', 'tel', 'url', 'date', 'month', 'number', 'select', 'textarea', 'radio', 'checkbox', 'file']), autocomplete: text,
    required: z.boolean(), executable: z.boolean(),
    category: z.enum(['short_answer', 'long_answer', 'choice', 'preference', 'declaration', 'sensitive', 'file', 'missing_semantics']),
    filePurpose: z.enum(['resume', 'cover_letter', 'portfolio', 'transcript', 'unknown']).nullable(),
    constraints: z.strictObject({ min: text, max: text, step: text, minLength: text, maxLength: text, pattern: text, accept: text, multiple: z.boolean() }),
    options: z.array(z.strictObject({ label: text, fingerprint: hash, disabled: z.boolean() })).max(100),
    current: z.strictObject({ fingerprint: hash, present: z.boolean() }),
    validation: z.strictObject({ valid: z.boolean().nullable(), flags: z.array(z.enum(['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'])).max(10), ariaInvalid: z.boolean(), errorPresent: z.boolean() }),
  })).max(100),
  unsupported: z.array(z.strictObject({ code: z.enum(['no_relevant_form', 'frame_requires_inspection', 'opaque_custom_element', 'custom_control', 'canvas', 'rich_text', 'locked_control', 'limit', 'authentication']), label: text })).max(100),
  observation: z.strictObject({ mutations: z.number().int().nonnegative(), scans: z.number().int().nonnegative(), bounded: z.literal(true) }),
}).refine((snapshot) => {
  const formIds = new Set(snapshot.forms.map((form) => form.id));
  return formIds.size === snapshot.forms.length && new Set(snapshot.fields.map((field) => field.id)).size === snapshot.fields.length &&
    (snapshot.selectedForm === null ? snapshot.fields.length === 0 : formIds.has(snapshot.selectedForm)) &&
    snapshot.fields.every((field) => !field.executable || (!['declaration', 'sensitive', 'missing_semantics'].includes(field.category) && (field.type !== 'file' || field.filePurpose === 'resume')));
}, 'Inconsistent form snapshot');
export type FormSnapshot = z.infer<typeof FormSnapshotSchema>;
export type FormSelection = z.infer<typeof SelectionSchema>;
export const InspectionSchema = z.strictObject({ sessionId: id, tabId: z.number().int().nonnegative(), frameId: z.number().int().nonnegative(), browserDocumentId: text.nullable(), snapshot: FormSnapshotSchema });
export type Inspection = z.infer<typeof InspectionSchema>;
