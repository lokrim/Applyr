import { browser } from 'wxt/browser';
import { branding } from '../branding';

// Firefox's API is feature-detected independently; WXT's Chrome-based types omit it.
type SidebarBrowser = { sidebarAction?: { open(): Promise<void> } };
function sidebar() { return (browser as unknown as SidebarBrowser).sidebarAction; }

export function surfaceCapability(): 'Chromium side panel' | 'Firefox sidebar' | 'Packaged tab' {
  if (typeof sidebar()?.open === 'function') return 'Firefox sidebar';
  if (typeof browser.sidePanel?.open === 'function') return 'Chromium side panel';
  return 'Packaged tab';
}

export async function openSessionSurface(windowId: number): Promise<string> {
  // Called directly from a click, after the popup has captured and saved its source tab.
  // Do not insert storage/messaging awaits before these user-gesture-sensitive calls.
  try {
    if (sidebar()?.open) { await sidebar()!.open(); return 'Firefox sidebar opened'; }
    if (browser.sidePanel?.open) { await browser.sidePanel.open({ windowId }); return 'Chromium side panel opened'; }
  } catch { /* Browser may expose an API but reject it; the packaged tab remains usable. */ }
  await openSessionTab();
  return 'Session opened in a packaged tab';
}

export function openSessionTab() { return browser.tabs.create({ url: browser.runtime.getURL(branding.pages.session) }); }
export function openOptions() { return browser.runtime.openOptionsPage(); }

export async function restrictPreferenceAccess() {
  const local = browser.storage.local;
  if (typeof local.setAccessLevel === 'function') await local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}
