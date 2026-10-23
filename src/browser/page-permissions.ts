import { browser } from 'wxt/browser';
import { originPattern } from './addresses';

// Call synchronously from the click handler. No messaging/storage/contains await
// may intervene before permissions.request, particularly in Firefox.
export function requestPageOrigin(origin: string) {
  return browser.permissions.request({ origins: [originPattern(origin, import.meta.env.DEV)] });
}
