import type { IDBPDatabase } from 'idb';
import type { ApplyrDatabase } from '../storage/database';
import { ConfigSchema, KeySchema, ProviderFailure, defaultConfig, type Provider, type ProviderConfig } from './contracts';

// This module belongs only to the privileged coordinator. No credential-read message exists.
export interface TrustedSession {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
  setAccessLevel?: (options: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void>;
}
export class ProviderStorage {
  private ready?: Promise<void>;
  constructor(private database: () => Promise<IDBPDatabase<ApplyrDatabase>>, private session: TrustedSession) {}
  private async trust() {
    // Session is trusted-only by default in Chrome/Firefox. Explicitly restrict when supported.
    this.ready ??= (async () => {
      if (!this.session?.get || !this.session?.set) throw new ProviderFailure('storage');
      if (this.session.setAccessLevel) await this.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    })();
    await this.ready;
  }
  async config(provider: Provider): Promise<ProviderConfig> {
    const db = await this.database(), raw = await db.get('providerSettings', provider);
    const parsed = ConfigSchema.safeParse(raw);
    if (parsed.success && parsed.data.provider === provider) return parsed.data;
    if (raw !== undefined) { await db.delete('providerSettings', provider); await this.clearKey(provider); }
    return defaultConfig(provider);
  }
  async save(config: ProviderConfig) {
    await (await this.database()).put('providerSettings', ConfigSchema.parse(config), config.provider);
  }
  async key(provider: Provider): Promise<string | null> {
    await this.trust();
    const config = await this.config(provider);
    const name = `provider-key:${provider}`, sessionValue = (await this.session.get(name))[name];
    const local = KeySchema.safeParse(sessionValue);
    if (local.success) return local.data;
    if (sessionValue !== undefined) await this.session.remove(name);
    if (!config.remember) { await (await this.database()).delete('providerCredentials', provider); return null; }
    const remembered = KeySchema.safeParse(await (await this.database()).get('providerCredentials', provider));
    if (!remembered.success) { await (await this.database()).delete('providerCredentials', provider); return null; }
    await this.session.set({ [name]: remembered.data });
    return remembered.data;
  }
  async setKey(provider: Provider, key: string | null, remember: boolean) {
    await this.trust();
    if (key === null) return this.clearKey(provider);
    const parsed = KeySchema.parse(key);
    const db = await this.database();
    // Delete the durable copy before moving to session-only storage.
    if (remember) await db.put('providerCredentials', parsed, provider);
    else await db.delete('providerCredentials', provider);
    await this.session.set({ [`provider-key:${provider}`]: parsed });
  }
  async clearKey(provider: Provider) {
    // Attempt both removals even if one store fails. No success on partial deletion.
    const results = await Promise.allSettled([
      this.database().then((db) => db.delete('providerCredentials', provider)),
      this.trust().then(() => this.session.remove(`provider-key:${provider}`)),
    ]);
    if (results.some((r) => r.status === 'rejected')) throw new ProviderFailure('storage');
  }
}
