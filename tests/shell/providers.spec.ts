import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { browser } from 'wxt/browser';
import { startFormFixtures } from '../fixtures/forms';
import { CREDENTIAL_CANARY, CANDIDATE_CANARY, providerSuccess } from '../fixtures/providers';
import { endpoints } from '../../src/providers/endpoints';

declare const chrome: typeof browser;

test('F11 real packaged settings isolate credentials; all native transports are synthetic worker mocks', async ({ browserName }, info) => {
  test.setTimeout(90_000); expect(browserName).toBe('chromium');
  const directory = await mkdtemp(path.join(tmpdir(), 'applyr-providers-'));
  const fixtures = await startFormFixtures(); let context: BrowserContext | undefined;
  try {
    const extension = path.join(directory, 'extension'); await cp(path.resolve('.output/chrome-mv3'), extension, { recursive: true });
    const manifestPath = path.join(extension, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    // Test-only install grants. Production JS is unchanged; native permission dialogs remain unverified.
    manifest.host_permissions = ['https://127.0.0.1/*', 'https://api.openai.com/*', 'https://generativelanguage.googleapis.com/*', 'https://api.anthropic.com/*'];
    await writeFile(manifestPath, JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(path.join(directory, 'profile'), { channel: 'chromium', headless: true, acceptDownloads: true, ignoreHTTPSErrors: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors'] });
    context.setDefaultTimeout(10_000);
    const externalRequests: string[] = [], logs: string[] = [];
    context.on('request', (r) => { if (/^https?:/.test(r.url()) && !r.url().startsWith(fixtures.origin) && !r.url().startsWith(fixtures.cross)) externalRequests.push(r.url()); });
    context.on('page', (p) => p.on('console', (m) => logs.push(m.text())));
    await context.route(/^https?:/, (r) => r.request().url().startsWith(fixtures.origin) ? r.continue() : r.abort());
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const base = worker.url().replace('/background.js', '');
    await worker.evaluate(({ endpoints, replies, candidate }) => {
      type Audit = { calls: { provider: string; headerOnly: boolean; synthetic: boolean; safeOptions: boolean }[] };
      const audit: Audit = { calls: [] };
      (globalThis as unknown as { providerAudit: Audit }).providerAudit = audit;
      // Mock the privileged fetch boundary; no provider or real credential network request runs.
      globalThis.fetch = async (url, init) => {
        const provider = Object.keys(endpoints).find((p) => endpoints[p as keyof typeof endpoints] === String(url)) as keyof typeof endpoints | undefined;
        if (!provider) throw new Error('unexpected native endpoint');
        const header = new Headers(init?.headers), key = provider === 'gemini' ? header.get('x-goog-api-key') : header.get('Authorization')?.replace('Bearer ', '');
        audit.calls.push({ provider, headerOnly: !!key && !String(url).includes(key) && !String(init?.body).includes(key), synthetic: !String(init?.body).includes(candidate) && String(init?.body).includes('Synthetic connection test'), safeOptions: init?.redirect === 'error' && init.credentials === 'omit' });
        return new Response(JSON.stringify(replies[provider]), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    }, { endpoints, replies: { openai: providerSuccess('openai'), gemini: providerSuccess('gemini'), claude: providerSuccess('claude') }, candidate: CANDIDATE_CANARY });
    const source = await context.newPage(); await source.goto(`${fixtures.origin}/F01`);
    const options = await context.newPage(); await options.goto(`${base}/options.html`);
    const section = options.getByTestId('provider-settings');
    const status = section.getByTestId('provider-status');
    await expect(status).toContainText('Unverified');
    await options.locator('.profile-workspace input[type=file]').setInputFiles({ name: 'f11-fictional.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nprofile_version: 1\nidentity: {legal_name: '+CANDIDATE_CANARY+'}\n---\n') });
    await expect(options.getByTestId('profile-preview')).toContainText(CANDIDATE_CANARY);
    expect(await worker.evaluate(() => (globalThis as unknown as { providerAudit: { calls: unknown[] } }).providerAudit.calls.length)).toBe(0);
    const send = (page: Page, intent: object) => page.evaluate((intent) => chrome.runtime.sendMessage({ channel: 'providers', schemaVersion: 1, requestId: crypto.randomUUID(), ...intent }), intent);
    for (const provider of ['openai', 'gemini', 'claude'] as const) {
      await options.getByLabel('Provider', { exact: true }).selectOption(provider);
      await expect(status).toContainText('Unverified');
      await section.getByLabel('Model ID', { exact: true }).fill('fixture-model');
      if (provider === 'claude') await section.getByLabel('Claude workspace ID (if required)', { exact: true }).fill('wrkspc_fixture');
      await section.getByLabel('API key', { exact: true }).fill(CREDENTIAL_CANARY);
      await expect(section.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
      await section.getByRole('button', { name: 'Save provider settings', exact: true }).click();
      await expect(section.getByTestId('key-presence')).toHaveText('Key stored ••••••••');
      await expect(section.getByLabel('API key', { exact: true })).toHaveValue('');
      // A key is absent from rendered DOM/text and from all runtime status responses.
      expect(await options.locator('body').innerText()).not.toContain(CREDENTIAL_CANARY);
      const downloadEvent = options.waitForEvent('download');
      await options.getByRole('button', { name: 'Download Markdown', exact: true }).click();
      const download = await downloadEvent; const downloadPath = await download.path();
      const exported = await readFile(downloadPath!, 'utf8'); expect(exported).toContain(CANDIDATE_CANARY); expect(exported).not.toContain(CREDENTIAL_CANARY);
      const state = await send(options, { type: 'STATUS', provider }); expect(JSON.stringify(state)).not.toContain(CREDENTIAL_CANARY);
      const session = await options.evaluate(() => chrome.storage.session.get(null)); expect(session[`provider-key:${provider}`]).toBe(CREDENTIAL_CANARY);
      const disk = await options.evaluate(async () => {
        const d = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => r(q.result); });
        return new Promise<unknown[]>((r) => { const q = d.transaction('providerCredentials').objectStore('providerCredentials').getAll(); q.onsuccess = () => { d.close(); r(q.result); }; });
      }); expect(disk).toEqual([]);
      if (provider === 'gemini') await expect(section.getByLabel(/Allow selected candidate data/)).toBeDisabled();
      await section.getByRole('button', { name: 'Test connection (synthetic, may charge)', exact: true }).click();
      await expect(status).toContainText('Verified — synthetic');
      // No credential-read command exists even for an options sender.
      expect(await send(options, { type: 'GET_KEY', provider })).toMatchObject({ ok: false, code: 'invalid_request' });
      const isolated = await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        const results = await chrome.scripting.executeScript({ target: { tabId: tab!.id! }, world: 'ISOLATED', func: async () => {
          let readable = false;
          try { readable = Object.keys(await chrome.storage.session.get(null)).some((k) => k.startsWith('provider-key:')); } catch { /* trusted-only API must reject */ }
          const reply = await chrome.runtime.sendMessage({ channel: 'providers', schemaVersion: 1, requestId: crypto.randomUUID(), type: 'STATUS', provider: 'openai' });
          return { readable, reply };
        } }); return results[0]!.result;
      }, `${fixtures.origin}/F01`);
      expect(isolated).toMatchObject({ readable: false, reply: { ok: false, code: 'permission' } });
      await section.getByRole('button', { name: 'Remove key', exact: true }).click();
      await expect(section.getByTestId('key-presence')).toHaveText('No key stored'); await expect(status).toContainText('Unverified');
      expect(await options.evaluate(() => chrome.storage.session.get(null))).toEqual({ 'applyr-session-epoch': expect.stringMatching(/^[a-f0-9-]{36}$/) });
    }
    // Explicit remember is durable, revocation clears it. All tests still synthetic.
    await section.getByLabel('API key', { exact: true }).fill(CREDENTIAL_CANARY);
    await section.getByLabel(/Remember key on this browser/).check();
    await section.getByRole('button', { name: 'Save provider settings', exact: true }).click();
    await expect(section.getByTestId('key-presence')).toHaveText('Key stored ••••••••');
    const rememberedOnDisk = await options.evaluate(async () => {
      const d = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => r(q.result); });
      return new Promise<unknown>((r) => { const q = d.transaction('providerCredentials').objectStore('providerCredentials').get('claude'); q.onsuccess = () => { d.close(); r(q.result); }; });
    }); expect(rememberedOnDisk).toBe(CREDENTIAL_CANARY);
    await options.reload(); await options.getByLabel('Provider', { exact: true }).selectOption('claude'); await expect(section.getByTestId('key-presence')).toHaveText('Key stored ••••••••');
    await section.getByRole('button', { name: 'Revoke AI consent and remove key', exact: true }).click();
    await expect(section.getByTestId('key-presence')).toHaveText('No key stored');
    const finalCredentials = await options.evaluate(async () => {
      const d = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => r(q.result); });
      return new Promise<unknown[]>((r) => { const q = d.transaction('providerCredentials').objectStore('providerCredentials').getAll(); q.onsuccess = () => { d.close(); r(q.result); }; });
    }); expect(finalCredentials).toEqual([]); expect(await options.evaluate(() => chrome.storage.session.get(null))).toEqual({ 'applyr-session-epoch': expect.stringMatching(/^[a-f0-9-]{36}$/) });
    const audit = await worker.evaluate(() => (globalThis as unknown as { providerAudit: { calls: unknown[] } }).providerAudit);
    expect(audit.calls).toEqual(['openai', 'gemini', 'claude'].map((provider) => ({ provider, headerOnly: true, synthetic: true, safeOptions: true })));
    expect(externalRequests).toEqual([]); expect(logs.join('\n')).not.toContain(CREDENTIAL_CANARY);
    await section.screenshot({ path: info.outputPath('provider-settings.png') });
    await info.attach('provider-audit', { body: JSON.stringify({ browser: context.browser()!.version(), transport: 'mocked privileged worker fetch', testOnlyInstallGrants: true, audit, externalRequests, credentialInLogs: false, isolatedSessionReadDenied: true, candidateDataSent: false }), contentType: 'application/json' });
  } finally { await context?.close(); await fixtures.close(); await rm(directory, { recursive: true, force: true }); }
});
