import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdapter, REQUEST_DEADLINE_MS } from '../../src/providers/adapters';
import { defaultConfig, errorText, ProviderRequestSchema, providers, type Provider } from '../../src/providers/contracts';
import { CLAUDE_VERSION, endpoints } from '../../src/providers/endpoints';
import { CANDIDATE_CANARY, CREDENTIAL_CANARY, jsonResponse, providerRefusal, providerSuccess, providerTruncation } from '../fixtures/providers';

const config = (p: Provider) => ({ ...defaultConfig(p), model: 'fixture-model' });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe.each(providers)('F11 %s native transport', (provider) => {
  it('probes structured capability with header-only key, bundled endpoint, stateless synthetic body and no candidate input', async () => {
    const transport = vi.fn(async () => jsonResponse(providerSuccess(provider)));
    const capability = await createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal);
    expect(capability).toMatchObject({ structuredOutput: true, model: 'fixture-model' });
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(endpoints[provider]); expect(url).not.toContain(CREDENTIAL_CANARY);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    const h = init.headers as Record<string, string>;
    expect(provider === 'gemini' ? h['x-goog-api-key'] : h.Authorization).toContain(CREDENTIAL_CANARY);
    if (provider === 'claude') expect(h['anthropic-version']).toBe(CLAUDE_VERSION);
    expect(init.body).not.toContain(CREDENTIAL_CANARY); expect(init.body).not.toContain(CANDIDATE_CANARY);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('fixture-model'); expect(body.tools).toBeUndefined();
    if (provider !== 'claude') expect(body.store).toBe(false);
    if (provider === 'openai') expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    if (provider === 'gemini') expect(body.response_format).toMatchObject({ type: 'text', mime_type: 'application/json' });
    if (provider === 'claude') expect(body.output_config.format.type).toBe('json_schema');
  });
  it.each([[401, 'auth'], [403, 'permission'], [404, 'model_unsupported'], [400, 'model_unsupported'], [422, 'model_unsupported']] as const)('normalizes %s without leaking raw bodies', async (status, code) => {
    const transport = vi.fn(async () => jsonResponse({ error: { message: CREDENTIAL_CANARY } }, status));
    const result = createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal);
    await expect(result).rejects.toMatchObject({ code, message: errorText[code] }); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not retry quota/billing errors', async () => {
    const transport = vi.fn(async () => jsonResponse({ error: { code: 'insufficient_quota', message: CREDENTIAL_CANARY } }, 429));
    await expect(createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal)).rejects.toMatchObject({ code: 'quota' }); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('honors Retry-After, retries transient 429/5xx at most twice, and preserves the provider/model', async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '1' })).mockResolvedValueOnce(jsonResponse({}, 503)).mockResolvedValueOnce(jsonResponse(providerSuccess(provider)));
    const result = createAdapter(provider, transport, { random: () => 0 }).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(999); expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); await expect(result).resolves.toMatchObject({ structuredOutput: true });
    expect(transport).toHaveBeenCalledTimes(3);
    for (const [url, init] of transport.mock.calls) { expect(url).toBe(endpoints[provider]); expect(JSON.parse(init.body).model).toBe('fixture-model'); }
  });
  it('limits retries and returns control when Retry-After exceeds the deadline', async () => {
    const transport = vi.fn(async () => jsonResponse({}, 429, { 'retry-after': '99999' }));
    await expect(createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal)).rejects.toMatchObject({ code: 'rate_limit' }); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('stops after three transient failures', async () => {
    vi.useFakeTimers(); const transport = vi.fn(async () => jsonResponse({}, 529));
    const check = expect(createAdapter(provider, transport, { random: () => 0 }).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal)).rejects.toMatchObject({ code: 'rate_limit' });
    await vi.advanceTimersByTimeAsync(1600); await check; expect(transport).toHaveBeenCalledTimes(3);
  });
  it('does not retry a network failure or expose its exception', async () => {
    const transport = vi.fn(async () => { throw new Error(CREDENTIAL_CANARY); });
    await expect(createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal)).rejects.toMatchObject({ code: 'network', message: errorText.network }); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('enforces the whole deadline on noncooperative transports without retry', async () => {
    vi.useFakeTimers(); const transport = vi.fn(() => new Promise<Response>(() => {}));
    const check = expect(createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS); await check; expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]).toBeDefined();
  });
  it('bounds stalled response-body reads as well as the initial fetch', async () => {
    vi.useFakeTimers(); const transport = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    const check = expect(createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS); await check;
  });
  it('aborts before dispatch, during fetch and during backoff', async () => {
    const transport = vi.fn(() => new Promise<Response>(() => {})), controller = new AbortController(); controller.abort();
    await expect(createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, controller.signal)).rejects.toMatchObject({ code: 'cancelled' }); expect(transport).not.toHaveBeenCalled();
    const second = new AbortController(), pending = createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, second.signal); second.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    const third = new AbortController(), transient = vi.fn(async () => jsonResponse({}, 429));
    const sleeping = createAdapter(provider, transient).testConnection(config(provider), CREDENTIAL_CANARY, third.signal);
    await new Promise((r) => setTimeout(r, 5)); third.abort(); await expect(sleeping).rejects.toMatchObject({ code: 'cancelled' }); expect(transient).toHaveBeenCalledTimes(1);
  });
  it.each(['refusal', 'truncation', 'malformed', 'injection', 'extra', 'oversize'] as const)('rejects %s with no automatic repair', async (kind) => {
    const value = kind === 'refusal' ? providerRefusal(provider) : kind === 'truncation' ? providerTruncation(provider) : providerSuccess(provider, kind === 'malformed' ? '```json\n{"ok":true}\n```' : kind === 'injection' ? `{"ok":true,"execute":"${CREDENTIAL_CANARY}"}` : kind === 'oversize' ? ' '.repeat(70_000) : '{"ok":true,"extra":1}');
    const transport = vi.fn(async () => jsonResponse(value));
    await expect(createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal)).rejects.toMatchObject({ code: kind === 'refusal' ? 'refusal' : 'invalid_output' }); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects redirect statuses, foreign final URLs and redirected responses', async () => {
    for (const mode of ['status', 'foreign', 'redirected']) {
      const response = mode === 'status' ? new Response(null, { status: 307 }) : jsonResponse(providerSuccess(provider));
      if (mode === 'foreign') Object.defineProperty(response, 'url', { value: 'https://evil.invalid/collect' });
      if (mode === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
      await expect(createAdapter(provider, async () => response).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal)).rejects.toMatchObject({ code: 'permission' });
    }
  });
  it('rejects empty keys/model IDs, injected header values and mismatched adapter config before fetch', async () => {
    const transport = vi.fn();
    for (const [c, key] of [[config(provider), ''], [{ ...config(provider), model: '' }, CREDENTIAL_CANARY], [{ ...config(provider), workspace: 'bad\r\nkey' }, CREDENTIAL_CANARY], [config(provider), 'key\r\nheader'], [{ ...config(provider), model: CREDENTIAL_CANARY }, CREDENTIAL_CANARY]] as const) {
      await expect(createAdapter(provider, transport).testConnection(c, key, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(transport).not.toHaveBeenCalled();
  });
});
it('selects Claude workspace only when explicitly supplied; missing/wrong workspaces remain normalized permission errors', async () => {
  const transport = vi.fn(async () => jsonResponse(providerSuccess('claude')));
  await createAdapter('claude', transport).testConnection({ ...config('claude'), workspace: 'wrkspc_fixture' }, CREDENTIAL_CANARY, new AbortController().signal);
  expect((transport.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'anthropic-workspace-id': 'wrkspc_fixture', 'anthropic-version': CLAUDE_VERSION });
});
it('denies credential reads, arbitrary endpoints, candidate tasks and extra payloads in provider messages', () => {
  const base = { channel: 'providers', schemaVersion: 1, requestId: crypto.randomUUID(), provider: 'openai' };
  for (const value of [{ ...base, type: 'GET_KEY' }, { ...base, type: 'TEST', revision: 0, profile: CANDIDATE_CANARY }, { ...base, type: 'TEST', revision: 0, endpoint: 'https://evil.invalid' }, { ...base, type: 'DRAFT', revision: 0 }, { ...base, type: 'STATUS', key: CREDENTIAL_CANARY }]) expect(ProviderRequestSchema.safeParse(value).success).toBe(false);
});
it('normalizes native Gemini invalid-key 400 and Claude workspace/credit 400 failures without retry', async () => {
  for (const [provider, error, code] of [
    ['gemini', { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }], message: CREDENTIAL_CANARY }, 'auth'],
    ['gemini', { message: 'API key not valid. Please pass a valid API key.' }, 'auth'],
    ['claude', { type: 'invalid_request_error', message: 'anthropic-workspace-id header is required' }, 'permission'],
    ['claude', { type: 'invalid_request_error', message: 'Workspace does not match the key' }, 'permission'],
    ['claude', { type: 'invalid_request_error', message: 'Your credit balance is too low' }, 'quota'],
  ] as const) {
    const transport = vi.fn(async () => jsonResponse({ error }, 400));
    await expect(createAdapter(provider, transport).testConnection(config(provider), CREDENTIAL_CANARY, new AbortController().signal)).rejects.toMatchObject({ code });
    expect(transport).toHaveBeenCalledOnce();
  }
});
