// Pure domain types: no browser, React, storage, or validation dependencies.
export interface TargetReference {
  tabId: number;
  windowId: number;
  origin: string | null;
  availability: 'https' | 'restricted' | 'unavailable';
}

export interface SessionCheckpoint {
  schemaVersion: 1;
  id: string;
  revision: number;
  lifecycle: 'QUEUED';
  phase: 'SETUP';
  target: TargetReference;
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
