import { ProfileSchema } from '../profile/schema';
import { profileAssertions } from '../profile/assertions';
import { createDryRun, previewBinding, type MappingInput } from '../mapping/rules';
import type { Inspection, FormSnapshot } from '../forms/schema';
import { ProviderFailure } from '../providers/contracts';
import { ContextSchema, type TaskContext, type TaskSelection } from './contracts';

type Field = FormSnapshot['fields'][number];
// Conservative secondary policy: page classification is a hint, never authority.
const excluded = /password|passcode|\botp\b|cookie|token|api.?key|secret|gender|race|ethnic|disabil|veteran|sexual|religio|citizen|visa|sponsor|authoriz|eligib|salary|compensation|criminal|birth|\bage\b|nationality|consent|agree|certify|attest|acknowledge|privacy|terms|declaration|confirm|accept|personal data|health/i;
export function safeAiField(f: Field) {
  if (/email|phone|address|\bcontact\b/i.test(f.label) || (/\bname\b/i.test(f.label) && !/project|employer|company|organization|school|college|university/i.test(f.label))) return false;
  return f.executable && !f.current.present && ['label', 'aria'].includes(f.labelSource) && !!f.label &&
    !['declaration', 'sensitive', 'file', 'missing_semantics'].includes(f.category) && !excluded.test([f.label, ...f.context, ...f.options.map((o) => o.label)].join(' ')) &&
    ['text', 'textarea', 'select'].includes(f.type) && !f.constraints.multiple && !f.constraints.pattern && !f.constraints.min && !f.constraints.max && !f.constraints.step &&
    !f.validation.ariaInvalid && !f.validation.errorPresent && f.validation.flags.every((v) => v === 'valueMissing') && f.options.length <= 30;
}
// Only selected scalar career evidence is eligible for transmission. Notes, contact,
// eligibility, preference, answer-bank metadata and whole records never enter this index.
export function evidenceIndex(input: MappingInput) {
  return profileAssertions(input.document, input.version).filter((a) => a.status === 'asserted' && typeof a.value === 'string' && a.value.trim() && a.value.length <= 600 &&
    /^(experience\.[\w-]+\.(organization|title|responsibilities\.\d+)|projects\.[\w-]+\.(name|description|technologies\.\d+|achievements\.\d+)|education\.[\w-]+\.(institution|degree|field|coursework\.\d+)|skills\.\d+\.name)$/.test(a.sourcePath) && !excluded.test(String(a.value)))
    .map((a) => ({ ref: a.sourcePath, text: String(a.value) }));
}
const words = (s: string): string[] => s.toLowerCase().match(/[a-z]{3,}/g) ?? [];
export function mappingEvidence(input: MappingInput, field: Field) {
  const tokens = words(`${field.label} ${field.context.join(' ')} ${field.options.map((o) => o.label).join(' ')}`);
  const aliases: string[] = /employer|company|organization/i.test(field.label) ? ['organization'] : /title|position/i.test(field.label) ? ['title'] : /school|university|college/i.test(field.label) ? ['institution'] : /degree/i.test(field.label) ? ['degree'] : /skill|technolog/i.test(field.label) ? ['skills', 'technologies'] : [];
  if (/current.*(employer|company|organization|title|position)/i.test(field.label) && (input.document.data.experience?.filter((e) => e.current).length ?? 0) !== 1) return [];
  return evidenceIndex(input).filter((e) => aliases.some((a) => e.ref.includes(a)) || words(`${e.ref} ${e.text}`).some((w) => tokens.includes(w))).slice(0, 6);
}
export function selectContext(inspection: Inspection, input: MappingInput, selections: TaskSelection[], roleExcerpt: string): TaskContext {
  const preview = createDryRun(inspection, input);
  if (!ProfileSchema.safeParse(input.document.data).success || input.sessionId !== inspection.sessionId || input.expiresAt <= Date.now() || inspection.snapshot.status !== 'stable' || new Set(selections.map((s) => s.fieldId)).size !== selections.length || excluded.test(roleExcerpt) || /https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(roleExcerpt)) throw new ProviderFailure('invalid_request');
  const evidence = evidenceIndex(input);
  return ContextSchema.parse({ scope: crypto.randomUUID(), revision: previewBinding(inspection, input).revision, fields: selections.map((s) => {
    const f = inspection.snapshot.fields.find((f) => f.id === s.fieldId);
    if (!f || !safeAiField(f) || !preview.items.some((i) => i.fieldId === f.id && i.state === 'review' && i.sourcePath === null) || (s.kind === 'prose' && f.type !== 'textarea') || (s.kind === 'mapping' && s.evidenceRefs.length)) throw new ProviderFailure('invalid_request');
    const selected = s.kind === 'mapping' ? mappingEvidence(input, f) : s.evidenceRefs.map((ref) => {
      const e = evidence.find((e) => e.ref === ref); if (!e) throw new ProviderFailure('invalid_request'); return e;
    });
    const pageLimit = f.constraints.maxLength ? Number(f.constraints.maxLength) : 2048;
    if (!Number.isInteger(pageLimit) || pageLimit <= 0) throw new ProviderFailure('invalid_request');
    const wordLimit = f.label.match(/(?:max(?:imum)?|up to|limit(?:ed to)?)\s*[:(]?\s*(\d+)\s*words/i)?.[1];
    const maxWords = wordLimit ? Math.min(Number(wordLimit), s.maxWords ?? 500, 500) : s.maxWords;
    return { id: f.id, kind: s.kind, question: f.label, type: f.type, maxChars: Math.min(pageLimit, 2048), maxWords,
      options: f.options.filter((o) => !o.disabled).map((o) => ({ id: o.fingerprint, label: o.label })), evidence: selected, roleExcerpt: s.kind === 'prose' ? roleExcerpt : '' };
  }) });
}
