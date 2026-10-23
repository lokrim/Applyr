import { expect, test, type Page } from '@playwright/test';
import { inspectForm } from '../../src/forms/inspect';
import { FormSnapshotSchema, type FormSelection } from '../../src/forms/schema';
import { addressIdentity } from '../../src/browser/addresses';
import { startFormFixtures } from '../fixtures/forms';

let fixtures: Awaited<ReturnType<typeof startFormFixtures>>;
test.beforeAll(async () => { fixtures = await startFormFixtures(); });
test.afterAll(async () => { await fixtures?.close(); });
async function inspect(page: Page, selection?: FormSelection) {
  const result = await page.evaluate(async ({ source, identity, selection }) => {
    // Only the test driver evaluates serialized bundled source. Production uses
    // scripting.executeScript(func) and never evaluates page/model text.
    return (0, eval)(`(${source})`)(identity, null, selection);
  }, { source: inspectForm.toString(), identity: await addressIdentity(page.url()), selection: selection ?? null });
  return FormSnapshotSchema.parse(result);
}

test('F01–F06 snapshots, stable revisions, required/conditional fields, manual steps, frames and shadow limits', async ({ browser }, info) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const snapshots = [];
  try {
    await page.goto(`${fixtures.origin}/F01`);
    await page.evaluate(() => {
      for (const prototype of [HTMLInputElement.prototype, HTMLSelectElement.prototype, HTMLTextAreaElement.prototype]) {
        for (const property of ['value', 'checked', 'files']) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
          if (descriptor) Object.defineProperty(prototype, property, { ...descriptor, set() { throw new Error('INSPECTION_WRITE'); } });
        }
      }
      HTMLFormElement.prototype.submit = () => { throw new Error('FINALIZATION'); };
      HTMLFormElement.prototype.requestSubmit = () => { throw new Error('FINALIZATION'); };
    });
    const before = await page.content();
    const f01 = await inspect(page); snapshots.push({ fixture: 'F01', snapshot: f01 });
    expect(await page.content()).toBe(before);
    expect(f01.status).toBe('stable'); expect(f01.fields).toHaveLength(21);
    expect(f01.fields.map((f) => f.type)).toEqual(expect.arrayContaining(['text', 'email', 'tel', 'url', 'date', 'month', 'number', 'select', 'radio', 'checkbox', 'textarea', 'file']));
    expect(f01.fields.find((f) => f.label === 'Full name')).toMatchObject({ required: true, current: { present: true }, context: ['Personal information'] });
    expect(f01.fields.find((f) => f.label === 'Email')?.validation.flags).toContain('valueMissing');
    expect(f01.fields.filter((f) => f.label === 'Name').map((f) => f.context)).toEqual([['Current employer'], ['Previous employer']]);
    expect(new Set(f01.fields.map((f) => f.id)).size).toBe(f01.fields.length);
    expect(f01.fields.find((f) => f.label === 'I agree to privacy terms')).toMatchObject({ category: 'declaration', executable: false });
    expect(f01.fields.find((f) => f.label === 'Require visa sponsorship')).toMatchObject({ category: 'sensitive', executable: false });
    expect(f01.fields.find((f) => f.type === 'textarea')).toMatchObject({ category: 'long_answer', constraints: { minLength: '20', maxLength: '400' } });
    expect(f01.fields.filter((f) => f.type === 'file').map((f) => f.filePurpose)).toEqual(['resume', 'cover_letter', 'transcript', 'portfolio']);
    expect(f01.fields.find((f) => f.label === 'Work location')?.options[2]?.disabled).toBe(true);
    expect(f01.fields.at(-1)).toMatchObject({ category: 'missing_semantics', executable: false });
    expect(JSON.stringify(f01)).not.toMatch(/Alex Fiction|F05_.*CANARY|Finalize|Submit application/);
    const stable = await inspect(page); expect(stable.revision).toBe(f01.revision); expect(stable.fields).toEqual(f01.fields);
    await page.reload(); const preEdit = await inspect(page);
    await page.getByLabel('Full name', { exact: true }).fill('Alex User Edit');
    const edited = await inspect(page); expect(edited.revision).toBeGreaterThan(preEdit.revision); expect(edited.fields[0]!.current.fingerprint).not.toBe(preEdit.fields[0]!.current.fingerprint);

    await page.goto(`${fixtures.origin}/F02`); await expect(page.getByLabel('Work location')).toContainText('Hybrid');
    const f02 = await inspect(page); snapshots.push({ fixture: 'F02', snapshot: f02 });
    expect(f02.fields).toHaveLength(3); expect(f02.fields[0]!.current.present).toBe(true);
    await page.getByLabel('Full name').fill('Edited React');
    const controlledEdit = await inspect(page); expect(controlledEdit.fields[0]!.current.fingerprint).not.toBe(f02.fields[0]!.current.fingerprint);
    await page.getByLabel('Email').fill('rejected@example.invalid'); await expect(page.getByLabel('Email')).toHaveValue('controlled@example.invalid');
    await page.getByRole('button', { name: 'Rerender controlled form' }).click();
    const rerender = await inspect(page); expect(rerender.revision).toBeGreaterThan(controlledEdit.revision); expect(rerender.fields[0]!.id).not.toBe(controlledEdit.fields[0]!.id); expect(rerender.document).toBe(f02.document);

    await page.goto(`${fixtures.origin}/F03`); const f03 = await inspect(page);
    await page.getByLabel('Need relocation?').check();
    const conditional = await inspect(page); snapshots.push({ fixture: 'F03', snapshot: conditional });
    expect(conditional.fields.find((f) => f.label === 'Required relocation city')).toMatchObject({ required: true, validation: { flags: ['valueMissing'] } });
    expect(conditional.revision).toBeGreaterThan(f03.revision);
    await page.getByRole('button', { name: 'Start mutation loop' }).click();
    const started = Date.now(); const loop = await inspect(page); expect(loop.status).toBe('unstable'); expect(loop.observation.scans).toBeLessThanOrEqual(4); expect(Date.now() - started).toBeLessThan(4000);
    await page.getByRole('button', { name: 'Stop mutation loop' }).click(); expect((await inspect(page)).status).toBe('stable');

    await page.goto(`${fixtures.origin}/F04`); const f04 = await inspect(page);
    await page.getByRole('button', { name: 'Next', exact: true }).click(); const next = await inspect(page); snapshots.push({ fixture: 'F04', snapshot: next });
    expect(next.identity).not.toBe(f04.identity); expect(next.document).not.toBe(f04.document); expect(next.fields.some((f) => f.type === 'textarea' && f.required)).toBe(true);
    expect(next.fields.some((f) => /finish|next|back/i.test(f.label))).toBe(false);
    await page.getByRole('button', { name: 'Back', exact: true }).click(); expect((await inspect(page)).fields).toHaveLength(3);
    await page.getByLabel('Application track').selectOption('Design'); await page.getByRole('button', { name: 'Next', exact: true }).click(); expect((await inspect(page)).fields.find((f) => f.label === 'Design portfolio URL')).toMatchObject({ type: 'url', required: true });
    expect(await page.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);

    await page.goto(`${fixtures.origin}/F05`); const f05 = await inspect(page); snapshots.push({ fixture: 'F05', snapshot: f05 });
    expect(f05.fields).toHaveLength(0); expect(f05.unsupported.filter((u) => u.code === 'frame_requires_inspection')).toHaveLength(2);
    const same = page.frames().find((f) => f.url() === `${fixtures.origin}/embedded`)!;
    const embedded = await same.evaluate(inspectForm, await addressIdentity(same.url())); expect(FormSnapshotSchema.parse(embedded).fields).toHaveLength(2);

    await page.goto(`${fixtures.origin}/F06`); const f06 = await inspect(page); snapshots.push({ fixture: 'F06', snapshot: f06 });
    expect(f06.fields.map((f) => f.label)).toEqual(['Full name', 'Email', 'Employer', 'Job title']);
    expect(f06.fields.find((f) => f.label === 'Employer')?.context).toEqual(['Open work history']);
    expect(f06.unsupported.map((u) => u.code)).toEqual(expect.arrayContaining(['opaque_custom_element', 'custom_control', 'canvas', 'rich_text']));
    expect(JSON.stringify(f06)).not.toContain('F05_CLOSED_CANARY');
    await info.attach('form-snapshots', { body: JSON.stringify(snapshots, null, 2), contentType: 'application/json' });
  } finally { await context.close(); }
});

test('multiple plausible forms require revision-bound selection; auth getters, irrelevant values and cookies are never read', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
  try {
    await page.goto(`${fixtures.origin}/F09`);
    await page.evaluate(() => {
      for (const e of document.querySelectorAll('input')) {
        if (e.closest('#application')) {
          for (const property of ['value', 'checked', 'files']) Object.defineProperty(e, property, { get() { throw new Error('AUTH_VALUE_READ'); }, set() { throw new Error('AUTH_WRITE'); } });
        }
      }
      Object.defineProperty(Document.prototype, 'cookie', { get() { throw new Error('COOKIE_READ'); } });
      HTMLFormElement.prototype.checkValidity = () => { throw new Error('VALIDATION_EVENT'); };
    });
    const snapshot = await inspect(page); expect(snapshot.fields).toHaveLength(0); expect(JSON.stringify(snapshot)).not.toMatch(/F05_.*CANARY/); expect(snapshot.unsupported.some((u) => u.code === 'authentication')).toBe(true);
    await page.goto(`${fixtures.origin}/F01`);
    await page.evaluate(() => { for (const e of document.querySelectorAll('#newsletter input,#search input,input[type=hidden]')) Object.defineProperty(e, 'value', { get() { throw new Error('IRRELEVANT_VALUE_READ'); } }); const form = document.querySelector('#application')!; const clone = form.cloneNode(true) as Element; clone.id = 'second-application'; clone.setAttribute('aria-label', 'Second application'); document.body.append(clone); });
    const ambiguous = await inspect(page); expect(ambiguous.status).toBe('selection_required'); expect(ambiguous.fields).toEqual([]); expect(ambiguous.forms).toHaveLength(2);
    const chosen = { formId: ambiguous.forms[1]!.id, document: ambiguous.document, revision: ambiguous.revision };
    const selected = await inspect(page, chosen); expect(selected.status).toBe('stable'); expect(selected.selectedForm).toBe(chosen.formId); expect(selected.fields.length).toBeGreaterThan(15);
    expect((await inspect(page, chosen)).status).toBe('stale_selection');
    const latest = await inspect(page); await page.evaluate(() => document.querySelector('#second-application')!.replaceWith(document.querySelector('#second-application')!.cloneNode(true)));
    expect((await inspect(page, { formId: latest.forms[1]!.id, document: latest.document, revision: latest.revision })).status).toBe('stale_selection');
  } finally { await context.close(); }
});

test('F07–F10 fixture hooks are controlled; inspection stays read-only and sends no uploads', async ({ browser }, info) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
  const outgoing: string[] = []; context.on('request', (r) => outgoing.push(r.url()));
  try {
    for (const fixture of ['F07', 'F08', 'F09', 'F10']) {
      await page.goto(`${fixtures.origin}/${fixture}`); const before = await page.content(); const result = await inspect(page);
      expect(await page.content()).toBe(before); expect(result.status).toBe('stable');
      expect(await page.evaluate(() => (window as unknown as { fixture: { finalizations: number; inputEvents: number } }).fixture)).toMatchObject({ finalizations: 0, inputEvents: 0 });
      if (fixture === 'F08') expect(result.fields.find((f) => f.type === 'textarea')!.label).toContain('<img');
      if (fixture === 'F10') { await page.getByRole('button', { name: 'Replace form' }).click(); const race = await inspect(page); expect(race.revision).toBeGreaterThan(result.revision); expect(race.fields[0]!.id).not.toBe(result.fields[0]!.id); }
    }
    expect(fixtures.requests.filter((r) => r.path === '/upload')).toHaveLength(0);
    expect(outgoing.every((url) => [fixtures.origin, fixtures.cross].includes(new URL(url).origin))).toBe(true);
    await info.attach('fixture-audit', { body: JSON.stringify({ origins: [fixtures.origin, fixtures.cross], requests: fixtures.requests, uploads: 0, providerRequests: 0, inspectedWrites: 0 }), contentType: 'application/json' });
  } finally { await context.close(); }
});

test('fixture-only F07 rejection/digest/duplicate hooks and F10 delayed/rerender/new-job races', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); const page = await context.newPage();
  try {
    await page.goto(`${fixtures.origin}/F07`);
    await page.locator('#upload').setInputFiles({ name: 'wrong.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') });
    await expect(page.locator('#upload-status')).toContainText('File rejected');
    const buffer = Buffer.from('%PDF-1.4\nsynthetic controlled fixture');
    await page.locator('#upload').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer });
    await expect(page.locator('#upload-status')).toContainText('Upload rejected by receiver');
    const { createHash } = await import('node:crypto');
    const upload = fixtures.requests.findLast((r) => r.path === '/upload')!;
    expect(upload).toMatchObject({ bytes: buffer.length, digest: createHash('sha256').update(buffer).digest('hex') });
    await page.locator('#upload').setInputFiles([]); await page.locator('#upload').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer });
    await expect(page.locator('#upload-status')).toContainText('Duplicate blocked');
    const snapshot = await inspect(page); expect(snapshot.fields.find((f) => f.type === 'file')).toMatchObject({ current: { present: true } });
    expect(snapshot.unsupported.filter((u) => u.code === 'custom_control').length).toBeGreaterThanOrEqual(2);

    await page.goto(`${fixtures.origin}/F10`); const original = await inspect(page);
    const raced = await page.evaluate(async ({ source, identity }) => {
      setTimeout(() => (document.querySelector('#rerender') as HTMLButtonElement).click(), 60);
      return (0, eval)(`(${source})`)(identity);
    }, { source: inspectForm.toString(), identity: await addressIdentity(page.url()) });
    const replaced = FormSnapshotSchema.parse(raced); expect(replaced.status).toBe('stable'); expect(replaced.revision).toBeGreaterThan(original.revision); expect(replaced.fields[0]!.id).not.toBe(original.fields[0]!.id);
    await page.getByRole('button', { name: 'Delay result', exact: true }).click(); await expect(page.getByLabel('Late required question')).toBeVisible();
    expect((await inspect(page)).fields.some((f) => f.label === 'Late required question' && f.required)).toBe(true);
    await page.getByRole('button', { name: 'New job at same URL', exact: true }).click(); const newJob = await inspect(page); expect(newJob.identity).toBe(original.identity); expect(newJob.revision).toBeGreaterThan(replaced.revision); expect(newJob.fields[0]!.label).toBe('New application name');
  } finally { await context.close(); }
});
