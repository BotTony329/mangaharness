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
                        → validate provider-native alpha
                        → same-provider edit/cutout (when supported)
                        → dedicated BackgroundRemovalProvider (when configured)
                        → built-in heuristic (last fallback only)
                        → alpha/bounds validation after every candidate
                        → transparent PNG derivative
                        → SourceAsset ready for canvas/Agent composition
```

`src/assets/processingPipeline.ts` owns that ordered cascade. Image adapters declare `supportsTransparentBackground`, `supportsImageEditing`, and `supportsReferenceImage`; capable generation adapters are explicitly asked for alpha, adapters without it are asked for a pure white field on monochrome projects and a chroma key otherwise (`selectBackgroundStrategy`), and capable edit adapters receive the immutable generated/uploaded source plus a strict isolate-without-redrawing instruction. `src/assets/providers/` is the independent hosted-segmentation boundary, currently with a remove.bg preset and the declarative Custom API adapter. `src/assets/backgroundRemoval.ts` is the bounded local implementation: one perimeter flood that keys every pixel reachable from the image border whose colour matches the estimated background model, measured to the segment between background colours so checkerboard tile seams do not form walls. Connectivity — not colour thresholding — is what preserves enclosed white clothing, skin, and line-art interiors; a global "near-white becomes transparent" rule would destroy exactly those regions.

Processing is non-destructive. `storageUrl`/`sourceUrl` always identify the original bytes; `processedImageUrl` identifies a separately stored PNG derivative. `backgroundRemovalStatus`, method, and provider record the cutout lifecycle without putting credentials in project data. A character/prop is composable only when the state is `ready`, real alpha was validated, and a derivative URL exists. A generated character/prop that fails extraction never becomes a library asset; the generator offers a single Retry. Legacy or reprocessed sources that fail expose one Retry control — extraction strategy and provider choice are pipeline internals, not product UI. `assetRenderUrl` is the single thumbnail, reference, canvas, and export selection rule and only promotes a validated derivative.

## Virtual manga stage

`domain/staging.ts` is the 2.5D projection engine: camera + depth → real transforms. Depth scale combines an optical exponent (from lens FOV) with a separate manga-exaggeration exponent, and characters are anchored at the ground line so they never float as they move through depth. `stageOps.setPanelCamera` reframes the focal subject and re-projects the panel, so shot/angle/lens visibly change composition rather than only metadata. `components/canvas/PerspectiveOverlay.tsx` draws horizon, vanishing-point handles and guide rays on the overlay layer, dragging through `transientDispatch` so one drag is one undo entry. `cameraChangeRequiresRedraw` is the explicit transform-vs-regeneration boundary.

`Panel` carries a `camera` (shot/angle/lens presets deriving pitch, roll, horizon, FOV, plus `mangaPerspectiveStrength`) and a `perspective` (type, horizon, vanishing points). Guides are panel data, never items, so export cannot reach them. `AssetInstance` carries an optional `stage` (depth, ground line, anchor, scale lock) layered over the existing free transform. `domain/stageOps.ts` holds the mutations; `characters/` holds the Character Kit projection, semantic sockets, the pose-rig data model, and the state resolver that answers cache-or-generate for every caller.

## Manga Puppet

`src/puppet/` holds the articulated character representation (D39): `model.ts` (parts, hierarchy, expressions, joints, attachments, `PartReadiness`), `transforms.ts` (the parent-child pivot maths that makes a shoulder carry its forearm), `capability.ts` (the explicit boundary that hands genuinely impossible requests to AI instead of distorting), and `fixture.ts` (a deterministic puppet, since the automatic compiler is deferred). A puppet lives on `AssetInstance.puppet` rather than as a new item kind, so depth, camera, framing, z-order and export apply unchanged; `render/PuppetNode.tsx` draws it with nested Konva groups and bubbles events to the outer group so selection picks the actor, not an eyelid. `domain/puppetOps.ts` provides the local, generation-free commands.

## Character rig

`ProjectDocument.characterStates` is the character state graph: semantic nodes carrying pose/expression/outfit/view/props, the parent state a render was derived from, the reference asset actually sent to the provider, the canonical anchor, and the generation delta. `characters/stateGraph.ts` owns traversal and weighted nearest-state search; `characters/stateResolver.ts` is the single cache-or-generate decision (exact render → nearest render → canonical → none) and names the reference that generation must use; `characters/kit.ts` projects one character as a parts box with honest CACHED / AVAILABLE / NEW availability. Nodes are created and pruned inside `libraryOps`/`assetLifecycle`, so the graph cannot diverge from the library.

## Pose rig

`characters/poseRig.ts` holds the 14-joint semantic rig and the canonical `PoseIntent` that both the editor and the Agent produce: presets, normalized sparse joint overrides, corrective (non-IK) constraints, a shared descriptor vocabulary with token-based normalization (`normalizeDescriptor`), per-render `PoseCalibration` that shifts the generic skeleton onto real artwork, and `deriveDescriptors`, which reads joint positions back as sentences relative to the calibrated baseline. Descriptors are the pose's identity via `poseRigKey` and participate in the state key; raw coordinates never do. `components/canvas/PoseEditOverlay.tsx` draws the draggable skeleton on the overlay layer and writes only to `uiStore.poseDraft`, so nothing enters the document until Apply routes through the normal resolver and state runtime.

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

Vitest suites guard geometry, source-vs-instance invariants, lifecycle references, Character state merging and resolution, scene continuity, command behavior, scope enforcement/auditing, serialization migrations, AI security, transparency inspection, cascade ordering, image-edit cutout, dedicated-provider validation, solid/checkerboard/chroma-key/white extraction, monochrome colour-contamination refusal, the character transparency contract, alpha-composite show-through over multiple backdrops, remove.bg multipart/auth handling, derivative preference, reprocessing, and Agent readiness. `scripts/e2e.mjs` drives the full agent → generation → composition → persistence → export loop in headless Chromium against `scripts/fake-providers.mjs`.
