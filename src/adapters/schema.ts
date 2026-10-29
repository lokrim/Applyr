import { z } from 'zod';

// Recognition identifies a bounded DOM pattern. It is never live compatibility proof.
export const AdapterSchema = z.strictObject({
  id: z.enum(['generic', 'greenhouse', 'lever', 'google_forms', 'ashby', 'smartrecruiters', 'workable', 'workday']), version: z.literal('1.0.0'),
  recognition: z.enum(['generic', 'host_path_form']),
  evidence: z.literal('owned_fixtures_only'),
}).refine((a) => (a.id === 'generic') === (a.recognition === 'generic'), 'Inconsistent adapter recognition');
export type Adapter = z.infer<typeof AdapterSchema>;
export type AdapterId = Adapter['id'];
const commonManual = ['Declarations and demographics', 'Complex comboboxes and rich text', 'Repeated education/history', 'Inaccessible frames and roots', 'Next and submission'];
// Bundled evidence is the source of product claims, never page-supplied claims.
export const adapterCapabilities = {
  generic: { name: 'Generic', tier: 'partial', fixtures: 'F01–F11; inline choices F12–F14', supported: 'Labelled native fields and bounded inline choices', manual: [...commonManual, 'Unverified uploads'] },
  greenhouse: { name: 'Greenhouse', tier: 'partial', fixtures: 'F12', supported: 'Native fields and visible inline listboxes', manual: [...commonManual, 'Remote pickers; native file selection does not prove acceptance'] },
  lever: { name: 'Lever', tier: 'partial', fixtures: 'F13', supported: 'Native fields and visible inline listboxes', manual: [...commonManual, 'Remote pickers; native file selection does not prove acceptance'] },
  google_forms: { name: 'Google Forms', tier: 'partial', fixtures: 'F14', supported: 'Labelled native text and leaf ARIA radio choices', manual: [...commonManual, 'Google sign-in, Drive dialogs and all file uploads', 'Grids, checkbox groups and other unproven choices'] },
  ashby: { name: 'Ashby', tier: 'experimental', fixtures: 'F15', supported: 'Application-context recognition, labelled native contact fields and leaf inline choices', manual: [...commonManual, 'All uploads and unproven employer controls'] },
  smartrecruiters: { name: 'SmartRecruiters', tier: 'experimental', fixtures: 'F16', supported: 'Application-context recognition, labelled native contact fields and native selects', manual: [...commonManual, 'Privacy decisions, all uploads and unproven steps'] },
  workable: { name: 'Workable', tier: 'experimental', fixtures: 'F17', supported: 'Application-context recognition, labelled native contact fields and native choices', manual: [...commonManual, 'All uploads and employer-specific questions'] },
  workday: { name: 'Workday', tier: 'experimental', fixtures: 'F18', supported: 'Bounded tenant application recognition and labelled native contact fields', manual: [...commonManual, 'Account gates, all uploads and tenant-specific widgets; last-priority coverage'] },
} as const satisfies Record<AdapterId, { name: string; tier: string; fixtures: string; supported: string; manual: readonly string[] }>;
export function adapterDescription(adapter?: Adapter) {
  const c = adapterCapabilities[adapter?.id ?? 'generic'];
  return `${c.name} adapter ${adapter?.version ?? '1.0.0'} · ${c.tier} · ${adapter?.recognition === 'host_path_form' ? 'host/path and form pattern recognized' : 'generic capabilities; vendor unverified'}. Evidence: owned fixtures only (${c.fixtures}); live variants untested. ${c.supported}. Manual: ${c.manual.join('; ')}.`;
}
