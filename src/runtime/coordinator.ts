import type { SessionCheckpoint, TargetReference } from '../domain/session';
import { createCheckpoint } from '../domain/session';
import { RequestSchema, type Response } from './schemas';
import { trustedPage, type Sender } from '../security/sender';
import { CheckpointStore, StaleCheckpointError } from '../storage/checkpoints';
import { initialAccess, type PageAccessService } from './page-access';

export interface CoordinatorDependencies {
  extensionId: string;
  pages: { popup: string; session: string; options: string };
  store: () => Promise<CheckpointStore>;
  target: (tabId: number) => Promise<TargetReference>;
  now: () => number;
  uuid: () => string;
  access?: PageAccessService;
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
        case 'INSPECT_FORM': {
          if (!dependencies.access) return fail('ACCESS_UNAVAILABLE');
          const result = await dependencies.access.inspect(message, message.frameOrigin, message.frameIdentity, message.selection);
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
        case 'FORGET_CHECKPOINT': checkpoint = await store.replace(null, message); break;
        case 'PROBE_TARGET':
          if (!dependencies.access) return fail('ACCESS_UNAVAILABLE');
          checkpoint = await dependencies.access.probe(message, message.frameOrigin, message.frameIdentity); break;
        case 'EDIT_TARGET':
          if (!dependencies.access) return fail('ACCESS_UNAVAILABLE');
          checkpoint = await dependencies.access.edit(message, message.role, message.company); break;
        case 'OPEN_APPLICATION':
          if (!dependencies.access) return fail('ACCESS_UNAVAILABLE');
          checkpoint = await dependencies.access.open(message, message.url); break;
      }
      return { schemaVersion: 1, requestId: message.requestId, ok: true, checkpoint };
    } catch (error) {
      if (error instanceof StaleCheckpointError) return fail('STALE_CHECKPOINT');
      if (error instanceof Error && ['INVALID_URL', 'TAB_UNAVAILABLE', 'ACCESS_UNAVAILABLE'].includes(error.message)) return fail(error.message as 'INVALID_URL' | 'TAB_UNAVAILABLE' | 'ACCESS_UNAVAILABLE');
      return fail('STORAGE_UNAVAILABLE');
    }
  };
}
