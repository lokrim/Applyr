import { useState } from 'react';
import { browser } from 'wxt/browser';
import type { SessionCheckpoint } from '../domain/session';
import { parseApplicationUrl } from '../browser/addresses';
import { requestPageOrigin } from '../browser/page-permissions';
import { sendIntent } from '../runtime/client';
import { FormInspection } from './FormInspection';

const guidance = {
  unprobed: 'Inspect this bound page to detect an application. No fields will be filled.',
  application: 'Application form detected. Use Inspect fields to review a scoped snapshot. Autofill is not available yet.',
  listing: 'Careers listing detected. Open the specific job application, then invoke applyr there.',
  login_challenge: 'Complete login or the security challenge on the website, then reinspect. applyr never reads passwords or one-time codes.',
  irrelevant: 'This does not appear to be a job application. Open an application URL or invoke applyr on the intended form.',
  uncertain: 'Application status is uncertain. Open the actual application or complete it manually.',
  restricted: 'This browser, store, PDF or unsupported page cannot be inspected. Settings and local inputs remain available.',
  permission: 'Page access is absent, denied or revoked. Grant the displayed site or invoke applyr on that application tab, then reinspect.',
  frame_permission: 'The application may be embedded. Additional access is needed only for the displayed application frame; unrelated frames will not be inspected.',
  frame_unavailable: 'The embedded application could not be inspected. The browser may block it or another frame. Open the embedded application directly and invoke applyr there.',
  closed: 'The bound application tab closed. Use Open application deliberately to reopen it as a new session.',
  navigation: 'The bound tab navigated or changed jobs. Invoke applyr on the new job and choose Use this tab to start a separate session. Previous inputs and approvals are not transferred.',
  reload: 'The application reloaded. Reinspect before continuing; previous page observations are invalid.',
  restart: 'The browser restarted or this older checkpoint has no page identity. Invoke applyr on the intended page and choose Use this tab. Tab IDs must be rebound after a browser restart.',
} as const;

export function TargetWorkspace({ checkpoint, onChange }: { checkpoint: SessionCheckpoint | null; onChange: (value: SessionCheckpoint | null) => void }) {
  const [url, setUrl] = useState('');
  const [role, setRole] = useState(checkpoint?.target.role ?? '');
  const [company, setCompany] = useState(checkpoint?.target.company ?? '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const binding = { sessionId: checkpoint?.id ?? null, revision: checkpoint?.revision ?? null };
  const blocked = ['closed', 'navigation', 'restart'].includes(checkpoint?.access?.reason ?? '');

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Page access failed. Invoke applyr on the application.'); }
    finally { setBusy(false); }
  }
  async function inspect(frameOrigin?: string, frameIdentity?: string) {
    if (checkpoint) onChange(await sendIntent({ type: 'PROBE_TARGET', sessionId: checkpoint.id, revision: checkpoint.revision, ...(frameOrigin ? { frameOrigin, frameIdentity } : {}) }));
  }

  return <section className="card target-workspace" aria-labelledby="page-heading">
    <div className="section-heading"><h2 id="page-heading">Application page</h2><span className="pill" aria-live="polite" data-testid="page-status">{checkpoint?.access?.status === 'needs_attention' ? 'Needs attention' : checkpoint?.access?.status === 'ready' ? 'Page access ready' : 'Not inspected'}</span></div>
    {checkpoint && <>
      <p className="target" data-testid="target-url">{checkpoint.target.url ?? 'URL unknown or restricted'}</p>
      <p data-testid="target-title">{checkpoint.target.title ?? 'Title unknown'}</p>
      <p>Role: <strong data-testid="target-role">{checkpoint.target.role ?? 'Unknown'}</strong> · Company: <strong data-testid="target-company">{checkpoint.target.company ?? 'Unknown'}</strong></p>
      <p data-testid="page-guidance">{guidance[checkpoint.access?.reason ?? 'unprobed']}</p>
      <p className="muted">Page classification: <strong data-testid="page-classification">{checkpoint.access?.classification ?? 'uncertain'}</strong>. Display edits do not change the application binding.</p>
      {editing ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
        onChange(await sendIntent({ type: 'EDIT_TARGET', sessionId: checkpoint.id, revision: checkpoint.revision, role, company })); setEditing(false);
      }); }}>
        <label>Display role<input maxLength={180} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Unknown" /></label>
        <label>Display company<input maxLength={180} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Unknown" /></label>
        <button disabled={busy}>Save display metadata</button>
      </form> : <button className="text-button" onClick={() => { setRole(checkpoint.target.role ?? ''); setCompany(checkpoint.target.company ?? ''); setEditing(true); }}>Edit display metadata</button>}
      <div className="actions">
        <button disabled={busy || blocked || !checkpoint.target.origin} onClick={() => void run(() => inspect())}>Inspect bound page</button>
        {checkpoint.target.origin && !blocked && checkpoint.access?.reason === 'permission' && <button className="secondary" disabled={busy} onClick={() => {
          const request = requestPageOrigin(checkpoint.target.origin!);
          void run(async () => { if (await request) await inspect(); else setNotice('Permission denied. Invoke applyr on the application itself or complete it manually.'); });
        }}>Grant {checkpoint.target.origin}</button>}
        <button className="secondary" disabled={busy || checkpoint.access?.reason === 'closed' || checkpoint.access?.reason === 'restart'} onClick={() => void run(async () => {
          await browser.tabs.update(checkpoint.target.tabId, { active: true }); await browser.windows.update(checkpoint.target.windowId, { focused: true });
        })}>Return to application</button>
      </div>
      {checkpoint.access?.frames.map((frame) => <div className="frame-access" key={frame.identity}>
        <p>Embedded application: {frame.origin}. {frame.origin === checkpoint.target.origin ? 'This frame shares the bound page’s origin.' : 'Read-only inspection needs this exact additional origin.'}</p>
        <p className="target" id={`frame-${frame.identity}`}>{frame.url}</p>
        <button aria-describedby={`frame-${frame.identity}`} disabled={busy || blocked} onClick={() => {
          if (frame.origin === checkpoint.target.origin) { void run(() => inspect(frame.origin, frame.identity)); return; }
          const request = requestPageOrigin(frame.origin);
          void run(async () => { if (await request) await inspect(frame.origin, frame.identity); else setNotice(`Access to ${frame.origin} was denied. Open the embedded application directly or continue manually.`); });
        }}>Inspect frame at {frame.origin}</button>
        <button className="secondary" disabled={busy} onClick={() => setUrl(frame.url)}>Use embedded URL</button>
      </div>)}
      <FormInspection key={`${checkpoint.id}:${checkpoint.revision}`} checkpoint={checkpoint} />
    </>}
    <form onSubmit={(event) => {
      event.preventDefault();
      let address: URL;
      try { address = parseApplicationUrl(url, import.meta.env.DEV); } catch (reason) { setError((reason as Error).message); return; }
      // Start the browser permission request in this gesture, before any await.
      const permission = requestPageOrigin(address.origin).catch(() => false);
      void run(async () => {
        const granted = await permission;
        const opened = await sendIntent({ type: 'OPEN_APPLICATION', ...binding, url: address.href });
        onChange(opened);
        setNotice(granted ? 'Opened a new bound tab. Inspect after it loads. No previous session inputs were transferred.' : 'Opened a new application tab. Access was not granted; invoke applyr there and choose Use this tab. No access was transferred.');
      });
    }}>
      <label htmlFor="application-url">Manual application URL</label>
      <input id="application-url" type="url" required maxLength={4096} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://company.example/jobs/123" />
      <p className="muted">Open application requests only the entered site and opens a new tab. This starts a separate binding and releases previous temporary session inputs. Saved defaults remain available by explicit selection.</p>
      <button disabled={busy}>Open application</button>
    </form>
    {notice && <p role="status">{notice}</p>}{error && <p className="error" role="alert">{error}</p>}
  </section>;
}
