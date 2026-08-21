# Manga Studio — Verified Project State

Last updated: 2026-08-21 (semantic transparency cascade and Background Removal BYOK)

## Current status

| Area | Status | Verified reality |
|---|---|---|
| Core domain architecture | WORKING LOCALLY | Schema v6 adds first-class asset lifecycle/provenance and a semantic Panel Scene for every panel. Source assets remain distinct from instances; older projects migrate forward and rebuild scenes. |
| Canonical Command Layer | WORKING LOCALLY | Persistent manual UI actions and every Agent tool dispatch the same typed commands. Live gestures use command-backed transient previews. No component, Agent, Character, asset, or AI client directly calls the legacy `commit` mutation path. |
| Asset and Character lifecycle | WORKING LOCALLY | Rename, archive/restore, regenerate-and-replace, reference-aware asset deletion, state removal, Character deletion with explicit asset policy, background removal, and prop removal are implemented. Used-source deletion refuses an implicit unsafe operation. |
| Semantic scenes and composition | WORKING LOCALLY | Panel scenes track exact background identity, location, Character roles/position/facing/depth, relationships, dialogue, and continuity. Agent composition reuses cached Character states and exact scene backgrounds before generation. |
| Agent validation | WORKING LOCALLY | Plan/runtime scope checks are followed by structural before/after scope auditing and panel composition validation. Tiny/off-panel Characters are safely corrected; unresolved missing/occluded content remains visible as validation warnings. |
| Agent planning reliability | DEPLOYED | The exact Panel 2 prompt returned a streamed plan in 77 ms of route work against the local Qwen-compatible fixture. Planning has a 25 s application deadline, safe stage timings, streamed content/tool-call parsing, Qwen hybrid non-thinking mode, and controlled timeout/provider/parser/validation failures. Production is live; real Qwen acceptance still requires the user's browser-held BYOK session. |
| Image generation | PARTIAL | The previously failing production request reached provider result handling, then failed while persisting the returned image because Vercel Blob was not connected. The fixed production handler emits request-scoped stage traces and Blob is connected; a fresh real BYOK generation still requires the user's configured browser session. |
| Gemini adapter | WORKING AT ADAPTER/UNIT LEVEL | Gemini declares reference/image-edit support but not native transparency. The adapter now performs provider-specific second-pass cutout requests through `generateContent`; returned bytes must pass real-alpha validation. Tests cover generation, references, edit serialization, malformed/missing images, HTTP failures, timeout, and secret redaction. |
| BYOK credential storage | CONFIGURED | User credentials remain encrypted in HttpOnly cookies. `APP_ENCRYPTION_KEY` is an operator infrastructure secret configured once in Vercel for Preview and Production; users do not configure it. Trace tests verify successful retrieval/decryption and the missing-key failure path without logging secrets. |
| Character reference persistence | PARTIAL | Accepted uploads and accepted generated results become Character assets; the first character asset becomes the reference. Project JSON persists in IndexedDB. Production refresh verification remains to be rerun after deployment. |
| Production asset storage | CONFIGURED | Public Vercel Blob store `manga-studio-assets` is connected to the existing `personal-b90d/mangaharness` project in `iad1`; the Blob credential is injected into Development, Preview, and Production. |
| Character upload UX | WORKING LOCALLY | Browser verification confirmed the native input is hidden; click-to-browse shows a real PNG preview and dimensions; Replace/Remove render; Remove restores the drop zone; provider absence shows `Connect Image Model`; no console error or Next.js overlay was present. Drag/drop uses the same selection path. |
| Provider diagnostics | WORKING LOCALLY | Safe structured logs cover request parsing, validation, credential lookup/decryption, provider routing, adapter creation, normalized request construction, outbound start/response status, parsing, and persistence. The UI can show safe provider/model/HTTP/stage/request-ID details. |
| Virtual character state | DEPLOYED | Placed characters carry independent pose, expression, outfit, and view fields. The shared resolver reuses only exact full-state matches, uses a compatible render as optional generation guidance, generates missing combinations against the canonical identity reference, and swaps the source without changing composition. |
| Character starter pack | DEPLOYED | New characters default to Asset Pack (1 canonical reference, 8 neutral-expression poses, 7 additional expressions = 16 generations without an uploaded reference) with Reference Only, itemized progress, cache skipping, and cancel-remaining behavior. Completed assets are retained. |
| Agent character editing | DEPLOYED | `set_character_slot` uses the same resolver as the Inspector and preserves all unspecified state fields. Pose, expression, outfit, and view are supported. |
| Agent execution scope | DEPLOYED | Every run captures an immutable typed scope with priority Selected Object → Selected Panel → Current Page → Whole Project. Explicit page/project language can widen Auto scope. The scope is included in context and planning, attached to the plan preview, validated server-side, and rechecked immediately before every tool call. Selected-panel plans cannot change layout, directly place loose workspace assets, or mutate another panel. |
| Agent character placement | DEPLOYED | The preferred `place_character` tool resolves the Character entity by ID/name and state assets through `metadata.characterId` plus requested pose/expression/outfit/view fields. Asset display names are not identity. Exact requested semantics reuse cache; unspecified dimensions prefer neutral/default state; missing states generate once and become reusable library assets. |
| Project Art Style | DEPLOYED | Schema v4 persists one active provider-neutral StyleProfile per project plus custom profiles. All 32 requested built-in substyles contain real positive/negative prompt logic and semantic visual properties. Changing style leaves existing assets untouched. |
| Visual style selection | DEPLOYED | The Top Bar shows the active style. The visual Art Style dialog presents six major families, generated preview cards, active-state feedback, and custom style creation with optional uploaded reference. |
| Style propagation | DEPLOYED | Manual generation, canonical character references, semantic character states, progressive Asset Packs, backgrounds, props, and Manga Agent generations all inherit the active style, negative prompt, optional style reference, and immutable asset-level style provenance. |
| Character identity UX | DEPLOYED | Character creation separates Name, Appearance, and Personality / visual identity from Project Art Style. The progressive Asset Pack contains eight poses and eight expressions without a Cartesian-product explosion. |
| Transparent character assets | DEPLOYED; EXACT PROVIDER ACCEPTANCE PENDING | Generated/uploaded character and prop sources use an ordered cascade: native alpha → image-provider edit → dedicated removal provider → conservative local fallback. Every candidate is decoded and checked for meaningful alpha, visible foreground, background removal, and usable bounds before a derivative is promoted. |
| Background removal | DEPLOYED | Background Removal is an independent BYOK capability with its own encrypted cookie, remove.bg Quick Preset, Custom API mapping, safe logs/errors, and optional deployment fallback. Manual recovery offers Retry, Image AI, provider selection, Keep Raw, and safe Details. |
| Agent Character readiness | DEPLOYED | Planner context, semantic resolution, slot switching, placement, and composition exclude raw/processing/failed Character derivatives. Generation stores a failed raw source for retry but fails the step; a following composition step reports that reprocessing is required. Activity exposes generation, removal, validation, and ready/composed phases. |
| Canvas compositing | DEPLOYED | Library previews, generation references, loose objects, panel instances, ghosts, and export share `assetRenderUrl`; only a `ready` derivative with validated alpha supersedes the immutable source. Background images remain rectangular. Live canvas and exported-PNG acceptance passed. |

## Root cause record

Production log for the observed `/api/generate` 500:

```text
Generation failed: Persistent storage is not configured. Connect a Vercel Blob store to this project.
```

Exact throw site: `src/storage/objectStore.ts`, `putLocal()`, called by `putObject()` from `src/ai/generate.ts` after provider image bytes were returned. `APP_ENCRYPTION_KEY` was not the thrown exception and is currently configured. The historical deployment lacked `BLOB_READ_WRITE_TOKEN`.

Production log for the observed `/api/agent` 500:

```text
Agent planning failed: Timed out
```

Exact cause: `src/server/customApi/execute.ts` armed its historical `REQUEST_TIMEOUT_MS = 90_000` timer for the user-configured Custom API call. The external POST began, but no response headers/body reached Manga Studio before that application timer aborted fetch. `CustomApiError("Timed out", 504)` escaped the adapter's conversion boundary and the route collapsed it to a generic 500. The route is Node with `maxDuration = 120`; Vercel did not terminate it at 90 seconds. There is no evidence that Qwen returned a response, so response parsing and post-processing did not begin.

Earlier production evidence for a previous Cute Girl checkerboard:

```text
[generate] provider_response_received 200
[generate] asset_post_processing_complete status=failed hasAlpha=false backgroundRemoved=false
```

That earlier detector-only failure was replaced by the built-in connectivity matte and remains a valid historical record. It is not evidence that every checkerboard image is safely segmentable.

Latest exact production failure (request `21f2a2ac-f572-4298-8e0f-e15e2910b368`) loaded the current Cute Girl source `source-b6810c8c-b3a6-4ffe-be6f-0968b6cd8cda-…jpg`, 546,997 bytes, 848×1264, SHA-256 `311ad513a4ef2203e7bb583e2028d07b76174b1cc2eb171e3a4ae482a373e34e`, and returned HTTP 422 after about one second in the processor. The JPEG has no alpha. Its light checker cells overlap the subject's white clothing, skin, grayscale shading, and anti-aliased line art, leaving no safe deterministic foreground seed. Local replay of those exact unchanged bytes reproduces the guarded failure. This is algorithmic, not a Sharp/Vercel runtime exception. The new pipeline therefore refuses threshold tuning and attempts semantic provider editing/segmentation before the local fallback.

## Known limitations

- Project documents are browser-local IndexedDB data; there is no authenticated cross-device project sync in the MVP.
- BYOK provider profiles are per browser cookie and limited to one active provider per capability.
- Gemini character consistency remains provider-dependent. Flash Lite accepts image input but is not optimized for multiple reference inputs; Manga Studio currently sends at most three storage references.
- The generator uses the `generateContent` adapter surface. Google currently promotes the newer Interactions API for image workflows, but the existing surface is retained until production evidence requires a migration.
- Production Character creation, refresh persistence, and derived pose/expression generation must be recorded here only after the new deployment is exercised with the user’s BYOK session.
- Starter-pack generation is sequential and cancellation stops remaining work after the currently active provider request finishes; it does not abort a request already in flight.
- Built-in style cards currently use reusable generated placeholder previews; `previewImage` and custom reference fields allow real preview artwork to be added without changing the style architecture.
- Style interpretation remains provider-dependent. Semantic style prompts and negative prompts are provider-neutral; adapters may support richer style controls later.
- The bundled extractor is deterministic rather than semantic ML and remains last-resort only. The latest exact Cute Girl proves that low-contrast light checkerboards overlapping pale manga artwork require a capable image-edit or segmentation provider. Every uncertain result fails safely and preserves the source.
- Whole Project scope is represented and enforced, but current agent tools still address panels on the active page; cross-page tool addressing remains future work.
- Archived sources remain visible in panels that already use them, by design, but are excluded from new library/Agent/Character-state resolution until restored.
- A real production Manga Agent run with the user's BYOK session is still required to record provider-side planning and generation evidence for the exact Yuri/Panel 1 prompt.
- The exact Mio/Panel 2 production acceptance remains dependent on the user's browser-held BYOK cookie. Clean CLI/browser verification cannot impersonate or extract that HttpOnly credential.

## Verification ledger

- Typecheck: passed.
- Lint: passed.
- Tests: 34 files, 199 tests passed. Transparency coverage includes cascade ordering, native-alpha short circuit, Gemini edit serialization, opaque edit fallthrough, dedicated-provider validation, remove.bg multipart/auth behavior, local-last fallback, total failure, processed URL preference, manual reprocessing, and Agent wait-for-ready behavior. Existing lifecycle, provider/security, compositing, scene, scope, and command coverage remains intact.
- Exact-current-fixture characterization: passed locally against the unchanged 546,997-byte 848×1264 source (`311ad…34e`). It remains `failed`, `hasAlpha=false` with local-only processing, which is the correct non-destructive result; no local-threshold success is claimed. Provider-backed production reprocessing remains the acceptance gate.
- Local browser verification: passed. The editor rendered meaningful controls, no framework overlay/page errors appeared, and AI Settings exposed independent Manga Agent, Image Generation, and Background Removal sections with both Custom API and Quick Preset modes.
- GitHub semantic-segmentation commit: `cedd52e` on `refactor/controlled-core-architecture`, pushed to `origin`.
- Production semantic-segmentation deployment: READY, `dpl_6PF2xHfT5hCDbZertz4amgJffRfv`, built in `iad1` from commit `cedd52e` and aliased to `https://mangaharness.vercel.app`.
- Production clean-session verification: passed. Home and `/api/provider/status` returned successfully; storage remained `vercel-blob`; the live AI Settings rendered the Background Removal Custom API and Quick Preset modes; no framework overlay, browser page error, or error-level Vercel log was found.
- Current exact Cute Girl production acceptance: pending a session-bound provider attempt. The clean verifier correctly reported no Image or Background Removal provider, and the user's Chrome session was not connected to Codex, so its encrypted HttpOnly BYOK cookie could not be used or inspected. No claim is made yet for provider HTTP status, transparent derivative, same-asset Canvas refresh, or checkerboard-free export for SHA-256 `311ad…34e`.
- Production build: passed with Next.js 15.5.23.
- Historical fixture verification (not the latest failing source): the earlier 848×1264 Cute Girl canonical/jumping JPEGs were locally converted to validated derivatives. This does not supersede the current 546,997-byte failure recorded above.
- Checkerboard-removal production deployment: READY, `dpl_546yQrY4SrS8LWheJ9bgunfcRzva` (`https://mangaharness.vercel.app`), built in `iad1` from tested commit `a2ca901`.
- Historical existing-asset route acceptance: request `03868b20-20f6-462d-83ab-187a38250dff` repaired the earlier 710,104-byte Cute Girl source. It is retained as regression evidence only, not acceptance for the current `311ad…34e` source.
- Historical production UI/canvas/export acceptance: request `5f151390-c9bf-4d0b-bf5a-231cf4396792` repaired and composed the earlier source. The current source still requires provider-backed production reprocessing, Canvas refresh, and export acceptance after this deployment.
- Production error scan after the exact route and browser flow: clean.
- Fresh BYOK Agent acceptance remains pending: the clean verification session correctly reported no image or agent provider, and HttpOnly user BYOK credentials were not available to automation. The original user run already proved Agent generation/provider response for this exact Cute Girl state; unit/integration coverage now proves that a failed cutout stops composition and a ready cutout permits it, but no new provider-side request is claimed.
- Local exact-prompt route acceptance: passed. With Panel 2 authoritative scope and `Suddenly, her besty's smile face jumped into the panel`, `/api/agent` returned HTTP 200; first streamed event was 16 ms after outbound start, provider completion was 57 ms, route work was 77 ms, finish reason was `stop`, and the only accepted action was `compose_character` for Mio smiling in Panel 2. No other-panel action was present.
- Local browser: passed (six style families, visual cards, built-in/custom activation, persistent Top Bar label, identity-separated character form, 16-generation Asset Pack estimate, no error overlay/console errors).
- Local controlled-core browser acceptance: passed. The app loaded with meaningful editor controls and no framework/page errors; Character creation exposed the lifecycle controls; explicit Character deletion removed the entity; after autosave and a full reload it remained deleted. The Manga Agent rendered its authoritative scope control (`Auto · Current Page · Page 1`).
- Local transparent-compositing acceptance: passed with a real opaque white-background Yuri upload over a colored street, panel placement, scaling, clipping, and page export. Export pixels beside Yuri remained street blue (`118,181,212,255`) while the enclosed white shirt remained opaque (`255,255,255,255`); no white rectangle or browser errors.
- Local agent acceptance: passed. With Panel 1 selected, a background, cached Yuri Walking state, and thought bubble were added only to Panel 1; panels 2–4 remained byte-for-byte unchanged and no generation history entry was created. A separate missing-state test generated and placed a reusable Yuri state. Runtime scope rejected a panel-2 call injected after plan validation.
- Local agent UI verification: passed. Selecting Panel 1 changed the visible scope control to `Auto · Selected Panel · Panel 1`; Current Page and Whole Project overrides were available; no Next.js overlay or browser page errors were present.
- GitHub transparent-compositing code commit: `604b512` on `agent/transparent-asset-compositing` (pushed to `origin`; not merged to `main`).
- GitHub agent-scope code commit: `48bdfa7` on `agent/agent-scope-character-resolution` (pushed to `origin`; not merged to `main`).
- GitHub controlled-core refactor commit: `6b38072` on `refactor/controlled-core-architecture` (pushed to `origin`; not merged to `main`).
- GitHub art-style-system code commit: `ec0b221` on `agent/project-art-style-system` (pushed to `origin`; not merged to `main`).
- GitHub character-rig code commit: `62d01cb` on `agent/virtual-character-rig`.
- Production deployment: READY, `dpl_FV5u8P1nf7Y6MRgAogy2wbzfoRom` (`https://mangaharness.vercel.app`), deployed from the tested `604b512` feature commit.
- Production controlled-core deployment: READY, `dpl_Bc8fvck6T5DchKh74u9KoHTtAEkZ` (`https://mangaharness.vercel.app`), deployed from tested commit `6b38072` in `iad1`.
- Production controlled-core browser verification: passed. Home and `/api/provider/status` returned HTTP 200; the editor rendered meaningful controls with no framework overlay or page errors; storage remained configured as `vercel-blob`; the clean verification browser correctly reported no user BYOK provider. The deployment error-level log scan was clean.
- Production agent-scope deployment: READY, `dpl_6njJayt3mrE4HseuMXa81RPebzMQ` (`https://mangaharness.vercel.app`), deployed from tested commit `48bdfa7` in `iad1`.
- Production agent UI verification: passed. The live Manga Agent rendered `Auto · Current Page · Page 1`; selecting Panel 1 changed it to `Auto · Selected Panel · Panel 1`. The live page returned HTTP 200 with no framework overlay or browser errors.
- Production agent post-deploy error scan: clean; no error-level logs found. `/api/provider/status` confirmed Vercel Blob remains configured and correctly reported no BYOK model in the clean verification browser.
- Production post-processor verification: passed. The live character upload returned separate source/processed Blob URLs with `hasAlpha: true`, `backgroundRemoved: true`, and `processingStatus: ready`; the manual removal route also returned HTTP 200 and another transparent derivative.
- Production transparent-compositing browser acceptance: passed with opaque Yuri over the street, checkerboard library preview, manual Reprocess Background HTTP 200, panel placement, scale changed from 138% to 110%, clipping, and PNG export. Export pixel evidence matched local verification and the browser reported no console/page errors.
- Production browser verification: passed (six style families; Western Comics and Minimal Line selection; custom style creation and Top Bar activation; identity-separated character form; Asset Pack and 16-generation estimate; no console/page errors).
- Post-deploy error scan: clean; no error logs found for the new deployment.
- Production status: HTTP 200; `storage.configured: true`; backend `vercel-blob`; no new serverless errors in the post-deploy scan.
- Production trace smoke test: request `77e6fab5-da18-4fe0-b4a4-526b4a8d9bd1` logged request parsing/validation and credential lookup safely, then returned the expected 503 because the CLI request intentionally had no BYOK cookie.
- Real production generation/persistence/derived-asset test: pending a run from the user's browser session with an Image Provider connected in AI Settings.
- GitHub Agent planning stabilization commit: `e8ad19d` on `refactor/controlled-core-architecture` (pushed to `origin`; not merged to `main`).
- Production Agent planning stabilization deployment: READY, `dpl_45kzQSdNkuHjyz7t8rprDyt83R5t` (`https://mangaharness.vercel.app`), built in `iad1` from the tested `e8ad19d` source state.
- Production Agent planning clean-session verification: passed. Home and provider status returned HTTP 200; the live editor and Manga Agent rendered without console warnings/errors; storage remained configured as Vercel Blob. A deliberately cookie-free exact-prompt POST returned the expected safe 503 in 8 ms with request ID `265def54-8730-46ab-ab93-a524dcf861c9` and request/context/response trace stages. The post-deploy error-level scan was clean.
- Real production Qwen/Mio/Panel-2 acceptance: pending. The available verification browser had no BYOK session and Chrome was not connected to Codex, so no provider request was made and no claim is recorded for provider status, final response time, tool execution, or panel mutation.
