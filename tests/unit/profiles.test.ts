import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exportProfile, parseAnswerSections, parseProfileBytes, parseProfileMarkdown, readProfileFile, removeUnknownKeys, validateProfileDocument } from '../../src/profile/markdown';
import { MAX_PROFILE_BYTES, ProfileSchema, type ProfileDocument } from '../../src/profile/schema';
import { profileAssertion, profileAssertions } from '../../src/profile/assertions';

const md = (yaml = 'profile_version: 1', body = '') => `---\n${yaml}\n---\n\n${body}`;
const blank = readFileSync('planning/examples/profile-template.md', 'utf8');
const fictional = readFileSync('planning/examples/profile-fictional.md', 'utf8');
function parsed(text: string) { const result = parseProfileMarkdown(text); expect(result.issues).toEqual([]); expect(result.document).toBeDefined(); return result.document!; }

describe('bounded safe Markdown profile round-trip', () => {
  it.each([['blank', blank], ['fictional', fictional]])('parses and semantically round-trips the supplied %s example', (_, text) => {
    const document = parsed(text);
    expect(parsed(exportProfile(document))).toEqual(document);
  });

  it('keeps bundled downloadable examples identical to the supplied examples', () => {
    expect(readFileSync('src/profile/examples/profile-template.md', 'utf8')).toBe(blank);
    expect(readFileSync('src/profile/examples/profile-fictional.md', 'utf8')).toBe(fictional);
  });

  it('setup → export → import retains every supported field, all values and answer bodies', () => {
    const document: ProfileDocument = { data: {
      profile_version: 1, reviewed_on: '2026-10-23',
      identity: { legal_name: 'Fictional One Name', preferred_name: '', given_name: null, middle_name: 'F', family_name: 'Example' },
      contact: { email: 'fictional@example.com', phone: '+0012345', address: { line1: '1 Example', line2: '', city: 'Example City', region: null, postal_code: '00101', country_code: 'IN' } },
      links: { linkedin: 'https://example.com/in', github: null, portfolio: 'https://example.com', website: 'https://example.org', other: [{ label: 'Demo', url: 'https://example.net' }, {}] },
      education: [{ id: 'degree-one', institution: 'Fictional College', degree: 'BSc', field: 'CS', start_date: '2023-08', end_date: '2027-05-12', expected: false, result: { value: 3.8, scale: '4.0' }, coursework: ['Data\nstructures', 'SQL'], certifications: [] }, { id: 'degree-two', result: null }],
      experience: [{ id: 'work-one', organization: 'Fictional Org', title: 'Intern', start_date: '2025-01-12', end_date: null, current: false, responsibilities: ['Build a demo'] }, { id: 'work-two' }],
      projects: [{ id: 'project-one', name: 'Demo', description: 'Fictional', technologies: ['TypeScript'], achievements: ['Local demo'], url: 'https://example.com/demo' }, { id: 'project-two', description: null }],
      skills: [{ name: 'TypeScript', evidence_refs: ['projects.project-one', 'education.degree-one.coursework'] }],
      preferences: { locations: ['Example City'], work_arrangements: ['onsite', 'hybrid', 'remote'], available_from: '2027-06', internship_months: 0, notice_days: null, relocation: false, compensation: { amount: 0, currency: 'INR', period: 'month' } },
      eligibility: [{ country_code: 'IN', work_authorized: false, sponsorship_required: null, confirmed_on: '2026-10-23' }, { country_code: 'US', work_authorized: null }],
      answers: [{ id: 'project-answer', question: 'A project?', kind: 'verified', fact_refs: ['projects.project-one', 'preferences.available_from', 'eligibility.IN.work_authorized'], reviewed_on: '2026-10-23' }, { id: 'preference', question: 'Preferences?', kind: 'preference', fact_refs: null, reviewed_on: null }],
    }, notes: '# Fictional test\n\nNotes with **formatting**.\n\n## Extra notes\n\nKeep this.', answerBodies: { 'project-answer': 'A **demo**.  \nNext line.\n\n```md\n## Answer: fake\n---\n```', preference: '<script>alert("inert")</script>\n![no fetch](https://example.com/pixel)' } };
    expect(validateProfileDocument(document).issues).toEqual([]);
    expect(parsed(exportProfile(document))).toEqual(document);
    expect(document.data.identity).not.toHaveProperty('family_name_inferred');
  });

  it('preserves absent/null/false, zero, leading zeros and month precision without guessing', () => {
    const p = parsed(md('profile_version: 1\ncontact: {phone: "0012", address: {postal_code: "00101", country_code: in}}\npreferences: {relocation: false, notice_days: 0, available_from: "2027-06"}\nidentity: null'));
    expect(p.data).not.toHaveProperty('eligibility');
    expect(p.data.identity).toBeNull();
    expect(p.data.preferences).toEqual({ relocation: false, notice_days: 0, available_from: '2027-06' });
    expect(p.data.contact?.address?.country_code).toBe('IN');
    expect(parsed(exportProfile(p))).toEqual(p);
    expect(ProfileSchema.safeParse({ profile_version: 1, contact: { phone: 123 } }).success).toBe(false);
    expect(ProfileSchema.safeParse({ profile_version: 1, contact: { address: { postal_code: 101 } } }).success).toBe(false);
  });

  it('blocks unknown keys with locations until explicitly removed; never drops other values', () => {
    const input = md('profile_version: 1\nidentity:\n  legal_name: Example\n  nickname: Demo\npreferences:\n  relocation: false');
    const result = parseProfileMarkdown(input);
    expect(result.document).toBeUndefined();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_KEY', path: ['identity', 'nickname'], line: 5, removable: true }));
    const repaired = removeUnknownKeys(input, [['identity', 'nickname'], ['identity', 'legal_name']]);
    expect(parsed(repaired).data.identity).toEqual({ legal_name: 'Example' });
    expect(parsed(repaired).data.preferences?.relocation).toBe(false);
  });

  it.each([
    ['', 'FRONT_MATTER'], ['---\nprofile_version: 1', 'FRONT_MATTER'],
    [md('profile_version: 2'), 'VERSION'], [md('profile_version: "1"'), 'VERSION'],
    [md('profile_version: 1\nprofile_version: 1'), 'DUPLICATE_KEY'],
    [md('profile_version: 1\nidentity: {legal_name: A, legal_name: B}'), 'DUPLICATE_KEY'],
    [md('profile_version: 1\nidentity: !evil {}'), 'TAG_RESOLVE_FAILED'],
    [md('profile_version: 1\nidentity: &x {}\ncontact: *x'), 'YAML_FEATURE'],
    [md('profile_version: 1\nidentity: {<<: {legal_name: x}}'), 'FORBIDDEN_KEY'],
    [md('profile_version: 1\nidentity: !!map {}'), 'YAML_FEATURE'],
    [md('profile_version: 1\nidentity: {password: canary}'), 'FORBIDDEN_KEY'],
    [md('profile_version: 1\napi_key: canary'), 'FORBIDDEN_KEY'],
    [md('profile_version: 1\ncontact: {sessionToken: canary}'), 'FORBIDDEN_KEY'],
    [md('profile_version: 1\n__proto__: {}'), 'FORBIDDEN_KEY'],
    [md('profile_version: 1\nidentity: [unclosed'), 'BAD_INDENT'],
  ])('rejects unsafe/malformed input with bounded diagnostics (%s)', (input, code) => {
    const result = parseProfileMarkdown(input);
    expect(result.document).toBeUndefined(); expect(result.issues.some((i) => i.code === code)).toBe(true);
    expect(JSON.stringify(result.issues)).not.toContain('canary');
  });

  it('rejects binary, invalid UTF-8, oversized bytes/text/files and multiple blocks', async () => {
    expect(parseProfileBytes(new Uint8Array([0xff, 0xfe])).issues[0]!.code).toBe('ENCODING');
    expect(parseProfileMarkdown(md('profile_version: 1', '\0')).issues[0]!.code).toBe('ENCODING');
    expect(parseProfileBytes(new Uint8Array(MAX_PROFILE_BYTES + 1)).issues[0]!.code).toBe('SIZE');
    expect(parseProfileMarkdown('😀'.repeat(MAX_PROFILE_BYTES / 2)).issues[0]!.code).toBe('SIZE');
    expect((await readProfileFile(new File(['x'.repeat(MAX_PROFILE_BYTES + 1)], 'profile.md'))).issues[0]!.code).toBe('SIZE');
    expect((await readProfileFile(new File([blank], 'profile.pdf'))).issues[0]!.code).toBe('FILE');
    expect(parseProfileMarkdown(md('profile_version: 1', '\n---\nprofile_version: 1\n---')).document).toBeUndefined();
    expect(parseProfileMarkdown(md('profile_version: 1\n...\n---\nprofile_version: 1')).document).toBeUndefined();
  });

  it('bounds nesting, total nodes and collection sizes', () => {
    expect(parseProfileMarkdown(md('profile_version: 1\nx: ' + '['.repeat(20) + 'null' + ']'.repeat(20))).issues[0]!.code).toBe('PARSE_LIMIT');
    expect(parseProfileMarkdown(md('profile_version: 1\nprojects: [' + Array.from({ length: 101 }, () => '{}').join(',') + ']')).issues[0]!.code).toBe('PARSE_LIMIT');
    expect(parseProfileMarkdown(md('profile_version: 1\nx: [' + Array.from({ length: 100 }, () => '[' + Array(100).fill('1').join(',') + ']').join(',') + ']')).issues[0]!.code).toBe('PARSE_LIMIT');
  });

  it('form validation reports the same size boundary and prevents answer text from changing section ownership', () => {
    expect(validateProfileDocument({ data: { profile_version: 1 }, notes: 'x'.repeat(MAX_PROFILE_BYTES), answerBodies: {} }).issues[0]?.code).toBe('SIZE');
    const document: ProfileDocument = { data: { profile_version: 1, answers: [{ id: 'a', kind: 'verified', question: 'Q' }] }, notes: '', answerBodies: { a: 'Body\n\n## Other notes\n\nWould leave the answer.' } };
    expect(validateProfileDocument(document).document).toBeUndefined();
    expect(() => exportProfile(document)).toThrow(/Repair/);
  });

  it.each(['2025-02-29', '2024-02-30', '2024-13', '0000-01', '2025', '2025-2-01'])('rejects impossible/malformed date %s', (date) => {
    expect(parseProfileMarkdown(md(`profile_version: 1\npreferences: {available_from: "${date}"}`)).document).toBeUndefined();
  });
  it('enforces quoted dates, date ordering, HTTPS URLs, country codes, compensation and unique stable IDs', () => {
    for (const yaml of [
      'preferences: {available_from: 2026-10}', 'reviewed_on: "2026-10"',
      'education: [{id: a, start_date: "2025-04", end_date: "2025-03-30"}]',
      'experience: [{id: a, start_date: "2025-04-22", end_date: "2025-04-01"}]',
      'links: {website: "javascript:alert(1)"}', 'links: {website: "http://example.com"}', 'links: {website: "https://user:password@example.com"}',
      'contact: {address: {country_code: ZZ}}', 'preferences: {compensation: {amount: 1}}',
      'projects: [{id: a}, {id: a}]', 'education: [{id: "Invalid ID"}]', 'experience: [{id: 10}]',
    ]) expect(parseProfileMarkdown(md('profile_version: 1\n' + yaml)).document, yaml).toBeUndefined();
    expect(parsed(md('profile_version: 1\nexperience: [{id: a, start_date: "2025-04-22", end_date: "2025-04"}]')).data.experience).toHaveLength(1);
  });

  it('requires matching answer metadata/text and resolved answer/skill references', () => {
    const metadata = 'profile_version: 1\nanswers: [{id: a, question: Q, kind: verified, fact_refs: []}]';
    for (const body of ['', '## Answer: b\n\nBody', '## Answer: a\n\nBody\n\n## Answer: a\n\nOther', '## Answer: invalid_ID\n\nBody', '## Answer: a###\n\nBody', '## Answer: a\n\n## Notes\n\nBody']) expect(parseProfileMarkdown(md(metadata, body)).document).toBeUndefined();
    expect(parseProfileMarkdown(md('profile_version: 1', '## Answer: orphan\n\nBody')).document).toBeUndefined();
    expect(parseProfileMarkdown(md(metadata.replace('fact_refs: []', 'fact_refs: [projects.missing]'), '## Answer: a\n\nBody')).document).toBeUndefined();
    expect(parseProfileMarkdown(md('profile_version: 1\nskills: [{name: SQL, evidence_refs: [experience.missing]}]')).document).toBeUndefined();
    expect(parseProfileMarkdown(md('profile_version: 1\nprojects: [{id: demo}]\nskills: [{name: SQL, evidence_refs: [projects.0]}]')).document).toBeUndefined();
    const p = parsed(md(metadata, '# Notes\n\nKeep.\n\n## Answer: a\n\nLine **one**.  \nNext.\n\n## Other notes\n\nAfter.'));
    expect(p.answerBodies.a).toBe('Line **one**.  \nNext.'); expect(p.notes).toContain('After.');
    expect(parsed(exportProfile(p))).toEqual(p);
    expect(parseAnswerSections('```md\n## Answer: fake\n```').answerBodies).toEqual({});
  });

  it('retains executable HTML, images and links solely as inert strings', () => {
    const html = '<script>globalThis.stolen=true</script>\n<img src="https://example.com/pixel" onerror="steal()">\n[click](javascript:steal())';
    const p = parsed(md('profile_version: 1', html));
    expect(p.notes).toBe(html); expect(parsed(exportProfile(p))).toEqual(p);
  });

  it('rejects conflicting or duplicate same-country eligibility without inferring answers', () => {
    const result = parseProfileMarkdown(md('profile_version: 1\neligibility: [{country_code: in, work_authorized: false}, {country_code: IN, work_authorized: true}]'));
    expect(result.document).toBeUndefined(); expect(result.issues[0]!.message).toMatch(/Conflicting/);
    expect(parseProfileMarkdown(md('profile_version: 1\neligibility: [{country_code: IN}, {country_code: IN}]')).document).toBeUndefined();
    expect(parsed(md('profile_version: 1\neligibility: [{country_code: IN, work_authorized: false, sponsorship_required: null}]')).data.eligibility?.[0]).toEqual({ country_code: 'IN', work_authorized: false, sponsorship_required: null });
  });

  it('carries source/version/review provenance, marks old time-sensitive assertions for review, and excludes notes', () => {
    const p = parsed(md('profile_version: 1\nreviewed_on: "2026-01-01"\nidentity: {legal_name: Example}\npreferences: {relocation: false, available_from: null}\neligibility: [{country_code: IN, work_authorized: false, confirmed_on: "2026-10-23"}]', 'No invented facts.'));
    const assertions = profileAssertions(p, 'frozen-v', Date.parse('2026-10-23T00:00:00Z'));
    expect(assertions.find((a) => a.sourcePath === 'preferences.relocation')).toMatchObject({ value: false, status: 'needs_review', profileVersion: 1, inputVersion: 'frozen-v' });
    expect(assertions.find((a) => a.sourcePath === 'preferences.available_from')?.status).toBe('unknown');
    expect(assertions.find((a) => a.sourcePath === 'eligibility.IN.work_authorized')?.status).toBe('asserted');
    expect(assertions.some((a) => a.sourcePath.includes('notes'))).toBe(false);
    expect(profileAssertion(p, 'identity.family_name', 'frozen-v')).toMatchObject({ status: 'unknown', value: undefined });
    expect(profileAssertion(p, 'preferences.available_from', 'frozen-v')).toMatchObject({ status: 'unknown', value: null });
  });

  it('an explicit unknown answer review date never borrows the profile review date', () => {
    const p = parsed(md('profile_version: 1\nreviewed_on: "2026-10-23"\nanswers: [{id: a, question: Q, kind: verified, reviewed_on: null}]', '## Answer: a\n\nFictional.'));
    expect(profileAssertion(p, 'answers.a.body', 'v', Date.parse('2026-10-23T00:00:00Z'))).toMatchObject({ reviewedOn: null, status: 'needs_review' });
  });
});
