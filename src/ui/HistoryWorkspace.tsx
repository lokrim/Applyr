import { useEffect, useState } from 'react';
import type { SessionCheckpoint } from '../domain/session';
import { terminal } from '../domain/session';
import { HistoryStore, type HistoryEntry } from '../storage/history';
import { CheckpointStore } from '../storage/checkpoints';
import { getDatabase } from '../storage/database';
import { sendIntent, readCheckpoint } from '../runtime/client';
import { downloadText } from '../browser/export';

export function HistoryWorkspace({ onChange }: { onChange: (cp: SessionCheckpoint | null) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]), [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  async function refresh() { setEntries(await new HistoryStore(await getDatabase()).read()); }
  useEffect(() => {
    let alive = true;
    const refreshView = () => { void getDatabase().then((db) => new HistoryStore(db).read()).then((h) => { if (alive) setEntries(h); }).catch(() => { if (alive) setError('History unavailable. Refresh to retry.'); }); };
    refreshView(); const c = new BroadcastChannel('applyr-target'); c.onmessage = refreshView;
    window.addEventListener('focus', refreshView);
    return () => { alive = false; c.close(); window.removeEventListener('focus', refreshView); };
  }, []);
  async function run(work: () => Promise<void>) { try { setError(''); await work(); } catch { setError('History action unavailable. The saved recovery may have expired. Refresh and select fresh inputs.'); } }
  return <section id="history" className="card" aria-labelledby="history-heading">
    <h2 id="history-heading">Local application history</h2>
    <p>Minimal metadata, separate from seven-day recovery. Terminal entries remain for 30 days; expired incomplete entries remain for 30 days after expiry. Submission stays unknown until you report it.</p>
    <div className="actions"><button onClick={() => void run(async () => { downloadText(await new HistoryStore(await getDatabase()).export(), 'applyr-history.json'); })}>Export history JSON</button><button className="secondary" onClick={() => void run(async () => { downloadText(await new HistoryStore(await getDatabase()).diagnostics(), 'applyr-diagnostics.json'); })}>Export redacted diagnostics</button><button className="text-button" onClick={() => void run(refresh)}>Refresh history</button></div>
    <p>History export contains job metadata, input version IDs, provider/model and fixed status categories. It excludes keys, answers, field preconditions and file bytes. Downloads are plaintext; profile Markdown is exported separately under <a href="#profiles">Candidate profile</a>.</p>
    {!entries.length && <p>No local application history.</p>}
    <ul>{entries.map((h) => <li key={h.id}>
      <strong>{h.role ?? 'Unknown role'} · {h.company ?? 'Unknown company'}</strong> · {h.state.toLowerCase().replaceAll('_', ' ')}
      <button className="text-button" onClick={() => setSelected(selected === h.id ? null : h.id)}>View history details</button>
      {selected === h.id && <div><p className="target">{h.url ?? 'No canonical job URL'}</p><p>Created {new Date(h.createdAt).toLocaleString()} · Updated {new Date(h.updatedAt).toLocaleString()}</p><p>Submission: {h.submission.status === 'unknown' ? 'unknown' : `reported by user at ${new Date(h.submission.reportedAt!).toLocaleString()} (source: user); not independently confirmed`}.</p><p>Profile versions: {h.profileVersions.join(', ') || 'None'} · Document versions: {h.documentVersions.join(', ') || 'None'}</p><p>AI: {h.providers.map((p) => `${p.provider} / ${p.model}`).join(', ') || 'No recorded provider use'}</p><p>Blockers: {h.blockers.join(', ') || 'None recorded'} · Errors: {h.errors.join(', ') || 'None recorded'}</p><button onClick={() => void run(async () => {
        const cp = await readCheckpoint();
        if (cp?.id === h.id) { onChange(cp); return; }
        const old = (await new CheckpointStore(await getDatabase()).archived()).find((s) => s.id === h.id);
        if (!old || terminal(old)) throw new Error('NO_RECOVERY');
        onChange(await sendIntent({ type: 'RESTORE_SESSION', sessionId: cp?.id ?? null, revision: cp?.revision ?? null, archivedId: h.id }));
      })}>View or resume saved recovery</button><p>Resume selects a retained session. Match its tab, reselect released inputs and reinspect before Start. Expired or terminal history has no resumable execution.</p></div>}
    </li>)}</ul>{error && <p role="alert">{error}</p>}
  </section>;
}

export function DuplicateChoices({ entries, onSeparate, onView, onDismiss }: { entries: HistoryEntry[]; onSeparate: () => void; onView: (cp: SessionCheckpoint) => void; onDismiss: () => void }) {
  const [view, setView] = useState(false), [error, setError] = useState('');
  const latest = entries[0];
  if (!latest) return null;
  return <div role="region" aria-label="Duplicate application" className="duplicate-notice">
    <h3>This application already has local history</h3><p>{latest.role ?? latest.url} · {entries.length} saved run(s). A second run requires your deliberate choice.</p>
    <button onClick={() => setView(!view)}>View existing application</button>
    {view && <ul>{entries.map((h) => <li key={h.id}>{h.state} · {new Date(h.createdAt).toLocaleString()} · Submission: {h.submission.status === 'unknown' ? 'unknown' : 'reported by user'}<p className="target">{h.url}</p></li>)}</ul>}
    <button onClick={() => void (async () => {
      try {
        const cp = await readCheckpoint();
        if (cp?.id === latest.id && !terminal(cp)) { onView(cp); onDismiss(); return; }
        const old = (await new CheckpointStore(await getDatabase()).archived()).find((s) => s.id === latest.id && !terminal(s));
        if (!old) { setError('No retained recovery for this run. View its history or explicitly start a separate run with fresh inputs.'); return; }
        const restored = await sendIntent({ type: 'RESTORE_SESSION', sessionId: cp?.id ?? null, revision: cp?.revision ?? null, archivedId: old.id });
        if (restored) onView(restored); onDismiss();
      } catch { setError('Recovery changed. Refresh before choosing it again.'); }
    })()}>Resume existing session</button>
    <button onClick={onSeparate}>Start explicit separate run</button><button className="text-button" onClick={onDismiss}>Keep existing run</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
