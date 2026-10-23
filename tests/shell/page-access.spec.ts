import { chromium, expect, test, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { browser } from 'wxt/browser';
import { probePage } from '../../src/browser/probe';
import { addressIdentity } from '../../src/browser/addresses';
import { application, pageCases } from '../fixtures/page-access';

declare const chrome: typeof browser;

test('owned DOM classification reads no protected values/cookies and performs no writes or provider traffic', async ({ browser }, testInfo) => {
  // Ordinary page test, not extension/activeTab evidence. Execute the exact
  // serialized production function with real DOM and poisoned protected getters.
  const context = await browser.newContext();
  const traffic: string[] = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url()); traffic.push(url.href);
    await route.fulfill({ contentType: 'text/html', body: url.hostname === 'probe.applyr.test' ? pageCases.find((c) => url.pathname === `/${c.name}`)?.html ?? '' : '' });
  });
  const page = await context.newPage();
  try {
    for (const fixture of pageCases) {
      const url = `https://probe.applyr.test/${fixture.name}`;
      await page.goto(url);
      await page.evaluate(() => {
        for (const property of ['value', 'checked', 'files']) Object.defineProperty(HTMLInputElement.prototype, property, { get() { throw new Error('PROTECTED_INPUT_READ'); }, set() { throw new Error('INPUT_WRITE'); }, configurable: true });
        Object.defineProperty(Document.prototype, 'cookie', { get() { throw new Error('COOKIE_READ'); }, configurable: true });
        for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket']) Object.defineProperty(window, name, { value: () => { throw new Error('PROVIDER_TRAFFIC'); }, configurable: true });
      });
      const result = await page.evaluate(probePage, await addressIdentity(url));
      expect(result?.classification, fixture.name).toBe(fixture.classification);
      expect(JSON.stringify(result)).not.toMatch(/hidden-canary|otp-canary|password-canary|existing-name|newsletter-canary|not-persisted/);
      expect(await page.locator('input').evaluateAll((inputs) => inputs.map((input) => input.getAttribute('value')))).not.toContain('filled');
      if (fixture.name === 'frame') expect(result?.frames).toEqual([expect.objectContaining({ origin: 'https://embed.applyr.test', url: 'https://embed.applyr.test/application' })]);
    }
    expect(traffic.every((url) => ['probe.applyr.test', 'embed.applyr.test', 'unrelated.applyr.test'].includes(new URL(url).hostname))).toBe(true);
    await testInfo.attach('probe-traffic', { body: JSON.stringify({ traffic, providerRequests: 0 }), contentType: 'application/json' });
  } finally { await context.close(); }
});

test('real extension scoped probe, manual open, two jobs, frame denial, closure and tab switching', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium'); test.setTimeout(90_000);
  const directory = await mkdtemp(path.join(tmpdir(), 'applyr-access-'));
  const extension = path.join(directory, 'extension');
  await cp(path.resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Test-only install grant: same production JS, one fictional HTTPS origin.
  // This is explicitly not a native toolbar/optional-permission-dialog test.
  manifest.host_permissions = ['https://jobs.applyr.test/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
    channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const traffic: string[] = [], errors: string[] = [];
  context.on('request', (r) => { if (/^https?:/.test(r.url())) traffic.push(r.url()); });
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  await context.route(/^https?:/, async (route) => {
    const url = new URL(route.request().url());
    if (!['jobs.applyr.test', 'embed.applyr.test', 'unrelated.applyr.test'].includes(url.hostname)) return route.abort();
    const body = url.pathname === '/frame' ? pageCases.find((c) => c.name === 'frame')!.html
      : url.pathname === '/same-frame' ? '<title>Apply at Fictional</title><h1>Apply here</h1><iframe title="Job application" src="https://jobs.applyr.test/apply?id=embedded"></iframe>'
        : url.hostname === 'jobs.applyr.test' ? application : '<title>Unrelated</title><input value="untouched">';
    await route.fulfill({ contentType: 'text/html', body });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const base = `chrome-extension://${worker.url().split('/')[2]}`;
  async function packaged(name: string) {
    const before = new Set(context.pages());
    await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `${base}/${name}.html`);
    await expect.poll(() => context.pages().some((p) => !before.has(p) && p.url() === `${base}/${name}.html`)).toBe(true);
    const page = context.pages().find((p) => !before.has(p) && p.url() === `${base}/${name}.html`)!;
    await page.waitForLoadState('domcontentloaded'); return page;
  }
  const read = (page: Page) => page.evaluate(() => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'GET_STATE', sessionId: null, revision: null }));
  try {
    const source = await context.newPage(); await source.goto('https://jobs.applyr.test/apply?id=one&token=not-persisted');
    await source.bringToFront();
    const popup = await packaged('popup');
    await expect(popup.getByTestId('page-classification')).toHaveText('application');
    await expect(popup.getByTestId('target-url')).toHaveText('https://jobs.applyr.test/apply?id=one');
    await expect(popup.getByTestId('target-role')).toHaveText('Engineer');
    const first = await read(popup); expect(first.ok).toBe(true); const originalId = first.checkpoint.id;
    await popup.getByRole('button', { name: 'Edit display metadata' }).click();
    await popup.getByLabel('Display role').fill('Edited Engineer'); await popup.getByLabel('Display company').fill('Edited Company');
    await popup.getByRole('button', { name: 'Save display metadata' }).click();
    await expect(popup.getByTestId('target-role')).toHaveText('Edited Engineer');
    expect((await read(popup)).checkpoint.target.identity).toBe(first.checkpoint.target.identity);
    const unrelated = await context.newPage(); await unrelated.goto('https://unrelated.applyr.test/other'); await unrelated.bringToFront();
    await popup.getByRole('button', { name: 'Inspect bound page', exact: true }).click();
    await expect(popup.getByTestId('page-classification')).toHaveText('application');
    expect((await read(popup)).checkpoint.target.tabId).toBe(first.checkpoint.target.tabId);
    await expect(source.locator('input[name=name]')).toHaveValue('existing-name');
    await expect(source.locator('#newsletter input')).toHaveValue('newsletter-canary');
    await expect(unrelated.locator('input')).toHaveValue('untouched');

    await source.goto('https://jobs.applyr.test/apply?id=two');
    await expect.poll(async () => (await read(popup)).checkpoint.access.reason).toBe('navigation');
    await expect(popup.getByTestId('page-status')).toHaveText('Needs attention');
    expect((await read(popup)).checkpoint.id).toBe(originalId);
    await source.bringToFront(); const secondPopup = await packaged('popup');
    await secondPopup.getByRole('button', { name: 'Use this tab', exact: true }).click();
    await expect(secondPopup.getByTestId('page-classification')).toHaveText('application');
    expect((await read(secondPopup)).checkpoint.id).not.toBe(originalId);
    await expect(secondPopup.getByTestId('target-url')).toHaveText('https://jobs.applyr.test/apply?id=two');

    await secondPopup.getByLabel('Manual application URL').fill('https://jobs.applyr.test/frame');
    await secondPopup.getByRole('button', { name: 'Open application', exact: true }).click();
    await expect.poll(() => context.pages().some((p) => p.url() === 'https://jobs.applyr.test/frame')).toBe(true);
    await expect.poll(async () => (await read(secondPopup)).checkpoint.target.url).toBe('https://jobs.applyr.test/frame');
    await secondPopup.getByRole('button', { name: 'Inspect bound page', exact: true }).click();
    await expect(secondPopup.getByTestId('page-classification')).toHaveText('uncertain');
    const framed = (await read(secondPopup)).checkpoint;
    expect(framed.access.frames).toHaveLength(1);
    const denied = await secondPopup.evaluate((record) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'PROBE_TARGET', sessionId: record.id, revision: record.revision, frameOrigin: 'https://embed.applyr.test', frameIdentity: record.access.frames[0].identity }), framed);
    expect(denied.checkpoint.access.reason).toBe('frame_permission');
    expect(await secondPopup.evaluate(() => chrome.permissions.contains({ origins: ['https://embed.applyr.test/*'] }))).toBe(false);
    const frameTab = context.pages().find((p) => p.url() === 'https://jobs.applyr.test/frame')!;
    await frameTab.close();
    await expect.poll(async () => (await read(secondPopup)).checkpoint.access.reason).toBe('closed');
    await expect(secondPopup.getByTestId('page-guidance')).toContainText('tab closed');
    await expect(source).toHaveURL('https://jobs.applyr.test/apply?id=two');
    // A newly opened ungranted origin cannot borrow the original job's access.
    const closed = (await read(secondPopup)).checkpoint;
    const opened = await secondPopup.evaluate((record) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'OPEN_APPLICATION', sessionId: record.id, revision: record.revision, url: 'https://unrelated.applyr.test/new-application' }), closed);
    expect(opened.ok).toBe(true);
    await expect.poll(() => context.pages().some((p) => p.url() === 'https://unrelated.applyr.test/new-application')).toBe(true);
    const current = (await read(secondPopup)).checkpoint;
    const inaccessible = await secondPopup.evaluate((record) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'PROBE_TARGET', sessionId: record.id, revision: record.revision }), current);
    expect(inaccessible.checkpoint.access.reason).toBe('permission');
    expect(inaccessible.checkpoint.target.origin).toBe('https://unrelated.applyr.test');
    await expect(unrelated.locator('input')).toHaveValue('untouched');
    await expect(source.locator('input[name=name]')).toHaveValue('existing-name');
    await expect(secondPopup.getByRole('alert')).toHaveCount(0);
    await secondPopup.screenshot({ path: testInfo.outputPath('page-permission.png'), fullPage: true });

    // Same-origin embedded applications reuse the bound page's grant.
    await secondPopup.getByRole('button', { name: 'Refresh checkpoint', exact: true }).click();
    await secondPopup.getByLabel('Manual application URL').fill('https://jobs.applyr.test/same-frame');
    await secondPopup.getByRole('button', { name: 'Open application', exact: true }).click();
    await expect.poll(async () => (await read(secondPopup)).checkpoint.target.url).toBe('https://jobs.applyr.test/same-frame');
    await secondPopup.getByRole('button', { name: 'Inspect bound page', exact: true }).click();
    await expect(secondPopup.getByTestId('page-classification')).toHaveText('uncertain');
    await secondPopup.getByRole('button', { name: 'Inspect frame at https://jobs.applyr.test', exact: true }).click();
    await expect(secondPopup.getByTestId('page-classification')).toHaveText('application');
    const embeddedPage = context.pages().find((p) => p.url() === 'https://jobs.applyr.test/same-frame')!;
    await expect(embeddedPage.frameLocator('iframe[title="Job application"]').locator('input[name=name]')).toHaveValue('existing-name');
    expect((await read(secondPopup)).checkpoint.target.url).toBe('https://jobs.applyr.test/same-frame');
    await secondPopup.screenshot({ path: testInfo.outputPath('page-application.png'), fullPage: true });
    await embeddedPage.close();
    await expect.poll(async () => (await read(secondPopup)).checkpoint.access.reason).toBe('closed');
    await expect(secondPopup.getByRole('alert')).toHaveCount(0);
    const permissionSet = await secondPopup.evaluate(() => chrome.permissions.getAll());
    expect(permissionSet.origins).toEqual(['https://jobs.applyr.test/*']);
    expect(traffic.every((url) => ['jobs.applyr.test', 'embed.applyr.test', 'unrelated.applyr.test'].includes(new URL(url).hostname))).toBe(true);
    expect(errors).toEqual([]);
    await secondPopup.screenshot({ path: testInfo.outputPath('page-attention.png'), fullPage: true });
    await testInfo.attach('access-runtime-evidence', { body: JSON.stringify({ browserVersion: context.browser()!.version(), grant: 'fixture-only install host grant', traffic, providerRequests: 0, errors }, null, 2), contentType: 'application/json' });
  } finally { await context.close(); await rm(directory, { recursive: true, force: true }); }
});
