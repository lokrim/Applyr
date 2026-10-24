import { usableCorrections } from '../attention/queue';
import { AiReview } from './AiReview';
import { useEffect, useState } from 'react';
import type { Inspection } from '../forms/schema';
import { createDryRun, updatedProfile, type MappingInput } from '../mapping/rules';
import type { PreviewItem, SessionCorrection } from '../mapping/schema';
import { getDatabase } from '../storage/database';
import { ProfileStore, type ProfileSnapshot, type SavedProfile } from '../storage/profiles';
import { changedProfilePaths } from '../profile/assertions';
import { exportProfile } from '../profile/markdown';
import type { ProfileDocument } from '../profile/schema';
import { notifyProfileChange, onProfileChange, onProfileDeletion } from '../browser/profile-events';
import type { SessionCheckpoint } from '../domain/session';
import { DocumentStore } from '../storage/documents';
import type { DocumentRef } from '../domain/document';
import { readCheckpoint, sendRequest } from '../runtime/client';

const store = async () => new ProfileStore(await getDatabase());
export function DryRunPreview({ inspection, inputVersion, checkpoint }: { inspection: Inspection; inputVersion: string | null; checkpoint: SessionCheckpoint }) {
  const [snapshot, setSnapshot] = useState<ProfileSnapshot | null>(null);
  const [saved, setSaved] = useState<SavedProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true, generation = 0;
    const refresh = () => {
      const request = ++generation;
      void store().then((s) => s.read()).then((state) => {
        if (alive && request === generation) {
          setSnapshot(state.snapshot?.version === inputVersion ? state.snapshot : null); setSaved(state.saved); setLoaded(true);
        }
      }).catch(() => { if (alive && request === generation) { setSnapshot(null); setSaved(null); setLoaded(true); } });
    };
    const stop = onProfileChange(refresh);
    const clear = onProfileDeletion(() => { generation++; setSnapshot(null); setSaved(null); });
    refresh(); window.addEventListener('focus', refresh);
    return () => { alive = false; stop(); clear(); window.removeEventListener('focus', refresh); };
  }, [inputVersion]);
  useEffect(() => {
    if (!snapshot) return;
    const timer = setTimeout(() => setSnapshot(null), Math.max(0, snapshot.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [snapshot]);
  return <section className="dry-run" aria-labelledby="dry-run-heading">
    <h3 id="dry-run-heading">Dry-run mapping preview</h3>
    <p>Preview only. This preview does not fill or verify website answers. No provider requests. Submission stays manual. This does not mean the application is complete.</p>
    {!loaded ? <p role="status">Loading frozen input…</p> : snapshot && snapshot.sessionId === inspection.sessionId ? <FrozenPreview key={snapshot.version} checkpoint={checkpoint} input={snapshot} inspection={inspection} saved={saved} onSaved={setSaved} /> : <p>Freeze a reviewed profile for this session in Candidate profile, then inspect fields again. Saved defaults are never borrowed into a missing or replacement input.</p>}
  </section>;
}

function FrozenPreview({ input, inspection, saved, onSaved, checkpoint }: { input: MappingInput; inspection: Inspection; saved: SavedProfile | null; onSaved: (value: SavedProfile) => void; checkpoint: SessionCheckpoint }) {
  const [corrections, setCorrections] = useState<SessionCorrection[]>([]);
  const [update, setUpdate] = useState<{ document: ProfileDocument; base: SavedProfile | null; path: string } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState<DocumentRef | null>(null);
  const [upload, setUpload] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  useEffect(() => { void getDatabase().then((db) => new DocumentStore(db).read()).then((s) => setResume(s.document?.sessionId === checkpoint.id ? s.document : null)); }, [checkpoint.id]);
  const persisted = usableCorrections(checkpoint, inspection, input);
  const combined = [...persisted.filter((c) => !corrections.some((x) => x.fieldId === c.fieldId)), ...corrections];
  const preview = createDryRun(inspection, input, combined);
  const { counts } = preview;
  return <div data-testid="dry-run-preview">
    <p className="target" data-testid="mapping-input">Frozen {input.source} input {input.version}. Snapshot {preview.binding.revision}, frame {preview.binding.frameId}.</p>
    <p>The attention queue saves reviewed batch answers for this application only. Local preview edits below stay in this view; use the queue to retain them across closing or recovery. Saved-default edits affect future sessions. Refreshing the frozen input requires reinspection and new confirmations.</p>
    <p role="status" data-testid="mapping-counts">{counts.inspected} inspected · {counts.proposed} proposed · {counts.skipped} skipped · {counts.missing} missing answers · {counts.review} need review · {counts.unsupported} unsupported fields · {counts.unsupportedAreas} unsupported areas</p>
    <p>{counts.requiredUnresolved} required fields remain unverified or unresolved. Proposed values are not accepted website answers.</p>
    <div className="proposal">
      <h4>Deterministic autofill</h4>
      <p>Start permits the displayed deterministic proposals on this bound form. The website may autosave values and uploads before submission. Recovery details expire with this session within seven days. Consent stays on the website; eligibility needs the explicit session confirmation below. You use Next and submit yourself.</p>
      {resume ? <><p>Selected session resume: {resume.filename} · {resume.size} bytes · input {resume.inputVersion}</p><label className="check-label"><input type="checkbox" checked={upload} disabled={!!runId || started} onChange={(e) => setUpload(e.target.checked)} />Include this resume in a uniquely identified native resume field</label></> : <p>No session resume included. Start a local document session first to include a PDF.</p>}
      <button disabled={!!runId || started || checkpoint.autofill?.status === 'running' || checkpoint.autofill?.status === 'cancelled' || checkpoint.lifecycle === 'PAUSED' || ['CANCELLED', 'AUTOFILL_FINISHED', 'FAILED'].includes(checkpoint.lifecycle) || checkpoint.recovery?.inspectionRequired || checkpoint.recovery?.reattachRequired || (!counts.proposed && !upload)} onClick={() => {
        const id = crypto.randomUUID(); setRunId(id); setStarted(true); setNotice('Filling permitted fields and checking current-step validation…');
        void readCheckpoint().then((latest) => { if (latest?.id !== checkpoint.id) throw new Error('Session changed. Reinspect before Start.'); return sendRequest({ type: 'START_AUTOFILL', sessionId: checkpoint.id, revision: latest.revision, runId: id, inspection, inputVersion: input.version, corrections: combined, resume: upload && resume ? { id: resume.id, inputVersion: resume.inputVersion } : null }); })
          .then(() => setNotice('Current-step results saved. Review on the website; use Next and submit yourself.'))
          .catch((e: unknown) => setNotice(e instanceof Error ? e.message : 'Autofill interrupted. Reinspect before any new action.')).finally(() => setRunId(null));
      }}>Start Autofill</button>
      {runId && <button className="secondary" onClick={() => {
        void sendRequest({ type: 'CANCEL_AUTOFILL', sessionId: checkpoint.id, revision: checkpoint.revision, runId }).then(() => setNotice('Cancelled. Further writes stopped. Existing page values and uploads are not rolled back.')).catch(() => setNotice('Cancellation could not be confirmed. Check saved progress.'));
      }}>Cancel autofill</button>}
    </div>
    <AiReview inspection={inspection} input={input} disabled={!!runId || started || checkpoint.lifecycle === 'PAUSED' || ['CANCELLED', 'AUTOFILL_FINISHED', 'FAILED'].includes(checkpoint.lifecycle) || !!checkpoint.recovery?.inspectionRequired || !!checkpoint.recovery?.reattachRequired} />
    <ol className="mapping-items">{preview.items.map((item) => <li key={item.fieldId} data-testid="mapping-item" data-state={item.state} className="inspected-field">
      <strong>{item.label}</strong> · {item.required ? 'Required' : 'Optional'} · <span>{item.state.replaceAll('_', ' ')}</span>
      <p>{item.reason}</p>
      {item.sourcePath && <p>Source: <code>{item.sourcePath}</code> · {item.proposal?.source.kind ?? input.source} · input {input.version}{item.proposal?.source.reviewedOn ? ` · reviewed ${item.proposal.source.reviewedOn}` : ''}</p>}
      {item.proposal && <><p>Proposed value: <strong data-testid="proposed-value">{displayValue(item)}</strong></p><p>{item.proposal.explanation}</p><p>Approval: {item.proposal.approval.replaceAll('_', ' ')}. Precondition: same field, document, input and revision; unchanged empty value; fresh inspection required.</p></>}
      {item.correctable && <CorrectionEditor key={`${item.fieldId}:${corrections.findIndex((c) => c.fieldId === item.fieldId)}`} item={item} onUse={(value, eligibilityConfirmed) => {
        const field = inspection.snapshot.fields.find((f) => f.id === item.fieldId)!;
        setCorrections((previous) => [...previous.filter((c) => c.fieldId !== item.fieldId), { binding: preview.binding, fieldId: item.fieldId, currentFingerprint: field.current.fingerprint, value, eligibilityConfirmed }]);
        setUpdate(null); setNotice('Session answer reviewed. The frozen profile and page were kept.');
      }} />}
      {corrections.some((c) => c.fieldId === item.fieldId) && <div className="actions"><button className="text-button" onClick={() => { setCorrections(corrections.filter((c) => c.fieldId !== item.fieldId)); setUpdate(null); }}>Remove session correction</button>{item.state === 'proposed' && !item.eligibility && <button className="secondary" onClick={() => {
        const correction = corrections.find((c) => c.fieldId === item.fieldId)!;
        const base = saved?.document ?? { data: { profile_version: 1 as const }, notes: '', answerBodies: {} };
        const document = updatedProfile(base, item.sourcePath!, correction.value);
        if (document) { setUpdate({ document, base: saved, path: item.sourcePath! }); setReviewed(false); setNotice('Review the saved-default diff below. Only the corrected path is proposed.'); }
        else setNotice('This record is absent or incompatible in the saved default. Use Candidate profile to review a complete update.');
      }}>Propose profile update</button>}</div>}
    </li>)}</ol>
    {!!inspection.snapshot.unsupported.length && <><h4>Unsupported areas</h4><ul>{inspection.snapshot.unsupported.map((u, i) => <li key={i}>{u.code.replaceAll('_', ' ')}: {u.label}</li>)}</ul></>}
    {notice && <p role="status">{notice}</p>}
    {update && <div className="proposal" aria-label="Reviewed profile update">
      <h4>Proposed profile update</h4><p>Changes the reusable default after explicit save. Your frozen input and session answer stay as reviewed.</p>
      <p>Changed paths: {changedProfilePaths(update.base?.document ?? null, update.document).join(', ')}</p>
      <details><summary>Before — saved default</summary><pre>{update.base ? exportProfile(update.base.document) : 'No saved default'}</pre></details>
      <details open><summary>After — proposed default</summary><pre>{exportProfile(update.document)}</pre></details>
      <label className="check-label"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />I reviewed this default-profile diff</label>
      <button disabled={!reviewed || busy} onClick={() => {
        setBusy(true);
        void store().then((s) => s.saveDefault(update.document, update.base?.version ?? null)).then((next) => { onSaved(next); notifyProfileChange(); setUpdate(null); setNotice('Reviewed profile update saved for future sessions. Frozen input unchanged.'); })
          .catch(() => { setUpdate(null); setNotice('The saved default changed or validation failed. Propose a fresh diff and review again.'); }).finally(() => setBusy(false));
      }}>Save reviewed profile update</button><button className="text-button" disabled={busy} onClick={() => setUpdate(null)}>Dismiss update</button>
    </div>}
  </div>;
}

function displayValue(item: PreviewItem) { const value = item.proposal!.value; return value.kind === 'text' ? value.text : value.kind === 'choice' ? value.label : value.checked ? 'Yes (checked)' : 'No (unchecked)'; }
function CorrectionEditor({ item, onUse }: { item: PreviewItem; onUse: (value: string | number | boolean, confirmed: boolean) => void }) {
  const [text, setText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  return <details className="correction"><summary>Review answer for this session</summary><form onSubmit={(e) => {
    e.preventDefault();
    if (!text || (item.eligibility && !confirmed)) return;
    onUse(item.inputKind === 'boolean' ? text === 'true' : item.inputKind === 'number' ? Number(text) : text, confirmed);
  }}>
    {item.inputKind === 'boolean' ? <label>Session answer<select aria-label="Session answer" required value={text} onChange={(e) => { setText(e.target.value); setConfirmed(false); }}><option value="">Unknown — choose explicitly</option><option value="true">Yes</option><option value="false">No</option></select></label> : <label>Session answer<input required maxLength={2048} type={item.inputKind === 'number' ? 'number' : 'text'} min={item.inputKind === 'number' ? '0' : undefined} value={text} onChange={(e) => setText(e.target.value)} /></label>}
    {item.eligibility && <label className="check-label"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I explicitly confirm this country-specific answer for this application</label>}
    <button disabled={!text || (item.eligibility && !confirmed)}>Use for this application preview</button>
  </form></details>;
}
