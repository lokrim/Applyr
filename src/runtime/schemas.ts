import { z } from 'zod';
import type { SessionCheckpoint } from '../domain/session';
import { parseApplicationUrl, sanitizedUrl } from '../browser/addresses';

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
  classification: z.enum(['application', 'listing', 'login_challenge', 'irrelevant', 'restricted', 'uncertain']),
  identity: z.string().regex(/^[a-f0-9]{64}$/), role: z.string().max(180).nullable(), company: z.string().max(180).nullable(), frames: z.array(FrameSchema).max(4),
});
export const AccessSchema = z.strictObject({
  status: z.enum(['unprobed', 'ready', 'needs_attention']),
  classification: ProbeSchema.shape.classification,
  reason: z.enum(['unprobed', 'application', 'listing', 'login_challenge', 'irrelevant', 'uncertain', 'restricted', 'permission', 'frame_permission', 'frame_unavailable', 'closed', 'navigation', 'reload', 'restart']),
  frames: z.array(FrameSchema).max(4), documentId: z.string().max(180).optional(), inspectedAt: integer.optional(),
});

export const CheckpointSchema: z.ZodType<SessionCheckpoint> = z.strictObject({
  schemaVersion: z.literal(1),
  id: uuid,
  revision: integer,
  lifecycle: z.enum(['QUEUED', 'NEEDS_ATTENTION']),
  phase: z.literal('SETUP'),
  target: TargetSchema,
  access: AccessSchema.optional(),
  createdAt: integer,
  updatedAt: integer,
  expiresAt: integer,
  submission: z.strictObject({ status: z.literal('unknown') }),
}).refine((record) => record.createdAt <= record.updatedAt && record.updatedAt < record.expiresAt);

const envelope = { schemaVersion: z.literal(1), requestId: uuid };
const binding = { sessionId: uuid.nullable(), revision: integer.nullable() };
export const RequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('GET_STATE'), sessionId: z.null(), revision: z.null() }),
  z.strictObject({ ...envelope, ...binding, type: z.literal('CAPTURE_TARGET'), tabId: integer }),
  z.strictObject({ ...envelope, type: z.literal('FORGET_CHECKPOINT'), sessionId: uuid, revision: integer }),
  z.strictObject({ ...envelope, type: z.literal('PROBE_TARGET'), sessionId: uuid, revision: integer, frameOrigin: origin.optional(), frameIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional() })
    .refine((r) => (r.frameOrigin === undefined) === (r.frameIdentity === undefined)),
  z.strictObject({ ...envelope, type: z.literal('EDIT_TARGET'), sessionId: uuid, revision: integer, role: z.string().max(180), company: z.string().max(180) }),
  z.strictObject({ ...envelope, ...binding, type: z.literal('OPEN_APPLICATION'), url: z.string().max(4096) }),
]);
export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    schemaVersion: z.literal(1), requestId: uuid, ok: z.literal(true), checkpoint: CheckpointSchema.nullable(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1), requestId: uuid.nullable(), ok: z.literal(false),
    code: z.enum(['FORBIDDEN', 'INVALID_MESSAGE', 'STALE_CHECKPOINT', 'TAB_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'INVALID_URL', 'ACCESS_UNAVAILABLE']),
  }),
]);
export type Response = z.infer<typeof ResponseSchema>;
