import { useState } from 'react';
import type { SessionCheckpoint } from '../domain/session';
import type { FormSelection, Inspection } from '../forms/schema';
import { sendRequest } from '../runtime/client';

export function FormInspection({ checkpoint }: { checkpoint: SessionCheckpoint }) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [frame, setFrame] = useState('');
  async function inspect(selection?: FormSelection) {
    setBusy(true); setError(''); setInspection(null);
    try {
      const candidate = checkpoint.access?.frames.find((f) => f.identity === frame);
      const result = await sendRequest({ type: 'INSPECT_FORM', sessionId: checkpoint.id, revision: checkpoint.revision, ...(candidate ? { frameOrigin: candidate.origin, frameIdentity: candidate.identity } : {}), ...(selection ? { selection } : {}) });
      setInspection(result.inspection ?? null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Inspection unavailable.'); }
    finally { setBusy(false); }
  }
  const snapshot = inspection?.snapshot;
  return <section aria-labelledby="inspection-heading" className="field-inspection">
    <h3 id="inspection-heading">Read-only field inspection</h3>
    <p>Inspect the relevant form for review. Values are represented by document-salted fingerprints. No values are filled, no files are uploaded, and no model is called.</p>
    {!!checkpoint.access?.frames.length && <label>Inspection context<select value={frame} onChange={(e) => { setFrame(e.target.value); setInspection(null); }}><option value="">Bound page</option>{checkpoint.access.frames.map((f) => <option key={f.identity} value={f.identity}>{f.origin} · {f.url}</option>)}</select></label>}
    <button disabled={busy || !checkpoint.target.origin || ['closed', 'navigation', 'restart', 'permission', 'reload'].includes(checkpoint.access?.reason ?? '')} onClick={() => void inspect()}>Inspect fields</button>
    {busy && <p role="status">Waiting briefly for a stable form…</p>}
    {error && <p role="alert">{error}</p>}
    {snapshot && <div data-testid="form-inspection">
      <p role="status">Snapshot {snapshot.revision}: {snapshot.status.replaceAll('_', ' ')}. {snapshot.fields.length} fields. This is a point-in-time observation; reinspect after changing the page.</p>
      <p className="muted">Frame {inspection.frameId} · Document {snapshot.document}</p>
      {snapshot.status === 'selection_required' && <fieldset><legend>Select the application form to inspect</legend>{snapshot.forms.map((form, index) => <button key={form.id} onClick={() => void inspect({ formId: form.id, document: snapshot.document, revision: snapshot.revision })}>{index + 1}. {form.label} ({form.fieldCount} controls)</button>)}</fieldset>}
      {snapshot.status === 'unstable' && <p>Changes exceeded the inspection bound. Wait for the page or complete this area manually, then reinspect.</p>}
      {snapshot.status === 'stale_selection' && <p>The form selection changed. Reinspect and select the form again.</p>}
      <ol>{snapshot.fields.map((field) => <li key={field.id} className="inspected-field">
        <strong>{field.label || 'Missing label'}</strong> · {field.type} · {field.required ? 'Required' : 'Optional'}
        {!!field.context.length && <p>{field.context.join(' / ')}</p>}
        <p>{field.category.replaceAll('_', ' ')}{field.filePurpose ? ` · ${field.filePurpose.replaceAll('_', ' ')}` : ''} · {field.executable ? 'Eligible control; writes unavailable' : 'Manual review required'}</p>
        <p>{field.current.present ? 'Existing value present' : 'Empty or unchecked'} · {field.validation.flags.join(', ') || (field.validation.valid === false ? 'Invalid' : 'No native validation error')}{field.validation.ariaInvalid || field.validation.errorPresent ? ' · Website reports an error' : ''}</p>
        {!!field.options.length && <p>Options: {field.options.map((o) => `${o.label}${o.disabled ? ' (disabled)' : ''}`).join(', ')}</p>}
        <details><summary>Inspection metadata</summary><p>Field {field.id} · {field.labelSource} · {field.autocomplete || 'No autocomplete'}</p><p>Constraints: {Object.entries(field.constraints).filter(([, v]) => v !== '' && v !== false).map(([k, v]) => `${k}: ${v}`).join(', ') || 'None declared'}</p><p className="target">Fingerprint: {field.current.fingerprint}</p></details>
      </li>)}</ol>
      {!!snapshot.unsupported.length && <><h4>Manual or unsupported areas</h4><ul>{snapshot.unsupported.map((item, index) => <li key={index}>{item.code.replaceAll('_', ' ')}: {item.label}</li>)}</ul></>}
    </div>}
  </section>;
}
