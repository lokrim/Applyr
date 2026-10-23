import { describe, expect, it } from 'vitest';
import { createCheckpoint, RECOVERY_TTL_MS } from '../../src/domain/session';
import { RequestSchema, CheckpointSchema, TargetSchema } from '../../src/runtime/schemas';
import { trustedPage } from '../../src/security/sender';
import { targetReference } from '../../src/browser/targets';

const id = 'da295600-6e98-4ab1-a651-9405353b222a';
const envelope = { schemaVersion: 1, requestId: id, sessionId: null, revision: null };
const page = 'chrome-extension://test/popup.html';

describe('runtime trust boundaries', () => {
  it('accepts only strict versioned intents and no privileged generic commands', () => {
    expect(RequestSchema.safeParse({ ...envelope, type: 'GET_STATE' }).success).toBe(true);
    for (const raw of [
      { ...envelope, type: 'SUBMIT' }, { ...envelope, type: 'FETCH', url: 'https://example.org' },
      { ...envelope, type: 'EXECUTE', script: 'alert(1)' }, { ...envelope, type: 'GET_STATE', credential: 'secret' },
      { ...envelope, type: 'GET_STATE', schemaVersion: 2 }, { ...envelope, type: 'CAPTURE_TARGET', tabId: -1 },
      { ...envelope, type: 'CAPTURE_TARGET', tabId: '1' }, { ...envelope, type: 'GET_STATE', requestId: 'bad' },
    ]) expect(RequestSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects content, foreign, nested, inactive and lookalike senders', () => {
    expect(trustedPage({ id: 'test', url: page }, 'test', [page])).toBe(page);
    expect(trustedPage({ id: 'test', url: page, tab: { url: page } }, 'test', [page])).toBe(page);
    for (const sender of [
      { id: 'foreign', url: page }, { id: 'test', url: 'https://evil.invalid/popup.html' },
      { id: 'test', url: `${page}?fake=1` }, { id: 'test', url: `${page}/child` },
      { id: 'test', url: page, tab: { url: 'https://evil.invalid' } },
      { id: 'test', url: page, frameId: 1 }, { id: 'test', url: page, documentLifecycle: 'prerender' },
      { id: 'test' },
    ]) expect(trustedPage(sender, 'test', [page])).toBeNull();
  });

  it('persists only the HTTPS origin, never credentials, path, query, fragment or title', () => {
    const target = targetReference({ id: 7, windowId: 1, url: 'https://user:secret@example.org/private?token=secret#otp' });
    expect(target).toEqual({ tabId: 7, windowId: 1, origin: 'https://example.org', availability: 'https' });
    expect(targetReference({ id: 7, windowId: 1, url: 'chrome://settings' }).availability).toBe('restricted');
    expect(targetReference({ id: 7, windowId: 1 }).availability).toBe('unavailable');
    expect(() => targetReference({ windowId: 1 })).toThrow();
    expect(TargetSchema.safeParse({ ...target, origin: 'https://example.org/path' }).success).toBe(false);
    expect(TargetSchema.safeParse({ ...target, origin: null }).success).toBe(false);
  });

  it('creates a truthful, expiring setup checkpoint with no candidate or submission claim', () => {
    const record = createCheckpoint(targetReference({ id: 7, windowId: 1 }), id, 1_000);
    expect(CheckpointSchema.parse(record)).toEqual(record);
    expect(record.expiresAt).toBe(1_000 + RECOVERY_TTL_MS);
    expect(record.lifecycle).toBe('QUEUED');
    expect(record.submission.status).toBe('unknown');
    expect(CheckpointSchema.safeParse({ ...record, profile: { name: 'test' } }).success).toBe(false);
    expect(CheckpointSchema.safeParse({ ...record, expiresAt: 0 }).success).toBe(false);
  });
});
