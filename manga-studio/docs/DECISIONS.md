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

## D30 — The light-checkerboard refusal was a bug, not algorithmic caution

D29 recorded that the deterministic extractor "correctly refuses an unsafe mask" for a light checkerboard overlapping pale artwork. Pixel-level replay disproves that. The seeding rule in the checkerboard matte required `luminance(pixel) > brightestBackgroundLuminance + 28`; when a tile colour is white that threshold is 283 on an 8-bit image, so **no pixel could ever seed a foreground**, and the `chroma > 28` alternative cannot fire on achromatic black-and-white line art. The mask was empty by construction, `removedRatio` reached 1.0, and the guard reported an unreliable extraction. A dark grid seeded normally, which is why the shipped tests passed while production — where the grid is light — always failed.

Two changes follow. First, generation no longer requests transparency it cannot receive: the prompt asked an adapter declaring `supportsTransparentBackground: false` for a "real transparent alpha background" while naming "fake checkerboard", and image models neither honour negations nor emit alpha, so they painted the grid. Prompts now request a flat chroma-key field when native alpha is unavailable, and never name the checkerboard.

Second, the separate solid flood and checkerboard matte (seed → dilate → erode → largest interior component → hole fill) collapse into one perimeter flood over an N-colour background model. Distance is measured to the segment between background colours so tile seams stay traversable without widening the radius — widening it bridges seams but swallows artwork, since a mid-tone skin fill sits closer to a light tile than the tiles sit to each other. Enclosed whites survive because the flood cannot reach them, which is a structural guarantee rather than a tuned threshold.

The provider cascade from D29 is unchanged and still runs first; the local extractor is simply no longer guaranteed to fail on the most common input.

## D31 — Monochrome characters are generated on white, not a chroma key

D30 replaced the checkerboard prompt with a magenta chroma key. Production showed the cost on black-and-white artwork: the saturated screen reflects onto the subject and the model bakes that spill into hair strands and silhouette edges as part of the drawing. It is not alpha-fringe spill, so no post-process can separate it from intended colour afterwards, and on a monochrome asset a magenta halo is glaring.

The background strategy is now ordered: validated native alpha, then a pure white field for monochrome line art, then the chroma key. White cannot tint anything. It is only viable because extraction is connectivity-based — the perimeter flood never reaches enclosed regions, so eye whites, white clothing, hair highlights, skin, and interior gaps survive even though they are the same colour as the background. A global "near-white becomes transparent" rule could not use this strategy at all. Coloured art keeps the chroma key, because its own palette can occupy the full near-white range where white offers no separation.

The chroma-key extractor is retained unchanged as the fallback, and the monochrome prompt names neither transparency nor chroma key.

Because the failure is created upstream of extraction, generation is also validated after the fact: for a monochrome project style, a result whose visible pixels are meaningfully saturated is refused with "Unexpected color contamination detected" rather than promoted into the library. The threshold ignores anti-aliasing and JPEG ringing (neutral, or tinted only in the single digits) and triggers on real coloured regions.

## D32 — The virtual manga stage (Phase 1 foundation)

Manga Studio moves from "AI image generator plus draggable PNG canvas" to a semi-professional manga system: the creator manipulates semantic manga concepts and the harness owns the geometry. Phase 1 lands the document model and the resolvers; it deliberately does not attempt IK, a 3D renderer, mesh deformation, perspective-aware regeneration, or a professional ruler system.

**Camera and perspective belong to `Panel`, not to `PanelScene`.** `scenes` is rebuilt from items during migration by `rebuildAllScenes()`, so a camera stored there could be clobbered by a rebuild. The panel is the entity; camera and perspective are its properties.

**Presets own the numbers until the creator takes one over.** `PanelCamera.derivedFrom` records which angle/lens produced each derived value. Without it we would have to choose between presets that stomp manual work and presets that stop working after any advanced edit; with it, changing the lens still moves the FOV while leaving a hand-set pitch alone.

**Sockets are derived, never stored.** A socket is a hit-test region over an instance. Persisting one would create a second state system beside the document and would drift the moment the instance is resized or swapped. `socketRegions()` prefers real `focusRegions` metadata and falls back to the documented upper-body heuristic, so accuracy improves without any caller changing.

**Depth is optional and never fights the creator.** An instance without `stage` behaves exactly as before. The current size is interpreted as the size at the previous depth — mid-stage the first time depth is enabled — so enabling depth is a no-op while any real depth change scales relative to where the character already was. `scaleLocked` stops depth driving size once the creator resizes by hand.

**Effects became typed but stayed tolerant.** Params are a discriminated union per kind; `normalizeEffectParams` coerces any legacy or unknown bag into a valid shape, so no document can fail to open because of an effect.

**Bubbles store a relationship, not a baked tail.** `targetCharacterId` / `targetInstanceId` let the tail be recomputed when the speaker moves; untargeted bubbles are never repositioned, because a hand-placed tail is the creator's decision.

Agent scope (§19) needed no new model — `agent/scope.ts` already resolved selected-object / selected-panel / current-page / whole-project with pre-execution `validateStepScope` and post-execution `validateScopeIntegrity`. The new semantic tools were added to `PANEL_TOOLS` so they inherit that enforcement.

## D33 — Reference lineage is a V2 requirement, not a Phase 1 patch

Explicit reference selection must emerge from the Character / CharacterState / StateResolver architecture rather than being bolted on as a UI picker over today's model. Phase 1 deliberately ships no reference selector.

What exists now: `findExactCharacterAsset` (style-locked, full-state, cache-first) and `findCompatibleCharacterAsset` (scored, explicitly guidance-only and never returned as a semantic substitute). `AssetProvenance.canonicalReferenceAssetId` already records which canonical image anchored a render.

What V2 needs before a selector can be correct:

- a **state graph** rather than a flat asset list, so states relate to one another instead of only to the canonical image;
- **reference lineage** — which reference anchored which state, transitively, so drift can be traced to its origin;
- **nearest reusable state** selection, choosing the closest existing render as the parent of a new one rather than always re-anchoring to canonical;
- **delta generation**, asking for the change from that parent instead of a full re-render;
- only then a UI that exposes and lets the creator override the selected reference.

Building the selector first would produce a control over a model that cannot answer "why this reference?", and it would be rewritten immediately.

## D34 — Character Rig 2.0: the state graph fulfils D33

D33 deferred reference lineage until the model could answer "why this reference?". Phase 2 builds that model.

**`CharacterStateRecord` is a semantic node; the asset is its render.** Keeping them separate is what lets a state be requested before it has an image, and lets a render be replaced without losing history. `ProjectDocument.characterStates` holds the graph.

**The graph is maintained at the asset write path, not beside it.** `libraryOps.addAsset` calls `recordAssetState`, and deletion prunes. There is therefore no way for the graph and the library to disagree — a second source of truth would have drifted within a session.

**Canonical images get no node.** They anchor identity rather than being selectable states; giving them one would make "standing/neutral" appear cached the moment a character was created, before anything had been rendered.

**Nearest-state search is weighted by how much of the drawing a dimension changes** — outfit 8, view 6, pose 4, expression 2, props 3. Re-posing in the same outfit preserves far more of a reference than keeping the pose while swapping the outfit. A `maxCost` ceiling means a wildly different render is never used as a reference merely because it is the only one; re-anchoring to canonical beats inheriting the wrong outfit and view.

**Style is part of usability.** A render made under a different `styleProfileId` is not a valid reference for the current style and is excluded from both cache hits and nearest-state search.

**The resolver names the reference; nobody re-derives it.** `stateRuntime` no longer computes its own reference set — it asks the resolver and sends exactly what the selector displays. Canonical still accompanies a derived reference so identity cannot drift further with each step down a lineage chain.

**Props are part of state identity.** The same pose with and without an umbrella are different states, so `props` participates in the state key. They are additive on drop rather than replacing, and normalized (lowercased, de-duplicated, sorted) so order and case cannot fork a state.

**Kit availability has three values, not two.** CACHED means the exact state has a render; AVAILABLE means the value exists in another combination and this one must be generated; NEW means it has never been rendered. Collapsing these is precisely how a tool starts pretending a semantic state exists when only a compatible image does.

**`view` is not a socket.** There is no region of a drawing that means "camera angle", so it stays a dropdown instead of pretending to be a drop target.

Migration v7 → v8 backfills nodes from existing renders. Parentage is left undefined for prior work: we know what each render is, but not what it was generated from, and inventing lineage would poison the graph it exists to make trustworthy.

## D35 — Interactive pose rig: meaning is the identity, coordinates are the authoring

Phase 3 makes the action-figure metaphor real: a draggable skeleton over the selected character, still with no IK, no Live2D, and no raster warping.

**Descriptors, not joints, are the pose's identity.** `poseRigKey` hashes the semantic reading ("right arm raised", "head turned left"), never the coordinates. Keying the cache on pixels would fork a distinct uncached state on every pixel of drag and defeat the cache entirely; keying on meaning lets two different drags — and an Agent request phrased the same way — share one render.

**Joints are stored normalized and sparse.** Only moved joints are kept, as 0–1 fractions of the instance box, so a pose survives scaling, moving, reframing, depth changes, and save/load. The overlay derives pixels on the fly and therefore follows the character for free.

**The draft never touches the document.** Pose-edit mode and the draft rig live in `uiStore`; dragging creates no undo entries, no commands, and no network calls. Only Apply consults the resolver, which reuses an exact cached render when one exists and generates otherwise. Cancel discards the draft with nothing to roll back.

**Constraints are corrective, not solved.** A dragged joint keeps exactly the position the creator chose; only a dependent elbow or knee that has drifted implausibly far off its limb is nudged back. Running a full IK solve would fight the drag and make the rig feel like it is resisting the user.

**A preset is a starting pose, not a lock.** Switching the base preset discards an edit built on the previous one — "walking, right arm raised" says nothing about where that arm belongs while running. Every other dimension keeps the edit.

**Overlay-only by construction.** The rig is drawn on the overlay layer and creates no document item, so it cannot reach an exported page. That is structural rather than a rule to remember.

**One pose path for the Agent.** `set_character_pose_rig` builds the same `PoseRigState` the joint editor produces and routes it through the same state runtime. There is no agent-only pose code.

### Bug found by the acceptance test

`swapInstanceAsset` rebuilt an instance's semantic state via `stateFromAsset`, which had never been taught to read the dimensions Phase 2 and 3 added. Swapping an instance therefore dropped `props` and `poseRig` silently. Fixed at the root: `stateFromAsset` now reads every dimension a render declares. Any dimension added later must be added there too, or the same class of silent loss returns.

## D36 — PoseIntent is the one pose representation, and calibration belongs to the render

Phase 4 closes two Phase 3 gaps: the generic rig did not sit on real artwork, and the editor and the Agent produced pose data by different routes.

**One representation.** `PoseIntent { basePose, descriptors[], jointOverrides?, torsoDirection?, headDirection?, motionVector? }` is produced by both paths. The editor drags joints and derives descriptors; the Agent supplies descriptors and normalizes them. Everything downstream — cache key, resolver, prompt — consumes only a PoseIntent, so there is no agent-only pose vocabulary and no agent-only pose path.

**Consistency rule.** Joint edits are authoring truth; descriptors summarize them. `normalizePoseIntent` re-derives descriptors whenever joints are present, so contradictory descriptors are discarded rather than merged. Descriptor-only intents keep their normalized descriptors.

**Descriptor normalization is token-based, not a lookup table.** "raise her right hand", "right hand up" and "lift right arm" all reduce to side=right, part=arm, action=raised → `right arm raised`. A table would only cover phrasings we thought of; unrecognized text returns null rather than being coerced into the nearest descriptor, because a wrong pose is worse than an ignored one.

**Calibration is stored per rendered state, not per character.** A walking render and a crouching render need different alignment; a single per-character fit would be wrong for both. It lives on `CharacterStateRecord.poseCalibration` and never triggers regeneration — it only moves where the editor draws the skeleton.

**A calibrated joint carries its descendants.** Aligning the hips moves the whole lower body; aligning a hand moves only the hand. Without propagation, fitting one landmark would visibly detach the limb it belongs to.

**Calibration does not participate in the cache key.** It is alignment, not pose, so a calibrated walking render still satisfies a plain walking request.

### Three bugs the acceptance test caught

1. **`"look right"` parsed to nothing.** The bare side word was consumed as a body side before it could serve as a direction. For head and torso a side word IS the direction, and verbs like "look" and "lean" now imply their body part.
2. **Dragging a hand reported a bend nobody asked for.** The untouched elbow was left off the limb line, so "raise the arm" also produced "right elbow bent" — and the Agent's equivalent intent did not, breaking unification. Dragging a tip now carries its mid joint at half the delta, which is also how a puppet limb behaves.
3. **Bend was measured absolutely, not as a change.** A calibrated arm that already looked bent reported "elbow bent" with zero movement, so a calibrated character read as permanently posed. Bend is now a delta against the calibrated baseline, consistent with every other descriptor.

## D37 — The camera stage becomes visible

Phase 1 shipped a complete, tested, serializing camera and perspective model that **nothing read**. `shotCoverage`, `depthSortKey` and `perspectiveGuideLines` had zero call sites; `panel.camera` was touched only by the inspector that displayed it back to itself. Phase 5 connects the model to the renderer. It adds little new architecture — it makes the existing architecture have consequences.

**`domain/staging.ts` is the projection engine.** Deterministic and pure: panel + camera + instance → transform. No physical camera solve; a manga stage compresses depth for readability rather than reproducing optics.

**The ground line is the anchor, not the image centre.** Scaling about the centre is what makes characters float as they move through depth. Feet stay on the ground line, so two characters at different depths read as standing on one floor.

**Base heights are captured under the OLD camera before a change.** Inferring them under the new camera reproduces the current size exactly and the lens or perspective change does nothing — the same cancellation bug Phase 1 hit with depth.

**Framing follows the focal subject.** `Panel.focalItemId`, falling back to the last character in the panel. Zooming the geometric centre would frame whatever happened to be in the middle rather than a face.

**Optical and manga perspective are separate multipliers.** Lens exponent comes from FOV; manga exponent from `mangaPerspectiveStrength`, and is exactly 1.0 at strength 0 so the control is honest at its default. One is what a camera would see; the other is the artist overstating it.

**Auto depth order is opt-in and defaults off.** Turning it on for existing projects would silently rearrange compositions people had already made. Only staged assets are reordered; bubbles and effects keep their band.

**The redraw boundary is explicit.** Shot and lens are transform-only — cropping to a close-up is honest, the artwork is unchanged and the viewport is tighter. A low or overhead angle is not: it is a new viewpoint that scaling cannot fake, so it reports `requiresRedraw` with a reason rather than stretching the image and calling it a low angle.

### Four bugs the acceptance tests caught

1. **Depth ordering was inverted.** `depthSortKey` is `-depth`, so the comparator had to sort ascending to put the farthest first; it sorted descending and drew near characters behind far ones.
2. **Angle changes did not reframe.** Framing ran only when the shot changed, so setting a low angle moved the horizon but left the subject where it was.
3. **Lens changes did nothing** — the base-height cancellation above.
4. **Depth could not release a framed subject.** Camera framing sets `scaleLocked`, and the Agent's depth tool did not clear it, so "put Mio in the foreground" silently failed after any shot change.

## D38 — Camera integrity: one framing engine, honest controls

Phase 5 made the camera visible. Phase 5.5 removes the places where the UI still claimed control the renderer did not honour. The governing rule: a control either visibly affects composition, is explicitly labelled experimental, or is not exposed.

**One framing vocabulary.** Two paths existed: the panel camera scaled the subject geometrically, while `compose_character` mapped a different word list onto crop presets — so "close-up" could mean a real close-up or a `face` crop that silently degraded to `upper-body` when the asset had no face region. Every framing word now resolves through `resolveShotType` to a canonical `ShotType` and is laid out by `frameSubject`. The two paths are tested to produce identical geometry for the same word.

**Dutch roll is real.** `PanelRenderer` rotates scene content about the panel centre inside the clip, so the shot tilts and the frame stays square. Export walks the same scene graph, so the page matches the editor. `PanelRollGroup` tilts the overlays with it — Konva reports a dragged child's position in its parent's space, so the overlays' existing inverse maths keeps working unrotated inside the rotated group.

**Yaw pans the framing.** That is the honest 2.5D consequence: turning the camera moves the subject in frame. It cannot show another side of an existing drawing, and `cameraChangeRequiresRedraw` says so past 20°. The control is labelled with exactly that boundary rather than hidden.

**Three-point is guide-and-context, and admits it.** The third vanishing point draws guides and contributes a real vertical-convergence instruction to generation, but no raster is re-projected. The UI states this and the redraw decision returns true.

**"Snap to Stage", not "Snap".** The honest name: it snaps staged characters to the ground plane and infers their depth. It does not snap arbitrary line art, and the label says so.

### The contradiction the acceptance test exposed

Two ground models had been built without noticing they disagreed. `projectInstance` placed every character's feet on one flat line, while `depthFromGroundPoint` — written for canvas dragging — assumed a floor receding toward the horizon. Dragging a character "deeper" therefore computed a depth against a floor the renderer was not using.

Resolved by making the floor recede **only when a horizon exists**: with perspective active the plane has depth in it and a distant character's feet sit higher in frame; with perspective off there is no horizon to recede along and the flat line is correct. A Phase 5 test asserting both characters share one screen y encoded the flat model and now asserts the stronger property — each character's feet land exactly on the ground plane at its own depth.

Changing the horizon now restages the panel, for the same reason a camera change does: the horizon *is* the floor.

## D39 — Manga Puppet becomes the primary editable character representation

*(The brief suggested numbering this D36; that number is already taken by the Character-Rig-2.0 record, so this is D39.)*

Until now a character was a flattened generated PNG with a semantic skeleton drawn on top. Changing an expression or a limb therefore required regenerating the whole character.

**The reason for the pivot is not that generation quality is poor.** It is structural:

> A semantic skeleton over a flattened raster has no authority over the pixels. Direct manipulation is therefore illusory unless the render representation is itself articulated.

Every workaround we built confirmed it. Phase 3 gave the rig joints, but Apply had to regenerate. Phase 4 added calibration because the generic skeleton never matched the artwork — a problem that only exists because the skeleton and the pixels are separate things. Descriptors, lineage, nearest-state references and delta prompts are all machinery for asking a model to redraw something the editor could not change itself. The representation was the bug.

**`MangaPuppet` is a hierarchy of textured parts with anchors and pivots.** Rotating an upper arm carries the forearm and hand because that relationship is computed in `transforms.ts`, not baked into pixels. An expression is a set of replacement facial parts, so applying one *cannot* reach a torso, a transform, an outfit or a panel — the guarantee is structural rather than a promise in a comment.

**The puppet rides on `AssetInstance` rather than becoming a new item kind.** `kind === "asset"` appears in twelve-plus files across agent context, scope, executor, composition validation, canvas and commands; a new kind would fork all of them and silently exclude puppets from depth, camera, framing, z-order and export. An instance is still "a character in a panel with a transform" — only rasterization changes, so the entire Phase 5.5 camera stage applies to puppets with no new code.

**Renderer: extend Konva, no new dependency.** Nested `Group`s compose transforms, child order gives per-part z-order, clipping already works, and events bubble to the outer group so clicking an eye selects the actor. PixiJS was considered and rejected: there is no evidence WebGL is needed for tens of parts.

**Capability is explicit, never silent.** `canApplyJoint` refuses a rotation past its limit with a reason and a fallback recommendation instead of distorting. `PartReadiness.hiddenRegionComplete` is honest about the occlusion problem: the fixture's upper arms were cut from a flat drawing, so a large shoulder swing reports `approximate` quality rather than rendering a hole where the torso should be.

**The AI path is demoted, not deleted.** The state graph, lineage, nearest-state resolver and reference selection become *more* valuable as the fallback for what the puppet genuinely cannot represent — a back view, a crouch without legs, extreme foreshortening. `PoseIntent` descriptors still describe those requests. What changes is that they are no longer the default route for a face change.

**Semantic state, puppet parameters and generated lineage are three different things** (§14). `CharacterState` stays semantic (walking, shocked, school uniform). `PuppetInstanceState` is how that state is currently rendered locally. Only generation creates graph nodes — a five-degree elbow move must not litter the lineage with meaningless ancestry.

Legacy flattened characters keep working untouched. Migration v9 → v10 is purely additive: no asset is reinterpreted as puppet parts, and no character gains a puppet it did not have.

## D40 — Entity grounding precedes creative planning; NOT_FOUND never means create

The Manga Agent was inconsistently resolving existing characters: a prompt naming Yuri could place Cute Girl, or invent a second "Yuri". The cause was not prompt quality.

**Identity was resolved at execution time, per call site, by a bidirectional substring match.** `findCharacter` ran `name.includes(query) || query.includes(name)` and returned `.find()`'s first hit in insertion order. It had no concept of ambiguity, so two plausible characters silently became one arbitrary answer. Six executor call sites each ran it independently. The planner was told to "reference characters by their exact names"; the context listed names without IDs and truncated at 6000 characters, so a large project could hide a character from the model entirely — and the most natural repair for a character the model cannot see is to create one. `create_character` was unconditionally available, and a failed step did not stop the run, so a plan could fail on Yuri and still place Cute Girl.

**Grounding now runs before the model is called.** `resolveCharacterReference` is the one canonical resolver and returns only RESOLVED, AMBIGUOUS, or NOT_FOUND. Its ladder is deterministic — id, exact name, normalized name, stored alias, pronoun-from-context, then whole-token containment anchored on the name's leading token. It never matches a bare substring, never resolves a description ("the black-haired girl") or a relationship ("Yuri's friend"), and returns AMBIGUOUS rather than choosing when more than one character matches. A suspected misspelling ("Yu ri") is reported for confirmation instead of bound silently.

**Creation is privileged and gated by the user's own words**, not by whether resolution succeeded. `detectCreationIntent` reads the prompt; "Create a new character named Hana" authorizes creation, "Yuri walks into the room" never does. The authorization is enforced twice — in plan validation and again at the executor's creation boundary — because the first protects against a bad plan and the second against a bad caller.

**An unresolvable reference blocks the whole run rather than failing one step.** The remaining steps were written assuming that step succeeded; executing them is precisely how a panel ends up holding the wrong character.

**Execution runs on IDs.** Plan validation binds every character argument to a `characterId` before anything mutates, and rewrites the display name to the bound character's real name so a step label can never read "Yuri" while operating on someone else. The library is re-checked at the generation boundary against the *current* document, because the plan was validated against an older one. Post-conditions then verify the document itself: the requested character is in the requested panel, and no Character exists that the run was not authorized to create.

## D41 — Manga language is a library, not a toolbar

Manga vocabulary was four hard-coded effect kinds in a dropdown. A dropdown cannot grow with a project, so a creator could not bring their own bubble shape, their own anger mark, or anything an AI generated for them.

**Manga language is now a first-class project library** across six categories, fed by three sources: built-ins for speed, uploads for creator ownership, and AI generation to fill gaps. The Agent orchestrates all three through the same search function the creator's search box uses — so the agent can never "reuse" something the human cannot find, or miss something visible on the shelf beside it.

**Built-ins are code, not document data.** They are merged in at read time rather than written into every project, which means they cannot be deleted into undeletable clutter, a new built-in appears in existing projects with no migration, and a saved document carries only what the creator actually owns.

**Structured and visual are kept distinct.** Bubbles, lines, tones and SFX stay parameterized objects that remain editable for the life of the document; a built-in bubble is never a generated bitmap. Uploaded and generated graphics are `SourceAsset`s placed as ordinary `AssetInstance`s, so they inherit transforms, z-order, camera staging and export with no new machinery. Presets like "Radial Speed" and "Shadow Tone" are variations on the existing typed `EffectParams` — new *presets* are data; only a new *kind* is a renderer change.

**SFX reuses the bubble item rather than adding a PanelItem kind.** D39's lesson applies: `kind === "asset" | "bubble" | "effect"` is matched across a dozen files, and a fourth kind would fork all of them. SFX is `bubbleType: "sfx"` with a style whose shape is `none` and whose outline is heavy — editable text, no balloon, and every existing path (selection, transform, undo, export) works untouched.

**Attachment is a document relationship, not a UI convention.** `ItemAttachment` stores the offset in the target's own frame, so a sweat drop follows Yuri through drags, resizes and camera restaging; the command layer recomputes it after anything that can move a subject. Detaching leaves the effect exactly where it is, and deleting the subject releases the attachment rather than snapping the effect to the origin.

**Reuse before generate is enforced deterministically, not by prompting.** `generate_manga_effect` is rejected during plan validation when the library already holds a match, and re-checked at the generation boundary against the current document. The search requires most of the query's meaningful words to land: sharing the single word "black" with "Black Focus Rays" is not a reason to drop focus lines into a panel that asked for smoke — and a weak match masquerading as a hit would suppress the generation the request genuinely needs.

## D42 — V3.2: the puppet becomes usable, and projects become real

**Canvas direct manipulation.** Joint handles and the face drop target are computed from the puppet's actual posed geometry (`jointHandles`, `faceDropTarget`), not from percentage bands — a tilted head moves its own drop target. Dragging a handle converts the pointer into a rotation against the bone's rest direction, so the manipulation is direct rather than a slider mapped onto a limb. Drags go through `transientDispatch` and commit once on release: continuous update, one undo entry. There is deliberately **no Apply button** for local puppet operations — a rotation inside the joint's limits costs nothing, and asking for confirmation would imply a cost that does not exist.

**The capability boundary is visible, and never silent.** A pointer past a joint limit stops the bone at the limit and reports `clamped`; the puppet is never distorted to satisfy the cursor. The prompt then offers Cancel / AI Redraw / Create New Puppet State, so escalation to a paid generation is always a choice rather than an accident.

**Legacy and puppet UI no longer mix.** A puppet-backed instance shows FACE / POSE / HANDS & PROPS / PUPPET and *not* the Pose Edit → regenerate flow, nor the generative Pose and Expression dropdowns. Outfit and View remain, because the puppet genuinely cannot change either. Flat characters keep Edit Pose / Calibrate Rig unchanged.

**Compiler v1 crops; it does not segment.** `PuppetPart.sourceRect` lets a part draw one rectangle of the canonical render. This is the honest minimum: no pixels are fabricated, the source asset is never modified, and every part's provenance is a rectangle a human confirmed. The wizard's step 1 says in as many words that the proposal is standard manga proportions rather than a detection result, and `compilerIssues` warns for every region left unconfirmed. `hiddenRegionComplete` stays false for arms until reconstruction actually produces an underlayer, so `canApplyJoint` reports large swings as approximate rather than rendering a hole.

**Hidden-region reconstruction writes a separate asset.** The image-edit provider is asked to redraw only the area behind a limb, preserving identity, outfit, line style and monochrome. Providers edit whole images and we cannot enforce "only these pixels changed" at that boundary — so the result becomes a *new* asset used only as the occluded part's backdrop. The canonical render is never overwritten, which means a bad edit cannot damage the character.

**Projects are real, not tabs.** IndexedDB already stored one record per `project.id`; what was missing was listing, deleting and switching. The list is derived by reading stored documents rather than kept in a side index, because a list that disagrees with what is actually stored is worse than one that takes a few milliseconds longer. Project switching goes through `loadDocument`, which resets history — undo must never step back into a project the creator has left.

**Duplicate deep-clones and repoints `projectId`, but keeps internal ids.** Deep cloning is what guarantees no shared mutable state, which is the property that matters. Internal ids are only ever resolved within their own document, so a cross-document collision is unobservable — whereas remapping every cross-reference (asset ids, part ids, expression slots, bubble targets, focal items, lineage parents) is exactly the sweep where one missed field silently corrupts a copy. Image blobs are immutable, so the copy shares them.

**Deleting the active project can never produce a broken editor**: it falls back to another project, or clears the document and shows the welcome state, and the stale `lastProjectId` pointer is removed so a reload cannot try to open a deleted project.

**Left dock is navigation; right inspector is editing.** The duplicate Pose / Face / Outfit / View matrix (`CharacterKitPanel`) is deleted. The left character browser now shows canonical preview, puppet status, rendered states, + Variation and Convert to Puppet — discovery, not a second editing surface competing with the inspector at different cost.

## D43 — The purple halo was contaminated RGB, not failed segmentation

A generated colour character showed saturated magenta fringes around hair, shoulders, arms, hands and trousers after background removal, even though the background itself was fully transparent.

**Measured, not inferred.** A probe ran physically-correct chroma-key sources through the real pipeline and sampled the silhouette. A black-hair edge at 75% coverage arrives from the generator as RGB `[73, 9, 76]` — exactly `0.75·[12,12,16] + 0.25·[255,0,255]`, which is what anti-aliasing *is*. The extracted PNG contained `[73, 9, 76, α=255]`: alpha correct, RGB still one-quarter magenta. The halo therefore existed in **both** the source (unavoidably) and the extracted PNG (avoidably), and compositing merely revealed it.

**Segmentation was never the bug.** That pixel is mostly foreground, so the perimeter flood correctly refused to key it out — and because it stayed fully opaque, the old `suppressKeySpill` never even looked at it: that function skipped `alpha === 255`. It could not have fixed the visible halo under any tuning.

**Where it did fire, it destroyed artwork.** It pushed RGB toward grey, turning a legitimately purple prop's edge from `[176, 45, 206]` into `[79, 79, 79]`. That is desaturation dressed as a fix: it removed real colour to hide a symptom.

**The fix un-mixes the blend.** For a rim pixel we know the matte and can read the true foreground from clean pixels a little deeper inside the silhouette. The blend then lies on the segment matte→foreground, and its position along that segment *is* the coverage:

    α  = clamp( (Csrc − M)·(F − M) / |F − M|² , 0, 1 )
    Cfg ≈ (Csrc − (1−α)·M) / α

Black hair recovers to `[12,12,16] @ α=191`; the purple prop recovers to `[150,60,190] @ α=188` — its real colour, because recovery targets the **local foreground**, never neutral.

**Two findings forced corrections during implementation.** A one-pixel erosion is not enough to locate clean reference colour: a soft edge several pixels wide is contaminated several pixels deep, and every pixel in that band is surrounded by other contaminated pixels, so the erosion happily returns a reference that is itself part magenta. A distance transform measures the band instead of assuming its width. Separately, taking the *median* of a reference window fails where the window straddles a colour boundary — a purple bag against black hair — producing a colour that exists nowhere in the artwork; choosing the candidate with the **smallest residual** asks the right question directly: which neighbouring colour, mixed with this matte, explains this pixel?

**Guardrails.** A pixel whose residual from the matte→foreground line exceeds a threshold is left alone, because it is independent artwork rather than a blend. Alpha is never raised above what segmentation concluded, so decontamination cannot resurrect background. Below 15% coverage the division is unstable, so the local foreground colour is used directly. Rejected outright: raising the removal threshold, eroding the silhouette, keying magenta indiscriminately, global desaturation, and prompt changes — none of those recover a foreground colour, and most destroy real artwork.

This matters beyond one image: puppet-native generation composites many independently extracted parts, so every part would have carried its own fringe.

## D44 — One HitStack, consumed by every selection surface

Overlapping panel content was effectively unreachable. Selection was Konva's own picking: each node wired `onMouseDown={onSelect}` and whichever node the hit graph reported first won.

**Three concrete defects fell out of that.** An image node's hit region is its full rectangle, so a character cutout's transparent corners captured clicks across a large slab of the panel. `locked` only disabled `draggable`, never `listening`, so a locked background still intercepted every click it covered. And there was no route to the second item under the pointer — no cycling, no menu, no layer list.

**`hitStack()` is now the single resolver**, pure and free of Konva and the DOM. Order is `panel.itemIds` and nothing else: last drawn is topmost is selected first. There is deliberately no category ranking, so a prop deliberately placed above a character is what a click on that prop selects.

**Selection moved from the nodes to the stage.** Nodes no longer pick for themselves; the stage resolves the pointer through the HitStack and selects. Dragging is gated on selection (`draggable = selected && !locked`), which is what makes cycling safe — without it, cycling to a lower layer would leave the top layer draggable and a drag would move the wrong thing.

**Alpha-aware hit testing** samples a downsampled per-URL alpha mask, built lazily from the already-cached image element. A mask that has not decoded yet returns null and the test falls back to bounds, because refusing to select something the creator can see is worse than a slightly generous hit region. Bubbles test against their ellipse rather than their box, so a balloon's empty corners stop swallowing the art behind them.

**A puppet stays one actor.** Its parts are hit-tested individually — clicking between an arm and the torso is correctly a miss — but the hit resolves to the *instance*. Internal part ids never enter the stack, so the Layers panel lists actors rather than eyelids.

**The Layers panel is a projection**, not a second tree: `panelLayers()` is the same function without a point filter, so list order is render order by construction. Locked rows stay fully interactive there, because that is the surface that unlocks them — refusing to select a locked layer in the list would strand it.

**Effects hit-test by bounds.** They are procedurally drawn line work with no texture to sample, so a full-panel screentone does capture clicks across the panel. That is z-order behaving correctly rather than a bug, and cycling, locking and the Layers panel are the remedy.

## D45 — Decontamination belongs to every alpha source, not just the one we key

D43 fixed the purple fringe for images we key ourselves. Production kept showing it, because generated colour characters mostly do not take that path.

**Two paths bypassed decontamination entirely.** `processAssetImage` returns early when the source already carries useful alpha, and `validateTransparentImageBytes` — used by the image-edit provider and by dedicated background-removal services — validated and re-encoded without touching RGB. Decontamination lived only inside the built-in flood, which is the single path D43 tested.

**The bypass became visible through storage, not rendering.** The native-alpha branch returned no `processedData`, and `processAndStoreAsset` then did `processedImageUrl = source.url`. Every contract check passed — status ready, alpha present, derivative URL present — while that URL pointed at the untouched provider file. The renderer was correct; the field had been aliased to the contaminated original.

**Measured on the real path:** black hair edge arrived as `[41,18,49] @ α=234` where the true ink is `[22,20,30]`; magenta excess on white was 25 for hair, 32 for trousers, 14 for the shirt. Byte-identical before and after processing. The opaque-magenta path, by contrast, already produced exact `[22,20,30]`.

**A provider's alpha carries no record of what it was keyed against**, so the matte is now inferred from the provider's own output by inverting the same equation: `M = (Csrc − a·F) / (1 − a)` over the rim, median across all samples.

**The first attempt at that silently declined**, and the reason is worth recording: real anti-aliasing does not spread coverage evenly. Measured on a 1px edge, alpha clusters near the extremes — ≈20 and ≈234 — with almost nothing between, so a "mid-coverage only" sampling window found no samples at all. Low-alpha pixels are also the *best* estimators rather than the worst: at a=0.08 the divisor is 0.92, so quantisation barely moves the answer and the pixel is nearly pure matte. Sampling now prefers that well-conditioned end.

**It declines rather than guesses** when the inferred matte sits on top of the artwork's own colours, or when the estimates never agreed — both of which mean a genuinely clean cutout, where "recovering" anything would rewrite real pixels.

**Premultiplication was audited and ruled out.** A half-transparent saturated pixel round-trips through sharp's PNG encode/decode byte-identical; the pipeline is straight alpha throughout.

**Two obsolete tests changed.** Both asserted `processedData` is undefined for an RGBA source — "no re-encoding needed". That assumption is precisely what let the raw source be rendered, so a transparency-requiring asset now always carries a real derivative or fails outright.

## D46 — A pipeline fix does not reach images already processed

After D45 shipped and deployed, the purple fringe was still visible on a character in production. The code was correct and live; the assets were not.

**A derivative in object storage keeps whatever bytes it was written with.** The character had 18 renders, all generated by earlier deployments, and `processedImageUrl` pointed at PNGs produced before edge decontamination existed. Redeploying rewrites code, never stored images.

**There was no way to repair them.** The library's Retry control is gated on `!assetSatisfiesTransparencyContract(asset)` — it appears only for assets that FAILED. A contaminated asset is `ready`, passes every check, and renders. Precisely the assets that needed rebuilding were the ones the UI offered no way to rebuild.

**Repair rebuilds the derivative from the untouched original.** `storageUrl` is never modified, so a rebuild is repeatable and cannot degrade the source. It runs sequentially because each asset is a provider round trip.

**A rebuild must not be able to break an asset that currently works.** Without care, a failed repair marks the asset failed, `assetRenderUrl` then returns undefined, and a character that was on the page a moment ago disappears — a strictly worse outcome than the fringe being repaired. `preserveOnFailure` restores the asset's previous processing state, and a batch continues past a failure rather than aborting.

The general lesson worth keeping: **any fix to an asset-processing pipeline needs a migration story for already-processed assets, or it is only half shipped.** D43 and D45 both fixed real defects and both left production visibly broken for this reason.

## D47 — Pure white is the only foreground backdrop

Three separate fixes chased the purple fringe downstream. This removes its source.

**Coloured artwork was deliberately generated on a magenta screen.** A saturated matte is blended into every anti-aliased edge pixel by definition, so the contamination was created at generation time, before any extraction code ran — and the model additionally bounced the screen colour onto hair strands as *intended* artwork, which no post-process can separate. Every extraction path then had to be taught to undo it, so any path that forgot reproduced the halo. Decontamination made the symptom recoverable; not introducing the matte makes it impossible.

**One policy, one place.** `foregroundAssetPolicy` is the single decision. Characters, props, expression variations, SFX and manga-language decorations consume it; none carries its own `#FFFFFF` string or chooses a backdrop. Monochrome and colour take the same path — the old split is exactly what let a chroma key survive for colour art. A provider with real alpha still wins, because then there is no matte at all.

**White is safe only because extraction is connectivity-based.** The perimeter flood removes background reachable from the border and never enters enclosed regions, so white shirts, eye whites, highlights and paper survive. A global "near-white becomes transparent" rule could not use this strategy.

**The contract is verified before keying, not assumed.** `validateWhiteBackground` measures the border and refuses extraction when the provider returned a coloured, dark, gradient or textured backdrop, naming the colour it found. It is opt-in and set only by the generation path: uploads may carry any backdrop, and repairing a pre-policy asset means re-extracting the very magenta matte it was generated with. Mild noise is deliberately accepted — variation the flood's own tolerance absorbs is cleanly removable, so failing it would block a usable render for nothing.

The magenta decontamination code stays as legacy repair. It is no longer part of the expected path.

## D48 — Relationships, interactions and puppets are three different things

**A relationship is who two characters ARE; an interaction is what they are DOING in one panel; a puppet is how one of them currently renders.** Collapsing any pair breaks something: a hug in panel 3 would imply a permanent bond, a friendship would imply a pose, and an interaction would inherit one participant's rig limits.

**`hug(Yuri, Mio)` must never decay into two pose values.** Two independently generated renders share no geometry, so the arms miss, the torsos interpenetrate and the scales disagree. The interaction owns what is *between* the participants, which is why it is an object rather than a field on each character.

**Capability decides local versus generative, and says why.** `beside` is placement and works for flat characters. `hold_hands` is a shared contact point two rigs reach toward. `hug` is `JOINT_GENERATION` **even when both characters are fully rigged** — not a rig limitation: no joint rotation produces the occlusion of one arm passing behind the other's back, because the source artwork does not contain it. One rigged and one flat participant reports `HYBRID` rather than pretending either extreme.

**Joint generation sends every participant's own reference.** Describing one character in text while sending the other's picture is what makes a model blend two people into one, so a participant without a usable reference is a hard failure rather than a text fallback.

**Composite renders are recorded honestly.** `InteractionRender` knows the image contains Yuri AND Mio, so grounding, reuse, lineage and deletion can all reason about it. The mode is stored as `composite`: pretending a joint render is still two independently editable puppets would be the same lie as a skeleton drawn over a flat PNG.

**Cache identity is participants + roles + outfits + view + style.** Participants sort so Yuri+Mio matches Mio+Yuri, but roles do not — "Yuri hugs Mio" and "Mio hugs Yuri" are different pictures.

**Relationships resolve phrases, never invent them.** "her close friend" resolves only through a stored edge. A recorded relationship *kind* that this character lacks — "her sister" with no sibling edge — returns NOT_FOUND rather than falling through to a token match that might hit someone unrelated.

## D49 — Rigging becomes an implementation capability, not a workflow

Convert to Puppet, the compiler wizard and raw joint sliders now live behind Advanced. The machinery is unchanged and still powers every free local edit; what changed is that a creator never has to segment body parts or confirm sixteen rectangles to move an arm. The user directs the scene; the harness picks the implementation.

## D50 — Click applies to the selection; drag targets another actor

The semantic state cards were `<span draggable>` with **no click handler at all**
and a tooltip reading "Drag onto the character's face". Clicking — the first
thing every creator tries — did nothing.

The rule is now uniform across expressions, poses, outfits, props and manga FX:
**click applies to the current selection, drag targets a different actor on
canvas.** Drag survives as the power-user shortcut for multi-actor panels; it is
never required for the ordinary one-character case.

Each card also states whether applying it is instant or costs a render, because
that is the one implementation fact a creator genuinely needs. `LOCAL_PUPPET`
and `JOINT_GENERATION` stay internal words: the UI says "Instant" or "Generate".

## D51 — Scene, Object and Prop are three creator-facing ideas

"Backgrounds" was too narrow and "Props" meant two different things.

- **SCENE** — a rectangular environment (classroom, street, bedroom). Keeps its
  whole image and is **never** sent through foreground extraction.
- **OBJECT** — a reusable isolated item (lamp, notebook, bag). Generated on pure
  white and cut out.
- **PROP** — an Object *in use* by a character. The same asset, a different
  relationship; not a duplicate asset.

Underneath, Scenes map to the `background` category and Objects to `prop`, so no
schema change was needed — the rename is creator-facing vocabulary over an
existing distinction that the pipeline already enforced.

## D52 — Relationships live with the character; interactions live with the scene

Persistent relationships are edited on the character card in the left library,
because they are project facts that improve Agent grounding. Interactions are
created from the right Inspector beside the selected actor, because that is
where a creator is standing when they decide two characters should do something.

**Relationship metadata is not a prerequisite for an interaction.** Two actors
the creator has already selected on canvas need no recorded friendship to hug.

## D53 — Provider output is never trusted outside a local edit mask

A prompt saying "only change the selected area" is a request. Image-edit models
redraw the whole frame: they re-encode the background, shift line weights, drift
skin tone and quietly restyle a face while faithfully doing the one thing that
was asked. Accepting their output wholesale is how a local hand fix silently
becomes a different character.

**The guarantee comes from our compositor, not the wording.** `compositeLocalEdit`
takes provider pixels only where the creator's mask is non-zero and copies the
original byte-for-byte everywhere else. Tested by handing it a provider fixture
that repaints the entire image magenta and asserting every unmasked byte is
identical afterwards.

**Feather runs inward.** A symmetric blur would spread coverage outward and let
provider pixels bleed past the selection. The blurred mask is multiplied back by
the drawn mask, so coverage outside it is exactly zero by construction. The
per-pass box radius is a third of the requested feather, because three stacked
passes reach three times as far — otherwise "feather 6" would have softened
roughly eighteen pixels and the control would not have meant what it said.

**Masks live in image space.** Zoom, pan and display scaling change what the
creator looks at; they must never change which pixels are editable. The editor
converts pointer positions once, at the boundary, and the mask canvas stays at
the asset's own dimensions.

### Three edit scopes

- **ASSET EDIT** — changes a reusable asset. Default is *Save as Variation*;
  replacing the original is confirmed separately because existing panels use it.
- **INSTANCE EDIT** — changes one placement, implemented as a variation plus a
  single `swap-instance-asset`. Other panels are untouched.
- **COMPOSITE EDIT** — pixels spanning several actors (Yuri hugging Mio). Not
  built in this phase; the edit core takes an image, a mask and an instruction,
  so it does not assume a single asset and can be reused for it later.

**Visual edit lineage is not semantic character state.** A cosmetic repair
records `provenance.localEdit` and deliberately does not create a
`CharacterStateRecord` — registering a node for every pixel fix would fill the
state graph with entries indistinguishable from one another.

## D54 — An Agent run either lands whole or does not land

`executePlan` snapshots the document, executes, validates, and only then commits;
anything fatal restores the snapshot. Before this, per-step failures were caught
and swallowed and `endTransaction` committed unconditionally, so a run that
wrecked a finished page reported "Done with 1 warning" — the failure that
prompted the rule.

A failed AI_GENERATION step stops the run rather than continuing. The artwork the
remaining steps were going to place does not exist; composing around a hole
produces a page that is wrong in a way the creator has to unpick by hand.

**Rollback restores the PAGE, not the library.** Images already generated cost
real money and real time, so new assets, their state records and the generation
log survive the rollback; only the composition is restored. A retry must not pay
for the same image twice, and erasing the record of why a run failed at exactly
the moment the creator wants to know is the wrong instinct.

## D55 — Validation issues have severity

`CompositionIssue` carried only `corrected: boolean`, so "Character is completely
obscured by a higher layer" and "recentred a character" weighed the same and both
appeared beside a success message. `severity: info | warning | fatal` is what lets
a run refuse to commit.

Fatal: a required participant missing, a participant fully obscured, an
interaction rendered without one of its people, a scope violation, an
unauthorized character, and existing items disappearing from a panel the run was
only meant to add to.

## D56 — One interaction service, two callers

`domain/interactionService.ts` owns capability evaluation, cache reuse, the joint
render and placement. The Inspector calls `renderInteraction` then
`placeInteractionRender` so it can preview first; the Agent calls
`executeInteraction`, which does both. Two pipelines would drift until a hug
meant different things depending on how it was asked for.

A joint render RETIRES the sprites it replaces by hiding them, because the
composite already contains both people. Hidden rather than deleted: undo and
"discard" both restore the panel, and the creator can bring one back from Layers.
This also exposed that `visible: false` was never honoured by the renderer — the
Layers eye toggle had been decorative.

## D57 — A cosmetic repair replaces the render it improved

Fixing a malformed hand in "Yuri, standing" produces better pixels for a state
that already exists, so it does not create a state node — but the node must now
point at the repaired image, or every later "place Yuri standing" quietly
reintroduces the defect the creator just paid to fix. The superseded image is
kept for lineage, and when the CANONICAL image is repaired the identity anchor
moves too, so future generations are not anchored on the broken hand.

`characterAssetRole` gains `variation` and `panel-only`. A panel-only image — a
joint interaction render — is never resolvable as "what this character looks
like": otherwise "place Yuri" could return a picture of Yuri mid-hug with
somebody else.

## D58 — A second character does not land on the first

Every fit placement centres on the panel, so "place Yuri, place Mio" put one
exactly behind the other: a valid document that renders as one character. New
placements now pick the emptiest slot across the panel. Existing items are never
moved — a run asked to add someone may not rearrange what the creator composed.

## D59 — Overlay handles own their press

The stage re-resolved selection on every mousedown, including presses that landed
on a depth handle or a vanishing point, which selected the panel underneath and
unmounted the handle mid-drag. The gesture died on the first pixel of movement
and read as a dead control. A press on a draggable node now belongs to that node.

## D60 — Kumanga, and one mark built from one geometry

The product is Kumanga: *kuma* + *manga*, tagline "AI Manga Studio". The mark —
black bear head, white muzzle, small outlined manga speech bubble at the lower
right — is a RECONSTRUCTION of approved reference artwork. It is never
regenerated, redesigned, or replaced with something AI-drawn.

It is built as a **single-colour silhouette with holes**, not as stacked black
and white shapes. The eyes, muzzle and bubble interior are the surface showing
through, so one drawing is the black mark on a light tile and the white mark on
a dark toolbar. That is what stops a "light version" and a "dark version"
drifting apart, and it is why the in-app component can simply inherit
`currentColor`.

Every variant is generated by `scripts/build-brand.mjs`. Editing an SVG by hand
is how the favicon and the toolbar stop being the same bear.

**At favicon size the bubble is dropped.** Its ring is 2.6 units in a 64-unit
box — at 16px that is a third of a pixel, which turns to mud and drags the head
off centre with it. The bear silhouette is the part that still identifies
Kumanga at that size, so `compact` keeps that and loses the rest. Simplifying is
not the same as substituting: it is the same bear.

The bear is BRAND. It never becomes a toolbar icon — editor controls stay
conventional and immediately understandable, and a bear-shaped Undo would be a
puzzle, not a tool.

## D61 — Flat by default: one icon set, five button roles, tone over borders

Kumanga reads as professional creative software (Figma, Linear, Photoshop), not
as a mobile game. Three rules carry that:

**No emoji in the product UI.** Emoji rendered as somebody else's artwork at
somebody else's colour and weight, changed between platforms, and could not
express state — a 👁 cannot be "disabled". Every functional glyph is now Lucide,
re-exported through `src/components/ui/icons.tsx` so the size and stroke contract
lives in one file. Keyboard-shortcut notation (⌘Z) stays: it is text, not an
icon.

**Five button roles, and only two draw a filled shape** (`ui/Button.tsx`):
primary, secondary, ghost, icon, danger. Before this, nearly every action was a
bordered rectangle, so nothing looked more important than anything else. Danger
reads as danger on HOVER, not at rest — a delete button that is red all the time
is just noise.

**Hierarchy from tone, not from rectangles.** Surfaces step
app → panel → elevated; borders are kept only where there is a real boundary —
the canvas, inputs, panel edges — and modals rely on elevation instead of a ring.
Selection is the accent tone, never an outline.

Accent purple is reserved for the primary action and the selected state. It was
previously Tailwind's default indigo doing three unrelated jobs at once, which
is how purple stopped meaning anything.

Focus rings are the one ring always drawn. Flattening removes borders that
carried no information; it must not remove the only signal a keyboard user has.

## D62 — Scope is where, subject is who

Two sites treated the creator's selection as the authoritative subject:
`validateStepScope` permitted nothing but `set_character_slot` under a
selected-object scope, and `findTargetInstance` resolved the selected object
first and then asserted it was a character. With a lamp selected, "let Cute girl
run to the camera and then shouting Yuri's name" grounded Cute Girl and Yuri
correctly and then died — every step rejected as a scope violation, or
"The scoped object is not a character asset".

The two questions are now answered by two modules. `subject.ts` answers WHO,
with the precedence explicit name > relationship > pronoun > selection > none.
`scope.ts` answers WHERE and **never asks what kind of object is selected** —
that assumption is what made a lamp, a bubble or an effect fatal to a request
that had nothing to do with them.

A selection still narrows the blast radius when the request is about the
selected thing or about no character at all. When the request names somebody
else, `scopeForSubject` widens the scope by exactly one step, object → panel,
and records why. Widening straight to the page would hand a request about one
character permission to rewrite everything around it.

`selected-object` scope still forbids PANEL-LEVEL tools — camera, perspective,
layout, reshape, clearing. That rule survives because it is about the SIZE of an
edit, not about the type of the selected object.

## D63 — A semantic plan sits between the sentence and the tools

Going straight from LLM text to editor commands made three things impossible:
explaining a failure, honouring "then", and keeping camera intent alive.

`sceneIntent.ts` derives participants and ordered beats deterministically from
the prompt before the planner is called. It is handed to the model as a
constraint — so the model cannot re-decide who the request is about — and shown
to the creator as Subject / Scope / Selection-used / Sequence.

Three consequences that are decisions, not details:

- **"Then" means panel progression.** In manga time passes between panels, so
  sequential beats request N panels rather than being stacked into one drawing
  of somebody running and shouting simultaneously.
- **"To the camera" is camera intent**, not `pose = running`. It reaches the
  stage and camera tools as depth and framing, never as an arbitrary scale bump.
- **Dialogue is editor-native.** "Shouting Yuri's name" resolves to speaker,
  referenced character and the text "Yuri!", then a shout bubble. Image models
  cannot spell, and text baked into pixels stops being editable or translatable.

Reading order also became load-bearing: grounded entities are sorted by where
they appear in the prompt, because "Cute Girl … shouts Yuri's name" is about
Cute Girl. They used to come out in character-creation order, which made the
subject depend on project history rather than on the sentence.

## D64 — Relationship is not Interaction, and both must be findable

A RELATIONSHIP is a persistent project fact (Yuri ↔ Mori = Close Friend) that
generates nothing. An INTERACTION is a scene action in one panel that may cost a
generation. The domain always separated them; the UI exposed neither, so a
capability that worked was reported as done and could not be found.

Relationships now live in the Inspector under a selected character's **Details**
tab — not behind Advanced, because "who is this person to that person" is
authoring, not configuration. Interactions live under **Interactions**, and when
two actors are selected they are promoted to a banner above everything about
either character individually.

Every interaction path — the single-character picker, the pair banner, and the
Agent's `create_interaction` — goes through `domain/interactionService`. The
Inspector previously ran its own capability check, dispatch and anchor logic;
two implementations of "what a hug is" drift until the result depends on how the
creator asked.

## D65 — Identity is resolved from any surviving link, and LEFT/RIGHT have jobs

Reported from production: a character selected on the canvas showed no State,
Interactions or Details tabs. The Inspector asked one of the three links that
can tie an asset to a character, and that link was the one the document had
lost. `characters/identity.ts` is now the single resolver, checking the
instance's own state, the asset's metadata, and the character's asset list in
that order. Existing damaged documents heal on load; no migration.

The damage is also stopped at source — `replaceAssetReferences` carries the
character onto the replacement asset — but the resolver stays, because a
document that has already been through the old path must still work.

**LEFT is what exists. RIGHT is what the selected thing means and does.**
Character thumbnails and asset states belong in the library; relationships,
interactions and state editing belong in the Inspector. The relationships
editor in the left card is now the same component as the Inspector's, rendered
compact — a shortcut, not a second implementation.

## D66 — A gesture that silently does nothing is a broken gesture

Shift-clicking a second actor did nothing whenever both characters were placed
with Fit, because both then fill the panel box and the click resolved to the
actor that was already primary. Shift-click now takes the next unselected entry
in the hit stack, so the gesture means "and this one too" rather than "nothing".

The Layers list also accepts shift-click, and highlights both rows. Canvas hit
testing has to tell two overlapping images apart; a list never does, so the
two-character workflow has one path that cannot degrade.

## D67 — A sequence plan, not a suggestion

The scene intent knew "run toward the camera, THEN shout" was two moments, and
nothing enforced it: the planner was told, and whether beat two landed in its
own panel depended on what the model chose to emit. Advisory structure is not
structure.

`agent/sequencePlan.ts` carries the panel on every beat, resolved by
`agent/panelAllocation.ts`, and compiles to ordinary editor commands — so it
still passes through the same validation, routing, transaction and
post-conditions as any other run. There is no privileged path.

Three details that are decisions, not mechanics:

- **The connective stays with its fragment.** A plain split consumed 下一格, so
  the beat lost the one word saying which panel it belonged in.
- **Panel targets are resolved before growth**, because growth depends on the
  highest panel the sequence reaches. Allocating first produced a plan that
  asked for panel 2 on a page grown only to hold panel 1.
- **Every fragment yields a beat.** "第一格，Yuri在前景，用广角低机位" has no verb
  at all; dropping it discarded the camera direction attached to it.

Simultaneity is not sequence. 同时 / meanwhile folds into the previous moment,
because inventing a panel the creator did not ask for is as wrong as collapsing
two they did.

## D68 — Camera language compiles; it does not leak

"Close up on Yuri" used to survive only as a hint to the planner. It is now
parsed into a typed `CameraIntent` and compiled into `set_camera`,
`set_perspective`, `set_character_depth` and `set_focal_character`. No second
camera system exists, and no raw natural-language camera instruction reaches
renderer code.

**Depth is order, never coordinates.** "Mori behind Yuri" is a constraint
between two actors; it resolves to depth bands and the existing stage projection
turns that into scale and ground position. An LLM emitting pixel values would be
guessing at arithmetic the harness can do exactly.

Relations are read CLAUSE BY CLAUSE. "Yuri在前景，Mori站在她身后的街道上" is two
statements, and reading the whole fragment at once let the two clauses share
their mentions — which put the wrong actor in front.

Camera work is editing. Every command this emits is an `EDITOR_OP`, so a closer
shot re-frames existing artwork and never redraws a character.

## D69 — Blame only what the run did

Validation failed a run because a character was completely obscured — by a
pile-up that existed before the run started. The Agent was being blamed for
damage it had not caused, and nothing could ever be edited on a crowded panel.
`validateAndCorrectComposition` now receives the pre-run document: a
pre-existing breach is a warning, and only a NEW one is fatal.

Relatedly, being MENTIONED is not being the actor. "她回头看Mori" needs Mori in
the panel so she can be looked at, but the pose belongs to Yuri alone; the
compiled plan applies action and expression only to the beat's actor.

## D70 — Camera intent outranks the selection too

Found on production: with a character selected, "给Yuri一个特写，低机位广角" was
refused. `selected-object` scope forbids panel-level tools — a rule that exists
so selecting one actor cannot license restaging the panel — and the camera steps
were rejected before execution. The post-conditions then correctly caught that
the shot had not been applied and rolled the run back, so the failure was honest
but the behaviour was wrong.

Selecting a character does not mean "do not touch the camera". Asking for a
close-up DOES mean "this is about the panel". `scopeForPanels` now widens a
selection-locked scope by one step when the plan carries camera, perspective or
focus intent, and records why — the same precedence rule already applied to a
named character and to a named panel, arriving through a third axis.

## D71 — Capability failures are repaired where they happen

"Every participant needs a usable identity reference before a joint render."
named nobody, explained nothing and offered no way out. Reproduced: the
character's canonical POINTER was set — so the old check passed — but the asset
it named had no finished cut-out, so the render URL resolved to nothing and the
error fell out of a length comparison.

Two different faults were tangled in one message. A pointer can be MISSING (an
old or transparency-repaired document lost the forward link) or PRESENT BUT
UNUSABLE (it names an image whose cut-out failed). The first is a data fault and
is now repaired silently — asking a creator to understand a metadata link is not
a product. The second is a real absence, and gets a card that names the
character and offers Choose Existing, Upload Reference and Generate Reference,
all attached to the EXISTING character.

`characters/identityReference.ts` is the one resolver, shared by the Agent, the
interaction UI and generation. Its ladder is canonical → legacy pointer → best
usable image in the character's library → best usable image tagged with them
anywhere. **Identity prefers a canonical or front/neutral image over whatever
pose is currently placed**: handing a model a mid-jump, laughing, back-view
anchor reproduces the pose and loses the face.

Choose Existing re-runs the existing transparency pipeline when the picked image
is not yet usable. Pointing at a broken image and declaring the problem solved
would be a button that changes nothing.

## D72 — A missing asset is a requirement, not a refusal

"The bad guy roach man punching to the camera" answered "Roach Man does not
exist in the project's character inventory, and creating new characters is
forbidden for this run." Nothing was wrong with the sentence. The Agent could
identify what a request needed, and could generate assets, and there was no
arrow between the two.

The cause was that grounding doubled as an authorization gate: an unmatched
name was fatal unless the prompt also contained a creation verb. That rule
cannot be patched per-sentence, because the sentences are unbounded.

**Reference FORM decides, not library contents.** A self-identifying reference
("Roach Man", "a cockroach superhero", "a new robot named Kumo") is someone the
creator is introducing, so it resolves to `create`. A pointing reference ("her
sister", "the teacher") asserts something already exists, so when nothing
answers it, it blocks — inventing an answer would put a stranger in the
creator's manga. Ambiguity always blocks.

Four things had to change together, and any one alone leaves the failure intact:

1. **Grounding stopped dropping introduced names.** A name the creator
   introduced in this very prompt was skipped on the theory that creation was
   handled elsewhere. Nothing handled it, so the entity vanished.
2. **Validation validates against the state a step will RUN in.** "Place Roach
   Man" was rejected as "does not exist" while the stage that creates Roach Man
   was already queued.
3. **The planner context stopped saying creation was FORBIDDEN.** The refusal
   creators saw was the MODEL's own words, produced from that line. Fixing the
   runtime alone would have left the message exactly as it was.
4. **Physical actions became poses.** "Punching" was in no vocabulary, so the
   beat fell through to a default standing pose — a character with a perfectly
   good punching asset would have been asked to generate another one.

Fulfilment runs before the page transaction and outside it: generated assets are
paid for and must survive a failed composition, while the page rolls back. It
uses the same services as the manual UI, so an Agent-made character is an
ordinary library character afterwards.

An unmatched capitalized word is only a character when the sentence frames it as
one, and quoted text is dialogue, never a reference. Without that, a fresh
project would turn prose into characters.

## D73 — Tone is a layer, and a pattern is not a picture

Two decisions carry the tone system, and both are about refusing to flatten
something that must stay editable.

**A tone never touches the artwork.** It is a `ToneItem` in the panel's item
stack, so it hides, reorders, duplicates, deletes and undoes like everything
else, and `domain/tones.test.ts` asserts the artwork's bytes are identical
before and after adding, editing, masking and deleting one. Baking tone into a
character would also destroy that character for every other panel using it.

**A procedural tone stores parameters, not pixels.** "Dot 30%" is 26 repeats per
100px at 45° with 30% coverage, drawn by `render/tonePainter` at output
resolution. A stored bitmap can only be resampled, and resampling a dot screen
gives grey mush plus moiré — the exact failure screentone systems exist to
avoid. The preset names are arithmetic: coverage is πr²/s², so a swatch measured
in the browser reads 30.6% ink for Dot 30%. At 2x export the edge count triples
rather than doubling, which only happens when the pattern is redrawn.

Generated and uploaded tones ARE images — a rain texture is not describable as
density and angle — so they keep a transform-and-tile path, and the inspector
offers each kind only the dials it can honour.

Masks store normalized SHAPES, not a rasterized selection, for the same reason,
and reuse the extracted `SelectionPainter` rather than a second mask editor.
Compositing goes through an offscreen buffer because `clip()` cannot express
"everywhere except", and inverting with even-odd turns overlapping brush strokes
into holes.

One subtlety cost a real bug: sizing the tone box exactly to the panel means any
rotation reveals bare corners, and pinning `rotation: 0` to avoid that leaves the
creator a slider that does nothing. The box is grown to the panel's DIAGONAL
instead — it covers at every angle, and the structural panel clip trims the
overhang.
