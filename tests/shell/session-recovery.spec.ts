import { expect, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { test } from '../fixtures/inspection-extension';
import type { Response } from '../../src/runtime/schemas';
import type { SessionCheckpoint } from '../../src/domain/session';

declare const chrome: typeof browser;
async function request(page: Page, intent: object) {
  const r = await page.evaluate((intent) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), ...intent }), intent) as Response;
  expect(r).toMatchObject({ ok: true }); if (!r.ok) throw new Error(r.code); return r;
}
async function current(page: Page) { return (await request(page, { type: 'GET_STATE', sessionId: null, revision: null })).checkpoint!; }
async function setup(inspector: { context: Page['context'] extends () => infer C ? C : never; popup: () => Promise<Page> }) {
  const popup = await inspector.popup(); await expect(popup.getByTestId('page-classification')).toHaveText('application');
  const session = await inspector.context.newPage(); await session.goto(popup.url().replace('popup.html', 'session.html'));
  await session.locator('.profile-workspace input[type=file]').setInputFiles({ name: 'fiction.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nprofile_version: 1\ncontact: {email: recovery@example.test, phone: "+001234"}\n---\n') });
  await session.getByRole('button', { name: 'Freeze profile for this session', exact: true }).click();
  await expect(session.getByTestId('frozen-profile-state')).toBeVisible();
  return { session, popup };
}
async function startData(session: Page) {
  const cp = await current(session), inspection = (await request(session, { type: 'INSPECT_FORM', sessionId: cp.id, revision: cp.revision })).inspection!;
  const inputVersion = await session.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => resolve(q.result); });
    return new Promise<string>((resolve) => { const q = db.transaction('profiles').objectStore('profiles').get('snapshot'); q.onsuccess = () => { db.close(); resolve(q.result.version); }; });
  });
  return { type: 'START_AUTOFILL', sessionId: cp.id, revision: cp.revision, inspection, inputVersion, runId: crypto.randomUUID(), corrections: [], resume: null };
}
async function waitStopped(page: Page) { await expect.poll(async () => (await current(page)).autofill?.status).not.toBe('running'); return current(page); }

test('F10 actual popup closure, tab switch, safe pause, reinspection, final scope and independent submission report', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector; await source.goto(`${fixtures.origin}/F01`);
  const { session, popup } = await setup(inspector); const start = await startData(session);
  const running = request(session, start);
  await expect(source.getByLabel('Email', { exact: true })).toHaveValue('recovery@example.test');
  let cp = await current(session);
  await request(session, { type: 'PAUSE_SESSION', sessionId: cp.id, revision: cp.revision });
  await popup.close();
  const unrelated = await context.newPage(); await unrelated.goto(`${fixtures.origin}/F01`); await unrelated.bringToFront();
  await running; cp = await waitStopped(session);
  expect(cp.lifecycle).toBe('PAUSED'); expect(cp.autofill?.operations).toHaveLength(1); expect(cp.autofill?.operations[0]?.result?.status).toBe('accepted');
  await expect(source.getByLabel('Phone', { exact: true })).toHaveValue(''); await expect(unrelated.getByLabel('Email', { exact: true })).toHaveValue('');
  await session.reload(); await expect(session.getByRole('heading', { name: 'Session: paused' })).toBeVisible();
  await session.getByRole('button', { name: 'Resume and reinspect', exact: true }).click();
  await expect(session.getByRole('heading', { name: 'Session: queued' })).toBeVisible();
  await expect(source.getByLabel('Phone', { exact: true })).toHaveValue('');
  await request(session, await startData(session)); cp = await current(session);
  expect(cp.lifecycle).toBe('READY_FOR_REVIEW'); expect(cp.reviewScope).toBe('current_step'); expect(cp.submission.status).toBe('unknown');
  await request(session, { type: 'FINAL_REVIEW', sessionId: cp.id, revision: cp.revision }); cp = await current(session);
  expect(cp.reviewScope).toBe('final_review');
  await request(session, { type: 'FINISH_SESSION', sessionId: cp.id, revision: cp.revision }); cp = await current(session);
  expect(cp.lifecycle).toBe('AUTOFILL_FINISHED'); expect(cp.submission.status).toBe('unknown');
  await request(session, { type: 'REPORT_SUBMISSION', sessionId: cp.id, revision: cp.revision }); cp = await current(session);
  expect(cp.submission.status).toBe('reported_by_user');
  expect(await source.evaluate(() => (window as unknown as { fixture: { finalizations: number } }).fixture.finalizations)).toBe(0);
  await session.reload();
  await expect(session.getByRole('region', { name: 'Session recovery' })).toContainText('reported by you');
  await session.getByRole('region', { name: 'Session recovery' }).screenshot({ path: info.outputPath('session-recovery.png') });
  await info.attach('F10-popup-pause', { body: JSON.stringify({ browser: context.browser()!.version(), checkpoint: cp }), contentType: 'application/json' });
});

for (const userEdit of [false, true]) test(`F10 actual worker termination after write before result: ${userEdit ? 'preserve user edit' : 'recover acceptance'} without replay`, async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector; await source.goto(`${fixtures.origin}/F01`);
  const { session, popup } = await setup(inspector), intent = await startData(session);
  const cdp = await context.newCDPSession(session);
  const versions: { versionId: string; scriptURL: string; runningStatus: string }[] = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (event) => versions.push(...event.versions)); await cdp.send('ServiceWorker.enable');
  await expect.poll(() => versions.some((v) => v.scriptURL.includes('background.js') && v.runningStatus === 'running')).toBe(true);
  const operation = session.evaluate((intent) => chrome.runtime.sendMessage({ ...intent, schemaVersion: 1, requestId: crypto.randomUUID() }).catch(() => null), intent).catch(() => null);
  await expect(source.getByLabel('Email', { exact: true })).toHaveValue('recovery@example.test');
  await cdp.send('ServiceWorker.stopWorker', { versionId: versions.findLast((v) => v.scriptURL.includes('background.js') && v.runningStatus === 'running')!.versionId });
  await operation; await popup.close();
  const interrupted = await current(session);
  expect(interrupted.lifecycle).toBe('NEEDS_ATTENTION'); expect(interrupted.autofill?.operations).toHaveLength(1);
  expect(interrupted.autofill?.operations[0]?.result).toBeNull();
  if (userEdit) await source.getByLabel('Email', { exact: true }).fill('edited@example.test');
  const before = await source.evaluate(() => (window as unknown as { fixture: { inputEvents: number } }).fixture.inputEvents);
  await request(session, { type: 'RESUME_SESSION', sessionId: interrupted.id, revision: interrupted.revision });
  const recovered = await current(session);
  expect(recovered.autofill?.operations[0]?.result?.status).toBe(userEdit ? 'skipped_user_change' : 'accepted');
  expect(await source.evaluate(() => (window as unknown as { fixture: { inputEvents: number } }).fixture.inputEvents)).toBe(before);
  await expect(source.getByLabel('Phone', { exact: true })).toHaveValue('');
  await session.reload(); expect((await current(session)).autofill?.operations[0]?.result?.status).toBe(userEdit ? 'skipped_user_change' : 'accepted');
  await cdp.detach();
  await info.attach('F10-worker-kill', { body: JSON.stringify({ browser: context.browser()!.version(), before: interrupted, recovered }), contentType: 'application/json' });
});

test('F10 reload, same/cross-origin navigation, target closure and job switching retain progress and require matching reattachment', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector; await source.goto(`${fixtures.origin}/F01`);
  const { session, popup } = await setup(inspector); await request(session, await startData(session));
  const saved = await current(session); expect(saved.autofill?.operations.some((o) => o.result?.status === 'accepted')).toBe(true);
  await source.reload(); await expect.poll(async () => (await current(session)).recovery?.inspectionRequired).toBe(true);
  let cp = await current(session);
  if (cp.access?.status !== 'ready') { await request(session, { type: 'PROBE_TARGET', sessionId: cp.id, revision: cp.revision }); cp = await current(session); }
  await request(session, { type: 'RESUME_SESSION', sessionId: cp.id, revision: cp.revision });
  await expect(source.getByLabel('Email', { exact: true })).toHaveValue('');
  await source.goto(`${fixtures.origin}/F02`); await expect.poll(async () => (await current(session)).access?.reason).toBe('navigation');
  cp = await current(session);
  const denied = await session.evaluate((cp) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'REATTACH_SESSION', sessionId: cp.id, revision: cp.revision, tabId: cp.target.tabId }), cp);
  expect(denied).toMatchObject({ ok: false, code: 'ACCESS_UNAVAILABLE' });
  await source.goto(`${fixtures.cross}/F01`); cp = await current(session); expect(cp.autofill?.operations).toEqual(saved.autofill?.operations);
  await source.close(); await expect.poll(async () => (await current(session)).access?.reason).toBe('closed');
  const matching = await context.newPage(); await matching.goto(`${fixtures.origin}/F01`);
  const tabId = await session.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)!.id!, matching.url());
  cp = await current(session); await request(session, { type: 'REATTACH_SESSION', sessionId: cp.id, revision: cp.revision, tabId });
  cp = await current(session); expect(cp.id).toBe(saved.id); expect(cp.recovery?.inspectionRequired).toBe(true); await expect(matching.getByLabel('Email', { exact: true })).toHaveValue('');
  await request(session, { type: 'PAUSE_SESSION', sessionId: cp.id, revision: cp.revision }); cp = await current(session);
  await request(popup, { type: 'CAPTURE_TARGET', tabId, sessionId: cp.id, revision: cp.revision });
  const next = await current(session); expect(next.id).not.toBe(saved.id);
  const restored = (await request(session, { type: 'RESTORE_SESSION', sessionId: next.id, revision: next.revision, archivedId: saved.id })).checkpoint as SessionCheckpoint;
  expect(restored.lifecycle).toBe('PAUSED'); expect(restored.autofill?.operations).toEqual(saved.autofill?.operations); expect(restored.recovery?.reattachRequired).toBe(true);
  await expect(matching.getByLabel('Email', { exact: true })).toHaveValue('');
  await info.attach('F10-navigation-jobs', { body: JSON.stringify({ browser: context.browser()!.version(), saved, restored }), contentType: 'application/json' });
});

test('F10 simulated browser restart requires user-selected matching target; no automatic write and missing inputs request reselection', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector; await source.goto(`${fixtures.origin}/F01`);
  const { session } = await setup(inspector); await request(session, await startData(session)); const saved = await current(session);
  const cdp = await context.newCDPSession(session), versions: { versionId: string; scriptURL: string; runningStatus: string }[] = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (event) => versions.push(...event.versions)); await cdp.send('ServiceWorker.enable');
  await expect.poll(() => versions.some((v) => v.scriptURL.includes('background.js') && v.runningStatus === 'running')).toBe(true);
  // Simulation: storage.session is cleared by browser restart. The actual worker
  // is stopped; production startup code must require deliberate attachment.
  await session.evaluate(() => chrome.storage.session.clear());
  await cdp.send('ServiceWorker.stopWorker', { versionId: versions.findLast((v) => v.scriptURL.includes('background.js') && v.runningStatus === 'running')!.versionId });
  let cp = await current(session); expect(cp.recovery?.reattachRequired).toBe(true); expect(cp.access?.reason).toBe('restart');
  expect(cp.autofill?.operations).toEqual(saved.autofill?.operations);
  const result = await session.evaluate((cp) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'RESUME_SESSION', sessionId: cp.id, revision: cp.revision }), cp);
  expect(result).toMatchObject({ ok: false, code: 'ACCESS_UNAVAILABLE' });
  const before = await source.evaluate(() => (window as unknown as { fixture: { inputEvents: number } }).fixture.inputEvents);
  await request(session, { type: 'REATTACH_SESSION', sessionId: cp.id, revision: cp.revision, tabId: cp.target.tabId }); cp = await current(session);
  expect(cp.recovery?.inspectionRequired).toBe(true); expect(await source.evaluate(() => (window as unknown as { fixture: { inputEvents: number } }).fixture.inputEvents)).toBe(before);
  await session.evaluate(async () => { const db = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => r(q.result); }); await new Promise<void>((r) => { const tx = db.transaction('profiles', 'readwrite'); tx.objectStore('profiles').delete('snapshot'); tx.oncomplete = () => r(); }); db.close(); });
  const missing = await session.evaluate((cp) => chrome.runtime.sendMessage({ schemaVersion: 1, requestId: crypto.randomUUID(), type: 'RESUME_SESSION', sessionId: cp.id, revision: cp.revision }), cp);
  expect(missing).toMatchObject({ ok: false, code: 'ACCESS_UNAVAILABLE' });
  await session.reload(); await expect(session.getByRole('region', { name: 'Session recovery' })).toContainText('require reselection');
  await cdp.detach(); await info.attach('F10-restart-simulation', { body: JSON.stringify({ browser: context.browser()!.version(), simulated: 'storage.session clearance', checkpoint: cp }), contentType: 'application/json' });
});

test('F10 actual worker termination after upload delivery observes selected bytes and never uploads twice', async ({ inspector }, info) => {
  const { source, fixtures, context } = inspector; await source.goto(`${fixtures.origin}/F07`);
  const { session } = await setup(inspector);
  await session.locator('.document-workspace input[type=file]').setInputFiles({ name: 'recovery.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nSynthetic recovery bytes\n') });
  await session.getByRole('button', { name: 'Start local document session', exact: true }).click();
  await expect(session.getByRole('status').filter({ hasText: 'Resume bound to this local session.' })).toBeVisible();
  const intent = await startData(session);
  const resume = await session.evaluate(async () => { const db = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open('applyr-local'); q.onsuccess = () => r(q.result); }); return new Promise<{ id: string; inputVersion: string }>((r) => { const q = db.transaction('documents').objectStore('documents').getAll(); q.onsuccess = () => { db.close(); const doc = q.result.find((d) => d.scope === 'session'); r({ id: doc.id, inputVersion: doc.inputVersion }); }; }); });
  const cdp = await context.newCDPSession(session), versions: { versionId: string; scriptURL: string; runningStatus: string }[] = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (event) => versions.push(...event.versions)); await cdp.send('ServiceWorker.enable');
  await expect.poll(() => versions.some((v) => v.scriptURL.includes('background.js') && v.runningStatus === 'running')).toBe(true);
  const operation = session.evaluate((intent) => chrome.runtime.sendMessage({ ...intent, schemaVersion: 1, requestId: crypto.randomUUID() }).catch(() => null), { ...intent, resume }).catch(() => null);
  await expect.poll(() => source.evaluate(() => (window as unknown as { fixture: { uploads: string[] } }).fixture.uploads.length)).toBe(1);
  await cdp.send('ServiceWorker.stopWorker', { versionId: versions.findLast((v) => v.scriptURL.includes('background.js') && v.runningStatus === 'running')!.versionId });
  await operation; let cp = await current(session);
  const pending = cp.autofill?.operations.find((o) => o.kind === 'upload'); expect(pending?.result).toBeNull();
  await request(session, { type: 'RESUME_SESSION', sessionId: cp.id, revision: cp.revision }); cp = await current(session);
  expect(cp.autofill?.operations.find((o) => o.kind === 'upload')?.result).toMatchObject({ selectedBytes: true, status: 'rejected', siteAcceptance: 'rejected' });
  await request(session, await startData(session));
  expect(fixtures.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  expect(await source.evaluate(() => (window as unknown as { fixture: { uploads: string[] } }).fixture.uploads.length)).toBe(1);
  await cdp.detach(); await info.attach('F10-upload-kill', { body: JSON.stringify({ browser: context.browser()!.version(), checkpoint: cp, uploads: fixtures.requests.filter((r) => r.method === 'POST') }), contentType: 'application/json' });
});
