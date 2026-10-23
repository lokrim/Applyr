import { describe, expect, it } from 'vitest';
import type { FormSnapshot, Inspection } from '../../src/forms/schema';
import type { ProfileDocument } from '../../src/profile/schema';
import { createDryRun, previewBinding, updatedProfile, validatePreviewProposal, type MappingInput } from '../../src/mapping/rules';
import { FieldProposalSchema, type SessionCorrection } from '../../src/mapping/schema';

const now = Date.parse('2026-10-23T12:00:00Z');
const uuid = () => crypto.randomUUID();
const hash = 'a'.repeat(64);
function field(patch: Partial<FormSnapshot['fields'][number]> = {}): FormSnapshot['fields'][number] {
  return { id: uuid(), label: 'Email', labelSource: 'label', context: ['Personal information'], type: 'text', autocomplete: '', required: true, executable: true, category: 'short_answer', filePurpose: null,
    constraints: { min: '', max: '', step: '', minLength: '', maxLength: '', pattern: '', accept: '', multiple: false }, options: [], current: { fingerprint: hash, present: false },
    validation: { valid: false, flags: ['valueMissing'], ariaInvalid: false, errorPresent: false }, ...patch };
}
const option = (label: string, disabled = false) => ({ label, disabled, fingerprint: [...new TextEncoder().encode(label)].map((n) => n.toString(16).padStart(2, '0')).join('').padEnd(64, '0').slice(0, 64) });
function setup(fields = [field()], data: ProfileDocument['data'] = { profile_version: 1, contact: { email: 'alex@example.test' } }) {
  const sessionId = uuid(), formId = uuid();
  const inspection: Inspection = { sessionId, tabId: 7, frameId: 0, browserDocumentId: 'browser-document', snapshot: { schemaVersion: 1, identity: hash, document: uuid(), revision: 2, status: 'stable', selectedForm: formId, forms: [{ id: formId, label: 'Application', fieldCount: fields.length }], fields, unsupported: [], observation: { mutations: 0, scans: 3, bounded: true } } };
  const input: MappingInput = { sessionId, version: uuid(), source: 'replacement', document: { data, notes: 'NOTE_SECRET_CANARY', answerBodies: {} }, expiresAt: now + 100000 };
  const run = (corrections: SessionCorrection[] = []) => createDryRun(inspection, input, corrections, now);
  const correction = (value: SessionCorrection['value'], eligibilityConfirmed = false): SessionCorrection => ({ binding: previewBinding(inspection, input), fieldId: fields[0]!.id, currentFingerprint: hash, value, eligibilityConfirmed });
  return { inspection, input, run, correction };
}

describe('deterministic dry-run mappings', () => {
  it.each([
    ['Full name', 'name', 'identity.legal_name', 'Alex Fiction'], ['First name', 'given-name', 'identity.given_name', 'Alex'],
    ['Middle name', 'additional-name', 'identity.middle_name', 'M'], ['Last name', 'family-name', 'identity.family_name', 'Fiction'],
    ['Preferred name', '', 'identity.preferred_name', 'Lex'], ['Email', 'email', 'contact.email', 'alex@example.test'],
    ['Phone', 'tel', 'contact.phone', '+001234'], ['Address line 1', 'address-line1', 'contact.address.line1', '1 Sample Road'],
    ['Address line 2', '', 'contact.address.line2', 'Unit 02'], ['City', 'address-level2', 'contact.address.city', 'Sample City'],
    ['Region', 'address-level1', 'contact.address.region', 'Sample Region'], ['Postal code', 'postal-code', 'contact.address.postal_code', '00123'],
    ['Country code', 'country', 'contact.address.country_code', 'IN'], ['LinkedIn URL', '', 'links.linkedin', 'https://example.test/in/alex'],
    ['GitHub URL', '', 'links.github', 'https://example.test/alex'], ['Portfolio URL', '', 'links.portfolio', 'https://example.test/portfolio'],
    ['Website', '', 'links.website', 'https://example.test/'],
  ])('maps exact %s from %s without transformations', (label, autocomplete, path, value) => {
    const doc: ProfileDocument = { data: { profile_version: 1 }, notes: '', answerBodies: {} };
    const updated = updatedProfile(doc, path, value)!;
    const { run } = setup([field({ label, autocomplete, type: 'text' })], updated.data);
    expect(run().items[0]).toMatchObject({ state: 'proposed', sourcePath: path, proposal: { value: { kind: 'text', text: value }, source: { kind: 'replacement', path }, submission: 'manual_only' } });
  });
  it('maps valid scoped autocomplete and rejects contradictory or unsupported metadata', () => {
    expect(setup([field({ autocomplete: 'section-candidate home email' })]).run().counts.proposed).toBe(1);
    for (const autocomplete of ['email tel', 'shipping email', 'username', 'tel-national', 'url']) expect(setup([field({ autocomplete })]).run().counts.proposed).toBe(0);
    expect(setup([field({ label: 'Phone', autocomplete: 'email' })]).run().items[0]!.state).toBe('review');
  });
  it.each(['Name', 'Your name', 'First and last name', 'Nombre', 'Years experience', 'Graduation month', 'Employer'])('abstains on ambiguous, localized or unsupported %s', (label) => {
    expect(setup([field({ label })], { profile_version: 1, identity: { legal_name: 'Alex Fiction' }, experience: [{ id: 'one', organization: 'Lab' }] }).run().counts.proposed).toBe(0);
  });
  it('never splits a legal name into missing components', () => {
    const { run } = setup([field({ label: 'First name', autocomplete: 'given-name' }), field({ label: 'Last name', autocomplete: 'family-name' })], { profile_version: 1, identity: { legal_name: 'Alex M Fiction' } });
    expect(run().items.map((i) => i.state)).toEqual(['missing', 'missing']);
  });
  it('does not trust placeholders without explicit autocomplete', () => {
    expect(setup([field({ labelSource: 'placeholder' })]).run().counts.proposed).toBe(0);
    expect(setup([field({ labelSource: 'placeholder', autocomplete: 'email' })]).run().counts.proposed).toBe(1);
  });
  it('abstains on duplicate labels and repeated/foreign context while retaining opaque identity', () => {
    const duplicate = setup([field(), field()]).run(); expect(duplicate.counts.review).toBe(2); expect(new Set(duplicate.items.map((i) => i.fieldId)).size).toBe(2);
    for (const context of ['Current employer', 'Previous employer', 'Emergency contact', 'Reference']) {
      const label = context.includes('employer') ? 'Name' : 'Email';
      expect(setup([field({ label, context: [context] })]).run().counts.proposed).toBe(0);
    }
  });
  it.each([undefined, null, ''])('missing/null/empty %s never becomes a negative answer', (relocation) => {
    const { run } = setup([field({ label: 'Willing to relocate', type: 'select', options: [option('Yes'), option('No')] })], { profile_version: 1, reviewed_on: '2026-10-23', preferences: { relocation: relocation as boolean | null | undefined } });
    expect(run().counts.proposed).toBe(0);
  });
  it('preserves false and zero and selects an actual equivalent option', () => {
    const { run } = setup([field({ label: 'Willing to relocate', type: 'select', options: [option('Choose'), option('Yes'), option(' No ')] }), field({ label: 'Notice period (days)', type: 'number' })], { profile_version: 1, reviewed_on: '2026-10-23', preferences: { relocation: false, notice_days: 0 } });
    expect(run().items.map((i) => i.proposal?.value)).toEqual([{ kind: 'choice', label: ' No ', optionFingerprint: option(' No ').fingerprint }, { kind: 'text', text: '0' }]);
  });
  it.each([
    [option('Yes')], [option('No preference')], [option('No', true)], [option('No'), option(' NO ')],
    [{ ...option('No'), fingerprint: hash }, { ...option('Yes'), fingerprint: hash }],
  ].map((options) => ({ options })))('abstains instead of inventing a missing No or selecting ambiguous options %#', ({ options }) => {
    const { run } = setup([field({ label: 'Willing to relocate', type: 'select', options })], { profile_version: 1, reviewed_on: '2026-10-23', preferences: { relocation: false } });
    expect(run().items[0]).toMatchObject({ state: 'review' }); expect(run().items[0]!.proposal).toBeUndefined();
  });
  it('matches bounded meaning aliases, not array position or fuzzy text', () => {
    const { run } = setup([field({ label: 'Work arrangement', type: 'select', options: [option('Remote'), option('On-site')] })], { profile_version: 1, reviewed_on: '2026-10-23', preferences: { work_arrangements: ['onsite'] } });
    expect(run().items[0]!.proposal?.value).toMatchObject({ label: 'On-site' });
    expect(setup([field({ label: 'Country', type: 'select', options: [option('India'), option('United States')] })], { profile_version: 1, contact: { address: { country_code: 'IN' } } }).run().items[0]!.proposal?.value).toMatchObject({ label: 'India' });
  });
  it('requires explicit session confirmation of the exact country-specific eligibility', () => {
    const { run, correction } = setup([field({ label: 'Are you authorized to work in US?', type: 'select', category: 'sensitive', executable: false, options: [option('Yes'), option('No')] })], { profile_version: 1, eligibility: [{ country_code: 'US', work_authorized: false, confirmed_on: '2026-10-23' }] });
    expect(run().items[0]).toMatchObject({ state: 'review', proposal: { approval: 'session_confirmation', value: { label: 'No' } } });
    expect(run([correction(false)]).items[0]!.state).toBe('review');
    expect(run([correction(false, true)]).items[0]).toMatchObject({ state: 'proposed', proposal: { approval: 'session_approved', source: { kind: 'session', path: 'eligibility.US.work_authorized' } } });
  });
  it('never borrows another country or address and allows a deliberate missing-country session answer', () => {
    const { run, correction } = setup([field({ label: 'Are you authorized to work in United States?', type: 'select', category: 'sensitive', executable: false, options: [option('Yes'), option('No')] })], { profile_version: 1, contact: { address: { country_code: 'US' } }, eligibility: [{ country_code: 'IN', work_authorized: true }] });
    expect(run().items[0]).toMatchObject({ state: 'missing', sourcePath: 'eligibility.US.work_authorized' });
    expect(run([correction(false, true)]).counts.proposed).toBe(1);
  });
  it.each(['Are you eligible to work?', 'Do you require visa sponsorship?', 'Are you authorized to work in US or Canada?', 'Will you now or in the future require sponsorship in US?'])('abstains on non-equivalent eligibility: %s', (label) => {
    expect(setup([field({ label, autocomplete: 'email', category: 'sensitive', executable: false })]).run().items[0]!.proposal).toBeUndefined();
  });
  it.each(['I agree to privacy terms', 'I certify my answers', 'Gender', 'Veteran status', 'Expected salary', 'Citizenship'])('never maps sensitive/consent %s despite hostile hints/corrections', (label) => {
    const { run, correction } = setup([field({ label, autocomplete: 'email' })]);
    expect(run([correction('secret')]).items[0]).toMatchObject({ state: 'review', correctable: false }); expect(run([correction('secret')]).items[0]!.proposal).toBeUndefined();
  });
  it('declaration context and category override eligibility metadata', () => {
    const { run } = setup([field({ label: 'Are you authorized to work in US?', category: 'declaration', executable: false })], { profile_version: 1, eligibility: [{ country_code: 'US', work_authorized: true, confirmed_on: '2026-10-23' }] });
    expect(run().items[0]!.proposal).toBeUndefined();
  });
  it('stale facts require session review even when known; absence of review date is unknown freshness', () => {
    for (const reviewed_on of ['2026-01-01', null, undefined]) {
      const { run, correction } = setup([field({ label: 'Willing to relocate', type: 'select', options: [option('Yes'), option('No')] })], { profile_version: 1, reviewed_on, preferences: { relocation: false } });
      expect(run().items[0]!.state).toBe('review'); expect(run().items[0]!.proposal).toBeUndefined();
      expect(run([correction(false)]).counts.proposed).toBe(1);
    }
  });
  it('conflicts and multiple supplied preferences are review items', () => {
    const conflict = setup([field({ label: 'Are you authorized to work in US?' })], { profile_version: 1, eligibility: [{ country_code: 'US', work_authorized: true }, { country_code: 'US', work_authorized: false }] });
    expect(conflict.run().counts.proposed).toBe(0);
    expect(setup([field({ label: 'Work arrangement', type: 'select', options: [option('Remote'), option('Hybrid')] })], { profile_version: 1, reviewed_on: '2026-10-23', preferences: { work_arrangements: ['remote', 'hybrid'] } }).run().items[0]!.state).toBe('review');
  });
  it('preserves prefilled/user-edited page values, including invalid ones', () => {
    const { run, correction } = setup([field({ current: { fingerprint: hash, present: true } })]);
    expect(run([correction('replacement@example.test')]).items[0]).toMatchObject({ state: 'skipped', correctable: false });
    expect(run().items[0]!.proposal).toBeUndefined(); expect(run().counts.requiredUnresolved).toBe(1);
  });
  it('maps only a unique explicitly current job; never selects a repeated record by index', () => {
    const fields = [field({ label: 'Current employer' }), field({ label: 'Current job title' })];
    const data: ProfileDocument['data'] = { profile_version: 1, experience: [{ id: 'old', organization: 'Old Lab' }, { id: 'current', current: true, organization: 'Lab', title: 'Intern' }] };
    expect(setup(fields, data).run().items.map((i) => i.sourcePath)).toEqual(['experience.current.organization', 'experience.current.title']);
    data.experience![0]!.current = true; expect(setup(fields, data).run().counts.proposed).toBe(0);
  });
  it('keeps date precision and rejects incompatible page constraints', () => {
    const data = { profile_version: 1 as const, reviewed_on: '2026-10-23', preferences: { available_from: '2026-11' } };
    expect(setup([field({ label: 'Start date', type: 'date' })], data).run().counts.proposed).toBe(0);
    expect(setup([field({ label: 'Start date', type: 'month' })], data).run().counts.proposed).toBe(1);
    const constrained = field(); constrained.constraints.maxLength = '2'; expect(setup([constrained]).run().counts.proposed).toBe(0);
  });
  it('supports ordinary boolean preferences without inferring unchecked means No', () => {
    const { run, correction } = setup([field({ label: 'Willing to relocate', type: 'checkbox', category: 'preference', options: [option('Willing to relocate')] })], { profile_version: 1, reviewed_on: '2026-10-23', preferences: { relocation: false } });
    expect(run().items[0]).toMatchObject({ state: 'review', proposal: { approval: 'session_confirmation' } });
    expect(run([correction(false)]).items[0]!.proposal?.value).toMatchObject({ kind: 'checked', checked: false });
  });
  it('leaves radio group membership, multi-select and uploads explicit manual fallbacks', () => {
    const radio = field({ label: 'Work arrangement', type: 'radio', options: [option('Remote')] });
    const { run } = setup([radio, field({ type: 'file', category: 'file', label: 'Resume', executable: false })], { profile_version: 1, preferences: { work_arrangements: ['remote'] } });
    expect(run().counts.unsupported).toBe(2);
  });
  it('whole-file replacement never reads defaults, notes, answers or hidden secrets', () => {
    const { run, input } = setup(); const before = structuredClone(input);
    input.document.data = { profile_version: 1 }; expect(run().items[0]!.state).toBe('missing');
    input.document.data = before.document.data; expect(JSON.stringify(run())).not.toContain('NOTE_SECRET_CANARY');
    expect(input.document).toEqual(before.document);
  });
  it('session corrections are bound to field, version, document, frame, revision and fingerprint', () => {
    const { run, correction } = setup(); const c = correction('new@example.test');
    for (const patch of [{ sessionId: uuid() }, { tabId: 8 }, { frameId: 2 }, { document: uuid() }, { revision: 1 }, { inputVersion: uuid() }, { browserDocumentId: 'other' }]) {
      expect(run([{ ...c, binding: { ...c.binding, ...patch } }]).items[0]!.state).toBe('review');
    }
    expect(run([{ ...c, currentFingerprint: 'b'.repeat(64) }]).counts.proposed).toBe(0);
    expect(run([c, c]).counts.proposed).toBe(0);
    expect(run([correction('invalid email')]).counts.proposed).toBe(0);
    expect(run([c]).items[0]!.proposal?.value).toMatchObject({ text: 'new@example.test' });
  });
  it('strict proposals reject forged fields, options, policies, selectors, values and versions', () => {
    const { run, inspection, input } = setup(); const p = run().items[0]!.proposal!;
    expect(validatePreviewProposal(p, inspection, input, [], now)).toBe(true);
    for (const patch of [{ fieldId: uuid() }, { binding: { ...p.binding, revision: 1 } }, { source: { ...p.source, inputVersion: uuid() } }, { value: { kind: 'text', text: 'attacker@example.test' } }, { approval: 'session_approved' }, { selector: 'input' }, { submission: 'authorized' }]) {
      expect(validatePreviewProposal({ ...p, ...patch }, inspection, input, [], now)).toBe(false);
    }
    expect(FieldProposalSchema.safeParse({ ...p, script: 'submit()' }).success).toBe(false);
  });
  it('refuses expired/foreign inputs or unstable snapshots and never mutates inputs', () => {
    const { inspection, input, run } = setup(); const before = structuredClone({ inspection, input }); run();
    expect({ inspection, input }).toEqual(before);
    input.expiresAt = now; expect(run().counts.proposed).toBe(0); input.expiresAt = now + 1000;
    input.sessionId = uuid(); expect(run().counts.proposed).toBe(0); input.sessionId = inspection.sessionId;
    inspection.snapshot.status = 'unstable'; expect(run().counts.proposed).toBe(0);
  });
  it('profile-update proposals patch only the explicit reviewed path against a separate default', () => {
    const saved: ProfileDocument = { data: { profile_version: 1, identity: { legal_name: 'Saved Name' }, contact: { email: 'old@example.test' } }, notes: 'Preserved notes', answerBodies: {} };
    const before = structuredClone(saved); const next = updatedProfile(saved, 'contact.email', 'new@example.test')!;
    expect(saved).toEqual(before); expect(next.data.identity).toEqual(saved.data.identity); expect(next.notes).toBe(saved.notes); expect(next.data.contact?.email).toBe('new@example.test');
    expect(updatedProfile(saved, '__proto__.password', 'secret')).toBeNull(); expect(updatedProfile(saved, 'experience.absent.title', 'Invented')).toBeNull();
  });
});
