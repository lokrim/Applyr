import { expect, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { test } from '../fixtures/inspection-extension';
import type { Response } from '../../src/runtime/schemas';

declare const chrome: typeof browser;
const profile = `---\nprofile_version: 1\nidentity: {legal_name: Alex Fiction}\ncontact: {email: alex@example.test}\npreferences: {work_arrangements: [remote, onsite]}\n---\n`;
async function request(page: Page, intent: object): Promise<Response> { return page.evaluate((intent) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), ...intent }), intent); }
async function current(page: Page) { const r = await request(page, { type: 'GET_STATE', sessionId: null, revision: null }); if (!r.ok || !r.checkpoint) throw new Error('Missing checkpoint'); return r.checkpoint; }
async function freeze(page: Page) {
  await page.locator('.profile-workspace input[type=file]').setInputFiles({ name: 'fictional.md', mimeType: 'text/markdown', buffer: Buffer.from(profile) });
  await page.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click(); await expect(page.getByTestId('frozen-profile-state')).toBeVisible();
}

test('packaged attention batch persists across UI reload, keyboard review, explicit Start and manual declaration reinspection', async ({ inspector }, info) => {
  test.setTimeout(90_000);
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/M06`); const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session);
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  const queue = session.getByRole('region', { name: 'Attention queue', exact: true });
  await expect(queue.getByTestId('attention-item').filter({ hasText: 'First name' })).toBeVisible();
  await expect(queue.getByTestId('attention-item').filter({ hasText: 'I certify my answers' })).toContainText('consent');
  const cp = await current(session); expect(cp.attention?.items.filter((i) => i.status === 'open').length).toBeGreaterThan(3);
  const first = queue.getByRole('textbox', { name: 'Session answer — First name', exact: true });
  await first.focus(); await expect(first).toBeFocused(); await session.keyboard.type('Alex'); await session.keyboard.press('Tab');
  expect(await first.evaluate((e) => e === document.activeElement)).toBe(false);
  await queue.getByRole('textbox', { name: 'Session answer — Last name', exact: true }).fill('Fiction');
  await queue.getByRole('button', { name: 'Use for this application', exact: true }).click();
  await expect(queue).toContainText('Batch reviewed and saved');
  await expect(source.getByLabel('First name', { exact: true })).toHaveValue('');
  const stored = await current(session); const firstId = stored.attention!.items.find((i) => i.question === 'First name')!.id;
  expect(stored.attention!.items.find((i) => i.id === firstId)!.status).toBe('answer_ready');
  await session.reload(); await expect(queue).toContainText('Reviewed answer: Alex');
  expect((await current(session)).attention!.items.find((i) => i.id === firstId)!.correction!.value).toBe('Alex');
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await expect(queue).toContainText('Reviewed answer: Alex');
  await session.getByRole('button', { name: 'Start Autofill', exact: true }).click();
  await expect(source.getByLabel('First name', { exact: true })).toHaveValue('Alex'); await expect(source.getByLabel('Last name', { exact: true })).toHaveValue('Fiction');
  await expect(session.getByTestId('autofill-results')).toContainText('Autofill status: review', { timeout: 20000 });
  await expect(source.getByLabel('I certify my answers')).not.toBeChecked();
  const declaration = queue.getByTestId('attention-item').filter({ hasText: 'I certify my answers' });
  await source.getByLabel('I certify my answers').check();
  await declaration.getByRole('button', { name: 'Recheck: I certify my answers', exact: true }).click();
  await expect(queue.getByTestId('attention-item').filter({ hasText: 'I certify my answers' })).toHaveCount(0);
  const summary = queue.getByRole('status').first(); await expect(summary).toHaveAttribute('aria-live', 'polite');
  await queue.evaluate((e) => e.scrollIntoView({ block: 'start' })); await session.screenshot({ path: info.outputPath('attention-queue.png') });
  await info.attach('attention-browser', { body: JSON.stringify({ browser: context.browser()!.version(), attention: (await current(session)).attention, notificationTest: 'disabled; no OS delivery tested', keyboard: 'actual Tab navigation and stable labelled input; no screen reader' }), contentType: 'application/json' });
});

test('Show field validates stale identity/frame, uses generic markers without focus, and cancel clears markers', async ({ inspector }) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/M06`); const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session);
  await source.getByLabel('Email', { exact: true }).focus();
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  const active = await source.evaluate(() => (document.activeElement as HTMLInputElement)?.type); expect(active).toBe('email');
  const queue = session.getByRole('region', { name: 'Attention queue' });
  await queue.getByRole('button', { name: 'Show field: First name', exact: true }).click();
  await expect(queue).toContainText('Field marked on the original page.');
  expect(await source.evaluate(() => (document.activeElement as HTMLInputElement)?.type)).toBe('email');
  const cp = await current(session), item = cp.attention!.items.find((i) => i.question === 'First name')!;
  const worker = context.serviceWorkers()[0]!;
  const marker = () => worker.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => {
    const m = (globalThis as unknown as { __applyrMarkers?: unknown }).__applyrMarkers;
    return { installed: !!m, text: document.documentElement.textContent?.includes('Reviewed answer: Alex') };
  } }))[0]?.result, cp.target.tabId);
  expect(await marker()).toEqual({ installed: true, text: false });
  await source.getByLabel('First name', { exact: true }).evaluate((e) => e.replaceWith(e.cloneNode(true)));
  const stale = await request(session, { type: 'SHOW_ATTENTION', sessionId: cp.id, revision: cp.revision, itemId: item.id }); expect(stale).toMatchObject({ ok: false, code: 'ACCESS_UNAVAILABLE' });
  await queue.getByRole('button', { name: 'Reinspect attention items', exact: true }).click();
  await session.getByRole('button', { name: 'Cancel session', exact: true }).click();
  await expect(queue).toContainText('Session ended');
  const hosts = () => worker.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => Array.from(document.documentElement.children).filter((e) => e.localName === 'div').length }))[0]?.result, cp.target.tabId);
  await expect.poll(hosts).toBe(0);
});

test('auth/challenge gate never reads password or OTP, never stores their values and resolves only after the page changes', async ({ inspector }) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/F09`); const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('login_challenge');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
  const cp = await current(session), worker = context.serviceWorkers()[0]!;
  await worker.evaluate(async (tabId) => { await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => {
    (globalThis as unknown as { authReads: number }).authReads = 0;
    for (const e of document.querySelectorAll('input')) Object.defineProperty(e, 'value', { get() { (globalThis as unknown as { authReads: number }).authReads++; throw new Error('AUTH_VALUE_READ'); } });
  } }); }, cp.target.tabId);
  const queue = session.getByRole('region', { name: 'Attention queue' });
  await queue.getByRole('button', { name: 'Reinspect attention items', exact: true }).click();
  await expect(queue).toContainText('Never enter codes in applyr');
  const state = await current(session); expect(JSON.stringify(state)).not.toMatch(/F05_.*CANARY|AUTH_VALUE_READ/);
  expect(await worker.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => (globalThis as unknown as { authReads: number }).authReads }))[0]?.result, cp.target.tabId)).toBe(0);
  await source.evaluate(() => { document.querySelector('form')!.innerHTML = '<label>Full name<input name="name" required></label><label>Email<input type="email" name="email" required></label>'; document.querySelector('h2')?.remove(); });
  await queue.getByRole('button', { name: 'Reinspect attention items', exact: true }).click();
  await expect(queue.getByTestId('attention-item').filter({ hasText: 'one-time-code gate' })).toHaveCount(0);
});

test('actual generic action badge is set for multiple blockers and clears on cancel; notifications remain opt-in', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/M06`); const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session); await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  const badge = () => session.evaluate(async () => ({ text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}) }));
  await expect.poll(badge).toEqual({ text: '!', title: 'applyr: needs attention' });
  const setting = await session.evaluate(async () => ({ settings: await chrome.storage.local.get('attention-alerts'), grant: await chrome.permissions.contains({ permissions: ['notifications'] }) }));
  expect(setting.grant).toBe(false); expect(setting.settings).toEqual({});
  await session.getByRole('button', { name: 'Cancel session', exact: true }).click(); await expect.poll(badge).toEqual({ text: '', title: 'applyr' });
  await info.attach('actual-badge', { body: JSON.stringify({ browser: context.browser()!.version(), blockedBadge: '!', cancelledBadge: '', notifications: 'off, native request and OS delivery not run' }), contentType: 'application/json' });
});

test.describe('native notification API with a test-only installation grant', () => {
  test.use({ notificationGrants: true });
  test('actual create/getAll, generic one-batch delivery, reload deduplication and opt-out', async ({ inspector }, info) => {
    const { source, fixtures, context } = inspector;
    await source.goto(`${fixtures.origin}/M06`); const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
    const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session);
    await session.evaluate(() => chrome.storage.local.set({ 'attention-alerts': { enabled: true, seen: [], links: [] } }));
    await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
    const notifications = () => session.evaluate(() => chrome.notifications.getAll());
    await expect.poll(async () => Object.keys(await notifications()).length).toBe(1);
    const initial = Object.keys(await notifications());
    await session.reload(); await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
    expect(Object.keys(await notifications())).toEqual(initial);
    const state = await session.evaluate(async () => (await chrome.storage.local.get('attention-alerts'))['attention-alerts']);
    expect((state as { seen: string[] }).seen.length).toBeGreaterThan(3); expect(JSON.stringify(state)).not.toMatch(/Email|First name|alex|127\.0/);
    const options = await context.newPage(); await options.goto(popup.url().replace('popup.html', 'options.html'));
    await options.getByRole('button', { name: 'Disable notifications', exact: true }).click();
    await expect.poll(async () => session.evaluate(async () => ((await chrome.storage.local.get('attention-alerts'))['attention-alerts'] as { enabled: boolean }).enabled)).toBe(false);
    await expect.poll(() => session.evaluate(() => chrome.action.getBadgeText({}))).toBe('!');
    await expect(session.getByRole('region', { name: 'Attention queue' }).getByTestId('attention-item').first()).toBeVisible();
    await info.attach('native-notification-api', { body: JSON.stringify({ browser: context.browser()!.version(), nativeApi: 'create/getAll verified; one id persisted across reload/reinspection', grant: 'test-only install grant; native opt-in/denial dialog not tested', osPresentation: 'headless, toast appearance/click and screen-reader not tested', optOut: 'actual settings opt-out and notification clear; queue and badge usable', revocation: 'not native-tested: installation grant is required and cannot be removed; covered by unit permission simulations' }), contentType: 'application/json' });
  });
});
