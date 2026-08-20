# Editor Model

## The infinite workspace

The root canvas is an infinite workspace, not the page. A manga page is one object inside it (`page.workspace` position); loose assets — reference sheets, staged generations, mood-board material — live beside pages as `WorkspaceItem`s. Loose items are working material: they are never exported with a page, and they convert to panel instances (and back) by dragging across the panel boundary. Navigation: drag empty space or hold Space to pan, wheel pans, ⌘/Ctrl+wheel zooms at the pointer, plus Fit page / Fit all controls.

### Coordinate spaces (see `src/domain/coords.ts`)

Viewport (screen) → stage transform → **Workspace** (pages + loose items) → subtract `page.workspace` → **Page** (panel polygons) → subtract panel bbox origin → **Panel-local** (item transforms). Each helper converts exactly one hop; conversions are explicit at call sites and unit-tested.

## Panels are polygons

A panel's geometry is a polygon (`points`, normalized page coords, 3–10 vertices) — a rectangle is just a 4-point polygon. Presets create the starting shape; after that the creator owns it: double-click a panel to enter shape-edit mode and drag vertex anchors (diagonal action panels). Clipping, the white fill, the border, hit testing, and export all follow the polygon — never the bounding box. Framing math (Fit/Fill/Upper Body) works against the polygon's bounding box.

## Source assets vs panel instances — the core invariant

A `SourceAsset` is a reusable library entity with source/processed URLs, semantic type, lifecycle status (`ready`, `processing`, `failed`, `archived`), provenance, and timestamps. Placing it in a panel creates an `AssetInstance` that stores **only presentation state**: center position, size, rotation, flip, opacity, crop mode.

- Mutating an instance never mutates the source.
- The same source can live in many panels with independent transforms.
- Deleting an instance never deletes the source.
- Deleting a used source requires an explicit choice: archive it while preserving uses, or cascade through every indexed reference. An implicit unsafe delete is rejected.

These rules are enforced in `itemOps.ts` and `assetLifecycle.ts`, and guarded by instance/lifecycle tests. Library menus expose rename, regenerate-and-replace, background processing, archive/restore, and reference-aware delete. Character deletion separately offers keeping assets or deleting linked assets.

## Panel scene graph

Each panel owns a semantic `PanelScene` alongside its visual stack. It records location, exact background asset identity, Character instance roles/position/facing/depth, relationships, dialogue, and continuity links. The scene projection is synchronized after item mutations. “Same street” is represented by reusing the exact source asset plus `backgroundSourcePanelId`, not by generating a visually similar replacement.

## Command boundary

All persistent manual actions and Agent actions dispatch the same typed commands through `editor/store.ts`. Drag/reshape previews use `transientDispatch`; `commitTransient` coalesces the command previews into one undo snapshot. Direct Zustand document mutation is not an Agent capability.

## Panel = viewport

A panel is a normalized rect on the page rendered as a Konva group with clipping. Items may extend beyond the panel; only pixels inside render. While an instance is selected, a ghosted unclipped copy shows what exists outside the frame.

## Framing (crop) modes

Computed by pure functions in `src/domain/geometry.ts`:

- **Fit** — contain the whole asset (letterboxing allowed).
- **Fill** — cover the panel; overflow is clipped. Default for backgrounds.
- **Upper Body** — frame a normalized upper-body region (annotation if present, otherwise a documented heuristic). This is approximate framing, not face detection.
- **Face** — only available when the asset carries real `focusRegions` metadata; the button is disabled otherwise. We never fake face detection.
- **Custom** — whatever the user made it. Any manual move/resize switches the instance to custom.

A mode computes a starting transform; the user (or agent) can keep adjusting afterwards. The panel does the cropping — sources are never cropped destructively.

## Semantic character instances

A placed character is not a static image: the floating toolbar exposes Pose and Expression dropdowns built from the character's slot metadata. Picking an existing slot swaps the instance's source asset (`swapInstanceAsset`) while preserving position, panel membership, z-order, and framing; picking "Generate…" opens the generator and swaps in the accepted result. The agent's `set_character_slot` tool is the same operation ("make her cry"), with generate-on-miss.

## Layers

Each panel holds one ordered `itemIds` array (bottom → top). New items insert at the top of their band — background < props/uploads < characters < effects < bubbles — and can be freely reordered afterwards (bands are defaults, not cages). The layer controls in the inspector are a projection of this array.

## Speech bubbles & effects

Bubbles (speech/thought/shout/narration) are panel items with text, font size, and a draggable tail target (narration has none). Double-click to edit text inline. Effects (speed lines, focus lines, impact burst, screentone) are procedural vector overlays — resolution-independent, so they stay crisp at 2× export.

## Undo/redo

Bounded snapshot history in the Zustand store:

- `commit(mutation)` — one history entry.
- `transient(mutation)` + `commitTransient()` — 60 fps drag updates collapse into one entry.
- `beginTransaction()`/`endTransaction()` — a whole agent run becomes one entry.

Keyboard: ⌘Z / ⇧⌘Z (Ctrl on Windows/Linux), ⌘D duplicate, Delete removes the selection.
