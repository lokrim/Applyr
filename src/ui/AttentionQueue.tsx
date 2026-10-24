import { useState } from 'react';
import type { SessionCheckpoint } from '../domain/session';
import { terminal } from '../domain/session';
import { pending } from '../attention/queue';
import type { AttentionItem } from '../attention/schema';
import { readCheckpoint, sendRequest } from '../runtime/client';
import { ProfileStore, type SavedProfile } from '../storage/profiles';
import { getDatabase } from '../storage/database';
import { updatedProfile } from '../mapping/rules';
import { exportProfile } from '../profile/markdown';
import type { ProfileDocument } from '../profile/schema';
import { notifyProfileChange } from '../browser/profile-events';

export function AttentionQueue({ checkpoint: cp, onChange }: { checkpoint: SessionCheckpoint; onChange: (cp: SessionCheckpoint | null) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [update, setUpdate] = useState<{ base: SavedProfile | null; document: ProfileDocument; path: string } | null>(null), [reviewed, setReviewed] = useState(false);
  const items = cp.attention?.items.filter(pending) ?? [];
  const ended = terminal(cp), disabled = busy || ended || cp.lifecycle === 'RUNNING';
  async function run(task: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : 'Reinspect the application before retrying.'); } finally { setBusy(false); }
  }
  async function binding() { const latest = await readCheckpoint(); if (latest?.id !== cp.id) throw new Error('The selected session changed.'); return { sessionId: cp.id, revision: latest.revision }; }
  async function act(type: 'REINSPECT_ATTENTION' | 'SHOW_ATTENTION', itemId?: string) {
    await run(async () => {
      const result = await sendRequest({ type, ...await binding(), ...(itemId ? { itemId } : {}) }); onChange(result.checkpoint);
      setNotice(type === 'SHOW_ATTENTION' ? itemId ? 'Field marked on the original page. Keyboard focus stays under your control.' : 'Returned to the original form.' : 'Fresh observations saved. Any remaining blockers still need your action.');
    });
  }
  const selected = items.filter((i) => i.correctable && answers[i.id]?.trim());
  function value(item: AttentionItem) { const text = answers[item.id]!; return item.inputKind === 'boolean' ? text === 'true' : item.inputKind === 'number' ? Number(text) : text; }
  return <section className="card attention-queue" aria-labelledby="attention-heading">
    <h2 id="attention-heading">Attention queue</h2>
    <p role="status" aria-live="polite" aria-atomic="true">{ended ? 'Session ended. Saved observations are read-only.' : `${items.length} items need action. ${items.filter((i) => i.status === 'answer_ready').length} have a reviewed session answer awaiting website verification.`}</p>
    <p>Answers apply only to this application. Login, codes, CAPTCHA, sensitive questions and declarations belong on the original page. Detection is best effort; handle unknown challenges manually. Reinspection checks the page; a checkbox here cannot resolve a website control.</p>
    <div className="actions"><button disabled={disabled || cp.recovery?.reattachRequired} onClick={() => void act('SHOW_ATTENTION')}>Return to form</button><button disabled={disabled || cp.recovery?.reattachRequired} onClick={() => void act('REINSPECT_ATTENTION')}>Reinspect attention items</button></div>
    {!items.length && <p>Inspect fields to discover missing answers and unsupported areas. No queued items is not proof of application completion.</p>}
    <form onSubmit={(e) => { e.preventDefault(); void run(async () => {
      const frames = [...new Set(selected.map((i) => i.target!.frameId))];
      for (const frameId of frames) {
        const result = await sendRequest({ type: 'ATTENTION_ANSWERS', ...await binding(), answers: selected.filter((i) => i.target!.frameId === frameId).map((i) => ({ itemId: i.id, itemRevision: i.revision, value: value(i), eligibilityConfirmed: confirmed[i.id] === true })) });
        onChange(result.checkpoint);
      } setAnswers({}); setConfirmed({}); setNotice('Batch reviewed and saved for this application. Inspect fields and review Start Autofill before insertion. Website answers remain unverified.');
    }); }}>
      <ol>{items.map((item) => <li key={item.id} className="inspected-field" data-testid="attention-item">
        <h3>{item.question}</h3><p>{item.required ? 'Required or blocking area' : 'Review item'} · {item.code} · {item.status === 'answer_ready' ? 'Answer reviewed; website verification pending' : 'Needs action'}</p>
        <p id={`reason-${item.id}`}>{item.reason}</p><p>{item.action}</p>
        {item.correctable && !ended && <fieldset disabled={disabled}><legend>Answer for {item.question}</legend>
          <label htmlFor={`answer-${item.id}`}>Session answer — {item.question}</label>
          {item.inputKind === 'boolean' ? <select id={`answer-${item.id}`} aria-describedby={`reason-${item.id}`} value={answers[item.id] ?? ''} onChange={(e) => { setAnswers({ ...answers, [item.id]: e.target.value }); setConfirmed({ ...confirmed, [item.id]: false }); }}><option value="">Unknown — choose explicitly</option><option value="true">Yes</option><option value="false">No</option></select> : <input id={`answer-${item.id}`} aria-describedby={`reason-${item.id}`} type={item.inputKind === 'number' ? 'number' : 'text'} min={item.inputKind === 'number' ? 0 : undefined} maxLength={2048} value={answers[item.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [item.id]: e.target.value })} />}
          {item.code === 'eligibility' && <label className="check-label"><input type="checkbox" checked={confirmed[item.id] ?? false} onChange={(e) => setConfirmed({ ...confirmed, [item.id]: e.target.checked })} />I explicitly confirm this country-specific answer for this application</label>}
          {item.correction && <p>Reviewed answer: {String(item.correction.value)}. It will be proposed only while page, field and input preconditions still match.</p>}
        </fieldset>}
        <div className="actions">{item.target && <button type="button" className="secondary" disabled={disabled || cp.recovery?.reattachRequired} onClick={() => void act('SHOW_ATTENTION', item.id)}>Show field: {item.question}</button>}
          <button type="button" className="secondary" disabled={disabled || cp.recovery?.reattachRequired} onClick={() => void act('REINSPECT_ATTENTION', item.id)}>Recheck: {item.question}</button>
          {item.correction && item.sourcePath && item.code !== 'eligibility' && <button type="button" className="text-button" disabled={disabled} onClick={() => void run(async () => {
            const state = await new ProfileStore(await getDatabase()).read(), base = state.saved;
            const document = updatedProfile(base?.document ?? { data: { profile_version: 1 }, notes: '', answerBodies: {} }, item.sourcePath!, item.correction!.value);
            if (!document) throw new Error('Review this record in Candidate profile before proposing a reusable update.');
            setUpdate({ base, document, path: item.sourcePath! }); setReviewed(false);
          })}>Propose profile update: {item.question}</button>}
        </div>
      </li>)}</ol>
      {!!items.some((i) => i.correctable) && <button disabled={disabled || !selected.length || selected.some((i) => i.code === 'eligibility' && !confirmed[i.id])}>Use for this application</button>}
    </form>
    <p>Generated drafts have their own batch review under Optional AI assistance after field inspection. Edit, reject or approve them explicitly; an approved draft never updates your saved profile automatically.</p>
    {update && <section className="proposal" aria-label="Reviewed profile update"><h3>Proposed profile update</h3><p>Changed path: {update.path}. This separate save affects future sessions; your frozen application input stays as reviewed.</p>
      <details><summary>Before — saved default</summary><pre>{update.base ? exportProfile(update.base.document) : 'No saved default'}</pre></details><details open><summary>After — proposed default</summary><pre>{exportProfile(update.document)}</pre></details>
      <label className="check-label"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />I reviewed this default-profile diff</label>
      <button disabled={!reviewed || disabled} onClick={() => void run(async () => { await new ProfileStore(await getDatabase()).saveDefault(update.document, update.base?.version ?? null); notifyProfileChange(); setUpdate(null); setNotice('Reviewed profile update saved for future sessions.'); })}>Save reviewed profile update</button><button className="text-button" onClick={() => setUpdate(null)}>Dismiss update</button>
    </section>}
    <p role="status" aria-live="polite">{notice}</p>{error && <p role="alert">{error}</p>}
  </section>;
}
