import { test, expect, type Page } from '@playwright/test';
import { inspectForm } from '../../src/forms/inspect';
import { operateControl } from '../../src/forms/apply';
import { FormSnapshotSchema, type FormSnapshot } from '../../src/forms/schema';
import type { ContentOperation } from '../../src/forms/operations';
import { addressIdentity } from '../../src/browser/addresses';
import { startFormFixtures } from '../fixtures/forms';

let fixtures: Awaited<ReturnType<typeof startFormFixtures>>;
test.beforeAll(async () => { fixtures = await startFormFixtures(); });
test.afterAll(async () => { await fixtures?.close(); });
async function inspect(page: Page) {
  return FormSnapshotSchema.parse(await page.evaluate(async ({ source, identity }) => (0, eval)(`(${source})`)(identity), { source: inspectForm.toString(), identity: await addressIdentity(page.url()) }));
}
async function operation(page: Page, command: ContentOperation) {
  return page.evaluate(async ({ source, command }) => (0, eval)(`(${source})`)(command), { source: operateControl.toString(), command });
}
function base(snapshot: FormSnapshot, field: FormSnapshot['fields'][number]) {
  return { operationId: crypto.randomUUID(), runId: crypto.randomUUID(), fieldId: field.id, precondition: field.current.fingerprint, binding: { sessionId: crypto.randomUUID(), tabId: 1, frameId: 0, browserDocumentId: null, identity: snapshot.identity, document: snapshot.document, revision: snapshot.revision, inputVersion: crypto.randomUUID() } };
}

test('ordinary DOM production executor all native types, required rejection, identity/precondition guards, cache and detached controls', async ({ browser }, info) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
  try {
    await page.goto(`${fixtures.origin}/F01`);
    const evidence: unknown[] = [];
    for (const [label, text] of [['Email', 'native@example.test'], ['Phone', '+001234'], ['Website', 'https://example.test'], ['Start date', '2026-11-01'], ['Graduation month', '2026-11'], ['Years experience', '0'], ['Name', 'Fictional Employer'], ['Why this role?', 'A supplied fictional explanation with enough characters.']]) {
      const snapshot = await inspect(page), field = snapshot.fields.find((f) => f.label === label)!;
      const command: ContentOperation = { ...base(snapshot, field), type: 'write', value: { kind: 'text', text: text! }, eligibilityApproved: false };
      const result = await operation(page, command); expect(result).toMatchObject({ status: 'accepted', code: 'persisted_valid' }); evidence.push({ type: field.type, result });
      const events = await page.evaluate(() => (window as unknown as { fixture: { inputEvents: number } }).fixture.inputEvents);
      expect(await operation(page, command)).toEqual(result);
      expect(await page.evaluate(() => (window as unknown as { fixture: { inputEvents: number } }).fixture.inputEvents)).toBe(events);
    }
    let snapshot = await inspect(page); const select = snapshot.fields.find((f) => f.type === 'select')!;
    expect(await operation(page, { ...base(snapshot, select), type: 'write', value: { kind: 'choice', label: 'Remote', optionFingerprint: select.options[1]!.fingerprint }, eligibilityApproved: false })).toMatchObject({ status: 'accepted' });
    snapshot = await inspect(page); const radio = snapshot.fields.find((f) => f.type === 'radio')!;
    expect(await operation(page, { ...base(snapshot, radio), type: 'write', value: { kind: 'choice', label: 'Part time', optionFingerprint: radio.options[1]!.fingerprint }, eligibilityApproved: false })).toMatchObject({ status: 'accepted' });
    await expect(page.getByLabel('Part time')).toBeChecked(); await expect(page.getByLabel('Full time')).not.toBeChecked();
    snapshot = await inspect(page); const box = snapshot.fields.find((f) => f.label === 'Send job updates')!;
    expect(await operation(page, { ...base(snapshot, box), type: 'write', value: { kind: 'checked', checked: true, optionFingerprint: box.options[0]!.fingerprint }, eligibilityApproved: false })).toMatchObject({ status: 'accepted' });
    snapshot = await inspect(page); const consent = snapshot.fields.find((f) => f.category === 'declaration')!;
    expect(await operation(page, { ...base(snapshot, consent), type: 'write', value: { kind: 'checked', checked: true, optionFingerprint: consent.options[0]!.fingerprint }, eligibilityApproved: true })).toMatchObject({ status: 'unsupported' });
    await expect(page.getByLabel('I agree to privacy terms')).not.toBeChecked();
    await page.reload(); snapshot = await inspect(page); const email = snapshot.fields.find((f) => f.label === 'Email')!;
    const command: ContentOperation = { ...base(snapshot, email), type: 'write', value: { kind: 'text', text: 'bad-email' }, eligibilityApproved: false };
    expect(await operation(page, command)).toMatchObject({ status: 'rejected', code: 'site_error' });
    await page.reload(); snapshot = await inspect(page); const original = snapshot.fields.find((f) => f.label === 'Email')!;
    const stale: ContentOperation = { ...base(snapshot, original), type: 'write', value: { kind: 'text', text: 'safe@example.test' }, eligibilityApproved: false };
    await page.getByLabel('Email', { exact: true }).fill('user@example.test');
    expect(await operation(page, stale)).toMatchObject({ status: 'skipped_user_change' });
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('user@example.test');
    const fresh = await inspect(page); const phone = fresh.fields.find((f) => f.label === 'Phone')!;
    await page.getByLabel('Phone').evaluate((e) => e.replaceWith(e.cloneNode(true)));
    expect(await operation(page, { ...base(fresh, phone), type: 'write', value: { kind: 'text', text: '+001234' }, eligibilityApproved: false })).toMatchObject({ status: 'unsupported', code: 'stale_control' });
    expect(await operation(page, { ...stale, binding: { ...stale.binding, document: crypto.randomUUID() } })).toMatchObject({ status: 'unsupported' });
    expect(await page.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);
    await info.attach('native-operations', { body: JSON.stringify({ browser: browser.version(), evidence, finalizations: 0 }), contentType: 'application/json' });
  } finally { await context.close(); }
});

test('upload transfer rejects malformed ordering/hash, scopes buffers, clears on cancel and reports selection without site acceptance', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
  try {
    await page.goto(`${fixtures.origin}/F01`);
    const snapshot = await inspect(page), field = snapshot.fields.find((f) => f.filePurpose === 'resume')!, binding = base(snapshot, field);
    const bytes = Array.from(new TextEncoder().encode('%PDF-1.7\nfixture'));
    const { createHash } = await import('node:crypto'); const digest = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    const begin: ContentOperation = { ...binding, type: 'begin', file: { name: 'resume.pdf', mime: 'application/pdf', size: bytes.length, lastModified: 123, digest } };
    expect(await operation(page, begin)).toEqual({ ready: true });
    expect(await operation(page, { ...binding, type: 'chunk', offset: 1, bytes })).toMatchObject({ code: 'transfer_invalid' });
    expect(await operation(page, { ...binding, type: 'commit' })).toMatchObject({ code: 'transfer_invalid' });
    const second = { ...binding, operationId: crypto.randomUUID() };
    expect(await operation(page, { ...begin, ...second })).toEqual({ ready: true });
    expect(await operation(page, { ...second, type: 'chunk', offset: 0, bytes: bytes.map(() => 0) })).toEqual({ ready: true });
    expect(await operation(page, { ...second, type: 'commit' })).toMatchObject({ code: 'transfer_invalid' });
    const third = { ...binding, operationId: crypto.randomUUID() };
    expect(await operation(page, { ...begin, ...third })).toEqual({ ready: true });
    expect(await operation(page, { ...third, type: 'cancel' })).toMatchObject({ code: 'cancelled' });
    expect(await operation(page, { ...third, type: 'commit' })).toMatchObject({ code: 'cancelled' });
    const fourth = { ...binding, operationId: crypto.randomUUID(), runId: crypto.randomUUID() };
    expect(await operation(page, { ...begin, ...fourth })).toEqual({ ready: true });
    expect(await operation(page, { ...fourth, type: 'chunk', offset: 0, bytes })).toEqual({ ready: true });
    expect(await operation(page, { ...fourth, type: 'commit' })).toMatchObject({ status: 'unverified', code: 'selected_only', selectedBytes: true, siteAcceptance: 'unverified' });
    expect(await operation(page, { ...fourth, type: 'verify' })).toMatchObject({ status: 'unverified', selectedBytes: true });
  } finally { await context.close(); }
});

test('a relabelled OTP/password control is rejected before any value getter is read', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
  try {
    await page.goto(`${fixtures.origin}/F01`); const snapshot = await inspect(page), email = snapshot.fields.find((f) => f.label === 'Email')!;
    await page.getByLabel('Email', { exact: true }).evaluate((e) => {
      e.parentElement!.firstChild!.textContent = 'One-time verification code';
      Object.defineProperty(e, 'value', { get() { throw new Error('PROTECTED_VALUE_READ'); } });
    });
    expect(await operation(page, { ...base(snapshot, email), type: 'write', value: { kind: 'text', text: 'fiction@example.test' }, eligibilityApproved: false })).toMatchObject({ status: 'skipped_user_change' });
    await page.reload(); const fresh = await inspect(page), f = fresh.fields.find((f) => f.label === 'Email')!;
    await page.getByLabel('Email', { exact: true }).evaluate((e) => {
      e.addEventListener('change', () => {
        (e as HTMLInputElement).type = 'password';
        Object.defineProperty(e, 'value', { get() { throw new Error('PROTECTED_VALUE_READ'); } });
      });
    });
    expect(await operation(page, { ...base(fresh, f), type: 'write', value: { kind: 'text', text: 'fiction@example.test' }, eligibilityApproved: false })).toMatchObject({ status: 'unverified', code: 'stale_control' });
  } finally { await context.close(); }
});

test('radio groups with hidden preselected members abstain without reading the hidden answer', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
  try {
    await page.goto(`${fixtures.origin}/F01`);
    await page.evaluate(() => {
      const radio = document.querySelector('input[name=schedule]')!;
      const hidden = document.createElement('input'); hidden.type = 'radio'; hidden.name = 'schedule'; hidden.hidden = true; hidden.checked = true; radio.parentElement!.append(hidden);
      Object.defineProperty(hidden, 'checked', { get() { throw new Error('HIDDEN_ANSWER_READ'); } });
    });
    const snapshot = await inspect(page);
    expect(snapshot.fields.filter((f) => f.type === 'radio').every((f) => !f.executable && !f.options.length && !f.radioGroup)).toBe(true);
  } finally { await context.close(); }
});
