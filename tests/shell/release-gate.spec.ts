import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { test } from '../fixtures/inspection-extension';
import type { Response } from '../../src/runtime/schemas';

declare const chrome: typeof browser;
const secret = 'P15_SYNTHETIC_CREDENTIAL_DO_NOT_EXPORT';
const profile = '---\nprofile_version: 1\nidentity: {legal_name: Alex Fiction}\ncontact: {email: gate@example.test}\n---\n';
async function request(page: Page, intent: object) {
  const response = await page.evaluate((intent) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), ...intent }), intent) as Response;
  expect(response).toMatchObject({ ok: true }); if (!response.ok) throw new Error(response.code); return response;
}
async function current(page: Page) { return (await request(page, { type: 'GET_STATE', sessionId: null, revision: null })).checkpoint!; }
async function setup(inspector: { popup: () => Promise<Page>; context: BrowserContext }) {
  const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await inspector.context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
  await session.locator('.profile-workspace input[type=file]').setInputFiles({ name: 'gate.md', mimeType: 'text/markdown', buffer: Buffer.from(profile) });
  await session.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click(); await expect(session.getByTestId('frozen-profile-state')).toBeVisible();
  return { popup, session };
}
async function start(page: Page) {
  const before = await current(page), observed = await request(page, { type: 'INSPECT_FORM', sessionId: before.id, revision: before.revision });
  const version = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => resolve(q.result); });
    return new Promise<string>((resolve) => { const q = db.transaction('profiles').objectStore('profiles').get('snapshot'); q.onsuccess = () => { db.close(); resolve(q.result.version); }; });
  });
  return request(page, { type: 'START_AUTOFILL', sessionId: before.id, revision: observed.checkpoint!.revision, inspection: observed.inspection, inputVersion: version, runId: crypto.randomUUID(), corrections: [], resume: null });
}

test('release gate: actual isolated senders, inert injection, credential canary and no-AI network boundary', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector;
  const logs: string[] = [], outgoing: string[] = [];
  context.on('console', (message) => logs.push(message.text()));
  await context.addInitScript(() => {
    (globalThis as unknown as { cspViolations: string[] }).cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => (globalThis as unknown as { cspViolations: string[] }).cspViolations.push(event.violatedDirective));
  });
  context.on('request', (r) => { if (/^https?:/.test(r.url())) outgoing.push(`${r.url()} ${r.postData() ?? ''}`); });
  const worker = context.serviceWorkers()[0]!;
  await source.goto(`${fixtures.origin}/F08`); const { session } = await setup(inspector);
  await session.evaluate((key) => chrome.storage.session.set({ 'provider-key:openai': key }), secret);
  const cp = await current(session);
  const attack = await worker.evaluate(async ({ tabId, sessionId, revision }) => {
    return (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: async (sessionId: string, revision: number) => {
      let sessionReadable = false;
      try { sessionReadable = Object.keys(await chrome.storage.session.get(null)).some((k) => k.startsWith('provider-key:')); } catch { /* trusted-only API */ }
      const messages = [
        { type: 'GET_STATE', sessionId: null, revision: null },
        { channel: 'providers', type: 'GET_KEY', provider: 'openai' },
        { channel: 'providers', type: 'STATUS', provider: 'openai' },
        { channel: 'ai', type: 'PREPARE', sessionId, revision },
        { type: 'FINAL_REVIEW', sessionId, revision },
        { type: 'REPORT_SUBMISSION', sessionId, revision },
        { type: 'DELETE_DATA', scope: 'all', sessionId, revision },
        { type: 'EXECUTE_SCRIPT', selector: 'form', script: 'submit()', sessionId, revision },
        { type: 'FETCH', url: 'https://evil.invalid', sessionId, revision },
      ];
      const responses = [];
      for (const message of messages) responses.push(await chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), ...message }));
      return { sessionReadable, responses };
    }, args: [sessionId, revision] }))[0]!.result;
  }, { tabId: cp.target.tabId, sessionId: cp.id, revision: cp.revision });
  expect(attack?.sessionReadable).toBe(false);
  expect(attack?.responses).toHaveLength(9);
  for (const response of attack!.responses) expect(response).toMatchObject({ ok: false });
  expect(JSON.stringify(attack)).not.toContain(secret);
  const invalid = await session.evaluate(() => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'EXECUTE_SCRIPT', selector: 'form', script: 'submit()' }));
  expect(invalid).toMatchObject({ ok: false });
  await start(session);
  await expect(source.getByLabel('Full name', { exact: true })).toHaveValue('Alex Fiction');
  await expect(source.getByLabel('Email', { exact: true })).toHaveValue('gate@example.test');
  const after = await current(session);
  expect(after.reviewScope).toBe('current_step'); expect(after.submission.status).toBe('unknown');
  expect(after.attention?.items.some((item) => item.status === 'open')).toBe(true);
  const final = await session.evaluate((cp) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'FINAL_REVIEW', sessionId: cp.id, revision: cp.revision }), after);
  expect(final).toMatchObject({ ok: false });
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number }; F05_ATTACK?: boolean }).fixture.finalizations)).toBe(0);
  expect(await session.locator('body').innerText()).not.toContain(secret);
  expect(await source.content()).not.toContain(secret);
  expect(await session.locator('img[src="x"], script:not([src])').count()).toBe(0);
  expect(await source.evaluate(() => (window as unknown as { F05_ATTACK?: boolean }).F05_ATTACK)).toBeUndefined();
  expect(logs.join('\n')).not.toContain(secret); expect(outgoing.join('\n')).not.toContain(secret);
  expect(await session.evaluate(() => (globalThis as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
  expect(outgoing.every((url) => url.startsWith(fixtures.origin) || url.startsWith(fixtures.cross))).toBe(true);
  expect(fixtures.requests.filter((r) => r.method === 'POST')).toEqual([]);
  await info.attach('release-security', { body: JSON.stringify({ browser: context.browser()!.version(), deniedContentMessages: attack!.responses.length, credentialLeaks: 0, unauthorizedRequests: 0, finalizations: 0, falseFinalReady: 0, transport: 'no AI request; test-only loopback grant' }), contentType: 'application/json' });
});

test('release gate: keyboard names, focus, errors and narrow/zoom layout on packaged surfaces', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector; await source.goto(`${fixtures.origin}/F10`);
  const { popup, session } = await setup(inspector);
  const options = await context.newPage(); await options.goto(popup.url().replace('popup.html', 'options.html'));
  const layouts = [];
  for (const page of [popup, session, options]) {
    for (const [width, zoom] of [[320, 1], [640, 2]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((zoom) => { document.documentElement.style.zoom = String(zoom); }, zoom);
      const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, zoom: getComputedStyle(document.documentElement).zoom }));
      expect(layout.scroll, `${page.url()} at ${width}/${zoom}`).toBeLessThanOrEqual(layout.width + 1); layouts.push(layout);
    }
    await page.evaluate(() => { document.documentElement.style.zoom = '1'; }); await page.setViewportSize({ width: 390, height: 900 });
    const controls = page.locator('button:visible, input:visible, select:visible, textarea:visible, summary:visible, a:visible');
    for (const control of await controls.all()) await expect(control).toHaveAccessibleName(/\S/);
    // Traverse from the browser's initial focus, exercising actual keyboard Tab.
    await page.reload(); await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => { const e = document.activeElement!; const s = getComputedStyle(e); return { tag: e.tagName, style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
      expect(focused.tag).not.toBe('BODY'); expect(focused.style).not.toBe('none'); expect(focused.width).toBeGreaterThan(0);
    }
  }
  const url = session.getByLabel('Manual application URL', { exact: true }); await url.focus(); await session.keyboard.type('https://');
  await session.getByRole('button', { name: 'Open application', exact: true }).click();
  // Native invalidity or a live extension error must prevent navigation.
  expect(await url.evaluate((e) => (e as HTMLInputElement).validity.valid)).toBe(false);
  await options.getByLabel('Model ID', { exact: true }).fill('invalid model with spaces');
  await options.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect(options.getByRole('alert')).toBeVisible();
  const opened = context.waitForEvent('page'); await popup.getByRole('button', { name: 'Open in tab', exact: true }).click();
  const fallback = await opened; await expect(fallback).toHaveURL(session.url());
  await expect(fallback.getByTestId('checkpoint-id')).toHaveText((await current(session)).id); await fallback.close();
  await options.screenshot({ path: info.outputPath('settings-keyboard.png') });
  await info.attach('release-accessibility', { body: JSON.stringify({ browser: context.browser()!.version(), layouts, namedVisibleControls: true, keyboardTabsPerSurface: 8, errors: 'native validity plus role=alert', zoom: 'CSS 200% reflow simulation; native browser zoom and human screen reader remain not run' }), contentType: 'application/json' });
});

test('release gate: persisted fixture metrics and paired scripted entry/assistance timing', async ({ inspector }, info) => {
  test.setTimeout(90_000);
  const { source, fixtures, context } = inspector; await source.goto(`${fixtures.origin}/F10`);
  const { session } = await setup(inspector);
  const pairs = [];
  for (let index = 0; index < 5; index++) {
    const manual = await context.newPage(); await manual.goto(`${fixtures.origin}/F10`);
    const manualBegin = performance.now();
    await manual.getByLabel('Full name', { exact: true }).fill('Alex Fiction'); await manual.getByLabel('Email', { exact: true }).fill('gate@example.test');
    await expect(manual.getByLabel('Full name', { exact: true })).toHaveValue('Alex Fiction'); await expect(manual.getByLabel('Email', { exact: true })).toHaveValue('gate@example.test');
    const scriptedEntryMs = performance.now() - manualBegin;
    await source.reload();
    // Explicit user resume only observes and authorizes no writes.
    await expect.poll(async () => (await current(session)).recovery?.inspectionRequired).toBe(true);
    let cp = await current(session);
    if (cp.access?.status !== 'ready') { await request(session, { type: 'PROBE_TARGET', sessionId: cp.id, revision: cp.revision }); cp = await current(session); }
    await request(session, { type: 'RESUME_SESSION', sessionId: cp.id, revision: cp.revision });
    const assistedBegin = performance.now(); await start(session);
    await expect(source.getByLabel('Full name', { exact: true })).toHaveValue('Alex Fiction'); await expect(source.getByLabel('Email', { exact: true })).toHaveValue('gate@example.test');
    const assistedMs = performance.now() - assistedBegin;
    const completed = await current(session);
    const accepted = completed.review?.items.filter((i) => i.status === 'accepted').length;
    expect(accepted).toBe(2); expect(completed.reviewScope).toBe('current_step'); expect(completed.submission.status).toBe('unknown');
    expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);
    await expect(manual.getByLabel('Email', { exact: true })).toHaveValue('gate@example.test');
    pairs.push({ scriptedEntryMs, assistedMs, correctPersisted: 2, attempted: 2, eligible: 2 }); await manual.close();
  }
  await info.attach('release-metrics', { body: JSON.stringify({ browser: context.browser()!.version(), fixture: 'F10 two required native fields; no uploads, consent or missing facts', sampleSize: pairs.length, pairs, timingBoundary: 'Script-driver fill baseline versus inspect+explicit Start+verified persistence. Setup/import/navigation excluded. Not human manual timing or a real-world time-saving claim.', interventions: 'One explicit Start per measured assisted step; setup excluded', wrongTabWrites: 0, finalizations: 0 }), contentType: 'application/json' });
});

test('release gate: actual working-application browser process restart requires matching attachment and never writes automatically', async ({ inspector }, info) => {
  const { source, fixtures } = inspector; await source.goto(`${fixtures.origin}/F10`);
  const { session } = await setup(inspector); await start(session); const before = await current(session);
  const url = session.url(); await session.evaluate((key) => chrome.storage.session.set({ 'provider-key:openai': key }), secret);
  const context = await inspector.restart();
  const restored = await context.newPage(); await restored.goto(url);
  const cp = await current(restored);
  expect(cp.id).toBe(before.id); expect(cp.autofill?.operations).toEqual(before.autofill?.operations);
  expect(cp.recovery?.reattachRequired).toBe(true); expect(cp.reviewScope).not.toBe('final_review');
  expect((await restored.evaluate(() => chrome.storage.session.get(null)))['provider-key:openai']).toBeUndefined();
  const denied = await restored.evaluate((cp) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'RESUME_SESSION', sessionId: cp.id, revision: cp.revision }), cp);
  expect(denied).toMatchObject({ ok: false });
  const matching = await context.newPage(); await matching.goto(`${fixtures.origin}/F10`);
  const unrelated = await context.newPage(); await unrelated.goto(`${fixtures.origin}/F01`);
  const tabId = await restored.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, matching.url());
  let now = await current(restored);
  await request(restored, { type: 'REATTACH_SESSION', sessionId: now.id, revision: now.revision, tabId });
  now = await current(restored); await request(restored, { type: 'RESUME_SESSION', sessionId: now.id, revision: now.revision });
  await expect(matching.getByLabel('Full name', { exact: true })).toHaveValue(''); await expect(matching.getByLabel('Email', { exact: true })).toHaveValue('');
  await expect(unrelated.getByLabel('Email', { exact: true })).toHaveValue('');
  expect(await matching.evaluate(() => (window as unknown as { fixture: { inputEvents: number; finalizations: number } }).fixture.inputEvents)).toBe(0);
  expect(await matching.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);
  now = await current(restored); expect(now.submission.status).toBe('unknown'); expect(now.reviewScope).not.toBe('final_review');
  await info.attach('working-browser-restart', { body: JSON.stringify({ browser: context.browser()!.version(), realProcessCloseAndRelaunch: true, preservedOperations: before.autofill!.operations.length, sessionKeyCleared: true, matchingReattachmentRequired: true, automaticWrites: 0, wrongTabWrites: 0, finalizations: 0 }), contentType: 'application/json' });
});
