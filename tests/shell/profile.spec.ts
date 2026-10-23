import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { browser } from 'wxt/browser';
import { parseProfileMarkdown } from '../../src/profile/markdown';

declare const chrome: typeof browser;

test('real extension profile setup, import/export, explicit defaults, frozen replacement and refresh', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(90_000);
  const directory = await mkdtemp(path.join(tmpdir(), 'applyr-profile-'));
  const extension = path.resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(directory, { channel: 'chromium', headless: true, acceptDownloads: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const outbound: string[] = [], errors: string[] = [];
  context.on('request', (r) => { if (/^https?:/.test(r.url())) outbound.push(r.url()); });
  await context.route(/^https?:/, (r) => r.abort());
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const base = `chrome-extension://${worker.url().split('/')[2]}`;
  async function page(url: string) {
    const previous = new Set(context.pages());
    const target = `${base}/${url}.html`;
    await worker.evaluate(async (url) => { await chrome.tabs.create({ url, active: false }); }, target);
    await expect.poll(() => context.pages().some((p) => !previous.has(p) && p.url() === target)).toBe(true);
    const p = context.pages().find((p) => !previous.has(p) && p.url() === target)!;
    await p.waitForLoadState('domcontentloaded'); return p;
  }
  async function state(p: Page, name: string, value = 'value') { await p.getByLabel(`${name} state`, { exact: true }).selectOption(value); }
  async function field(p: Page, fieldPath: string, value: string) {
    const container = p.locator(`.profile-field[data-path="${fieldPath}"]`);
    const mode = container.locator(':scope > .field-label select');
    if (await mode.count()) await mode.selectOption('value');
    await container.locator(':scope > textarea, :scope > input').fill(value);
  }
  async function section(p: Page, name: string) {
    const summary = p.locator('.profile-section > summary').filter({ hasText: new RegExp(`^${name}$`) });
    const details = summary.locator('..');
    if (!(await details.getAttribute('open') !== null)) await summary.click();
  }
  async function validate(p: Page) { await p.getByRole('button', { name: 'Validate profile', exact: true }).click(); await expect(p.getByRole('heading', { name: 'Validation passed — review supplied assertions' })).toBeVisible(); }
  async function download(p: Page) { const event = p.waitForEvent('download'); await p.getByRole('button', { name: 'Download Markdown', exact: true }).click(); const file = await event; return await readFile((await file.path())!, 'utf8'); }
  async function upload(p: Page, text: string) { await p.locator('input[type=file]').setInputFiles({ name: 'fictional-test.md', mimeType: 'text/markdown', buffer: Buffer.from(text) }); await expect(p.getByRole('heading', { name: 'Validation passed — review supplied assertions' })).toBeVisible(); }
  try {
    // Capture a genuine setup checkpoint through the popup; candidate details remain fictional.
    await worker.evaluate(async () => chrome.tabs.create({ url: 'about:blank', active: true }));
    const popup = await page('popup');
    await expect(popup.getByTestId('checkpoint-id')).toBeVisible();
    const options = await page('options');
    await expect(options.getByTestId('saved-profile-state')).toHaveText('No saved default profile.');
    await expect(options.getByText('Fictional Institute of Technology', { exact: false })).toHaveCount(0);
    const templateDownload = options.waitForEvent('download');
    await options.getByRole('button', { name: 'Download blank template' }).click();
    expect((await templateDownload).suggestedFilename()).toBe('applyr-blank-template.md');
    const fictionalDownload = options.waitForEvent('download');
    await options.getByRole('button', { name: 'Download fictional example' }).click();
    expect((await fictionalDownload).suggestedFilename()).toBe('applyr-fictional-example.md');

    await state(options, 'Identity'); await field(options, 'identity.legal_name', 'Fictional Single Legal Name');
    await state(options, 'Given name', 'null');
    await state(options, 'Contact'); await field(options, 'contact.email', 'fictional@example.com'); await field(options, 'contact.phone', '+001234');
    await state(options, 'Address'); await field(options, 'contact.address.postal_code', '00101');
    await section(options, 'Education'); await state(options, 'Education');
    await options.getByRole('button', { name: 'Add Education item', exact: true }).click();
    await field(options, 'education.0.id', 'fictional-degree'); await field(options, 'education.0.institution', 'Fictional Institute'); await field(options, 'education.0.start_date', '2024-08'); await field(options, 'education.0.end_date', '2027-05');
    await options.getByLabel('Expected graduation', { exact: true }).selectOption('true');
    await options.getByRole('button', { name: 'Add Education item', exact: true }).click(); await field(options, 'education.1.id', 'second-degree');
    await section(options, 'Experience'); await state(options, 'Experience'); await options.getByRole('button', { name: 'Add Experience item', exact: true }).click(); await field(options, 'experience.0.id', 'fictional-work'); await field(options, 'experience.0.title', 'Fictional Intern'); await options.getByLabel('Current role', { exact: true }).selectOption('false');
    await section(options, 'Projects'); await state(options, 'Projects'); await options.getByRole('button', { name: 'Add Projects item', exact: true }).click(); await field(options, 'projects.0.id', 'fictional-project'); await field(options, 'projects.0.name', 'Demo project');
    await section(options, 'Preferences'); await state(options, 'Preferences'); await options.getByLabel('Relocation', { exact: true }).selectOption('false'); await field(options, 'preferences.available_from', '2027-06');
    await section(options, 'Eligibility'); await state(options, 'Eligibility'); await options.getByRole('button', { name: 'Add Eligibility item', exact: true }).click(); await field(options, 'eligibility.0.country_code', 'in'); await options.getByLabel('Work authorized', { exact: true }).selectOption('null'); await options.getByLabel('Sponsorship required', { exact: true }).selectOption('false');
    await section(options, 'Reusable answers'); await state(options, 'Reusable answers'); await options.getByRole('button', { name: 'Add Reusable answers item', exact: true }).click(); await field(options, 'answers.0.id', 'demo-answer'); await field(options, 'answers.0.question', 'Describe your project?');
    await state(options, 'Fact references'); await options.getByRole('button', { name: 'Add Fact references item', exact: true }).click(); await field(options, 'answers.0.fact_refs.0', 'projects.fictional-project');
    await section(options, 'Answer text & notes'); await options.getByLabel('Answer body: demo-answer', { exact: true }).fill('A **fictional** project.\n\nSecond paragraph.'); await options.getByLabel('Notes (never treated as facts)').fill('Fictional setup test only.');
    await validate(options);
    const exported = await download(options);
    const original = parseProfileMarkdown(exported).document!;
    await options.getByRole('heading', { name: 'Candidate profile', exact: true }).scrollIntoViewIfNeeded();
    await options.screenshot({ path: testInfo.outputPath('profile-setup.png') });
    expect(original.data.identity).toEqual({ legal_name: 'Fictional Single Legal Name', given_name: null });
    expect(original.data.education).toHaveLength(2); expect(original.data.preferences?.relocation).toBe(false); expect(original.data.contact?.address?.postal_code).toBe('00101'); expect(original.answerBodies['demo-answer']).toContain('Second paragraph.');
    await options.getByRole('button', { name: 'Save as default', exact: true }).click(); await expect(options.getByTestId('saved-profile-state')).toContainText('Saved default version');
    // A new options tab imports the exported file with no implicit save.
    const imported = await page('options'); await upload(imported, exported);
    expect(parseProfileMarkdown(await download(imported)).document).toEqual(original);
    await expect(imported.getByRole('status')).toContainText('Nothing has been saved');
    await imported.getByText('Review or repair imported Markdown', { exact: true }).click();
    await imported.getByRole('button', { name: 'Return to form', exact: true }).click();
    await validate(imported); expect(parseProfileMarkdown(await download(imported)).document).toEqual(original);

    const session = await page('session'); await session.getByRole('button', { name: 'Preview saved default' }).click(); await session.getByRole('button', { name: 'Freeze profile for this session' }).click();
    await expect(session.getByTestId('frozen-profile-state')).toContainText('saved');
    const firstVersion = await session.getByTestId('frozen-profile-state').innerText();
    await options.getByRole('button', { name: 'Edit saved default' }).click(); await field(options, 'identity.legal_name', 'Updated Fictional Default'); await validate(options); await options.getByRole('button', { name: 'Save as default', exact: true }).click();
    await expect(options.getByRole('status')).toContainText('Existing frozen inputs were kept');
    await session.getByRole('button', { name: 'Reload profile state' }).click(); await expect(session.getByTestId('frozen-profile-state')).toHaveText(firstVersion);
    await session.getByRole('button', { name: 'Preview saved default' }).click(); await expect(session.getByTestId('profile-preview')).toContainText('Updated Fictional Default');
    await session.getByRole('button', { name: 'Refresh frozen profile' }).click(); await expect(session.getByTestId('frozen-profile-state')).not.toHaveText(firstVersion);

    // Whole-file replacement, inert XSS/link/image preview, and explicit persistent proposal.
    const replacement = '---\nprofile_version: 1\npreferences: {relocation: false}\n---\n\n<script>globalThis.profileExecuted=true</script>\n<img src="https://example.com/pixel" onerror="steal()">\n![remote](https://example.com/image)\n';
    await upload(session, replacement);
    await expect(session.getByTestId('profile-preview')).toContainText('<script>');
    expect(await session.locator('img').count()).toBe(0); expect(await session.evaluate(() => Object.hasOwn(globalThis, 'profileExecuted'))).toBe(false);
    await session.getByRole('button', { name: 'Refresh frozen profile' }).click();
    await session.locator('.snapshot-summary summary').click();
    await expect(session.locator('.snapshot-summary pre')).not.toContainText('identity:'); await expect(session.locator('.snapshot-summary pre')).not.toContainText('contact:');
    await options.getByRole('button', { name: 'Reload profile state' }).click(); await options.getByRole('button', { name: 'Edit saved default' }).click(); await expect(options.getByTestId('profile-preview')).toContainText('Updated Fictional Default');
    await session.getByRole('button', { name: 'Propose profile update' }).click(); await expect(session.getByRole('heading', { name: 'Proposed persistent update' })).toBeVisible(); await session.getByRole('button', { name: 'Save proposed default' }).click(); await expect(session.getByRole('status')).toContainText('explicitly saved');
    await options.getByRole('button', { name: 'Reload profile state' }).click(); await options.getByRole('button', { name: 'Edit saved default' }).click(); await expect(options.getByTestId('profile-preview')).not.toContainText('identity:');

    // Unknown-key repair is deliberate and errors do not contain field values.
    await options.locator('input[type=file]').setInputFiles({ name: 'unknown.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nprofile_version: 1\nidentity: {nickname: Fictional}\n---\n') });
    await expect(options.getByRole('alert')).toContainText('Repair 1 validation issue'); await options.getByRole('button', { name: 'Remove this unknown key' }).click(); await expect(options.getByRole('heading', { name: 'Validation passed — review supplied assertions' })).toBeVisible();
    await options.locator('input[type=file]').setInputFiles({ name: 'secret.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nprofile_version: 1\napi_key: secret-canary\n---\n') });
    await expect(options.locator('.validation-preview')).toContainText('FORBIDDEN_KEY'); await expect(options.locator('.validation-preview')).not.toContainText('secret-canary'); await expect(options.getByRole('button', { name: 'Remove this unknown key' })).toHaveCount(0);
    await expect(options.getByRole('button', { name: 'Save as default', exact: true })).toHaveCount(0);
    await options.getByRole('button', { name: 'Delete saved profile', exact: true }).click(); await options.getByRole('button', { name: 'Confirm delete profile and recovery copies' }).click(); await expect(options.getByTestId('saved-profile-state')).toHaveText('No saved default profile.');
    await expect(session.getByTestId('frozen-profile-state')).toHaveCount(0);
    await expect(session.getByTestId('profile-preview')).toHaveCount(0);
    await expect(imported.getByTestId('profile-preview')).toHaveCount(0);
    expect(await session.evaluate(() => chrome.storage.local.get(null))).toEqual({});
    const permissions = await session.evaluate(() => chrome.permissions.getAll()); expect(permissions.permissions).not.toContain('downloads'); expect(permissions.origins ?? []).toEqual([]);
    expect(outbound).toEqual([]); expect(errors).toEqual([]);
    await options.screenshot({ path: testInfo.outputPath('profile.png'), fullPage: true });
    await testInfo.attach('profile-runtime', { body: JSON.stringify({ browserVersion: context.browser()!.version(), outbound, errors, profileRoundTrip: true }, null, 2), contentType: 'application/json' });
  } finally { await context.close(); await rm(directory, { recursive: true, force: true }); }
});
