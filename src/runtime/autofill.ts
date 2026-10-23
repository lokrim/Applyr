import type { SessionCheckpoint } from '../domain/session';
import { ActionResultSchema, ContentOperationSchema, type ActionResult, type ContentOperation, type Autofill } from '../forms/operations';
import { createDryRun, previewBinding } from '../mapping/rules';
import type { SessionCorrection } from '../mapping/schema';
import type { Request } from './schemas';
import type { PageAccessService } from './page-access';
import { CheckpointStore, StaleCheckpointError } from '../storage/checkpoints';
import { ProfileStore } from '../storage/profiles';
import { DocumentStore } from '../storage/documents';
import type { ApplyrDatabase } from '../storage/database';
import type { IDBPDatabase } from 'idb';

type Start = Extract<Request, { type: 'START_AUTOFILL' }>;
export class AutofillService {
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
      const next = { ...cp, revision: cp.revision + 1, updatedAt: Date.now(), autofill: change(cp.autofill) };
      try { await store.replace(next, { sessionId, revision: cp.revision }); this.deps.changed(); return next; }
      catch (e) { if (!(e instanceof StaleCheckpointError) || attempt === 3) throw e; }
    }
    throw new StaleCheckpointError();
  }
  async cancel(sessionId: string, runId: string) {
    const active = this.active;
    if (active?.id === runId && active.sessionId === sessionId) {
      active.cancelled = true;
      if (active.command) await this.deps.dispatch({ ...this.base(active.command), type: 'cancel' }).catch(() => {});
    }
    const cp = await this.save(sessionId, runId, (s) => ({ ...s, status: 'cancelled' }));
    // Cancel releases temporary inputs. Effects already delivered to the website
    // remain observable; neither this nor buffer clearing is a remote rollback.
    const db = await this.deps.database();
    const tx = db.transaction('profiles', 'readwrite'); await tx.store.delete('snapshot'); await tx.done;
    const docs = new DocumentStore(db); const state = await docs.read();
    if (state.session?.sessionId === sessionId && state.session.status === 'started') await docs.end(sessionId, state.session.version, 'cancelled');
    this.deps.changed(); return cp;
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
      const inspect = async () => {
        const cp = await this.checkpoint();
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
      const state: Autofill = { id: message.runId, inputVersion: frozen.version, status: 'running', operations: initial.autofill?.operations ?? [], requiredUnresolved: 0, unsupported: 0 };
      await new CheckpointStore(db).replace({ ...cp, revision: cp.revision + 1, updatedAt: Date.now(), autofill: state }, { sessionId: cp.id, revision: cp.revision });
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
        await this.save(message.sessionId, message.runId, (s) => ({ ...s, operations: [...s.operations, { id: operationId, fieldId: field.id, kind: upload ? 'upload' : 'field', binding, precondition: field.current.fingerprint, intentAt: Date.now(), result: null }] }));
        active.command = command;
        const authorized = async () => {
          const latest = await this.checkpoint();
          if (!latest || latest.id !== message.sessionId || latest.autofill?.id !== message.runId || latest.autofill.status !== 'running' || active.cancelled) throw new Error('ACCESS_UNAVAILABLE');
          const verified = await this.deps.access.verify(latest);
          if (verified.revision !== latest.revision || verified.access?.status !== 'ready') throw new Error('ACCESS_UNAVAILABLE');
          const p = (await new ProfileStore(db).read()).snapshot;
          if (p?.version !== frozen.version) throw new Error('ACCESS_UNAVAILABLE');
          if (upload) {
            const d = (await new DocumentStore(db).read()).document;
            if (d?.id !== message.resume?.id || d?.inputVersion !== message.resume?.inputVersion) throw new Error('ACCESS_UNAVAILABLE');
          }
        };
        let outcome: ActionResult;
        try {
          await authorized();
          // Never reinterpret an original prefilled/edited control that became
          // empty during this batch as a new deterministic opportunity.
          const originalField = original.snapshot.fields.find((f) => f.id === field.id);
          if (originalField && originalField.current.fingerprint !== field.current.fingerprint) {
            outcome = { operationId, fieldId: field.id, status: 'skipped_user_change', code: 'user_change', selectedBytes: null, siteAcceptance: upload ? 'unverified' : 'not_applicable' };
            await this.save(message.sessionId, message.runId, (s) => ({ ...s, operations: s.operations.map((o) => o.id === operationId ? { ...o, result: outcome } : o) }));
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
        await this.save(message.sessionId, message.runId, (s) => ({ ...s, operations: s.operations.map((o) => o.id === operationId ? { ...o, result: outcome } : o) }));
        if (outcome.code === 'unknown_effect' || outcome.code === 'stale_control' || active.cancelled) break;
      }
      if (!active.cancelled) {
        inspection = await inspect();
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
      if (!active.cancelled) await this.save(message.sessionId, message.runId, (s) => ({ ...s, status: 'interrupted' })).catch(() => {});
      return this.checkpoint();
    } finally { if (this.active === active) this.active = null; this.deps.changed(); }
  }
}
