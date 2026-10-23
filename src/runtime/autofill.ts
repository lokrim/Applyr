import { transition, terminal, LEASE_MS, type SessionCheckpoint } from '../domain/session';
import { ActionResultSchema, ContentOperationSchema, recoverySignature, type ActionResult, type ContentOperation, type Autofill } from '../forms/operations';
import { createDryRun, previewBinding } from '../mapping/rules';
import type { SessionCorrection, ProposedValue } from '../mapping/schema';
import type { Inspection } from '../forms/schema';
import { safeAiField } from '../ai/context';
import type { Request } from './schemas';
import type { PageAccessService } from './page-access';
import { CheckpointStore, StaleCheckpointError } from '../storage/checkpoints';
import { ProfileStore } from '../storage/profiles';
import { DocumentStore } from '../storage/documents';
import type { ApplyrDatabase } from '../storage/database';
import type { IDBPDatabase } from 'idb';

type Start = Extract<Request, { type: 'START_AUTOFILL' }>;
export class AutofillService {
  readonly owner = crypto.randomUUID();
  private active: { id: string; sessionId: string; cancelled: boolean; command?: ContentOperation } | null = null;
  constructor(private readonly deps: {
    database: () => Promise<IDBPDatabase<ApplyrDatabase>>; access: PageAccessService;
    dispatch: (command: ContentOperation) => Promise<unknown>; changed: () => void;
  }) {}
  private async checkpoint() { return new CheckpointStore(await this.deps.database()).read(); }
  private async save(sessionId: string, runId: string, change: (state: Autofill) => Autofill) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const store = new CheckpointStore(await this.deps.database()), cp = await store.read();
      if (!cp || cp.id !== sessionId || cp.autofill?.id !== runId) throw new StaleCheckpointError();
      const state = change(cp.autofill);
      if (state.operations.length > cp.autofill.operations.length && (cp.lifecycle !== 'RUNNING' || cp.lease?.owner !== this.owner || cp.pauseRequested)) throw new StaleCheckpointError();
      // Results may arrive after pause/cancel; retain them without reviving execution.
      let next = { ...cp, revision: cp.revision + 1, updatedAt: Date.now(), autofill: state };
      if (state.status === 'cancelled' && !terminal(cp)) next = { ...transition(cp, { type: 'CANCEL' }, Date.now()), autofill: { ...state, operations: state.operations.map((op) => ({ ...op, recovery: undefined })) } };
      else if (cp.lifecycle === 'RUNNING' && cp.lease?.owner !== this.owner) throw new StaleCheckpointError();
      else if (!terminal(cp) && state.status === 'review') next = { ...transition(cp, { type: 'REVIEW' }, Date.now()), autofill: state };
      else if (!terminal(cp) && state.status === 'interrupted') next = { ...transition(cp, { type: 'INTERRUPT', reason: 'interrupted' }, Date.now()), autofill: state };
      if (next.lifecycle === 'RUNNING' && state.operations.length > cp.autofill.operations.length) next.phase = 'FILLING';
      if (next.lease) next.lease = { ...next.lease, expiresAt: Date.now() + LEASE_MS };
      try { await store.replace(next, { sessionId, revision: cp.revision }); this.deps.changed(); return next; }
      catch (e) { if (!(e instanceof StaleCheckpointError) || attempt === 3) throw e; }
    }
    throw new StaleCheckpointError();
  }
  private async inspecting(sessionId: string, runId: string, validating: boolean) {
    let cp = await this.boundary(sessionId);
    if (cp.lifecycle !== 'RUNNING' || cp.lease?.owner !== this.owner || cp.lease.token !== runId) throw new Error('ACCESS_UNAVAILABLE');
    const phase = validating ? 'VALIDATING' : 'INSPECTING';
    if (cp.phase !== phase) {
      const store = new CheckpointStore(await this.deps.database());
      cp = (await store.replace(transition(cp, { type: 'PHASE', phase }, Date.now()), { sessionId, revision: cp.revision }))!;
      this.deps.changed();
    }
    return cp;
  }
  private async interrupted(sessionId: string, runId: string) {
    const cp = await this.checkpoint();
    if (cp?.id !== sessionId) return;
    if (cp.pauseRequested) { await this.boundary(sessionId).catch(() => {}); return; }
    if (cp.lifecycle === 'RUNNING') await this.save(sessionId, runId, (s) => ({ ...s, status: 'interrupted' })).catch(() => {});
  }
  private async result(sessionId: string, runId: string, result: ActionResult) {
    await new CheckpointStore(await this.deps.database()).recordResult(sessionId, runId, result); this.deps.changed();
  }
  async pause(sessionId: string, revision: number) {
    // Stopping may observe newer progress in this same session. It grants no
    // write authority and can never stop a different job/session ID.
    const store = new CheckpointStore(await this.deps.database());
    for (let attempt = 0; attempt < 4; attempt++) {
      const cp = await store.read();
      if (!cp || cp.id !== sessionId || revision > cp.revision) throw new StaleCheckpointError();
      let next = transition(cp, { type: 'PAUSE' }, Date.now());
      if (next.pauseRequested && this.active?.sessionId !== sessionId) next = transition(next, { type: 'BOUNDARY' }, Date.now());
      if (next.lifecycle === 'PAUSED' && next.autofill?.status === 'running') next.autofill = { ...next.autofill, status: 'paused' };
      try { await store.replace(next, { sessionId, revision: cp.revision }); this.deps.changed(); return next; }
      catch (error) { if (!(error instanceof StaleCheckpointError) || attempt === 3) throw error; }
    }
    throw new StaleCheckpointError();
  }
  private async boundary(sessionId: string) {
    const store = new CheckpointStore(await this.deps.database()), cp = await store.read();
    if (!cp || cp.id !== sessionId) throw new StaleCheckpointError();
    if (cp.pauseRequested) {
      const next = transition(cp, { type: 'BOUNDARY' }, Date.now());
      if (next.autofill) next.autofill = { ...next.autofill, status: 'paused' };
      await store.replace(next, { sessionId, revision: cp.revision }); this.deps.changed(); throw new Error('PAUSED');
    }
    if (cp.lifecycle === 'PAUSED' || terminal(cp) || cp.recovery?.inspectionRequired || cp.recovery?.reattachRequired) throw new Error('PAUSED');
    return cp;
  }
  async resume(sessionId: string, revision: number) {
    if (this.active) throw new Error('ACCESS_UNAVAILABLE');
    const db = await this.deps.database(), store = new CheckpointStore(db), cp = await store.read();
    if (!cp || cp.id !== sessionId || cp.revision !== revision) throw new StaleCheckpointError();
    if (terminal(cp) || cp.lifecycle === 'RUNNING' || cp.lease || cp.recovery?.reattachRequired || cp.access?.status !== 'ready') throw new Error('ACCESS_UNAVAILABLE');
    const input = (await new ProfileStore(db).read()).snapshot;
    if (!input || input.sessionId !== cp.id) throw new Error('ACCESS_UNAVAILABLE');
    const fresh = (await this.deps.access.inspect({ sessionId, revision })).inspection;
    if (!['stable', 'selection_required'].includes(fresh.snapshot.status)) throw new Error('ACCESS_UNAVAILABLE');
    // Only read current values/selected bytes. Remounted fields stay uncertain.
    const operations = [];
    for (const op of cp.autofill?.operations ?? []) {
      if (op.result && op.result.code !== 'unknown_effect') { operations.push(op); continue; }
      let result: ActionResult = { operationId: op.id, fieldId: op.fieldId, status: 'unverified', code: 'unknown_effect', selectedBytes: null, siteAcceptance: op.kind === 'upload' ? 'unverified' : 'not_applicable' };
      const field = fresh.snapshot.fields.find((f) => f.id === op.fieldId);
      if (field && fresh.snapshot.document === op.binding.document && fresh.frameId === op.binding.frameId && fresh.browserDocumentId === op.binding.browserDocumentId && op.recovery && op.recoverySignature && await recoverySignature(field) === op.recoverySignature) {
        const response = ActionResultSchema.safeParse(await this.deps.dispatch({ type: 'observe', operationId: op.id, runId: cp.autofill!.id, fieldId: op.fieldId, binding: previewBinding(fresh, input), precondition: field.current.fingerprint, expected: op.recovery }).catch(() => null));
        if (response.success && response.data.operationId === op.id && response.data.fieldId === op.fieldId) result = response.data;
      }
      operations.push({ ...op, result });
    }
    const next = { ...transition(cp, { type: 'RESUME' }, Date.now()), recovery: { reason: 'inspected', inspectionRequired: false, reattachRequired: false }, autofill: cp.autofill ? { ...cp.autofill, status: 'interrupted' as const, operations } : undefined };
    await store.replace(next, { sessionId, revision }); this.deps.changed(); return next;
  }
  async releaseInputs(sessionId: string, status: 'cancelled' | 'finished') {
    const db = await this.deps.database();
    const tx = db.transaction(['profiles', 'checkpoints'], 'readwrite');
    const raw = await tx.objectStore('checkpoints').get('current') as SessionCheckpoint | undefined;
    if (raw?.id === sessionId) await tx.objectStore('profiles').delete('snapshot');
    await tx.done;
    const docs = new DocumentStore(db), state = await docs.read();
    if (state.session?.sessionId === sessionId && state.session.status === 'started') await docs.end(sessionId, state.session.version, status);
  }
  async cancelSession(sessionId: string, revision: number) {
    const store = new CheckpointStore(await this.deps.database());
    for (let attempt = 0; attempt < 4; attempt++) {
      const cp = await store.read();
      if (!cp || cp.id !== sessionId || revision > cp.revision) throw new StaleCheckpointError();
      if (terminal(cp)) return cp;
      if (cp.autofill) return this.cancel(sessionId, cp.autofill.id);
      const next = transition(cp, { type: 'CANCEL' }, Date.now());
      try { await store.replace(next, { sessionId, revision: cp.revision }); this.deps.changed(); return next; }
      catch (error) { if (!(error instanceof StaleCheckpointError) || attempt === 3) throw error; }
    }
    throw new StaleCheckpointError();
  }
  async cancel(sessionId: string, runId: string) {
    const existing = await this.checkpoint();
    if (!existing || existing.id !== sessionId || existing.autofill?.id !== runId) throw new StaleCheckpointError();
    if (terminal(existing)) return existing;
    const active = this.active;
    if (active?.id === runId && active.sessionId === sessionId) {
      active.cancelled = true;
      if (active.command) await this.deps.dispatch({ ...this.base(active.command), type: 'cancel' }).catch(() => {});
    }
    const cp = await this.save(sessionId, runId, (s) => ({ ...s, status: 'cancelled' }));
    // Cancel releases temporary inputs. Effects already delivered to the website
    // remain observable; neither this nor buffer clearing is a remote rollback.
    await this.releaseInputs(sessionId, 'cancelled');
    this.deps.changed(); return cp;
  }
  // This entry is called only with background-held reviewed proposals by AiService.
  // It shares the deterministic lease, journal, executor and cancellation path.
  async applyApproved(original: Inspection, inputVersion: string, values: { fieldId: string; value: ProposedValue }[]) {
    if (this.active) throw new Error('ACCESS_UNAVAILABLE');
    const active = { id: crypto.randomUUID(), sessionId: original.sessionId, cancelled: false, command: undefined as ContentOperation | undefined };
    this.active = active;
    let started = false;
    try {
      const db = await this.deps.database(), cp = await this.checkpoint();
      const input = (await new ProfileStore(db).read()).snapshot;
      if (!cp || terminal(cp) || cp.lifecycle === 'PAUSED' || cp.recovery?.inspectionRequired || cp.recovery?.reattachRequired || cp.id !== original.sessionId || cp.target.tabId !== original.tabId || !input || input.version !== inputVersion || cp.access?.status !== 'ready' || cp.autofill?.status === 'running' || cp.autofill?.status === 'cancelled' || cp.autofill?.operations.some((o) => !o.result) || (cp.autofill?.operations.length ?? 0) + values.length > 100) throw new Error('ACCESS_UNAVAILABLE');
      const frame = original.frameId === 0 ? undefined : cp.access?.frames.find((f) => f.identity === original.snapshot.identity);
      if (original.frameId !== 0 && !frame) throw new Error('ACCESS_UNAVAILABLE');
      const inspect = async (validating = false) => {
        const latest = started ? await this.inspecting(original.sessionId, active.id, validating) : await this.boundary(original.sessionId);
        if (!latest || latest.id !== cp.id || active.cancelled || (started && latest.autofill?.status !== 'running')) throw new Error('ACCESS_UNAVAILABLE');
        const selected = original.snapshot.forms.length > 1 && original.snapshot.selectedForm ? { formId: original.snapshot.selectedForm, document: original.snapshot.document, revision: original.snapshot.revision } : undefined;
        const fresh = (await this.deps.access.inspect({ sessionId: cp.id, revision: latest.revision }, frame?.origin, frame?.identity, selected)).inspection;
        const a = previewBinding(original, input), b = previewBinding(fresh, input);
        if (JSON.stringify({ ...a, revision: 0 }) !== JSON.stringify({ ...b, revision: 0 }) || fresh.snapshot.status !== 'stable' || fresh.snapshot.selectedForm !== original.snapshot.selectedForm) throw new Error('ACCESS_UNAVAILABLE');
        return fresh;
      };
      let inspection = await inspect();
      if (inspection.snapshot.revision !== original.snapshot.revision) throw new Error('ACCESS_UNAVAILABLE');
      const latest = await this.checkpoint();
      if (!latest || latest.revision !== cp.revision) throw new StaleCheckpointError();
      await new CheckpointStore(db).replace({ ...transition(latest, { type: 'START', lease: { owner: this.owner, token: active.id, application: latest.target.identity ?? '', expiresAt: Date.now() + LEASE_MS } }, Date.now()), autofill: { id: active.id, inputVersion, status: 'running', operations: cp.autofill?.operations ?? [], requiredUnresolved: 0, unsupported: inspection.snapshot.unsupported.length } }, { sessionId: cp.id, revision: latest.revision });
      started = true; this.deps.changed();
      for (const entry of values) {
        if (active.cancelled) break;
        inspection = await inspect();
        const field = inspection.snapshot.fields.find((f) => f.id === entry.fieldId), old = original.snapshot.fields.find((f) => f.id === entry.fieldId);
        // Within a batch prior writes may advance the snapshot revision; every
        // pending field must still match its entire reviewed field descriptor.
        if (!field || !old || !safeAiField(field) || JSON.stringify(field) !== JSON.stringify(old) || (field.constraints.minLength && entry.value.kind === 'text' && entry.value.text.length < Number(field.constraints.minLength))) throw new Error('ACCESS_UNAVAILABLE');
        const frozen = (await new ProfileStore(db).read()).snapshot;
        if (frozen?.version !== inputVersion) throw new Error('ACCESS_UNAVAILABLE');
        const current = await this.checkpoint();
        if (!current || active.cancelled) throw new Error('ACCESS_UNAVAILABLE');
        const verified = await this.deps.access.verify(current);
        if (verified.revision !== current.revision || verified.access?.status !== 'ready') throw new Error('ACCESS_UNAVAILABLE');
        const operationId = crypto.randomUUID();
        const command: ContentOperation = { type: 'write', operationId, runId: active.id, fieldId: field.id, binding: previewBinding(inspection, input), precondition: field.current.fingerprint, value: entry.value, eligibilityApproved: false };
        const signature = await recoverySignature(field);
        await this.save(cp.id, active.id, (s) => ({ ...s, operations: [...s.operations, { id: operationId, fieldId: field.id, kind: 'field', binding: command.binding, precondition: command.precondition, recoverySignature: signature, recovery: entry.value, intentAt: Date.now(), result: null }] }));
        active.command = command;
        let result: ActionResult;
        try {
          const beforeDispatch = await this.boundary(cp.id);
          if (!beforeDispatch || beforeDispatch.lifecycle !== 'RUNNING' || beforeDispatch.lease?.owner !== this.owner || active.cancelled || beforeDispatch.autofill?.status !== 'running' || (await new ProfileStore(db).read()).snapshot?.version !== inputVersion) throw new Error('cancelled');
          const verifiedDispatch = await this.deps.access.verify(beforeDispatch);
          if (verifiedDispatch.revision !== beforeDispatch.revision || verifiedDispatch.access?.status !== 'ready' || active.cancelled) throw new Error('ACCESS_UNAVAILABLE');
          result = ActionResultSchema.parse(await this.deps.dispatch(ContentOperationSchema.parse(command)));
          if (result.operationId !== operationId || result.fieldId !== field.id) throw new Error('unverified');
        } catch {
          result = { operationId, fieldId: field.id, status: 'unverified', code: 'unknown_effect', selectedBytes: null, siteAcceptance: 'not_applicable' };
        } finally { active.command = undefined; }
        await this.result(cp.id, active.id, result);
        if (result.status !== 'accepted') break;
      }
      if (!active.cancelled) {
        inspection = await inspect(true);
        await this.save(cp.id, active.id, (s) => ({ ...s, status: 'review', requiredUnresolved: inspection.snapshot.fields.filter((f) => f.required && (!f.current.present || f.validation.valid === false || f.validation.ariaInvalid || f.validation.errorPresent)).length }));
      }
    } catch (e) {
      if (started && !active.cancelled) await this.interrupted(original.sessionId, active.id);
      throw e;
    } finally { if (this.active === active) this.active = null; this.deps.changed(); }
  }
  private base(c: ContentOperation) { return { operationId: c.operationId, runId: c.runId, fieldId: c.fieldId, binding: c.binding, precondition: c.precondition }; }
  async start(message: Start): Promise<SessionCheckpoint | null> {
    if (this.active) {
      if (this.active.id === message.runId && this.active.sessionId === message.sessionId) return this.checkpoint();
      throw new Error('ACCESS_UNAVAILABLE');
    }
    const initial = await this.checkpoint();
    if (!initial || initial.id !== message.sessionId) throw new StaleCheckpointError();
    if (initial.autofill?.id === message.runId) return initial; // Durable request deduplication, including cancelled runs.
    if (initial.revision !== message.revision || initial.autofill?.status === 'cancelled' || initial.autofill?.status === 'running' || initial.autofill?.operations.some((o) => !o.result)) throw new Error('ACCESS_UNAVAILABLE');
    if (terminal(initial) || initial.lifecycle === 'PAUSED' || initial.recovery?.inspectionRequired || initial.recovery?.reattachRequired) throw new Error('ACCESS_UNAVAILABLE');
    // No concurrent invocation may acquire a second lease while validation awaits.
    if (this.active) throw new Error('ACCESS_UNAVAILABLE');
    const active = { id: message.runId, sessionId: message.sessionId, cancelled: false, command: undefined as ContentOperation | undefined };
    this.active = active;
    let started = false;
    try {
      const db = await this.deps.database();
      const frozen = (await new ProfileStore(db).read()).snapshot;
      if (!frozen || frozen.sessionId !== message.sessionId || frozen.version !== message.inputVersion || message.inspection.sessionId !== message.sessionId || message.inspection.tabId !== initial.target.tabId) throw new Error('ACCESS_UNAVAILABLE');
      const frame = message.inspection.frameId === 0 ? undefined : initial.access?.frames.find((f) => f.identity === message.inspection.snapshot.identity);
      if (message.inspection.frameId !== 0 && !frame) throw new Error('ACCESS_UNAVAILABLE');
      let inspection = message.inspection;
      const inspect = async (validating = false) => {
        const cp = started ? await this.inspecting(message.sessionId, active.id, validating) : await this.boundary(message.sessionId);
        if (!cp || cp.id !== message.sessionId || active.cancelled || (started && cp.autofill?.status !== 'running')) throw new Error('ACCESS_UNAVAILABLE');
        const selected = inspection.snapshot.forms.length > 1 && inspection.snapshot.selectedForm ? { formId: inspection.snapshot.selectedForm, document: inspection.snapshot.document, revision: inspection.snapshot.revision } : undefined;
        const next = (await this.deps.access.inspect({ sessionId: cp.id, revision: cp.revision }, frame?.origin, frame?.identity, selected)).inspection;
        if (next.frameId !== message.inspection.frameId || next.browserDocumentId !== message.inspection.browserDocumentId || next.snapshot.document !== message.inspection.snapshot.document || next.snapshot.status !== 'stable' || !next.snapshot.selectedForm || next.snapshot.selectedForm !== message.inspection.snapshot.selectedForm) throw new Error('ACCESS_UNAVAILABLE');
        return next;
      };
      inspection = await inspect();
      if (JSON.stringify(previewBinding(inspection, frozen)) !== JSON.stringify(previewBinding(message.inspection, frozen))) throw new Error('ACCESS_UNAVAILABLE');
      const cp = await this.checkpoint();
      if (!cp || cp.revision !== message.revision || active.cancelled) throw new StaleCheckpointError();
      const state: Autofill = { id: message.runId, inputVersion: frozen.version, documentInput: message.resume, status: 'running', operations: initial.autofill?.operations ?? [], requiredUnresolved: 0, unsupported: 0 };
      await new CheckpointStore(db).replace({ ...transition(cp, { type: 'START', lease: { owner: this.owner, token: active.id, application: cp.target.identity ?? '', expiresAt: Date.now() + LEASE_MS } }, Date.now()), autofill: state }, { sessionId: cp.id, revision: cp.revision });
      started = true;
      this.deps.changed();
      const original = message.inspection;
      const attempted = new Set(state.operations.map((o) => o.fieldId));
      const corrections = () => message.corrections.flatMap((c): SessionCorrection[] => {
        const old = original.snapshot.fields.find((f) => f.id === c.fieldId), current = inspection.snapshot.fields.find((f) => f.id === c.fieldId);
        if (!old || !current || old.current.fingerprint !== current.current.fingerprint || JSON.stringify(c.binding) !== JSON.stringify(previewBinding(original, frozen)) || c.currentFingerprint !== old.current.fingerprint) return [];
        return [{ ...c, binding: previewBinding(inspection, frozen) }];
      });
      let quiet = 0;
      for (let index = state.operations.length; index < 100 && !active.cancelled; index++) {
        const currentInput = (await new ProfileStore(db).read()).snapshot;
        if (!currentInput || currentInput.version !== frozen.version) throw new Error('ACCESS_UNAVAILABLE');
        inspection = await inspect();
        const preview = createDryRun(inspection, frozen, corrections());
        const item = preview.items.find((i) => i.state === 'proposed' && i.proposal?.approval !== 'session_confirmation' && !attempted.has(i.fieldId));
        const resumeFields = inspection.snapshot.fields.filter((f) => f.type === 'file' && f.filePurpose === 'resume' && f.executable);
        const upload = !item && message.resume && resumeFields.length === 1 && !resumeFields[0]!.current.present && !attempted.has(resumeFields[0]!.id) ? resumeFields[0] : undefined;
        const field = item ? inspection.snapshot.fields.find((f) => f.id === item.fieldId)! : upload;
        if (!field) {
          // Extra finite inspections catch delayed conditional controls; changing
          // or looping forms fail closed in the inspector. Never click Next.
          if (++quiet < 3) continue;
          break;
        }
        quiet = 0; attempted.add(field.id);
        // A remount after an unknown result must not cause another upload.
        if (upload && state.operations.some((o) => o.kind === 'upload')) continue;
        const operationId = crypto.randomUUID(), binding = previewBinding(inspection, frozen);
        const base = { operationId, runId: message.runId, fieldId: field.id, binding, precondition: field.current.fingerprint };
        const prior = await this.checkpoint();
        if (upload && prior?.autofill?.operations.some((o) => o.kind === 'upload')) continue;
        let file: File | undefined;
        let metadata: Extract<ContentOperation, { type: 'begin' }>['file'] | undefined;
        if (upload && message.resume) {
          const docs = new DocumentStore(db), selected = await docs.read();
          if (!selected.document || selected.document.id !== message.resume.id || selected.document.inputVersion !== message.resume.inputVersion || selected.document.sessionId !== message.sessionId || selected.session?.status !== 'started') throw new Error('ACCESS_UNAVAILABLE');
          file = await docs.readBytes(selected.document.id, selected.document.inputVersion);
          metadata = { name: file.name, mime: file.type, size: file.size, lastModified: file.lastModified, digest: selected.document.digest };
        }
        const command: ContentOperation = item ? { ...base, type: 'write', value: item.proposal!.value, eligibilityApproved: item.eligibility && item.proposal!.approval === 'session_approved' } : { ...base, type: 'begin', file: metadata! };
        const signature = await recoverySignature(field);
        await this.save(message.sessionId, message.runId, (s) => ({ ...s, operations: [...s.operations, { id: operationId, fieldId: field.id, kind: upload ? 'upload' : 'field', binding, precondition: field.current.fingerprint, recoverySignature: signature, recovery: item ? item.proposal!.value : { kind: 'file', ...metadata! }, intentAt: Date.now(), result: null }] }));
        active.command = command;
        const authorized = async () => {
          const latest = await this.boundary(message.sessionId);
          if (!latest || latest.id !== message.sessionId || latest.autofill?.id !== message.runId || latest.autofill.status !== 'running' || latest.lifecycle !== 'RUNNING' || latest.lease?.owner !== this.owner || active.cancelled) throw new Error('ACCESS_UNAVAILABLE');
          const verified = await this.deps.access.verify(latest);
          if (verified.revision !== latest.revision || verified.access?.status !== 'ready') throw new Error('ACCESS_UNAVAILABLE');
          const p = (await new ProfileStore(db).read()).snapshot;
          if (p?.version !== frozen.version) throw new Error('ACCESS_UNAVAILABLE');
          if (upload) {
            const d = (await new DocumentStore(db).read()).document;
            if (d?.id !== message.resume?.id || d?.inputVersion !== message.resume?.inputVersion) throw new Error('ACCESS_UNAVAILABLE');
          }
          if (active.cancelled || (await this.checkpoint())?.lifecycle !== 'RUNNING') throw new Error('ACCESS_UNAVAILABLE');
        };
        let outcome: ActionResult;
        try {
          await authorized();
          // Never reinterpret an original prefilled/edited control that became
          // empty during this batch as a new deterministic opportunity.
          const originalField = original.snapshot.fields.find((f) => f.id === field.id);
          if (originalField && originalField.current.fingerprint !== field.current.fingerprint) {
            outcome = { operationId, fieldId: field.id, status: 'skipped_user_change', code: 'user_change', selectedBytes: null, siteAcceptance: upload ? 'unverified' : 'not_applicable' };
            await this.result(message.sessionId, message.runId, outcome);
            continue;
          }
          let response = await this.deps.dispatch(ContentOperationSchema.parse(command));
          if (file && response && typeof response === 'object' && 'ready' in response) {
            for (let offset = 0; offset < file.size; offset += 65536) {
              await authorized();
              const bytes = Array.from(new Uint8Array(await file.slice(offset, offset + 65536).arrayBuffer()));
              response = await this.deps.dispatch(ContentOperationSchema.parse({ ...base, type: 'chunk', offset, bytes }));
              bytes.fill(0);
              if (!response || typeof response !== 'object' || !('ready' in response)) break;
            }
            if (response && typeof response === 'object' && 'ready' in response) { await authorized(); response = await this.deps.dispatch({ ...base, type: 'commit' }); }
          }
          const parsed = ActionResultSchema.safeParse(response);
          if (!parsed.success || parsed.data.operationId !== operationId || parsed.data.fieldId !== field.id) throw new Error('ACCESS_UNAVAILABLE');
          outcome = parsed.data;
          if (upload && outcome.status === 'unverified') {
            // Inspect before a read-only verification. There is deliberately no
            // retry of begin/chunk/commit, even if the result was lost.
            inspection = await inspect();
            const observed = ActionResultSchema.safeParse(await this.deps.dispatch({ ...base, type: 'verify' }));
            if (observed.success && observed.data.operationId === operationId && observed.data.fieldId === field.id) outcome = observed.data;
          }
        } catch {
          outcome = { operationId, fieldId: field.id, status: 'unverified', code: active.cancelled ? 'cancelled' : 'unknown_effect', selectedBytes: null, siteAcceptance: upload ? 'unverified' : 'not_applicable' };
          if (upload && !active.cancelled) {
            try {
              inspection = await inspect();
              const observed = ActionResultSchema.safeParse(await this.deps.dispatch({ ...base, type: 'verify' }));
              if (observed.success && observed.data.operationId === operationId && observed.data.fieldId === field.id) outcome = observed.data;
            } catch { /* Keep unknown, never replay the upload. */ }
          }
        } finally {
          if (upload) await this.deps.dispatch({ ...base, type: 'clear' }).catch(() => {});
          active.command = undefined;
        }
        await this.result(message.sessionId, message.runId, outcome);
        if (outcome.code === 'unknown_effect' || outcome.code === 'stale_control' || active.cancelled) break;
      }
      if (!active.cancelled) {
        inspection = await inspect(true);
        const ledger = (await this.checkpoint())?.autofill?.operations ?? [];
        const remaining = inspection.snapshot.fields.filter((f) => {
          const last = ledger.findLast((o) => o.fieldId === f.id);
          return f.required && (!f.current.present || f.validation.valid === false || f.validation.ariaInvalid || f.validation.errorPresent || (last && last.result?.status !== 'accepted') || f.type === 'file');
        });
        await this.save(message.sessionId, message.runId, (s) => ({ ...s, status: 'review', requiredUnresolved: remaining.length, unsupported: inspection.snapshot.unsupported.length }));
      }
      return this.checkpoint();
    } catch (e) {
      if (!started) throw e;
      if (!active.cancelled) await this.interrupted(message.sessionId, message.runId);
      return this.checkpoint();
    } finally { if (this.active === active) this.active = null; this.deps.changed(); }
  }
}
