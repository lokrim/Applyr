import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { parseAlerts } from '../browser/attention-alerts';
export function NotificationSettings() {
  const [enabled, setEnabled] = useState(false), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void browser.storage.local.get('attention-alerts').then((s) => { if (alive) setEnabled(parseAlerts(s['attention-alerts']).enabled); }); };
    const changed = (_changes: unknown, area: string) => { if (area === 'local') refresh(); };
    refresh(); browser.storage.onChanged.addListener(changed);
    return () => { alive = false; browser.storage.onChanged.removeListener(changed); };
  }, []);
  return <section className="card" aria-label="Notifications"><h2>Attention notifications</h2><p>Off initially. Optional generic alerts contain no questions, answers, job details or authentication values. The queue and badge work without notifications.</p>
    <button disabled={busy} onClick={() => {
      // Native request starts directly in this opt-in gesture, before storage awaits.
      const request = enabled ? Promise.resolve(false) : browser.permissions.request({ permissions: ['notifications'] }).catch(() => false);
      setBusy(true);
      void request.then(async (granted) => {
        const raw = await browser.storage.local.get('attention-alerts'), state = parseAlerts(raw['attention-alerts']);
        await browser.storage.local.set({ 'attention-alerts': { ...state, enabled: granted } });
        if (enabled) { for (const link of state.links) await browser.notifications?.clear(`applyr-${link.token}`).catch(() => false); await browser.permissions.remove({ permissions: ['notifications'] }).catch(() => false); }
        setEnabled(granted); setNotice(granted ? 'Generic attention notifications enabled. Operating system settings may still suppress delivery.' : enabled ? 'Notifications disabled.' : 'Notification access unavailable or declined. Use the attention queue and badge.');
      }).catch(() => setNotice('Notification preference could not be saved. The attention queue remains available.')).finally(() => setBusy(false));
    }}>{enabled ? 'Disable notifications' : 'Enable notifications'}</button><p role="status">{notice}</p></section>;
}
