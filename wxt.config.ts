import { defineConfig } from 'wxt';
import { fileURLToPath } from 'node:url';
import { branding } from './src/branding';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  imports: false,
  vite: () => ({ resolve: { alias: {
    // micromark's browser decoder needs document at module load. Use its official
    // non-DOM export in every bundle, including Chromium's service worker.
    'decode-named-character-reference': fileURLToPath(import.meta.resolve('decode-named-character-reference')),
  } } }),
  hooks: {
    'build:manifestGenerated'(wxt, manifest) {
      manifest.action = { ...manifest.action, default_title: branding.name };
      // WXT regenerates background after merging manifest options. Make MV3 event-page intent explicit.
      if (wxt.config.browser === 'firefox' && manifest.background && 'scripts' in manifest.background) {
        manifest.background.persistent = false;
      }
    },
  },
  webExt: {
    binaries: {
      ...(process.env.BRAVE_BINARY ? { chrome: process.env.BRAVE_BINARY } : {}),
      ...(process.env.FIREFOX_BINARY ? { firefox: process.env.FIREFOX_BINARY } : {}),
    },
  },
  manifest: ({ browser, mode }) => ({
    name: branding.name,
    description: branding.description,
    permissions: ['activeTab', 'scripting', 'storage', ...(browser === 'firefox' ? [] : ['sidePanel'])],
    optional_permissions: ['notifications'],
    optional_host_permissions: ['https://*/*', ...(mode === 'development' ? ['http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*'] : [])],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; connect-src https://api.openai.com https://generativelanguage.googleapis.com https://api.anthropic.com" },
    ...(browser === 'firefox'
      ? {
          background: { scripts: ['background.js'], persistent: false },
          sidebar_action: { default_panel: 'session.html', default_title: branding.name, open_at_install: false },
          browser_specific_settings: {
            gecko: {
              id: branding.firefoxId,
              strict_min_version: '140.0',
              // Core filling transmits the user-selected identity/contact/resume to the bound site.
              data_collection_permissions: { required: ['personallyIdentifyingInfo'], optional: ['authenticationInfo', 'websiteContent'] },
            },
          },
        }
      : {
          background: { service_worker: 'background.js' },
          minimum_chrome_version: '116',
          side_panel: { default_path: 'session.html' },
        }),
  }),
});
