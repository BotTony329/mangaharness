# MVP Completion Audit

Read this with `docs/PROJECT_CONTEXT.md` and `docs/DECISIONS.md` at the start of
every session, and update it at the end.

**Classification rule:** a type, schema, request builder or domain model is NOT
execution evidence. `COMPLETE` requires a cited path from intent to persistence.

> Audit taken against commit `21a4562`, then updated as debt was closed.

---

## Reachability matrix

**A single COMPLETE is banned.** A capability can be finished in the domain,
reachable by the Agent, and still be invisible to a creator — which is exactly
how Relationships and Interactions came to be reported as done while nobody
could find them. Every user-facing capability is scored on five independent
axes.

| Capability | Domain | Agent | UI reachable | Real execution | Browser verified |
|---|---|---|---|---|---|
| Relationship — create | COMPLETE | COMPLETE (grounding) | COMPLETE | N/A (no generation) | COMPLETE |
| Relationship — list / reciprocal | COMPLETE | COMPLETE | COMPLETE | N/A | COMPLETE |
| Relationship — edit type | COMPLETE | N/A | COMPLETE | N/A | PARTIAL — control present, re-type not clicked through |
| Relationship — delete | COMPLETE | N/A | COMPLETE | N/A | COMPLETE |
| Relationship → Agent grounding ("her close friend") | COMPLETE | COMPLETE | COMPLETE | N/A | COMPLETE — resolves with the edge, refuses without it |
| Interaction — single-character entry | COMPLETE | COMPLETE | COMPLETE | see below | COMPLETE |
| Interaction — multi-select entry | COMPLETE | COMPLETE | COMPLETE | see below | COMPLETE |
| Interaction — Instant vs Generate labels | COMPLETE | N/A | COMPLETE | N/A | COMPLETE |
| Interaction — local (Walk Together, Beside) | COMPLETE | COMPLETE | COMPLETE | COMPLETE | PARTIAL — labelled Instant, not clicked through |
| Interaction — joint render (Hug) | COMPLETE | COMPLETE | COMPLETE | IMPLEMENTED | PARTIAL — reaches `POST /api/generate`, 503 (no provider) |
| Interaction — provider round trip | — | — | — | IMPLEMENTED | **UNVERIFIED** — no provider in this environment |
| Subject vs scope precedence | COMPLETE | COMPLETE | COMPLETE (run log) | N/A | COMPLETE |
| Temporal decomposition ("then") | COMPLETE | COMPLETE | COMPLETE (run log) | PARTIAL — plan requests N panels; the planner is told, not forced | COMPLETE |
| Camera intent ("to the camera") | COMPLETE | PARTIAL — carried as a constraint to the planner | COMPLETE (run log) | PARTIAL | COMPLETE |
| Dialogue planning ("shouting Yuri's name") | COMPLETE | COMPLETE | COMPLETE (run log) | COMPLETE — editor-native bubble | COMPLETE |

### What "browser verified" means here

This environment has **no AI provider**. `POST /api/agent` and
`POST /api/generate` cannot reach a model. For the Agent runs above, the LLM
call was stubbed in the page and **everything downstream ran for real**:
grounding, subject resolution, scope, intent derivation, plan validation,
capability routing, execution, post-validation and rollback. The stub is stated
wherever it applies; nothing about the model's own output is claimed.

---

## P0 — Agent ↔ image generation execution

The previous reports were partly wrong in both directions. Correcting the record.

| Agent action | Class | Execution path |
|---|---|---|
| `generate_character_asset` | **COMPLETE** | `executor.doGenerateCharacterAsset` → `generateCharacterAssetForState` (`stateRuntime.ts:121`) → `callGenerateApi` → `POST /api/generate` → `generateAsset` → `provider.generateImage` → `processAndStoreAsset` → `create-asset` |
| `generate_background` / `generate_prop` | **COMPLETE** | `executor.doGenerateScenery` → `callGenerateApi` (`executor.ts:393`) → same route |
| `generate_manga_effect` | **COMPLETE** | `executor.doGenerateMangaEffect` → `callGenerateApi` (`executor.ts:840`) → same route → `add-language-asset` |
| `place_character` / `compose_character` (generate-if-missing) | **COMPLETE** | `resolveOrGenerateState` → `generateCharacterAssetForState` → real route |
| `set_character_slot` | **COMPLETE** | `applyCharacterStateToInstance` → `generateCharacterAssetForState` (`stateRuntime.ts:202`) |
| **`create_interaction`** | **MISSING → COMPLETE** | Added: `executor.doCreateInteraction` → `interactionService.executeInteraction` → orchestrator → real route |
| **Joint (multi-character) generation from Agent** | **MISSING → IMPLEMENTED — PROVIDER-INTEGRATION UNVERIFIED** | `executor.doCreateInteraction` → `interactionService.executeInteraction` → `renderInteraction` → `callGenerateApi` with BOTH reference URLs → `storeGeneratedAsset` → `record-interaction-render` → `placeInteractionRender` |
| Joint generation from UI | **IMPLEMENTED — PROVIDER-INTEGRATION UNVERIFIED** | `InteractionDialog` → `renderInteraction` / `placeInteractionRender` — the same service, with a preview step the Agent skips |
| Local/inpaint edit (`/api/assets/edit`) | **IMPLEMENTED — PROVIDER-INTEGRATION UNVERIFIED** | `AssetDetailEditor` → `POST /api/assets/edit` → `provider.editImage` → `compositeLocalEdit` → `putObject` |
| Local edit from Agent | **MISSING** | No agent tool. Deferred — see below. |

**Correction to earlier reporting:** character, scene, object and manga-FX
generation from the Agent were already real end-to-end. The statement "the Agent
may not actually orchestrate image generation" was true only for interactions.

---

## P0 — Execution classes

| Class | Router verdict | Reaches provider |
|---|---|---|
| `EDITOR_OP` — move, scale, camera, framing, bubble, layer, panel, effect | `EDITOR_OP` | never |
| `LOCAL_ASSET_OP` — puppet expression, supported joint, crop, transform | `LOCAL_ASSET_OP` | never |
| `AI_GENERATION` — new character, unsupported pose, outfit, scene, object, interaction, local redraw | `AI_GENERATION` | always |

Implemented in `src/agent/capabilityRouter.ts`, asserted per tool in
`src/agent/capabilityRouter.test.ts`. No `AI_GENERATION` action is satisfied by
composing existing PNGs.

---

## P0 — Non-destructive Agent transaction

| Item | Before | After |
|---|---|---|
| Snapshot | `beginTransaction` captured one, used only for undo grouping | Same snapshot now also serves rollback |
| Failure handling | Per-step `catch` swallowed errors; `endTransaction` always committed | `abortTransaction()` restores the snapshot |
| Fatal validation | none | `FATAL` issues abort and roll back |
| Scope protection | `validateScopeIntegrity` reported after commit | Runs before commit; violations are FATAL |

**Was BROKEN** — a failed or destructive run committed anyway. Now:
`Understand → Ground → Scope → Plan → Preflight → Snapshot → Execute →
Post-validate → Commit OR Rollback` (`executor.executePlan`).

---

## P0 — Validation severity

**Was BROKEN.** `CompositionIssue` had only `corrected: boolean`, so
"Character is completely obscured by a higher layer" was reported alongside a
success message.

Now `severity: "info" | "warning" | "fatal"` (`compositionValidation.ts`).
FATAL: required participant missing, participant fully obscured, interaction
missing a participant, scope violation, unexpected deletion, panel emptied.
Any FATAL rolls the run back.

---

## P0 — Golden regression

`src/agent/goldenRun.test.ts`. A composed four-panel page — background,
character, dialogue and an effect in every panel — and the run
"Yuri and Mori hug and they both smile happily" targeting panel 4 only.

Asserts: panels 1–3 byte-identical; exactly one generation carrying two distinct
reference URLs and the requested expression; both participants present in the
finale panel via `charactersInAsset`; no new character; panel 4's dialogue and
effect intact; the cached render reused on a second run rather than paid for
twice; and, when the provider fails, EVERY panel restored with the undo stack
untouched.

---

## P1

| Item | Class | Evidence |
|---|---|---|
| P1.1 Interaction E2E (UI + Agent share one service) | **COMPLETE** (provider unverified) | `src/domain/interactionService.ts` is the single path; `InteractionDialog` no longer builds its own request |
| P1.2 Local edit — candidates (2–4) | **COMPLETE** | `AssetDetailEditor` requests N, creator picks |
| P1.2 Local edit — lasso | **COMPLETE** | Real polygon capture, not a rectangle |
| P1.2 Local edit — pan while zoomed | **COMPLETE** | Space/middle-drag |
| P1.2 Local edit — real provider round trip | **UNVERIFIED** | No edit-capable provider in this environment (`/api/assets/edit` returns 422: the connected model cannot edit) |
| P1.2 Local edit — composite/interaction asset | **PARTIAL** | Works on the composite as one image; no per-participant escalation |
| P1.2 Local edit — glass/semi-transparent | **NOT SUPPORTED, STATED IN UI** | The outside-mask guarantee is exactly why: `AssetDetailEditor` says so beside the Generate button |
| P1.3 Cosmetic variation resolution | **COMPLETE** | `libraryOps.promoteVariation` + `characterAssetRole: variation \| panel-only`; `src/domain/variationLineage.test.ts` |
| P1.4 Ground plane + depth handle | **COMPLETE (browser-verified)** | `src/components/canvas/StageOverlay.tsx`; dragging the handle re-scales the character live |
| P1.4 Camera controls, perspective guides, stage snap | **PRE-EXISTING, VERIFIED** | `PanelStageControls`, `PerspectiveOverlay`, `place-on-stage` |
| P1.4 Corner-pin | **NOT DONE** | See below |
| P1.5 Inspector tabs | **COMPLETE (browser-verified)** | Look / Position / Scene in `InspectorPanel.tsx` |
| P1.6 Contextual toolbar | **PRE-EXISTING, VERIFIED** | `FloatingToolbar.tsx` — per-kind controls on selection |
| P1.6 Unified `+ Generate` | **COMPLETE (browser-verified)** | One top-bar entry → Character / Scene / Object / Manga FX |
| P1.7 Localhost clean-clone | **COMPLETE** | README + `.env.example` + production build |

---

## Not done, with reason

**Corner-pin (part of P1.4).** Konva has no perspective transform: pinning an
image to an arbitrary quad needs either a triangle mesh or a WebGL pass. That is
the same machinery as `P2` mesh deformation, and shipping an affine-only
"corner-pin" that silently refuses real perspective would be a control that lies
about what it does. It belongs with the mesh work, not ahead of it.

`P2` (puppet compiler, mesh deformation, hidden-region reconstruction, leg rig,
SFX warp, vertical text) untouched by design.

---

## Defects found and fixed while closing this list

Not new features — things that were already wrong:

| Defect | Consequence | Fix |
|---|---|---|
| Two `place_character` steps into one panel stacked both characters at the panel centre | The second character completely hid the first; the run reported success | `itemOps.clearCenterX` places a new character where it does not cover one already there |
| `visible: false` was ignored by the renderer | The Layers eye toggle did nothing; a hidden layer still exported | `PanelRenderer` filters hidden items |
| `placeComposite` claimed to retire the sprites a joint render replaces, and did not | Each character appeared twice after a hug | `placeInteractionRender` hides the participants it replaced |
| The stage re-resolved selection under every overlay handle | Grabbing a depth handle or vanishing point selected the panel and killed the drag | `CanvasStage` lets a draggable handle keep its own press |
| A failed run committed anyway | A destroyed panel stayed destroyed | Rollback (P0.5) |

---

## Real provider status

- **VERIFIED against a live provider:** none. This environment has no API key;
  `POST /api/generate` returns 503 and `POST /api/assets/edit` returns 422.
- **IMPLEMENTED — PROVIDER-INTEGRATION UNVERIFIED:** character/state/pose/
  expression generation, scene, object, manga FX, interaction joint generation,
  local edit.
- **MOCK-ONLY:** nothing. Every path above calls the real route; the tests stub
  `fetch` at the network boundary rather than replacing the pipeline.
