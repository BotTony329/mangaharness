# Domain Model

Schema version 6 serializes product meaning, never Konva nodes.

## Aggregate

`ProjectDocument` owns Projects, Characters, Assets, Pages, Panels, Panel Scenes, panel Items, loose Workspace Items, style settings, and generation history. IDs connect entities; image bytes live in object storage.

## Assets and instances

`SourceAsset` is the reusable resource. Its immutable source survives optional processing, while `status` controls availability for new use. `AssetInstance` references `sourceAssetId` and owns only transform/framing/visibility state. Deleting an instance cannot delete its source.

`inspectAssetUsage` indexes all known references before lifecycle changes. Delete modes are `if-unused`, `archive`, and `cascade`. Replacement rewrites references from one source ID to another. Regeneration creates a new asset first, then performs that replacement; provider data never overwrites an existing source in place.

## Characters and state

`Character` is identity and owns zero or more visuals. A `CharacterState` has orthogonal `pose`, `expression`, `outfit`, and `view` dimensions. State patches preserve unspecified dimensions. Exact state plus active style is the cache key; a miss may generate a new state asset anchored to the canonical reference.

## Pages, panels, and scenes

`Page` owns ordered polygon panels. `Panel` owns an ordered visual item stack. The matching `PanelScene` owns semantic location, exact background identity, Character roles/position/facing/depth, action relationships, dialogue, and continuity. Scene state is synchronized from visual mutations and enriched by semantic commands.

## Persistence and migration

`serializeProject` writes plain JSON. `deserializeProject` migrates earlier versions incrementally. The v6 migration normalizes lifecycle/provenance fields and rebuilds scenes from existing content. Archived assets remain renderable by existing instances but are excluded from new UI/Agent resolution.
