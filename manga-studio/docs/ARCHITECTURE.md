# Architecture

## Overview

Next.js 15 (App Router) + React 19 + TypeScript strict. The editor is a client application; the server exists only for the security boundary (AI keys, storage writes) — there is no server-side project database in the MVP.

**Mental model:** an infinite workspace canvas where the manga page is one object among loose working material; polygon panels clip their contents; manual direct manipulation and the Manga Agent operate the same domain command layer; AI generates reusable semantic assets, never flattened pages. (See EDITOR_MODEL.md for coordinate spaces and the panel/instance invariants.)

```
Browser
├── Domain document (single source of truth, plain JSON)
│     src/domain — schema-v6 entities, scenes, lifecycle, commands, validation
├── Editor state (Zustand)
│     src/editor — store, history (undo/redo), selection, UI state
├── Canvas projection (react-konva)
│     src/render — scene nodes; src/components/canvas — interactive stage
├── Studio chrome
│     src/components — library, inspector, agent panel, toolbar, pages bar
├── Persistence
│     src/storage/projectStore.ts — IndexedDB (project JSON only)
└── Export
      src/export — PNG capture of the live stage (overlay hidden)

Server (Next.js API routes)
├── /api/generate          → src/ai — provider registry, adapters, prompt templates
├── /api/agent             → src/agent — planner, skills, tool schemas
├── /api/assets/upload     → src/storage — validation + object storage
├── /api/assets/remove-background → src/assets — inspect, extract, validate, persist derivative
├── /api/provider/status   → safe configuration status (no secrets)
└── /api/files/[...path]   → dev-only local storage fallback

External
├── Vercel Blob            → persistent image storage (uploads + generations)
├── Gemini / generic REST  → image generation
└── DeepSeek (OpenAI-compatible) → agent planning
```

## Character and prop processing

Character and prop images are compositing layers, while backgrounds are rectangular scene surfaces. Generation and foreground extraction are separate capabilities:

```text
ImageGenerationProvider → immutable source image
                        → AssetPostProcessor inspection
                        → BackgroundRemovalProvider (when opaque)
                        → alpha/bounds validation
                        → transparent PNG derivative
                        → SourceAsset ready for canvas/Agent composition
```

`src/assets/backgroundRemoval.ts` is the provider boundary. Its built-in Vercel-compatible implementation uses bounded pixel operations: an edge-connected flood for solid backgrounds and a connectivity-based matte for baked two-colour checkerboards. The checkerboard path identifies interior foreground evidence, closes narrow line-art gaps, fills enclosed artwork, and removes the spatially exterior pattern; it never deletes white, grey, or black colours globally. A hosted or ML segmentation adapter can replace it without changing generation providers, library ingestion, or canvas rendering.

Processing is non-destructive. `storageUrl`/`sourceUrl` always identify the original bytes; `processedImageUrl` identifies a separately stored PNG derivative. A character/prop with an explicit processing state is composable only when the state is `ready`, real alpha was validated, and a derivative URL exists. Failed sources stay in the library with a safe reason and can be retried through the same server pipeline. `assetRenderUrl` is the single thumbnail, reference, canvas, and export selection rule and only promotes a validated derivative.

## Module rules

- `src/domain/commands.ts` is the canonical mutation facade. UI actions and Agent tools dispatch typed `DomainCommand` values; domain modules remain pure `doc → doc` transformations. Live canvas gestures use `transientDispatch`, which applies the same commands without adding history until the gesture ends.
- `src/render` renders domain state; it never mutates it and never imports `src/export`.
- `src/ai` (server) knows generation providers; `src/assets` owns the independent post-processing/removal capability. The editor only sees normalized API responses. Library ingestion of generation results happens client-side in `src/ai/clientGeneration.ts` (composition-root pattern) — providers never write to the library.
- `src/agent` validates every model-planned tool call against zod schemas before anything executes; execution happens client-side through the command layer inside one history transaction. The scope is checked both at plan validation and immediately before execution, then audited against the before/after documents.

## Core domain boundaries

- `SourceAsset` is a first-class reusable resource with semantic type, lifecycle status, immutable source URL, optional processed derivative, provenance, and timestamps.
- `Character` is an identity that owns canonical and state visuals. Pose, expression, outfit, and view are independent `CharacterState` dimensions resolved to an exact cached visual or a newly generated reusable asset.
- `AssetInstance` is presentation state only. It references a source asset and never owns or mutates the source.
- Every `Panel` has a `PanelScene` projection containing background identity, semantic Character placement, relationships, dialogue, location, and continuity metadata.
- `assetLifecycle.ts` is the reference-aware delete/archive/replace boundary. Unsafe deletion is refused unless the caller chooses an explicit archive or cascade mode.
- `compositionValidation.ts` audits required content, visibility, scale, background presence, occlusion, and scope integrity; safe geometry defects are corrected before the Agent run completes.

## Key data-flow decisions

- **Document-first canvas.** Konva nodes are projections of the domain document; nothing canvas-related is serialized. Save/load, undo, agent execution, and export all operate on the same JSON document.
- **Undo = snapshots.** Documents are small (image binaries live in object storage, referenced by URL), so bounded snapshot history (50 entries) is simpler and safer than command inversion. Drag gestures collapse into one entry; an agent run is one transaction → one entry.
- **Images by URL.** The project document stores only storage URLs. IndexedDB holds the document; Vercel Blob holds binaries; the canvas loads them with `crossOrigin=anonymous` so export never hits tainted-canvas errors.

## Canvas technology

Konva.js via react-konva. Rationale: per-group clipping (`clipX/Y/Width/Height`) maps exactly onto panel-viewport semantics; built-in Transformer covers move/resize/rotate handles; react-konva keeps the scene graph declarative from Zustand state. Canvas 2D performance is ample for tens of objects per page. (PixiJS is WebGL headroom we don't need; Fabric's React integration is weaker; raw canvas/SVG means rebuilding hit-testing and transforms.)

## Testing

Vitest suites guard geometry, source-vs-instance invariants, lifecycle references, Character state merging and resolution, scene continuity, command behavior, scope enforcement/auditing, serialization migrations, AI security, transparency inspection, solid/checkerboard extraction, invalid-alpha rejection, derivative preference, reprocessing, and Agent readiness. `scripts/e2e.mjs` drives the full agent → generation → composition → persistence → export loop in headless Chromium against `scripts/fake-providers.mjs`.
