import { trustedPage, type Sender } from '../security/sender';
import { ProviderRequestSchema, ProviderFailure, unverified, type Provider, type ProviderRequest, type ProviderStatus, type ProviderView } from './contracts';
import { createAdapter, type ProviderAdapter } from './adapters';
import { providerPattern } from './endpoints';
import type { ProviderStorage } from './storage';

export class ProviderService {
  private queue: Promise<unknown> = Promise.resolve();
  private epochs = new Map<Provider, number>();
  private active = new Map<Provider, AbortController>();
  private statuses = new Map<Provider, ProviderStatus>();
  private blocked = new Set<Provider>();
  constructor(private storage: ProviderStorage, private contains: (pattern: string) => Promise<boolean>, private adapter: (provider: Provider) => ProviderAdapter = createAdapter) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work); this.queue = next.catch(() => {}); return next;
  }
  private invalidate(provider: Provider) {
    this.epochs.set(provider, (this.epochs.get(provider) ?? 0) + 1);
    this.active.get(provider)?.abort(); this.active.delete(provider); this.statuses.set(provider, unverified());
  }
  private async view(provider: Provider): Promise<ProviderView> {
    const config = await this.storage.config(provider);
    return { config, hasKey: !this.blocked.has(provider) && !!await this.storage.key(provider), status: this.statuses.get(provider) ?? unverified() };
  }
  async execute(request: ProviderRequest): Promise<ProviderView> {
    const provider = request.provider;
    if (request.type === 'STATUS') return this.serial(() => this.view(provider));
    if (request.type === 'TEST') return this.test(provider, request.revision);
    // Invalidate synchronously, including while a prior test is preparing or sleeping.
    this.invalidate(provider);
    return this.serial(async () => {
      const config = await this.storage.config(provider);
      const revision = request.type === 'SAVE' ? request.config.revision : request.revision;
      // Revocation/removal must dominate a stale view. A queued stale SAVE
      // cannot restore keys after this mutation advances the revision.
      if (request.type === 'SAVE' && revision !== config.revision) throw new ProviderFailure('stale');
      if (request.type === 'CANCEL') return this.view(provider);
      try {
        if (request.type === 'SAVE') {
          if (request.config.provider !== provider) throw new ProviderFailure('invalid_request');
          const oldKey = await this.storage.key(provider), key = request.key ?? oldKey;
          if (key && (request.config.model.includes(key) || request.config.workspace.includes(key))) throw new ProviderFailure('invalid_request');
          const identityChanged = config.model !== request.config.model || config.workspace !== request.config.workspace || !!request.key;
          const revoked = config.candidateConsent && !request.config.candidateConsent;
          const next = { ...request.config, revision: config.revision + 1 };
          // Consent always binds the exact saved model/workspace/key. Changing identity requires a later explicit grant.
          if (identityChanged) next.candidateConsent = false;
          if (revoked) { next.remember = false; next.paidServiceConfirmed = false; await this.storage.clearKey(provider); }
          else await this.storage.setKey(provider, key, next.remember);
          await this.storage.save(next);
        } else {
          await this.storage.clearKey(provider);
          await this.storage.save({ ...config, revision: config.revision + 1, remember: false, candidateConsent: false, paidServiceConfirmed: false });
        }
        this.blocked.delete(provider);
        return await this.view(provider);
      } catch (error) {
        if (error instanceof ProviderFailure && error.code === 'invalid_request') throw error;
        this.blocked.add(provider);
        // A failed mutation must never leave an enabled partial credential state.
        await this.storage.clearKey(provider).catch(() => {});
        throw new ProviderFailure('storage');
      }
    });
  }
  private async test(provider: Provider, revision: number): Promise<ProviderView> {
    if (this.active.has(provider)) throw new ProviderFailure('busy');
    const controller = new AbortController(), epoch = this.epochs.get(provider) ?? 0;
    this.active.set(provider, controller);
    const current = () => !controller.signal.aborted && epoch === (this.epochs.get(provider) ?? 0);
    try {
      const { config, key } = await this.serial(async () => ({ config: await this.storage.config(provider), key: await this.storage.key(provider) }));
      if (!current()) throw new ProviderFailure('cancelled');
      if (config.revision !== revision) throw new ProviderFailure('stale');
      if (!key || this.blocked.has(provider)) throw new ProviderFailure('auth');
      if (!config.model) throw new ProviderFailure('model_unsupported');
      if (!await this.contains(providerPattern(provider))) throw new ProviderFailure('permission');
      if (!current()) throw new ProviderFailure('cancelled');
      this.statuses.set(provider, { state: 'testing', code: null, capability: null });
      const capability = await this.adapter(provider).testConnection(config, key, controller.signal);
      if (!current()) throw new ProviderFailure('cancelled');
      this.statuses.set(provider, { state: 'verified', code: null, capability });
    } catch (e) {
      const code = e instanceof ProviderFailure ? e.code : 'storage';
      if (current()) this.statuses.set(provider, { state: 'error', code, capability: null });
    } finally { if (this.active.get(provider) === controller) this.active.delete(provider); }
    return this.serial(() => this.view(provider));
  }
  // Future candidate operations must use this gate and recheck their captured epoch before dispatch.
  // No candidate request/message is implemented in prompt 08.
  async candidateReady(provider: Provider): Promise<boolean> {
    return this.serial(async () => {
      const view = await this.view(provider);
      return view.hasKey && view.config.candidateConsent && (provider !== 'gemini' || view.config.paidServiceConfirmed)
        && view.status.state === 'verified' && view.status.capability?.model === view.config.model
        && await this.contains(providerPattern(provider));
    });
  }
  revokePermissions() {
    // Host wildcards can cover any native provider. Invalidate all conservatively; no new transmissions follow removal.
    for (const provider of ['openai', 'gemini', 'claude'] as const) this.invalidate(provider);
  }
}
export function providerHandler(service: ProviderService, extensionId: string, optionsUrl: string) {
  return async (raw: unknown, sender: Sender) => {
    if (!trustedPage(sender, extensionId, [optionsUrl])) return { ok: false, requestId: null, code: 'permission' };
    const parsed = ProviderRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, requestId: null, code: 'invalid_request' };
    try { return { ok: true, requestId: parsed.data.requestId, view: await service.execute(parsed.data) }; }
    catch (error) { return { ok: false, requestId: parsed.data.requestId, code: error instanceof ProviderFailure ? error.code : 'storage' }; }
  };
}
