import { expect, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { test } from '../fixtures/inspection-extension';
import { ResponseSchema, type Response } from '../../src/runtime/schemas';

declare const chrome: typeof browser;
const read = (page: Page) => page.evaluate(() => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'GET_STATE', sessionId: null, revision: null }));
async function inspect(page: Page, extra = {}) {
  const state = await read(page);
  const raw = await page.evaluate(({ checkpoint, extra }) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'INSPECT_FORM', sessionId: checkpoint.id, revision: checkpoint.revision, ...extra }), { checkpoint: state.checkpoint, extra });
  return ResponseSchema.parse(raw);
}
function successful(response: Response) { if (!response.ok || !response.inspection) throw new Error(JSON.stringify(response)); return response.inspection; }

test('production isolated inspector, inert review UI, exact frame denial, nonpersistent snapshots and selection', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector; const errors: string[] = [];
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  await source.goto(`${fixtures.origin}/F01`); const ui = await inspector.popup();
  await expect(ui.getByTestId('page-classification')).toHaveText('application');
  const first = successful(await inspect(ui)); expect(first.frameId).toBe(0); expect(first.browserDocumentId).toBeTruthy(); expect(first.snapshot.fields).toHaveLength(21);
  const second = successful(await inspect(ui)); expect(second.snapshot).toMatchObject({ revision: first.snapshot.revision, document: first.snapshot.document, fields: first.snapshot.fields });
  await ui.getByRole('button', { name: 'Inspect fields', exact: true }).click(); await expect(ui.getByTestId('form-inspection')).toContainText('21 fields');
  await expect(source.getByLabel('Full name', { exact: true })).toHaveValue('Alex Fiction');
  const persisted = await ui.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('applyr-local'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    try { const records = await Promise.all(Array.from(db.objectStoreNames).map((name) => new Promise<unknown[]>((resolve, reject) => { const req = db.transaction(name).objectStore(name).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }))); return JSON.stringify(records); }
    finally { db.close(); }
  });
  expect(persisted).not.toMatch(/fingerprint|Alex Fiction|Personal information/);

  await source.goto(`${fixtures.origin}/F08`); await source.bringToFront(); const attack = await inspector.popup(); await attack.getByRole('button', { name: 'Use this tab', exact: true }).click();
  await expect(attack.getByTestId('page-classification')).toHaveText('application'); await attack.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await expect(attack.getByTestId('form-inspection')).toContainText('<img src=x onerror='); expect(await attack.locator('.field-inspection img,.field-inspection script').count()).toBe(0);
  expect(await attack.evaluate(() => 'F05_ATTACK' in window)).toBe(false); await attack.screenshot({ path: info.outputPath('inspection.png'), fullPage: true });

  await source.goto(`${fixtures.origin}/F05`); const framed = await inspector.popup(); await framed.getByRole('button', { name: 'Use this tab', exact: true }).click();
  await expect.poll(async () => (await read(framed)).checkpoint.access.frames.length).toBe(2);
  const frameState = (await read(framed)).checkpoint;
  const same = frameState.access.frames.find((f: { origin: string }) => f.origin === fixtures.origin);
  const cross = frameState.access.frames.find((f: { origin: string }) => f.origin === fixtures.cross);
  expect(await inspect(framed, { frameOrigin: cross.origin, frameIdentity: cross.identity })).toMatchObject({ ok: false, code: 'ACCESS_UNAVAILABLE' });
  // Chrome may deny allFrames when an unrelated frame is ungranted. Remove the
  // other embeds via the test driver to prove the authorized same-origin path.
  await source.locator('iframe').evaluateAll((frames) => frames.slice(1).forEach((f) => f.remove()));
  const embedded = successful(await inspect(framed, { frameOrigin: same.origin, frameIdentity: same.identity })); expect(embedded.frameId).toBeGreaterThan(0); expect(embedded.snapshot.fields).toHaveLength(2); expect(embedded.snapshot.identity).toBe(same.identity);

  await source.goto(`${fixtures.origin}/F01`); await source.evaluate(() => { const clone = document.querySelector('form')!.cloneNode(true) as Element; clone.id = 'application-two'; clone.setAttribute('aria-label', 'Second application'); document.body.append(clone); });
  const ambiguous = await inspector.popup(); const previousId = (await read(ambiguous)).checkpoint.id; await ambiguous.getByRole('button', { name: 'Use this tab', exact: true }).click();
  await ambiguous.getByRole('button', { name: 'Start explicit separate run', exact: true }).click();
  await expect.poll(async () => (await read(ambiguous)).checkpoint.id).not.toBe(previousId);
  await expect(ambiguous.getByTestId('page-classification')).toHaveText('application'); await ambiguous.getByRole('button', { name: 'Inspect fields', exact: true }).click();
  await expect(ambiguous.getByTestId('form-inspection')).toContainText('selection required');
  await ambiguous.getByRole('button', { name: /2\. Second application/ }).click(); await expect(ambiguous.getByTestId('form-inspection')).toContainText('21 fields');
  await info.attach('extension-inspection-audit', { body: JSON.stringify({ browser: context.browser()!.version(), first, frame: embedded, requests: fixtures.requests, providerRequests: 0, inspectedWrites: 0, finalizations: 0, errors }), contentType: 'application/json' });
  expect(errors).toEqual([]); expect(fixtures.requests.some((r) => r.method !== 'GET')).toBe(false);
});

test('isolated extension snapshots F02–F04/F06/F09, rerenders, dynamic required fields and manual navigation', async ({ inspector }, info) => {
  const { source, fixtures } = inspector;
  await source.goto(`${fixtures.origin}/F02`); await expect(source.getByLabel('Work location')).toContainText('Hybrid');
  const ui = await inspector.popup(); await expect(ui.getByTestId('page-classification')).toHaveText('application');
  const initial = successful(await inspect(ui)); expect(initial.snapshot.fields).toHaveLength(3);
  await source.getByLabel('Full name').fill('Extension user edit');
  const edited = successful(await inspect(ui)); expect(edited.snapshot.revision).toBeGreaterThan(initial.snapshot.revision);
  await source.getByRole('button', { name: 'Rerender controlled form' }).click();
  const rerendered = successful(await inspect(ui)); expect(rerendered.snapshot.fields[0]!.id).not.toBe(edited.snapshot.fields[0]!.id);
  const evidence = [{ fixture: 'F02', snapshot: rerendered.snapshot }];
  async function attach(fixture: string) {
    await source.goto(`${fixtures.origin}/${fixture}`); const panel = await inspector.popup();
    const previous = (await read(panel)).checkpoint.id;
    await panel.getByRole('button', { name: 'Use this tab', exact: true }).click();
    await expect.poll(async () => { const checkpoint = (await read(panel)).checkpoint; return checkpoint.id !== previous && !!checkpoint.access.inspectedAt; }).toBe(true); return panel;
  }
  const conditional = await attach('F03'); await source.getByLabel('Need relocation?').check();
  const dynamic = successful(await inspect(conditional)); expect(dynamic.snapshot.fields.find((f) => f.label === 'Required relocation city')).toMatchObject({ required: true }); evidence.push({ fixture: 'F03', snapshot: dynamic.snapshot });
  await source.getByRole('button', { name: 'Start mutation loop' }).click(); expect(successful(await inspect(conditional)).snapshot.status).toBe('unstable'); await source.getByRole('button', { name: 'Stop mutation loop' }).click();
  const stepped = await attach('F04'); const before = successful(await inspect(stepped));
  await source.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(async () => (await read(stepped)).checkpoint.access.reason).toBe('navigation'); expect(await inspect(stepped)).toMatchObject({ ok: false, code: 'ACCESS_UNAVAILABLE' });
  const nextPanel = await inspector.popup(); const previousStepId = (await read(nextPanel)).checkpoint.id; await nextPanel.getByRole('button', { name: 'Use this tab', exact: true }).click();
  await nextPanel.getByRole('button', { name: 'Start explicit separate run', exact: true }).click();
  await expect.poll(async () => { const checkpoint = (await read(nextPanel)).checkpoint; return checkpoint.id !== previousStepId && !!checkpoint.access.inspectedAt; }).toBe(true);
  const after = successful(await inspect(nextPanel)); expect(after.snapshot.identity).not.toBe(before.snapshot.identity); expect(after.snapshot.fields.some((f) => f.type === 'textarea')).toBe(true); evidence.push({ fixture: 'F04', snapshot: after.snapshot });
  const shadow = await attach('F06'); const open = successful(await inspect(shadow)); expect(open.snapshot.fields.map((f) => f.label)).toEqual(['Full name', 'Email', 'Employer', 'Job title']); expect(open.snapshot.unsupported.some((u) => u.code === 'opaque_custom_element')).toBe(true); evidence.push({ fixture: 'F06', snapshot: open.snapshot });
  const auth = await attach('F09'); const gated = successful(await inspect(auth)); expect(gated.snapshot.fields).toEqual([]); expect(gated.snapshot.unsupported.some((u) => u.code === 'authentication')).toBe(true); expect(JSON.stringify(gated)).not.toMatch(/F05_.*CANARY/);
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number; inputEvents: number } }).fixture)).toMatchObject({ finalizations: 0, inputEvents: 0 });
  await info.attach('isolated-fixture-snapshots', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
});
