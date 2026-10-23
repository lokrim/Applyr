// Nonpersonal invalidation only, scoped to the extension origin. No Blob/File messaging.
const name = 'applyr-document-state-v1';
export function onDocumentChange(refresh: (deleted: boolean) => void) {
  const channel = new BroadcastChannel(name);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (event.data === 'DOCUMENT_CHANGED' || event.data === 'DOCUMENT_DELETED') refresh(event.data === 'DOCUMENT_DELETED');
  };
  return () => channel.close();
}
export function notifyDocumentChange(deleted = false) {
  const channel = new BroadcastChannel(name);
  channel.postMessage(deleted ? 'DOCUMENT_DELETED' : 'DOCUMENT_CHANGED');
  channel.close();
}
