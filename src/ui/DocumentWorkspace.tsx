import { useEffect, useRef, useState } from 'react';
import type { DocumentRef } from '../domain/document';
import { DocumentError, selectPdf } from '../documents/pdf';
import { DocumentStore, type DocumentSelection, type DocumentState } from '../storage/documents';
import { getDatabase } from '../storage/database';
import { notifyDocumentChange, onDocumentChange } from '../browser/document-events';
import { notifyProfileChange } from '../browser/profile-events';

const store = async () => new DocumentStore(await getDatabase());
const empty: DocumentState = { saved: null, session: null, document: null };
type Draft = { selection: DocumentSelection; filename: string; size: number; digest: string; inputVersion: string };

function DocumentDetails({ document }: { document: Pick<DocumentRef, 'filename' | 'size' | 'digest' | 'inputVersion'> }) {
  return <dl className="details document-details"><div><dt>Filename / size</dt><dd>{document.filename} · {document.size.toLocaleString()} bytes ({(document.size / 1024 / 1024).toFixed(2)} MiB)</dd></div><div><dt>Input version</dt><dd>{document.inputVersion}</dd></div><div><dt>SHA-256 digest (content identity only)</dt><dd>{document.digest}</dd></div></dl>;
}

export function DocumentSummary() {
  const [summary, setSummary] = useState('Not added');
  useEffect(() => {
    let alive = true;
    const refresh = () => { void store().then((s) => s.read()).then((s) => {
      if (alive) setSummary(s.session?.status === 'needs_reselection' ? 'Select resume again' : s.document ? 'Session resume bound' : s.saved ? 'Reusable default available' : 'Not added');
    }).catch(() => { if (alive) setSummary('Storage unavailable'); }); };
    const stop = onDocumentChange(refresh);
    refresh(); window.addEventListener('focus', refresh);
    return () => { alive = false; stop(); window.removeEventListener('focus', refresh); };
  }, []);
  return <strong>{summary}</strong>;
}

export function DocumentWorkspace({ surface, sessionId, onMutation }: { surface: 'session' | 'options'; sessionId: string | null; onMutation: () => Promise<void> }) {
  const [state, setState] = useState<DocumentState>(empty);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reuse, setReuse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<DocumentRef | null>(null);
  const generation = useRef(0);
  const currentSessionId = useRef(sessionId);
  const terminal = surface === 'session' && (state.session?.status === 'finished' || state.session?.status === 'cancelled');

  async function reload() { setState(await (await store()).read()); }
  function clearDraft() { generation.current++; setDraft(null); setReuse(false); setDeleting(null); }
  useEffect(() => {
    let alive = true;
    const refresh = (deleted = false) => {
      if (deleted) { clearDraft(); setNotice('A document was deleted. Open selections were cleared; select the resume again if needed.'); }
      void store().then((s) => s.read()).then((s) => { if (alive) { setState(s); setReady(true); } })
        .catch(() => { if (alive) { setError(new DocumentError('STORAGE').message); setReady(true); } });
    };
    const focus = () => refresh();
    const stop = onDocumentChange(refresh);
    refresh(); window.addEventListener('focus', focus);
    return () => { alive = false; generation.current++; stop(); window.removeEventListener('focus', focus); };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (reason) { setError(reason instanceof DocumentError ? reason.message : new DocumentError('STORAGE').message); }
    finally { setBusy(false); }
  }
  async function end(status: 'cancelled' | 'finished') {
    await (await store()).end(state.session!.sessionId, state.session!.version, status);
    clearDraft(); await reload(); notifyDocumentChange(); notifyProfileChange(); await onMutation();
    setNotice(`Local session ${status}. Unsaved document and profile recovery copies were removed; deliberately saved defaults remain. This does not report an application submission.`);
  }

  return <section id="documents" className="card document-workspace" aria-labelledby="documents-heading">
    <h2 id="documents-heading">Resume PDF</h2>
    <p>Select one PDF up to 10 MiB. Basic extension, MIME and header checks are not malware scanning, proof of readability or employer acceptance. Empty browser MIME is allowed when the other checks pass.</p>
    <p className="muted">Original bytes and filename stay unchanged. applyr does not parse the resume or send it to AI. This resume is never implicitly used as a cover letter, portfolio or transcript.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    {!ready ? <p>Loading local documents…</p> : <>
      <div data-testid="saved-resume"><h3>Saved reusable default</h3>{state.saved ? <><DocumentDetails document={state.saved} /><div className="actions"><button className="secondary" disabled={busy || terminal} onClick={() => {
        generation.current++; const saved = state.saved!; setDraft({ ...saved, selection: { source: 'saved', id: saved.id, inputVersion: saved.inputVersion } }); setReuse(false); setNotice('Saved default selected for review. The running session version stays unchanged until an explicit replacement.');
      }}>Use saved resume</button><button className="text-button" disabled={busy} onClick={() => setDeleting(state.saved)}>Delete saved resume</button></div></> : <p>No saved reusable resume.</p>}</div>
      <div data-testid="session-resume"><h3>Session document</h3>{state.document ? <><p>Bound to session {state.session?.sessionId}. Recovery expires {new Date(state.session!.expiresAt).toLocaleString()}. Default changes do not change this version.</p><DocumentDetails document={state.document} /><button className="text-button" disabled={busy} onClick={() => setDeleting(state.document)}>Remove session resume</button></> : <p>{state.session?.status === 'needs_reselection' ? 'Resume deleted or bytes unavailable. Select the PDF again; nothing else will be substituted.' : state.session ? `Local document session ${state.session.status}. Temporary session bytes were released.` : 'No document recovery copy. Start has not been pressed.'}</p>}</div>
      {surface === 'session' && state.session && !terminal && <div className="actions"><button className="secondary" disabled={busy} onClick={() => void run(() => end('cancelled'))}>Cancel local session</button><button className="secondary" disabled={busy} onClick={() => void run(() => end('finished'))}>Finish local session</button></div>}
      {!terminal && <>
        <label className="file-label">{draft || state.document ? 'Replace PDF selection' : 'Choose resume PDF'}<input type="file" accept=".pdf,application/pdf" disabled={busy} onChange={(event) => {
          const files = Array.from(event.target.files ?? []); event.target.value = ''; if (!files.length) return;
          clearDraft();
          const selectedGeneration = ++generation.current;
          void run(async () => {
            const selected = await selectPdf(files);
            if (selectedGeneration !== generation.current) return;
            setDraft({ selection: { source: 'replacement', file: selected.file }, filename: selected.file.name, size: selected.file.size, digest: selected.digest, inputVersion: crypto.randomUUID() }); setReuse(false);
            setNotice('Selected in this persistent view only. No recovery copy or reusable save was created. Keep this view open until Start or an explicit save.');
          });
        }} /></label>
        {draft && <div data-testid="pending-resume"><h3>{draft.selection.source === 'saved' ? 'Pending saved-default selection' : 'Pending per-session replacement'}</h3><DocumentDetails document={draft} /><p>The pending version is a preview. Start or replacement creates a new immutable session input version.</p><button className="text-button" disabled={busy} onClick={clearDraft}>Remove pending selection</button></div>}
        <p>Before Start: a temporary local recovery copy will be bound to this session for at most seven days after your last explicit session activity. Viewing it does not extend retention. Cancellation, finish and expiry remove unsaved copies. Expired data is ineligible immediately; a closed browser purges bytes when next opened. Local storage is not encrypted by applyr.</p>
        <label className="reuse-choice"><input type="checkbox" checked={reuse} disabled={busy || !draft || draft.selection.source === 'saved'} onChange={(e) => setReuse(e.target.checked)} /> Save as reusable resume (optional; retained until you remove or replace the saved default)</label>
        {surface === 'options' ? <button disabled={busy || !draft || draft.selection.source !== 'replacement' || !reuse} onClick={() => void run(async () => {
          if (draft?.selection.source !== 'replacement') return;
          await (await store()).saveDefault(draft.selection.file, state.saved?.id ?? null); clearDraft(); await reload(); notifyDocumentChange(); setNotice('Reusable default explicitly saved. Started sessions retain their bound document version.');
        })}>Save selected resume as default</button> : <button disabled={busy || !draft || !sessionId || currentSessionId.current !== sessionId} onClick={() => void run(async () => {
          if (!draft || !sessionId) return;
          await (await store()).start(sessionId, draft.selection, state.session?.version ?? null, reuse ? { expectedId: state.saved?.id ?? null } : undefined);
          clearDraft(); await onMutation(); await reload(); notifyDocumentChange(); setNotice('Resume bound to this local session. Reinspect fields before including it with Start Autofill. This action has not uploaded it.');
        })}>{state.session ? 'Replace session resume' : 'Start local document session'}</button>}
        <p className="muted">This starts local input recovery only. To send this resume, inspect fields, explicitly include it and use Start Autofill. The website may begin uploading before submission.</p>
      </>}
      {terminal && <p>For another run, explicitly capture a new setup checkpoint from the intended source tab.</p>}
      <button className="text-button" disabled={busy} onClick={() => void run(async () => { await reload(); setNotice('Document state reloaded. Your pending selection stays in this view.'); })}>Reload document state</button>
      {deleting && <div className="delete-document"><p>Delete these local bytes and invalidate every saved/session reference sharing them? A running session will require reselection. This cannot recall a file already received elsewhere.</p><button disabled={busy} onClick={() => void run(async () => {
        await (await store()).deleteDocument(deleting.id, deleting.inputVersion); clearDraft(); await reload(); notifyDocumentChange(true); await onMutation(); setNotice('Document bytes and references deleted. Reselect a PDF if the session needs one.');
      })}>Confirm delete document and shared references</button><button className="text-button" disabled={busy} onClick={() => setDeleting(null)}>Keep document</button></div>}
    </>}
  </section>;
}
