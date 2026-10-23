import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { branding } from '../branding';
import type { SessionCheckpoint } from '../domain/session';
import { openOptions, openSessionSurface, openSessionTab, surfaceCapability } from '../browser/surfaces';
import { readCheckpoint, sendIntent } from '../runtime/client';
import { ProfileSummary, ProfileWorkspace } from './ProfileWorkspace';

export type Surface = 'popup' | 'session' | 'options';
type SourceTab = { id: number; windowId: number };

export function App({ surface }: { surface: Surface }) {
  const [checkpoint, setCheckpoint] = useState<SessionCheckpoint | null>(null);
  const [sourceTab, setSourceTab] = useState<SourceTab | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const capability = surfaceCapability();

  useEffect(() => {
    let alive = true;
    async function initialize() {
      // Begin capture immediately, before opening or focusing any other extension surface.
      const tabPromise = surface === 'popup' ? browser.tabs.query({ active: true, currentWindow: true }) : Promise.resolve([]);
      try {
        const [tabs, saved] = await Promise.all([tabPromise, readCheckpoint()]);
        const tab = tabs[0];
        const candidate = tab?.id !== undefined && !tab.url?.startsWith(browser.runtime.getURL('/'))
          ? { id: tab.id, windowId: tab.windowId } : null;
        if (!alive) return;
        setSourceTab(candidate);
        if (!saved && candidate) {
          const captured = await sendIntent({ type: 'CAPTURE_TARGET', tabId: candidate.id, sessionId: null, revision: null });
          if (alive) setCheckpoint(captured);
        } else setCheckpoint(saved);
      } catch (reason) { if (alive) setError(message(reason)); }
      finally { if (alive) setLoading(false); }
    }
    void initialize();
    const refreshOnFocus = () => {
      void readCheckpoint().then((saved) => { if (alive) setCheckpoint(saved); })
        .catch((reason: unknown) => { if (alive) setError(message(reason)); });
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => { alive = false; window.removeEventListener('focus', refreshOnFocus); };
  }, [surface]);

  async function perform(action: () => Promise<unknown>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  return (
    <main className={`shell ${surface}`}>
      <header>
        <span className="brand-mark" aria-hidden="true">a</span>
        <div><p className="brand">{branding.name}<span className="stage">local preview</span></p><p className="tagline">{branding.tagline}</p></div>
      </header>
      <div className="eyebrow">{surface === 'popup' ? 'QUICK OPEN' : surface === 'options' ? 'SETTINGS & PRIVACY' : 'YOUR SESSION'}</div>
      <h1>{surface === 'options' ? 'A local place to start.' : branding.copy.setup}</h1>
      <p className="intro">{branding.copy.foundation}</p>

      {loading && <p role="status">Opening local checkpoint…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      {!loading && <>
        <section className="card" aria-labelledby="checkpoint-heading">
          <div className="section-heading"><h2 id="checkpoint-heading">{checkpoint ? 'Saved setup checkpoint' : 'No saved checkpoint'}</h2><span className="pill">{checkpoint ? 'Setup needed' : 'Empty'}</span></div>
          {checkpoint ? <>
            <p className="target" data-testid="target-origin">{checkpoint.target.origin ?? (checkpoint.target.availability === 'restricted' ? 'Browser or unsupported page' : 'Site address unavailable')}</p>
            <p data-testid="target-tab">Source tab #{checkpoint.target.tabId}</p>
            <p className="muted">{checkpoint.target.availability === 'https'
              ? 'Only the HTTPS origin is saved. Page inspection has not started.'
              : 'Open applyr from an HTTPS application page when page access is implemented.'}</p>
            <dl className="details">
              <div><dt>Checkpoint</dt><dd data-testid="checkpoint-id">{checkpoint.id}</dd></div>
              <div><dt>Saved</dt><dd>{new Date(checkpoint.updatedAt).toLocaleString()}</dd></div>
              <div><dt>Expires</dt><dd>{new Date(checkpoint.expiresAt).toLocaleString()}</dd></div>
            </dl>
            <p className="muted">A saved tab reference is not permission to act. Tab IDs must be rebound after a browser restart.</p>
          </> : <p>Open the toolbar popup on your intended application tab to save a source reference. No profile has been added.</p>}
        </section>

        <section className="card" aria-labelledby="readiness-heading">
          <h2 id="readiness-heading">Ready when you are</h2>
          <ul className="readiness">
            <li><span>Candidate profile</span><ProfileSummary /></li>
            <li><span>Resume</span><strong>Not added</strong></li>
            <li><span>AI assistance</span><strong>Not configured</strong></li>
            <li><span>Session surface</span><strong>{capability}</strong></li>
          </ul>
          <p className="muted">{capability === 'Packaged tab' ? 'A packaged tab is available in this browser.' : 'If the browser declines to open its panel, applyr opens a packaged tab.'}</p>
        </section>

        <div className="actions">
          {surface === 'popup' && <>
            <button disabled={busy || !checkpoint} onClick={() => {
              // Invoke immediately on the click; the source is already captured and persisted.
              if (checkpoint) void perform(async () => setNotice(await openSessionSurface(checkpoint.target.windowId)));
            }}>Open session</button>
            {sourceTab && <button className="secondary" disabled={busy || sourceTab.id === checkpoint?.target.tabId} onClick={() => void perform(async () => {
              setCheckpoint(await sendIntent({ type: 'CAPTURE_TARGET', tabId: sourceTab.id, sessionId: checkpoint?.id ?? null, revision: checkpoint?.revision ?? null }));
              setNotice('Source tab captured. Open the session when ready.');
            })}>Use this tab</button>}
          </>}
          {surface !== 'session' && <button className="secondary" disabled={busy} onClick={() => void perform(async () => { await openSessionTab(); })}>Open in tab</button>}
          <button className="secondary" disabled={busy} onClick={() => void perform(async () => { setCheckpoint(await readCheckpoint()); setNotice('Checkpoint refreshed.'); })}>Refresh checkpoint</button>
          {surface !== 'options' && <button className="text-button" onClick={() => void perform(openOptions)}>Settings & privacy</button>}
        </div>

        {surface !== 'popup' && <ProfileWorkspace key={checkpoint?.id ?? 'no-session'} surface={surface} sessionId={checkpoint?.id ?? null} onFreeze={async () => { setCheckpoint(await readCheckpoint()); }} />}

        {surface === 'options' && <section className="card" aria-labelledby="storage-heading">
          <h2 id="storage-heading">Local recovery & permissions</h2>
          <p>{branding.copy.privacy}</p>
          <p>No optional site-origin or notification permission has been requested by this shell. Optional eligibility is declared for future explicit user requests.</p>
          <p>Saved profiles stay in extension-origin IndexedDB until explicitly deleted. Session-only profile copies expire after seven days. Documents and providers are not configured yet.</p>
          <button className="secondary" disabled={busy || !checkpoint} onClick={() => void perform(async () => {
            if (checkpoint) setCheckpoint(await sendIntent({ type: 'FORGET_CHECKPOINT', sessionId: checkpoint.id, revision: checkpoint.revision }));
            setNotice('Setup checkpoint removed from this browser.');
          })}>Forget setup checkpoint</button>
        </section>}
      </>}
      <footer><p>{branding.copy.manual}</p><p>Local only · No analytics · No form actions</p></footer>
    </main>
  );
}

function message(reason: unknown) { return reason instanceof Error ? reason.message : 'The extension could not open local state. Refresh to try again.'; }
