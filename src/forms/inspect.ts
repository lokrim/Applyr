import type { FormSelection, FormSnapshot } from './schema';

// Serialized into the authorized ISOLATED world; all runtime helpers stay inside.
// No page bridge, writes, credential reads, provider access or persistent observer.
export async function inspectForm(expectedIdentity: string, frameUrl: string | null = null, selection: FormSelection | null = null): Promise<FormSnapshot | null> {
  if (frameUrl && (window === window.top || location.origin !== new URL(frameUrl).origin || location.pathname !== new URL(frameUrl).pathname)) return null;
  const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (v) => v.toString(16).padStart(2, '0')).join('');
  const address = () => location.href.replace(/^(https?:\/\/)[^/@]+:[^/@]+@/, '$1');
  if (await hash(address()) !== expectedIdentity) return null;
  type State = { identity: string; document: string; salt: string; revision: number; signature: string; candidates: string; ids: WeakMap<Element, string>; registry: Map<string, WeakRef<Element>>; forms: Set<string>; busy: boolean };
  const scope = globalThis as typeof globalThis & { __applyrInspection?: State };
  if (!scope.__applyrInspection || scope.__applyrInspection.identity !== expectedIdentity) scope.__applyrInspection = { identity: expectedIdentity, document: crypto.randomUUID(), salt: crypto.randomUUID(), revision: 0, signature: '', candidates: '', ids: new WeakMap(), registry: new Map(), forms: new Set(), busy: false };
  const state = scope.__applyrInspection;
  if (state.busy) return null;
  state.busy = true;
  // Drop strong references immediately; only this inspection can rebuild them.
  state.registry.clear();
  const clean = (value: string | null | undefined) => (value ?? '')
    // eslint-disable-next-line no-control-regex -- Remove page-controlled direction/control characters.
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 240);
  const opaque = (value: string) => hash(`${state.salt}:${value}`);
  const identify = (element: Element) => { let id = state.ids.get(element); if (!id) { id = crypto.randomUUID(); state.ids.set(element, id); } return id; };
  const parent = (element: Element): Element | null => element.parentElement ?? (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
  const visible = (element: Element): boolean => {
    for (let current: Element | null = element; current; current = parent(current)) {
      const style = getComputedStyle(current);
      if (current.matches('[hidden],[inert],[aria-hidden="true"]') || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return element.getClientRects().length > 0;
  };
  const nodeText = (element: Element | null) => {
    if (!element) return '';
    // Read text nodes only: never attributes/values or the text of form controls,
    // scripts, hidden nodes or editable regions embedded in a label.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let result = '', count = 0;
    while (walker.nextNode() && count++ < 100 && result.length < 240) {
      const owner = walker.currentNode.parentElement;
      if (owner && !owner.closest('input,textarea,select,script,style,[contenteditable]') && visible(owner)) result += ` ${walker.currentNode.textContent ?? ''}`;
    }
    return clean(result.replace(/\s+/g, ' '));
  };
  const refs = (element: Element, attr: string) => clean((element.getAttribute(attr) ?? '').split(/\s+/).slice(0, 5).map((id) => nodeText((element.getRootNode() as Document | ShadowRoot).getElementById(id))).join(' '));
  const name = (element: Element): { label: string; labelSource: FormSnapshot['fields'][number]['labelSource'] } => {
    const aria = refs(element, 'aria-labelledby') || clean(element.getAttribute('aria-label'));
    if (aria) return { label: aria, labelSource: 'aria' };
    const labels = 'labels' in element ? Array.from((element as HTMLInputElement).labels ?? []).slice(0, 4).map(nodeText).join(' ') : '';
    if (labels) return { label: clean(labels), labelSource: 'label' };
    const placeholder = clean(element.getAttribute('placeholder'));
    return { label: placeholder, labelSource: placeholder ? 'placeholder' : 'missing' };
  };
  const job = /\b(apply|application|candidate|job|position|career|resume|résumé)\b/i;
  const excluded = /newsletter|subscribe|search|payment|checkout|sign.?in|log.?in/i;
  const auth = /password|passwd|passcode|one.?time|\botp\b|\busername\b|verification.?code|security.?code|auth.?token|session.?token|credit.?card|card.?number|\bcc-[\w-]+\b|\bcvc\b|\bcvv\b|\bpin\b/i;
  let mutations = 0, scans = 0;
  const observers: MutationObserver[] = [];
  const observed = new Set<Node>();
  const observe = (root: Node) => {
    if (observed.has(root)) return;
    observed.add(root);
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true }); observers.push(observer);
  };
  const started = performance.now();
  let limited = false;
  let currentControls: Element[] = [];
  const scan = async (): Promise<Omit<FormSnapshot, 'revision' | 'observation'>> => {
    scans++;
    const elements: Element[] = []; let roots = 0;
    const walk = (root: Document | ShadowRoot, depth: number) => {
      observe(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        if (elements.length >= 3000) { limited = true; break; }
        const element = walker.currentNode as Element; elements.push(element);
        if (element.shadowRoot && visible(element)) {
          if (depth < 3 && roots++ < 12) walk(element.shadowRoot, depth + 1); else limited = true;
        }
      }
    };
    walk(document, 0);
    const metadata = (e: Element) => `${e.getAttribute('aria-label') ?? ''} ${refs(e, 'aria-labelledby')} ${e.id} ${e.getAttribute('name') ?? ''}`;
    const context = `${document.title} ${elements.filter((e) => e.matches('h1,h2') && visible(e)).slice(0, 8).map(nodeText).join(' ')}`;
    const controls = elements.filter((e) => e.matches('input,select,textarea,[role="combobox"],[role="listbox"],[role="checkbox"],[role="radio"],[role="textbox"],[contenteditable="true"],canvas') && visible(e));
    const owner = (e: Element): Element | null => {
      if ('form' in e && (e as HTMLInputElement).form) return (e as HTMLInputElement).form;
      for (let p = parent(e); p; p = parent(p)) if (p.matches('form,[role="form"]')) return p;
      return null;
    };
    const plausible = elements.filter((e) => e.matches('form,[role="form"]') && visible(e) && !excluded.test(metadata(e)) &&
      (job.test(metadata(e)) || (job.test(context) && controls.some((c) => owner(c) === e && /name|email|phone|resume|candidate/i.test(metadata(c))))));
    if (plausible.length > 20) limited = true;
    const forms = plausible.slice(0, 20).map((e) => ({ id: identify(e), label: name(e).label || 'Application form', fieldCount: Math.min(100, controls.filter((c) => owner(c) === e && !c.matches('input[type="hidden"],input[type="password"],button,input[type="submit"],input[type="reset"],input[type="button"],input[type="image"]') && !auth.test(`${metadata(c)} ${name(c).label} ${c.getAttribute('autocomplete') ?? ''}`)).length) }));
    const stale = !!selection && (selection.document !== state.document || selection.revision !== state.revision || !state.forms.has(selection.formId) || !forms.some((f) => f.id === selection.formId) || state.candidates !== JSON.stringify(forms));
    const selected = stale ? null : selection ? plausible.find((e) => identify(e) === selection.formId) ?? null : plausible.length === 1 ? plausible[0]! : null;
    const fields: FormSnapshot['fields'] = [], unsupported: FormSnapshot['unsupported'] = [];
    const add = (code: FormSnapshot['unsupported'][number]['code'], label: string) => { if (unsupported.length < 99) unsupported.push({ code, label: clean(label) }); else limited = true; };
    if (!forms.length) add('no_relevant_form', 'No relevant application form found.');
    for (const frame of elements.filter((e) => e.matches('iframe') && visible(e) && job.test(`${e.getAttribute('title')} ${e.getAttribute('src')}`)).slice(0, 4)) add('frame_requires_inspection', clean(frame.getAttribute('title')) || 'Application frame requires separate authorization and inspection.');
    const gated = selected && controls.some((c) => owner(c) === selected && (c.matches('input[type="password"]') || auth.test(`${metadata(c)} ${name(c).label} ${c.getAttribute('autocomplete') ?? ''}`)));
    if (gated) add('authentication', 'Complete authentication or payment gates manually, then reinspect. No control values read from this form.');
    if (selected && !gated) {
      for (const e of elements) {
        if (owner(e) !== selected) continue;
        if (e.matches('input[type="file"]') && !visible(e) && Array.from((e as HTMLInputElement).labels ?? []).some(visible)) add('custom_control', name(e).label || 'Hidden file picker requires manual upload.');
        if (!visible(e)) continue;
        if (e.localName.includes('-') && !e.shadowRoot) add('opaque_custom_element', name(e).label || 'Opaque custom element; a closed root cannot be inspected.');
        if (e.matches('[role="button"]') && /upload|resume|attach|dropzone|file/i.test(metadata(e))) add('custom_control', name(e).label || 'Custom file widget requires manual upload.');
      }
      for (const e of controls.filter((c) => owner(c) === selected)) {
        const named = name(e);
        const context: string[] = [];
        for (let p = parent(e); p && p !== selected; p = parent(p)) if (p.matches('fieldset') && context.length < 5) { const legend = Array.from(p.children).find((c) => c.matches('legend')); const text = nodeText(legend ?? null); if (text) context.unshift(text); }
        const type = e instanceof HTMLInputElement ? e.type : e.localName;
        const semantics = `${metadata(e)} ${named.label} ${context.join(' ')} ${e.getAttribute('autocomplete') ?? ''}`;
        if (e.matches('input[type="hidden"]') || ['submit', 'reset', 'button', 'image'].includes(type)) continue;
        if (type === 'password' || auth.test(semantics)) { add('authentication', 'Authentication or payment control excluded; no value read.'); continue; }
        if (e.matches('[contenteditable="true"]')) { add('rich_text', named.label || 'Rich text requires manual entry.'); continue; }
        if (e.matches('canvas')) { add('canvas', named.label || 'Canvas control is inaccessible.'); continue; }
        if (!e.matches('input,select,textarea')) { add('custom_control', named.label || 'Custom control requires manual entry.'); continue; }
        if (e.matches(':disabled,[readonly]')) { add('locked_control', named.label || 'Locked control'); continue; }
        if (!['text', 'email', 'tel', 'url', 'date', 'month', 'number', 'select', 'textarea', 'radio', 'checkbox', 'file'].includes(type)) { add('custom_control', named.label || 'Unsupported native control'); continue; }
        if (fields.length >= 100) { limited = true; break; }
        const control = e as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        let category: FormSnapshot['fields'][number]['category'] = type === 'file' ? 'file' : /consent|agree|certif|attest|acknowledge|privacy|terms|declar|i confirm|i accept|authorize|personal data/i.test(semantics) ? 'declaration'
          : /gender|race|ethnic|disabil|veteran|sexual|religio|citizen|visa|sponsor|work authoriz|eligib|salary|compensation|criminal|birth/i.test(semantics) ? 'sensitive'
            : ['select', 'radio'].includes(type) ? 'choice' : type === 'checkbox' ? 'preference' : type === 'textarea' ? 'long_answer' : 'short_answer';
        if (!named.label || named.labelSource === 'placeholder') category = 'missing_semantics';
        const filePurpose = type !== 'file' ? null : /resume|résumé|\bcv\b/i.test(semantics) ? 'resume' : /cover/i.test(semantics) ? 'cover_letter' : /portfolio/i.test(semantics) ? 'portfolio' : /transcript/i.test(semantics) ? 'transcript' : 'unknown';
        const value = type === 'file' ? Array.from((control as HTMLInputElement).files ?? []).map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|') : ['checkbox', 'radio'].includes(type) ? String((control as HTMLInputElement).checked) : control instanceof HTMLSelectElement && control.multiple ? Array.from(control.selectedOptions).map((o) => o.value).join('\u0000') : control.value;
        const flags = (['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'] as const).filter((key) => control.validity[key]);
        const optionElements = control instanceof HTMLSelectElement ? Array.from(control.options) : [];
        if (optionElements.length > 100) limited = true;
        const options = await Promise.all(optionElements.slice(0, 100).map(async (o) => ({ label: clean(o.label), fingerprint: await opaque(o.value), disabled: o.disabled || !!o.closest('optgroup[disabled]') })));
        if (['radio', 'checkbox'].includes(type)) options.push({ label: named.label, fingerprint: await opaque((control as HTMLInputElement).value), disabled: false });
        fields.push({ id: identify(e), ...named, context, type: type as FormSnapshot['fields'][number]['type'], autocomplete: clean(e.getAttribute('autocomplete')), required: control.required || e.getAttribute('aria-required') === 'true', category, filePurpose,
          executable: !['declaration', 'sensitive', 'missing_semantics'].includes(category) && (type !== 'file' || filePurpose === 'resume'),
          constraints: { min: clean(e.getAttribute('min')), max: clean(e.getAttribute('max')), step: clean(e.getAttribute('step')), minLength: clean(e.getAttribute('minlength')), maxLength: clean(e.getAttribute('maxlength')), pattern: clean(e.getAttribute('pattern')), accept: clean(e.getAttribute('accept')), multiple: e.hasAttribute('multiple') }, options,
          current: { fingerprint: await opaque(value), present: ['checkbox', 'radio'].includes(type) ? (control as HTMLInputElement).checked : value.length > 0 },
          // Do not call checkValidity/reportValidity (they dispatch events), or read
          // validationMessage/error text: those can echo credentials or answers.
          validation: { valid: control.willValidate ? control.validity.valid : null, flags, ariaInvalid: e.getAttribute('aria-invalid') === 'true', errorPresent: !!refs(e, 'aria-errormessage') },
        });
      }
    }
    currentControls = controls;
    if (limited) add('limit', 'Inspection bound reached; complete unsupported areas manually.');
    return { schemaVersion: 1, identity: expectedIdentity, document: state.document, status: stale ? 'stale_selection' : !selected && forms.length > 1 ? 'selection_required' : 'stable', selectedForm: selected ? identify(selected) : null, forms, fields, unsupported };
  };
  try {
    let result = await scan(), signature = JSON.stringify(result), stable = false;
    for (let pass = 0; pass < 3 && performance.now() - started < 1200 && mutations < 100; pass++) {
      const before = mutations;
      await new Promise((resolve) => setTimeout(resolve, 160));
      const next = await scan(), nextSignature = JSON.stringify(next);
      stable = before === mutations && signature === nextSignature;
      result = next; signature = nextSignature;
      // Require at least two observation intervals to catch short async inserts.
      if (stable && pass >= 1) break;
    }
    const settledMutations = mutations;
    if (await hash(address()) !== expectedIdentity) { state.registry.clear(); return null; }
    if (mutations !== settledMutations) stable = false;
    if (!stable || limited) result.status = 'unstable';
    const finalSignature = JSON.stringify(result);
    if (state.signature !== finalSignature) { state.revision++; state.signature = finalSignature; }
    state.forms = new Set(result.forms.map((f) => f.id));
    state.candidates = JSON.stringify(result.forms);
    if (result.status === 'stable') for (const e of currentControls) {
      const id = state.ids.get(e);
      if (id && result.fields.some((f) => f.id === id) && e.isConnected) state.registry.set(id, new WeakRef(e));
    }
    return { ...result, revision: state.revision, observation: { mutations, scans, bounded: true } };
  } finally { for (const observer of observers) observer.disconnect(); state.busy = false; }
}
