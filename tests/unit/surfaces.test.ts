import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  sidePanel: undefined as { open: ReturnType<typeof vi.fn> } | undefined,
  sidebarAction: undefined as { open: ReturnType<typeof vi.fn> } | undefined,
  runtime: { getURL: (path: string) => `extension://${path}`, openOptionsPage: vi.fn() },
  tabs: { create: vi.fn() },
}));
vi.mock('wxt/browser', () => ({ browser: api }));
import { openSessionSurface, surfaceCapability } from '../../src/browser/surfaces';

describe('browser surface fallback', () => {
  beforeEach(() => { api.sidePanel = undefined; api.sidebarAction = undefined; vi.clearAllMocks(); });
  it('invokes Chromium panel immediately using the captured window', async () => {
    api.sidePanel = { open: vi.fn().mockResolvedValue(undefined) };
    const opening = openSessionSurface(9);
    expect(api.sidePanel.open).toHaveBeenCalledWith({ windowId: 9 });
    expect(surfaceCapability()).toBe('Chromium side panel');
    await opening;
    expect(api.tabs.create).not.toHaveBeenCalled();
  });
  it('uses the distinct Firefox sidebar API', async () => {
    api.sidebarAction = { open: vi.fn().mockResolvedValue(undefined) };
    expect(surfaceCapability()).toBe('Firefox sidebar');
    await openSessionSurface(9);
    expect(api.sidebarAction.open).toHaveBeenCalledOnce();
    expect(api.tabs.create).not.toHaveBeenCalled();
  });
  it('falls back to a fixed packaged page on unavailable or rejected APIs', async () => {
    expect(surfaceCapability()).toBe('Packaged tab');
    await openSessionSurface(9);
    expect(api.tabs.create).toHaveBeenCalledWith({ url: 'extension:///session.html' });
    api.sidePanel = { open: vi.fn().mockRejectedValue(new Error('gesture denied')) };
    await openSessionSurface(9);
    expect(api.tabs.create).toHaveBeenCalledTimes(2);
  });
});
