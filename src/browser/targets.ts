import type { TargetReference } from '../domain/session';
import { addressIdentity, displayText, parseApplicationUrl, sanitizedUrl } from './addresses';

export function targetReference(tab: { id?: number; windowId: number; url?: string; title?: string }, allowLoopback = false): TargetReference {
  if (tab.id === undefined || tab.id < 0 || tab.windowId < 0) throw new Error('TAB_UNAVAILABLE');
  let origin: string | null = null;
  let availability: TargetReference['availability'] = 'unavailable';
  let address: string | null = null;
  if (tab.url) {
    availability = 'restricted';
    try {
      const url = parseApplicationUrl(tab.url, allowLoopback);
      origin = url.origin; availability = url.protocol === 'https:' ? 'https' : 'loopback'; address = sanitizedUrl(url);
    } catch { /* No raw URL or title is persisted. */ }
  }
  return { tabId: tab.id, windowId: tab.windowId, origin, availability, url: address, title: displayText(tab.title), role: null, company: null };
}

export async function capturedTarget(tab: Parameters<typeof targetReference>[0], allowLoopback = false) {
  const target = targetReference(tab, allowLoopback);
  return target.origin && tab.url ? { ...target, identity: await addressIdentity(tab.url) } : target;
}
