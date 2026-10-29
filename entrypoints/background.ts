import '../src/security/schema-policy';
import { deleteLocalData } from '../src/storage/data-controls';
import { notifyProfileDeletion } from '../src/browser/profile-events';
import { notifyDocumentChange, onDocumentChange } from '../src/browser/document-events';
import { AttentionService } from '../src/attention/service';
import { AttentionAlerts, parseAlerts, openAttentionAlert } from '../src/browser/attention-alerts';
import { markAttention } from '../src/forms/markers';
import { terminal, type SessionCheckpoint } from '../src/domain/session';
import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { onProfileDeletion } from '../src/browser/profile-events';
import { branding } from '../src/branding';
import { createCoordinator } from '../src/runtime/coordinator';
import { getDatabase } from '../src/storage/database';
import { CheckpointStore } from '../src/storage/checkpoints';
import { ProfileStore } from '../src/storage/profiles';
import { DocumentStore } from '../src/storage/documents';
import { capturedTarget } from '../src/browser/targets';
import { originPattern } from '../src/browser/addresses';
import { probePage } from '../src/browser/probe';
import { inspectForm } from '../src/forms/inspect';
import { PageAccessService } from '../src/runtime/page-access';
import { restrictPreferenceAccess } from '../src/browser/surfaces';
import { AutofillService } from '../src/runtime/autofill';
import { operateControl } from '../src/forms/apply';
import { ContentOperationSchema } from '../src/forms/operations';
import { ProviderStorage } from '../src/providers/storage';
import { AiService, aiHandler } from '../src/ai/service';
import { ProviderService, providerHandler } from '../src/providers/service';

export default defineBackground({
  persistent: false,
  main() {
    const providers = new ProviderService(new ProviderStorage(getDatabase, browser.storage.session), (pattern) => browser.permissions.contains({ origins: [pattern], ...(import.meta.env.BROWSER === 'firefox' ? { data_collection: ['authenticationInfo'] } : {}) }), undefined, () => import.meta.env.BROWSER === 'firefox' ? browser.permissions.contains({ origins: [], ...{ data_collection: ['websiteContent', 'personallyIdentifyingInfo', 'authenticationInfo'] } }) : Promise.resolve(true));
    const handleProvider = providerHandler(providers, browser.runtime.id, browser.runtime.getURL(branding.pages.options), () => ai.discard());
    const store = async () => new CheckpointStore(await getDatabase());
    const target = async (tabId: number) => capturedTarget(await browser.tabs.get(tabId), import.meta.env.DEV);
    let previous: SessionCheckpoint | null = null;
    let changeGeneration = 0;
    const changed = () => {
      const generation = ++changeGeneration;
      const channel = new BroadcastChannel('applyr-target'); channel.postMessage('changed'); channel.close();
      void store().then((s) => s.read()).then(async (cp) => {
        if (generation !== changeGeneration) return;
        const old = previous; previous = cp;
        const cleanup = old && (!cp || old.id !== cp.id) ? old : cp && (terminal(cp) || cp.access?.status !== 'ready' || cp.recovery?.inspectionRequired) ? cp : null;
        if (cleanup) {
          const contexts = [cleanup, ...(old?.id === cleanup.id ? [old] : [])];
          const frameIds = [...new Set([0, ...contexts.flatMap((s) => [...s.attention?.items.flatMap((i) => i.target ? [i.target.frameId] : []) ?? [], ...s.review?.items.map((i) => i.target.frameId) ?? []])])];
          await browser.tabs.sendMessage(cleanup.target.tabId, { channel: 'clear-applyr-markers' }).catch(() => {});
          await browser.scripting.executeScript({ target: { tabId: cleanup.target.tabId, frameIds }, world: 'ISOLATED', func: markAttention, args: [null, [], false] }).catch(() => {});
        }
        if (generation === changeGeneration) await alerts?.refresh(cp);
      }).catch(() => {});
    };
    const access = new PageAccessService({
      store, target, now: Date.now, uuid: () => crypto.randomUUID(), allowLoopback: import.meta.env.DEV,
      changed,
      contains: (origin) => browser.permissions.contains({ origins: [originPattern(origin, import.meta.env.DEV)] }),
      createTab: (url) => browser.tabs.create({ url, active: true }),
      inspect: async (tabId, identity, frame, selection) => {
        const results = await browser.scripting.executeScript({
          target: frame ? { tabId, allFrames: true } : { tabId, frameIds: [0] },
          world: 'ISOLATED', func: inspectForm, args: [identity, frame?.url ?? null, selection ?? null],
        });
        const found = results.filter((r) => r.result !== null && r.result !== undefined);
        // Identical duplicated frame URLs are ambiguous too; never choose one.
        return found.length === 1 ? { result: found[0]!.result, documentId: found[0]!.documentId, frameId: found[0]!.frameId } : null;
      },
      probe: async (tabId, identity, frame) => {
        // Chrome may reject allFrames if any other frame lacks permission. We
        // then offer opening the embedded application directly; never broaden.
        const results = await browser.scripting.executeScript({
          target: frame ? { tabId, allFrames: true } : { tabId, frameIds: [0] },
          world: 'ISOLATED', func: probePage, args: [identity, frame?.url ?? null],
        });
        const found = results.find((r) => r.result !== null && r.result !== undefined);
        return found ? { result: found.result, documentId: found.documentId } : null;
      },
    });
    const attention = new AttentionService({ database: getDatabase, access, changed,
      mark: async (t, fields, show) => {
        const results = await browser.scripting.executeScript({ target: { tabId: t.tabId, frameIds: [t.frameId] }, world: 'ISOLATED', func: markAttention, args: [t, fields, show] });
        return results.length === 1 && (!t.browserDocumentId || results[0]?.documentId === t.browserDocumentId) && results[0]?.result === true;
      },
      activate: async (cp) => { await browser.tabs.update(cp.target.tabId, { active: true }); await browser.windows.update(cp.target.windowId, { focused: true }); },
    });
    const alerts = new AttentionAlerts({
      read: async () => parseAlerts((await browser.storage.local.get('attention-alerts'))['attention-alerts']),
      write: (state) => browser.storage.local.set({ 'attention-alerts': state }),
      permission: () => browser.permissions.contains({ permissions: ['notifications'] }),
      badge: async (status) => { await browser.action.setBadgeText({ text: status.text }); await browser.action.setTitle({ title: status.title }); await browser.action.setBadgeBackgroundColor({ color: '#34335c' }); },
      create: async (id, options) => { if (typeof browser.notifications?.create !== 'function') throw new Error('UNSUPPORTED'); await browser.notifications.create(id, { type: 'basic', iconUrl: browser.runtime.getURL('/icon-48.png'), ...options }); },
      clear: async (id) => typeof browser.notifications?.clear === 'function' ? browser.notifications.clear(id) : false,
    });
    browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes['attention-alerts'] && parseAlerts(changes['attention-alerts'].newValue).enabled !== parseAlerts(changes['attention-alerts'].oldValue).enabled) changed(); });
    browser.notifications?.onClicked?.addListener((id) => {
      void ready.then(async () => {
        const s = await store();
        const opened = await openAttentionAlert(id, {
          state: async () => parseAlerts((await browser.storage.local.get('attention-alerts'))['attention-alerts']),
          current: () => s.read(), archived: () => s.archived(), restore: (sessionId, expected) => s.restore(sessionId, expected),
          open: async () => { await browser.tabs.create({ url: browser.runtime.getURL(branding.pages.session), active: true }); },
        });
        if (!opened) return;
        await browser.notifications.clear(id).catch(() => false); changed();
      }).catch(() => {});
    });
    const autofill = new AutofillService({ database: getDatabase, access, changed, observed: (cp, inspection) => attention.observe(cp, inspection),
      dispatch: async (command) => {
        ContentOperationSchema.parse(command);
        const b = command.binding;
        const results = await browser.scripting.executeScript({ target: { tabId: b.tabId, frameIds: [b.frameId] }, world: 'ISOLATED', func: operateControl, args: [command] });
        const found = results.filter((r) => r.frameId === b.frameId && (!b.browserDocumentId || r.documentId === b.browserDocumentId));
        return found.length === 1 ? found[0]!.result : null;
      },
    });
    const ai = new AiService(getDatabase, providers, autofill, changed);
    onProfileDeletion(() => { ai.discard(); autofill.invalidate(); changed(); });
    onDocumentChange((deleted) => { if (deleted) { ai.discard(); autofill.invalidate(); changed(); } });
    const handleAi = aiHandler(ai, browser.runtime.id, [browser.runtime.getURL(branding.pages.session), browser.runtime.getURL(branding.pages.options)]);
    const handle = createCoordinator({
      extensionId: browser.runtime.id,
      pages: {
        popup: browser.runtime.getURL(branding.pages.popup),
        session: browser.runtime.getURL(branding.pages.session),
        options: browser.runtime.getURL(branding.pages.options),
      },
      store, target, access, autofill, attention, changed, discardAi: () => ai.discard(),
      deleteData: async (scope) => {
        ai.discard(); autofill.invalidate();
        if (scope === 'all') {
          // Revocation invalidates pending probes/dispatch before clearing keys.
          providers.revokePermissions();
          for (const provider of ['openai', 'claude', 'gemini'] as const) await providers.execute({ channel: 'providers', schemaVersion: 1, requestId: crypto.randomUUID(), type: 'REMOVE_KEY', provider, revision: 0 });
          await providers.fenceReset();
        }
        await deleteLocalData(await getDatabase(), scope);
        const resetChannel = new BroadcastChannel('applyr-data-reset'); resetChannel.postMessage(scope); resetChannel.close();
        if (scope === 'profile' || scope === 'all') notifyProfileDeletion();
        if (scope === 'history' || scope === 'all') notifyDocumentChange(true);
        if (scope === 'all') {
          await alerts.refresh(null);
          await browser.storage.session.clear(); await browser.storage.local.clear();
          const grants = await browser.permissions.getAll(), manifest = browser.runtime.getManifest();
          if (grants.permissions?.includes('notifications') && typeof browser.notifications?.getAll === 'function') for (const id of Object.keys(await browser.notifications.getAll())) await browser.notifications.clear(id);
          const optionalOrigins = (grants.origins ?? []).filter((origin) => !manifest.host_permissions?.includes(origin));
          if (optionalOrigins.length) await browser.permissions.remove({ origins: optionalOrigins });
          const optionalData = (grants as { data_collection?: string[] }).data_collection?.filter((c) => ['websiteContent', 'authenticationInfo'].includes(c)) ?? [];
          if (optionalData.length) await browser.permissions.remove({ origins: [], ...{ data_collection: optionalData } });
          if (grants.permissions?.includes('notifications') && !manifest.permissions?.includes('notifications')) await browser.permissions.remove({ permissions: ['notifications'] });
        }
        changed();
      },
      now: Date.now,
      uuid: () => crypto.randomUUID(),
    });
    // Recovery starts on every worker/event-page instantiation. Listener registration
    // below remains synchronous; every handler gates work on this finite promise.
    const ready = (async () => {
      const marker = await browser.storage.session.get('applyr-session-epoch');
      const restart = typeof marker['applyr-session-epoch'] !== 'string';
      if (restart) await browser.storage.session.set({ 'applyr-session-epoch': crypto.randomUUID() });
      await (await store()).recover(autofill.owner, restart);
      if (restart) await access.event(null, 'restart');
      changed();
    })();
    void ready.catch(() => { /* Requests report the storage failure. */ });
    // Callback bridge works with Chrome versions that do not support Promise listeners.
    browser.runtime.onMessage.addListener((message: unknown, sender, respond) => {
      const isProvider = typeof message === 'object' && message !== null && 'channel' in message && message.channel === 'providers';
      const isAi = typeof message === 'object' && message !== null && 'channel' in message && message.channel === 'ai';
      void ready.then<unknown>(() => isProvider ? handleProvider(message, sender) : isAi ? handleAi(message, sender) : handle(message, sender)).then(respond).catch(() => respond({ schemaVersion: 1, requestId: null, ok: false, code: 'STORAGE_UNAVAILABLE' }));
      return true;
    });
    const initialize = () => {
      void restrictPreferenceAccess().catch(() => { /* No preferences are stored in this shell. */ });
      void getDatabase().then((database) => new CheckpointStore(database).read()).catch(() => { /* UI reports storage failures. */ });
      void getDatabase().then((database) => new ProfileStore(database).read()).catch(() => { /* UI reports bounded storage failures. */ });
      void getDatabase().then((database) => new DocumentStore(database).read()).catch(() => { /* UI reports bounded document storage failures. */ });
    };
    // Events observe only the bound tab. No activation listener can retarget it.
    const safely = (operation: Promise<unknown>) => { void operation.catch(() => { /* Durable preconditions prevent writes until revalidation. */ }); };
    browser.tabs.onRemoved.addListener((tabId) => safely(ready.then(async () => { const cp = await (await store()).read(); if (cp?.target.tabId === tabId) ai.discard(); await access.event(tabId, 'closed'); })));
    browser.tabs.onReplaced.addListener((_added, removed) => safely(ready.then(async () => { const cp = await (await store()).read(); if (cp?.target.tabId === removed) ai.discard(); await access.event(removed, 'closed'); })));
    browser.tabs.onUpdated.addListener((tabId, change) => {
      if (change.url || change.status === 'loading') safely(ready.then(async () => {
        const checkpoint = await (await store()).read();
        if (checkpoint?.target.tabId !== tabId) return;
        ai.discard();
        const verified = await access.verify(checkpoint);
        if (verified.access?.reason !== 'navigation') await access.event(tabId, 'reload');
      }));
      if (change.status === 'complete') safely(ready.then(async () => {
        const checkpoint = await (await store()).read();
        if (checkpoint?.target.tabId !== tabId || !checkpoint.target.origin || checkpoint.access?.inspectedAt || !['permission', 'reload'].includes(checkpoint.access?.reason ?? '')) return;
        if (await browser.permissions.contains({ origins: [originPattern(checkpoint.target.origin, import.meta.env.DEV)] })) await access.probe({ sessionId: checkpoint.id, revision: checkpoint.revision });
      }));
    });
    browser.permissions.onRemoved.addListener((permissions) => { if (permissions.origins?.length || (permissions as { data_collection?: string[] }).data_collection?.length) { providers.revokePermissions(); ai.discard(); } safely(ready.then(async () => { await access.revoked(permissions.origins ?? []); changed(); })); });
    browser.runtime.onStartup.addListener(() => { initialize(); ai.discard(); safely(ready.then(async () => { await (await store()).recover(autofill.owner, true); await access.event(null, 'restart'); })); });
    browser.runtime.onInstalled.addListener(initialize);
    initialize();
  },
});
