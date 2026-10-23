# applyr

Local-first assistance for job applications. **Prompt 01 implements the extension shell only.** Profile parsing, resumes, page inspection, autofill and provider integrations are not implemented. The original specification and sequential prompts are in [planning/](planning/README.md); the current handoff is [IMPLEMENTATION_STATUS.md](planning/IMPLEMENTATION_STATUS.md).

## Local setup

Use **Node.js 24 LTS** (latest supported patch) and npm. `.nvmrc` selects that major; the project was verified with Node 24.19.0 and npm 11.17.0. Dependencies are pinned in `package-lock.json`.

```sh
nvm use
npm ci
npm run dev
```

`dev` starts WXT's Chromium MV3 development build and browser launcher. Use a disposable browser profile for development. For Brave, copy `.env.example` to `.env`, set `BRAVE_BINARY` to the executable on your machine, and run:

```sh
npm run dev:brave
```

The script requires a real executable, not an application directory; there is no machine-specific path in source. Alternatively, export `BRAVE_BINARY` in your shell. For Firefox 140+, optionally set `FIREFOX_BINARY` in `.env`, then run:

```sh
npm run dev:firefox
```

Only local browser overrides belong in `.env`. **Do not put provider keys or candidate data in build configuration**; environment values can be bundled into extension code. `.env` and WXT's personal `web-ext.config.ts` are ignored by Git. No backend or account is required. WXT's live-reload build adds development-only localhost connectivity; use production outputs below for permission review and smoke tests.

## Verify

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run build:firefox
npm run check:manifests
# Or run the above in order:
npm run check

# One-time test-browser download:
npx playwright install chromium
npm run test:shell
```

The shell test launches **real Playwright Chromium**, loads `.output/chrome-mv3` with a fresh temporary persistent profile, and operates the actual packaged UI. It checks source capture, the panel-opening click, packaged-tab UI, popup reopening, browser restart, checkpoint removal, message rejection, empty preferences and absent optional origin grants. It rejects HTTP(S) page traffic and asserts no observed HTTP(S) requests. There are no providers or form actions in production source. The test opens the popup HTML as an inactive extension tab so the original source tab stays active; it does **not** automate the native toolbar dropdown. Its source tab is `about:blank`, so it verifies a real tab reference rather than HTTPS activeTab access. The test profile is removed afterward. Screenshot and runtime evidence are attached to Playwright results; none use personal data.

Vitest tests use in-memory IndexedDB and mocked surface APIs. They verify schemas, sender checks, migration from an empty database, reopen/expiry/purge, compare-and-swap races, bounded errors and browser-specific fallback. They are distinct from the real browser test. Future database upgrades must add a numbered migration and preserve or deliberately invalidate older records.

## Load production builds manually

**Brave / Chromium**

1. Run `npm run build`.
2. Open `brave://extensions`, enable Developer mode and choose **Load unpacked**.
3. Select `.output/chrome-mv3` (the directory containing `manifest.json`).
4. Pin applyr, open an intended HTTPS application page, and click the toolbar icon.
5. The popup captures that source tab and saves a setup checkpoint. Choose **Open session** to open a side panel; a rejected/unavailable panel opens the packaged session tab. **Open in tab** is always available.
6. Close and reopen the popup/session and confirm the same checkpoint. Switch source tabs and use **Use this tab** explicitly to replace it. Settings offers **Forget setup checkpoint**.

**Firefox temporary installation**

1. Run `npm run build:firefox` with Firefox 140 or newer available.
2. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `.output/firefox-mv3/manifest.json`.
3. Open applyr from a page, then choose **Open session** for the Firefox sidebar or packaged-tab fallback. Verify capture, reopen and deletion as above.
4. Temporary add-ons are removed on Firefox restart. A signed release is a later publication step; this output is unsigned. Firefox event-page/sidebar behavior requires its own runtime checks.

These are instructions, not claims that manual Brave/Firefox checks ran. Actual checks and browser versions are recorded separately in the handoff.

## Boundaries and permissions

`entrypoints/` contains WXT background, popup, options and a shared `session.html` used for both panels and tab fallback. `src/domain` is pure TypeScript; `src/runtime` owns Zod contracts and the coordinator; `src/security` validates exact packaged sender URLs/extension IDs; `src/browser` adapts browser APIs; `src/storage` owns versioned IndexedDB; `src/ui` renders React. Branding and extension metadata live in `src/branding.ts`.

Production manifests are explicit MV3 variants: Chromium service worker plus `side_panel`; Firefox nonpersistent background scripts plus `sidebar_action`, minimum 140. Both declare `activeTab`, `scripting` and `storage`; Chromium also declares `sidePanel`. HTTPS origins and notifications are **optional eligibility only**. No host permission is granted at installation, no content script is registered, and no permission request is implemented yet. Browser API presence is feature detection, not a verified Brave/Edge compatibility claim.

The current allowlist is only `GET_STATE`, popup-only `CAPTURE_TARGET` and revision-bound `FORGET_CHECKPOINT`. Every message has a version, request ID and session/revision binding (null for discovery). Runtime sender, input and response validation is mandatory. There is no generic fetch, script execution, credential access or submission command.

The coordinator stores one schema-v1 setup checkpoint in IndexedDB: random ID, source tab/window, HTTPS origin if available, setup phase and expiry. It deliberately omits page title, credentials, path/query/fragment, profile data and files. Reads never renew the seven-day expiry. Invalid/expired records are removed on startup and access; a closed browser cannot physically purge data. Source tab IDs are references, not durable authority: later prompts must rebind after restart and validate page/frame/revision before operations. No ordinary preferences are stored; Chromium local-storage access is restricted to trusted contexts where supported. No personal data or provider keys belong in ordinary preferences or content bundles.

Firefox currently declares `required: ["none"]` because this shell does not transmit data outside the extension. Before candidate-to-site features or AI requests ship, audit real payloads and update required/optional categories and consent handling according to `planning/SECURITY_PRIVACY.md`. No provider traffic is permitted by the production `connect-src 'none'` CSP; future provider work must deliberately revise this boundary.

The latest `web-ext` development launcher currently brings an upstream `node-forge` advisory. See the handoff for the exact audit and release limitation; shipped runtime dependencies audited clean. Do not apply npm's suggested downgrade to obsolete tooling automatically.

Stop at this foundation. The next implementation task is **02 — Candidate profiles**.
