import { expect, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { test } from '../fixtures/inspection-extension';
import type { SessionCheckpoint } from '../../src/domain/session';
import type { Inspection } from '../../src/forms/schema';
import type { Response } from '../../src/runtime/schemas';

declare const chrome: typeof browser;
const profile = `---\nprofile_version: 1\nreviewed_on: "2026-10-23"\nidentity: {legal_name: Alex Fiction}\ncontact: {email: alex@example.test, phone: "+001234", address: {city: Mumbai}}\nlinks: {website: "https://example.test/"}\npreferences: {available_from: "2026-11-01", work_arrangements: [remote], relocation: true, notice_days: 0}\n---\n`;
async function freeze(session: Page) {
  await session.locator('.profile-workspace input[type=file]').setInputFiles({ name: 'fictional.md', mimeType: 'text/markdown', buffer: Buffer.from(profile) });
  await session.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click();
  await expect(session.getByTestId('frozen-profile-state')).toBeVisible();
}
async function request(page: Page, intent: object): Promise<Extract<Response, { ok: true }>> {
  const result = await page.evaluate((intent) => chrome.runtime.sendMessage({ ...intent, schemaVersion: 1, requestId: crypto.randomUUID() }), intent) as Response;
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.code);
  return result;
}
async function current(page: Page) { return (await request(page, { type: 'GET_STATE', sessionId: null, revision: null })).checkpoint!; }
async function inspect(page: Page) { const cp = await current(page); return (await request(page, { type: 'INSPECT_FORM', sessionId: cp.id, revision: cp.revision })).inspection!; }
function startIntent(cp: SessionCheckpoint, inspection: Inspection, inputVersion: string, runId: string) { return { type: 'START_AUTOFILL', sessionId: cp.id, revision: cp.revision, inspection, inputVersion, runId, corrections: [], resume: null }; }
async function inputVersion(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => r(q.result); });
    return new Promise<string>((r) => { const q = db.transaction('profiles').objectStore('profiles').get('snapshot'); q.onsuccess = () => { db.close(); r(q.result.version); }; });
  });
}

test('F01 real packaged Start writes only deterministic fields, validates required blockers, persists and deduplicates', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/F01`); const popup = await inspector.popup();
  await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session);
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await session.getByRole('button', { name: 'Start Autofill', exact: true }).click();
  const results = session.getByTestId('autofill-results'); await expect(results).toContainText('Current-step autofill: review', { timeout: 20_000 });
  await expect(results).toContainText('5 accepted');
  await expect(source.getByLabel('Email', { exact: true })).toHaveValue('alex@example.test');
  await expect(source.getByLabel('Phone', { exact: true })).toHaveValue('+001234');
  await expect(source.getByLabel('Website', { exact: true })).toHaveValue('https://example.test/');
  await expect(source.getByLabel('Start date')).toHaveValue('2026-11-01');
  await expect(source.getByLabel('Work location')).toHaveValue('remote');
  await expect(source.getByLabel('Full name', { exact: true })).toHaveValue('Alex Fiction');
  await expect(source.getByLabel('I agree to privacy terms')).not.toBeChecked();
  await results.scrollIntoViewIfNeeded(); await session.screenshot({ path: info.outputPath('autofill-results.png') });
  const cp = await current(session); expect(cp.autofill?.operations).toHaveLength(5); expect(cp.autofill?.requiredUnresolved).toBeGreaterThan(0);
  expect(cp.submission.status).toBe('unknown');
  const before = await source.evaluate(() => (window as unknown as { fixture: { inputEvents: number } }).fixture.inputEvents);
  const repeated = await request(session, { ...startIntent(cp, await inspect(session), await inputVersion(session), cp.autofill!.id) });
  expect(repeated.checkpoint?.autofill).toEqual(cp.autofill);
  expect(await source.evaluate(() => (window as unknown as { fixture: unknown }).fixture)).toMatchObject({ finalizations: 0, inputEvents: before });
  await session.reload(); await expect(session.getByTestId('autofill-results')).toContainText('5 accepted');
  expect(fixtures.requests.every((r) => r.method === 'GET')).toBe(true);
  await info.attach('native-autofill', { body: JSON.stringify({ browser: context.browser()!.version(), checkpoint: cp, requests: fixtures.requests }), contentType: 'application/json' });
});

test('F02 controlled React persisted state, rerender rejection, select and ordinary checkbox events', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/F02?writes=1`); const popup = await inspector.popup();
  await expect(popup.getByTestId('page-classification')).toHaveText('application');
  await expect(source.getByLabel('Work location')).toContainText('Hybrid');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session);
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  const box = session.getByTestId('mapping-item').filter({ hasText: 'Willing to relocate' });
  await box.getByText('Review answer for this session', { exact: true }).click();
  await box.getByLabel('Session answer', { exact: true }).selectOption('true');
  await box.getByRole('button', { name: 'Use for this application preview' }).click();
  await session.getByRole('button', { name: 'Start Autofill', exact: true }).click();
  await expect(session.getByTestId('autofill-results')).toContainText('Current-step autofill: review', { timeout: 20_000 });
  await expect(session.getByTestId('autofill-results')).toContainText('3 accepted');
  await expect(session.getByTestId('autofill-results')).toContainText('1 rejected');
  const cp = await current(session);
  await source.getByRole('button', { name: 'Rerender controlled form' }).click();
  await expect(source.getByLabel('Full name')).toHaveValue('Alex Fiction');
  await expect(source.getByLabel('Email')).toHaveValue('');
  await expect(source.getByLabel('Work location')).toHaveValue('Remote');
  await expect(source.getByLabel('Willing to relocate')).toBeChecked();
  expect(await source.evaluate(() => (window as unknown as { fixture: { accepted: unknown; finalizations: number } }).fixture)).toMatchObject({ accepted: { name: 'Alex Fiction', email: '', location: 'Remote', relocation: true }, finalizations: 0 });
  await info.attach('react-autofill', { body: JSON.stringify(cp.autofill), contentType: 'application/json' });
});

test('F03 conditional required fields are reinspected and cancellation stops subsequent writes', async ({ inspector }) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/F03`);
  await source.evaluate(() => { document.querySelector('#conditional')!.parentElement!.firstChild!.textContent = 'Willing to relocate'; });
  const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session);
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  const box = session.getByTestId('mapping-item').filter({ hasText: 'Willing to relocate' });
  await box.getByText('Review answer for this session', { exact: true }).click(); await box.getByLabel('Session answer', { exact: true }).selectOption('true');
  await box.getByRole('button', { name: 'Use for this application preview' }).click();
  await session.getByRole('button', { name: 'Start Autofill', exact: true }).click();
  await expect(session.getByTestId('autofill-results')).toContainText('Current-step autofill: review', { timeout: 20_000 });
  await expect(source.getByLabel('Required relocation city')).toBeVisible();
  expect((await current(session)).autofill?.requiredUnresolved).toBe(1);
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);
});

test('cancel during the first operation preserves delivered values and prevents all later operations', async ({ inspector }) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/F01`); const popup = await inspector.popup();
  await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session);
  const inspection = await inspect(session), cp = await current(session), version = await inputVersion(session), runId = crypto.randomUUID();
  const operation = request(session, startIntent(cp, inspection, version, runId));
  await expect(source.getByLabel('Email', { exact: true })).toHaveValue('alex@example.test');
  await request(session, { type: 'CANCEL_AUTOFILL', sessionId: cp.id, revision: cp.revision, runId });
  await operation;
  await expect(source.getByLabel('Phone', { exact: true })).toHaveValue('');
  const after = await current(session); expect(after.autofill?.status).toBe('cancelled'); expect(after.autofill?.operations).toHaveLength(1);
  await expect(source.getByLabel('Email', { exact: true })).toHaveValue('alex@example.test');
});

test('F07 selected resume crosses isolated bounded JSON transfer unchanged, delayed rejection and duplicate prevention', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/F07`); const popup = await inspector.popup();
  await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session);
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\nSynthetic resume\n'), Buffer.alloc(150000, 42)]);
  await session.locator('.document-workspace input[type=file]').setInputFiles({ name: 'fictional.pdf', mimeType: 'application/pdf', buffer: bytes });
  await session.getByRole('button', { name: 'Start local document session', exact: true }).click();
  await expect(session.getByRole('status').filter({ hasText: 'Resume bound to this local session.' })).toBeVisible();
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await session.getByLabel('Include this resume in a uniquely identified native resume field').check();
  await session.getByRole('button', { name: 'Start Autofill', exact: true }).click();
  await expect(session.getByTestId('autofill-results')).toContainText('Current-step autofill: review', { timeout: 20_000 });
  const cp = await current(session), uploads = cp.autofill!.operations.filter((o) => o.kind === 'upload');
  expect(uploads).toHaveLength(1); expect(uploads[0]!.result).toMatchObject({ status: 'rejected', selectedBytes: true, siteAcceptance: 'rejected' });
  const selected = await source.locator('#upload').evaluate(async (e) => Array.from(new Uint8Array(await (e as HTMLInputElement).files![0]!.arrayBuffer())));
  expect(Buffer.from(selected)).toEqual(bytes);
  expect(fixtures.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  const { createHash } = await import('node:crypto'); const digest = createHash('sha256').update(bytes).digest('hex');
  expect(fixtures.requests.find((r) => r.method === 'POST')).toMatchObject({ path: '/upload', bytes: bytes.length, digest });
  await request(session, startIntent(cp, await inspect(session), await inputVersion(session), cp.autofill!.id));
  expect(fixtures.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);
  await info.attach('upload-autofill', { body: JSON.stringify({ browser: context.browser()!.version(), autofill: cp.autofill, requests: fixtures.requests }), contentType: 'application/json' });
});

test('edits between operations are preserved, including clearing an original prefill', async ({ inspector }) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/F01`); const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session);
  const inspection = await inspect(session), cp = await current(session);
  const running = request(session, startIntent(cp, inspection, await inputVersion(session), crypto.randomUUID()));
  await expect(source.getByLabel('Email', { exact: true })).toHaveValue('alex@example.test');
  await source.getByLabel('Full name', { exact: true }).fill(''); await source.getByLabel('Phone', { exact: true }).fill('+009999');
  await running;
  await expect(source.getByLabel('Full name', { exact: true })).toHaveValue(''); await expect(source.getByLabel('Phone', { exact: true })).toHaveValue('+009999');
  const after = await current(session);
  expect(after.autofill?.operations.find((o) => o.fieldId === inspection.snapshot.fields[0]!.id)?.result).toMatchObject({ status: 'skipped_user_change' });
  expect(after.autofill?.operations.some((o) => o.fieldId === inspection.snapshot.fields.find((f) => f.type === 'tel')!.id)).toBe(false);
});

test('country approval is required for eligibility; consent and demographics stay manual during real writes', async ({ inspector }) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/M06`); const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html')); await freeze(session);
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  const auth = session.getByTestId('mapping-item').filter({ has: session.locator('strong').filter({ hasText: /^Are you authorized to work in US\?$/ }) });
  await auth.getByText('Review answer for this session', { exact: true }).click();
  await auth.getByLabel('Session answer', { exact: true }).selectOption('false');
  await expect(auth.getByRole('button', { name: 'Use for this application preview' })).toBeDisabled();
  await auth.getByRole('checkbox').check(); await auth.getByRole('button', { name: 'Use for this application preview' }).click();
  await session.getByRole('button', { name: 'Start Autofill', exact: true }).click();
  await expect(session.getByTestId('autofill-results')).toContainText('Current-step autofill: review', { timeout: 20_000 });
  await expect(source.getByLabel('Are you authorized to work in US?')).toHaveValue('no');
  await expect(source.getByLabel('I certify my answers')).not.toBeChecked(); await expect(source.getByLabel('Gender')).toHaveValue('');
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);
});
