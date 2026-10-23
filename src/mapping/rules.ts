import { profileAssertion } from '../profile/assertions';
import type { ProfileDocument } from '../profile/schema';
import { ProfileSchema } from '../profile/schema';
import { InspectionSchema, type FormSnapshot, type Inspection } from '../forms/schema';
import { FieldProposalSchema, SessionCorrectionSchema, type DryRun, type PreviewBinding, type PreviewItem, type SessionCorrection, type ProposedValue } from './schema';

type Field = FormSnapshot['fields'][number];
export interface MappingInput { sessionId: string; version: string; source: 'saved' | 'replacement'; document: ProfileDocument; expiresAt: number }
interface Meaning { path: string; via: string; kind?: 'boolean' | 'number'; eligibility?: boolean; countryName?: boolean }
export const normalizeMeaning = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?:*]+$/, '').trim();
const countries: Record<string, string[]> = {
  IN: ['India'], US: ['United States', 'United States of America', 'USA'], GB: ['United Kingdom', 'UK'],
  CA: ['Canada'], AU: ['Australia'], DE: ['Germany'], FR: ['France'], SG: ['Singapore'],
};
const contact: Record<string, string> = {
  'full name': 'identity.legal_name', 'legal name': 'identity.legal_name', 'full legal name': 'identity.legal_name',
  'first name': 'identity.given_name', 'given name': 'identity.given_name', 'middle name': 'identity.middle_name',
  'last name': 'identity.family_name', 'family name': 'identity.family_name', 'surname': 'identity.family_name', 'preferred name': 'identity.preferred_name',
  email: 'contact.email', 'email address': 'contact.email', phone: 'contact.phone', 'phone number': 'contact.phone', 'telephone number': 'contact.phone',
  'address line 1': 'contact.address.line1', 'address line 2': 'contact.address.line2', city: 'contact.address.city',
  state: 'contact.address.region', province: 'contact.address.region', region: 'contact.address.region', 'state/province': 'contact.address.region',
  'postal code': 'contact.address.postal_code', 'zip code': 'contact.address.postal_code', 'country code': 'contact.address.country_code',
  country: 'contact.address.country_code', linkedin: 'links.linkedin', 'linkedin url': 'links.linkedin', github: 'links.github', 'github url': 'links.github',
  portfolio: 'links.portfolio', 'portfolio url': 'links.portfolio', website: 'links.website', 'website url': 'links.website', 'personal website': 'links.website',
};
const autocomplete: Record<string, string> = {
  name: 'identity.legal_name', 'given-name': 'identity.given_name', 'additional-name': 'identity.middle_name', 'family-name': 'identity.family_name',
  email: 'contact.email', tel: 'contact.phone', 'address-line1': 'contact.address.line1', 'address-line2': 'contact.address.line2',
  'address-level2': 'contact.address.city', 'address-level1': 'contact.address.region', 'postal-code': 'contact.address.postal_code',
  country: 'contact.address.country_code', 'country-name': 'contact.address.country_code',
};
const consent = /\b(consent|agree|certify|attest|acknowledge|privacy|terms|declaration|confirm|accept|authorize|personal data)\b/i;
const sensitive = /gender|race|ethnic|disabil|veteran|sexual|religio|citizen|visa|sponsor|authoriz|eligib|salary|compensation|criminal|birth|\bage\b|nationality/i;
const foreignContext = /emergency|reference|referee|parent|guardian|spouse|recommender|recruiter|billing|shipping|previous|education|school|university|project|employer|work history|employment/i;

// A closed list of complete English questions and country names. No inference
// from contact address, employer location, citizenship, or a generic "eligible".
function eligibilityMeaning(field: Field): Meaning | null {
  const label = normalizeMeaning(field.label);
  for (const [code, names] of Object.entries(countries)) for (const name of [code, ...names]) {
    const country = normalizeMeaning(name);
    if ([`are you authorized to work in ${country}`, `are you legally authorized to work in ${country}`].includes(label))
      return { path: `eligibility.${code}.work_authorized`, via: 'Explicit country-specific authorization question', kind: 'boolean', eligibility: true };
    if ([`do you require visa sponsorship in ${country}`, `do you require sponsorship in ${country}`].includes(label))
      return { path: `eligibility.${code}.sponsorship_required`, via: 'Explicit country-specific sponsorship question', kind: 'boolean', eligibility: true };
  }
  return null;
}

export function fieldMeaning(field: Field, document: ProfileDocument): Meaning | null {
  const label = normalizeMeaning(field.label), context = field.context.join(' ');
  if (foreignContext.test(context) || /emergency|reference|referee|parent|guardian|spouse|recruiter/i.test(label)) return null;
  if (field.category === 'declaration' || consent.test(`${field.label} ${context}`)) return null;
  const eligibility = ['label', 'aria'].includes(field.labelSource) ? eligibilityMeaning(field) : null;
  if (eligibility) return eligibility;
  if (field.category === 'sensitive' || sensitive.test(`${field.label} ${context}`)) return null;
  // Metadata is a meaning hint, never authority. Validate its complete grammar;
  // unsupported detail tokens do not fall through to a suggestive label.
  const tokens = field.autocomplete.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let autoPath: string | undefined, token: string | undefined;
  if (tokens.length && !['on', 'off'].includes(tokens[0]!)) {
    if (tokens[0]!.startsWith('section-')) tokens.shift();
    if (['home', 'mobile'].includes(tokens[0]!)) tokens.shift();
    token = tokens.shift();
    if (tokens.length || !token || !autocomplete[token]) return null;
    autoPath = autocomplete[token];
  }
  const labelPath = ['label', 'aria'].includes(field.labelSource) ? contact[label] : undefined;
  if (autoPath && labelPath && autoPath !== labelPath) return null;
  if (autoPath && label && !contact[label] && !['name', 'your name', 'contact', 'your email', 'your phone'].includes(label)) return null;
  if (autoPath && contact[label] && autoPath !== contact[label]) return null;
  if (autoPath || labelPath) return { path: (autoPath ?? labelPath)!, via: autoPath ? `Autocomplete ${token}` : 'Exact associated label', countryName: token === 'country-name' || label === 'country' };
  if (!['label', 'aria'].includes(field.labelSource)) return null;
  const preferences: Record<string, [string, Meaning['kind']?]> = {
    'start date': ['available_from'], 'available from': ['available_from'], 'earliest start date': ['available_from'],
    'notice period (days)': ['notice_days', 'number'], 'internship duration (months)': ['internship_months', 'number'],
    'willing to relocate': ['relocation', 'boolean'], 'are you willing to relocate': ['relocation', 'boolean'],
    'work arrangement': ['work_arrangements'], 'preferred work arrangement': ['work_arrangements'], 'work location': ['work_arrangements'],
    'preferred work location': ['locations'],
  };
  if (preferences[label]) { const [path, kind] = preferences[label]!; return { path: `preferences.${path}`, kind, via: 'Exact preference label with declared units' }; }
  // The explicit current marker selects a unique record; never use array order.
  if (['current employer', 'current job title'].includes(label)) {
    const current = document.data.experience?.filter((e) => e.current === true) ?? [];
    if (current.length === 1) return { path: `experience.${current[0]!.id}.${label === 'current employer' ? 'organization' : 'title'}`, via: 'Unique explicitly current experience record' };
  }
  return null;
}

function manualReason(field: Field): string | null {
  const text = `${field.label} ${field.context.join(' ')}`;
  if (field.category === 'declaration' || consent.test(text)) return 'Consent or attestation requires your action on the website.';
  if (field.category === 'sensitive' || sensitive.test(text)) return 'Sensitive or consequential question requires manual review; no eligibility or demographic inference.';
  if (field.type === 'file') return 'Attachment requires separate upload review. This preview never transfers files.';
  return null;
}

function supplied(document: ProfileDocument, meaning: Meaning, version: string, now: number) {
  if (['preferences.work_arrangements', 'preferences.locations'].includes(meaning.path)) {
    const entries = meaning.path.endsWith('work_arrangements') ? document.data.preferences?.work_arrangements : document.data.preferences?.locations;
    if (!entries?.length) return { value: undefined, status: 'unknown', reviewedOn: document.data.reviewed_on };
    if (entries.length !== 1) return { value: undefined, status: 'conflict', reviewedOn: document.data.reviewed_on };
    return profileAssertion(document, `${meaning.path}.0`, version, now);
  }
  return profileAssertion(document, meaning.path, version, now);
}

function aliases(value: string | number | boolean, meaning: Meaning): string[] {
  if (typeof value === 'boolean') return [value ? 'yes' : 'no'];
  const text = String(value);
  if (meaning.path === 'contact.address.country_code') return [text, ...(countries[text] ?? [])];
  if (meaning.path === 'preferences.work_arrangements' && text === 'onsite') return ['onsite', 'on-site', 'on site'];
  return [text];
}

function proposalValue(field: Field, value: string | number | boolean, meaning: Meaning): ProposedValue | null {
  if (field.constraints.multiple) return null;
  const allowed = meaning.kind === 'boolean' ? ['checkbox', 'select', 'radio'] : meaning.kind === 'number' ? ['number', 'text'] : meaning.path === 'contact.email' ? ['email', 'text'] : meaning.path === 'contact.phone' ? ['tel', 'text'] : meaning.path.startsWith('links.') ? ['url', 'text'] : meaning.path === 'preferences.available_from' ? ['date', 'month', 'text'] : ['text', 'textarea', 'select', 'radio'];
  if (!allowed.includes(field.type)) return null;
  if (field.type === 'checkbox') {
    if (meaning.kind !== 'boolean' || typeof value !== 'boolean' || field.options.length !== 1 || field.options[0]!.disabled) return null;
    return { kind: 'checked', checked: value, optionFingerprint: field.options[0]!.fingerprint };
  }
  if (field.type === 'select' || field.type === 'radio') {
    const accepted = aliases(value, meaning).map(normalizeMeaning);
    const matches = field.options.filter((o) => !o.disabled && accepted.includes(normalizeMeaning(o.label)));
    if (matches.length !== 1 || field.options.filter((o) => o.fingerprint === matches[0]!.fingerprint).length !== 1) return null;
    return { kind: 'choice', label: matches[0]!.label, optionFingerprint: matches[0]!.fingerprint };
  }
  if (typeof value === 'boolean' || field.type === 'file') return null;
  let text = String(value);
  if (meaning.countryName) { const name = countries[text]?.[0]; if (!name) return null; text = name; }
  if (!text.trim() || text.length > 2048) return null;
  if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  if (field.type === 'month' && !/^\d{4}-\d{2}$/.test(text)) return null;
  if (field.type === 'number' && (meaning.kind !== 'number' || typeof value !== 'number')) return null;
  if (field.type === 'number' || ['date', 'month'].includes(field.type)) {
    const order = (s: string) => field.type === 'number' ? Number(s) : s;
    if ((field.constraints.min && order(text) < order(field.constraints.min)) || (field.constraints.max && order(text) > order(field.constraints.max))) return null;
    // Arbitrary step/pattern semantics remain review, never executable regex from a page.
    if (field.constraints.step && field.constraints.step !== 'any' && field.constraints.step !== '1') return null;
  }
  if ((field.constraints.maxLength && text.length > Number(field.constraints.maxLength)) || (field.constraints.minLength && text.length < Number(field.constraints.minLength)) || field.constraints.pattern) return null;
  return { kind: 'text', text };
}

export function previewBinding(inspection: Inspection, input: MappingInput): PreviewBinding {
  const { snapshot, sessionId, tabId, frameId, browserDocumentId } = inspection;
  return { sessionId, tabId, frameId, browserDocumentId, identity: snapshot.identity, document: snapshot.document, revision: snapshot.revision, inputVersion: input.version };
}
const sameBinding = (a: PreviewBinding, b: PreviewBinding) => Object.entries(a).every(([key, value]) => b[key as keyof PreviewBinding] === value);

export function createDryRun(inspection: Inspection, input: MappingInput, corrections: readonly SessionCorrection[] = [], now = Date.now()): DryRun {
  InspectionSchema.parse(inspection);
  const binding = previewBinding(inspection, input);
  // Unknown, conflicting or structurally invalid inputs never get partial guesses.
  const validInput = ProfileSchema.safeParse(input.document.data).success;
  const meanings = inspection.snapshot.fields.map((f) => fieldMeaning(f, input.document));
  const items = inspection.snapshot.fields.map((field, index): PreviewItem => {
    const meaning = meanings[index];
    const item: PreviewItem = { fieldId: field.id, label: field.label || 'Missing label', required: field.required, state: 'review', reason: '', sourcePath: meaning?.path ?? null, eligibility: !!meaning?.eligibility, correctable: false, inputKind: meaning?.kind ?? 'text' };
    const stop = (state: PreviewItem['state'], reason: string) => ({ ...item, state, reason });
    if (inspection.snapshot.status !== 'stable' || !inspection.snapshot.selectedForm) return stop('review', 'Reinspect a stable, explicitly selected application form.');
    if (input.sessionId !== inspection.sessionId || input.expiresAt <= now) return stop('review', 'The frozen input expired or belongs to another session. Select inputs and reinspect.');
    if (field.current.present) return stop('skipped', field.validation.valid === false || field.validation.ariaInvalid || field.validation.errorPresent ? 'Existing page answer preserved; website validation needs review.' : 'Existing page answer preserved. Reinspect after user changes.');
    if (!validInput) return stop('review', 'Profile conflicts or validation errors require repair before mapping.');
    const manual = manualReason(field);
    if (manual && !meaning?.eligibility) return stop(field.type === 'file' ? 'unsupported' : 'review', manual);
    if (!meaning) return stop('review', 'Unknown or ambiguous meaning, name, record selection or metadata conflict. Enter this answer on the page.');
    if (!field.executable && !meaning.eligibility) return stop('unsupported', 'This control requires manual interaction.');
    if (field.type === 'radio') return stop('unsupported', 'Radio group identity is not available in this snapshot; choose on the page.');
    if (meanings.filter((m) => m?.path === meaning.path).length > 1) return stop('review', 'Multiple fields refer to the same fact. Duplicate or repeated-record selection requires review.');
    item.correctable = true;
    if (field.validation.ariaInvalid || field.validation.errorPresent || field.validation.flags.some((flag) => flag !== 'valueMissing')) return stop('review', 'The website reports a validation error. Resolve it on the page, then reinspect.');
    const rawCorrections = corrections.filter((c) => c.fieldId === field.id);
    if (rawCorrections.length > 1) return stop('review', 'Conflicting session corrections; review one answer.');
    const correction = rawCorrections[0];
    if (correction && (!SessionCorrectionSchema.safeParse(correction).success || !sameBinding(correction.binding, binding) || correction.currentFingerprint !== field.current.fingerprint)) return stop('review', 'Session correction is outdated. Reinspect and review the answer again.');
    const assertion = supplied(input.document, meaning, input.version, now);
    if (!correction && assertion.status === 'conflict') return stop('review', 'Multiple supplied preferences conflict with a single-choice question. Choose explicitly for this session.');
    if (!correction && assertion.status === 'unknown') return stop('missing', 'No supplied answer at this profile path. Missing and null stay unknown; they never mean No.');
    if (!correction && assertion.status === 'needs_review') return stop('review', 'Time-sensitive information has no review date or is older than 90 days. Review for this session.');
    const value = correction ? correction.value : assertion.value;
    if (!['string', 'number', 'boolean'].includes(typeof value) || (meaning.kind === 'boolean' && typeof value !== 'boolean') || (meaning.kind === 'number' && typeof value !== 'number')) return stop('review', 'The supplied value does not match the explicit question type.');
    if (correction && !validCorrection(input.document, meaning.path, value)) return stop('review', 'Correction does not satisfy the supported profile format. Review the value.');
    const proposed = proposalValue(field, value as string | number | boolean, meaning);
    if (!proposed) return stop('review', 'No unique enabled option with equivalent meaning, or incompatible type, precision or constraints. No substitute chosen.');
    const confirmed = correction?.eligibilityConfirmed === true;
    const confirmationRequired = meaning.eligibility ? !confirmed : field.type === 'checkbox' && !correction;
    item.state = confirmationRequired ? 'review' : 'proposed';
    item.reason = meaning.eligibility && !confirmed ? 'Explicit confirmation for this country and application is required.' : confirmationRequired ? 'An unchecked box may be an existing No. Review a session answer before proposing any change.' : correction ? 'Reviewed session answer; saved profile and website are unchanged.' : 'Exact deterministic match from the frozen input; preview only.';
    item.proposal = FieldProposalSchema.parse({ schemaVersion: 1, fieldId: field.id, binding,
      source: { kind: correction ? 'session' : input.source, path: meaning.path, inputVersion: input.version, reviewedOn: correction ? new Date(now).toISOString().slice(0, 10) : assertion.reviewedOn ?? null }, value: proposed,
      explanation: `${meaning.via}. ${item.reason}`,
      precondition: { currentFingerprint: field.current.fingerprint, mustBeEmpty: true, reinspectionRequired: true },
      approval: confirmationRequired ? 'session_confirmation' : correction ? 'session_approved' : 'ordinary', submission: 'manual_only',
    });
    return item;
  });
  return { binding, items, counts: { inspected: items.length, proposed: items.filter((i) => i.state === 'proposed').length, skipped: items.filter((i) => i.state === 'skipped').length, missing: items.filter((i) => i.state === 'missing').length, review: items.filter((i) => i.state === 'review').length, unsupported: items.filter((i) => i.state === 'unsupported').length, unsupportedAreas: inspection.snapshot.unsupported.length,
    requiredUnresolved: items.filter((i) => i.required && i.state !== 'proposed').length } };
}

// Reused by correction validation and the explicit saved-default diff. Only known
// scalar paths are editable. A stable record must already exist in that default.
export function updatedProfile(document: ProfileDocument, path: string, value: unknown): ProfileDocument | null {
  if (!/^(identity\.(legal_name|preferred_name|given_name|middle_name|family_name)|contact\.(email|phone|address\.(line1|line2|city|region|postal_code|country_code))|links\.(linkedin|github|portfolio|website)|preferences\.(available_from|notice_days|internship_months|relocation|work_arrangements|locations)|experience\.[a-z0-9]+(?:-[a-z0-9]+)*\.(organization|title)|eligibility\.[A-Z]{2}\.(work_authorized|sponsorship_required))$/.test(path)) return null;
  const next = structuredClone(document);
  const parts = path.split('.');
  let parent = next.data as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const record = parent.find((r: Record<string, unknown>) => r.id === part || r.country_code === part);
      if (!record) return null;
      parent = record;
    } else {
      if (parent[part] == null) parent[part] = {};
      if (typeof parent[part] !== 'object') return null;
      parent = parent[part] as Record<string, unknown>;
    }
  }
  parent[parts.at(-1)!] = ['preferences.work_arrangements', 'preferences.locations'].includes(path) ? [value] : value;
  const checked = ProfileSchema.safeParse(next.data);
  return checked.success ? { ...next, data: checked.data } : null;
}
function validCorrection(document: ProfileDocument, path: string, value: unknown) {
  // A missing eligibility record can receive a session answer, never a persistent
  // assertion inferred from another country or a partial replacement profile.
  if (path.startsWith('eligibility.')) return typeof value === 'boolean';
  return updatedProfile(document, path, value) !== null;
}

// Preview proposals are data, never commands. A future consumer must still
// independently authorize/reinspect the page; this checks enumerated membership,
// provenance, policy, exact option choice and the original value precondition.
export function validatePreviewProposal(raw: unknown, inspection: Inspection, input: MappingInput, corrections: readonly SessionCorrection[] = [], now = Date.now()): boolean {
  const parsed = FieldProposalSchema.safeParse(raw);
  if (!parsed.success) return false;
  const expected = createDryRun(inspection, input, corrections, now).items.find((i) => i.fieldId === parsed.data.fieldId)?.proposal;
  return !!expected && JSON.stringify(parsed.data) === JSON.stringify(expected);
}
