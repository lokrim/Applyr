import { expect, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { readFile } from 'node:fs/promises';
import { test } from '../fixtures/inspection-extension';
import type { Response } from '../../src/runtime/schemas';
import { syntheticPdf } from '../fixtures/pdf';

declare const chrome: typeof browser;
const canary = 'P12_EXPORT_KEY_CANARY', answer = 'P12_DETAILED_ANSWER_CANARY';
const profile = `---\nprofile_version: 1\nidentity: {legal_name: Alex Fiction}\ncontact: {email: alex@example.test}\n---\n${answer}\n`;
async function request(page: Page, intent: object) {
  const r = await page.evaluate((intent) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), ...intent }), intent) as Response;
  expect(r, `Request ${JSON.stringify(intent).slice(0, 60)} returned ${JSON.stringify(r)}`).toMatchObject({ ok: true }); if (!r.ok) throw new Error(r.code); return r;
}
async function current(page: Page) { return (await request(page, { type: 'GET_STATE', sessionId: null, revision: null })).checkpoint!; }
async function start(session: Page) {
  const cp = await current(session), observed = await request(session, { type: 'INSPECT_FORM', sessionId: cp.id, revision: cp.revision });
  const inputVersion = await session.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => resolve(q.result); });
    return new Promise<string>((resolve) => { const q = db.transaction('profiles').objectStore('profiles').get('snapshot'); q.onsuccess = () => { db.close(); resolve(q.result.version); }; });
  });
  await request(session, { type: 'START_AUTOFILL', sessionId: cp.id, revision: observed.checkpoint!.revision, runId: crypto.randomUUID(), inspection: observed.inspection, inputVersion, corrections: [], resume: null });
}
async function importProfile(page: Page) { await page.locator('.profile-workspace input[type=file]').setInputFiles({ name: 'fiction.md', mimeType: 'text/markdown', buffer: Buffer.from(profile) }); }
async function stores(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => resolve(q.result); });
    const all: Record<string, unknown[]> = {};
    for (const name of db.objectStoreNames) all[name] = await new Promise<unknown[]>((resolve) => { const q = db.transaction(name).objectStore(name).getAll(); q.onsuccess = () => resolve(q.result); });
    db.close(); return all;
  });
}

test('AC-19/20 actual review counts, manual repair, blocked final review, independent finish and explicit user report', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector; await source.goto(`${fixtures.origin}/F10`);
  const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application'); const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
  await importProfile(session); await session.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click(); await expect(session.getByTestId('frozen-profile-state')).toBeVisible();
  await start(session);
  await expect(session.getByTestId('review-counts')).toContainText('2 accepted fills');
  await expect(session.getByRole('heading', { name: 'Current step ready for review', exact: true })).toBeVisible();
  await expect(source.getByLabel('Email', { exact: true })).toHaveValue('alex@example.test');
  await session.getByRole('button', { name: 'I am reviewing the final step', exact: true }).click();
  await expect(session.getByRole('heading', { name: 'Autofill finished — review and submit on the website', exact: true })).toBeVisible();
  // Website rerender removes a previously accepted value. Fresh final-review intent must refuse.
  await source.getByLabel('Email', { exact: true }).fill('');
  let cp = await current(session);
  const rejected = await session.evaluate((cp) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'FINAL_REVIEW', sessionId: cp.id, revision: cp.revision }), cp);
  expect(rejected).toMatchObject({ ok: false, code: 'ACCESS_UNAVAILABLE' });
  await expect(session.getByTestId('review-counts')).toContainText('1 accepted fills');
  await expect(session.getByRole('heading', { name: 'Review required — unresolved or unverified items', exact: true })).toBeVisible();
  await source.getByLabel('Email', { exact: true }).fill('manual@example.test');
  cp = await current(session); await request(session, { type: 'REINSPECT_ATTENTION', sessionId: cp.id, revision: cp.revision });
  await expect(session.getByTestId('review-counts')).toContainText('1 manually completed / existing values');
  await session.getByRole('button', { name: 'I am reviewing the final step', exact: true }).click();
  await expect(session.getByRole('heading', { name: 'Autofill finished — review and submit on the website', exact: true })).toBeVisible();
  await session.getByTestId('autofill-results').screenshot({ path: info.outputPath('field-review.png') });
  await session.getByRole('button', { name: 'Finish autofill session', exact: true }).click();
  await expect(session.getByRole('heading', { name: 'Session: autofill finished', exact: true })).toBeVisible();
  cp = await current(session); expect(cp.submission.status).toBe('unknown'); expect((await stores(session)).profiles).toEqual([]);
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);
  // Explicit test-driver user action on the owned fixture only. Its submit
  // handler prevents navigation/network; the extension never clicks this.
  await source.evaluate(() => { const button = document.createElement('button'); button.type = 'submit'; button.textContent = 'User submits owned fixture'; document.querySelector('form')!.append(button); });
  await source.getByRole('button', { name: 'User submits owned fixture', exact: true }).click();
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(1);
  expect((await current(session)).submission.status).toBe('unknown');
  await session.getByRole('button', { name: 'I submitted it', exact: true }).click();
  await expect.poll(async () => (await current(session)).submission.status).toBe('reported_by_user');
  cp = await current(session); expect(cp.submission).toMatchObject({ status: 'reported_by_user', source: 'user', reportedAt: expect.any(Number) });
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(1);
  expect(fixtures.requests.every((r) => r.method === 'GET')).toBe(true);
});

test('AC-16 duplicate tracking URLs require view/resume or deliberate separate-run before a new tab/session', async ({ inspector }) => {
  const { source, fixtures, context } = inspector; await source.goto(`${fixtures.origin}/F10?job_id=17&utm_source=first`);
  const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application'); const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
  const cp = await current(session), before = context.pages().length;
  await session.getByLabel('Manual application URL', { exact: true }).fill(`${fixtures.origin}/F10?job_id=17&utm_source=second&token=SECRET_CANARY`);
  await session.getByRole('button', { name: 'Open application', exact: true }).click();
  const notice = session.getByRole('region', { name: 'Duplicate application' }); await expect(notice).toBeVisible();
  expect((await current(session)).id).toBe(cp.id); expect(context.pages()).toHaveLength(before);
  await notice.getByRole('button', { name: 'View existing application', exact: true }).click(); await expect(notice).toContainText('Submission: unknown');
  await notice.getByRole('button', { name: 'Resume existing session', exact: true }).click(); await expect(notice).not.toBeVisible(); expect((await current(session)).id).toBe(cp.id);
  await session.getByRole('button', { name: 'Open application', exact: true }).click(); await expect(notice).toBeVisible();
  const createdTab = context.waitForEvent('page');
  await notice.getByRole('button', { name: 'Start explicit separate run', exact: true }).click();
  await createdTab;
  await expect.poll(async () => (await current(session)).id).not.toBe(cp.id);
  expect((await stores(session)).history!).toHaveLength(2);
  for (const record of (await stores(session)).history!) { expect(JSON.stringify(record)).not.toContain('SECRET_CANARY'); expect(JSON.stringify(record)).not.toContain('utm_'); }
  await expect.poll(() => context.pages().length).toBe(before + 1);
});

test('packaged exports/help and confirmed independent deletion remove sensitive copies without leaking answers/keys', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector; await source.goto(`${fixtures.origin}/F10?job_id=22&token=URL_SECRET`);
  const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application'); const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
  await importProfile(session); await session.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click(); await expect(session.getByTestId('frozen-profile-state')).toBeVisible();
  const options = await context.newPage(); await options.goto(popup.url().replace('popup.html', 'options.html'));
  await importProfile(options); await options.getByRole('button', { name: 'Save as default', exact: true }).click(); await expect(options.getByTestId('saved-profile-state')).toContainText('Saved default');
  await options.locator('.document-workspace input[type=file]').setInputFiles({ name: 'fiction.pdf', mimeType: 'application/pdf', buffer: Buffer.from(syntheticPdf()) });
  await options.getByLabel('Save as reusable resume', { exact: false }).check(); await options.getByRole('button', { name: 'Save selected resume as default', exact: true }).click(); await expect(options.getByRole('button', { name: 'Delete saved resume', exact: true })).toBeVisible();
  await options.evaluate(async (key) => { await chrome.storage.session.set({ 'provider-key:openai': key }); }, canary);
  await start(session);
  // Seed a remembered key only after provider status has loaded; no provider request occurs.
  await options.evaluate(async (key) => { const db = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => r(q.result); }); await new Promise<void>((r) => { const tx = db.transaction('providerCredentials', 'readwrite'); tx.objectStore('providerCredentials').put(key, 'openai'); tx.oncomplete = () => r(); }); db.close(); }, canary);
  const download = options.waitForEvent('download'); await options.getByRole('button', { name: 'Export history JSON', exact: true }).click(); const file = await download; expect(file.suggestedFilename()).toBe('applyr-history.json');
  const text = await readFile((await file.path())!, 'utf8'); expect(JSON.parse(text).applications).toHaveLength(1);
  for (const denied of [canary, answer, 'URL_SECRET', 'precondition', 'recovery', 'fileBytes']) expect(text).not.toContain(denied);
  const diagnosticEvent = options.waitForEvent('download'); await options.getByRole('button', { name: 'Export redacted diagnostics', exact: true }).click(); const diagnostic = await diagnosticEvent;
  const diagnosticText = await readFile((await diagnostic.path())!, 'utf8'); expect(diagnosticText).not.toContain(canary); expect(diagnosticText).not.toContain(answer);
  const templateEvent = options.waitForEvent('download'); await options.getByRole('button', { name: 'Get blank profile template', exact: true }).click(); const template = await templateEvent; expect(template.suggestedFilename()).toBe('applyr-blank-template.md'); expect(await readFile((await template.path())!, 'utf8')).toContain('profile_version: 1');
  // Every built-in settings anchor resolves to a real section.
  expect(await options.locator('#help a[href^="#"]').evaluateAll((links) => links.every((a) => !!document.querySelector(a.getAttribute('href')!)))).toBe(true);
  const beforeDelete = await current(session), row = beforeDelete.review!.items[0]!;
  await request(session, { type: 'SHOW_REVIEW', sessionId: beforeDelete.id, revision: beforeDelete.revision, fieldId: row.fieldId });
  const marker = () => context.serviceWorkers()[0]!.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => !!(globalThis as unknown as { __applyrMarkers?: unknown }).__applyrMarkers }))[0]?.result, beforeDelete.target.tabId);
  await expect.poll(marker).toBe(true);
  await options.getByRole('button', { name: 'Delete profile and recovery copies', exact: true }).click();
  expect((await stores(options)).profiles!.length).toBeGreaterThan(0);
  await options.getByRole('button', { name: 'Confirm delete profile and sensitive recovery', exact: true }).click();
  await expect.poll(async () => (await stores(options)).profiles).toEqual([]);
  await expect(options.locator('#privacy').getByRole('status')).toContainText('Selected local data deleted.');
  const remaining = await stores(options); expect(remaining.history).toHaveLength(1); expect(remaining.documents).toHaveLength(1); expect(remaining.providerCredentials).toEqual([canary]); expect(JSON.stringify(remaining.checkpoints)).not.toContain(answer);
  await expect(session.getByTestId('frozen-profile-state')).not.toBeVisible(); await expect.poll(marker).toBe(false);
  await options.getByRole('button', { name: 'Delete history and unsaved recovery', exact: true }).click(); await options.getByRole('button', { name: 'Confirm delete history and unsaved recovery', exact: true }).click();
  await expect.poll(async () => (await stores(options)).history).toEqual([]); expect((await stores(options)).documents).toHaveLength(1);
  await options.locator('#privacy').screenshot({ path: info.outputPath('data-controls.png') });
  await options.getByRole('button', { name: 'Delete all applyr data', exact: true }).click(); await options.getByRole('button', { name: 'Confirm delete all applyr data', exact: true }).click();
  await expect.poll(async () => Object.values(await stores(options)).every((x) => x.length === 0)).toBe(true);
  await expect(options.locator('#privacy').getByRole('status')).toContainText('Selected local data deleted.');
  await expect.poll(async () => options.evaluate(async () => chrome.storage.session.get(null))).toEqual({});
  await expect.poll(async () => options.evaluate(async () => chrome.storage.local.get(null))).toEqual({});
  await expect.poll(async () => options.evaluate(async () => chrome.action.getBadgeText({}))).toBe('');
  const staleSave = await options.evaluate(async (key) => chrome.runtime.sendMessage({ channel: 'providers', schemaVersion: 1, requestId: crypto.randomUUID(), type: 'SAVE', provider: 'openai', config: { schemaVersion: 1, provider: 'openai', revision: 0, model: 'stale-model', workspace: '', remember: true, candidateConsent: false, paidServiceConfirmed: false }, key }), canary);
  expect(staleSave).toMatchObject({ ok: false, code: 'stale' });
  expect(Object.values(await stores(options)).every((x) => x.length === 0)).toBe(true);
  expect(await options.evaluate(async () => chrome.storage.session.get(null))).toEqual({});
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);
});
