import { chromium, test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { browser } from 'wxt/browser';
import { startFormFixtures } from './forms';

declare const chrome: typeof browser;
export const test = base.extend<{ platformGrants: boolean; aiProviderGrants: boolean; notificationGrants: boolean; inspector: { context: BrowserContext; fixtures: Awaited<ReturnType<typeof startFormFixtures>>; source: Page; popup: () => Promise<Page> } }>({
  platformGrants: [false, { option: true }],
  aiProviderGrants: [false, { option: true }],
  notificationGrants: [false, { option: true }],
  inspector: async ({ browserName, aiProviderGrants, notificationGrants, platformGrants }, use) => {
    expect(browserName).toBe('chromium');
    const fixtures = await startFormFixtures();
    const directory = await mkdtemp(path.join(tmpdir(), 'applyr-inspection-'));
    const extension = path.join(directory, 'extension');
    await cp(path.resolve('.output/chrome-mv3'), extension, { recursive: true });
    const manifestPath = path.join(extension, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    // Same production JavaScript; test-only install grant to one loopback HOST.
    // This host pattern omits the port and matches all ports; localhost stays denied.
    if (notificationGrants) manifest.permissions.push('notifications');
    manifest.host_permissions = ['https://127.0.0.1/*', ...(platformGrants ? ['https://job-boards.greenhouse.io/*', 'https://jobs.lever.co/*', 'https://docs.google.com/*', 'https://jobs.ashbyhq.com/*', 'https://jobs.smartrecruiters.com/*', 'https://apply.workable.com/*', 'https://fiction.wd1.myworkdayjobs.com/*'] : []), ...(aiProviderGrants ? ['https://api.openai.com/*'] : [])];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
      channel: 'chromium', headless: true, ignoreHTTPSErrors: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--ignore-certificate-errors'],
    });
    await context.route(/^https?:/, (route) => [fixtures.origin, fixtures.cross].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const url = `chrome-extension://${worker.url().split('/')[2]}/popup.html`;
    const source = await context.newPage();
    const popup = async () => {
      await source.bringToFront(); const before = new Set(context.pages());
      await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), url);
      await expect.poll(() => context.pages().some((p) => !before.has(p) && p.url() === url)).toBe(true);
      const page = context.pages().find((p) => !before.has(p) && p.url() === url)!;
      await page.waitForLoadState('domcontentloaded'); return page;
    };
    try { await use({ context, fixtures, source, popup }); }
    finally { await context.close(); await fixtures.close(); await rm(directory, { recursive: true, force: true }); }
  },
});
