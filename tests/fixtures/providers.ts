import type { Provider } from '../../src/providers/contracts';

// F11: synthetic transport bodies only; never contact a provider.
export const CREDENTIAL_CANARY = 'F11_SYNTHETIC_CREDENTIAL_CANARY_84';
export const CANDIDATE_CANARY = 'F11_CANDIDATE_NEVER_SEND_73';
export function providerSuccess(provider: Provider, text = '{"ok":true}'): unknown {
  if (provider === 'openai') return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] };
  if (provider === 'gemini') return { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] };
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
}
export function providerRefusal(provider: Provider): unknown {
  if (provider === 'openai') return { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: CREDENTIAL_CANARY }] }] };
  if (provider === 'gemini') return { status: 'failed', errors: [{ code: 'safety_blocked', message: CREDENTIAL_CANARY }] };
  return { stop_reason: 'refusal', content: [{ type: 'text', text: CREDENTIAL_CANARY }] };
}
export function providerTruncation(provider: Provider): unknown {
  return provider === 'claude' ? { stop_reason: 'max_tokens', content: [] } : { status: 'incomplete' };
}
export function jsonResponse(value: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
