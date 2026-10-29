import { expect, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { test } from '../fixtures/inspection-extension';
import { inspectForm } from '../../src/forms/inspect';
import { operateControl } from '../../src/forms/apply';
import { FormSnapshotSchema, type FormSnapshot } from '../../src/forms/schema';
import type { ContentOperation } from '../../src/forms/operations';
import type { Response } from '../../src/runtime/schemas';
import { addressIdentity } from '../../src/browser/addresses';

declare const chrome: typeof browser;
const cases = [
  ['F14', 'https://docs.google.com/forms/d/e/fictional_form/viewform', 'google_forms', 'Google Forms'],
  ['F15', 'https://jobs.ashbyhq.com/fiction/12345678-1234-1234-1234-123456789abc/application', 'ashby', 'Ashby'],
  ['F16', 'https://jobs.smartrecruiters.com/Fiction/123456789-engineer', 'smartrecruiters', 'SmartRecruiters'],
  ['F17', 'https://apply.workable.com/fiction/j/ABC123/apply/', 'workable', 'Workable'],
  ['F18', 'https://fiction.wd1.myworkdayjobs.com/en-US/Careers/job/Remote/Engineer_REQ123/apply', 'workday', 'Workday'],
] as const;
const profile = `---\nprofile_version: 1\nreviewed_on: "2026-10-30"\nidentity: {legal_name: Alex Fiction, given_name: Alex}\ncontact: {email: alex@example.test, address: {city: Mumbai}}\npreferences: {work_arrangements: [remote]}\n---\n`;
async function request(page: Page, intent: object) {
  const result = await page.evaluate((intent) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), ...intent }), intent) as Response;
  expect(result).toMatchObject({ ok: true }); if (!result.ok) throw new Error(result.code); return result;
}
async function current(page: Page) { return (await request(page, { type: 'GET_STATE', sessionId: null, revision: null })).checkpoint!; }
async function scan(page: Page) { return FormSnapshotSchema.parse(await page.evaluate(async ({ source, identity }) => (0, eval)(`(${source})`)(identity), { source: inspectForm.toString(), identity: await addressIdentity(page.url()) })); }
async function operate(page: Page, command: ContentOperation) { return page.evaluate(async ({ source, command }) => (0, eval)(`(${source})`)(command), { source: operateControl.toString(), command }); }
function choice(s: FormSnapshot, label = 'Remote'): Extract<ContentOperation, { type: 'write' }> {
  const f = s.fields.find((f) => f.control)!, o = f.options.find((o) => o.label === label)!;
  return { type: 'write', operationId: crypto.randomUUID(), runId: crypto.randomUUID(), fieldId: f.id, precondition: f.current.fingerprint, eligibilityApproved: false,
    binding: { sessionId: crypto.randomUUID(), tabId: 1, frameId: 0, browserDocumentId: null, identity: s.identity, document: s.document, revision: s.revision, inputVersion: crypto.randomUUID() }, value: { kind: 'choice', label, optionFingerprint: o.fingerprint } };
}

test.describe('F14–F18 owned HTML at intercepted vendor URLs; no live traffic', () => {
  test.use({ platformGrants: true });
  for (const [pattern, url, adapter, name] of cases) test(`${pattern} packaged subset, explicit manual limits and failed manual upload`, async ({ inspector }, info) => {
    const { source, context, fixtures } = inspector;
    const html = await (await context.request.get(`${fixtures.origin}/${pattern}`)).text();
    await context.route(url, (r) => r.fulfill({ body: html, contentType: 'text/html' })); await source.goto(url);
    const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
    const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
    await session.locator('.profile-workspace input[type=file]').setInputFiles({ name: 'fiction.md', mimeType: 'text/markdown', buffer: Buffer.from(profile) });
    await session.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click(); await expect(session.getByTestId('frozen-profile-state')).toBeVisible();
    await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
    await expect(session.getByTestId('adapter-evidence')).toContainText(`${name} adapter 1.0.0`);
    if (pattern !== 'F14') await expect(session.getByTestId('adapter-evidence')).toContainText('experimental');
    await session.getByRole('button', { name: 'Start Autofill', exact: true }).click();
    await expect(session.getByTestId('autofill-results')).toContainText('Autofill status: review', { timeout: 25000 });
    await expect(source.locator('[name=email]')).toHaveValue('alex@example.test');
    await expect(source.locator('input[autocomplete=name],input[autocomplete=given-name]')).toHaveValue(pattern === 'F16' || pattern === 'F18' ? 'Alex' : 'Alex Fiction');
    if (pattern === 'F14') await expect(source.locator('[role=radio][aria-checked=true]')).toHaveText('Remote');
    if (pattern === 'F15') await expect(source.locator('[role=option][aria-selected=true]')).toHaveText('Remote');
    if (pattern === 'F16') await expect(source.locator('select')).toHaveValue('remote');
    if (pattern === 'F17') await expect(source.locator('input[value=remote]')).toBeChecked();
    await expect(source.locator('#declaration')).not.toBeChecked();
    if (pattern !== 'F14') await expect(source.locator('[name=school]')).toHaveValue('');
    await expect.poll(async () => (await current(session)).review?.items.filter((i) => i.status === 'accepted').length).toBe(pattern === 'F18' ? 2 : 3);
    const before = await current(session);
    expect(before.review!.areas[0]!.adapter!.id).toBe(adapter); expect(before.reviewScope).toBe('current_step'); expect(before.submission.status).toBe('unknown');
    expect(before.autofill!.operations.some((o) => o.kind === 'upload')).toBe(false);
    expect(before.review!.areas[0]!.manual).toContain('Resume PDF');
    await expect(session.getByRole('list', { name: 'Manual compatibility limitations' })).toContainText('Resume PDF');
    await expect(session.getByRole('button', { name: 'I am reviewing the final step' })).toBeDisabled();
    // Test driver acts as the user; applyr never selects this file or starts a dialog.
    await source.locator('#manual-file').setInputFiles({ name: 'fiction.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nF14_18_MANUAL_FAILURE\n') });
    await expect(source.locator('#file-status')).toHaveText('Upload failed: manual retry required');
    await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
    await expect.poll(async () => (await current(session)).review?.items.find((i) => i.upload)?.status).toBe('rejected');
    await expect(session.getByRole('list', { name: 'Field review list' })).toContainText('upload rejected');
    const cp = await current(session);
    expect(cp.review!.items.find((i) => i.upload)!.status).toBe('rejected');
    await expect(session.getByTestId('autofill-results')).toContainText('failed or unverified uploads');
    expect(cp.autofill!.operations.some((o) => o.kind === 'upload')).toBe(false);
    expect(fixtures.requests.filter((r) => r.method === 'POST')).toEqual([]);
    expect(await source.evaluate(() => (window as unknown as { fixture: object }).fixture)).toMatchObject({ finalizations: 0, advancements: 0 });
    if (pattern === 'F14') await session.getByTestId('autofill-results').screenshot({ path: 'planning/evidence/prompt-14/forms-review.png' });
    if (pattern === 'F18') {
      const options = await context.newPage(); await options.goto(popup.url().replace('popup.html', 'options.html'));
      await options.getByText('Compatibility and evidence', { exact: true }).click();
      const table = options.getByRole('table', { name: 'Compatibility summary' });
      await expect(table).toContainText('Workday · experimental'); await expect(table).toContainText('Google Forms · partial');
      await table.screenshot({ path: 'planning/evidence/prompt-14/compatibility-summary.png' });
    }
    await info.attach('coverage', { body: JSON.stringify({ pattern, adapter, browser: context.browser()!.version(), manual: cp.review!.areas[0]!.manual, finalizations: 0, liveTraffic: false }), contentType: 'application/json' });
  });

  test('host matches and wrong paths without application semantics never promote a vendor', async ({ inspector }) => {
    const { source, context, fixtures } = inspector;
    for (const [pattern, url] of cases) {
      const html = await (await context.request.get(`${fixtures.origin}/${pattern}`)).text();
      const unrelated = html.replace(/aria-label="[^"]*(?:application|Application)[^"]*"/g, 'aria-label="Newsletter"');
      for (const [target, body] of [[url, unrelated], [new URL('/careers', url).href, html], [url.replace(new URL(url).hostname, `${new URL(url).hostname}.evil.invalid`), html], [url.replace(new URL(url).host, `${new URL(url).host}:444`), html]]) {
        await context.route(target!, (r) => r.fulfill({ body: body!, contentType: 'text/html' })); await source.goto(target!);
        expect((await scan(source)).adapter!.id).toBe('generic');
      }
    }
  });

  test('an unrecognized Google application shape still cannot authorize native upload', async ({ inspector }) => {
    const { source, context, fixtures } = inspector, url = cases[0][1];
    const html = (await (await context.request.get(`${fixtures.origin}/F14`)).text()).replace('Full name</label>', 'Preferred alias</label>').replace('autocomplete="name"', '');
    await context.route(url, (r) => r.fulfill({ body: html, contentType: 'text/html' })); await source.goto(url);
    const snapshot = await scan(source); expect(snapshot.adapter!.id).toBe('generic');
    const file = snapshot.fields.find((f) => f.type === 'file')!; expect(file.executable).toBe(false); expect(snapshot.unsupported.some((a) => a.code === 'manual_upload')).toBe(true);
    const c = choice(snapshot);
    expect(await operate(source, { type: 'begin', operationId: c.operationId, runId: c.runId, binding: c.binding, fieldId: file.id, precondition: file.current.fingerprint, file: { name: 'fiction.pdf', mime: 'application/pdf', size: 20, lastModified: 1, digest: 'a'.repeat(64) } })).toMatchObject({ status: 'unsupported', code: 'manual_control' });
    expect(await source.evaluate(() => (window as unknown as { fixture: object }).fixture)).toMatchObject({ finalizations: 0, inputEvents: 0 });
  });

  test('user advancement reinspects new fields, retains frozen versions and pauses a repeated branch', async ({ inspector }) => {
    const { source, context, fixtures } = inspector, url = cases[0][1];
    const html = await (await context.request.get(`${fixtures.origin}/F14`)).text(); await context.route(url, (r) => r.fulfill({ body: html, contentType: 'text/html' })); await source.goto(url);
    const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
    await expect(popup.getByTestId('target-url')).toHaveText(source.url());
    const session = await context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
    await session.locator('.profile-workspace input[type=file]').setInputFiles({ name: 'fiction.md', mimeType: 'text/markdown', buffer: Buffer.from(profile) });
    await session.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click(); await expect(session.getByTestId('frozen-profile-state')).toBeVisible();
    await session.getByRole('button', { name: 'Inspect fields', exact: true }).click(); await session.getByRole('button', { name: 'Start Autofill', exact: true }).click();
    await expect(session.getByTestId('autofill-results')).toContainText('Autofill status: review', { timeout: 25000 });
    const first = await current(session);
    await source.locator('#next').click(); await expect(source.getByLabel('City', { exact: true })).toBeVisible();
    await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
    await expect.poll(async () => (await current(session)).review?.items.some((i) => i.label === 'City' && i.status === 'unresolved')).toBe(true);
    const second = await current(session);
    expect(second.target).toEqual(first.target); expect(second.autofill!.inputVersion).toBe(first.autofill!.inputVersion); expect(second.reviewScope).not.toBe('final_review');
    await source.locator('#back').click(); await session.getByRole('button', { name: 'Inspect fields', exact: true }).click();
    await expect.poll(async () => (await current(session)).lifecycle).toBe('PAUSED');
    const loop = await current(session); expect(loop.lifecycle).toBe('PAUSED'); expect(loop.recovery!.reason).toBe('branch_loop');
    await expect(session.getByRole('list', { name: 'Manual compatibility limitations' })).toContainText('Repeated branch');
    expect(loop.submission.status).toBe('unknown'); expect(loop.target).toEqual(first.target); expect(loop.autofill!.inputVersion).toBe(first.autofill!.inputVersion);
    expect(await source.evaluate(() => (window as unknown as { fixture: object }).fixture)).toMatchObject({ finalizations: 0, advancements: 1 });
  });
});

test('F14–F18 account/challenge metadata gates exclude protected answers', async ({ inspector }) => {
  const { source, fixtures } = inspector;
  for (const [pattern] of cases) for (const gate of ['account', 'challenge']) {
    await source.goto(`${fixtures.origin}/${pattern}?${gate}`);
    await source.evaluate(() => { Object.defineProperty(HTMLInputElement.prototype, 'value', { get() { throw new Error('Protected answer read'); }, set() { throw new Error('Forbidden write'); }, configurable: true }); });
    const s = await scan(source); expect(s.fields).toEqual([]); expect(s.unsupported.some((a) => a.code === 'authentication')).toBe(true);
    expect(s.unsupported.some((a) => a.code === (gate === 'account' ? 'login' : 'captcha'))).toBe(true);
    expect(JSON.stringify(s)).not.toContain('CANARY');
    expect(await source.evaluate(() => (window as unknown as { fixture: object }).fixture)).toMatchObject({ finalizations: 0, inputEvents: 0 });
  }
});

test('F14 radio operation binds membership and abstains on declarations, finalization, hidden peers, edits and errors', async ({ inspector }) => {
  const { source, fixtures } = inspector;
  await source.goto(`${fixtures.origin}/F14`); let s = await scan(source), c = choice(s);
  expect(await operate(source, choice(s, 'On-site'))).toMatchObject({ status: 'unsupported' });
  expect(await operate(source, c)).toMatchObject({ status: 'accepted' }); expect(await operate(source, c)).toMatchObject({ status: 'accepted' });
  s = await scan(source); expect(await operate(source, { ...c, type: 'observe', expected: c.value, binding: { ...c.binding, revision: s.revision } })).toMatchObject({ status: 'accepted' });
  expect(await source.evaluate(() => (window as unknown as { fixture: { choiceEvents: number } }).fixture.choiceEvents)).toBe(1);
  for (const variant of ['declaration', 'sensitive', 'button', 'duplicate', 'hidden', 'nested', 'ownership']) {
    await source.reload();
    await source.locator('#arrangement').evaluate((e, v) => {
      if (v === 'declaration') e.setAttribute('aria-label', 'I certify my answers');
      if (v === 'sensitive') e.setAttribute('aria-label', 'Gender');
      if (v === 'button') { const b = document.createElement('button'); b.type = 'submit'; e.replaceWith(b); b.append(e); }
      if (v === 'duplicate') e.children[1]!.textContent = 'Remote';
      if (v === 'hidden') e.children[1]!.setAttribute('hidden', '');
      if (v === 'nested') e.children[0]!.innerHTML = '<button>Submit application</button>';
      if (v === 'ownership') e.setAttribute('aria-owns', 'foreign');
    }, variant);
    s = await scan(source); expect(s.fields.filter((f) => f.control).every((f) => !f.executable)).toBe(true);
  }
  await source.goto(`${fixtures.origin}/F14?reject`); expect(await operate(source, choice(await scan(source)))).toMatchObject({ status: 'rejected', code: 'site_error' });
  await source.goto(`${fixtures.origin}/F14`); s = await scan(source); c = choice(s); await source.getByRole('radio', { name: 'Hybrid' }).click();
  expect(await operate(source, c)).toMatchObject({ status: 'unsupported' });
  await expect(source.getByLabel('Required branch city')).toBeVisible(); expect((await scan(source)).fields.some((f) => f.label === 'Required branch city' && f.required)).toBe(true);
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);
});

test('F14/F18 denied application frames stay manual in packaged inspection', async ({ inspector }) => {
  const { source, fixtures } = inspector;
  for (const pattern of ['F14', 'F18']) {
    await source.goto(`${fixtures.origin}/${pattern}-cross`); const popup = await inspector.popup();
    if (pattern === 'F18') await popup.getByRole('button', { name: 'Use this tab', exact: true }).click();
    await expect(popup.getByTestId('target-url')).toHaveText(source.url());
    await expect.poll(async () => (await current(popup)).access?.frames.some((f) => f.origin === fixtures.cross && f.url.endsWith(`/${pattern}`))).toBe(true);
    const cp = await current(popup), frame = cp.access!.frames.find((f) => f.origin === fixtures.cross)!;
    const denied = await popup.evaluate((intent) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), ...intent }), { type: 'INSPECT_FORM', sessionId: cp.id, revision: cp.revision, frameOrigin: frame.origin, frameIdentity: frame.identity });
    expect(denied.ok).toBe(false); expect((await current(popup)).submission.status).toBe('unknown');
    await popup.close();
  }
});
