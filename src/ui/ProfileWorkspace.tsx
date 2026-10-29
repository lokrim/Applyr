import { useEffect, useRef, useState } from 'react';
import { getDatabase } from '../storage/database';
import { ProfileStore, type ProfileSnapshot, type SavedProfile } from '../storage/profiles';
import { exportProfile, parseProfileMarkdown, readProfileFile, removeUnknownKeys, validateProfileDocument, type ImportResult } from '../profile/markdown';
import { MAX_PROFILE_BYTES, type ProfileDocument } from '../profile/schema';
import { changedProfilePaths, profileAssertions } from '../profile/assertions';
import { ProfileFields } from './ProfileFields';
import { sendIntent, readCheckpoint } from '../runtime/client';
import { downloadMarkdown } from '../browser/export';
import { notifyProfileChange, notifyProfileDeletion, onProfileChange, onProfileDeletion } from '../browser/profile-events';
import blankExample from '../profile/examples/profile-template.md?raw';
import fictionalExample from '../profile/examples/profile-fictional.md?raw';

const emptyDocument = (): ProfileDocument => ({ data: { profile_version: 1 }, notes: '', answerBodies: {} });
const profileStore = async () => new ProfileStore(await getDatabase());

export function ProfileSummary() {
  const [summary, setSummary] = useState('Not added');
  useEffect(() => {
    let alive = true;
    const refresh = () => { void profileStore().then((store) => store.read()).then(({ saved, snapshot }) => {
      if (alive) setSummary(snapshot ? `Frozen ${snapshot.source} profile` : saved ? 'Saved default available' : 'Not added');
    }).catch(() => { if (alive) setSummary('Storage unavailable'); }); };
    const stop = onProfileChange(refresh);
    refresh(); window.addEventListener('focus', refresh);
    return () => { alive = false; stop(); window.removeEventListener('focus', refresh); };
  }, []);
  return <strong>{summary}</strong>;
}

export function ProfileWorkspace({ surface, sessionId, onFreeze }: { surface: 'options' | 'session'; sessionId: string | null; onFreeze: () => Promise<void> }) {
  const [saved, setSaved] = useState<SavedProfile | null>(null);
  const [snapshot, setSnapshot] = useState<ProfileSnapshot | null>(null);
  const [draft, setDraft] = useState<ProfileDocument>(emptyDocument);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [source, setSource] = useState<'saved' | 'replacement'>('replacement');
  const [selectedSavedVersion, setSelectedSavedVersion] = useState<string | null>(null);
  const [proposal, setProposal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const importGeneration = useRef(0);
  const initialSession = useRef(sessionId);
  const valid = preview?.document;
  const changes = valid ? changedProfilePaths(snapshot?.document ?? null, valid) : [];

  function clearProfileMemory() {
    importGeneration.current++; setSaved(null); setSnapshot(null); setDraft(emptyDocument()); setPreview(null); setImportText(null); setProposal(false); setDeleting(false); setSource('replacement'); setSelectedSavedVersion(null);
  }

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      const generation = importGeneration.current;
      void profileStore().then((store) => store.read()).then((state) => { if (alive && generation === importGeneration.current) { setSaved(state.saved); setSnapshot(state.snapshot); } if (alive) setReady(true); })
        .catch(() => { if (alive) setError('Local profile storage is unavailable. Reload to try again.'); });
    };
    const stop = onProfileChange(refresh);
    refresh();
    return () => { alive = false; stop(); };
  }, []);

  useEffect(() => onProfileDeletion(() => {
    importGeneration.current++; setSaved(null); setSnapshot(null); setDraft(emptyDocument()); setPreview(null); setImportText(null); setProposal(false); setDeleting(false); setSource('replacement'); setSelectedSavedVersion(null);
    setNotice('Profile and recovery copies were deleted. This open working copy has been cleared.');
  }), []);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch { setError('Profile operation failed or state changed in another window. Reload profile state and review before trying again.'); }
    finally { setBusy(false); }
  }
  function edit(next: ProfileDocument) { setDraft(next); setPreview(null); setProposal(false); setSource('replacement'); }
  function stage(document: ProfileDocument, selectedSource: 'saved' | 'replacement') {
    setSelectedSavedVersion(selectedSource === 'saved' ? saved?.version ?? null : null);
    setDraft(structuredClone(document)); setPreview(validateProfileDocument(document)); setSource(selectedSource); setProposal(false); setImportText(null); setNotice('Review this whole profile before saving or freezing it. Missing fields stay unknown.');
  }
  function validateImport(text: string) {
    const result = parseProfileMarkdown(text); setPreview(result); setProposal(false); setSource('replacement');
    if (result.document) setDraft(result.document);
  }
  function updateData(data: Record<string, unknown>) {
    const oldAnswers = draft.data.answers ?? [];
    const nextAnswers = (data.answers ?? []) as NonNullable<ProfileDocument['data']['answers']>;
    if (new Set(nextAnswers.map((a) => a.id)).size !== nextAnswers.length) {
      setError('Answer IDs must be unique. Choose a different ID; both existing answer bodies have been kept.'); return;
    }
    setError('');
    const bodies: Record<string, string> = Object.create(null);
    nextAnswers.forEach((answer) => {
      if (Object.hasOwn(draft.answerBodies, answer.id)) bodies[answer.id] = draft.answerBodies[answer.id] ?? '';
      else {
        // Renaming a stable answer ID retains its text; removal drops only that body.
        const at = nextAnswers.indexOf(answer);
        const old = oldAnswers[at];
        bodies[answer.id] = old && !nextAnswers.some((a) => a.id === old.id) ? draft.answerBodies[old.id] ?? '' : '';
      }
    });
    edit({ ...draft, data: data as ProfileDocument['data'], answerBodies: bodies });
  }

  return <section id="profiles" className="card profile-workspace" aria-labelledby="profile-heading">
    <h2 id="profile-heading">Candidate profile</h2>
    <p>Set up locally, without AI. Every field is optional. Legal names stay as entered; country codes never imply work authorization.</p>
    <p className="muted">Personal files and exports are plaintext. Local browser storage is not encrypted by applyr. Keep passwords, API keys, OTPs, cookies and tokens out of fields and prose. Credential checks cannot prove a file contains no secrets.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    {!ready ? <p>Loading profile state…</p> : <>
      <p data-testid="saved-profile-state">{saved ? `Saved default version ${saved.version}` : 'No saved default profile.'}</p>
      {snapshot && <div className="snapshot-summary"><p data-testid="frozen-profile-state">Frozen input version {snapshot.version} · {snapshot.source}</p><p>Frozen until explicitly refreshed. Recovery expires {new Date(snapshot.expiresAt).toLocaleString()}. Reinspection is required after refresh to generate a new dry-run mapping preview.</p><details><summary>View frozen input</summary><pre>{exportProfile(snapshot.document)}</pre></details></div>}
      <div className="actions">
        <button className="secondary" disabled={busy} onClick={() => { importGeneration.current++; stage(emptyDocument(), 'replacement'); setPreview(null); }}>Create blank profile</button>
        {saved && <button className="secondary" disabled={busy} onClick={() => stage(saved.document, 'saved')}>{surface === 'options' ? 'Edit saved default' : 'Preview saved default'}</button>}
        {snapshot && <button className="secondary" disabled={busy} onClick={() => stage(snapshot.document, 'replacement')}>Edit session profile</button>}
        <button className="text-button" disabled={busy} onClick={() => void run(async () => { const state = await (await profileStore()).read(); setSaved(state.saved); setSnapshot(state.snapshot); setProposal(false); setNotice('Profile state reloaded. The working form was kept.'); })}>Reload profile state</button>
      </div>
      <div className="examples"><p>Examples contain no real candidate information and are never preloaded.</p><button className="text-button" onClick={() => downloadMarkdown(blankExample, 'applyr-blank-template.md')}>Download blank template</button><button className="text-button" onClick={() => downloadMarkdown(fictionalExample, 'applyr-fictional-example.md')}>Download fictional example</button></div>
      <label className="file-label">Import one Markdown file (UTF-8, max 256 KiB)<input type="file" accept=".md,text/markdown" disabled={busy} onChange={(e) => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
        const generation = ++importGeneration.current;
        void run(async () => {
          const result = await readProfileFile(file);
          if (generation !== importGeneration.current) return;
          // Store only bounded, valid UTF-8 text in the repair editor.
          const text = file.size <= MAX_PROFILE_BYTES && !result.issues.some((i) => ['ENCODING', 'FILE'].includes(i.code)) ? new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) : null;
          if (generation !== importGeneration.current) return;
          setImportText(text); setPreview(result); setSource('replacement'); setProposal(false);
          if (result.document) setDraft(result.document);
          setNotice('Import preview only. Nothing has been saved or selected for a session.');
        });
      }} /></label>
      {importText !== null && <details open={!valid} className="import-repair"><summary>Review or repair imported Markdown</summary><label>Markdown source<textarea rows={12} spellCheck={false} maxLength={MAX_PROFILE_BYTES} value={importText} onChange={(e) => { setImportText(e.target.value); setPreview(null); setProposal(false); }} /></label><div className="actions"><button className="secondary" onClick={() => validateImport(importText)}>Validate imported Markdown</button><button className="text-button" onClick={() => { setImportText(null); setPreview(null); }}>Return to profile form</button></div></details>}
      {preview && <div className="validation-preview" aria-label="Profile validation preview">
        {preview.issues.length > 0 ? <><p role="alert">Repair {preview.issues.length} validation issue(s) before continuing.</p><ul>{preview.issues.map((issue, i) => <li key={i}><code>{issue.code}</code> · {issue.line ? `line ${issue.line}${issue.column ? `:${issue.column}` : ''}` : 'field'} · <code>{issue.path.join('.') || 'document'}</code>: {issue.message}{issue.removable && importText !== null && <button className="text-button" onClick={() => { const repaired = removeUnknownKeys(importText, [issue.path]); setImportText(repaired); validateImport(repaired); }}>Remove this unknown key</button>}</li>)}</ul></> : valid && <>
          <h3>Validation passed — review supplied assertions</h3>
          <p>Imported facts are user assertions. “Verified” is the supplied answer kind, not independent verification. Authorization, sponsorship and consent still need per-application handling.</p>
          <p>{profileAssertions(valid, 'preview').filter((a) => a.status === 'needs_review').length} time-sensitive values need review (review date missing or older than 90 days). Notes are never promoted to facts.</p>
          <details open><summary>Inert Markdown preview</summary><pre data-testid="profile-preview">{exportProfile(valid)}</pre></details>
          <div className="actions">
            <button className="secondary" disabled={busy} onClick={() => downloadMarkdown(exportProfile(valid))}>Download Markdown</button>
            {surface === 'options' && <button disabled={busy} onClick={() => void run(async () => { setSaved(await (await profileStore()).saveDefault(valid, saved?.version ?? null)); notifyProfileChange(); setNotice('Saved as default for future sessions. Existing frozen inputs were kept.'); })}>Save as default</button>}
            {surface === 'session' && <>
              <button disabled={busy || !sessionId || initialSession.current !== sessionId} onClick={() => void run(async () => {
                const selection = source === 'saved' && selectedSavedVersion ? { source: 'saved' as const, savedVersion: selectedSavedVersion } : { source: 'replacement' as const, document: valid };
                const next = await (await profileStore()).freeze(sessionId!, selection, snapshot?.version ?? null);
                // The frozen indicator must not precede the parent checkpoint
                // refresh: its revision change invalidates an old inspection.
                await onFreeze(); setSnapshot(next); notifyProfileChange();
                setNotice('Profile frozen for this session only. Reinspection is required before future page actions.');
              })}>{snapshot ? 'Refresh frozen profile' : 'Freeze profile for this session'}</button>
              <button className="secondary" disabled={busy} onClick={() => setProposal(true)}>Propose profile update</button>
            </>}
          </div>
          {surface === 'session' && <><p>Freezing is an explicit local input selection, without AI or page actions. A replacement is the entire profile; missing facts never borrow the saved default.</p><p>Recovery keeps a temporary profile copy for at most seven days after explicit session activity. Saving a default is separate.</p><p>Affected input paths: {changes.join(', ') || 'No semantic changes'}. Refresh clears the previous inspection and corrections; inspect fields to review affected mappings.</p></>}
          {proposal && <div className="proposal"><h3>Proposed persistent update</h3><p>This changes the reusable default only after the save below. Review the complete before/after contents.</p><p>Changed paths: {changedProfilePaths(saved?.document ?? null, valid).join(', ') || 'No semantic changes'}</p><details><summary>Before — saved default</summary><pre>{saved ? exportProfile(saved.document) : 'No saved default'}</pre></details><details open><summary>After — proposed default</summary><pre>{exportProfile(valid)}</pre></details><button disabled={busy} onClick={() => void run(async () => { setSaved(await (await profileStore()).saveDefault(valid, saved?.version ?? null)); notifyProfileChange(); setProposal(false); setNotice('Proposed default explicitly saved. Frozen session inputs were kept.'); })}>Save proposed default</button><button className="text-button" onClick={() => setProposal(false)}>Dismiss proposal</button></div>}
        </>}
      </div>}
      {importText === null && <div className="profile-editor">
        <h3>Working form</h3><p>Changes stay in this tab until an explicit save or freeze. Not supplied, unknown (null), empty text and false are distinct. Dates use YYYY-MM or YYYY-MM-DD; review dates use YYYY-MM-DD. References use paths such as projects.project-id. All links require HTTPS.</p>
        <ProfileFields value={draft.data as Record<string, unknown>} onChange={updateData} />
        <details className="profile-section"><summary>Answer text & notes</summary>{draft.data.answers?.map((answer, i) => <label key={i}>Answer body: {answer.id}<textarea rows={5} spellCheck={false} value={draft.answerBodies[answer.id] ?? ''} onChange={(e) => edit({ ...draft, answerBodies: { ...draft.answerBodies, [answer.id]: e.target.value } })} /></label>)}<label>Notes (never treated as facts)<textarea rows={5} spellCheck={false} value={draft.notes} onChange={(e) => edit({ ...draft, notes: e.target.value })} /></label></details>
        <button disabled={busy} onClick={() => { setPreview(validateProfileDocument(draft)); setProposal(false); }}>Validate profile</button>
      </div>}
      {surface === 'options' && saved && <div className="delete-profile"><button className="text-button" disabled={busy} onClick={() => setDeleting(true)}>Delete saved profile</button>{deleting && <><p>This removes the saved default, all sensitive frozen profile copies and open working copies in applyr. Exported files remain under your control.</p><button disabled={busy} onClick={() => void run(async () => { const cp = await readCheckpoint(); await sendIntent({ type: 'DELETE_DATA', scope: 'profile', sessionId: cp?.id ?? null, revision: cp?.revision ?? null }); clearProfileMemory(); notifyProfileDeletion(); setNotice('Saved profile and recovery copies deleted.'); })}>Confirm delete profile and recovery copies</button><button className="text-button" onClick={() => setDeleting(false)}>Keep profile</button></>}</div>}
    </>}
  </section>;
}
