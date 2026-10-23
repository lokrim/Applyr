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
    const handleProvider = providerHandler(providers, browser.runtime.id, browser.runtime.getURL(branding.pages.options));
    const store = async () => new CheckpointStore(await getDatabase());
    const target = async (tabId: number) => capturedTarget(await browser.tabs.get(tabId), import.meta.env.DEV);
    const access = new PageAccessService({
      store, target, now: Date.now, uuid: () => crypto.randomUUID(), allowLoopback: import.meta.env.DEV,
      changed: () => { const channel = new BroadcastChannel('applyr-target'); channel.postMessage('changed'); channel.close(); },
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
    const changed = () => { const channel = new BroadcastChannel('applyr-target'); channel.postMessage('changed'); channel.close(); };
    const autofill = new AutofillService({ database: getDatabase, access, changed,
      dispatch: async (command) => {
        ContentOperationSchema.parse(command);
        const b = command.binding;
        const results = await browser.scripting.executeScript({ target: { tabId: b.tabId, frameIds: [b.frameId] }, world: 'ISOLATED', func: operateControl, args: [command] });
        const found = results.filter((r) => r.frameId === b.frameId && (!b.browserDocumentId || r.documentId === b.browserDocumentId));
        return found.length === 1 ? found[0]!.result : null;
      },
    });
    const ai = new AiService(getDatabase, providers, autofill, changed);
    onProfileDeletion(() => ai.discard());
    const handleAi = aiHandler(ai, browser.runtime.id, [browser.runtime.getURL(branding.pages.session), browser.runtime.getURL(branding.pages.options)]);
    const handle = createCoordinator({
      extensionId: browser.runtime.id,
      pages: {
        popup: browser.runtime.getURL(branding.pages.popup),
        session: browser.runtime.getURL(branding.pages.session),
        options: browser.runtime.getURL(branding.pages.options),
      },
      store, target, access, autofill, changed, discardAi: () => ai.discard(),
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
    browser.permissions.onRemoved.addListener((permissions) => { providers.revokePermissions(); ai.discard(); safely(ready.then(() => access.revoked(permissions.origins ?? []))); });
    browser.runtime.onStartup.addListener(() => { initialize(); ai.discard(); safely(ready.then(async () => { await (await store()).recover(autofill.owner, true); await access.event(null, 'restart'); })); });
    browser.runtime.onInstalled.addListener(initialize);
    initialize();
  },
});
