import type { ProfileDocument } from './schema';

export type AssertionStatus = 'asserted' | 'unknown' | 'conflict' | 'needs_review';
export interface ProfileAssertion {
  sourcePath: string;
  profileVersion: 1;
  inputVersion: string;
  reviewedOn?: string | null;
  status: AssertionStatus;
  value: unknown;
}
export interface DraftProposal { status: 'needs_approval'; text: string; factRefs: string[]; inputVersion: string }

// Provenance is computed from the frozen input. No name splitting, résumé extraction,
// country inference, or independent verification is implied by "asserted"/"verified".
export function profileAssertions(document: ProfileDocument, inputVersion: string, now = Date.now()): ProfileAssertion[] {
  const assertions: ProfileAssertion[] = [];
  const stale = (reviewed: string | null | undefined) => !reviewed || now - Date.parse(`${reviewed}T00:00:00Z`) > 90 * 86400000;
  function walk(value: unknown, path: string, reviewedOn: string | null | undefined) {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) value.forEach((item, i) => {
        const segment = item && typeof item === 'object' && 'id' in item ? String(item.id) : path === 'eligibility' && item && typeof item === 'object' && 'country_code' in item ? String(item.country_code) : i;
        walk(item, `${path}.${segment}`, reviewedOn);
      });
      else {
        const item = value as Record<string, unknown>;
        const review = Object.hasOwn(item, 'reviewed_on') ? item.reviewed_on as string | null : Object.hasOwn(item, 'confirmed_on') ? item.confirmed_on as string | null : reviewedOn;
        Object.entries(item).forEach(([key, field]) => walk(field, path ? `${path}.${key}` : key, review));
      }
      return;
    }
    const sensitiveToAge = /^(?:eligibility\.|answers\.|preferences\.)/.test(path);
    assertions.push({ sourcePath: path, profileVersion: 1, inputVersion, reviewedOn, status: value == null || (typeof value === 'string' && !value.trim()) ? 'unknown' : sensitiveToAge && stale(reviewedOn) ? 'needs_review' : 'asserted', value });
  }
  walk(document.data, '', document.data.reviewed_on);
  document.data.answers?.forEach((a) => {
    const reviewedOn = a.reviewed_on !== undefined ? a.reviewed_on : document.data.reviewed_on;
    assertions.push({ sourcePath: `answers.${a.id}.body`, profileVersion: 1, inputVersion, reviewedOn, status: stale(reviewedOn) ? 'needs_review' : 'asserted', value: document.answerBodies[a.id] });
  });
  return assertions;
}

export function profileAssertion(document: ProfileDocument, sourcePath: string, inputVersion: string, now = Date.now()): ProfileAssertion {
  return profileAssertions(document, inputVersion, now).find((a) => a.sourcePath === sourcePath) ?? { sourcePath, profileVersion: 1, inputVersion, status: 'unknown', value: undefined };
}

export function changedProfilePaths(before: ProfileDocument | null, after: ProfileDocument): string[] {
  const changes: string[] = [];
  function compare(a: unknown, b: unknown, path: string) {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
    } else changes.push(path);
  }
  compare(before?.data, after.data, 'profile'); compare(before?.notes, after.notes, 'notes'); compare(before?.answerBodies, after.answerBodies, 'answers');
  return changes;
}
