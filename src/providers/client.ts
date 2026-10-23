import { browser } from 'wxt/browser';
import { ProviderFailure, ProviderRequestSchema, ProviderResponseSchema, type ProviderIntent } from './contracts';

export async function providerIntent(intent: ProviderIntent) {
  const request = ProviderRequestSchema.parse({ ...intent, channel: 'providers', schemaVersion: 1, requestId: crypto.randomUUID() });
  // Never propagate validation/raw transport errors, which can contain submitted secrets.
  try {
    const response = ProviderResponseSchema.parse(await browser.runtime.sendMessage(request));
    if (!response.ok) throw new ProviderFailure(response.code);
    if (response.requestId !== request.requestId || response.view.config.provider !== request.provider) throw new ProviderFailure('invalid_request');
    return response.view;
  } catch (e) { throw e instanceof ProviderFailure ? e : new ProviderFailure('invalid_request'); }
}
