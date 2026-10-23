// Content digest identifies bytes, never trust or employer acceptance.
export interface DocumentRef {
  schemaVersion: 1;
  id: string;
  kind: 'resume';
  digest: string;
  filename: string;
  mime: string;
  size: number;
  lastModified: number;
  inputVersion: string;
  blobRef: string;
  scope: 'session' | 'saved';
  sessionId: string | null;
  expiresAt: number | null;
}
