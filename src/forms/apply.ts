import type { InspectionState } from './inspect';
import type { ActionResult, ContentOperation } from './operations';

// Injected only by the privileged coordinator into one authorized ISOLATED frame.
// No page message listener, selectors from callers, network or generic clicks.
export async function operateControl(command: ContentOperation): Promise<ActionResult | { ready: true } | null> {
  type Transfer = { key: string; command: Extract<ContentOperation, { type: 'begin' }>; bytes: Uint8Array; offset: number; timer: ReturnType<typeof setTimeout> };
  type Agent = { cancelled: Set<string>; transfer?: Transfer; cache: Map<string, { key: string; result: Promise<ActionResult> }> };
  const scope = globalThis as typeof globalThis & { __applyrInspection?: InspectionState; __applyrOperations?: Agent };
  const agent: Agent = scope.__applyrOperations ??= { cancelled: new Set(), cache: new Map() };
  const state = scope.__applyrInspection;
  const result = (status: ActionResult['status'], code: ActionResult['code'], selectedBytes: boolean | null = null): ActionResult => ({ operationId: command.operationId, fieldId: command.fieldId, status, code, selectedBytes, siteAcceptance: command.type === 'write' || (command.type === 'observe' && command.expected?.kind !== 'file') ? 'not_applicable' : code === 'upload_rejected' ? 'rejected' : 'unverified' });
  const clear = () => { if (agent.transfer) { clearTimeout(agent.transfer.timer); agent.transfer.bytes.fill(0); delete agent.transfer; } };
  const key = JSON.stringify([command.operationId, command.runId, command.fieldId, command.binding, command.precondition, command.type === 'write' ? [command.value, command.eligibilityApproved] : null]);
  if (command.type === 'cancel') {
    agent.cancelled.add(command.runId); if (agent.cancelled.size > 100) agent.cancelled.delete(agent.cancelled.values().next().value!);
    if (agent.transfer?.command.runId === command.runId) clear();
    return result('unverified', 'cancelled');
  }
  if (command.type === 'clear') { if (agent.transfer?.key === key) clear(); return { ready: true }; }
  const hash = async (bytes: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) => v.toString(16).padStart(2, '0')).join('');
  const opaque = (s: string) => hash(new TextEncoder().encode(`${state?.salt}:${s}`));
  const address = () => location.href.replace(/^(https?:\/\/)[^/@]+:[^/@]+@/, '$1');
  if (!state || state.identity !== command.binding.identity || state.document !== command.binding.document || await hash(new TextEncoder().encode(address())) !== command.binding.identity) { clear(); return result('unsupported', 'stale_control'); }
  if (agent.cancelled.has(command.runId)) { clear(); return result('unverified', 'cancelled'); }
  const cached = agent.cache.get(command.operationId);
  if (cached && command.type !== 'verify' && command.type !== 'observe') return cached.key === key ? cached.result : result('unsupported', 'transfer_invalid');
  if (command.type === 'chunk') {
    const t = agent.transfer;
    if (!t || t.key !== key || command.offset !== t.offset || !command.bytes.length || command.bytes.length > 65536 || command.bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255) || t.offset + command.bytes.length > t.bytes.length) { clear(); return result('unsupported', 'transfer_invalid'); }
    t.bytes.set(command.bytes, t.offset); t.offset += command.bytes.length;
    return { ready: true };
  }
  const field = state.snapshot?.fields.find((f) => f.id === command.fieldId);
  const e = state.registry.get(command.fieldId)?.deref();
  // The only custom operation is an already visible, registered inline option.
  // No selector, menu-opening click, native activation or caller-supplied target.
  if (field?.control && e?.isConnected) {
    const choices = state.choices?.get(field.id);
    const safe = () => !!choices && e.isConnected && state.safeRead?.(field.id) && choices.valid();
    const error = () => e.getAttribute('aria-invalid') === 'true' || (e.getAttribute('aria-errormessage') ?? '').split(/\s+/).slice(0, 5).some((id) => { const n = (e.getRootNode() as Document | ShadowRoot).getElementById(id); return !!n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden' && !!n.textContent?.trim(); });
    if (!choices || !safe()) return result('unsupported', 'stale_control');
    const expected = command.type === 'write' ? command.value : command.type === 'observe' ? command.expected : null;
    if (!expected || expected.kind !== 'choice') return result('unsupported', 'manual_control');
    const option = field.options.find((o) => o.fingerprint === expected.optionFingerprint && !o.disabled && o.label === expected.label);
    if (!option) return result('unsupported', 'manual_control');
    if (command.type === 'observe') {
      if (state.revision !== command.binding.revision || !state.guard?.()) return result('unverified', 'stale_control');
      const equal = await opaque(choices.read()) === expected.optionFingerprint;
      return !safe() || !state.guard?.() ? result('unverified', 'stale_control') : equal ? error() ? result('rejected', 'site_error') : result('accepted', 'persisted_valid') : result('skipped_user_change', 'user_change');
    }
    if (command.type !== 'write' || !field.executable || field.category !== 'choice' || field.current.present || state.busy || state.revision !== command.binding.revision || !state.guard?.()) return result('unsupported', 'manual_control');
    const before = choices.read();
    if (await opaque(before) !== command.precondition || !state.guard?.() || !safe() || choices.read() !== before) return result('skipped_user_change', 'user_change');
    if (agent.cache.size >= 100) return result('unsupported', 'manual_control');
    const pending = Promise.resolve().then(async () => {
      if (agent.cancelled.has(command.runId)) return result('unverified', 'cancelled');
      if (!state.guard?.() || !safe() || choices.read() !== before) return result('skipped_user_change', 'user_change');
      let userEdit = false;
      const edited = (event: Event) => { if (event.isTrusted) userEdit = true; };
      e.addEventListener('click', edited, true); e.addEventListener('keydown', edited, true);
      try {
        if (!choices.choose(expected.optionFingerprint)) return result('unsupported', 'manual_control');
        for (let pass = 0; pass < 4; pass++) {
          await new Promise((r) => setTimeout(r, 160));
          if (userEdit) return result('skipped_user_change', 'user_change');
          if (!safe() || await hash(new TextEncoder().encode(address())) !== command.binding.identity) return result('unverified', 'stale_control');
        }
        const after = choices.read(), fingerprint = await opaque(after);
        if (userEdit || choices.read() !== after) return result('skipped_user_change', 'user_change');
        if (fingerprint !== expected.optionFingerprint) return result('rejected', 'value_rejected');
        return safe() ? error() ? result('rejected', 'site_error') : result('accepted', 'persisted_valid') : result('unverified', 'stale_control');
      } catch { return result('unverified', 'unknown_effect'); }
      finally { e.removeEventListener('click', edited, true); e.removeEventListener('keydown', edited, true); }
    });
    agent.cache.set(command.operationId, { key, result: pending });
    return pending;
  }
  if (!field || !e || !e.isConnected || !(e instanceof HTMLInputElement || e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement)) { clear(); return result('unsupported', 'stale_control'); }
  const visibleError = () => {
    const root = e.getRootNode() as Document | ShadowRoot;
    const visible = (n: Element) => n.getClientRects().length > 0 && getComputedStyle(n).display !== 'none' && getComputedStyle(n).visibility !== 'hidden' && !n.closest('[hidden],[aria-hidden="true"]');
    const refs = (e.getAttribute('aria-errormessage') ?? '').split(/\s+/).slice(0, 5).map((id) => root.getElementById(id)).filter((n): n is HTMLElement => !!n);
    const statuses = Array.from((e.form ?? root).querySelectorAll('[role="alert"],[role="status"],[aria-live]')).slice(0, 30);
    return e.getAttribute('aria-invalid') === 'true' || refs.some((n) => visible(n) && !!n.textContent?.trim()) || statuses.some((n) => visible(n) && /reject|fail|invalid|error|too large|not allowed|unsupported|duplicate blocked/i.test(n.textContent?.slice(0, 600) ?? ''));
  };
  const peers = () => e instanceof HTMLInputElement && e.type === 'radio' ? Array.from(state.registry.values()).map((r) => r.deref()).filter((p): p is HTMLInputElement => p instanceof HTMLInputElement && p.type === 'radio' && p.name === e.name && p.form === e.form && p.getRootNode() === e.getRootNode()) : [];
  const rawValue = () => e instanceof HTMLInputElement && e.type === 'file' ? Array.from(e.files ?? []).map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|') : e instanceof HTMLInputElement && e.type === 'radio' ? JSON.stringify(peers().map((p) => [state.ids.get(p), p.checked])) : e instanceof HTMLInputElement && e.type === 'checkbox' ? String(e.checked) : e.value;
  if (command.type === 'observe') {
    // Durable recovery is observation only, independent of the operation cache.
    if (state.revision !== command.binding.revision || !state.guard?.() || !state.safeRead?.(command.fieldId)) return result('unverified', 'stale_control');
    const expected = command.expected;
    if (!expected) return result('unverified', 'unknown_effect');
    if (expected.kind === 'file') {
      if (!(e instanceof HTMLInputElement) || e.type !== 'file') return result('unverified', 'stale_control');
      const files = e.files;
      const equal = files?.length === 1 && files[0]!.size === expected.size && files[0]!.name === expected.name && await hash(await files[0]!.arrayBuffer()) === expected.digest;
      if (!e.isConnected || !state.guard?.()) return result('unverified', 'stale_control');
      return visibleError() ? result('rejected', 'upload_rejected', !!equal) : result('unverified', equal ? 'selected_only' : 'unknown_effect', !!equal);
    }
    let equal = false;
    if (expected.kind === 'text') equal = e.value === expected.text;
    else if (expected.kind === 'checked' && e instanceof HTMLInputElement && e.type === 'checkbox') equal = e.checked === expected.checked && await opaque(e.value) === expected.optionFingerprint;
    else if (expected.kind === 'choice') {
      const selected = e instanceof HTMLSelectElement ? e.selectedOptions[0] : peers().find((p) => p.checked);
      equal = !!selected && await opaque(selected.value) === expected.optionFingerprint;
    }
    if (!e.isConnected || !state.guard?.()) return result('unverified', 'stale_control');
    if (!equal) return field.current.present ? result('skipped_user_change', 'user_change') : result('unverified', 'unknown_effect');
    return e.validity.valid && !visibleError() ? result('accepted', 'persisted_valid') : result('rejected', 'site_error');
  }
  if (command.type === 'verify') {
    // Observation only: never reassign an uncertain file or replay an event.
    if (cached?.key !== key) return result('unverified', 'unknown_effect');
    const prior = await cached.result;
    return visibleError() ? result('rejected', 'upload_rejected', prior.selectedBytes) : prior;
  }
  if (state.busy || state.revision !== command.binding.revision || !state.guard?.()) { clear(); return result('skipped_user_change', 'user_change'); }
  const before = rawValue();
  if (await opaque(before) !== command.precondition || !state.guard?.() || rawValue() !== before) { clear(); return result('skipped_user_change', 'user_change'); }
  if (e.matches(':disabled,[readonly]') || field.category === 'declaration' || field.category === 'missing_semantics' || (field.category === 'sensitive' && !(command.type === 'write' && command.eligibilityApproved)) || (!field.executable && field.category !== 'sensitive')) { clear(); return result('unsupported', 'manual_control'); }
  if (command.type === 'begin') {
    if (!(e instanceof HTMLInputElement) || e.type !== 'file' || field.filePurpose !== 'resume' || field.current.present || e.multiple || !command.file.name.toLowerCase().endsWith('.pdf') || !['', 'application/pdf'].includes(command.file.mime) || command.file.size <= 0 || command.file.size > 10 * 1024 * 1024) return result('unsupported', 'manual_control');
    const accepts = e.accept.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (accepts.length && !accepts.some((s) => ['.pdf', 'application/pdf', 'application/*', '*/*'].includes(s))) return result('rejected', 'upload_rejected', false);
    if (agent.transfer) return agent.transfer.key === key && JSON.stringify(agent.transfer.command.file) === JSON.stringify(command.file) ? { ready: true } : result('unsupported', 'transfer_invalid');
    agent.transfer = { key, command, bytes: new Uint8Array(command.file.size), offset: 0, timer: setTimeout(clear, 30_000) };
    return { ready: true };
  }
  if (agent.cache.size >= 100) { clear(); return result('unsupported', 'manual_control'); }
  // Install the in-flight promise before the first asynchronous external effect.
  const pending = Promise.resolve().then(async (): Promise<ActionResult> => {
    let target = e;
    let fileDigest: string | null = null;
    let expected: string | boolean;
    let file: File | null = null;
    if (command.type === 'commit') {
      const t = agent.transfer;
      if (!t || t.key !== key || t.offset !== t.bytes.length) { clear(); return result('unsupported', 'transfer_invalid'); }
      fileDigest = t.command.file.digest;
      if (await hash(t.bytes.buffer as ArrayBuffer) !== fileDigest) { clear(); return result('unsupported', 'transfer_invalid'); }
      file = new File([t.bytes.buffer as ArrayBuffer], t.command.file.name, { type: t.command.file.mime, lastModified: t.command.file.lastModified });
      clear(); expected = '';
    } else if (command.type === 'write') {
      const value = command.value;
      if (field.type === 'file' || field.current.present) return result('skipped_user_change', 'user_change');
      if (value.kind === 'text') {
        if (!['text', 'email', 'tel', 'url', 'number', 'date', 'month', 'textarea'].includes(field.type)) return result('unsupported', 'manual_control');
        expected = value.text;
      } else {
        if (value.kind === 'checked' && !(e instanceof HTMLInputElement && e.type === 'checkbox')) return result('unsupported', 'manual_control');
        if (value.kind === 'choice' && !(e instanceof HTMLSelectElement || (e instanceof HTMLInputElement && e.type === 'radio'))) return result('unsupported', 'manual_control');
        const choices = e instanceof HTMLSelectElement ? Array.from(e.options) : e instanceof HTMLInputElement && e.type === 'radio' ? peers() : [e as HTMLInputElement];
        const matches = [];
        for (const option of choices) if (!option.disabled && !(option instanceof HTMLOptionElement && option.closest('optgroup[disabled]')) && await opaque(option.value) === value.optionFingerprint) matches.push(option);
        if (matches.length !== 1 || (e instanceof HTMLSelectElement && e.multiple)) return result('unsupported', 'manual_control');
        if (e instanceof HTMLInputElement && e.type === 'radio') target = matches[0] as HTMLInputElement;
        expected = value.kind === 'checked' ? value.checked : e instanceof HTMLSelectElement ? matches[0]!.value : true;
      }
    } else return result('unsupported', 'transfer_invalid');
    // All awaits precede this final synchronous guard and native setter.
    if (agent.cancelled.has(command.runId)) return result('unverified', 'cancelled');
    if (!e.isConnected || !target.isConnected || state.revision !== command.binding.revision || !state.guard?.() || rawValue() !== before || target.matches(':disabled,[readonly]')) return result('skipped_user_change', 'user_change');
    let userEdit = false;
    const edited = (event: Event) => { if (event.isTrusted) userEdit = true; };
    target.addEventListener('input', edited); target.addEventListener('change', edited);
    try {
      if (file) {
        const dt = new DataTransfer(); dt.items.add(file);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')!.set!.call(target, dt.files);
      } else {
        const proto = target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, typeof expected === 'boolean' ? 'checked' : 'value')!.set!.call(target, expected);
        // React's checkbox/radio change plugin listens to click. Event has no
        // activation default, unlike MouseEvent/click(), so cannot submit/toggle.
        if (typeof expected === 'boolean') target.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
      }
      target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      target.dispatchEvent(new FocusEvent('blur', { bubbles: false, composed: true }));
      target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
      for (let pass = 0; pass < (file ? 8 : 4); pass++) {
        await new Promise((r) => setTimeout(r, 160));
        if (userEdit) return result('skipped_user_change', 'user_change', file ? false : null);
        if (!state.safeRead?.(state.ids.get(target) ?? '')) return result('unverified', 'stale_control');
        if (!target.isConnected || location.href.replace(/^(https?:\/\/)[^/@]+:[^/@]+@/, '$1') !== addressAtWrite) return result('unverified', 'stale_control', file ? false : null);
      }
      if (file) {
        const selected = (target as HTMLInputElement).files;
        const equal = selected?.length === 1 && selected[0]!.name === file.name && selected[0]!.type === file.type && selected[0]!.size === file.size && selected[0]!.lastModified === file.lastModified && await hash(await selected[0]!.arrayBuffer()) === fileDigest;
        return visibleError() ? result('rejected', 'upload_rejected', !!equal) : result('unverified', equal ? 'selected_only' : 'value_rejected', !!equal);
      }
      const actual = target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type) ? target.checked : target.value;
      if (actual !== expected) return result('rejected', 'value_rejected');
      const lengthInvalid = typeof expected === 'string' && ((target.getAttribute('minlength') && expected.length < Number(target.getAttribute('minlength'))) || (target.getAttribute('maxlength') && expected.length > Number(target.getAttribute('maxlength'))));
      if (!target.validity.valid || lengthInvalid || visibleError()) return result('rejected', 'site_error');
      return result('accepted', 'persisted_valid');
    } catch { return result('unverified', 'unknown_effect', file ? false : null); }
    finally { target.removeEventListener('input', edited); target.removeEventListener('change', edited); }
  });
  const addressAtWrite = address();
  agent.cache.set(command.operationId, { key, result: pending });
  return pending;
}
