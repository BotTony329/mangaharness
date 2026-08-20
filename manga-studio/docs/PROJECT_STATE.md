# Manga Studio — Verified Project State

Last updated: 2026-08-20 (virtual character rig and starter asset pack)

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
| Character starter pack | DEPLOYED | New characters default to Starter Pack (1 canonical reference, 4 neutral-expression poses, 4 additional expressions = 9 generations without an uploaded reference) with Reference Only, itemized progress, cache skipping, and cancel-remaining behavior. Completed assets are retained. |
| Agent character editing | DEPLOYED | `set_character_slot` uses the same resolver as the Inspector and preserves all unspecified state fields. Pose, expression, outfit, and view are supported. |

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

## Verification ledger

- Typecheck: passed.
- Lint: passed.
- Tests: 18 files, 131 tests passed, including Yuri walking/neutral → walking/angry → running/angry → cached walking/angry reuse.
- Production build: passed with Next.js 15.5.23.
- Local browser: passed (meaningful page render, no error overlay/console errors, Starter Pack and Reference Only controls, 9-image estimate).
- GitHub character-rig code commit: `62d01cb` on `agent/virtual-character-rig`.
- Production deployment: READY, `dpl_AjFEj33GqoL7dwpo1nB1xbyur3cu` (`https://mangaharness.vercel.app`).
- Production browser verification: passed (Starter Pack, Reference Only, 9-image estimate, no overlay, no console/page errors).
- Post-deploy error scan: clean; no error logs found for the new deployment.
- Production status: HTTP 200; `storage.configured: true`; backend `vercel-blob`; no new serverless errors in the post-deploy scan.
- Production trace smoke test: request `77e6fab5-da18-4fe0-b4a4-526b4a8d9bd1` logged request parsing/validation and credential lookup safely, then returned the expected 503 because the CLI request intentionally had no BYOK cookie.
- Real production generation/persistence/derived-asset test: pending a run from the user's browser session with an Image Provider connected in AI Settings.
