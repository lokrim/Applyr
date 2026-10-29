// Pure domain types: no browser, React, storage, or validation dependencies.
export interface TargetReference {
  tabId: number;
  windowId: number;
  origin: string | null;
  availability: 'https' | 'loopback' | 'restricted' | 'unavailable';
  url?: string | null;
  title?: string | null;
  role?: string | null;
  company?: string | null;
  identity?: string;
}

export type PageClassification = 'application' | 'listing' | 'login_challenge' | 'irrelevant' | 'restricted' | 'uncertain';
export interface FrameCandidate { url: string; origin: string; identity: string }
export interface PageAccess {
  status: 'unprobed' | 'ready' | 'needs_attention';
  classification: PageClassification;
  reason: 'unprobed' | 'application' | 'listing' | 'login_challenge' | 'irrelevant' | 'uncertain' | 'restricted' | 'permission' | 'frame_permission' | 'frame_unavailable' | 'closed' | 'navigation' | 'reload' | 'restart';
  frames: FrameCandidate[];
  challenge?: 'login' | 'otp' | 'captcha' | 'authentication';
  documentId?: string;
  inspectedAt?: number;
}

export interface SessionCheckpoint {
  schemaVersion: 1;
  id: string;
  revision: number;
  lifecycle: Lifecycle;
  phase: Phase;
  target: TargetReference;
  access?: PageAccess;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  lastActivityAt?: number;
  submission: { status: 'unknown' | 'reported_by_user'; reportedAt?: number; source?: 'user' };
  reviewScope?: 'current_step' | 'final_review';
  pauseRequested?: boolean;
  recovery?: { reason: string; inspectionRequired: boolean; reattachRequired: boolean };
  lease?: { owner: string; token: string; application: string; expiresAt: number };
  aiRequest?: { id: string; status: 'pending' | 'completed' | 'uncertain'; inputVersion: string };
  providerRequests?: NonNullable<SessionCheckpoint['aiRequest']>[];
  approval?: { batchId: string; inputVersion: string; document: string; revision: number; at: number; decisions: { fieldId: string; action: 'approve' | 'reject'; text: string }[] };
  autofill?: import('../forms/operations').Autofill;
  attention?: import('../attention/schema').Attention;
  review?: import('../review').FieldReview;
  providerError?: import('../providers/contracts').ProviderErrorCode;
  providers?: { provider: 'openai' | 'claude' | 'gemini'; model: string }[];
}

export const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createCheckpoint(target: TargetReference, id: string, now: number): SessionCheckpoint {
  return {
    schemaVersion: 1,
    id,
    revision: 0,
    lifecycle: 'QUEUED',
    phase: 'SETUP',
    target,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + RECOVERY_TTL_MS,
    submission: { status: 'unknown' },
  };
}

export type Lifecycle = 'QUEUED' | 'RUNNING' | 'NEEDS_ATTENTION' | 'PAUSED' | 'READY_FOR_REVIEW' | 'AUTOFILL_FINISHED' | 'CANCELLED' | 'FAILED';
export type Phase = 'SETUP' | 'INSPECTING' | 'PREPARING' | 'FILLING' | 'VALIDATING';
export const LEASE_MS = 60_000;
export const terminal = (s: SessionCheckpoint) => ['CANCELLED', 'FAILED', 'AUTOFILL_FINISHED'].includes(s.lifecycle);
// An explicit final-step choice cannot override known blockers or missing evidence.
export function reviewReady(s: SessionCheckpoint) {
  return !!s.review?.items.length && s.autofill?.status === 'review' && s.access?.status === 'ready'
    && !s.recovery?.inspectionRequired && !s.recovery?.reattachRequired
    && !s.attention?.items.some((i) => i.status === 'open' || i.status === 'answer_ready')
    && !s.review.areas.some((a) => a.unsupported > 0)
    && s.autofill.requiredUnresolved === 0 && s.autofill.unsupported === 0
    && !s.review.items.some((i) => i.status === 'rejected' || i.status === 'unverified' || (i.required && i.status === 'unresolved'));
}
export type SessionEvent =
  | { type: 'START'; lease: NonNullable<SessionCheckpoint['lease']> }
  | { type: 'PHASE'; phase: Exclude<Phase, 'SETUP'> }
  | { type: 'PAUSE' } | { type: 'BOUNDARY' } | { type: 'RESUME' }
  | { type: 'REVIEW'; scope?: 'current_step' | 'final_review' }
  | { type: 'INTERRUPT'; reason: string; reattach?: boolean }
  | { type: 'CANCEL' } | { type: 'FAIL'; reason: string } | { type: 'FINISH' } | { type: 'REPORT_SUBMISSION' };
// Pure state transitions. No browser view is an execution authority.
export function transition(s: SessionCheckpoint, event: SessionEvent, now: number): SessionCheckpoint {
  if (event.type !== 'REPORT_SUBMISSION' && terminal(s)) throw new Error('ACCESS_UNAVAILABLE');
  let next = { ...s, revision: s.revision + 1, updatedAt: now };
  switch (event.type) {
    case 'START':
      if (s.lifecycle === 'RUNNING' || s.lifecycle === 'PAUSED' || s.recovery?.inspectionRequired || s.recovery?.reattachRequired || s.pauseRequested) throw new Error('ACCESS_UNAVAILABLE');
      next = { ...next, lastActivityAt: now, expiresAt: now + RECOVERY_TTL_MS, lifecycle: 'RUNNING', phase: 'FILLING', lease: event.lease, reviewScope: undefined }; break;
    case 'PHASE': if (s.lifecycle !== 'RUNNING') throw new Error('ACCESS_UNAVAILABLE'); next.phase = event.phase; break;
    case 'PAUSE':
      next.pauseRequested = s.lifecycle === 'RUNNING';
      if (s.lifecycle !== 'RUNNING') { next.lifecycle = 'PAUSED'; next.lease = undefined; }
      break;
    case 'BOUNDARY':
      if (s.pauseRequested) { next.lifecycle = 'PAUSED'; next.pauseRequested = false; next.lease = undefined; if (next.aiRequest?.status === 'pending') next.aiRequest = { ...next.aiRequest, status: 'uncertain' }; next.recovery = { reason: 'paused', inspectionRequired: true, reattachRequired: false }; }
      break;
    case 'RESUME':
      if (s.recovery?.reattachRequired) throw new Error('ACCESS_UNAVAILABLE');
      next = { ...next, lifecycle: 'QUEUED', phase: 'INSPECTING', reviewScope: undefined, pauseRequested: false, lease: undefined, approval: undefined, recovery: { reason: 'resumed', inspectionRequired: true, reattachRequired: false } }; break;
    case 'REVIEW':
      if (event.scope === 'final_review' && !reviewReady(s)) throw new Error('ACCESS_UNAVAILABLE');
      next = { ...next, lifecycle: 'READY_FOR_REVIEW', phase: 'VALIDATING', reviewScope: event.scope ?? 'current_step', lease: undefined }; break;
    case 'INTERRUPT': next = { ...next, lifecycle: s.lifecycle === 'PAUSED' ? 'PAUSED' : 'NEEDS_ATTENTION', reviewScope: undefined, pauseRequested: false, lease: undefined, approval: undefined, recovery: { reason: event.reason, inspectionRequired: true, reattachRequired: !!event.reattach }, aiRequest: s.aiRequest?.status === 'pending' ? { ...s.aiRequest, status: 'uncertain' } : s.aiRequest }; break;
    case 'CANCEL': next = { ...next, lifecycle: 'CANCELLED', pauseRequested: false, lease: undefined, approval: undefined, aiRequest: s.aiRequest?.status === 'pending' ? { ...s.aiRequest, status: 'uncertain' } : s.aiRequest }; break;
    case 'FAIL': next = { ...next, lifecycle: 'FAILED', pauseRequested: false, lease: undefined, approval: undefined, recovery: { reason: event.reason, inspectionRequired: true, reattachRequired: false }, aiRequest: s.aiRequest?.status === 'pending' ? { ...s.aiRequest, status: 'uncertain' } : s.aiRequest }; break;
    case 'FINISH': if (s.lifecycle !== 'READY_FOR_REVIEW') throw new Error('ACCESS_UNAVAILABLE'); next = { ...next, lifecycle: 'AUTOFILL_FINISHED', lease: undefined, approval: undefined }; break;
    case 'REPORT_SUBMISSION': next.submission = { status: 'reported_by_user', reportedAt: now, source: 'user' }; break;
  }
  if (['INTERRUPT', 'BOUNDARY', 'CANCEL', 'FAIL', 'FINISH'].includes(event.type)) next.providerRequests = s.providerRequests?.map((r) => r.status === 'pending' ? { ...r, status: 'uncertain' } : r);
  if (['CANCEL', 'FINISH'].includes(event.type) && next.autofill) next.autofill = { ...next.autofill, operations: next.autofill.operations.map((op) => ({ ...op, recovery: undefined })) };
  if (['CANCEL', 'FINISH'].includes(event.type) && next.attention) next.attention = { ...next.attention, items: next.attention.items.map((i) => ({ ...i, correction: undefined })) };
  return next;
}
