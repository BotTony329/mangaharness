# Manga Studio Engineering Context

> Read this first, then check `git log --oneline -10`. If this document
> disagrees with the code, the code wins — correct this file before implementing.
> Update it at the END of every meaningful task, before reporting.

## Current Product Thesis

An AI-native, semi-professional manga editor. AI generates **reusable structured
assets**; the creator **composes** them; the Agent operates the **same commands**
the UI does.

It is explicitly *not* "prompt → finished page", and *not* "change a character →
regenerate the whole character". The creator directs the scene; the harness picks
the implementation.

## Current Architecture

- **Next.js 15 App Router + React 19 + TypeScript strict + Zustand + Konva.**
- **One write path.** Every mutation is a `DomainCommand` handled by
  `applyDomainCommand` (`src/domain/commands.ts`), which delegates to pure
  `doc → doc` modules in `src/domain/*Ops.ts`. UI and Agent both dispatch these;
  the Agent has no privileged write path.
- **Undo is snapshot-based** in `src/editor/store.ts`. `transientDispatch` +
  `commitTransient` make a drag one undo entry.
- **Persistence** is IndexedDB, one record per `project.id`
  (`src/storage/projectStore.ts`). Documents hold no binaries — images live in
  object storage and are referenced by URL.
- **Schema v12**, forward-only migrations in `src/domain/serialization.ts`.
- **BYOK providers.** Keys are AES-GCM in HttpOnly cookies; the browser never
  talks to a provider directly.

## Major Decisions

Durable rules. Do not silently reverse these.

- **Foreground assets generate on PURE WHITE.** Never a magenta/green/chroma
  matte. One policy: `src/ai/foregroundPolicy.ts`. (D47)
- **Relationship ≠ Interaction.** A relationship is who two characters ARE
  (persistent); an interaction is what they are DOING in one panel. (D48)
- **An interaction is not two poses.** `hug(A, B)` owns shared geometry and is
  one coordinated request carrying BOTH identity references. (D48)
- **Puppet is an internal capability, not a creator workflow.** Rigging lives
  behind Advanced. (D49)
- **Local transform is preferred before generation.** Camera, depth, framing and
  local puppet edits must never cost a generation call.
- **The Agent may not invent project state.** Grounding resolves to
  RESOLVED/AMBIGUOUS/NOT_FOUND; NOT_FOUND never means create. (D40)
- **Selection is one HitStack.** Canvas, right-click menu and Layers panel all
  resolve to the same `PanelItem.id`. (D44)
- **CLICK applies to the current selection; DRAG targets another canvas actor.**
- **A pipeline fix does not reach already-processed assets** — it needs a repair
  path or it is half shipped. (D46)
- **Provider output is never trusted outside a local edit mask.** The compositor
  is the enforcement boundary, not the prompt. (D53)
- **Asset Edit / Instance Edit / Composite Edit** are three scopes; editing an
  asset must never silently change every panel using it. (D53)

## Current User-Facing Workflow

A creator can, without opening Advanced and without triggering generation:

1. Create / rename / duplicate / delete projects; switch between them.
2. Create characters, generate a canonical reference, generate variations.
3. Place characters, scenes, objects and manga FX into panels.
4. **Click** a pose/expression/outfit card to apply it to the selected actor;
   **drag** it onto a different actor to target them instead.
5. Select two actors (shift-click) and run an interaction — Instant ones apply
   immediately, generative ones open a preview first.
6. Select layers reliably in crowded panels: topmost-first, alt-click to cycle,
   right-click for a layer menu, lock/hide/reorder in the Layers panel.
7. Direct the camera: shot, angle, lens, roll, draggable horizon and vanishing
   points, per-instance depth.
8. Ask the Agent, which resolves characters deterministically first.

## Major Systems

### Projects — **working**
`src/editor/projectsStore.ts`, `src/storage/projectStore.ts`,
`src/components/library/ProjectsPanel.tsx`.
Create/rename/duplicate/delete/switch, welcome empty state, autosave.
*Limitation:* lifecycle actions live in a `⋯` menu; no Project Settings surface.

### Characters — **working**
`src/domain/libraryOps.ts`, `src/characters/*`,
`src/components/library/CharactersTab.tsx`, `src/components/inspector/InspectorPanel.tsx`.
Identity, canonical reference, semantic state (pose/expression/outfit/view),
state graph + lineage, click-first state cards with Instant/Generate hints.
*Limitation:* Outfit/View still generate; no cached-state browser in Normal mode.

### Scene Assets — **working**
Creator-facing **Scenes** (rectangular environments, never extracted) and
**Objects** (cutouts, extracted). Both map onto existing asset categories —
Scenes → `background`, Objects → `prop`.
*Limitation:* Objects cannot yet be attached to a character as a held Prop from
the UI; the puppet attachment system exists but has no Object-to-hand flow.

### Manga FX — **working**
`src/language/*`, `src/components/library/MangaFxTab.tsx`.
Built-ins are code (merged at read time, never stored); uploads and AI-generated
effects are project data. Structured effects stay parameterized; visual effects
are cutouts. Effects can attach to a character and follow them.

### Relationships / Interactions — **domain complete, UI partial**
`src/domain/relationships.ts`, `src/domain/interactions.ts`,
`src/components/inspector/InteractionControls.tsx`,
`src/components/dialogs/InteractionDialog.tsx`.
Capability picks LOCAL_STAGE / LOCAL_PUPPET / HYBRID / JOINT_GENERATION and the
UI shows only "Instant" or "Generate". Joint renders record both participants.
*Limitation:* the Agent has no `create_interaction` tool yet, so "让豆包抱住friend"
is not yet executed as one interaction.

### Generative Editing — **working, provider-untested**
`src/assets/localEdit.ts` (compositor), `src/assets/editRequest.ts` (instruction),
`src/app/api/assets/edit/route.ts`, `src/components/dialogs/AssetDetailEditor.tsx`.

**Asset Detail Editor.** Full-screen workspace opened by double-clicking an
asset thumbnail, its "Edit Image ✦" context item, or the same button on a
selected instance in the Inspector. Brush + rectangle selection, zoom/pan,
prompt, results strip, hold-to-compare, and three save actions.

**SelectionMask** is `{ width, height, data: Uint8Array }` where each byte is
coverage, 0 = keep original. The editor paints onto a canvas held at the ASSET's
own pixel dimensions and ships it as a PNG, so the mask arrives already in image
space.

**Image-space coordinate rule.** Pointer positions convert to image space once,
at the boundary (`toImage`). Zoom and pan never touch the mask canvas. Verified
in-browser: the same hand painted at 100% and 156% produced image bounds
x264-338/y345-417 and x269-335/y345-410 against a hand circle at x266-334/y346-414.

**Outside-mask enforcement.** `compositeLocalEdit` takes provider pixels only
where the mask is non-zero and copies the original byte-for-byte everywhere
else. This is the guarantee — the prompt is only a request. Feather runs INWARD
(blurred mask multiplied back by the drawn mask), so coverage can never appear
where nothing was painted. Feather radius means what it says: the per-pass box
radius is a third of the requested value, because three stacked passes reach
three times as far.

**Transparency.** `restoreAlpha` keeps the original alpha outside the mask
always, and inside the mask too when the provider returned a flattened frame —
so a cut-out object cannot gain a white slab.

**Variation model.** A saved edit is a NEW asset with
`provenance.localEdit { parentAssetId, editPrompt, intent, editedAt }`. A
`cosmetic` edit deliberately does NOT register a `CharacterStateRecord`: visual
edit lineage is not semantic character state.

**Asset vs Instance.** Save as Variation (default, safe) · Use only in this
panel (variation + single `swap-instance-asset`) · Replace original (confirmed,
warns that existing panels change).

*Limitations:* one result per Generate (no parallel candidates); no lasso; no
pan drag (zoom only, image is centred); the whole edit path has never run
against a live image-edit provider.

### Camera / Stage — **mostly working, discoverability weak**
`src/domain/camera.ts`, `src/domain/staging.ts`, `src/domain/stageOps.ts`,
`src/components/canvas/PerspectiveOverlay.tsx`,
`src/components/inspector/PanelStageControls.tsx`.
Shot, angle, lens, roll, yaw (shifts framing — genuinely functional), depth,
ground anchor, focal subject, draggable horizon and vanishing points.
*Limitation:* no dedicated Camera/Stage mode; controls are found by selecting a
panel and scrolling the Inspector. No on-canvas depth handle. No ground-plane
overlay. No perspective corner-pin for scene assets.

### Agent — **working**
`src/agent/*`. Deterministic grounding before planning, plan validation binding
names to IDs, runtime creation guard, post-condition validation.
*Limitation:* no interaction tool; no camera-mode tools beyond existing ones.

### Generation providers — **working**
`src/ai/*`. BYOK, reference images where the provider supports them, one shared
Generator dialog with a shared Reference Picker for Scene/Object/FX.

### Transparency pipeline — **working**
`src/assets/*`. Pure-white policy → white-background validation → connectivity
flood → matte edge decontamination → alpha contract → registration.
Decontamination runs on every alpha source, including provider-supplied alpha.
*Limitation:* assets generated before a pipeline fix keep their old bytes;
"Fix transparency" on a character card rebuilds them.

### Persistence — **working**
IndexedDB per project, autosave, forward-only migrations, no fabricated data on
migration.

## Last Completed Work

**V3.4 — Asset Detail Editor and generative local editing.**
Selection mask in image space, outside-mask compositor with inward feather,
`/api/assets/edit` reusing the existing `editImage` provider capability,
non-destructive variation provenance, and the Asset/Instance/Replace boundary.

**Tests:** 718 passing / 57 files. Typecheck clean, lint clean, production build
clean.

## Known Bugs / UX Problems

- **The Inspector is long.** Interactions sit below the fold for a selected
  character — verified in the browser, the Hug button needed scrolling. The
  Inspector needs collapsible sections or a tab strip.
- Camera/Stage has no dedicated mode; it is discoverable only by selecting a
  panel and scrolling the Inspector.
- No on-canvas depth handle — depth is a slider only.
- Agent cannot create interactions; the domain layer can.
- Joint interaction generation is wired to the UI but has not been exercised
  against a live provider.
- Objects cannot be attached to a character's hand from the UI.
- Assets generated before the white policy still carry a magenta matte until
  "Fix transparency" is run on that character.
- Three-point perspective renders guides but has no distinct projection
  consequence beyond two-point.
- Local editing has never run against a live image-edit provider; only the
  capability-error path was exercised in the browser.
- The Asset Detail Editor offers one result per Generate, not 2-4 candidates.
- A cosmetic variation can become the preferred render for that semantic state
  on FUTURE placements (newest wins in the resolver). Existing instances are
  never touched.

## Next Recommended Work

0. **Run the local edit against a real image-edit provider.** Every part of the
   path is unit- and browser-tested except the provider round trip; identity
   preservation inside the mask is unproven in practice.
1. **Agent interaction tool** — `create_interaction` + capability-aware
   execution, so "让豆包抱住friend" runs as one interaction. Highest value: the
   domain layer is finished and unreachable from the Agent.
2. **Camera / Stage mode** — one entry point revealing horizon, VPs, ground and
   depth handles; removes the biggest discoverability gap.
3. **On-canvas depth handle** — direct manipulation instead of a slider.
4. **Object → hand attachment** — connect Objects to the existing puppet
   attachment sockets.
5. **Live joint-generation run** — exercise the hug path against a real provider
   and check identity preservation.

## Important Files / Modules

```
src/domain/          commands.ts (single write path), types.ts (schema),
                     interactions.ts, relationships.ts, staging.ts, camera.ts,
                     itemOps.ts, languageOps.ts, projectOps.ts
src/canvas/          hitStack.ts (one selection resolver)
src/agent/           grounding.ts, planValidation.ts, executor.ts, contextBuilder.ts
src/ai/              foregroundPolicy.ts (white policy), promptTemplates.ts, generate.ts
src/assets/          postProcessor.ts, backgroundRemoval.ts, matteDecontamination.ts,
                     renderSource.ts (render URL contract), clientProcessing.ts (repair),
                     localEdit.ts (outside-mask compositor), editRequest.ts
src/puppet/          model.ts, transforms.ts, capability.ts, compiler.ts, interaction.ts
src/editor/          store.ts (doc + undo), projectsStore.ts, uiStore.ts (transient UI)
src/components/      library/ (left dock), inspector/ (right), canvas/, dialogs/, agent/
docs/DECISIONS.md    durable ADRs — read before changing architecture
```
