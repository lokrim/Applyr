import { browser } from 'wxt/browser';
import { RequestSchema, ResponseSchema, type Request } from './schemas';

type WithoutEnvelope<T> = T extends Request ? Omit<T, 'schemaVersion' | 'requestId'> : never;
export type Intent = WithoutEnvelope<Request>;
const errors = {
  FORBIDDEN: 'This page cannot access the checkpoint.',
  INVALID_MESSAGE: 'The extension received an unsupported request. Reload the extension UI.',
  STALE_CHECKPOINT: 'The checkpoint changed in another window or expired. Refresh before trying again.',
  TAB_UNAVAILABLE: 'The source tab is no longer available. Open the popup from the intended tab.',
  STORAGE_UNAVAILABLE: 'Local recovery storage is unavailable. Check browser storage space and reload.',
  INVALID_URL: 'Use a valid HTTPS application URL without credentials. Browser pages are unsupported.',
  ACCESS_UNAVAILABLE: 'This page or embedded application cannot be inspected. Invoke applyr on the application itself.',
} as const;

export async function sendIntent(intent: Intent) {
  return (await sendRequest(intent)).checkpoint;
}

export async function sendRequest(intent: Intent) {
  const request = RequestSchema.parse({ ...intent, schemaVersion: 1, requestId: crypto.randomUUID() });
  const response = ResponseSchema.parse(await browser.runtime.sendMessage(request));
  if (response.requestId !== request.requestId) throw new Error('The extension response could not be verified. Reload this page.');
  if (!response.ok) throw new Error(errors[response.code]);
  return response;
}

export function readCheckpoint() { return sendIntent({ type: 'GET_STATE', sessionId: null, revision: null }); }
