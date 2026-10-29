import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { providerIntent } from '../providers/client';
import { defaultConfig, errorText, ProviderFailure, type Provider, type ProviderConfig, type ProviderView } from '../providers/contracts';
import { providerOrigin, providerPattern } from '../providers/endpoints';

const labels = { openai: 'OpenAI', gemini: 'Gemini', claude: 'Claude' };
const terms = { openai: 'https://developers.openai.com/api/docs/guides/your-data', gemini: 'https://ai.google.dev/gemini-api/terms', claude: 'https://platform.claude.com/docs/en/manage-claude/api-and-data-retention' };
export function ProviderSettings() {
  const [provider, setProvider] = useState<Provider>('openai');
  return <section id="providers" className="card provider-workspace" aria-labelledby="provider-heading">
    <h2 id="provider-heading">Optional AI providers</h2>
    <p>Deterministic autofill works without AI. API requests use your own provider account and may incur charges separately from a chat subscription.</p>
    <p>Keys stay in trusted browser session storage by default. Remember key stores a nonsynced copy in extension-origin IndexedDB. These stores are not encrypted vaults: browser-profile access, a compromised device or extension can expose keys. Providers warn against production browser-held secrets. Use only your own personal key.</p>
    <label htmlFor="provider-select">Provider</label><select id="provider-select" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="claude">Claude</option></select>
    <ProviderForm key={provider} provider={provider} />
  </section>;
}
function ProviderForm({ provider }: { provider: Provider }) {
  const [view, setView] = useState<ProviderView | null>(null);
  const [config, setConfig] = useState<ProviderConfig>(defaultConfig(provider));
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false), [testing, setTesting] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  function accept(next: ProviderView) { setView(next); setConfig(next.config); setDirty(false); }
  useEffect(() => {
    let alive = true;
    const refresh = () => { void providerIntent({ type: 'STATUS', provider }).then((v) => { if (alive) accept(v); }).catch(() => { if (alive) setError(errorText.storage); }); };
    refresh();
    return () => { alive = false; };
  }, [provider]);
  function edit(next: Partial<ProviderConfig>) { setConfig({ ...config, ...next }); setDirty(true); setNotice(''); }
  async function run(work: () => Promise<ProviderView>, text = '') {
    setBusy(true); setError(''); setNotice('');
    try { accept(await work()); setNotice(text); }
    catch (e) { setError(e instanceof ProviderFailure ? e.message : errorText.invalid_request); }
    finally { setBusy(false); }
  }
  const status = view?.status;
  return <div data-testid="provider-settings">
    <p className="muted">Endpoint: {providerOrigin(provider)}. Enter your account’s exact model ID. Model listing is not used; only an explicit structured-output test can verify this model.</p>
    <label>Model ID<input value={config.model} maxLength={160} disabled={busy || testing} onChange={(e) => edit({ model: e.target.value, candidateConsent: false })} autoComplete="off" spellCheck={false} /></label>
    {provider === 'claude' && <><label>Claude workspace ID (if required)<input value={config.workspace} maxLength={100} disabled={busy || testing} onChange={(e) => edit({ workspace: e.target.value, candidateConsent: false })} autoComplete="off" spellCheck={false} /></label><p className="muted">Required for a key that is not scoped to one workspace. If supplied for a workspace-scoped key, it must match. Check your provider account if access fails.</p></>}
    <label>API key<input type="password" value={key} maxLength={512} autoComplete="off" spellCheck={false} disabled={busy || testing} placeholder={view?.hasKey ? 'Key stored •••••••• — leave empty to keep' : 'Enter your personal API key'} onChange={(e) => { setKey(e.target.value); edit({ candidateConsent: false }); }} /></label>
    <p data-testid="key-presence">{view?.hasKey ? 'Key stored ••••••••' : 'No key stored'}</p>
    <label><input type="checkbox" checked={config.remember} disabled={busy || testing} onChange={(e) => edit({ remember: e.target.checked })} /> Remember key on this browser (explicit local storage, never synced)</label>
    <button disabled={!view || busy || testing} onClick={() => {
      const submittedKey = key; setKey('');
      void run(() => providerIntent({ type: 'SAVE', provider, config, ...(submittedKey ? { key: submittedKey } : {}) }), 'Settings saved. A changed key, model or workspace requires a new consent and test.');
    }}>Save provider settings</button>
    <p>Synthetic testing sends only a fixed JSON task and the selected model ID. It sends no profile, resume, form, answers or page context. Testing can incur a small charge and cannot establish billing tier, remaining quota or future availability.</p>
    <p role="status" data-testid="provider-status">{testing ? 'Testing synthetic structured output…' : !view || status?.state === 'unverified' ? 'Unverified — no live capability established.' : status?.state === 'verified' ? 'Verified — synthetic structured output succeeded for this saved model in this browser session.' : status?.state === 'testing' ? 'Testing synthetic structured output…' : `Unverified — ${status?.code ? errorText[status.code] : 'No live capability established.'}`}</p>
    <div className="actions">
      <button disabled={!view?.hasKey || !config.model || dirty || busy || testing} onClick={() => {
        // Permission request must begin directly in this deliberate click, before asynchronous work.
        const request = { origins: [providerPattern(provider)], ...(import.meta.env.BROWSER === 'firefox' ? { data_collection: ['authenticationInfo'] } : {}) };
        const grant = browser.permissions.request(request);
        setTesting(true); setError(''); setNotice('');
        void (async () => {
          try {
            if (!await grant) throw new ProviderFailure('permission');
            accept(await providerIntent({ type: 'TEST', provider, revision: config.revision }));
          } catch (e) { setError(e instanceof ProviderFailure ? e.message : errorText.permission); }
          finally { setTesting(false); }
        })();
      }}>Test connection (synthetic, may charge)</button>
      <button className="secondary" disabled={!view || busy} onClick={() => void run(() => providerIntent({ type: 'CANCEL', provider, revision: view!.config.revision }), 'Test cancelled locally; already delivered requests may still be billed.')}>Cancel test</button>
      <button className="secondary" disabled={!view || busy} onClick={() => { setKey(''); void run(() => providerIntent({ type: 'REMOVE_KEY', provider, revision: view!.config.revision }), 'Session and remembered key removed; consent cleared.'); }}>Remove key</button>
    </div>
    <h3>{labels[provider]} candidate-data consent</h3>
    <p>Future AI assistance may send selected candidate facts and provenance IDs, relevant question/field labels and options, limits, and a relevant role excerpt to {labels[provider]} using this saved model. It requires your separate approval before insertion. This milestone sends no candidate data.</p>
    <p>Whole profiles, PDF bytes, full pages, passwords, cookies and sensitive declarations are excluded. Provider retention and training depend on account and terms; local deletion cannot recall delivered requests. Stateless options do not promise zero retention. <a href={terms[provider]} target="_blank" rel="noreferrer">{labels[provider]} data terms</a></p>
    {provider === 'gemini' && <><p>Unpaid Gemini services generally prohibit personal/sensitive information and may use inputs for improvement and human review. Regional EEA/Switzerland/UK terms differ; applyr conservatively requires an active paid-service confirmation for candidate data everywhere. A successful synthetic test cannot prove paid status.</p><label><input type="checkbox" checked={config.paidServiceConfirmed} disabled={busy || testing} onChange={(e) => edit({ paidServiceConfirmed: e.target.checked, candidateConsent: false })} /> I confirm this Gemini key/project has an active paid-service configuration</label></>}
    <label><input type="checkbox" checked={config.candidateConsent} disabled={!view?.hasKey || dirty && (config.model !== view.config.model || config.workspace !== view.config.workspace) || !!key || busy || testing || provider === 'gemini' && !config.paidServiceConfirmed} onChange={(e) => {
      if (!e.target.checked && view?.config.candidateConsent) {
        setKey(''); void run(() => providerIntent({ type: 'REVOKE_CONSENT', provider, revision: view.config.revision }), 'AI consent revoked and key removed. Pending requests were stopped locally.');
      } else edit({ candidateConsent: e.target.checked });
    }} /> Allow selected candidate data to {labels[provider]} with model {view?.config.model || '(save a model first)'}</label>
    <p className="muted">Save to grant consent. Revoking saved consent removes the key and aborts pending requests. Changing provider does not transfer consent. No provider/model fallback or automatic output-repair request is made. Timeouts require your deliberate retry and may already be billed.</p>
    <button className="text-button" disabled={!view || busy} onClick={() => { setKey(''); void run(() => providerIntent({ type: 'REVOKE_CONSENT', provider, revision: view!.config.revision }), 'AI consent revoked and key removed.'); }}>Revoke AI consent and remove key</button>
    <button className="text-button" disabled={busy || testing} onClick={() => { setKey(''); void run(() => providerIntent({ type: 'STATUS', provider })); }}>Reload provider settings</button>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
  </div>;
}
