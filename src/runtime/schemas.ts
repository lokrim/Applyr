import { z } from 'zod';
import { ErrorCodeSchema } from '../providers/contracts';
import { FieldReviewSchema } from '../review';
import { AttentionSchema, AttentionAnswerSchema } from '../attention/schema';
import type { SessionCheckpoint } from '../domain/session';
import { parseApplicationUrl, sanitizedUrl } from '../browser/addresses';
import { InspectionSchema, SelectionSchema } from '../forms/schema';
import { AutofillSchema } from '../forms/operations';
import { SessionCorrectionSchema } from '../mapping/schema';

const integer = z.number().int().nonnegative();
const uuid = z.string().uuid();
const origin = z.string().max(512).refine((value) => {
  try { return parseApplicationUrl(value, true).origin === value; } catch { return false; }
});
export const TargetSchema = z.strictObject({
  tabId: integer,
  windowId: integer,
  origin: origin.nullable(),
  availability: z.enum(['https', 'loopback', 'restricted', 'unavailable']),
  url: z.string().max(4096).refine((v) => { try { return sanitizedUrl(parseApplicationUrl(v, true)) === v; } catch { return false; } }).nullable().optional(),
  title: z.string().max(180).nullable().optional(), role: z.string().max(180).nullable().optional(), company: z.string().max(180).nullable().optional(),
  identity: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine((target) => (target.availability === 'https' || target.availability === 'loopback') === (target.origin !== null))
  .refine((target) => !target.origin || (target.availability === 'https' ? target.origin.startsWith('https:') : target.origin.startsWith('http:')))
  .refine((target) => { try { return !target.url || new URL(target.url).origin === target.origin; } catch { return false; } });

export const FrameSchema = z.strictObject({ url: z.string().max(4096), origin, identity: z.string().regex(/^[a-f0-9]{64}$/) }).refine((frame) => {
  try { const url = parseApplicationUrl(frame.url, true); return url.origin === frame.origin && sanitizedUrl(url) === frame.url; } catch { return false; }
});
export const ProbeSchema = z.strictObject({
  challenge: z.enum(['login', 'otp', 'captcha', 'authentication']).optional(),
  classification: z.enum(['application', 'listing', 'login_challenge', 'irrelevant', 'restricted', 'uncertain']),
  identity: z.string().regex(/^[a-f0-9]{64}$/), role: z.string().max(180).nullable(), company: z.string().max(180).nullable(), frames: z.array(FrameSchema).max(4),
});
export const AccessSchema = z.strictObject({
  status: z.enum(['unprobed', 'ready', 'needs_attention']),
  classification: ProbeSchema.shape.classification, challenge: ProbeSchema.shape.challenge,
  reason: z.enum(['unprobed', 'application', 'listing', 'login_challenge', 'irrelevant', 'uncertain', 'restricted', 'permission', 'frame_permission', 'frame_unavailable', 'closed', 'navigation', 'reload', 'restart']),
  frames: z.array(FrameSchema).max(4), documentId: z.string().max(180).optional(), inspectedAt: integer.optional(),
});

export const CheckpointSchema: z.ZodType<SessionCheckpoint> = z.strictObject({
  schemaVersion: z.literal(1),
  id: uuid,
  revision: integer,
  lifecycle: z.enum(['QUEUED', 'RUNNING', 'NEEDS_ATTENTION', 'PAUSED', 'READY_FOR_REVIEW', 'AUTOFILL_FINISHED', 'CANCELLED', 'FAILED']),
  phase: z.enum(['SETUP', 'INSPECTING', 'PREPARING', 'FILLING', 'VALIDATING']),
  target: TargetSchema,
  access: AccessSchema.optional(),
  createdAt: integer,
  updatedAt: integer,
  expiresAt: integer, lastActivityAt: integer.optional(),
  submission: z.strictObject({ status: z.enum(['unknown', 'reported_by_user']), reportedAt: integer.optional(), source: z.literal('user').optional() }).refine((s) => s.status === 'reported_by_user' ? s.reportedAt !== undefined && s.source === 'user' : s.reportedAt === undefined && s.source === undefined),
  reviewScope: z.enum(['current_step', 'final_review']).optional(), pauseRequested: z.boolean().optional(),
  recovery: z.strictObject({ reason: z.string().max(80), inspectionRequired: z.boolean(), reattachRequired: z.boolean() }).optional(),
  lease: z.strictObject({ owner: uuid, token: uuid, application: z.string().max(4096), expiresAt: integer }).optional(),
  aiRequest: z.strictObject({ id: uuid, status: z.enum(['pending', 'completed', 'uncertain']), inputVersion: uuid }).optional(),
  providerRequests: z.array(z.strictObject({ id: uuid, status: z.enum(['pending', 'completed', 'uncertain']), inputVersion: uuid })).max(100).optional(),
  approval: z.strictObject({ batchId: uuid, inputVersion: uuid, document: uuid, revision: integer, at: integer, decisions: z.array(z.strictObject({ fieldId: uuid, action: z.enum(['approve', 'reject']), text: z.string().max(2048) })).max(8) }).optional(),
  review: FieldReviewSchema.optional(), providerError: ErrorCodeSchema.optional(), providers: z.array(z.strictObject({ provider: z.enum(['openai', 'claude', 'gemini']), model: z.string().max(160) })).max(100).optional(),
  autofill: AutofillSchema.optional(), attention: AttentionSchema.optional(),
}).refine((record) => record.createdAt <= record.updatedAt && record.updatedAt < record.expiresAt && (record.lastActivityAt === undefined || (record.lastActivityAt <= record.updatedAt && record.expiresAt - record.lastActivityAt <= 7 * 24 * 60 * 60 * 1000)) && (record.lifecycle !== 'RUNNING' || record.phase !== 'SETUP'));

const envelope = { schemaVersion: z.literal(1), requestId: uuid };
const binding = { sessionId: uuid.nullable(), revision: integer.nullable() };
export const RequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('ATTENTION_ANSWERS'), sessionId: uuid, revision: integer, answers: z.array(AttentionAnswerSchema).min(1).max(100) }),
  z.strictObject({ ...envelope, type: z.literal('REINSPECT_ATTENTION'), sessionId: uuid, revision: integer, itemId: uuid.optional() }),
  z.strictObject({ ...envelope, type: z.literal('SHOW_ATTENTION'), sessionId: uuid, revision: integer, itemId: uuid.optional() }),
  z.strictObject({ ...envelope, type: z.literal('PAUSE_SESSION'), sessionId: uuid, revision: integer }),
  z.strictObject({ ...envelope, type: z.literal('RESUME_SESSION'), sessionId: uuid, revision: integer }),
  z.strictObject({ ...envelope, type: z.literal('CANCEL_SESSION'), sessionId: uuid, revision: integer }),
  z.strictObject({ ...envelope, type: z.literal('FINISH_SESSION'), sessionId: uuid, revision: integer }),
  z.strictObject({ ...envelope, type: z.literal('REPORT_SUBMISSION'), sessionId: uuid, revision: integer }),
  z.strictObject({ ...envelope, type: z.literal('FINAL_REVIEW'), sessionId: uuid, revision: integer }),

  z.strictObject({ ...envelope, type: z.literal('REATTACH_SESSION'), sessionId: uuid, revision: integer, tabId: integer }),
  z.strictObject({ ...envelope, type: z.literal('RESTORE_SESSION'), sessionId: uuid.nullable(), revision: integer.nullable(), archivedId: uuid }),
  z.strictObject({ ...envelope, type: z.literal('START_AUTOFILL'), sessionId: uuid, revision: integer, runId: uuid, inspection: InspectionSchema, inputVersion: uuid, corrections: z.array(SessionCorrectionSchema).max(100), resume: z.strictObject({ id: uuid, inputVersion: uuid }).nullable() }),
  z.strictObject({ ...envelope, type: z.literal('CANCEL_AUTOFILL'), sessionId: uuid, revision: integer, runId: uuid }),
  z.strictObject({ ...envelope, type: z.literal('DELETE_DATA'), sessionId: uuid.nullable(), revision: integer.nullable(), scope: z.enum(['profile', 'history', 'all']) }),
  z.strictObject({ ...envelope, type: z.literal('SHOW_REVIEW'), sessionId: uuid, revision: integer, fieldId: uuid }),
  z.strictObject({ ...envelope, type: z.literal('GET_STATE'), sessionId: z.null(), revision: z.null() }),
  z.strictObject({ ...envelope, ...binding, type: z.literal('CAPTURE_TARGET'), tabId: integer, separateRun: z.literal(true).optional() }),
  z.strictObject({ ...envelope, type: z.literal('FORGET_CHECKPOINT'), sessionId: uuid, revision: integer }),
  z.strictObject({ ...envelope, type: z.literal('PROBE_TARGET'), sessionId: uuid, revision: integer, frameOrigin: origin.optional(), frameIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional() })
    .refine((r) => (r.frameOrigin === undefined) === (r.frameIdentity === undefined)),
  z.strictObject({ ...envelope, type: z.literal('EDIT_TARGET'), sessionId: uuid, revision: integer, role: z.string().max(180), company: z.string().max(180) }),
  z.strictObject({ ...envelope, type: z.literal('INSPECT_FORM'), sessionId: uuid, revision: integer, frameOrigin: origin.optional(), frameIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional(), selection: SelectionSchema.optional() })
    .refine((r) => (r.frameOrigin === undefined) === (r.frameIdentity === undefined)),
  z.strictObject({ ...envelope, ...binding, type: z.literal('OPEN_APPLICATION'), url: z.string().max(4096), separateRun: z.literal(true).optional() }),
]);
export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    schemaVersion: z.literal(1), requestId: uuid, ok: z.literal(true), checkpoint: CheckpointSchema.nullable(), inspection: InspectionSchema.optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1), requestId: uuid.nullable(), ok: z.literal(false),
    code: z.enum(['FORBIDDEN', 'INVALID_MESSAGE', 'STALE_CHECKPOINT', 'TAB_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'INVALID_URL', 'ACCESS_UNAVAILABLE', 'DUPLICATE_APPLICATION']),
  }),
]);
export type Response = z.infer<typeof ResponseSchema>;
