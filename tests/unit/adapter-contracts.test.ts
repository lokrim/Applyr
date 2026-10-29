import { describe, expect, it } from 'vitest';
import { AdapterSchema } from '../../src/adapters/schema';
import { FormSnapshotSchema, type FormSnapshot } from '../../src/forms/schema';
import { recoverySignature } from '../../src/forms/operations';
import { FieldReviewSchema } from '../../src/review';

const id = crypto.randomUUID(), hash = 'a'.repeat(64);
function snapshot(): FormSnapshot {
  return { schemaVersion: 1, identity: hash, document: id, revision: 1, status: 'stable', selectedForm: id, forms: [{ id, label: 'Application', fieldCount: 1 }],
    fields: [{ id, label: 'Work location', labelSource: 'aria', context: [], type: 'select', control: 'inline_listbox_v1', autocomplete: '', required: true, executable: true, category: 'choice', filePurpose: null,
      constraints: { min: '', max: '', step: '', minLength: '', maxLength: '', pattern: '', accept: '', multiple: false }, options: [{ label: 'Remote', fingerprint: hash, disabled: false }], current: { fingerprint: hash, present: false }, validation: { valid: null, flags: [], ariaInvalid: false, errorPresent: false } }], unsupported: [], observation: { bounded: true, scans: 3, mutations: 0 } };
}
const adapter = { id: 'greenhouse', version: '1.0.0', recognition: 'host_path_form', evidence: 'owned_fixtures_only' };
describe('bounded adapter contracts', () => {
  it('rejects invented versions, proof, fields and inconsistent recognition claims', () => {
    expect(AdapterSchema.safeParse(adapter).success).toBe(true);
    for (const a of [{ ...adapter, id: 'generic' }, { ...adapter, version: '2.0' }, { ...adapter, evidence: 'live_verified' }, { ...adapter, execute: 'submit()' }]) expect(AdapterSchema.safeParse(a).success).toBe(false);
  });
  it('keeps old snapshots/review areas readable while constraining custom shapes', () => {
    const s = snapshot(); expect(FormSnapshotSchema.safeParse(s).success).toBe(true);
    expect(FieldReviewSchema.safeParse({ at: 1, areas: [{ frameId: 0, unsupported: 1 }], items: [] }).success).toBe(true);
    expect(FieldReviewSchema.safeParse({ at: 1, areas: [{ frameId: 0, unsupported: 1, adapter }], items: [] }).success).toBe(true);
    for (const patch of [{ type: 'text' }, { category: 'short_answer' }, { constraints: { ...s.fields[0]!.constraints, multiple: true } }, { category: 'declaration' }, { control: 'click_anything' }]) {
      expect(FormSnapshotSchema.safeParse({ ...s, fields: [{ ...s.fields[0], ...patch }] }).success).toBe(false);
    }
  });
  it('binds recovery to native/custom mechanism and enumerated choice membership', async () => {
    const f = snapshot().fields[0]!, native = { ...f }; delete native.control;
    expect(await recoverySignature(f)).not.toBe(await recoverySignature(native));
    expect(await recoverySignature(f)).not.toBe(await recoverySignature({ ...f, options: [{ ...f.options[0]!, fingerprint: 'b'.repeat(64) }] }));
  });
});
