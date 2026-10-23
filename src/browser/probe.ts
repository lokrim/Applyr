import type { FrameCandidate, PageClassification } from '../domain/session';

export interface ProbeResult {
  classification: PageClassification;
  identity: string;
  role: string | null;
  company: string | null;
  frames: FrameCandidate[];
}

// Serialized by scripting.executeScript into an ISOLATED world. Keep all runtime
// helpers inside this function. It receives only an identity precondition, no inputs.
export async function probePage(expectedIdentity: string, frameUrl: string | null = null): Promise<ProbeResult | null> {
  if (frameUrl && (window === window.top || location.origin !== new URL(frameUrl).origin || location.origin + location.pathname !== new URL(frameUrl).origin + new URL(frameUrl).pathname)) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.href.replace(/^(https?:\/\/)[^/@]+:[^/@]+@/, '$1')));
  const identity = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
  if (identity !== expectedIdentity) return null;
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    return !element.closest('[hidden],[inert],[aria-hidden="true"]') && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  // eslint-disable-next-line no-control-regex -- Page text must not retain control characters.
  const text = (v: string | null | undefined) => (v ?? '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 180);
  const headings = Array.from(document.querySelectorAll('h1,h2')).slice(0, 12).filter(visible).map((e) => text(e.textContent));
  const context = [text(document.title), location.pathname, ...headings].join(' ').toLowerCase();
  const job = /\b(apply|application|candidate|job|position|vacancy|career|hiring|resume|résumé)\b/;
  const frames: FrameCandidate[] = [];
  // Only discover visible, application-labelled embeds. Never inspect their values.
  for (const frame of Array.from(document.querySelectorAll('iframe')).slice(0, 30)) {
    if (!visible(frame) || !job.test(`${frame.title} ${frame.getAttribute('src') ?? ''}`.toLowerCase())) continue;
    try {
      const url = new URL(frame.getAttribute('src') ?? '', location.href);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) continue;
      url.username = ''; url.password = '';
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.href));
      const frameIdentity = Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
      url.hash = '';
      for (const [key, value] of Array.from(url.searchParams)) if (!/^(?:id|job|jobid|job_id|job-id|gh_jid|position|positionid|position_id|posting|postingid|posting_id|requisitionid|requisition_id|reqid|req_id|jk|vjk)$/i.test(key) || !/^[\w.-]{1,100}$/.test(value)) url.searchParams.delete(key);
      url.pathname = url.pathname.replace(/\/(token|auth|secret|reset|verify)\/[^/]+/gi, '/$1/[redacted]').replace(/[^/]{80,}/g, '[redacted]');
      if (frames.length < 4 && !frames.some((f) => f.url === url.href)) frames.push({ url: url.href, origin: url.origin, identity: frameIdentity });
    } catch { /* Unsupported embeds require manual use of the site. */ }
  }
  let login = /\b(sign[ -]?in|log[ -]?in|captcha|verify (?:you|your identity)|security challenge|one[ -]?time (?:code|password))\b/.test(context);
  let relevant = 0;
  // Scope controls to relevant forms; unrelated newsletter/search/payment forms
  // are never enumerated. No control values, hidden fields or cookie APIs are read.
  for (const form of Array.from(document.querySelectorAll('form,[role="form"]')).slice(0, 30)) {
    if (!visible(form)) continue;
    const meta = `${form.getAttribute('aria-label') ?? ''} ${form.id} ${form.getAttribute('name') ?? ''} ${form.getAttribute('action') ?? ''}`.toLowerCase();
    if (/newsletter|subscribe|search|payment|checkout/.test(meta)) continue;
    // Only recognize types/autocomplete, not names/labels/values, for authentication.
    if (Array.from(form.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]')).some(visible)) login = true;
    if (!job.test(meta) && !job.test(context)) continue;
    for (const control of Array.from(form.querySelectorAll('input:not([type="hidden"]):not([type="password"]):not([autocomplete="one-time-code"]),select,textarea')).slice(0, 100)) {
      if (!visible(control) || control.matches(':disabled,[readonly]')) continue;
      const type = control.getAttribute('type')?.toLowerCase() ?? 'text';
      if (['submit', 'reset', 'button', 'image'].includes(type)) continue;
      const label = `${control.getAttribute('name') ?? ''} ${control.id} ${control.getAttribute('autocomplete') ?? ''} ${control.getAttribute('aria-label') ?? ''}`.toLowerCase();
      if (/otp|one.?time|password|passcode|verification.?code|credit|card|cvc|cvv/.test(label)) continue;
      if (/name|email|phone|resume|cv|cover|education|experience|linkedin|portfolio|address|candidate/.test(label) || type === 'file') relevant++;
    }
  }
  const listing = /\b(careers|open positions|job openings|search jobs|job listings)\b/.test(context);
  const classification: PageClassification = login ? 'login_challenge' : relevant >= 2 ? 'application' : listing ? 'listing' : job.test(context) || frames.length || !context.trim() ? 'uncertain' : 'irrelevant';
  const heading = headings.find((h) => !/^(apply|application|careers|jobs|job application)$/i.test(h));
  const parts = (heading ?? '').split(/\s+(?:at|@)\s+/i);
  return { classification, identity, role: job.test(context) && parts.length === 2 ? text(parts[0]) : null, company: job.test(context) && parts.length === 2 ? text(parts[1]) : null, frames: classification === 'application' || login ? [] : frames };
}
