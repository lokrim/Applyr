// Structural subset makes the trust rule independently testable.
export interface Sender {
  id?: string;
  url?: string;
  frameId?: number;
  documentLifecycle?: string;
  tab?: { url?: string };
}

export function trustedPage(sender: Sender, extensionId: string, pageUrls: readonly string[]): string | null {
  if (sender.id !== extensionId || !sender.url || (sender.frameId !== undefined && sender.frameId !== 0)) return null;
  if (sender.documentLifecycle && sender.documentLifecycle !== 'active') return null;
  // Exact packaged URLs only; no content senders, nested pages, query strings or lookalike hosts.
  if (!pageUrls.includes(sender.url)) return null;
  if (sender.tab && sender.tab.url !== sender.url) return null;
  return sender.url;
}
