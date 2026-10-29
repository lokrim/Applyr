import type { SessionCheckpoint, TargetReference } from '../domain/session';
import { createCheckpoint, transition } from '../domain/session';
import { RequestSchema, type Response } from './schemas';
import { trustedPage, type Sender } from '../security/sender';
import { CheckpointStore, StaleCheckpointError } from '../storage/checkpoints';
import { initialAccess, type PageAccessService } from './page-access';
import type { AttentionService } from '../attention/service';
import type { AutofillService } from './autofill';

export interface CoordinatorDependencies {
  extensionId: string;
  pages: { popup: string; session: string; options: string };
  store: () => Promise<CheckpointStore>;
  target: (tabId: number) => Promise<TargetReference>;
  now: () => number;
  uuid: () => string;
  access?: PageAccessService;
  autofill?: AutofillService;
  attention?: AttentionService;
  changed?: () => void;
  discardAi?: () => void;
  deleteData?: (scope: 'profile' | 'history' | 'all') => Promise<void>;
}

export function createCoordinator(dependencies: CoordinatorDependencies) {
  return async (raw: unknown, sender: Sender): Promise<Response> => {
    const page = trustedPage(sender, dependencies.extensionId, Object.values(dependencies.pages));
    const request = RequestSchema.safeParse(raw);
    const requestId = request.success ? request.data.requestId : null;
    const fail = (code: Extract<Response, { ok: false }>['code']): Response => ({ schemaVersion: 1, requestId, ok: false, code });
    if (!page) return fail('FORBIDDEN');
    if (!request.success) return fail('INVALID_MESSAGE');
    const message = request.data;
    if (message.type === 'CAPTURE_TARGET' && page !== dependencies.pages.popup) return fail('FORBIDDEN');
    try {
      const store = await dependencies.store();
      let checkpoint: SessionCheckpoint | null = null;
      switch (message.type) {
        case 'DELETE_DATA': {
          if (page !== dependencies.pages.options || !dependencies.deleteData) return fail('FORBIDDEN');
          const cp = await store.read();
          if ((cp?.id ?? null) !== message.sessionId || (cp?.revision ?? null) !== message.revision) throw new StaleCheckpointError();
          await dependencies.deleteData(message.scope); checkpoint = await store.read(); break;
        }
        case 'SHOW_REVIEW':
          if (!dependencies.attention) return fail('ACCESS_UNAVAILABLE');
          checkpoint = await dependencies.attention.show(message, undefined, message.fieldId); break;
        case 'ATTENTION_ANSWERS':
        case 'REINSPECT_ATTENTION': {
          if (!dependencies.attention) return fail('ACCESS_UNAVAILABLE');
          const result = message.type === 'ATTENTION_ANSWERS' ? await dependencies.attention.answers(message) : await dependencies.attention.reinspect(message, message.itemId);
          result.checkpoint = await store.activity(result.checkpoint.id);
          return { schemaVersion: 1, requestId: message.requestId, ok: true, ...result };
        }
        case 'SHOW_ATTENTION':
          if (!dependencies.attention) return fail('ACCESS_UNAVAILABLE');
          checkpoint = await dependencies.attention.show(message, message.itemId); break;
        case 'RESTORE_SESSION':
          dependencies.discardAi?.(); checkpoint = await store.restore(message.archivedId, message); break;
        case 'REATTACH_SESSION':
          if (!dependencies.access) return fail('ACCESS_UNAVAILABLE');
          dependencies.discardAi?.(); checkpoint = await dependencies.access.reattach(message, message.tabId); break;
        case 'RESUME_SESSION':
          if (!dependencies.autofill) return fail('ACCESS_UNAVAILABLE');
          dependencies.discardAi?.(); checkpoint = await dependencies.autofill.resume(message.sessionId, message.revision); break;
        case 'PAUSE_SESSION':
          if (!dependencies.autofill) return fail('ACCESS_UNAVAILABLE');
          { const cp = await store.read(); if (!cp || cp.id !== message.sessionId || message.revision > cp.revision) throw new StaleCheckpointError(); }
          dependencies.discardAi?.(); checkpoint = await dependencies.autofill.pause(message.sessionId, message.revision); break;
        case 'CANCEL_SESSION':
          if (!dependencies.autofill) return fail('ACCESS_UNAVAILABLE');
          { const cp = await store.read(); if (!cp || cp.id !== message.sessionId || message.revision > cp.revision) throw new StaleCheckpointError(); }
          dependencies.discardAi?.(); checkpoint = await dependencies.autofill.cancelSession(message.sessionId, message.revision); break;
        case 'FINISH_SESSION':
        case 'REPORT_SUBMISSION':
        case 'FINAL_REVIEW': {
          let cp = await store.read();
          if (!cp || cp.id !== message.sessionId || cp.revision !== message.revision) throw new StaleCheckpointError();
          if (message.type === 'FINAL_REVIEW' && dependencies.attention) cp = (await dependencies.attention.reinspect(message)).checkpoint;
          if (message.type === 'FINAL_REVIEW' && cp.lifecycle !== 'READY_FOR_REVIEW') throw new Error('ACCESS_UNAVAILABLE');
          const event = message.type === 'FINISH_SESSION' ? { type: 'FINISH' as const } : message.type === 'FINAL_REVIEW' ? { type: 'REVIEW' as const, scope: 'final_review' as const } : { type: 'REPORT_SUBMISSION' as const };
          const next = transition(cp, event, dependencies.now());
          if (message.type === 'FINISH_SESSION') dependencies.discardAi?.();
          checkpoint = await store.replace(next, { sessionId: cp.id, revision: cp.revision });
          if (message.type === 'FINISH_SESSION') await dependencies.autofill?.releaseInputs(cp.id, 'finished');
          break;
        }
        case 'START_AUTOFILL':
          if (!dependencies.autofill) return fail('ACCESS_UNAVAILABLE');
          checkpoint = await dependencies.autofill.start(message); break;
        case 'CANCEL_AUTOFILL':
          if (!dependencies.autofill) return fail('ACCESS_UNAVAILABLE');
          dependencies.discardAi?.(); checkpoint = await dependencies.autofill.cancel(message.sessionId, message.runId); break;
        case 'INSPECT_FORM': {
          if (!dependencies.access) return fail('ACCESS_UNAVAILABLE');
          const result = await dependencies.access.inspect(message, message.frameOrigin, message.frameIdentity, message.selection);
          if (dependencies.attention) result.checkpoint = await dependencies.attention.observe(result.checkpoint, result.inspection);
          result.checkpoint = await store.activity(result.checkpoint.id);
          return { schemaVersion: 1, requestId: message.requestId, ok: true, ...result };
        }
        case 'GET_STATE': {
          // A tab event may invalidate state while a view is reading it. Retry
          // the read instead of showing a stale-mutation error for a passive read.
          for (let attempt = 0; attempt < 3; attempt++) {
            checkpoint = await store.read();
            try {
              if (checkpoint && dependencies.access) checkpoint = await dependencies.access.verify(checkpoint);
              break;
            } catch (error) {
              if (!(error instanceof StaleCheckpointError)) throw error;
              if (attempt === 2) checkpoint = await store.read();
            }
          }
          break;
        }
        case 'CAPTURE_TARGET': {
          let target: TargetReference;
          try { target = await dependencies.target(message.tabId); }
          catch { return fail('TAB_UNAVAILABLE'); }
          await store.assertNewRun(target.url, message.separateRun);
          dependencies.discardAi?.();
          const next = createCheckpoint(target, dependencies.uuid(), dependencies.now());
          if (dependencies.access) next.access = initialAccess(target);
          checkpoint = await store.replace(next, message);
          if (dependencies.access) {
            try { checkpoint = await dependencies.access.probe({ sessionId: next.id, revision: next.revision }); }
            catch (error) {
              // Capture is already committed; an automatic read-only probe may
              // race the navigation observer. Keep the bound attention state.
              if (!(error instanceof StaleCheckpointError)) throw error;
              checkpoint = await store.read();
              if (checkpoint?.id !== next.id) throw error;
            }
          }
          break;
        }
        case 'FORGET_CHECKPOINT': dependencies.discardAi?.(); checkpoint = await store.replace(null, message); break;
        case 'PROBE_TARGET':
          if (!dependencies.access) return fail('ACCESS_UNAVAILABLE');
          checkpoint = await dependencies.access.probe(message, message.frameOrigin, message.frameIdentity); break;
        case 'EDIT_TARGET':
          if (!dependencies.access) return fail('ACCESS_UNAVAILABLE');
          checkpoint = await dependencies.access.edit(message, message.role, message.company); break;
        case 'OPEN_APPLICATION':
          if (!dependencies.access) return fail('ACCESS_UNAVAILABLE');
          dependencies.discardAi?.(); checkpoint = await dependencies.access.open(message, message.url, message.separateRun); break;
      }
      if (checkpoint && !['GET_STATE', 'DELETE_DATA', 'START_AUTOFILL'].includes(message.type)) checkpoint = await store.activity(checkpoint.id);
      if (message.type !== 'GET_STATE') dependencies.changed?.();
      return { schemaVersion: 1, requestId: message.requestId, ok: true, checkpoint };
    } catch (error) {
      if (error instanceof StaleCheckpointError) return fail('STALE_CHECKPOINT');
      if (error instanceof Error && ['INVALID_URL', 'TAB_UNAVAILABLE', 'ACCESS_UNAVAILABLE', 'DUPLICATE_APPLICATION'].includes(error.message)) return fail(error.message as 'INVALID_URL' | 'TAB_UNAVAILABLE' | 'ACCESS_UNAVAILABLE' | 'DUPLICATE_APPLICATION');
      return fail('STORAGE_UNAVAILABLE');
    }
  };
}
