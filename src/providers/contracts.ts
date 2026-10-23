import { z } from 'zod';

export const ProviderSchema = z.enum(['openai', 'gemini', 'claude']);
export type Provider = z.infer<typeof ProviderSchema>;
export const providers = ProviderSchema.options;
// These are identifiers, never URLs or arbitrary header values.
const ModelSchema = z.string().max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$|^$/);
export const KeySchema = z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/);
export const ConfigSchema = z.strictObject({
  schemaVersion: z.literal(1), provider: ProviderSchema, revision: z.number().int().nonnegative(),
  model: ModelSchema, workspace: z.string().max(100).regex(/^[a-zA-Z0-9_-]*$/),
  remember: z.boolean(), candidateConsent: z.boolean(), paidServiceConfirmed: z.boolean(),
}).refine((c) => c.provider === 'claude' || c.workspace === '')
  .refine((c) => c.provider !== 'gemini' || !c.candidateConsent || c.paidServiceConfirmed);
export type ProviderConfig = z.infer<typeof ConfigSchema>;
export function defaultConfig(provider: Provider): ProviderConfig {
  return { schemaVersion: 1, provider, revision: 0, model: '', workspace: '', remember: false, candidateConsent: false, paidServiceConfirmed: false };
}
export const ErrorCodeSchema = z.enum(['auth', 'permission', 'model_unsupported', 'quota', 'rate_limit', 'network', 'timeout', 'refusal', 'invalid_output', 'cancelled', 'storage', 'stale', 'busy', 'invalid_request']);
export type ProviderErrorCode = z.infer<typeof ErrorCodeSchema>;
export const errorText: Record<ProviderErrorCode, string> = {
  auth: 'Key missing, expired or rejected. Check the key in your provider account.',
  permission: 'Access denied. Check the exact provider host grant, key restrictions and Claude workspace ID where required.',
  model_unsupported: 'This model or structured schema is unavailable. Check the model ID and test again.',
  quota: 'Provider quota or billing limit reached. Check your provider account.',
  rate_limit: 'Provider is busy or rate limited. Try again when ready.',
  network: 'Connection failed or browser restrictions blocked it. The request may have been billed; retry only when ready.',
  timeout: 'Request timed out. It may already have been billed. Retry only when ready.',
  refusal: 'The provider refused the task. No repair request was sent.',
  invalid_output: 'The provider returned incomplete or invalid structured output. No repair request was sent.',
  cancelled: 'Request stopped locally. Already delivered requests may still be processed or billed.',
  storage: 'Credential storage is unavailable. No verified connection is available. Retry removal if deletion failed.',
  stale: 'Settings changed in another view. Reload the provider settings before saving.',
  busy: 'A request is already running for this provider.',
  invalid_request: 'Unsupported provider settings request.',
};
export class ProviderFailure extends Error {
  constructor(readonly code: ProviderErrorCode) { super(errorText[code]); }
}
export const CapabilitySchema = z.strictObject({ structuredOutput: z.literal(true), model: ModelSchema, testedAt: z.number().nonnegative() });
export type Capability = z.infer<typeof CapabilitySchema>;
export const StatusSchema = z.strictObject({
  state: z.enum(['unverified', 'testing', 'verified', 'error']),
  code: ErrorCodeSchema.nullable(), capability: CapabilitySchema.nullable(),
});
export type ProviderStatus = z.infer<typeof StatusSchema>;
export const ViewSchema = z.strictObject({ config: ConfigSchema, hasKey: z.boolean(), status: StatusSchema });
export type ProviderView = z.infer<typeof ViewSchema>;
const envelope = { channel: z.literal('providers'), schemaVersion: z.literal(1), requestId: z.uuid(), provider: ProviderSchema };
export const ProviderRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('STATUS') }),
  z.strictObject({ ...envelope, type: z.literal('SAVE'), config: ConfigSchema, key: KeySchema.optional() }),
  z.strictObject({ ...envelope, type: z.enum(['TEST', 'REMOVE_KEY', 'REVOKE_CONSENT', 'CANCEL']), revision: z.number().int().nonnegative() }),
]);
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
export type ProviderIntent = ProviderRequest extends infer R ? R extends ProviderRequest ? Omit<R, 'channel' | 'schemaVersion' | 'requestId'> : never : never;
export const ProviderResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), requestId: z.uuid(), view: ViewSchema }),
  z.strictObject({ ok: z.literal(false), requestId: z.uuid().nullable(), code: ErrorCodeSchema }),
]);
export const unverified = (): ProviderStatus => ({ state: 'unverified', code: null, capability: null });
