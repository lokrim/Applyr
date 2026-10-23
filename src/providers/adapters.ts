import { z } from 'zod';
import { ConfigSchema, KeySchema, ProviderFailure, type Capability, type Provider, type ProviderConfig } from './contracts';
import { CLAUDE_VERSION, endpoints } from './endpoints';
import { ContextSchema, type TaskContext, type Proposal } from '../ai/contracts';
import { AI_INSTRUCTIONS, outputSchema, validateProposals } from '../ai/validation';

export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export const REQUEST_DEADLINE_MS = 25_000;
const MAX_RESPONSE_BYTES = 65_536;
const PROBE = 'Synthetic connection test. Return only JSON with the property ok set to true. No candidate information is included.';
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const ProbeSchema = z.strictObject({ ok: z.literal(true) });
export interface ProviderAdapter {
  readonly provider: Provider;
  propose(config: ProviderConfig, key: string, signal: AbortSignal, context: TaskContext): Promise<Proposal[]>;
  testConnection(config: ProviderConfig, key: string, signal: AbortSignal): Promise<Capability>;
}
const record = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

function body(provider: Provider, model: string, context?: TaskContext): unknown {
  const input = context ? `${AI_INSTRUCTIONS}\nTask data: ${JSON.stringify(context)}` : PROBE;
  const formatSchema = context ? outputSchema(context) : schema;
  const tokens = context ? 6000 : 256;
  if (provider === 'openai') return { model, input, store: false, max_output_tokens: tokens, text: { format: { type: 'json_schema', name: context ? 'review_proposals' : 'connection_probe', strict: true, schema: formatSchema } } };
  if (provider === 'gemini') return { model, input, store: false, stream: false, background: false, generation_config: { max_output_tokens: tokens }, response_format: { type: 'text', mime_type: 'application/json', schema: formatSchema } };
  return { model, max_tokens: tokens, messages: [{ role: 'user', content: input }], output_config: { format: { type: 'json_schema', schema: formatSchema } } };
}
function headers(provider: Provider, key: string, workspace: string): Record<string, string> {
  if (provider === 'gemini') return { 'content-type': 'application/json', 'x-goog-api-key': key };
  return { 'content-type': 'application/json', Authorization: `Bearer ${key}`, ...(provider === 'claude' ? { 'anthropic-version': CLAUDE_VERSION, ...(workspace ? { 'anthropic-workspace-id': workspace } : {}) } : {}) };
}
function httpFailure(status: number, raw: unknown): ProviderFailure {
  const e = record(record(raw).error);
  // Inspect bounded data only to classify. Never return/log messages, headers, IDs or bodies.
  const markers = `${String(e.code ?? '')} ${String(e.type ?? '')} ${String(e.status ?? '')} ${String(e.message ?? '')} ${array(e.details).map((d) => String(record(d).reason ?? '')).join(' ')}`.toLowerCase();
  if (status === 401 || /api_key_invalid|api_key_expired|invalid_api_key|api key not valid|api key expired|unauthenticated/.test(markers)) return new ProviderFailure('auth');
  if (status === 403) return new ProviderFailure('permission');
  if (/anthropic-workspace-id|workspace.*(required|missing|invalid|match|access)/.test(markers)) return new ProviderFailure('permission');
  if (/insufficient_quota|billing|credit balance|quota.exhaust|quota.exceed|daily.*limit/.test(markers)) return new ProviderFailure('quota');
  if (status === 404 || status === 400 || status === 422) return new ProviderFailure('model_unsupported');
  if (status === 429 || status >= 500) return new ProviderFailure('rate_limit');
  return new ProviderFailure('network');
}
function output(provider: Provider, raw: unknown): string {
  const r = record(raw);
  if (provider === 'claude') {
    if (r.stop_reason === 'refusal') throw new ProviderFailure('refusal');
    if (r.stop_reason !== 'end_turn') throw new ProviderFailure('invalid_output');
    const blocks = array(r.content).map(record);
    if (blocks.some((b) => b.type !== 'text')) throw new ProviderFailure('invalid_output');
    return blocks.map((b) => typeof b.text === 'string' ? b.text : '').join('');
  }
  if (provider === 'openai') {
    const blocks = array(r.output).map(record).flatMap((m) => array(m.content).map(record));
    if (blocks.some((b) => b.type === 'refusal')) throw new ProviderFailure('refusal');
    if (r.status !== 'completed' || r.error || r.incomplete_details || array(r.output).map(record).some((m) => !['message', 'reasoning'].includes(String(m.type)) || m.status !== undefined && m.status !== 'completed') || blocks.some((b) => b.type !== 'output_text')) throw new ProviderFailure('invalid_output');
    return blocks.map((b) => typeof b.text === 'string' ? b.text : '').join('');
  }
  const errors = array(r.errors).map(record);
  if (errors.some((e) => /safety|block|refus/i.test(String(e.code)))) throw new ProviderFailure('refusal');
  if (r.status !== 'completed' || errors.length) throw new ProviderFailure('invalid_output');
  const steps = array(r.steps).map(record);
  if (steps.some((s) => !['model_output', 'thought'].includes(String(s.type)))) throw new ProviderFailure('invalid_output');
  const blocks = steps.filter((s) => s.type === 'model_output').flatMap((s) => array(s.content).map(record));
  if (blocks.some((b) => b.type !== 'text')) throw new ProviderFailure('invalid_output');
  return blocks.map((b) => typeof b.text === 'string' ? b.text : '').join('');
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new ProviderFailure('invalid_output');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new ProviderFailure('invalid_output');
      chunks.push(value);
    }
    const joined = new Uint8Array(length); let offset = 0;
    for (const c of chunks) { joined.set(c, offset); offset += c.length; }
    try { return JSON.parse(new TextDecoder().decode(joined)); } catch { throw new ProviderFailure('invalid_output'); }
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new ProviderFailure('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function createAdapter(provider: Provider, transport: Transport = fetch, options: { deadlineMs?: number; random?: () => number } = {}): ProviderAdapter {
  async function request(rawConfig: ProviderConfig, rawKey: string, external: AbortSignal, context?: TaskContext): Promise<unknown> {
    const parsed = ConfigSchema.safeParse(rawConfig), parsedKey = KeySchema.safeParse(rawKey);
    if (!parsed.success || !parsedKey.success || parsed.data.provider !== provider || !parsed.data.model) throw new ProviderFailure('invalid_request');
    const config = parsed.data, key = parsedKey.data;
    // Do not allow a pasted credential to become a model/workspace/body field.
    if (config.model.includes(key) || config.workspace.includes(key) || (context && JSON.stringify(context).includes(key))) throw new ProviderFailure('invalid_request');
    const controller = new AbortController();
    const abort = () => controller.abort();
    external.addEventListener('abort', abort, { once: true });
    if (external.aborted) controller.abort();
    const deadline = Math.min(REQUEST_DEADLINE_MS, Math.max(1, options.deadlineMs ?? REQUEST_DEADLINE_MS));
    const started = Date.now(); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadline);
    // Race the entire operation, including body reads and non-cooperative mocks.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new ProviderFailure(timedOut ? 'timeout' : 'cancelled'));
      controller.signal.addEventListener('abort', fail, { once: true });
      if (controller.signal.aborted) fail();
    });
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (controller.signal.aborted) throw new ProviderFailure('cancelled');
        let response: Response;
        try {
          response = await transport(endpoints[provider], { method: 'POST', headers: headers(provider, key, config.workspace), body: JSON.stringify(body(provider, config.model, context)), redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
        } catch { throw new ProviderFailure('network'); }
        if (controller.signal.aborted) throw new ProviderFailure('cancelled');
        if (response.redirected || (response.url && response.url !== endpoints[provider]) || (response.status >= 300 && response.status < 400)) throw new ProviderFailure('permission');
        let data: unknown;
        try { data = await readJson(response, controller.signal); }
        catch (e) { if (response.ok) throw e; data = null; }
        if (!response.ok) {
          const failure = httpFailure(response.status, data);
          if (failure.code !== 'rate_limit' || attempt === 2) throw failure;
          const retry = response.headers.get('retry-after');
          const retryMs = retry === null ? 0 : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          const jitter = Math.floor((options.random ?? Math.random)() * 200);
          const delay = Math.max(500 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : 0) + jitter;
          if (Date.now() - started + delay >= deadline) throw failure;
          await sleep(delay, controller.signal); continue;
        }
        let value: unknown;
        const text = output(provider, data);
        if (text.includes(key)) throw new ProviderFailure('invalid_output');
        try { value = JSON.parse(text); } catch { throw new ProviderFailure('invalid_output'); }
        return value;
      }
      throw new ProviderFailure('rate_limit');
    };
    try { return await Promise.race([run(), aborted]); }
    catch (e) {
      if (timedOut) throw new ProviderFailure('timeout');
      if (external.aborted) throw new ProviderFailure('cancelled');
      throw e instanceof ProviderFailure ? e : new ProviderFailure('network');
    } finally { clearTimeout(timer); controller.abort(); external.removeEventListener('abort', abort); }
  }
  return { provider,
    async testConnection(config, key, signal) {
      const value = await request(config, key, signal);
      if (!ProbeSchema.safeParse(value).success) throw new ProviderFailure('invalid_output');
      return { structuredOutput: true, model: config.model, testedAt: Date.now() };
    },
    async propose(config, key, signal, rawContext) {
      const parsed = ContextSchema.safeParse(rawContext);
      if (!parsed.success) throw new ProviderFailure('invalid_request');
      const context = parsed.data;
      return validateProposals(await request(config, key, signal, context), context);
    },
  };
}
