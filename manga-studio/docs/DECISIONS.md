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

## D19 — Custom API is the universal provider type; presets are prefills
Provider dropdowns no longer define the capability boundary. Users describe an arbitrary AI API declaratively — endpoint, HTTP method, auth mode (none/bearer/named header), extra headers, a JSON request template with safe `{{variable}}` substitution (structured injection for exact-match placeholders, string interpolation otherwise, no evaluation of any kind), a limited property-path response mapping (`data.images[0].url`), reference-image mode (url/base64 into the template), and sync or submit-and-poll execution. Presets ("OpenAI-style images", "Anthropic-style messages") only prefill these editable fields. No user code is ever accepted — declarative data only, validated with zod at save and again at execution. Verified by an E2E that connects two API shapes that exist nowhere in the source.

## D20 — Custom API test performs one real minimal generation
Arbitrary APIs have no universal cheap status endpoint, so Test Connection for a custom image provider executes one small real request and reports whether the mapping found an image at the configured path (the UI states the cost). Agent custom tests use a one-line completion. Known-preset providers keep their cheap model/status probes.

## Deferred from the universal-provider spec (recorded, not silent)
Multipart-file reference mode (URL/base64 cover current targets); per-header "secret" flags (the entire config, headers included, already lives in the encrypted cookie; the API key remains the only value with dedicated secret handling); multiple saved provider profiles per capability (cookie-per-capability keeps exactly one active config; a profile library needs vault storage that shouldn't be faked with cookies); GET-with-query-template requests.

## D17 — BYOK harness: users bring their own providers (supersedes D09's env-only stance)
Manga Studio is a harness whose execution models are user-configurable, OpenCode-style. Users connect their own agent LLM and image provider in AI Settings — no Vercel edits, no redeploys. D09's concern (no safe serverless session state) is resolved with encrypted HttpOnly cookies: AES-256-GCM under a deployment-owned `APP_ENCRYPTION_KEY`, so the "session store" is the cookie itself and every serverless instance can decrypt it statelessly. Env vars remain an optional operator fallback that user sessions override.

## D18 — Agent providers behind one JSON-plan interface
`AgentModelProvider` (label/model/testConnection/completeJson) with three adapters: OpenAI-compatible (primary — covers DeepSeek, Kimi, OpenRouter, self-hosted), Google Gemini (native JSON response mode), Anthropic-compatible (prompt-enforced JSON; the planner strips fences). The single-JSON-plan contract doubles as the structured fallback for models without native tool calling — Manga Studio's internal tool schema never depends on any vendor's function-call format, and validatePlan gates all of them identically.

## D13 — Workspace revision: page is an object, not the root canvas (schema v2)
Per the interaction-architecture revision: the root canvas is an infinite workspace; pages carry a `workspace` position; loose `WorkspaceItem`s hold reference/staged material that never exports. Panels moved from `rect` to polygon `points` (rectangles are 4-point polygons) so clipping/border/hit/export follow the true shape — the non-rectangular manga panel differentiator. One forward migration (v1→v2) converts stored projects.

## D14 — Coordinate spaces isolated in `src/domain/coords.ts`
Three spaces (viewport → workspace → page → panel-local) with one-hop conversion helpers; item transforms stay panel-local anchored to the polygon's bbox origin, so reshaping a panel doesn't invalidate item positions. Loose↔instance conversions are the only cross-space writes and live in `workspaceOps.ts`.

## D15 — Semantic instance swap over re-placement
"Pose: Standing → Running" replaces the instance's `sourceAssetId` (recomputing non-custom crop modes, preserving position/panel/z) instead of deleting and re-placing. The strict slot matcher (`slotSwitch.ts`) requires the changed field to match exactly — a miss offers generation rather than silently substituting — while the agent's fuzzy resolver still handles planning-time reuse.

## D16 — Agent results staged on the workspace
Generated assets land in the library immediately (with provenance) AND appear as loose items beside the page. Full accept-before-library staging was considered and deferred: delete-from-workspace plus library removal covers rejection for MVP without a second asset state.

## D12 — Deterministic keyword skill selection
An LLM selector would add latency, cost, and nondeterminism for marginal gain at 6 skills. Keyword triggers are testable and transparent (the UI shows the selection). Revisit when the skill library grows.

## D21 — Secret-safe generation trace spans the complete server path
`/api/generate` assigns a request ID and emits structured stage logs from JSON parsing through BYOK lookup/decryption, adapter construction, reference processing, the exact provider-fetch boundary, provider HTTP response, normalized image parsing, and Blob persistence. Trace callbacks carry only an allow-listed set of non-secret fields; keys, cookies, authorization headers, encrypted credentials, and complete provider configs are never logged. Safe request IDs and normalized provider diagnostics may reach the browser so an operator can correlate a user-visible failure with Vercel logs.

## D22 — Character reference input is source-based, not `File`-based domain state
The creation dialog currently implements the `upload` source with drag/drop, preview, validation, replace, and remove controls. Its transient selection is a discriminated `{ kind: "upload" }` value; accepted images are persisted as normal Character assets and the domain document stores only asset IDs/URLs. This leaves room for future `asset-library` and `canvas-selection` sources without coupling Character entities to browser `File` objects.

## D23 — Schema v6 makes lifecycle and panel semantics durable
Assets now carry canonical `type`, `sourceUrl`, `status`, `provenance`, and `updatedAt` fields while legacy `category`, `storageUrl`, and metadata remain compatibility aliases. Every panel has a serializable `PanelScene`. The v5→v6 migration derives these fields and rebuilds scenes from existing panel contents, so older projects remain loadable.

## D24 — One typed Command Layer is the only persistent editor write facade
`applyDomainCommand` coordinates lifecycle, library, panel, scene, style, workspace, and validation modules. Manual UI and Agent execution both call `dispatch`; canvas previews call `transientDispatch`. Pure lower-level operations remain implementation details and test seams, not alternate product write paths.

## D25 — Deletion is reference-aware and mode-explicit
The lifecycle module indexes Character references/states, panel instances, workspace instances, scene backgrounds, style references, and generation history. `if-unused` refuses unsafe removal. `archive` hides an asset from new resolution while keeping existing renders valid. `cascade` removes or clears all indexed references. Instance deletion never removes a source asset.

## D26 — Semantic Agent composition is validated, not trusted
The preferred `compose_character` tool resolves Character state before applying framing, position, facing, depth, and role. `reuse_scene_background` preserves exact continuity, and `add_scene_relationship` records intent. Plan-time and execution-time scope guards are followed by a structural before/after audit and composition validation. Correctable out-of-frame/tiny placements are repaired; unresolved warnings remain visible in the activity log.

## D27 — Agent planning owns a 25-second deadline and streams inside provider adapters
`/api/agent` remains a planning-only Node route; tool and image execution stays in the browser runtime after the validated plan returns. The planner owns one 25-second `AbortController` covering fetch and response-body consumption, so the application returns a controlled 504 before Vercel's 120-second route limit. OpenAI-compatible and recognized Custom Chat Completions adapters request SSE and normalize content, reasoning fields, finish reasons, and incremental tool-call arguments behind the provider interface. Routine hybrid Qwen models receive `enable_thinking: false`; explicitly thinking-oriented Qwen/QwQ models are not overridden. The route emits request-scoped, secret-safe stage timings, and the UI exposes only allow-listed diagnostics.

## D28 — Foreground extraction is a separate non-destructive provider capability
Image generation and background removal have independent provider contracts. The bundled `BackgroundRemovalProvider` uses bounded connectivity/morphology operations compatible with the existing Next.js Node/Vercel/Sharp runtime: perimeter flood for solid backgrounds and an interior foreground matte for baked checkerboards. It never removes colours globally. Original bytes are immutable, validated transparent PNGs are derivatives, and explicit processing states gate Character/prop composition. Detector-only failure was rejected because it made manual retry structurally incapable of success; adding a heavyweight bundled ML runtime was rejected for the MVP because it would increase serverless size/runtime risk without production evidence. The interface allows a future hosted or ML provider when the deterministic extractor's documented complex-scene limits are reached.

## D29 — Semantic segmentation precedes the local heuristic

New production evidence supersedes D28's assumption that the built-in checkerboard matte is adequate as the primary remover. The current 546,997-byte Cute Girl JPEG contains a light checkerboard whose white cells overlap white clothing, skin, grayscale shading, and anti-aliased outlines; the deterministic extractor correctly refuses an unsafe mask. The ordered policy is now: validated native provider alpha, same-image-provider edit/cutout, independently configured hosted `BackgroundRemovalProvider`, then local connectivity as the last fallback. remove.bg is one quick preset rather than a hard-coded product dependency; Custom API preserves the harness architecture. No method may report success until the returned pixels pass alpha/foreground/bounds validation, and raw source bytes are never overwritten.
