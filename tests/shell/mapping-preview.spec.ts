function immutableInput(value: unknown) { return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !['expiresAt', 'lastActivityAt'].includes(key))); }
import { expect, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { test } from '../fixtures/inspection-extension';

declare const chrome: typeof browser;
const today = new Date().toISOString().slice(0, 10);
const profile = `---\nprofile_version: 1\nreviewed_on: "${today}"\nidentity: {legal_name: Alex Fiction}\ncontact: {email: alex@example.test, phone: "+001234"}\nlinks: {website: "https://example.test/"}\npreferences: {available_from: "2026-11-01", work_arrangements: [remote], relocation: false}\neligibility:\n  - {country_code: US, work_authorized: false, confirmed_on: "${today}"}\n---\nNOTE_SECRET_MAPPING_CANARY\n`;
async function importProfile(page: Page, text: string) {
  await page.locator('.profile-workspace input[type=file]').setInputFiles({ name: 'fictional-mapping.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
  await expect(page.getByRole('heading', { name: 'Validation passed — review supplied assertions' })).toBeVisible();
}
const row = (page: Page, label: string) => page.getByTestId('mapping-item').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
async function correction(page: Page, label: string, answer: string) {
  const item = row(page, label);
  await item.getByText('Review answer for this session', { exact: true }).click();
  const control = item.getByLabel('Session answer', { exact: true });
  if (await control.evaluate((e) => e.localName === 'select')) await control.selectOption(answer); else await control.fill(answer);
  return item;
}
async function savedData(page: Page, key: 'default' | 'snapshot') {
  return page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('applyr-local'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    try { return await new Promise<unknown>((resolve, reject) => { const req = db.transaction('profiles').objectStore('profiles').get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); } finally { db.close(); }
  }, key);
}

test('packaged dry-run F01 counts, source paths, session correction, reviewed default diff and frozen replacement', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector;
  const outbound: string[] = [], errors: string[] = [];
  context.on('request', (request) => { if (/^https?:/.test(request.url()) && ![fixtures.origin, fixtures.cross].includes(new URL(request.url()).origin)) outbound.push(request.url()); });
  context.on('page', (page) => page.on('pageerror', (e) => errors.push(e.message)));
  await source.goto(`${fixtures.origin}/F01`);
  const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
  const options = await context.newPage(); await options.goto(popup.url().replace('popup.html', 'options.html'));
  await importProfile(options, profile); await options.getByRole('button', { name: 'Save as default', exact: true }).click();
  await importProfile(session, profile); await session.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click();
  await expect(session.getByTestId('frozen-profile-state')).toBeVisible();
  await session.evaluate(() => chrome.storage.session.set({ providerCredentialCanary: 'PROVIDER_SECRET_MAPPING_CANARY' }));
  const before = await source.content(); const frozen = immutableInput(await savedData(session, 'snapshot'));
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  const counts = session.getByTestId('mapping-counts');
  await expect(counts).toHaveText('21 inspected · 5 proposed · 2 skipped · 0 missing answers · 10 need review · 4 unsupported fields · 0 unsupported areas');
  await expect(row(session, 'Email')).toContainText('contact.email'); await expect(row(session, 'Email')).toContainText('replacement');
  await expect(row(session, 'Full name')).toHaveAttribute('data-state', 'skipped');
  const preview = session.getByTestId('dry-run-preview');
  expect(await preview.innerText()).not.toMatch(/NOTE_SECRET_MAPPING_CANARY|PROVIDER_SECRET_MAPPING_CANARY|F05_.*CANARY/);
  await expect(preview).not.toContainText('application complete');
  await session.setViewportSize({ width: 800, height: 1100 });
  await session.locator('#dry-run-heading').evaluate((e) => e.scrollIntoView());
  await session.screenshot({ path: info.outputPath('mapping-preview.png') });
  const email = await correction(session, 'Email', 'session-only@example.test');
  await email.getByRole('button', { name: 'Use for this application preview' }).click();
  await expect(email.getByTestId('proposed-value')).toHaveText('session-only@example.test');
  expect(immutableInput(await savedData(session, 'snapshot'))).toEqual(frozen);
  expect(JSON.stringify(await savedData(session, 'default'))).not.toContain('session-only@example.test');
  await email.getByRole('button', { name: 'Propose profile update', exact: true }).click();
  const diff = session.getByLabel('Reviewed profile update', { exact: true });
  await expect(diff).toContainText('profile.contact.email'); await expect(diff).toContainText('session-only@example.test');
  await expect(diff.getByRole('button', { name: 'Save reviewed profile update' })).toBeDisabled();
  await diff.getByLabel('I reviewed this default-profile diff').check(); await diff.getByRole('button', { name: 'Save reviewed profile update' }).click();
  await expect(diff).toHaveCount(0);
  expect(JSON.stringify(await savedData(session, 'default'))).toContain('session-only@example.test'); expect(immutableInput(await savedData(session, 'snapshot'))).toEqual(frozen);
  await expect(session.getByTestId('mapping-input')).toContainText((frozen as { version: string }).version);
  // A fresh inspection discards the view-only correction; saved edits do not
  // rewrite the running frozen input.
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await expect(row(session, 'Email').getByTestId('proposed-value')).toHaveText('alex@example.test');
  // A whole-file replacement has no contact section. It must not fill from
  // either the original or newly edited saved default.
  await importProfile(session, '---\nprofile_version: 1\nidentity: {legal_name: Partial Replacement}\n---\n');
  await session.getByRole('button', { name: 'Refresh frozen profile', exact: true }).click();
  await expect(session.getByTestId('dry-run-preview')).toHaveCount(0);
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await expect(row(session, 'Email')).toHaveAttribute('data-state', 'missing');
  await expect(counts).toHaveText('21 inspected · 0 proposed · 2 skipped · 5 missing answers · 10 need review · 4 unsupported fields · 0 unsupported areas');
  await options.getByRole('button', { name: 'Delete saved profile', exact: true }).click();
  await options.getByRole('button', { name: 'Confirm delete profile and recovery copies' }).click();
  await expect(session.getByTestId('dry-run-preview')).toHaveCount(0);
  expect(await source.content()).toBe(before);
  expect(await source.evaluate(() => (window as unknown as { fixture: unknown }).fixture)).toMatchObject({ finalizations: 0, inputEvents: 0 });
  expect(outbound).toEqual([]); expect(errors).toEqual([]); expect(fixtures.requests.every((r) => r.method === 'GET')).toBe(true);
  await info.attach('mapping-runtime-audit', { body: JSON.stringify({ browser: context.browser()!.version(), fixture: 'F01', inspected: 21, initial: { proposed: 5, skipped: 2, missing: 0, review: 10, unsupported: 4 }, replacement: { proposed: 0, skipped: 2, missing: 5, review: 10, unsupported: 4 }, unchangedDOM: true, finalizations: 0, inputEvents: 0, providerRequests: outbound, errors, frozenUnchangedByCorrectionAndDefaultSave: true, requests: fixtures.requests }), contentType: 'application/json' });
});

test('country-specific confirmation, stale preference review and consent/demographic/manual separation', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/M06`); const popup = await inspector.popup();
  await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
  await importProfile(session, profile.replace(`reviewed_on: "${today}"`, 'reviewed_on: "2026-01-01"'));
  await session.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click();
  const before = await source.content();
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await expect(session.getByTestId('mapping-counts')).toHaveText('8 inspected · 1 proposed · 0 skipped · 3 missing answers · 4 need review · 0 unsupported fields · 1 unsupported areas');
  await expect(row(session, 'First name')).toHaveAttribute('data-state', 'missing');
  await expect(row(session, 'Last name')).toHaveAttribute('data-state', 'missing');
  await expect(row(session, 'Do you require sponsorship in India?')).toHaveAttribute('data-state', 'missing');
  await expect(row(session, 'Willing to relocate')).toContainText('older than 90 days');
  const auth = await correction(session, 'Are you authorized to work in US?', 'false');
  await expect(auth.getByRole('button', { name: 'Use for this application preview' })).toBeDisabled();
  await auth.getByLabel('I explicitly confirm this country-specific answer for this application').check();
  await auth.getByRole('button', { name: 'Use for this application preview' }).click();
  await expect(auth).toHaveAttribute('data-state', 'proposed'); await expect(auth).toContainText('session approved');
  const relocate = await correction(session, 'Willing to relocate', 'false'); await relocate.getByRole('button', { name: 'Use for this application preview' }).click();
  await expect(relocate).toHaveAttribute('data-state', 'proposed');
  await expect(session.getByTestId('mapping-counts')).toHaveText('8 inspected · 3 proposed · 0 skipped · 3 missing answers · 2 need review · 0 unsupported fields · 1 unsupported areas');
  await expect(row(session, 'I certify my answers').getByText('Review answer for this session', { exact: true })).toHaveCount(0);
  await expect(row(session, 'Gender').getByText('Review answer for this session', { exact: true })).toHaveCount(0);
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await expect(auth).toHaveAttribute('data-state', 'review');
  expect(await source.content()).toBe(before);
  expect(await source.evaluate(() => (window as unknown as { fixture: unknown }).fixture)).toMatchObject({ finalizations: 0, inputEvents: 0 });
  expect(fixtures.requests.every((r) => r.method === 'GET')).toBe(true);
  // Seed an existing No with an empty raw option value. Semantic presence must
  // preserve it; this explicit driver setup is separate from the read-only UI.
  await source.getByLabel('Willing to relocate').evaluate((e) => { const select = e as HTMLSelectElement; select.options[2]!.value = ''; select.selectedIndex = 2; });
  const seeded = await source.content();
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await expect(row(session, 'Willing to relocate')).toHaveAttribute('data-state', 'skipped');
  expect(await source.content()).toBe(seeded);
  await info.attach('mapping-confirmation-audit', { body: JSON.stringify({ browser: context.browser()!.version(), fixture: 'M06', fields: 8, unsupportedAreas: 1, initial: { proposed: 1, missing: 3, review: 4 }, confirmed: { proposed: 3, missing: 3, review: 2 }, reinspectionClearedConfirmations: true, unchangedDOM: true, finalizations: 0, inputEvents: 0 }), contentType: 'application/json' });
});

test('React existing/user answers are preserved and a different view refreshing frozen inputs invalidates the preview', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector;
  await source.goto(`${fixtures.origin}/F02`); await expect(source.getByLabel('Work location')).toContainText('Hybrid');
  await source.getByLabel('Full name').fill('User page answer');
  const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
  await importProfile(session, profile); await session.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click();
  await expect(session.getByTestId('frozen-profile-state')).toBeVisible();
  const before = await source.content();
  await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await expect(session.getByTestId('mapping-counts')).toHaveText('3 inspected · 0 proposed · 3 skipped · 0 missing answers · 0 need review · 0 unsupported fields · 0 unsupported areas');
  const other = await context.newPage(); await other.goto(session.url());
  await importProfile(other, '---\nprofile_version: 1\ncontact: {email: refreshed@example.test}\n---\n');
  await other.getByRole('button', { name: 'Refresh frozen profile', exact: true }).click();
  await expect(session.getByTestId('dry-run-preview')).toHaveCount(0);
  await expect(source.getByLabel('Full name')).toHaveValue('User page answer');
  expect(await source.content()).toBe(before);
  await info.attach('mapping-react-version-audit', { body: JSON.stringify({ browser: context.browser()!.version(), fixture: 'F02', inspected: 3, proposed: 0, skipped: 3, crossViewFrozenRefreshInvalidatesPreview: true, unchangedDOM: true }), contentType: 'application/json' });
});
