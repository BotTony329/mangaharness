# Editor Model

## Source assets vs panel instances — the core invariant

A `SourceAsset` is an immutable library item (image URL + metadata). Placing it in a panel creates an `AssetInstance` that stores **only presentation state**: center position, size, rotation, flip, opacity, crop mode. 

- Mutating an instance never mutates the source.
- The same source can live in many panels with independent transforms.
- Deleting an instance never deletes the source.
- Deleting a source removes its instances (the only cascading direction).

These rules are enforced in `src/domain/itemOps.ts` and guarded by `src/domain/instances.test.ts`.

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
