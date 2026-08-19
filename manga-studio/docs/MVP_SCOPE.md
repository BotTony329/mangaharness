# MVP Scope

## The three hypotheses this MVP proves

- **A — Asset-based creation:** panels are composed from reusable source assets, not regenerated wholes.
- **B — Panel viewport editing:** one full-body character asset serves full/medium/upper-body/close framings through viewport cropping, zero regenerations.
- **C — AI asset expansion:** after creating a character, AI generates additional poses/expressions referencing the existing character (where the provider supports references), and results become reusable assets.

Plus the agentic revision: **prompt → editable composition** via the Manga Agent.

## Shipped

- Project with pages, predefined layouts (single, 2-stacked, 2-side-by-side, 3-stacked, 4-grid, yonkoma), panel borders.
- Panel viewport clipping; Fit / Fill / Upper Body / Face (metadata-gated) / Custom framing; ghosted overflow preview.
- Non-destructive instances: move, resize, rotate, flip, opacity, duplicate, delete, layer reorder (forward/backward/front/back).
- Asset library: characters (structured pose/expression browser with variation stacking), backgrounds, props, uploads (validated); drag-to-panel.
- Speech / thought / shout bubbles + narration boxes with inline editing, draggable tails; speed lines, focus lines, impact burst, screentone effects.
- Undo/redo (snapshot history, gesture coalescing, agent-run grouping); keyboard shortcuts.
- Persistence: IndexedDB project document + autosave; images in Vercel Blob.
- Export: current page PNG at 1×/2× via the live scene graph, CORS-safe.
- Real AI generation: Gemini adapter (reference-aware) + generic OpenAI-compatible adapter, server-side keys, capability-adaptive UI, provenance metadata, generation history.
- Manga Agent: 10 validated tools, 6 skills, DeepSeek-compatible planner, per-step execution status, generation-count confirmation, contextual quick actions.

## Deliberately deferred (per spec)

Authentication/accounts/billing; collaboration; multi-project management UI (domain models support multiple projects; the UI opens the last one); custom panel drawing / split-merge; Face Focus auto-detection (needs region metadata we refuse to fake); asset versioning UI beyond variation stacking; project archive export/import; PDF/webtoon/print export; layer masks/blend modes; advanced typography; autonomous long-form story generation; multi-agent orchestration; LoRA training; animation/video; marketplace; mobile.

## Known limitations

- Undo history is in-memory (refresh clears history; the document itself persists).
- Gemini does not return transparent PNGs; character assets arrive with white backgrounds (not faked otherwise). A provider with transparent output can declare the capability.
- Identity consistency depends on the provider; the UI labels reference-aware generation as provider-dependent, never guaranteed.
- The agent plans in a single pass (no mid-run replanning); failed steps are reported and skipped.
- One page-size preset (1200×1800); RTL reading direction is stored but doesn't yet reorder panel numbering.
