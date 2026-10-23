# applyr

Local-first assistance for job applications. **Prompts 01–10 implement local profiles/resumes, scoped page access, deterministic mapping, verified native autofill, reviewed AI mappings/drafts and durable session recovery.** Freeze a reviewed profile, inspect fields, review proposals, then use **Start Autofill**. The website may autosave filled values and attachments before submission. Consent stays manual; country-specific eligibility needs an explicit session confirmation. You control Next and final submission. AI uses minimized career evidence and requires explicit approval before insertion. Next is prompt 11 — Human intervention.

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

Form inspection tests serve F01–F10 on two loopback HTTPS origins (127.0.0.1 and localhost), using ephemeral synthetic TLS certificates. They require local `openssl`, loopback listeners and Chromium launch permission. Fixture React code is compiled in memory with the installed Vite toolchain. The extension fixture copies unchanged production JavaScript and adds a test-only install grant for 127.0.0.1. Ordinary DOM tests separately poison authentication/cookie getters and control setters; production extension uploads and separate test-driver uploads exercise only owned loopback receivers. No fixture instrumentation ships in either production build. These fixtures prove patterns, not live ATS compatibility.

Dry-run tests cover deterministic contact/name/link mappings, explicit current employment and supported preferences, exact option membership, stale/missing/conflicting facts, frozen replacements and consent/eligibility safeguards. The packaged preview tests use F01, React F02 and the owned M06 review fixture. Corrections stay in the current view until reinspection or closure. A separate reviewed diff and save changes the reusable default for future sessions; the frozen input stays unchanged. Radio groups, repeated-record selection, arbitrary prose and unsupported meanings stay manual. Unchecked preferences require review; eligibility needs explicit country/application confirmation. The preview does not fill, upload, verify website acceptance or indicate completion.

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

Only visible, application-labelled embedded frames are offered for inspection. Same-origin frames need no additional host request. A cross-origin frame requires its displayed origin and a reason. Chrome can refuse an all-frame injection if another frame is inaccessible; applyr then offers a direct-open/manual fallback without asking for broader access. Frame identity guards return before DOM inspection in unrelated frames. Detection is heuristic: custom widgets, closed shadow roots and unrecognized challenges may remain uncertain. No autofill begins in this stage.

The strict runtime allowlist covers checkpoint/target management, scoped inspection and explicit `START_AUTOFILL` / `CANCEL_AUTOFILL` intents. Every message has a version, request ID and session/revision binding (null for discovery). Runtime sender, input and response validation is mandatory. There is no generic fetch, script execution, credential access or submission command.

Database v4 keeps versioned checkpoints, profiles, document metadata, document blobs and document links in extension-origin IndexedDB, with separate provider settings and explicitly remembered credential stores. The checkpoint contains sanitized target metadata and bounded operation intents/results; raw answers, filenames and bytes are absent from the ledger. Frozen profile inputs and selected PDFs use their separate stores. Reads never renew the seven-day expiry. Invalid/expired records are purged on startup/access; a closed browser cannot physically delete data. Source tab IDs are references, not durable authority: operations independently validate target/frame/document/revision and permission, and restart never automatically resumes writes. No personal data or provider keys belong in ordinary preferences or content bundles.

Firefox declares `required: ["personallyIdentifyingInfo"]` for candidate-to-site fields/resumes and optional `authenticationInfo` / `websiteContent` for explicitly requested BYOK provider testing and AI context sharing. Firefox native consent remains unverified. CSP allows only the three bundled provider HTTPS origins; there are no install-time host grants. Candidate AI dispatch checks native website-content consent independently from the synthetic test.

The latest `web-ext` development launcher currently brings an upstream `node-forge` advisory. See the handoff for the exact audit and release limitation; shipped runtime dependencies audited clean. Do not apply npm's suggested downgrade to obsolete tooling automatically.

The current implementation includes deterministic native autofill/upload verification and optional AI preparation with explicit batch approval. The next task is **11 — Human intervention**.

## Read-only field inspection

Invoke applyr on the application, then choose **Inspect fields** in the application-page section. If several forms are plausible, choose the displayed form. Review labels, fieldset context, required/native validation, constraints, choices and existing-value presence. Existing values are represented only by document-salted fingerprints; raw answers, credentials and filenames are not displayed or persisted by inspection.

Select an embedded application in **Inspection context** after granting its displayed origin using the frame-access action. Inaccessible frames, opaque/closed custom roots, canvas, rich text, locked controls and unverified widgets stay manual. Open roots are inspected within fixed bounds. Declarations, sensitive questions and missing semantics are flagged for review; submit/Next/finalization controls are excluded.

Snapshots live in memory, are point-in-time observations and clear when the checkpoint changes. Reinspect after editing, rerendering, navigating or completing a manual gate. At least two observation intervals and a quiet final comparison are required, with at most four scans, a 1.2-second scan-start deadline and a 100-record mutation stop; loops produce an unstable snapshot. No observer runs indefinitely. Freeze a reviewed profile before inspection to generate the dry-run mapping preview. Inspection itself performs no writes. Start Autofill separately authorizes deterministic native operations and optionally the selected session resume. Optional AI proposals use the separate reviewed flow below. Automatic submission remains unavailable.


## Deterministic autofill and uploads

Start Autofill fills only proposals rederived from the frozen input and explicitly reviewed session answers. Existing answers/user edits are preserved. Narrow operations cover text, email, telephone, URL, number, date/month, native single select, radio groups with explicit semantics, ordinary checkbox and textarea. Unknown meaning, repeated records, consent, demographics, custom controls and hidden file pickers remain manual. Supported DOM operations do not imply every question has a deterministic mapping.

Each write checks target/frame/document/revision, live field identity and the unchanged-value precondition. Native setters and bounded event/render readback distinguish accepted, rejected, unverified, user-change skips and unsupported results. Required questions and site errors remain visible. Observations are bounded; later site changes need reinspection.

To include a resume, start its local document session, reinspect and select **Include this resume** before Start Autofill. Exactly one visible compatible native resume input is eligible. Ordered JSON byte chunks (64 KiB, 10 MiB aggregate) are scoped to the operation/session/frame; SHA-256 and selected-file bytes are verified. Selection and site acceptance are separate: generic uploads with no dependable acceptance evidence remain **unverified**, while observed delayed rejection is **rejected**. Hidden/custom pickers, mismatched types, ignored synthetic events and ambiguous resume inputs need manual upload. No live ATS support claim is made.

Intents/results persist in the seven-day local checkpoint before/after effects; repeated/in-flight operations are deduplicated. Lost upload replies trigger inspection/observation, never an automatic reupload. Interrupted operations do not auto-resume after worker/browser restart. Durable recovery requires explicit reinspection and, after restart, matching-target reattachment. Cancel prevents later writes, clears pending byte buffers and releases temporary inputs; values or uploads already delivered to the website remain there. Review results on the website and use Next/final submission yourself.

Automated evidence uses bundled Chromium with one test-only loopback install grant. Brave/Edge/Firefox runtime and native permission/consent dialogs remain unverified; browser builds alone do not establish runtime support.

## Optional native provider configuration (prompt 08)

Open Settings & privacy → Optional AI providers. Choose OpenAI, Gemini or Claude, enter your account’s exact model ID and personal key, then save. Claude workspace ID is required for keys not scoped to a single workspace. No model name or capability is guessed, and no call runs when settings opens. Deterministic autofill continues without a key.

Keys use trusted browser session storage by default. The unchecked Remember option explicitly stores a nonsynced copy in extension-origin IndexedDB. These stores are not encrypted vaults and browser/device/extension compromise can expose a key. Remove key or Revoke AI consent clears both copies, clears candidate consent and aborts pending work locally; delivered requests may still be processed or billed.

Test connection is a deliberate, potentially billable, synthetic structured-output task on your own account. It sends no candidate/profile/PDF/page data, and cannot verify billing tier or remaining quota. All providers remain unverified until that test actually succeeds; this repository’s fixtures mock the privileged transport and establish no live-provider compatibility. Model entry stays available without listing. Candidate-data consent is separate for each saved provider/model, and Gemini requires an active paid-service confirmation. Optional candidate-data requests now use the task-specific minimization and approval flow described below.

Requests use fixed native endpoints with header-only credentials, exact host grants, rejected redirects, a 25-second deadline, bounded output and redacted errors. Synthetic connection probes can retry transient HTTP 429/5xx at most twice inside that deadline; candidate requests make one attempt, and uncertain network/timeouts, refusal and invalid output require deliberate user retry. No paid repair, provider/model fallback, proxy or arbitrary compatible endpoint exists. Provider retention is account/terms dependent; stateless flags and local deletion do not guarantee remote erasure. See [provider strategy](planning/LLM_PROVIDER_STRATEGY.md) and [prompt-08 evidence](planning/evidence/prompt-08/sources.md). Next: prompt **11**.

### Optional AI preparation (prompt 09)

Inspect a stable form with a frozen profile, then open **Optional AI assistance**. AI defaults to Off. Configure a provider, save candidate sharing consent and run its explicit synthetic test in Settings first. Select ambiguous fields; select displayed career evidence for each wording draft and optionally enter a bounded role excerpt/word limit. Requests use your saved provider/model and may incur account charges.

Review each source and suggested mapping or draft. Edit the source/option or wording, choose Approve/Reject per field and acknowledge the factual/length review, then apply the batch decisions. Fresh field/input/permission checks precede each approved insertion. Results remain current-step observations; you use Next and submit on the website. The site may autosave approved values. No generated text becomes a reusable profile fact or carries into another job.

Only bounded scalar career evidence is eligible for AI in this milestone; missing/conflicting facts, contact/identity, consequential declarations/demographics and unsupported controls stay manual or deterministic. Provider failures offer explicit retry of selected tasks or Continue without AI and preserve completed field results. No silent provider/model switch, output repair or whole-profile resend. Unconsumed review batches are ephemeral and clear on reinspection/view/worker loss. Consumed decisions and operation recovery data are durable temporary session records, without automatic replay. Native provider tests remain mocked in automated validation; live compatibility is unverified until your explicit synthetic test succeeds.

Session recovery now persists lifecycle, phase, input versions, approvals, operation intents/results and expiring execution leases. Pause waits for a safe operation boundary. Resume reinspects and returns to queued; use Start explicitly for further writes. Cancel/finish release temporary input copies; delivered site values/uploads and provider requests cannot be recalled. Final-review scope and “I submitted it” are explicit user reports, never inferred from navigation.

Worker interruption never replays a write or a possibly billed AI call. Recovery observes the same document's current values/upload bytes; missing/remounted controls remain unverified. Browser restart requires a user-selected exact matching target, permission verification and inspection. Other saved job ledgers remain available, but restoring one requires input reselection and never resumes automatically. Missing profile/PDF bytes require reselection; missing provider session keys require Settings/retesting or continuing without AI. Candidate provider requests make one transport attempt; retry is explicit.
