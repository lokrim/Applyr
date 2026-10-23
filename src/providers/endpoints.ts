import type { Provider } from './contracts';

// Verified against official docs, 2026-10-23. See planning/evidence/prompt-08/sources.md.
export const endpoints: Readonly<Record<Provider, string>> = Object.freeze({
  openai: 'https://api.openai.com/v1/responses',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/interactions',
  claude: 'https://api.anthropic.com/v1/messages',
});
export const CLAUDE_VERSION = '2026-10-21';
export function providerOrigin(provider: Provider) { return new URL(endpoints[provider]).origin; }
export function providerPattern(provider: Provider) { return `${providerOrigin(provider)}/*`; }
