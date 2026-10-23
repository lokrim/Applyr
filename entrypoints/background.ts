import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { branding } from '../src/branding';
import { createCoordinator } from '../src/runtime/coordinator';
import { getDatabase } from '../src/storage/database';
import { CheckpointStore } from '../src/storage/checkpoints';
import { ProfileStore } from '../src/storage/profiles';
import { DocumentStore } from '../src/storage/documents';
import { targetReference } from '../src/browser/targets';
import { restrictPreferenceAccess } from '../src/browser/surfaces';

export default defineBackground({
  persistent: false,
  main() {
    const handle = createCoordinator({
      extensionId: browser.runtime.id,
      pages: {
        popup: browser.runtime.getURL(branding.pages.popup),
        session: browser.runtime.getURL(branding.pages.session),
        options: browser.runtime.getURL(branding.pages.options),
      },
      store: async () => new CheckpointStore(await getDatabase()),
      target: async (tabId) => targetReference(await browser.tabs.get(tabId)),
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
    browser.runtime.onStartup.addListener(initialize);
    browser.runtime.onInstalled.addListener(initialize);
    initialize();
  },
});
