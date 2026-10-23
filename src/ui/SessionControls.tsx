import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { terminal, type SessionCheckpoint } from '../domain/session';
import { readCheckpoint, sendIntent } from '../runtime/client';
import { requestPageOrigin } from '../browser/page-permissions';
import { CheckpointStore } from '../storage/checkpoints';
import { getDatabase } from '../storage/database';

export function SessionControls({ checkpoint: cp, onChange }: { checkpoint: SessionCheckpoint; onChange: (cp: SessionCheckpoint | null) => void }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [tabs, setTabs] = useState<{ id: number; label: string }[]>([]), [tab, setTab] = useState('');
  const [archived, setArchived] = useState<SessionCheckpoint[]>([]);
  useEffect(() => {
    void browser.tabs.query({}).then((all) => setTabs(all.flatMap((t) => t.id !== undefined && t.url?.startsWith(`${cp.target.origin}/`) ? [{ id: t.id, label: t.title ?? `Tab ${t.id}` }] : [])));
    void getDatabase().then((db) => new CheckpointStore(db).archived()).then(setArchived).catch(() => setError('Saved sessions could not be read. Refresh to retry.'));
  }, [cp.id, cp.target.origin, cp.recovery?.reattachRequired]);
  async function run(action: () => Promise<SessionCheckpoint | null>) {
    setBusy(true); setError('');
    try { onChange(await action()); } catch (e) { setError(e instanceof Error ? e.message : 'Refresh saved progress before proceeding.'); }
    finally { setBusy(false); }
  }
  const action = (type: 'PAUSE_SESSION' | 'RESUME_SESSION' | 'CANCEL_SESSION' | 'FINISH_SESSION' | 'REPORT_SUBMISSION' | 'FINAL_REVIEW') => run(async () => { const latest = await readCheckpoint(); if (latest?.id !== cp.id) throw new Error('The selected session changed. Refresh before proceeding.'); return sendIntent({ type, sessionId: cp.id, revision: latest.revision }); });
  return <section aria-label="Session recovery" className="card">
    <h3>Session: {cp.lifecycle.replaceAll('_', ' ').toLowerCase()}</h3>
    <p>Phase: {cp.phase.toLowerCase()} · Review: {cp.reviewScope === 'final_review' ? 'Final review, confirmed by you' : 'Current step only'}</p>
    {cp.recovery && <p>Recovery: {cp.recovery.reason.replaceAll('_', ' ')}. Reinspect before Start. Expired or deleted inputs require reselection. Missing AI keys require Settings, or continue without AI.</p>}
    {cp.aiRequest?.status === 'uncertain' && <p>A provider request was interrupted and may have been billed. It will never be replayed automatically. Requesting AI again is a new explicit request.</p>}
    {cp.pauseRequested && <p role="status">Pause requested. Waiting for the current operation result.</p>}
    {cp.recovery?.reattachRequired && !terminal(cp) && <div>
      <label>Choose a matching application tab<select value={tab} onChange={(e) => setTab(e.target.value)}><option value="">Select a tab</option>{tabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
      <button disabled={busy || !tab || !cp.target.origin} onClick={() => {
        const permission = requestPageOrigin(cp.target.origin!);
        void run(async () => { if (!await permission) throw new Error('Grant access to the matching application, then retry.'); return sendIntent({ type: 'REATTACH_SESSION', sessionId: cp.id, revision: cp.revision, tabId: Number(tab) }); });
      }}>Reattach selected matching tab</button>
      <p>Open the original application yourself if it is absent. Reattachment checks its exact identity and permission; it does not write.</p>
    </div>}
    <div className="actions">
      {!terminal(cp) && cp.lifecycle !== 'PAUSED' && <button disabled={busy || cp.pauseRequested} onClick={() => void action('PAUSE_SESSION')}>Pause session</button>}
      {!terminal(cp) && (cp.lifecycle === 'PAUSED' || cp.recovery?.inspectionRequired) && <button disabled={busy || cp.recovery?.reattachRequired || cp.access?.status !== 'ready'} onClick={() => void action('RESUME_SESSION')}>Resume and reinspect</button>}
      {!terminal(cp) && <button disabled={busy} onClick={() => void action('CANCEL_SESSION')}>Cancel session</button>}
      {cp.lifecycle === 'READY_FOR_REVIEW' && <>
        {cp.reviewScope !== 'final_review' && <button disabled={busy} onClick={() => void action('FINAL_REVIEW')}>I am reviewing the final step</button>}
        <button disabled={busy} onClick={() => void action('FINISH_SESSION')}>Finish autofill session</button>
      </>}
      {cp.submission.status === 'unknown' && <button disabled={busy} onClick={() => void action('REPORT_SUBMISSION')}>I submitted it</button>}
    </div>
    <p>Submission: {cp.submission.status === 'reported_by_user' ? 'reported by you; not independently confirmed' : 'unknown'}. You control Next and submission on the website.</p>
    <p>Pause stops at a safe boundary. Cancel stops future work; already delivered values, uploads and provider requests cannot be recalled.</p>
    {!!archived.length && <details><summary>Other saved sessions</summary>{archived.map((old) => <p key={old.id}>{old.target.role ?? old.target.origin} · {old.lifecycle.toLowerCase()} · {old.autofill?.operations.filter((o) => o.result?.status === 'accepted').length ?? 0} accepted <button disabled={busy || terminal(old)} onClick={() => void run(() => sendIntent({ type: 'RESTORE_SESSION', sessionId: cp.id, revision: cp.revision, archivedId: old.id }))}>Recover saved session</button></p>)}</details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
