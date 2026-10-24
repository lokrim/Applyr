import { expect, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { test } from '../fixtures/inspection-extension';
import type { Response } from '../../src/runtime/schemas';

declare const chrome: typeof browser;
async function request(page: Page, intent: object) {
  const result = await page.evaluate((intent) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), ...intent }), intent) as Response;
  expect(result).toMatchObject({ ok: true }); if (!result.ok) throw new Error(result.code); return result;
}
async function current(page: Page) { return (await request(page, { type: 'GET_STATE', sessionId: null, revision: null })).checkpoint!; }

for (const challenge of [false, true]) test(`embedded ${challenge ? 'challenge' : 'unsupported area'} Recheck retains its frame across reopen and observes manual completion`, async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/F01`);
  await source.evaluate(() => { const f = document.createElement('iframe'); f.title = 'Embedded job application'; f.src = '/embedded'; document.body.append(f); });
  const embedded = source.frameLocator('iframe'); await expect(embedded.locator('form')).toBeVisible();
  await embedded.locator('form').evaluate((form, challenge) => {
    if (challenge) {
      const gate = document.createElement('div'); gate.id = 'captcha'; gate.textContent = 'Complete manually'; form.append(gate);
      const secret = document.createElement('input'); secret.type = 'password'; secret.value = 'AUTH_CANARY'; form.append(secret);
    } else { const widget = document.createElement('div'); widget.role = 'combobox'; widget.setAttribute('aria-label', 'Embedded manual widget'); widget.textContent = 'Choose'; form.append(widget); }
  }, challenge);
  const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
  let cp = await current(session); const frame = cp.access!.frames.find((f) => f.url.endsWith('/embedded'))!;
  expect(frame).toBeTruthy();
  const inspected = await request(session, { type: 'INSPECT_FORM', sessionId: cp.id, revision: cp.revision, frameOrigin: frame.origin, frameIdentity: frame.identity });
  const item = inspected.checkpoint!.attention!.items.find((i) => challenge ? i.code === 'captcha' : i.question === 'Embedded manual widget')!;
  expect(item.context!.frameId).toBeGreaterThan(0); expect(item.target).toBeUndefined();
  const frameId = item.context!.frameId, worker = context.serviceWorkers()[0]!;
  await worker.evaluate(async ({ tabId, frameId }) => { await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'ISOLATED', func: () => {
    (globalThis as unknown as { authReads: number }).authReads = 0;
    for (const e of document.querySelectorAll('input[type=password], input[autocomplete=one-time-code]')) Object.defineProperty(e, 'value', { get() { (globalThis as unknown as { authReads: number }).authReads++; throw new Error('AUTH_READ'); } });
  } }); }, { tabId: cp.target.tabId, frameId });
  await session.reload();
  const row = session.getByTestId('attention-item').filter({ hasText: challenge ? /captcha/ : 'Embedded manual widget' });
  await row.getByRole('button', { name: /^Recheck:/ }).click();
  await expect(session.getByRole('region', { name: 'Attention queue' })).toContainText('Fresh observations saved.');
  cp = await current(session); expect(cp.attention!.items.find((i) => i.id === item.id)?.status).toBe('open');
  await embedded.locator('form').evaluate((form) => { form.querySelector('#captcha')?.remove(); form.querySelector('input[type=password]')?.remove(); form.querySelector('[role=combobox]')?.remove(); });
  await row.getByRole('button', { name: /^Recheck:/ }).click();
  await expect(row).toHaveCount(0);
  cp = await current(session); expect(cp.attention!.items.find((i) => i.id === item.id)?.status).toBe('stale');
  expect(cp.attention!.items.some((i) => i.key.endsWith(':selection') && i.status === 'open')).toBe(false);
  expect(await source.evaluate(() => (window as unknown as { fixture: { inputEvents: number; finalizations: number } }).fixture)).toMatchObject({ inputEvents: 0, finalizations: 0 });
  const reads = await worker.evaluate(async ({ tabId, frameId }) => (await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'ISOLATED', func: () => (globalThis as unknown as { authReads: number }).authReads }))[0]?.result, { tabId: cp.target.tabId, frameId });
  expect(reads).toBe(0); expect(JSON.stringify(cp)).not.toContain('AUTH_CANARY');
  await info.attach('embedded-attention', { body: JSON.stringify({ browser: context.browser()!.version(), code: item.code, context: item.context, authReads: reads, finalStatus: 'stale after own-frame observation', rootEffects: 0 }), contentType: 'application/json' });
});
