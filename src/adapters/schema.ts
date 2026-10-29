import { z } from 'zod';

// Recognition identifies a bounded DOM pattern. It is never live compatibility proof.
export const AdapterSchema = z.strictObject({
  id: z.enum(['generic', 'greenhouse', 'lever']), version: z.literal('1.0.0'),
  recognition: z.enum(['generic', 'host_path_form']),
  evidence: z.literal('owned_fixtures_only'),
}).refine((a) => (a.id === 'generic') === (a.recognition === 'generic'), 'Inconsistent adapter recognition');
export type Adapter = z.infer<typeof AdapterSchema>;
export function adapterDescription(adapter?: Adapter) {
  const name = adapter?.id === 'greenhouse' ? 'Greenhouse' : adapter?.id === 'lever' ? 'Lever' : 'Generic';
  return `${name} adapter ${adapter?.version ?? '1.0.0'} · ${adapter?.recognition === 'host_path_form' ? 'host/path and form pattern recognized' : 'generic capabilities; vendor unverified'}. Evidence: owned fixtures only. Native fields and visible single-choice inline listboxes only; popup choices, declarations and opaque uploads need manual action. File selection does not prove site acceptance. Live ATS variants untested.`;
}
