import type { AttentionTarget } from '../attention/schema';
import type { InspectionState } from './inspect';
// Serialized in ISOLATED. No labels, answers, selectors, events or credential reads.
export async function markAttention(target: AttentionTarget | null, fieldIds: string[], show: boolean): Promise<boolean> {
  const scope = globalThis as typeof globalThis & { __applyrInspection?: InspectionState; __applyrMarkers?: { clear: () => void } };
  scope.__applyrMarkers?.clear();
  if (!target) return true;
  const state = scope.__applyrInspection;
  const hash = async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(location.href.replace(/^(https?:\/\/)[^/@]+:[^/@]+@/, '$1')))), (b) => b.toString(16).padStart(2, '0')).join('');
  if (!state || state.identity !== target.identity || state.document !== target.document || state.revision !== target.revision || await hash() !== target.identity) return false;
  const entries = fieldIds.slice(0, 100).map((id) => ({ id, el: state.registry.get(id)?.deref() }));
  if (!entries.length || entries.some((x) => !x.el?.isConnected || !state.safeRead?.(x.id))) return false;
  type Runtime = { id: string; onMessage: { addListener: (fn: (message: unknown, sender: { id?: string }) => void) => void; removeListener: (fn: (message: unknown, sender: { id?: string }) => void) => void } };
  const runtimeScope = globalThis as typeof globalThis & { chrome?: { runtime?: Runtime }; browser?: { runtime?: Runtime } };
  const runtime = runtimeScope.browser?.runtime ?? runtimeScope.chrome?.runtime;
  const onClear = (message: unknown, sender: { id?: string }) => { if (runtime && sender.id === runtime.id && typeof message === 'object' && message !== null && Object.keys(message).length === 1 && 'channel' in message && message.channel === 'clear-applyr-markers') clear(); };
  const host = document.createElement('div'); host.setAttribute('aria-hidden', 'true'); host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
  const root = host.attachShadow({ mode: 'closed' });
  const marks = entries.map(({ el }) => {
    const mark = document.createElement('div'); mark.textContent = 'applyr · review';
    mark.style.cssText = 'position:fixed;font:12px system-ui;color:#fff;background:#34335c;border:2px solid #fff;border-radius:4px;padding:2px 5px;pointer-events:none';
    root.append(mark); return { el: el!, mark };
  });
  let cleared = false;
  const expiry = setTimeout(() => clear(), 30_000);
  const clear = () => { if (cleared) return; cleared = true; clearTimeout(expiry); if (scope.__applyrMarkers?.clear === clear) delete scope.__applyrMarkers; observer.disconnect(); runtime?.onMessage.removeListener(onClear); host.remove(); window.removeEventListener('scroll', position, true); window.removeEventListener('resize', position); window.removeEventListener('popstate', clear); window.removeEventListener('hashchange', clear); window.removeEventListener('pagehide', clear); };
  const position = () => {
    if (scope.__applyrInspection !== state || state.revision !== target.revision || entries.some((x) => !x.el?.isConnected || !state.safeRead?.(x.id))) { clear(); return; }
    for (const { el, mark } of marks) { const r = el.getBoundingClientRect(); mark.style.left = `${Math.max(0, Math.min(innerWidth - 110, r.left))}px`; mark.style.top = `${Math.max(0, r.top - 25)}px`; mark.hidden = r.bottom < 0 || r.top > innerHeight; }
  };
  const observer = new MutationObserver(() => { position(); void hash().then((id) => { if (id !== target.identity) clear(); }); });
  document.documentElement.append(host); position();
  observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
  window.addEventListener('scroll', position, true); window.addEventListener('resize', position); window.addEventListener('popstate', clear); window.addEventListener('hashchange', clear); window.addEventListener('pagehide', clear);
  runtime?.onMessage.addListener(onClear);
  scope.__applyrMarkers = { clear };
  if (show) entries[0]!.el!.scrollIntoView({ block: 'center', behavior: 'instant' });
  return true;
}
