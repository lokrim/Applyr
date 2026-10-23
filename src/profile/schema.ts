import { z } from 'zod';

export const MAX_PROFILE_BYTES = 256 * 1024;
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// ISO 3166-1 alpha-2 assigned codes; no citizenship/authorization inference.
const countries = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
export function validDate(value: string) {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const y = Number(year), m = Number(month);
  if (y < 1 || m < 1 || m > 12) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return !day || (Number(day) >= 1 && Number(day) <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!);
}
const text = z.string().max(32768);
const short = z.string().max(2048);
const id = z.string().max(80).regex(ID_PATTERN);
const date = z.string().refine(validDate, 'Use a real YYYY-MM or YYYY-MM-DD date.');
const fullDate = date.refine((v) => v.length === 10, 'Use YYYY-MM-DD for a review/confirmation date.');
const country = z.string().refine((v) => countries.has(v.toUpperCase()), 'Use an assigned ISO country code.').transform((v) => v.toUpperCase());
const https = short.refine((v) => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } }, 'Use an HTTPS URL without credentials.');
const optional = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const list = <T extends z.ZodType>(schema: T) => z.array(schema).max(100);
const strings = list(text);
const refs = list(short);
const bool = optional(z.boolean());
const ranged = {
  start_date: optional(date), end_date: optional(date),
};

export const ProfileSchema = z.strictObject({
  profile_version: z.literal(1),
  reviewed_on: optional(fullDate),
  identity: optional(z.strictObject({ legal_name: optional(short), preferred_name: optional(short), given_name: optional(short), middle_name: optional(short), family_name: optional(short) })),
  contact: optional(z.strictObject({ email: optional(z.email()), phone: optional(short), address: optional(z.strictObject({
    line1: optional(short), line2: optional(short), city: optional(short), region: optional(short), postal_code: optional(short), country_code: optional(country),
  })) })),
  links: optional(z.strictObject({ linkedin: optional(https), github: optional(https), portfolio: optional(https), website: optional(https), other: optional(list(z.strictObject({ label: optional(short), url: optional(https) }))) })),
  education: optional(list(z.strictObject({ id, institution: optional(short), degree: optional(short), field: optional(short), ...ranged, expected: bool,
    result: optional(z.strictObject({ value: optional(z.union([short, z.number().finite()])), scale: optional(z.union([short, z.number().finite()])) })), coursework: optional(strings), certifications: optional(strings),
  }))),
  experience: optional(list(z.strictObject({ id, organization: optional(short), title: optional(short), ...ranged, current: bool, responsibilities: optional(strings) }))),
  projects: optional(list(z.strictObject({ id, name: optional(short), description: optional(text), technologies: optional(strings), achievements: optional(strings), url: optional(https) }))),
  skills: optional(list(z.strictObject({ name: short.min(1), evidence_refs: optional(refs) }))),
  preferences: optional(z.strictObject({ locations: optional(strings), work_arrangements: optional(list(z.enum(['onsite', 'hybrid', 'remote']))), available_from: optional(date),
    internship_months: optional(z.number().int().nonnegative()), notice_days: optional(z.number().int().nonnegative()), relocation: bool,
    compensation: optional(z.strictObject({ amount: optional(z.number().finite().nonnegative()), currency: optional(z.string().regex(/^[A-Z]{3}$/)), period: optional(z.enum(['hour', 'month', 'year'])) })),
  })),
  eligibility: optional(list(z.strictObject({ country_code: country, work_authorized: bool, sponsorship_required: bool, confirmed_on: optional(fullDate) }))),
  answers: optional(list(z.strictObject({ id, question: short.min(1), kind: z.enum(['verified', 'preference']), fact_refs: optional(refs), reviewed_on: optional(fullDate) }))),
}).superRefine((profile, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  for (const section of ['education', 'experience', 'projects', 'answers'] as const) {
    const ids = new Set<string>();
    profile[section]?.forEach((entry, index) => {
      if (ids.has(entry.id)) issue([section, index, 'id'], 'Duplicate stable ID; choose a unique ID within this section.');
      ids.add(entry.id);
    });
  }
  for (const section of ['education', 'experience'] as const) profile[section]?.forEach((entry, i) => {
    // Compare date intervals: an unknown day/month must not be invented.
    if (entry.start_date && entry.end_date && entry.start_date.slice(0, 7) > entry.end_date.slice(0, 7)) issue([section, i, 'end_date'], 'End date precedes start date.');
    else if (entry.start_date?.length === 10 && entry.end_date?.length === 10 && entry.start_date > entry.end_date) issue([section, i, 'end_date'], 'End date precedes start date.');
  });
  const compensation = profile.preferences?.compensation;
  if (compensation?.amount != null && (!compensation.currency || !compensation.period)) issue(['preferences', 'compensation'], 'An amount requires currency and period.');
  const seen = new Map<string, { work_authorized?: boolean | null; sponsorship_required?: boolean | null }>();
  profile.eligibility?.forEach((entry, i) => {
    const previous = seen.get(entry.country_code);
    if (previous) {
      const conflict = (['work_authorized', 'sponsorship_required'] as const).some((key) => previous[key] != null && entry[key] != null && previous[key] !== entry[key]);
      issue(['eligibility', i, 'country_code'], conflict ? 'Conflicting country eligibility; repair the entries explicitly.' : 'Duplicate country eligibility; keep one entry per country.');
    }
    seen.set(entry.country_code, entry);
  });
  const paths = referencePaths(profile);
  profile.skills?.forEach((skill, i) => skill.evidence_refs?.forEach((ref, j) => { if (!paths.has(ref)) issue(['skills', i, 'evidence_refs', j], 'Unresolved evidence reference; use a supplied stable path.'); }));
  profile.answers?.forEach((answer, i) => answer.fact_refs?.forEach((ref, j) => { if (!paths.has(ref)) issue(['answers', i, 'fact_refs', j], 'Unresolved fact reference; use a supplied stable path.'); }));
});

export type Profile = z.infer<typeof ProfileSchema>;
export interface ProfileDocument { data: Profile; notes: string; answerBodies: Record<string, string> }

export function referencePaths(profile: unknown): Set<string> {
  const paths = new Set<string>();
  function walk(value: unknown, path: string) {
    if (path && value !== undefined) paths.add(path);
    if (!value || typeof value !== 'object') return;
    // Country codes uniquely identify eligibility records. Other arrays without
    // IDs may be referenced as a whole, never by an unstable numeric index.
    if (Array.isArray(value)) value.forEach((item) => {
      if (item && typeof item === 'object' && 'id' in item) walk(item, `${path}.${String(item.id)}`);
      else if (path === 'eligibility' && item && typeof item === 'object' && 'country_code' in item) walk(item, `${path}.${String(item.country_code)}`);
    });
    else Object.entries(value).forEach(([key, item]) => { if (!['profile_version', 'answers', 'reviewed_on'].includes(key)) walk(item, path ? `${path}.${key}` : key); });
  }
  walk(profile, '');
  return paths;
}
