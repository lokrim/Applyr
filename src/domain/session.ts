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
  documentId?: string;
  inspectedAt?: number;
}

export interface SessionCheckpoint {
  schemaVersion: 1;
  id: string;
  revision: number;
  lifecycle: 'QUEUED' | 'NEEDS_ATTENTION';
  phase: 'SETUP';
  target: TargetReference;
  access?: PageAccess;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  submission: { status: 'unknown' };
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
