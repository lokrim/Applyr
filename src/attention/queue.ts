import type { SessionCheckpoint } from '../domain/session';
import { terminal } from '../domain/session';
import type { Inspection } from '../forms/schema';
import { recoverySignature } from '../forms/operations';
import { createDryRun, previewBinding, type MappingInput } from '../mapping/rules';
import type { SessionCorrection } from '../mapping/schema';
import type { Attention, AttentionItem } from './schema';

export const instructions = {
  draft: ['A generated proposal needs your factual and wording review.', 'Review the batch under Optional AI assistance. If the review view was closed or lost, request and review a fresh batch explicitly; it may incur a new charge.'],
  missing: ['No supplied answer is available.', 'Enter a truthful answer for this application, or complete the field on the website.'],
  ambiguous: ['The fact or field mapping is ambiguous or conflicting.', 'Choose one reviewed answer where supported, or complete it on the website.'],
  eligibility: ['This country-specific eligibility answer needs explicit confirmation.', 'Confirm the exact answer for this application or answer on the website.'],
  consent: ['Consent or attestation requires your action.', 'Read and complete this control on the original website, then reinspect.'],
  sensitive: ['This sensitive or consequential question requires manual review.', 'Answer on the original website, then reinspect.'],
  login: ['A login gate was detected (best effort).', 'Sign in on the website, then reinspect. Never enter credentials in applyr.'],
  otp: ['A one-time-code gate was detected (best effort).', 'Complete verification on the website, then reinspect. Never enter codes in applyr.'],
  captcha: ['A CAPTCHA or security challenge was detected (best effort).', 'Complete the challenge yourself on the website, then reinspect.'],
  authentication: ['An authentication, payment or unknown challenge gate needs manual handling.', 'Return to the website. Complete it yourself and reinspect; applyr does not read authentication values.'],
  unsupported: ['This area cannot be safely automated.', 'Complete it on the original page and reinspect. Unverifiable custom controls remain manual.'],
  validation: ['The website rejected or has not validated this answer.', 'Review the field and website error on the original page, correct it and reinspect.'],
  upload: ['Attachment acceptance failed or remains unverified.', 'Review the upload on the website. Replace or upload manually if needed, then reinspect. No blind upload retry.'],
  navigation: ['The target changed, closed or needs matching reattachment.', 'Open the original application and use the matching-tab recovery controls. Reinspect before continuing.'],
  permission: ['Page or frame access is unavailable.', 'Grant the displayed exact origin or invoke applyr on the form, then reinspect.'],
  recovery: ['Fresh inspection or manual review is required.', 'Use recovery controls and reinspect. Resume never replays an uncertain operation.'],
} as const;
export const pending = (item: AttentionItem) => item.status === 'open' || item.status === 'answer_ready';
function item(key: string, code: AttentionItem['code'], question: string, required = true): AttentionItem {
  return { id: crypto.randomUUID(), key, revision: 1, code, question, reason: instructions[code][0], action: instructions[code][1], required, status: 'open', sourcePath: null, inputKind: 'text', correctable: false };
}
// IDs survive repeated observations; only meaningful blocker changes advance alerts.
export function mergeQueue(previous: Attention | undefined, observations: AttentionItem[], scope: (i: AttentionItem) => boolean): Attention {
  const items = (previous?.items ?? []).filter((i) => !scope(i));
  for (const observed of observations) {
    const old = previous?.items.find((i) => i.key === observed.key);
    if (old) {
      observed.id = old.id;
      const semantic = (i: AttentionItem) => JSON.stringify([i.code, i.question, i.reason, i.action, i.required, i.status, i.target?.signature, i.correctable]);
      observed.revision = old.revision + Number(semantic(old) !== semantic(observed));
    }
    items.push(observed);
  }
  for (const old of previous?.items.filter(scope) ?? []) if (!observations.some((i) => i.key === old.key)) items.push({ ...old, status: 'stale', correction: undefined, revision: old.revision + Number(old.status !== 'stale') });
  const bounded = [...items.filter(pending), ...items.filter((i) => !pending(i))].slice(0, 200);
  const changed = JSON.stringify(bounded) !== JSON.stringify(previous?.items ?? []);
  return { version: 1, revision: (previous?.revision ?? 0) + Number(changed), items: bounded };
}
export function accessQueue(cp: SessionCheckpoint): Attention | undefined {
  if (terminal(cp)) return cp.attention ? { ...cp.attention, items: cp.attention.items.map((i) => ({ ...i, correction: undefined })) } : undefined;
  const reason = cp.access?.reason;
  const code = cp.access?.status === 'needs_attention' ? reason === 'login_challenge' ? cp.access.challenge ?? 'authentication' : ['navigation', 'closed', 'restart'].includes(reason ?? '') ? 'navigation' : ['permission', 'frame_permission', 'frame_unavailable'].includes(reason ?? '') ? 'permission' : 'unsupported' : undefined;
  const observations = code ? [item('access', code, 'Application page')] : [];
  let queue = mergeQueue(cp.attention, observations, (i) => i.key === 'access');
  if (code && code !== 'permission') queue = { ...queue, items: queue.items.map((i) => (i.context || i.target) && pending(i) ? { ...i, status: 'stale', correction: undefined } : i) };
  return queue.items.length ? queue : cp.attention;
}
export function usableCorrections(cp: SessionCheckpoint, inspection: Inspection, input: MappingInput): SessionCorrection[] {
  const binding = previewBinding(inspection, input);
  return (cp.attention?.items ?? []).flatMap((i) => {
    const c = i.correction, field = inspection.snapshot.fields.find((f) => f.id === c?.fieldId);
    return c && pending(i) && field && c.currentFingerprint === field.current.fingerprint && JSON.stringify(c.binding) === JSON.stringify(binding) ? [c] : [];
  });
}
export async function inspectionQueue(cp: SessionCheckpoint, inspection: Inspection, input: MappingInput | null): Promise<Attention> {
  const { snapshot: s } = inspection;
  const context = { tabId: inspection.tabId, frameId: inspection.frameId, browserDocumentId: inspection.browserDocumentId, identity: s.identity, document: s.document, revision: s.revision, formId: s.selectedForm, multipleForms: s.forms.length > 1 };
  const corrections = input ? usableCorrections(cp, inspection, input) : [];
  const preview = input ? createDryRun(inspection, input, corrections) : null;
  const observations: AttentionItem[] = [];
  for (const field of s.fields) {
    if (field.radioGroup && field.radioGroup.primary !== field.id) continue;
    const mapped = preview?.items.find((i) => i.fieldId === field.id);
    const op = cp.autofill?.operations.findLast((o) => o.fieldId === field.id && o.binding.document === s.document);
    const error = field.validation.ariaInvalid || field.validation.errorPresent || field.validation.flags.some((f) => f !== 'valueMissing');
    const valid = field.current.present && field.validation.valid !== false && !error;
    const correction = corrections.find((c) => c.fieldId === field.id);
    let code: AttentionItem['code'] | undefined;
    if (field.type === 'file' && (field.required || op || error)) code = 'upload';
    else if (error || (op?.result && op.result.status !== 'accepted' && !valid)) code = 'validation';
    else if (!valid && field.category === 'declaration') code = 'consent';
    else if (!valid && mapped?.eligibility) code = 'eligibility';
    else if (!valid && field.category === 'sensitive') code = 'sensitive';
    else if (!valid && mapped?.state === 'missing') code = 'missing';
    else if (!valid && mapped?.state === 'unsupported') code = 'unsupported';
    else if (!valid && (mapped?.state === 'review' || (!mapped && field.required))) code = 'ambiguous';
    else if (correction) code = cp.attention?.items.find((i) => i.correction?.fieldId === field.id)?.code;
    const old = cp.attention?.items.find((i) => i.target?.document === s.document && i.target.fieldId === field.id);
    if (!code && !old) continue;
    const entry = item(`field:${inspection.frameId}:${s.document}:${field.id}`, code ?? old!.code, field.radioGroup?.label || field.label || 'Unlabelled field', field.required);
    entry.context = context;
    entry.target = { tabId: inspection.tabId, frameId: inspection.frameId, browserDocumentId: inspection.browserDocumentId, identity: s.identity, document: s.document, revision: s.revision, formId: s.selectedForm, fieldId: field.id, signature: await recoverySignature(field) };
    entry.status = valid && field.type !== 'file' ? 'resolved' : correction ? 'answer_ready' : 'open';
    entry.correctable = !!mapped?.correctable && !valid && !['validation', 'upload', 'consent', 'sensitive'].includes(entry.code);
    entry.sourcePath = mapped?.sourcePath ?? null; entry.inputKind = mapped?.inputKind ?? 'text'; entry.correction = correction;
    if (mapped && entry.correctable) entry.reason = mapped.reason;
    observations.push(entry);
  }
  for (const [index, area] of s.unsupported.entries()) {
    const code = ['login', 'otp', 'captcha', 'authentication'].includes(area.code) ? area.code as AttentionItem['code'] : 'unsupported';
    observations.push({ ...item(`area:${inspection.frameId}:${s.document}:${area.code}:${index}`, code, code === 'unsupported' ? area.label : 'Authentication or challenge'), context });
  }
  if (s.status !== 'stable') observations.push({ ...item(`area:${inspection.frameId}:${s.document}:selection`, 'unsupported', 'Select a stable application form and reinspect'), context });
  return mergeQueue(cp.attention, observations, (i) => !!i.target && i.target.frameId === inspection.frameId || i.key.startsWith(`area:${inspection.frameId}:`));
}

// Only the review obligation is durable here. Unapproved model text stays in memory.
export function draftQueue(cp: SessionCheckpoint, batchId: string, fields: { id: string; question: string }[]): Attention {
  const observations = fields.map((f) => item(`draft:${batchId}:${f.id}`, 'draft', f.question));
  return mergeQueue(cp.attention, observations, (i) => i.key.startsWith('draft:'));
}
