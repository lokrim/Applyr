import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Inspection } from '../forms/schema';
import { createDryRun, type MappingInput } from '../mapping/rules';
import { evidenceIndex, mappingEvidence, safeAiField } from '../ai/context';
import { aiIntent } from '../ai/client';
import type { ReviewBatch, TaskSelection } from '../ai/contracts';
import { providerPattern } from '../providers/endpoints';
import { ProviderFailure, type Provider } from '../providers/contracts';

export function AiReview({ inspection, input, disabled }: { inspection: Inspection; input: MappingInput; disabled: boolean }) {
  const [provider, setProvider] = useState<Provider | ''>('');
  const [selected, setSelected] = useState<TaskSelection[]>([]);
  const [role, setRole] = useState('');
  const [batch, setBatch] = useState<ReviewBatch | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [decisions, setDecisions] = useState<Record<string, 'approve' | 'reject'>>({});
  const [mappingEdits, setMappingEdits] = useState<Record<string, { factRef?: string; optionId?: string }>>({});
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => () => { void aiIntent({ type: 'DISCARD' }).catch(() => {}); }, []);
  const preview = createDryRun(inspection, input);
  const fields = inspection.snapshot.fields.filter((f) => safeAiField(f) && preview.items.some((i) => i.fieldId === f.id && i.state === 'review' && i.sourcePath === null));
  const evidence = evidenceIndex(input);
  function toggle(fieldId: string, checked: boolean) {
    const field = fields.find((f) => f.id === fieldId)!;
    setSelected((s) => checked ? [...s, { fieldId, kind: field.type === 'textarea' ? 'prose' : 'mapping', evidenceRefs: [], maxWords: null }] : s.filter((s) => s.fieldId !== fieldId));
  }
  return <section className="proposal ai-review" data-testid="ai-review" aria-label="Optional AI review">
    <h4>Optional AI assistance</h4>
    <p>AI is off until you choose a provider and request proposals. Deterministic autofill stays available. Each request may incur charges on the saved provider/model. Review every fact and wording before insertion; model confidence cannot approve a write.</p>
    <label>AI provider<select aria-label="AI provider" disabled={busy || !!batch || disabled} value={provider} onChange={(e) => setProvider(e.target.value as Provider | '')}><option value="">Off — deterministic only</option><option value="openai">OpenAI</option><option value="gemini">Gemini</option><option value="claude">Claude</option></select></label>
    {provider && !batch && <>
      <p>Configure and test this model in Settings, then grant candidate sharing there. This request sends only the selected questions/options and displayed career evidence. No full profile, PDF, notes, contact data or existing field values are included.</p>
      {!fields.length && <p>No eligible ambiguous fields. Missing or consequential answers require your input on the website.</p>}
      {fields.map((f) => {
        const selection = selected.find((s) => s.fieldId === f.id);
        const sources = selection?.kind === 'prose' ? evidence : mappingEvidence(input, f);
        return <fieldset key={f.id}><legend>{f.label}</legend>
          <label><input type="checkbox" disabled={busy || disabled || (!selection && selected.length >= 8)} checked={!!selection} onChange={(e) => toggle(f.id, e.target.checked)} />Request {f.type === 'textarea' ? 'wording draft' : 'mapping suggestion'}</label>
          {selection && <>
            {selection.kind === 'prose' && <label>Maximum words (optional; include the website limit)<input type="number" min={1} max={500} value={selection.maxWords ?? ''} onChange={(e) => setSelected(selected.map((s) => s.fieldId === f.id ? { ...s, maxWords: e.target.value ? Number(e.target.value) : null } : s))} /></label>}
            {!sources.length && <p>Missing evidence. Supply facts through Candidate profile and refresh the frozen input, or answer on the website. No AI request can fill this gap.</p>}
            <ul>{sources.map((source) => <li key={source.ref}>{selection.kind === 'prose' && <input aria-label={`Include ${source.ref}`} type="checkbox" checked={selection.evidenceRefs.includes(source.ref)} disabled={!selection.evidenceRefs.includes(source.ref) && selection.evidenceRefs.length >= 6} onChange={(e) => setSelected(selected.map((s) => s.fieldId === f.id ? { ...s, evidenceRefs: e.target.checked ? [...s.evidenceRefs, source.ref] : s.evidenceRefs.filter((r) => r !== source.ref) } : s))} />}<code>{source.ref}</code>: {source.text}</li>)}</ul>
          </>}
        </fieldset>;
      })}
      <label>Role excerpt for wording (optional, up to 1,000 characters)<textarea maxLength={1000} value={role} onChange={(e) => setRole(e.target.value)} /></label>
      <button disabled={busy || disabled || !selected.length || selected.some((s) => s.kind === 'prose' ? !s.evidenceRefs.length : !mappingEvidence(input, fields.find((f) => f.id === s.fieldId)!).length)} onClick={() => {
        const grant = import.meta.env.BROWSER === 'firefox' ? browser.permissions.request({ origins: [providerPattern(provider)], ...{ data_collection: ['authenticationInfo', 'websiteContent', 'personallyIdentifyingInfo'] } }) : Promise.resolve(true);
        setBusy(true); setMessage('');
        void grant.then(async (allowed) => {
          if (!allowed) throw new ProviderFailure('permission');
          const response = await aiIntent({ type: 'PREPARE', provider, inspection, inputVersion: input.version, selections: selected, roleExcerpt: role });
          setBatch(response.batch); setEdits(Object.fromEntries(response.batch?.proposals.map((p) => [p.fieldId, p.text]) ?? [])); setDecisions({}); setMappingEdits({}); setReviewed(false); setMessage(response.message);
        }).catch((e: unknown) => setMessage(`${e instanceof ProviderFailure ? e.message : 'AI unavailable.'} Deterministic results are preserved. Retry explicitly when ready.`)).finally(() => setBusy(false));
      }}>{message ? 'Retry selected AI tasks (may charge)' : 'Request selected AI proposals (may charge)'}</button>
    </>}
    {batch && <>
      <p>Review batch · {batch.provider} / {batch.model}. Applies only to this application and frozen input. Approved text is never saved as a reusable fact or reused for another job.</p>
      {batch.proposals.map((p) => {
        const f = batch.context.fields.find((f) => f.id === p.fieldId)!;
        return <fieldset key={p.fieldId} data-testid="ai-proposal"><legend>{f.question}</legend>
          <p>{p.status.replaceAll('_', ' ')} · {p.operation === 'draft_answer' ? 'Unverified wording draft — check every factual assertion and personal motivation' : 'Fact mapping suggestion'}</p>
          <p>Limit: {f.maxChars} characters{f.maxWords !== null ? ` / ${f.maxWords} words` : ''}.</p>
          <p>Source evidence:</p><ul>{p.factRefs.map((ref) => <li key={ref}><code>{ref}</code>: {f.evidence.find((e) => e.ref === ref)?.text}</li>)}</ul>
          {f.roleExcerpt && <details><summary>Role context</summary><p>{f.roleExcerpt}</p></details>}
          {p.status === 'proposed' ? <>
            {p.operation === 'draft_answer' ? <label>Edit wording<textarea maxLength={f.maxChars} value={edits[p.fieldId] ?? ''} onChange={(e) => { setEdits({ ...edits, [p.fieldId]: e.target.value }); setReviewed(false); }} /></label> : <><label>Edit source fact<select value={mappingEdits[p.fieldId]?.factRef ?? p.factRefs[0]} onChange={(e) => { setMappingEdits({ ...mappingEdits, [p.fieldId]: { ...mappingEdits[p.fieldId], factRef: e.target.value } }); setReviewed(false); }}>{f.evidence.map((source) => <option key={source.ref} value={source.ref}>{source.ref}: {source.text}</option>)}</select></label>{p.optionId && <label>Edit option<select value={mappingEdits[p.fieldId]?.optionId ?? p.optionId} onChange={(e) => { setMappingEdits({ ...mappingEdits, [p.fieldId]: { ...mappingEdits[p.fieldId], optionId: e.target.value } }); setReviewed(false); }}>{f.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>}</>}
            <label>Decision<select aria-label={`Decision for ${f.question}`} value={decisions[p.fieldId] ?? ''} onChange={(e) => { setDecisions({ ...decisions, [p.fieldId]: e.target.value as 'approve' | 'reject' }); setReviewed(false); }}><option value="">Choose explicitly</option><option value="approve">Approve for this application</option><option value="reject">Reject</option></select></label>
          </> : <><p>Supply the missing or conflicting fact yourself. Nothing will be inserted.</p><button onClick={() => setDecisions({ ...decisions, [p.fieldId]: 'reject' })}>Dismiss question</button></>}
        </fieldset>;
      })}
      <label><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />I reviewed the evidence, factual claims, wording and length limits for every approved answer</label>
      <button disabled={busy || disabled || !reviewed || batch.proposals.some((p) => !decisions[p.fieldId])} onClick={() => {
        setBusy(true);
        void aiIntent({ type: 'DECIDE', batchId: batch.id, decisions: batch.proposals.map((p) => ({ fieldId: p.fieldId, action: decisions[p.fieldId]!, text: edits[p.fieldId] ?? '', factsReviewed: reviewed, ...mappingEdits[p.fieldId] })) })
          .then((r) => { setBatch(null); setMessage(r.message); }).catch((e: unknown) => { setBatch(null); setMessage(`${e instanceof ProviderFailure ? e.message : 'Approval could not be applied.'} Reinspect and review a fresh batch. Completed field results are preserved.`); }).finally(() => setBusy(false));
      }}>Apply batch decisions and insert approved values</button>
    </>}
    {provider && <button className="secondary" disabled={busy} onClick={() => { setProvider(''); setBatch(null); void aiIntent({ type: 'DISCARD' }).then((r) => setMessage(r.message)); }}>Continue without AI / reject batch</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
