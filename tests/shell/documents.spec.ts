import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { browser } from 'wxt/browser';
import type { DocumentRef } from '../../src/domain/document';
import { syntheticPdf } from '../fixtures/pdf';

declare const chrome: typeof browser;
type Payload = Pick<DocumentRef, 'filename' | 'mime' | 'size' | 'lastModified' | 'digest'> & { chunks: string[] };
declare global {
  interface Window { reconstructForProof(payload: Payload, selector?: string): Promise<{ status: string; reason?: string; bytes?: number[]; digest?: string; fileList?: boolean; count?: number }> }
}

test('real Chromium extension document lifecycle and owned native-input byte proof', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium'); test.setTimeout(90_000);
  const directory = await mkdtemp(path.join(tmpdir(), 'applyr-documents-'));
  const extension = path.resolve('.output/chrome-mv3');
  const received: { name: string; bytes: Buffer; digest: string; rejected: boolean }[] = [];
  const fixture = await readFile('tests/fixtures/native-upload.html');
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(fixture); return; }
    if (request.method === 'POST' && request.url?.startsWith('/receive?')) {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const form = await new Response(Buffer.concat(parts), { headers: { 'Content-Type': request.headers['content-type']! } }).formData();
      const file = form.get('resume');
      if (!(file instanceof File)) { response.writeHead(400); response.end(); return; }
      const bytes = Buffer.from(await file.arrayBuffer());
      const rejected = request.url.includes('reject');
      received.push({ name: file.name, bytes, digest: createHash('sha256').update(bytes).digest('hex'), rejected });
      response.writeHead(rejected ? 422 : 200); response.end(); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback fixture');
  const origin = `http://127.0.0.1:${address.port}`;
  const context = await chromium.launchPersistentContext(directory, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const outbound: string[] = [], errors: string[] = [], requests: string[] = [];
  context.on('request', (r) => { if (/^https?:/.test(r.url())) { requests.push(r.url()); if (!r.url().startsWith(`${origin}/`)) outbound.push(r.url()); } });
  await context.route(/^https?:/, (r) => r.request().url().startsWith(`${origin}/`) ? r.continue() : r.abort());
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const base = `chrome-extension://${worker.url().split('/')[2]}`;
  async function packaged(name: string) {
    const old = new Set(context.pages()); const url = `${base}/${name}.html`;
    await worker.evaluate(async (url) => chrome.tabs.create({ url, active: false }), url);
    await expect.poll(() => context.pages().some((p) => !old.has(p) && p.url() === url)).toBe(true);
    const page = context.pages().find((p) => !old.has(p) && p.url() === url)!;
    await expect(name === 'popup' ? page.getByTestId('checkpoint-id') : page.locator('.document-workspace')).toBeVisible(); return page;
  }
  async function disk(p: Page) {
    return p.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('applyr-local'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction(['documents', 'documentLinks', 'documentBlobs']);
      const all = <T>(store: string) => new Promise<T[]>((resolve) => { const r = tx.objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); });
      const [refs, links, blobs] = await Promise.all([all<DocumentRef>('documents'), all<unknown>('documentLinks'), all<Blob>('documentBlobs')]); db.close();
      return { refs, links, blobs: blobs.length };
    });
  }
  const firstBytes = Buffer.concat([Buffer.from(syntheticPdf(`fictional-original ${'padding '.repeat(10_000)}`)), Buffer.from([0, 255, 128, 13, 10])]);
  const first = { name: 'Fictional résumé.PDF', mimeType: 'application/pdf', buffer: firstBytes };
  const second = { name: 'second.pdf', mimeType: 'application/pdf', buffer: Buffer.from(syntheticPdf('second')) };
  const digest = createHash('sha256').update(firstBytes).digest('hex');
  try {
    await worker.evaluate(async () => chrome.tabs.create({ url: 'about:blank', active: true }));
    // Popup captures a checkpoint but has no document picker.
    const popup = await packaged('popup');
    await expect(popup.getByTestId('checkpoint-id')).toBeVisible(); expect(await popup.locator('input[type=file]').count()).toBe(0);
    const session = await packaged('session'); const options = await packaged('options');
    const docs = session.locator('.document-workspace');
    await docs.locator('input[type=file]').setInputFiles({ name: 'wrong.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not PDF') });
    await expect(docs.getByRole('alert')).toContainText('Choose one nonempty PDF');
    await expect(docs.getByRole('button', { name: 'Start local document session' })).toBeDisabled();
    await docs.locator('input[type=file]').setInputFiles(first);
    await expect(docs.getByTestId('pending-resume')).toContainText(digest);
    await expect(docs.getByLabel('Save as reusable resume', { exact: false })).not.toBeChecked();
    expect((await disk(session)).blobs).toBe(0);
    await session.getByRole('button', { name: 'Refresh checkpoint', exact: true }).click();
    await expect(docs.getByTestId('pending-resume')).toContainText(first.name);
    await docs.getByRole('button', { name: 'Start local document session' }).click();
    await expect(docs.getByTestId('session-resume')).toContainText(digest);
    const bound = (await disk(session)).refs.find((r) => r.scope === 'session')!;
    expect(bound.filename).toBe(first.name); expect(bound.digest).toBe(digest); expect((await disk(session)).blobs).toBe(1);
    await session.reload(); await expect(session.getByTestId('session-resume')).toContainText(bound.inputVersion);
    // Real browser Blob storage, explicit JSON-only automation-driver transport.
    const payload = await session.evaluate(async (ref): Promise<Payload> => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('applyr-local'); r.onsuccess = () => resolve(r.result); });
      const blob = await new Promise<Blob>((resolve) => { const r = db.transaction('documentBlobs').objectStore('documentBlobs').get(ref.blobRef); r.onsuccess = () => resolve(r.result as Blob); }); db.close();
      const bytes = new Uint8Array(await blob.arrayBuffer()); const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += 65536) chunks.push(btoa(String.fromCharCode(...bytes.slice(offset, offset + 65536))));
      return { filename: ref.filename, mime: ref.mime, size: ref.size, digest: ref.digest, lastModified: ref.lastModified, chunks };
    }, bound);
    expect(payload.chunks).toHaveLength(2);
    const harness = await context.newPage(); await harness.goto(origin);
    const serialized: Payload = JSON.parse(JSON.stringify(payload)) as Payload;
    const selected = await harness.evaluate((p) => window.reconstructForProof(p), serialized);
    expect(selected).toMatchObject({ status: 'input_selected', fileList: true, count: 1, digest });
    expect(Buffer.from(selected.bytes!)).toEqual(firstBytes);
    await expect(harness.locator('#selection')).toContainText(digest);
    await expect(harness.locator('#remote')).toHaveText('Not sent to receiver'); expect(received).toHaveLength(0);
    await harness.getByRole('button', { name: 'Send to owned local receiver' }).click();
    await expect(harness.locator('#remote')).toHaveText('Owned receiver accepted bytes');
    expect(received[0]).toMatchObject({ name: first.name, digest, rejected: false }); expect(received[0]!.bytes).toEqual(firstBytes);
    await harness.locator('#behavior').selectOption('reject'); await harness.getByRole('button', { name: 'Send to owned local receiver' }).click();
    await expect(harness.locator('#remote')).toContainText('rejected file'); expect(received[1]!.bytes).toEqual(firstBytes);
    await harness.evaluate((p) => window.reconstructForProof(p, '#custom'), serialized);
    await expect(harness.locator('#custom-state')).toContainText('Manual upload required');
    const invalid = await harness.evaluate((p) => window.reconstructForProof({ ...p, digest: '0'.repeat(64) }), serialized);
    expect(invalid.status).toBe('manual');
    await harness.screenshot({ path: testInfo.outputPath('native-proof.png'), fullPage: true });
    // A settings default save never mutates an existing session's version.
    const settingsDocs = options.locator('.document-workspace');
    await settingsDocs.locator('input[type=file]').setInputFiles(second);
    await expect(settingsDocs.getByTestId('pending-resume')).toContainText(second.name);
    await expect(settingsDocs.getByRole('button', { name: 'Save selected resume as default' })).toBeDisabled();
    await settingsDocs.getByLabel('Save as reusable resume', { exact: false }).check();
    await settingsDocs.getByRole('button', { name: 'Save selected resume as default' }).click();
    await expect(settingsDocs.getByTestId('saved-resume')).toContainText(second.name);
    await session.locator('.document-workspace').getByRole('button', { name: 'Reload document state' }).click();
    await expect(session.getByTestId('session-resume')).toContainText(bound.inputVersion);
    await session.locator('.document-workspace input[type=file]').setInputFiles(first);
    await expect(session.getByTestId('pending-resume')).toBeVisible();
    await session.locator('.document-workspace').getByRole('button', { name: 'Replace session resume' }).click();
    await expect(session.getByTestId('session-resume')).not.toContainText(bound.inputVersion);
    // Explicit saved reuse shares one stored Blob; deletion invalidates both views.
    await session.getByRole('button', { name: 'Use saved resume' }).click();
    await session.getByRole('button', { name: 'Replace session resume' }).click();
    await expect(session.getByTestId('session-resume')).toContainText(second.name);
    expect((await disk(session)).blobs).toBe(1);
    await options.getByRole('button', { name: 'Delete saved resume', exact: true }).click();
    await options.getByRole('button', { name: 'Confirm delete document and shared references' }).click();
    await expect(session.getByTestId('session-resume')).toContainText('Select the PDF again');
    expect((await disk(session)).blobs).toBe(0);
    // Explicit saving at Start is separate and preserves the default at cancellation.
    await session.locator('.document-workspace input[type=file]').setInputFiles(first);
    await expect(session.getByTestId('pending-resume')).toBeVisible();
    await session.getByLabel('Save as reusable resume', { exact: false }).check();
    await session.getByRole('button', { name: 'Replace session resume' }).click();
    await expect(session.getByTestId('session-resume')).toContainText(first.name);
    await session.locator('.document-workspace').screenshot({ path: testInfo.outputPath('documents.png') });
    await session.getByRole('button', { name: 'Cancel local session' }).click();
    await expect(session.getByTestId('session-resume')).toContainText('cancelled');
    expect((await disk(session)).refs.map((r) => r.scope)).toEqual(['saved']); expect((await disk(session)).blobs).toBe(1);
    await options.reload();
    await expect(options.locator('.document-workspace input[type=file]')).toBeVisible();
    await options.locator('.document-workspace input[type=file]').setInputFiles(second);
    await expect(options.getByTestId('pending-resume')).toContainText(second.name);
    await expect(options.getByLabel('Save as reusable resume', { exact: false })).not.toBeChecked();
    await options.getByRole('button', { name: 'Remove pending selection' }).click();
    expect((await disk(session)).refs.map((r) => r.scope)).toEqual(['saved']);
    expect(await session.evaluate(() => chrome.storage.local.get(null))).toEqual({});
    expect(outbound).toEqual([]); expect(errors).toEqual([]);
    await testInfo.attach('document-runtime', { body: JSON.stringify({ browser: 'Chromium', browserVersion: context.browser()!.version(), proof: 'Production extension UI/IndexedDB; JSON via test driver; ordinary owned loopback page File/DataTransfer/native input; multipart owned receiver', fullAuthorizedExtensionTransfer: false, digest, receiverByteEquality: received.every((r) => r.bytes.equals(firstBytes)), receiverRequests: received.length, customManualFallback: true, requests, outbound, errors, firefox: 'not run', brave: 'not run', edge: 'not run' }, null, 2), contentType: 'application/json' });
  } finally { await context.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); }
});
