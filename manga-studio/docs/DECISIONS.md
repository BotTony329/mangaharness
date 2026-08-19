# Architecture Decision Records

## D01 — Next.js on Vercel supersedes the PRD's Vite SPA
The PRD (v1.1) recommended a Vite SPA with a mock-only provider and local-first everything. The build directive explicitly requires production deployment on Vercel with **real** AI generation and server-side secrets. A pure SPA cannot hold API keys; Next.js API routes provide the server boundary with one deployable unit. The PRD's editor architecture (domain models, viewport semantics, state separation) is kept intact.

## D02 — Konva.js via react-konva
Per-group clipping = panel viewports; built-in Transformer = manipulation handles; declarative binding to Zustand state. Canvas 2D is sufficient for tens of objects/page. Alternatives: PixiJS (WebGL headroom we don't need, weaker text), Fabric (imperative, third-party React wrappers), raw canvas/SVG (rebuild hit-testing + transforms).

## D03 — Snapshot undo instead of command inversion
Documents are small (binaries live in object storage by URL), so bounded deep-copy history (50 entries) is trivially correct. Command inversion's failure mode — a missed inverse corrupting state — is the PRD's own listed risk. Gestures coalesce via a transient path; agent runs group via transactions. Revisit only if documents grow enormous.

## D04 — One ordered item array per panel
Instances, bubbles, and effects share a single `itemIds` stack (discriminated union). Layer UI, rendering, and export all project the same array — no parallel z-index bookkeeping. Insertion bands (bg < props < characters < effects < bubbles) are defaults, not constraints.

## D05 — Gemini as the first real provider; generic REST second
Chosen because Gemini's image models accept reference images natively — the capability Hypothesis C (character-consistent asset expansion) actually needs. The generic OpenAI-compatible adapter provides an escape hatch to any gateway, honestly declaring `referenceImage: false`.

## D06 — DeepSeek (OpenAI-compatible) for the agent, JSON-plan mode
User-selected. The planner requests one JSON object (`response_format: json_object`) with the full step list instead of streaming function calls — more portable across OpenAI-compatible vendors and trivially validatable. Tools use semantic addressing (panel numbers, character names) so a single planning pass needs no ID round-trips; the executor resolves semantics against live state.

## D07 — Client-side plan execution through the shared command layer
Editor state lives in the browser (local-first MVP), so the server returns a validated plan and the client executes it through the same domain mutations the manual UI uses. One transaction = one undo entry; no privileged write path; generation steps go through the same `/api/generate` boundary as manual generation.

## D08 — Vercel Blob for binaries; IndexedDB for the document
Blob: zero-config on Vercel, public CORS-friendly URLs (tainted-canvas-safe export), automatic token injection. IndexedDB keeps the document local (no auth in MVP) behind a `PersistenceService` interface so cloud storage is an adapter swap. The local `.data/` fallback throws on Vercel rather than silently losing files.

## D09 — No browser API-key input
The spec allowed a password-masked temporary key field but preferred dropping it over weak security. Serverless has no safe per-session server memory; every browser-side path risks persistence. Not built; env-vars only (documented in AI_PROVIDER_SECURITY.md).

## D10 — Skills as markdown text in TS modules
Loose `.md` files require output-file-tracing configuration to survive serverless bundling; a silent miss would break the agent in production only. Text-in-module keeps skills inspectable/editable prose with guaranteed bundling. Format can move to `.md` + loader later without changing the selector or planner.

## D11 — Face Focus is metadata-gated, Upper Body is heuristic
Upper-body framing uses an annotated region when present, else a documented heuristic (top ~55%) — approximate framing is explicitly acceptable. Face framing without real region metadata would be fake face detection, so the button is disabled until an asset carries a `face` focus region.

## D12 — Deterministic keyword skill selection
An LLM selector would add latency, cost, and nondeterminism for marginal gain at 6 skills. Keyword triggers are testable and transparent (the UI shows the selection). Revisit when the skill library grows.
