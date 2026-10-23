# applyr

Local-first assistance for job applications. **Prompts 01–04 implement the extension shell, candidate profiles, local resume documents and scoped read-only page access.** Profile setup, safe Markdown import/export, explicit reusable defaults, versioned session inputs and PDF recovery work locally without AI. The page probe classifies the bound application without filling fields. Real-page autofill and provider integrations are not implemented.

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

The shell tests launch **real Playwright Chromium** with disposable persistent profiles and operate the actual packaged UI. They retain profile/PDF lifecycle, byte preservation, source capture, panel opening, restart, deletion and message-boundary regressions. Page-access tests use intercepted fictional HTTPS fixtures and a temporary copy of the production build with one fixture-only install host grant; they exercise the isolated-world probe, manual opening, similar jobs, unrelated tabs, embedded-frame denial and closure. A separate ordinary-page test poisons input-value/cookie getters to verify read-only classification. These checks do **not** automate the native toolbar activeTab grant or a native optional-permission dialog. Exact-origin request timing/grant/denial and revocation are covered with owned API mocks. Profile/shell tests block all HTTP(S); the native upload spike permits only its loopback receiver. Page-access fixtures are intercepted and provider traffic is asserted zero. Screenshot and runtime evidence are attached to Playwright results; none use personal data.

Vitest uses in-memory IndexedDB and mocked surface APIs for storage/surface tests, and the actual YAML/Markdown libraries for parser tests. It covers both supplied examples, every v1 field, null/false/absence, malformed/oversized input, YAML restrictions, unknown-key repair, credentials, answer sections/references, dates, eligibility conflicts, v1→v2 migration, default/session isolation, expiry and compare-and-swap races. It also preserves foundation sender and surface checks. They are distinct from the real browser test. Future database upgrades must add a numbered migration and preserve or deliberately invalidate older records.

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

## Candidate profiles

Open **Settings & privacy** to create a blank working profile or import one UTF-8 `.md` file (max 256 KiB). All sections are optional. Each field distinguishes not supplied, unknown (`null`) and an explicit value; boolean choices include yes/no. Education, experience, projects, skills, links, eligibility and reusable answers support repeatable records. Names are never split. Use stable IDs for record references and `YYYY-MM`/`YYYY-MM-DD` for dates; review/confirmation dates require the full date.

Choose **Validate profile** to see a plain-text preview, then **Download Markdown** or explicitly **Save as default**. Import first shows a validation preview; unknown fields block it until repaired or explicitly removed one at a time. Custom YAML tags, anchors/aliases, merges, duplicate keys/IDs, unresolved references, invalid dates and obvious credential keys are rejected. HTML/links/images remain inert text. Blank and visibly fictional examples are downloads only and never become the user's profile automatically. Imported facts remain user assertions; no PDF facts or authorization are inferred.

In the session view, **Preview saved default** or import/edit a whole replacement. **Freeze profile for this session** explicitly saves a seven-day temporary recovery copy; **Refresh frozen profile** deliberately creates a new input version and requires future reinspection. Missing replacement fields remain unknown. Editing the saved default affects future selections, while existing frozen profiles remain unchanged. **Propose profile update** shows the saved default and proposed content with changed paths; only **Save proposed default** changes persistent data. No AI, page inspection or autofill starts from these actions.

Unsaved edits stay in the persistent UI tab until saved/frozen or closed. Defaults remain in extension-origin IndexedDB until deleted. Confirming profile deletion clears the default, frozen recovery copies and open applyr working copies; downloaded exports are plaintext files under the user's control. Reads do not renew recovery. Nothing is stored in ordinary preferences, sent to a provider or passed to a website. Local browser storage is not an encrypted vault.

## Boundaries and permissions

`entrypoints/` contains WXT background, popup, options and a shared `session.html` used for both panels and tab fallback. `src/domain` is pure TypeScript; `src/runtime` owns Zod contracts and the coordinator; `src/security` validates exact packaged sender URLs/extension IDs; `src/browser` adapts browser APIs; `src/storage` owns versioned IndexedDB; `src/profile` owns the shared v1 schema, parser/exporter and provenance; `src/ui` renders React. Branding and extension metadata live in `src/branding.ts`.

Production manifests are explicit MV3 variants: Chromium service worker plus `side_panel`; Firefox nonpersistent background scripts plus `sidebar_action`, minimum 140. Both declare `activeTab`, `scripting` and `storage`; Chromium also declares `sidePanel`. HTTPS origins and notifications are **optional eligibility only**. No host permission is granted at installation and no content script is registered. Explicit page/frame actions request only the displayed exact origin; notifications remain off. Development builds additionally allow HTTP loopback fixtures; release builds reject them. Browser API presence is feature detection, not a verified Brave/Edge compatibility claim.

## Page selection and access

The popup captures its original tab before opening another extension surface. The session displays a sanitized URL/title, best-effort role/company and explicit unknowns. **Edit display metadata** changes labels only. Switching tabs does not change the binding. **Inspect bound page** reads bounded relevant form metadata, classifying application, careers listing, login/challenge, irrelevant, restricted or uncertain. It reads no input values, passwords, OTPs, hidden fields or cookies and performs no fill/upload/submit actions.

**Open application** validates HTTPS, requests that exact origin during the click and creates a new tab and session binding. If permission is denied, invoke applyr on the new tab; access from the original tab is never transferred. This deliberate new binding releases previous temporary session inputs; saved defaults require explicit reselection. Navigation, reload, closure and revoked access leave visible attention guidance. A changed job, including on the same origin, requires a separate attachment through **Use this tab**. Restricted pages still allow settings and local input management.

Only visible, application-labelled embedded frames are offered for inspection. Same-origin frames need no additional host request. A cross-origin frame requires its displayed origin and a reason. Chrome can refuse an all-frame injection if another frame is inaccessible; applyr then offers a direct-open/manual fallback without asking for broader access. Frame identity guards return before DOM inspection in unrelated frames. Detection is heuristic: custom widgets, shadow DOM and unrecognized challenges may remain uncertain. No autofill begins in this stage.

The current allowlist is only `GET_STATE`, popup-only `CAPTURE_TARGET` and revision-bound `FORGET_CHECKPOINT`. Every message has a version, request ID and session/revision binding (null for discovery). Runtime sender, input and response validation is mandatory. There is no generic fetch, script execution, credential access or submission command.

Database v2 preserves the schema-v1 checkpoint and adds a separate profiles store. The coordinator stores one setup checkpoint: random ID, source tab/window, HTTPS origin if available, setup phase and expiry. It deliberately omits page title, credentials, path/query/fragment, profile data and files. Reads never renew the seven-day expiry. Invalid/expired records are removed on startup and access; a closed browser cannot physically purge data. Source tab IDs are references, not durable authority: later prompts must rebind after restart and validate page/frame/revision before operations. No ordinary preferences are stored; Chromium local-storage access is restricted to trusted contexts where supported. No personal data or provider keys belong in ordinary preferences or content bundles.

Firefox currently declares `required: ["none"]` because this shell does not transmit data outside the extension. Before candidate-to-site features or AI requests ship, audit real payloads and update required/optional categories and consent handling according to `planning/SECURITY_PRIVACY.md`. No provider traffic is permitted by the production `connect-src 'none'` CSP; future provider work must deliberately revise this boundary.

The latest `web-ext` development launcher currently brings an upstream `node-forge` advisory. See the handoff for the exact audit and release limitation; shipped runtime dependencies audited clean. Do not apply npm's suggested downgrade to obsolete tooling automatically.

Stop after candidate profiles. The next implementation task is **03 — Documents**.
