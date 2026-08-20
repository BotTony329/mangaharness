# Manga Studio — Verified Project State

Last updated: 2026-08-20 (project-level art style system)

## Current status

| Area | Status | Verified reality |
|---|---|---|
| Image generation | PARTIAL | The previously failing production request reached provider result handling, then failed while persisting the returned image because Vercel Blob was not connected. The fixed production handler emits request-scoped stage traces and Blob is connected; a fresh real BYOK generation still requires the user's configured browser session. |
| Gemini adapter | WORKING AT ADAPTER/UNIT LEVEL | `gemini-3.1-flash-lite-image` is a current stable Google image-generation/editing model. Adapter tests cover success, reference input, malformed/missing images, HTTP 400/401/403/404/429/5xx, and timeout. The prior production exception occurred after provider invocation, not in Gemini payload construction. |
| BYOK credential storage | CONFIGURED | User credentials remain encrypted in HttpOnly cookies. `APP_ENCRYPTION_KEY` is an operator infrastructure secret configured once in Vercel for Preview and Production; users do not configure it. Trace tests verify successful retrieval/decryption and the missing-key failure path without logging secrets. |
| Character reference persistence | PARTIAL | Accepted uploads and accepted generated results become Character assets; the first character asset becomes the reference. Project JSON persists in IndexedDB. Production refresh verification remains to be rerun after deployment. |
| Production asset storage | CONFIGURED | Public Vercel Blob store `manga-studio-assets` is connected to the existing `personal-b90d/mangaharness` project in `iad1`; the Blob credential is injected into Development, Preview, and Production. |
| Character upload UX | WORKING LOCALLY | Browser verification confirmed the native input is hidden; click-to-browse shows a real PNG preview and dimensions; Replace/Remove render; Remove restores the drop zone; provider absence shows `Connect Image Model`; no console error or Next.js overlay was present. Drag/drop uses the same selection path. |
| Provider diagnostics | WORKING LOCALLY | Safe structured logs cover request parsing, validation, credential lookup/decryption, provider routing, adapter creation, normalized request construction, outbound start/response status, parsing, and persistence. The UI can show safe provider/model/HTTP/stage/request-ID details. |
| Virtual character state | DEPLOYED | Placed characters carry independent pose, expression, outfit, and view fields. The shared resolver reuses only exact full-state matches, uses a compatible render as optional generation guidance, generates missing combinations against the canonical identity reference, and swaps the source without changing composition. |
| Character starter pack | DEPLOYED | New characters default to Asset Pack (1 canonical reference, 8 neutral-expression poses, 7 additional expressions = 16 generations without an uploaded reference) with Reference Only, itemized progress, cache skipping, and cancel-remaining behavior. Completed assets are retained. |
| Agent character editing | DEPLOYED | `set_character_slot` uses the same resolver as the Inspector and preserves all unspecified state fields. Pose, expression, outfit, and view are supported. |
| Project Art Style | DEPLOYED | Schema v4 persists one active provider-neutral StyleProfile per project plus custom profiles. All 32 requested built-in substyles contain real positive/negative prompt logic and semantic visual properties. Changing style leaves existing assets untouched. |
| Visual style selection | DEPLOYED | The Top Bar shows the active style. The visual Art Style dialog presents six major families, generated preview cards, active-state feedback, and custom style creation with optional uploaded reference. |
| Style propagation | DEPLOYED | Manual generation, canonical character references, semantic character states, progressive Asset Packs, backgrounds, props, and Manga Agent generations all inherit the active style, negative prompt, optional style reference, and immutable asset-level style provenance. |
| Character identity UX | DEPLOYED | Character creation separates Name, Appearance, and Personality / visual identity from Project Art Style. The progressive Asset Pack contains eight poses and eight expressions without a Cartesian-product explosion. |

## Root cause record

Production log for the observed `/api/generate` 500:

```text
Generation failed: Persistent storage is not configured. Connect a Vercel Blob store to this project.
```

Exact throw site: `src/storage/objectStore.ts`, `putLocal()`, called by `putObject()` from `src/ai/generate.ts` after provider image bytes were returned. `APP_ENCRYPTION_KEY` was not the thrown exception and is currently configured. The historical deployment lacked `BLOB_READ_WRITE_TOKEN`.

## Known limitations

- Project documents are browser-local IndexedDB data; there is no authenticated cross-device project sync in the MVP.
- BYOK provider profiles are per browser cookie and limited to one active provider per capability.
- Gemini character consistency remains provider-dependent. Flash Lite accepts image input but is not optimized for multiple reference inputs; Manga Studio currently sends at most three storage references.
- The generator uses the `generateContent` adapter surface. Google currently promotes the newer Interactions API for image workflows, but the existing surface is retained until production evidence requires a migration.
- Production Character creation, refresh persistence, and derived pose/expression generation must be recorded here only after the new deployment is exercised with the user’s BYOK session.
- Starter-pack generation is sequential and cancellation stops remaining work after the currently active provider request finishes; it does not abort a request already in flight.
- Built-in style cards currently use reusable generated placeholder previews; `previewImage` and custom reference fields allow real preview artwork to be added without changing the style architecture.
- Style interpretation remains provider-dependent. Semantic style prompts and negative prompts are provider-neutral; adapters may support richer style controls later.

## Verification ledger

- Typecheck: passed.
- Lint: passed.
- Tests: 19 files, 136 tests passed, covering built-in profile completeness, custom profile persistence, style-aware prompts/provenance, style-aware cache isolation, schema-v4 migration, and the progressive 15-state character pack.
- Production build: passed with Next.js 15.5.23.
- Local browser: passed (six style families, visual cards, built-in/custom activation, persistent Top Bar label, identity-separated character form, 16-generation Asset Pack estimate, no error overlay/console errors).
- GitHub art-style-system code commit: `ec0b221` on `agent/project-art-style-system` (pushed to `origin`; not merged to `main`).
- GitHub character-rig code commit: `62d01cb` on `agent/virtual-character-rig`.
- Production deployment: READY, `dpl_65DXLj9qZKKmKnmkrmx4DMuKpS2i` (`https://mangaharness.vercel.app`), deployed from the tested `ec0b221` feature commit.
- Production browser verification: passed (six style families; Western Comics and Minimal Line selection; custom style creation and Top Bar activation; identity-separated character form; Asset Pack and 16-generation estimate; no console/page errors).
- Post-deploy error scan: clean; no error logs found for the new deployment.
- Production status: HTTP 200; `storage.configured: true`; backend `vercel-blob`; no new serverless errors in the post-deploy scan.
- Production trace smoke test: request `77e6fab5-da18-4fe0-b4a4-526b4a8d9bd1` logged request parsing/validation and credential lookup safely, then returned the expected 503 because the CLI request intentionally had no BYOK cookie.
- Real production generation/persistence/derived-asset test: pending a run from the user's browser session with an Image Provider connected in AI Settings.
