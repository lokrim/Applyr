import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { browser } from 'wxt/browser';

// Type annotation only. The real browser provides chrome; no API mocks or production test hooks.
declare const chrome: typeof browser;

test('built extension captures a source, reopens its UI and persists across browser restart', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  const profile = await mkdtemp(path.join(tmpdir(), 'applyr-shell-'));
  const extension = path.resolve('.output/chrome-mv3');
  let context: BrowserContext | undefined;
  const outbound: string[] = [];
  const errors: string[] = [];
  async function launch() {
    const launched = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    launched.on('request', (request) => { if (/^https?:/.test(request.url())) outbound.push(request.url()); });
    await launched.route(/^https?:/, (route) => route.abort());
    launched.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    const worker = launched.serviceWorkers()[0] ?? await launched.waitForEvent('serviceworker');
    // Node treats extension schemes as opaque origins; derive the actual packaged URL from the worker.
    const extensionId = worker.url().split('/')[2];
    return { launched, worker, base: `chrome-extension://${extensionId}` };
  }
  async function packagedPage(worker: Worker, url: string) {
    const previous = new Set(context!.pages());
    await worker.evaluate(async (url) => { await chrome.tabs.create({ url, active: false }); }, url);
    // tabs.create can resolve before Playwright receives an earlier tab's page event.
    // Select the new packaged page by its actual URL, not whichever event arrives first.
    await expect.poll(() => context!.pages().some((page) => !previous.has(page) && page.url() === url)).toBe(true);
    const page = context!.pages().find((page) => !previous.has(page) && page.url() === url)!;
    await page.waitForLoadState('domcontentloaded');
    return page;
  }
  try {
    let running = await launch();
    context = running.launched;
    const browserVersion = context.browser()!.version();
    const source = await running.worker.evaluate(async () => chrome.tabs.create({ url: 'about:blank', active: true }));
    const popup = await packagedPage(running.worker, `${running.base}/popup.html`);
    await expect(popup.getByRole('heading', { name: 'Saved setup checkpoint' })).toBeVisible();
    await expect(popup.getByTestId('target-tab')).toHaveText(`Source tab #${source.id}`);
    await expect(popup.getByTestId('page-classification')).toHaveText('restricted');
    await expect(popup.getByText('Not configured', { exact: true })).toBeVisible();
    const checkpointId = await popup.getByTestId('checkpoint-id').innerText();

    // Real UI click invokes sidePanel.open or its packaged-tab fallback.
    await popup.getByRole('button', { name: 'Open session', exact: true }).click();
    await expect(popup.getByRole('status')).toContainText(/opened/i);
    const sessionEvent = context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open in tab', exact: true }).click();
    const session = await sessionEvent;
    await expect(session.getByTestId('checkpoint-id')).toHaveText(checkpointId);
    await expect(session.getByTestId('target-tab')).toHaveText(`Source tab #${source.id}`);
    await popup.close();
    const reopened = await packagedPage(running.worker, `${running.base}/popup.html`);
    await expect(reopened.getByTestId('checkpoint-id')).toHaveText(checkpointId);
    await session.screenshot({ path: testInfo.outputPath('session.png'), fullPage: true });

    const forbidden = await session.evaluate(async () => chrome.runtime.sendMessage({
      schemaVersion: 1, requestId: crypto.randomUUID(), type: 'FETCH', sessionId: null, revision: null, url: 'https://evil.invalid',
    }));
    expect(forbidden).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    const preferences = await session.evaluate(async () => chrome.storage.local.get(null));
    expect(preferences).toEqual({});
    const permissions = await session.evaluate(async () => chrome.permissions.getAll());
    expect(permissions.origins ?? []).toEqual([]);

    await context.close();
    running = await launch();
    context = running.launched;
    const restored = await packagedPage(running.worker, `${running.base}/session.html`);
    await expect(restored.getByTestId('checkpoint-id')).toHaveText(checkpointId);
    await expect(restored.getByText('Tab IDs must be rebound after a browser restart.', { exact: false })).toBeVisible();
    // Orderly Chromium shutdown can close the bound tab before startup fires.
    // Either event must leave durable attention and prevent automatic probing.
    await expect(restored.getByTestId('page-status')).toHaveText('Needs attention');
    await expect(restored.getByTestId('page-guidance')).toContainText(/browser restarted|tab closed/);
    await expect(restored.getByRole('button', { name: 'Inspect bound page', exact: true })).toBeDisabled();
    await restored.getByRole('button', { name: 'Settings & privacy' }).click();
    // openOptionsPage may reuse/navigate an existing tab instead of emitting a new-page event.
    await expect.poll(() => context!.pages().some((page) => page.url() === `${running.base}/options.html`)).toBe(true);
    const options = context.pages().find((page) => page.url() === `${running.base}/options.html`)!;
    await expect(options.getByTestId('checkpoint-id')).toHaveText(checkpointId);
    await options.getByRole('button', { name: 'Forget setup checkpoint' }).click();
    await expect(options.getByRole('heading', { name: 'No saved checkpoint' })).toBeVisible();
    const cleared = await packagedPage(running.worker, `${running.base}/session.html`);
    await expect(cleared.getByRole('heading', { name: 'No saved checkpoint' })).toBeVisible();
    await testInfo.attach('session-screenshot', { path: testInfo.outputPath('session.png'), contentType: 'image/png' });
    expect(errors).toEqual([]);
    expect(outbound).toEqual([]);
    await testInfo.attach('runtime-evidence', { body: JSON.stringify({ browserVersion, extension, checkpointId, outbound, errors }, null, 2), contentType: 'application/json' });
    console.log(`Real extension shell passed on Chromium ${browserVersion}`);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
