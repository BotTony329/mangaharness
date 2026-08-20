# Manga Studio — Verified Project State

Last updated: 2026-08-20 (MVP integration and UX stabilization pass)

## Current status

| Area | Status | Verified reality |
|---|---|---|
| Image generation | PARTIAL | The previously failing production request reached provider result handling, then failed while persisting the returned image because Vercel Blob was not connected. Code now emits request-scoped stage traces; post-fix production generation still requires a fresh browser acceptance run. |
| Gemini adapter | WORKING AT ADAPTER/UNIT LEVEL | `gemini-3.1-flash-lite-image` is a current stable Google image-generation/editing model. Adapter tests cover success, reference input, malformed/missing images, HTTP 400/401/403/404/429/5xx, and timeout. The prior production exception occurred after provider invocation, not in Gemini payload construction. |
| BYOK credential storage | CONFIGURED | User credentials remain encrypted in HttpOnly cookies. `APP_ENCRYPTION_KEY` is an operator infrastructure secret configured once in Vercel for Preview and Production; users do not configure it. Trace tests verify successful retrieval/decryption and the missing-key failure path without logging secrets. |
| Character reference persistence | PARTIAL | Accepted uploads and accepted generated results become Character assets; the first character asset becomes the reference. Project JSON persists in IndexedDB. Production refresh verification remains to be rerun after deployment. |
| Production asset storage | CONFIGURED | Public Vercel Blob store `manga-studio-assets` is connected to the existing `personal-b90d/mangaharness` project in `iad1`; the Blob credential is injected into Development, Preview, and Production. |
| Character upload UX | WORKING LOCALLY | Browser verification confirmed the native input is hidden; click-to-browse shows a real PNG preview and dimensions; Replace/Remove render; Remove restores the drop zone; provider absence shows `Connect Image Model`; no console error or Next.js overlay was present. Drag/drop uses the same selection path. |
| Provider diagnostics | WORKING LOCALLY | Safe structured logs cover request parsing, validation, credential lookup/decryption, provider routing, adapter creation, normalized request construction, outbound start/response status, parsing, and persistence. The UI can show safe provider/model/HTTP/stage/request-ID details. |

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

## Verification ledger

- Typecheck: passed.
- Lint: passed.
- Tests: 17 files, 129 tests passed.
- Production build: passed with Next.js 15.5.23.
- Local browser: passed (page render, no error overlay/console errors, provider gate, reference preview/replace/remove).
- Production deployment: pending.
