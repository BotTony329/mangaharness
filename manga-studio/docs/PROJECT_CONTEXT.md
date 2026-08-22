# Kumanga Engineering Context

> Read this first, then check `git log --oneline -10`. If this document
> disagrees with the code, the code wins — correct this file before implementing.
> Update it at the END of every meaningful task, before reporting.

> **2026-08-22 — EDITOR CORE FROZEN.**
> Camera/Stage closed (all controls verified real — see the Camera section);
> provider settings UI simplified to name/key/model with the API-standard
> picker folded into Advanced; final smoke 10/10 PASS with zero console errors
> (`scripts/smoke-final.mjs`); 872 tests / lint / typecheck / build green.
> POST-MVP non-blockers: on-canvas depth handle, ground-plane overlay,
> perspective corner-pin, dedicated Camera mode, live-provider E2E.
> **Manga Agent = REWRITE REQUIRED / NOT PART OF EDITOR FREEZE.** Agent code
> must not change Editor Core; it calls `src/services/*` + domain commands.
> Known residual: `app/api/provider/test` + `models` routes import
> `agent/providers` (the agent-model channel — goes with the rewrite).
>
> **2026-08-22 Editor Core decoupling (phase 1):** `src/services/` is now the
> single application-service layer — generation, characters, scenery,
> manga-language and interaction all enter through it from BOTH the UI and the
> Agent. The executor no longer touches the generation HTTP client or prompt
> assembly directly; ad-hoc provider-status fetches are gone; run summaries
> name preserved assets after a rollback. Architecture boundaries are enforced
> by `src/services/architecture.test.ts`. Full before/after graphs:
> `docs/EDITOR_CORE_DECOUPLING.md`. 872 tests / 73 files green.
>
> **2026-08-22 P0 product closure:** three fixes landed — (1) AI Settings is
> protocol-first (API standard dropdown, provider name is a free label, Custom
> JSON folds out Advanced API mapping); (2) background removal is an optional
> fallback behind "Configure fallback (optional)" — the primary path is the
> built-in white-background extractor, always on; (3) Agent runs report
> COMPLETED / PARTIALLY_COMPLETED / FAILED via `agent/stepPolicy.ts`, with
> explicit "Approximate composition" fallback for failed interactions — the
> "Done with X failed steps" summary is gone. 866 tests / 72 files green;
> deployed to production.
>
> **2026-08-22 P0 debt closure:** scene-local apposition co-resolution landed
> (`agent/coreference.ts`, commit `b02eff1`) and the planner's creation policy
> is unified (commit `be0e92f`). See "Co-reference" below and
> `docs/TAKEOVER_AUDIT.md`.

## Product Identity

**Name:** Kumanga — *kuma* (bear) + *manga*.
**Tagline:** AI Manga Studio.
**Browser title:** `Kumanga — AI Manga Studio`.

The mark is a black bear head with a small outlined manga speech bubble at the
lower right. It is a RECONSTRUCTION of approved reference artwork — never
regenerate or redesign it. Every variant comes from one geometry definition in
`scripts/build-brand.mjs`; edit that and re-run it rather than touching an SVG.

| Asset | Path |
|---|---|
| Mark, dark ink | `public/brand/kumanga-mark.svg` |
| Mark, light ink | `public/brand/kumanga-mark-dark.svg` |
| Mark without the bubble (≤20px) | `public/brand/kumanga-mark-compact.svg` |
| App tile, favicon | `public/brand/kumanga-icon.svg`, `src/app/icon.svg` |
| Wordmark | `public/brand/kumanga-wordmark{,-dark}.svg` |
| In-app React mark | `src/components/brand/KumangaMark.tsx` |

**Icon system:** Lucide, re-exported through `src/components/ui/icons.tsx` at one
size and stroke weight. No emoji anywhere in the product UI. The bear is brand;
editor controls stay conventional.

**Design tokens:** `src/app/globals.css` (`--bg-app`, `--bg-panel`,
`--bg-elevated`, `--border-subtle`, `--text-*`, `--accent`, `--danger`, radius
and spacing). Accent is Kumanga purple `#7c5cff`, reserved for the primary
action and the selected state.

**Button hierarchy:** `src/components/ui/Button.tsx` — primary, secondary,
ghost, icon, danger. Only primary and secondary draw a filled shape.

## Current Product Thesis

An AI-native, semi-professional manga editor. AI generates **reusable structured
assets**; the creator **composes** them; the Agent operates the **same commands**
the UI does.

It is explicitly *not* "prompt → finished page", and *not* "change a character →
regenerate the whole character". The creator directs the scene; the harness picks
the implementation.

## Permanent UI rules

**LEFT is what exists. RIGHT is what the selected thing means and does.**
Character thumbnails, rendered states and asset shelves live in the library on
the left. Relationships, interactions and state editing live in the Inspector on
the right. A control that only exists inside the asset library is not
product-reachable for a creator working on the canvas.

When ONE character is selected the Inspector shows **State · Interactions ·
Details**, near the top, with no Advanced flag and no scrolling. When TWO
character actors are selected a **pair banner** appears above the tabs.

**Character identity is resolved through `characters/identity.ts`, never by
reading one link.** An asset can be tied to a character three ways — the
instance's `characterState`, the asset's `metadata.characterId`, and the
character's own `assetIds` / canonical reference. Anything that asks only one of
them will eventually render a real character as an anonymous picture, which is
exactly how the Inspector lost its tabs in production.

**Verify on production, not on localhost.** `mangaharness.vercel.app` is the
product. Confirm the deployed commit SHA matches HEAD before claiming a UI
behaviour works.

## MVP FREEZE

The MVP feature scope is **FROZEN**. Anything not listed as COMPLETE below is
POST-MVP, and no unfinished MVP work has been moved there.

| Area | Status |
|---|---|
| Core creator loop | COMPLETE |
| Asset generation | COMPLETE |
| Local asset editing | COMPLETE |
| Character relationships | COMPLETE |
| Multi-character interactions | COMPLETE |
| Camera / stage | COMPLETE |
| Agent grounding | COMPLETE |
| Temporal planning | COMPLETE |
| Transactional execution | COMPLETE |
| Project lifecycle | COMPLETE |

One external dependency is unresolved and cannot be resolved from here:
**live image-provider round trip — no API credential in this environment.** The
adapter, request construction, routing and failure reporting are all complete
and reach `POST /api/generate`; only the far side of that call is unverified.

## The semantic execution architecture

```
USER PROMPT
  ↓  agent/grounding.ts        WHO — names, aliases, pronouns, relationships
  ↓  agent/subject.ts          precedence: name > relationship > pronoun > selection
  ↓  agent/scope.ts            WHERE — never asks what KIND of object is selected
  ↓  agent/sceneIntent.ts      moments and beats, EN + ZH, derived deterministically
  ↓  agent/sequencePlan.ts     SequencePlan: beat → panel, camera per beat
  ↓  agent/panelAllocation.ts  panel numbers, layout growth, preservation
  ↓  agent/capabilityRouter.ts EDITOR_OP | LOCAL_ASSET_OP | AI_GENERATION
  ↓  compileSequencePlan       editor commands — the ONLY thing that mutates
  ↓  editor/store transaction  snapshot → execute → validate → commit OR rollback
  ↓  post-condition validation semantic invariants, not "did the commands run"
```

**The planner interprets; the harness decides.** When a prompt carries explicit
structure — sequential moments, a named panel, or camera language — the
deterministic compiler's steps are what execute. The model is not given the
opportunity to collapse two moments into one panel or to drop a framing
instruction.

### Temporal rules

- Beats split on `then / next / after that / 然后 / 接着 / 下一格 / 随后 / 之后`.
  The connective is KEPT with the fragment it introduces, because "下一格" is the
  word that says which panel the beat belongs in.
- `meanwhile / 同时 / 与此同时 / while / 一边` marks SIMULTANEITY. It folds into
  the previous moment and never creates a panel.
- Explicit panel names (`第一格`, `panel 2`) override allocation order.
  `下一格` means the panel after the previous beat's, or after the panel the
  creator is working in when it is the first thing they said.
- Panel targets are resolved BEFORE growth, because growth depends on the
  highest panel the sequence reaches.
- Every fragment yields at least one beat, so a staging-only moment
  ("第一格，Yuri在前景，用广角低机位") is not silently dropped.

### Camera-intent mappings

`agent/cameraIntent.ts` parses and compiles into existing commands only:

| Language | Compiles to |
|---|---|
| close-up / 特写 / 拉近 · wide / 远景 · full / 全身 · medium / 中景 | `set_camera { shot }` |
| low angle / 低机位 / 仰拍 · high / 俯拍 · overhead / 俯瞰 · eye level / 平视 | `set_camera { angle }` |
| dutch / 斜角 | `set_camera { angle: dutch }` + roll |
| wide-angle / 广角 · telephoto / 长焦 | `set_camera { lens }` |
| one/two/three-point perspective / 一点·两点·三点透视 | `set_perspective { type }` |
| foreground / 前景 · background / 背景 | `set_character_depth { placement }` |
| A in front of B / A 在 B 前面 · behind / 身后 | relative → depth ORDER → `set_character_depth` |
| focus on X / 聚焦 / 镜头拉近X | `set_focal_character` |

Depth is always resolved as **order**, never as coordinates. Relations are read
clause by clause; a clause naming one character relates it to the beat's
subject, which is who the pronoun means.

**Camera work never generates.** Every compiled camera command is an
`EDITOR_OP`. A closer shot re-frames artwork that already exists.

### Agent AI / Image AI boundary

- **Agent AI** understands and plans. It never writes to the document.
- **Image AI** renders one requested asset for an already-approved beat. It
  never invents manga structure.
- `agent/capabilityRouter.ts` decides which is which; an unclassified tool is
  treated as generative so a new tool cannot spend money silently.

### Preservation invariants (all FATAL, all roll back)

- Panels the request never named come back byte-identical.
- Existing items never disappear from a run that was only meant to add.
- Layout growth only ADDS panels; content is carried forward.
- Every beat's subjects are present in that beat's panel.
- Dialogue exists, in the beat's panel, with the requested text.
- Camera shot / angle / lens / perspective reached the panel.
- Relative depth order is satisfied.
- A character already obscured BEFORE the run is a warning, not a fatal — the
  Agent is not blamed for a pile-up it did not create.

## TONE SYSTEM

**TONE IS A NON-DESTRUCTIVE LAYER.** A tone is never baked into a Character,
Scene or Object. Hiding it returns the artwork exactly as it was, because the
artwork was never modified — the tone is a separate item in the panel's stack.
`domain/toneOps` touches `doc.items` and nothing else; if it ever needs to write
to `doc.assets`, that guarantee has been broken upstream.

### Tone is a reusable asset, from three sources

| Source | What it is | Where it lives |
| --- | --- | --- |
| procedural | a PATTERN — density, frequency, angle | built-in presets; parameters stored on the layer |
| generated | a texture or atmosphere no formula describes | an ordinary `tone` library asset |
| uploaded | the creator's own screentone or sticker | an ordinary `tone` library asset |

All three appear on one shelf, because a creator looking for gloom does not care
which produced it.

### Procedural tone preserves parameters

A screentone is a pattern, not a picture. The document stores "26 repeats per
100px at 45°, 30% coverage" and `render/tonePainter` draws it at OUTPUT
resolution, so the dots stay round and separate at any export scale. Storing a
bitmap instead produces the two classic failures — grey mush where the dots
were, and moiré where the output grid beats against the dot grid. Verified: at
2x export the edge count roughly triples rather than doubling, which only
happens when the pattern is redrawn rather than upscaled.

**Density is coverage.** "Dot 30%" draws dots sized so thirty percent of the
area is ink; the preset names are arithmetic, not labels. Ink is BLACK — a grey
wash at 30% opacity prints as mud and cannot be halftoned later.

### Tone participates in normal layer ordering

Tones sit above the artwork and below the lettering (band 3, with effects), so a
tone shades the scene without greying out the dialogue. They reorder, hide,
lock, duplicate, delete and undo through the same commands as every other item.

### Masks reuse the existing selection infrastructure — no separate pipeline

`components/dialogs/SelectionPainter` is the ONE selection surface, shared by
local generative editing and tone masking. A tone mask stores normalized (0..1)
SHAPES rather than a rasterized bitmap, for the same reason procedural tones
store parameters: a stored bitmap can only ever be resampled, and normalized
shapes survive the panel being resized and the page exported at 2x.

Masked tones composite through an offscreen buffer at device resolution. A plain
`clip()` cannot express "everywhere EXCEPT the mask" — inverting a path with the
even-odd rule turns overlapping brush strokes into holes — so both directions
use the one approach that is correct for both.

### Consequences that are easy to get wrong

- **The panel polygon clip is structural.** Items already render inside the
  panel's clip path, so nothing can spill out, on screen or in the export.
  "Clip to panel" therefore means the tone FILLS and follows the panel; the box
  is grown to the panel's diagonal so rotation still covers every corner. Sizing
  it exactly to the panel forces `rotation: 0` and leaves a dead slider.
- **No dial is offered that cannot be honoured.** Image tones get scale,
  rotation and repeat; procedural tones get density, frequency and angle.
- **Uploads are never destructively processed.** Existing alpha is preserved; an
  opaque tone is OFFERED the existing transparency repair, in the creator's
  words, rather than having its background stripped automatically.
- **The Agent uses the same commands as the human UI.** `apply_tone` dispatches
  `add-tone`; there is no command that bakes tone into artwork for it to reach.

## GROUNDING IS NOT A CREATION GATE

**A missing asset is a REQUIREMENT, not a failure. The Agent's job is to route
it to generation, not to refuse the sentence.**

Grounding answers "what does this sentence refer to?", not "is this allowed?".
Every reference resolves to exactly one of three outcomes:

| Outcome | When | What happens |
| --- | --- | --- |
| `existing` | the library has it | reuse it — never re-create |
| `create` | a SELF-IDENTIFYING reference the library lacks — "Roach Man", "a cockroach superhero", "a new robot named Kumo" | create the entity and generate its assets, then continue the run |
| `unresolved` | a POINTING reference nothing answers — "her sister", "the teacher" — or a genuinely ambiguous one | block, because inventing an answer would put a stranger in the creator's manga |

The discriminator is the FORM of the reference, never whether the project
happens to contain a match. A creator who writes a name is introducing someone;
a creator who points at a relationship is asserting one already exists.

### The arrow

    PROMPT → grounding → entity resolution → asset requirements
           → FULFILMENT (create character · generate canonical · generate state)
           → asset library → plan validation → editor commands → page

Fulfilment runs BEFORE the page transaction and is deliberately outside it:
generated library assets are paid for and must survive a failed composition,
while the page is what rolls back. It goes through the SAME services the manual
UI uses — the `create-character` command behind "+ New Character" and
`generateCharacterAssetForState` behind the starter pack — so an Agent-made
character is indistinguishable from a hand-made one and is reusable afterwards.
There is deliberately no Agent-only generation path.

### Consequences that are easy to get wrong

- **Plan validation validates against the state a step will RUN in**, not the
  document as it is at planning time. A step naming a character the run is
  about to create must pass.
- **The planner context must say so too.** The refusal creators actually saw was
  written by the model, because the context block said creation was FORBIDDEN.
  Fixing the runtime alone leaves the message intact.
- **An unmatched capitalized word is only a character when the sentence treats
  it as one** — a person descriptor, or an action only a character performs.
  Quoted text is dialogue and never a reference.

### Co-reference: apposition is ONE participant

"his rival, the bad character Roachman" and "her sister, Mori" name ONE person
twice. `agent/coreference.ts` binds them structurally — a pointing phrase
(`classifyReference` → "pointing") adjacent to a name-carrying phrase across a
comma or dash — with no per-relationship-word logic. The pointing half folds
into the canonical entity as a `sceneLocalAliases` entry plus an optional
`sceneRelation` (e.g. rival of the established subject). **Scene-local means
never persisted**: the relationship graph is not written by a sentence of plot.
If the graph already answers the phrase with a DIFFERENT character, project
data wins and nothing merges. A bare pointing reference ("Yuri hugs her
sister", no name attached) still blocks. A capitalised word after a place
preposition ("in Melbourne") is a location, not a character.

**Creation policy has exactly one source of truth: deterministic entity
resolution.** The planner never decides whether a character may be created;
its system prompt and TOOL_DOCS say the resolved world is authoritative.

Golden cases: `agent/coreference.test.ts` (A–F from the takeover brief, plus
the relationship-graph-wins safety case).

## CAPABILITY RECOVERY RULE

**A creator-facing capability is not complete if its failure state only explains
why the operation cannot run. Every recoverable capability failure must identify
the affected entity and provide an in-context path to repair it.**

Concretely, a failure message must name WHO or WHAT is affected in the
creator's own vocabulary, and the repair must be reachable from the place the
creator hit the wall — not from documentation, not from another screen, and
never by editing internal state. Terms like characterId, assetId, metadata link
and resolver never appear in creator-facing copy.

A data fault that the harness can fix on its own is not a decision to hand the
creator. `resolveCharacterIdentityReference` repairs a broken pointer silently;
only a genuinely absent capability produces a card.

## Permanent Agent rules

**Scope defines where the Agent may operate. Grounding defines what entities the
user means. Selection is contextual evidence, not authority. An explicitly
grounded entity must not be overridden by an unrelated selected object.**

**Natural-language manga instructions are scene intents, not direct editor
commands. Temporal and multi-actor requests must be semantically decomposed
before tool execution.**

Concretely:

- `agent/subject.ts` resolves WHO, with the precedence
  explicit name > relationship > pronoun-from-context > selection > none.
  "None" is a valid answer: "make this panel more dramatic" has no character
  subject and must not be given one.
- `agent/scope.ts` resolves WHERE and **never asks what kind of object is
  selected**. A page holds panels, characters, scenes, objects, bubbles, effects
  and composite renders; which of those a request needs is the planner's
  question. `scopeForSubject` widens a selection-locked scope to its panel when
  the request names somebody else.
- Explicit intent outranks selection on THREE axes: a named character
  (`scopeForSubject`), a named panel, and panel-level camera work
  (`scopeForPanels`). A selection is always evidence, never authority.
- `agent/sceneIntent.ts` produces the semantic plan — participants and ordered
  beats — BEFORE the planner is called, deterministically from the prompt. It is
  passed to the model as a constraint and shown to the creator in the run log.
- Dialogue is editor-native. An image model is never asked to render readable
  text.

### Run status and step policy

**A run never reports "Done with X failed steps".** `agent/stepPolicy.ts` is
the single authority:

- Every step has an explicit criticality by tool — not inferred from strings.
  `create_interaction` is required-with-fallback; decorative tools
  (`add_effect`, `apply_tone`, `place_manga_effect`, `generate_manga_effect`)
  are noncritical; everything else is required.
- `ExecutionSummary.status` is COMPLETED (all steps ok), PARTIALLY_COMPLETED
  (noncritical steps skipped, or a fallback was used), or FAILED (a required
  step failed — the page is rolled back). `ScopeViolationError` always aborts
  and rolls back, no exceptions.
- When `create_interaction` fails, the executor tries **Approximate
  composition**: both participants are placed into the panel from their
  existing resolved assets (`resolveOrGenerateState` with
  `generateIfMissing: false`) — never a silent skip, always listed under
  `summary.fallbacks`. If no existing asset exists, the run fails and rolls
  back.
- The Agent panel renders the plan (what was asked) separately from the
  execution outcome (what happened), with a Partially-completed card listing
  fallbacks / skipped steps / warnings plus Retry and Revert-this-run (undo)
  actions. Golden cases: `agent/runStatus.test.ts` CASE 1–4.

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

### Camera / Stage — **COMPLETE (frozen; creator-language UX)**
Panel select → Inspector top "CAMERA / STAGE": Presets (Dialogue / Close
Emotion / Hero Entrance / Intimidating / Action Impact / Establishing Shot —
combos of existing controls, no stored preset state) → Shot (Close-up/Medium/
Full/Wide glyph buttons) → Angle (High/Eye Level/Low) → Lens (Dramatic=wide /
Natural=normal / Flat=tele) → Focus on [character] → per-character Distance
from Camera slider. Perspective Guides fold (eye level / VP editing /
perspective strength / Tilt=roll); Advanced fold (pitch/yaw/roll/fov/horizonY).
Pure UX adapter over the frozen camera core (`PanelStageControls.tsx`);
browser acceptance `scripts/smoke-camera-ux.mjs` 11/11 PASS.
`src/domain/camera.ts`, `src/domain/staging.ts`, `src/domain/stageOps.ts`,
`src/components/canvas/PerspectiveOverlay.tsx`, `PanelRollGroup.tsx`,
`src/components/inspector/PanelStageControls.tsx` (panel-level) +
`InstanceStageControls.tsx` (per-character).
Verified real, not data-only: Shot/Angle reframe via `applyShotFraming`;
Lens→fov→depthScale; roll rotates panel content on canvas (PanelRollGroup);
yaw pans framing; horizonY moves the ground line; depth slider resizes live;
ground anchor (Snap to Ground); focal subject drives framing; perspective
mode + draggable horizon/vanishing points via Edit Guides; auto depth order.
Entry: select a panel → Inspector top section (Camera / Perspective / Stage).
Advanced-only by design: pitch, roll, yaw, fov numerics, eye level.
*POST-MVP (non-blockers):* on-canvas depth handle, ground-plane overlay,
perspective corner-pin, dedicated Camera mode.

### Agent — **working**
`src/agent/*`. Deterministic grounding before planning, plan validation binding
names to IDs, runtime creation guard, post-condition validation. Run status
and per-step criticality follow `agent/stepPolicy.ts` (see "Run status and
step policy"). `create_interaction` exists, with Approximate-composition
fallback.
*Limitation:* no camera-mode tools beyond existing ones.

### Generation providers — **working**
`src/ai/*`. BYOK, reference images where the provider supports them, one shared
Generator dialog with a shared Reference Picker for Scene/Object/FX.

**AI Settings UX (protocol-first).** The dialog asks "which API standard does
your provider speak" (OpenAI-compatible / Anthropic Messages / Gemini Native /
Custom JSON), not "which vendor". Provider Name is a free-text label; Simple
Setup is the only default path — there is no Custom/Preset tab split. Choosing
Custom JSON folds out Advanced API mapping (`CustomProviderForm`).

**Background removal is a fallback, not a third provider.** Primary path:
assets are generated on pure white and cut out by the built-in extractor —
always on, nothing to configure (`postProcessor.ts` defaults to
`builtInBackgroundRemovalProvider`). A removal API is consulted only when the
built-in path fails, and only if the creator connected one under "Configure
fallback (optional)" in AI Settings.

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

**P0 product closure — settings UX, background-removal policy, run status.**

- AI Settings is protocol-first: API standard dropdown + free-text provider
  name; Custom JSON folds out Advanced API mapping; no Custom/Preset tabs.
- Background removal demoted to optional fallback; primary built-in extraction
  needs no configuration (runtime already defaulted to it — UI was the lie).
- Agent run status semantics: COMPLETED / PARTIALLY_COMPLETED / FAILED from
  `agent/stepPolicy.ts`; explicit "Approximate composition" fallback for failed
  interactions; "Done with X failed steps" eliminated. Golden tests CASE 1–4 in
  `agent/runStatus.test.ts`; browser smoke (`scripts/smoke-settings.mjs`)
  verified the new settings UI with zero console errors.
- 866 tests / 72 files, lint, typecheck, build all green; deployed to
  production (`mangaharness.vercel.app`).

**P0 debt closure — apposition co-resolution + unified creation policy.** See
"Co-reference" above. `b02eff1` + `be0e92f`, deployed to production
(`mangaharness.vercel.app`). Remaining true blocker: live provider round-trips
still require the user's browser BYOK session; nothing in this environment can
exercise them.

**Temporal planning and camera intent closed; MVP frozen.**

- `agent/sequencePlan.ts` is the enforced structure: every beat carries its
  panel, resolved by `agent/panelAllocation.ts`, and compiles to editor
  commands. Structured prompts no longer depend on what the model emits.
- `agent/cameraIntent.ts` parses EN + ZH camera language into a typed intent and
  compiles it into the existing camera, perspective, depth and focus commands.
- Post-conditions validate the SEMANTIC plan; any breach rolls back.
- Golden cases A–G in `agent/sequenceGolden.test.ts` run the real pipeline with
  only the model call stubbed.
- Fixed on the way: a pre-existing pile-up was rolling back unrelated runs, and
  a merely-mentioned character adopted the actor's pose.

**Character identity resolver + production-verified interaction UI.**

- Reported from production: a character selected on the canvas showed no State /
  Interactions / Details tabs. The Inspector read `asset.metadata.characterId`
  alone; that document carried the identity on the reverse link only. See D65.
- `characters/identity.ts` resolves through all three links and is used by the
  Inspector, InteractionControls, the pair banner, `stateFromInstance`,
  `slotSwitch`, `hitStack`, `CanvasStage` and the Agent panel.
  `replaceAssetReferences` no longer creates the broken state.
- Shift-click did nothing when both characters were placed with Fit; it now
  takes the next unselected hit-stack entry, and the Layers list accepts
  shift-click as a path that cannot degrade. See D66.
- Verified on the deployed site at commit `a04b49f`, not on localhost.

**Agent subject/scope repair + Relationship & Interaction reachability.**

- Reproduced the reported failure in the browser: grounding resolved Cute Girl
  and Yuri correctly, then a selected lamp overruled them. Two sites encoded
  "selection is authority" — `validateStepScope` rejected every step, and
  `findTargetInstance` demanded the selected object be a character. Both fixed;
  see D62.
- `subject.ts`, `sceneIntent.ts` and `scopeForSubject` added. The Agent panel now
  prints Subject / Scope / Selection-used-as-subject / Sequence before executing.
- Grounded entities are ordered by READING order; a name swallowed by a longer
  relationship phrase is no longer a separate reference.
- Relationships are reachable from the Inspector (character → Details) with
  create, edit, delete; Interactions from character → Interactions and from a
  high-priority banner when two actors are selected. Both go through
  `interactionService` — the Inspector's second execution path is gone.

**Kumanga brand + flat UI pass.** Product renamed from "Manga Studio"; the
approved bear mark reconstructed as vector and wired through favicon, manifest,
toolbar, welcome screen and README. Design tokens introduced, Lucide adopted as
the single icon system, every emoji removed from the product UI, and the button
hierarchy flattened (see D60/D61).

**V3.5 — MVP completion / debt closure.** See `docs/MVP_COMPLETION_AUDIT.md` for
the item-by-item classification.

- **Agent runs are transactional.** `executePlan` snapshots, executes, validates,
  then commits OR rolls back. A failed generation stops the run instead of
  composing around a hole. Rollback keeps images already paid for and the
  generation log — it restores the PAGE, not the library.
- **Validation has severity.** `IssueSeverity` = info / warning / fatal; any
  fatal aborts. The panel says what was restored instead of "Done with 1 warning".
- **`create_interaction`** reaches the Agent, through the same
  `services/interaction` the Inspector uses — capability check, cache reuse,
  one joint render carrying BOTH identity references, provenance, placement.
- **Execution classes.** `agent/capabilityRouter.ts` answers whether a tool can
  spend a generation; an unclassified tool is treated as generative.
- **Golden regression.** `src/agent/goldenRun.test.ts` — panels the request never
  named come back byte-identical, or the run did not commit.
- **Cosmetic variations replace the render they improved** (`promoteVariation`),
  so a repaired hand reaches every later placement.
- **Ground plane + depth handle** on canvas, **Inspector tabs**
  (Look / Position / Scene), **one `+ Generate`** entry point.

**Tests:** 862 passing / 71 files. Typecheck, lint and production build clean.

## Known Bugs / UX Problems

These are POST-MVP. None is unfinished MVP work.

- No path has been exercised against a live image provider in this environment
  (`POST /api/generate` → 503). Everything up to that call is complete.
- Local editing on a composite (two-character) asset treats it as one image;
  there is no per-participant escalation.
- Three-point perspective renders guides but has no distinct projection
  consequence beyond two-point.
- Objects cannot be attached to a character's hand from the UI.
- Assets generated before the white-background policy keep a magenta matte until
  "Fix transparency" is run on that character.
- A sequence needing more than four panels overflows rather than adding a page.
- Camera vocabulary is EN + ZH; other languages fall back to the planner.

## Next Recommended Work (POST-MVP)

1. Run every generation path against a real provider.
2. Per-participant escalation for local edits on composite assets.
3. Mesh deformation and corner-pin, which unblock real perspective placement.
4. Object → hand attachment through the existing puppet sockets.
5. Multi-page sequence overflow.

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

---

## Agent V2 + Harness (2026-08-22, commits 5f8eb7f / a64645e / f1fdcfa)

**AGENT V2 SHIPPED.** The 1703-line `src/agent/executor.ts` is deleted and
replaced by `src/agent-v2/`:

- `pipeline.ts` — UNDERSTAND → PLAN → RESOLVE → CALL → VALIDATE; AgentPanel
  only renders pipeline events.
- `orchestrator.ts` — run lifecycle: transaction, step policy, validation,
  execution summary.
- `process/*` — per-domain execution (character / scene / panel / dialogue /
  tone / camera / interaction / localEdit), each taking a run-scoped
  `RunContext` (no module-level run globals).
- `validation/` — plan / sequence / identity post-conditions.
- Architecture boundary tests now cover both `src/agent/` and `src/agent-v2/`.

**New agent tool `edit_asset_region`** — golden case J pins it to the same
`/api/assets/edit` route and the same `LocalEditService.saveEditedVariation`
write path as the Asset Detail Editor UI. The agent passes a full-canvas mask
(regionless edit; locality comes from the instruction — recorded assumption).
Result lands as a NEW asset with local-edit provenance and is swapped into the
targeted instance; the original is never mutated.

**HARNESS v0.1.0.** Root npm workspace: one `npm install` at the root, then
`npm run dev|build|start|test|typecheck|lint`. Root scripts call `next`
directly so host/port args forward (the `npm --prefix` chain swallowed `-p`).
No registration, localhost-first: blob storage falls back to `./.data`,
provider status treats non-Vercel as configured. README rewritten for Kumanga,
NOTICE.md + in-app "Kumanga by BotTony329" credit added, CONTRIBUTING.md and
ARCHITECTURE.md added. Clean-clone verified: install → dev (custom port) →
build → start → 873 tests, all pass from a fresh clone.

**Tests: 873 passed / 74 files. Gates: tsc / eslint / build all clean.
Production: https://mangaharness.vercel.app (HTTP 200).**

NOT verified in this environment: live BYOK generation against a real
provider key (no key available here) — first item of POST-MVP work.

---

## Semantic Integrity (2026-08-22)

P0 root cause: the LLM planner was treated as a source of truth — it invented
characters "Japanese"/"Kyoto" from a prompt whose only named entity was Kiki,
and nothing downstream distrusted it.

Fix — a provider-independent Semantic Parser Contract, three layers:

- `src/agent/literalEvidence.ts` — deterministic extraction of the prompt's
  immutable facts: explicit naming structures (called/named/whose name is +
  叫/名叫/名字叫/叫做) with attribute binding, and location spans (location
  preposition + proper noun; "X-style street" scene frames). No model, no
  hard-coded names.
- `src/agent/prompts/semanticParser.ts` — the single versioned system-prompt
  contract (SEMANTIC_PARSER_CONTRACT v1), imported by the planner only.
- `src/agent/semanticValidation.ts` — runtime distrust layer: any plan step
  whose character name is a location, an attribute word, or absent from the
  prompt's evidence is a violation; violations BLOCK the run before
  AssetRequirements/executor. Apposition double-participants are caught too.

Grounding now consumes literal evidence (protected surfaces never become
entities) and explicit naming alone authorizes creation ("a girl named Kiki"
asks for Kiki to exist — no creation verb required, per §10 three-state
EXISTING/CREATE/UNRESOLVED).

Answers: (1) Kiki can't become "Japanese" because explicit naming binds
nearby descriptors as attributes and the validator rejects attribute-derived
identities. (2) Kyoto can't auto-become a character: location evidence +
grounding protection; only explicit naming ("a villain named Kyoto") makes it
one — CASE 2 proves this is structural, not hardcode. (3) If the LLM still
errs, semanticValidation blocks the run inside validateGroundedPlan. (4) No
test strings in the implementation — rules are structural. (5) New providers
need no Agent Core change: the contract is one imported prompt, validation is
deterministic. (6) No reverse coupling: UI → pipeline → services → domain.

Golden cases P0 + 2–7 in `src/agent/semanticGolden.test.ts` (12 tests).
Suite: 885 passed / 75 files. Gates clean. Production HTTP 200.

Remaining: scene background auto-requirement for P0-style prompts still rides
the planner (validator guards identities, not scene completeness); compound
pose fidelity is asserted at grounding level, generation fidelity is POST-MVP.
