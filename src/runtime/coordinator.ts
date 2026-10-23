import type { TargetReference } from '../domain/session';
import { createCheckpoint } from '../domain/session';
import { RequestSchema, type Response } from './schemas';
import { trustedPage, type Sender } from '../security/sender';
import { CheckpointStore, StaleCheckpointError } from '../storage/checkpoints';

export interface CoordinatorDependencies {
  extensionId: string;
  pages: { popup: string; session: string; options: string };
  store: () => Promise<CheckpointStore>;
  target: (tabId: number) => Promise<TargetReference>;
  now: () => number;
  uuid: () => string;
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
      let checkpoint;
      switch (message.type) {
        case 'GET_STATE': checkpoint = await store.read(); break;
        case 'CAPTURE_TARGET': {
          let target: TargetReference;
          try { target = await dependencies.target(message.tabId); }
          catch { return fail('TAB_UNAVAILABLE'); }
          checkpoint = await store.replace(createCheckpoint(target, dependencies.uuid(), dependencies.now()), message);
          break;
        }
        case 'FORGET_CHECKPOINT': checkpoint = await store.replace(null, message); break;
      }
      return { schemaVersion: 1, requestId: message.requestId, ok: true, checkpoint };
    } catch (error) {
      return fail(error instanceof StaleCheckpointError ? 'STALE_CHECKPOINT' : 'STORAGE_UNAVAILABLE');
    }
  };
}
