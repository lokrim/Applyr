import { reviewSummary } from '../review';
import type { SessionCheckpoint } from '../domain/session';
import { sendRequest } from '../runtime/client';
import { useState } from 'react';

export function AutofillResults({ checkpoint }: { checkpoint: SessionCheckpoint }) {
  const [notice, setNotice] = useState('');
  const state = checkpoint.autofill;
  if (!state) return null;
  const summary = reviewSummary(checkpoint);
  const results = state.operations.map((o) => o.result);
  return <section aria-label="Autofill results" data-testid="autofill-results">
    <h3>{summary.ready ? checkpoint.reviewScope === 'final_review' ? 'Autofill finished — review and submit on the website' : 'Current step ready for review' : 'Review required — unresolved or unverified items'}</h3>
    <p data-testid="review-counts">{summary.accepted} accepted fills · {summary.manual} manually completed / existing values · {summary.drafts} accepted approved drafts · {summary.required} unresolved required questions · {summary.uncertain} uncertain mappings / draft reviews · {summary.uploads} failed or unverified uploads</p>
    <p>Autofill status: {state.status}. These are observations for inspected controls, not proof of a complete application. Use the website’s Next and submit controls yourself.</p>
    <p>{checkpoint.review ? checkpoint.review.items.filter((i) => i.status === 'rejected').length : results.filter((r) => r?.status === 'rejected').length} rejected fields · {checkpoint.review ? checkpoint.review.items.filter((i) => i.status === 'unverified').length : results.filter((r) => !r || r.status === 'unverified').length} unverified fields · {results.filter((r) => r?.status === 'skipped_user_change').length} user changes preserved · {results.filter((r) => r?.status === 'unsupported').length} unsupported operations</p>
    {state.status === 'review' && <p>{state.requiredUnresolved} required controls unresolved · {state.unsupported} unsupported areas. Review the current step on the website. You control Next and final submission.</p>}
    {state.status === 'running' && <><p>An operation may be in progress or interrupted. Reloading never retries it. Reinspect the form before any further action.</p><button onClick={() => void sendRequest({ type: 'CANCEL_AUTOFILL', sessionId: checkpoint.id, revision: checkpoint.revision, runId: state.id }).catch(() => setNotice('Cancellation could not be confirmed. Refresh saved progress before proceeding.'))}>Cancel autofill</button></>}
    {notice && <p role="alert">{notice}</p>}
    {state.status === 'cancelled' && <p>Further writes stopped. Existing page values and uploads are not rolled back. Start a separate session for another run.</p>}
    {state.status === 'paused' && <p>Paused. Resume and reinspect before starting further writes.</p>}
    {state.status === 'interrupted' && <p>Autofill stopped for review. Reinspect the page; unknown operations are never blindly retried.</p>}
    {!!checkpoint.review?.items.length && <ul aria-label="Field review list">{checkpoint.review.items.map((row) => <li key={`${row.target.frameId}:${row.fieldId}`}><strong>{row.label}</strong> · {row.status} {row.approvedDraft ? '· approved draft' : ''} {row.upload ? '· site acceptance unverified' : ''}<button className="text-button" disabled={checkpoint.lifecycle === 'RUNNING' || ['CANCELLED', 'AUTOFILL_FINISHED', 'FAILED'].includes(checkpoint.lifecycle)} onClick={() => void sendRequest({ type: 'SHOW_REVIEW', sessionId: checkpoint.id, revision: checkpoint.revision, fieldId: row.fieldId }).catch(() => setNotice('Field changed or unavailable. Return to the application and reinspect.'))}>Show reviewed field</button></li>)}</ul>}
    <details><summary>Operation log — observations at execution time</summary><ul>{state.operations.map((o) => <li key={o.id}>{o.kind} · {o.result?.status.replaceAll('_', ' ') ?? 'unknown effect — inspect before proceeding'} · {o.result?.code.replaceAll('_', ' ')}{o.kind === 'upload' && <span> · Selected bytes: {o.result?.selectedBytes === true ? 'verified equal' : 'not verified'} · Site acceptance: {o.result?.siteAcceptance ?? 'unverified'}. Manual review/upload may be needed.</span>}</li>)}</ul></details>
    <p>Submission status: {checkpoint.submission.status === 'reported_by_user' ? 'reported by you' : 'unknown'}. applyr never advances or submits the form.</p>
  </section>;
}
