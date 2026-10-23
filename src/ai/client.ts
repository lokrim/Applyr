import { browser } from 'wxt/browser';
import { AiRequestSchema, AiResponseSchema, type AiIntent } from './contracts';
import { ProviderFailure } from '../providers/contracts';
export async function aiIntent(intent: AiIntent) {
  const request = AiRequestSchema.parse({ ...intent, channel: 'ai', schemaVersion: 1, requestId: crypto.randomUUID() });
  try {
    const response = AiResponseSchema.parse(await browser.runtime.sendMessage(request));
    if (!response.ok) throw new ProviderFailure(response.code);
    if (response.requestId !== request.requestId) throw new ProviderFailure('invalid_request');
    return response;
  } catch (e) { throw e instanceof ProviderFailure ? e : new ProviderFailure('invalid_request'); }
}
