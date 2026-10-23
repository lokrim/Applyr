import type { SessionCheckpoint } from '../domain/session';
import { sendRequest } from '../runtime/client';
import { useState } from 'react';

export function AutofillResults({ checkpoint }: { checkpoint: SessionCheckpoint }) {
  const [notice, setNotice] = useState('');
  const state = checkpoint.autofill;
  if (!state) return null;
  const results = state.operations.map((o) => o.result);
  return <section aria-label="Autofill results" data-testid="autofill-results">
    <h3>Current-step autofill: {state.status}</h3>
    <p>{results.filter((r) => r?.status === 'accepted').length} accepted · {results.filter((r) => r?.status === 'rejected').length} rejected · {results.filter((r) => !r || r.status === 'unverified').length} unverified · {results.filter((r) => r?.status === 'skipped_user_change').length} user changes preserved · {results.filter((r) => r?.status === 'unsupported').length} unsupported operations</p>
    {state.status === 'review' && <p>{state.requiredUnresolved} required controls unresolved · {state.unsupported} unsupported areas. Review the current step on the website. You control Next and final submission.</p>}
    {state.status === 'running' && <><p>An operation may be in progress or interrupted. Reloading never retries it. Reinspect the form before any further action.</p><button onClick={() => void sendRequest({ type: 'CANCEL_AUTOFILL', sessionId: checkpoint.id, revision: checkpoint.revision, runId: state.id }).catch(() => setNotice('Cancellation could not be confirmed. Refresh saved progress before proceeding.'))}>Cancel autofill</button></>}
    {notice && <p role="alert">{notice}</p>}
    {state.status === 'cancelled' && <p>Further writes stopped. Existing page values and uploads are not rolled back. Start a separate session for another run.</p>}
    {state.status === 'interrupted' && <p>Autofill stopped for review. Reinspect the page; unknown operations are never blindly retried.</p>}
    <ul>{state.operations.map((o) => <li key={o.id}>{o.kind} · {o.result?.status.replaceAll('_', ' ') ?? 'unknown effect — inspect before proceeding'} · {o.result?.code.replaceAll('_', ' ')}{o.kind === 'upload' && <span> · Selected bytes: {o.result?.selectedBytes === true ? 'verified equal' : 'not verified'} · Site acceptance: {o.result?.siteAcceptance ?? 'unverified'}. Manual review/upload may be needed.</span>}</li>)}</ul>
    <p>Submission status: unknown. applyr never advances or submits the form.</p>
  </section>;
}
