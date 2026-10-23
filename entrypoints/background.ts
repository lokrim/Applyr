import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { branding } from '../src/branding';
import { createCoordinator } from '../src/runtime/coordinator';
import { getDatabase } from '../src/storage/database';
import { CheckpointStore } from '../src/storage/checkpoints';
import { ProfileStore } from '../src/storage/profiles';
import { DocumentStore } from '../src/storage/documents';
import { capturedTarget } from '../src/browser/targets';
import { originPattern } from '../src/browser/addresses';
import { probePage } from '../src/browser/probe';
import { PageAccessService } from '../src/runtime/page-access';
import { restrictPreferenceAccess } from '../src/browser/surfaces';

export default defineBackground({
  persistent: false,
  main() {
    const store = async () => new CheckpointStore(await getDatabase());
    const target = async (tabId: number) => capturedTarget(await browser.tabs.get(tabId), import.meta.env.DEV);
    const access = new PageAccessService({
      store, target, now: Date.now, uuid: () => crypto.randomUUID(), allowLoopback: import.meta.env.DEV,
      changed: () => { const channel = new BroadcastChannel('applyr-target'); channel.postMessage('changed'); channel.close(); },
      contains: (origin) => browser.permissions.contains({ origins: [originPattern(origin, import.meta.env.DEV)] }),
      createTab: (url) => browser.tabs.create({ url, active: true }),
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
    const handle = createCoordinator({
      extensionId: browser.runtime.id,
      pages: {
        popup: browser.runtime.getURL(branding.pages.popup),
        session: browser.runtime.getURL(branding.pages.session),
        options: browser.runtime.getURL(branding.pages.options),
      },
      store, target, access,
      now: Date.now,
      uuid: () => crypto.randomUUID(),
    });
    // Callback bridge works with Chrome versions that do not support Promise listeners.
    browser.runtime.onMessage.addListener((message: unknown, sender, respond) => {
      void handle(message, sender).then(respond);
      return true;
    });
    const initialize = () => {
      void restrictPreferenceAccess().catch(() => { /* No preferences are stored in this shell. */ });
      void getDatabase().then((database) => new CheckpointStore(database).read()).catch(() => { /* UI reports storage failures. */ });
      void getDatabase().then((database) => new ProfileStore(database).read()).catch(() => { /* UI reports bounded storage failures. */ });
      void getDatabase().then((database) => new DocumentStore(database).read()).catch(() => { /* UI reports bounded document storage failures. */ });
    };
    // Events observe only the bound tab. No activation listener can retarget it.
    const safely = (operation: Promise<unknown>) => { void operation.catch(() => { /* A subsequent UI read revalidates binding; no page writes exist. */ }); };
    browser.tabs.onRemoved.addListener((tabId) => safely(access.event(tabId, 'closed')));
    browser.tabs.onReplaced.addListener((_added, removed) => safely(access.event(removed, 'closed')));
    browser.tabs.onUpdated.addListener((tabId, change) => {
      if (change.url || change.status === 'loading') safely((async () => {
        const checkpoint = await (await store()).read();
        if (checkpoint?.target.tabId !== tabId) return;
        const verified = await access.verify(checkpoint);
        if (verified.access?.reason !== 'navigation') await access.event(tabId, 'reload');
      })());
      if (change.status === 'complete') safely((async () => {
        const checkpoint = await (await store()).read();
        if (checkpoint?.target.tabId !== tabId || !checkpoint.target.origin || checkpoint.access?.inspectedAt || !['permission', 'reload'].includes(checkpoint.access?.reason ?? '')) return;
        if (await browser.permissions.contains({ origins: [originPattern(checkpoint.target.origin, import.meta.env.DEV)] })) await access.probe({ sessionId: checkpoint.id, revision: checkpoint.revision });
      })());
    });
    browser.permissions.onRemoved.addListener((permissions) => safely(access.revoked(permissions.origins ?? [])));
    browser.runtime.onStartup.addListener(() => { initialize(); safely(access.event(null, 'restart')); });
    browser.runtime.onInstalled.addListener(initialize);
    initialize();
  },
});
