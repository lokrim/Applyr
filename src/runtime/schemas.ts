import { z } from 'zod';
import type { SessionCheckpoint } from '../domain/session';

const integer = z.number().int().nonnegative();
const uuid = z.string().uuid();
export const TargetSchema = z.strictObject({
  tabId: integer,
  windowId: integer,
  origin: z.string().max(512).refine((value) => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; }
    catch { return false; }
  }).nullable(),
  availability: z.enum(['https', 'restricted', 'unavailable']),
}).refine((target) => (target.availability === 'https') === (target.origin !== null));

export const CheckpointSchema: z.ZodType<SessionCheckpoint> = z.strictObject({
  schemaVersion: z.literal(1),
  id: uuid,
  revision: integer,
  lifecycle: z.literal('QUEUED'),
  phase: z.literal('SETUP'),
  target: TargetSchema,
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
]);
export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    schemaVersion: z.literal(1), requestId: uuid, ok: z.literal(true), checkpoint: CheckpointSchema.nullable(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1), requestId: uuid.nullable(), ok: z.literal(false),
    code: z.enum(['FORBIDDEN', 'INVALID_MESSAGE', 'STALE_CHECKPOINT', 'TAB_UNAVAILABLE', 'STORAGE_UNAVAILABLE']),
  }),
]);
export type Response = z.infer<typeof ResponseSchema>;
