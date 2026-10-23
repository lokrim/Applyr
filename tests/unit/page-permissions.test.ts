import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ permissions: { request: vi.fn() } }));
vi.mock('wxt/browser', () => ({ browser: api }));
import { requestPageOrigin } from '../../src/browser/page-permissions';

describe('gesture-scoped origin permission requests', () => {
  beforeEach(() => vi.resetAllMocks());
  it('requests only the exact origin synchronously, before any awaited work', async () => {
    api.permissions.request.mockResolvedValue(true);
    const request = requestPageOrigin('https://jobs.example');
    expect(api.permissions.request).toHaveBeenCalledExactlyOnceWith({ origins: ['https://jobs.example/*'] });
    expect(await request).toBe(true);
  });
  it('preserves denial and rejects wildcard/path/credential requests', async () => {
    api.permissions.request.mockResolvedValue(false);
    expect(await requestPageOrigin('https://frame.example')).toBe(false);
    for (const origin of ['https://*', 'https://*.example', 'https://example.org/path', 'https://u:p@example.org']) expect(() => requestPageOrigin(origin)).toThrow();
    expect(api.permissions.request).toHaveBeenCalledOnce();
  });
});
