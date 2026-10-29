import { useState } from 'react';
import type { SessionCheckpoint } from '../domain/session';
import { readCheckpoint, sendIntent } from '../runtime/client';
import type { DeletionScope } from '../storage/data-controls';

export function DataControls({ onChange, onReset }: { onChange: (cp: SessionCheckpoint | null) => void; onReset: () => void }) {
  const [choice, setChoice] = useState<DeletionScope | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const descriptions = {
    profile: 'Delete the saved profile, frozen copies, reviewed corrections, approved draft values and affected recovery values. Stop affected work. Saved documents and minimal history remain.',
    history: 'Delete all history and associated session ledgers, unsaved profile/PDF recovery, review and draft records. Stop ongoing work. Saved default profiles, saved documents and provider keys remain.',
    all: 'Delete every applyr database record, preferences and session/remembered keys. Stop work, reset badges/markers and remove removable optional site/provider/notification permissions. Open working copies will be cleared.',
  };
  return <section id="privacy" className="card" aria-labelledby="privacy-heading"><h2 id="privacy-heading">Privacy & data controls</h2>
    <p>Saved profiles and reusable PDFs remain until removed. Temporary input snapshots, approved drafts and sensitive operation values expire seven days after your last explicit session activity, or on cancel/finish. History lasts 30 days after ending or recovery expiry. Viewing does not renew retention. Closed browsers purge at the next startup/access.</p>
    <p>Local storage is not an encrypted vault. Keys use trusted session storage by default; Remember stores a nonsynced local copy. Browser restart can lose session keys.</p>
    <p>Deleting local data cannot recall values, files or requests already received by a website or provider. For remote removal, use the employer’s contact/privacy controls or the provider’s account/data controls linked in <a href="#providers">AI settings</a>. Exported files stay under your control.</p>
    <div className="actions"><button onClick={() => setChoice('profile')}>Delete profile and recovery copies</button><button onClick={() => setChoice('history')}>Delete history and unsaved recovery</button><button onClick={() => setChoice('all')}>Delete all applyr data</button></div>
    <p>Independent choices: <a href="#documents">Delete a saved or session document</a> · <a href="#providers">Remove a key or revoke AI consent</a> · <a href="#history">Export history or diagnostics</a> · <a href="#profiles">Export profile Markdown</a></p>
    {choice && <div role="group" aria-label="Confirm local deletion"><p>{descriptions[choice]}</p><p>This does not erase information already sent elsewhere.</p><button disabled={busy} onClick={() => void (async () => {
      setBusy(true); setNotice('');
      try { const cp = await readCheckpoint(); onChange(await sendIntent({ type: 'DELETE_DATA', scope: choice, sessionId: cp?.id ?? null, revision: cp?.revision ?? null })); if (choice === 'all') onReset(); setChoice(null); setNotice('Selected local data deleted. Previously transmitted information and downloaded exports remain outside applyr.'); }
      catch { setNotice('Deletion could not be fully confirmed. Refresh local state and retry. Some data or permissions may remain.'); }
      finally { setBusy(false); }
    })()}>Confirm delete {choice === 'all' ? 'all applyr data' : choice === 'profile' ? 'profile and sensitive recovery' : 'history and unsaved recovery'}</button><button className="text-button" disabled={busy} onClick={() => setChoice(null)}>Keep local data</button></div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
