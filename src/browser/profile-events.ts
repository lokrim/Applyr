// Extension-origin only, no personal payload. Website contexts cannot subscribe.
const channelName = 'applyr-profile-deletion-v1';
export function onProfileChange(refresh: () => void) {
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (event: MessageEvent<unknown>) => { if (event.data === 'PROFILE_CHANGED' || event.data === 'PROFILE_DELETED') refresh(); };
  return () => channel.close();
}
export function onProfileDeletion(clear: () => void) {
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (event: MessageEvent<unknown>) => { if (event.data === 'PROFILE_DELETED') clear(); };
  return () => channel.close();
}
export function notifyProfileDeletion() {
  const channel = new BroadcastChannel(channelName);
  channel.postMessage('PROFILE_DELETED'); channel.close();
}
export function notifyProfileChange() {
  const channel = new BroadcastChannel(channelName);
  channel.postMessage('PROFILE_CHANGED'); channel.close();
}
