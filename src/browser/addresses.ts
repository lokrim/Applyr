// These rules apply before persistence, UI display, permission requests and tab creation.
const jobKeys = /^(?:id|job|jobid|job_id|job-id|gh_jid|position|positionid|position_id|posting|postingid|posting_id|requisitionid|requisition_id|reqid|req_id|jk|vjk)$/i;
const restrictedHosts = new Set(['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com', 'accounts-static.cdn.mozilla.net', 'accounts.firefox.com', 'addons.cdn.mozilla.net', 'addons.mozilla.org', 'api.accounts.firefox.com', 'content.cdn.mozilla.net', 'discovery.addons.mozilla.org', 'install.mozilla.org', 'oauth.accounts.firefox.com', 'profile.accounts.firefox.com', 'support.mozilla.org', 'sync.services.mozilla.com']);

export function displayText(value: string | undefined | null): string | null {
  if (!value) return null;
  // Page text is untrusted and may contain pasted addresses or credentials.
  // eslint-disable-next-line no-control-regex -- Explicitly strip untrusted control characters.
  const clean = value.replace(/https?:\/\/\S+/gi, '[link]').replace(/\b(?:bearer\s+\S+|(?:token|password|secret|api[_-]?key|otp)\s*[:=]\s*\S+)/gi, '[redacted]').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return clean.slice(0, 180) || null;
}

export function parseApplicationUrl(raw: string, allowLoopback = false): URL {
  // eslint-disable-next-line no-control-regex -- Reject whitespace/control-bearing addresses.
  if (raw.length > 4096 || /[\u0000-\u0020\u007f]/.test(raw.trim())) throw new Error('Enter a valid HTTPS application URL.');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('Enter a valid HTTPS application URL.'); }
  if (!url.hostname || url.hostname.includes('*')) throw new Error('Enter an exact HTTPS application host.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:'))) throw new Error('Use HTTPS without embedded credentials. HTTP is limited to development loopback fixtures.');
  if (restrictedHosts.has(url.hostname) || url.pathname.toLowerCase().endsWith('.pdf')) throw new Error('This browser/store or PDF page cannot be inspected. Open the application website.');
  return url;
}

export function sanitizedUrl(url: URL): string {
  const safe = new URL(url.origin + url.pathname);
  // Never persist unknown queries, fragments, authentication or tracking parameters.
  for (const [key, value] of url.searchParams) if (jobKeys.test(key) && /^[\w.-]{1,100}$/.test(value)) safe.searchParams.append(key, value);
  // Redact token-shaped path segments and known secret-bearing path pairs.
  safe.pathname = safe.pathname.replace(/\/(token|auth|secret|reset|verify)\/[^/]+/gi, '/$1/[redacted]').replace(/[^/]{80,}/g, '[redacted]');
  return safe.href;
}

export async function addressIdentity(raw: string): Promise<string> {
  // An opaque digest distinguishes even unknown job query keys and hash-router jobs.
  // It is only an equality precondition, never a claim of URL safety or encryption.
  const url = new URL(raw); url.username = ''; url.password = '';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.href));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}

export function originPattern(origin: string, allowLoopback = false): string {
  const url = parseApplicationUrl(origin, allowLoopback);
  if (url.origin !== origin) throw new Error('An exact site origin is required.');
  return `${origin}/*`;
}
