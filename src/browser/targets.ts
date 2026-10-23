import type { TargetReference } from '../domain/session';

export function targetReference(tab: { id?: number; windowId: number; url?: string }): TargetReference {
  if (tab.id === undefined || tab.id < 0 || tab.windowId < 0) throw new Error('TAB_UNAVAILABLE');
  let origin: string | null = null;
  let availability: TargetReference['availability'] = 'unavailable';
  if (tab.url) {
    availability = 'restricted';
    try {
      const url = new URL(tab.url);
      if (url.protocol === 'https:') { origin = url.origin; availability = 'https'; }
    } catch { /* No raw URL or title is persisted. */ }
  }
  return { tabId: tab.id, windowId: tab.windowId, origin, availability };
}
