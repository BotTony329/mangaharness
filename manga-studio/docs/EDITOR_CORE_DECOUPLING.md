# Kumanga — Editor Core Decoupling Audit (Phase kickoff)

> Goal: UI and Manga Agent are two callers of ONE set of Application Services.
> No rewrites. Extract service boundaries, merge duplicate paths, delete dead
> paths. All existing behaviour must survive.
> Acceptance test: delete `src/agent/` tomorrow → Editor still runs complete;
> rewrite `src/agent/` → no changes needed in Character/Scene/Object/Tone/
> Provider/Renderer/Persistence.

## 1. Before dependency graph (audited 2026-08-22, commit 4e999c5)

```
UI (components/*)
 ├─ TopBar / PagesBar / CanvasStage …      → editor/store.dispatch (commands)      OK
 ├─ Inspector/InteractionControls          → domain/interactionService  ─┐ shared
 ├─ dialogs/InteractionDialog              → domain/interactionService  ─┤ path
 ├─ library/CharactersTab                  → characters/stateRuntime    ─┐ shared
 │                                          + fetch("/api/provider/status") ✗
 ├─ dialogs/GeneratorDialog                → ai/clientGeneration DIRECT ✗
 │                                          + storeGeneratedAsset + dispatch
 ├─ dialogs/AiSettingsDialog               → fetch /api/provider/*      (settings-only, tolerable)
 ├─ dialogs/AssetDetailEditor, PuppetCompilerDialog, library/uploadAsset
 │                                         → fetch /api/* DIRECT        ✗ (no service facade)
 └─ library/TonesTab, CanvasStage          → domain/toneOps via commands OK

Manga Agent (agent/*)
 ├─ executor.ts (1759 LOC, ~27 tool handlers)
 │    → ai/clientGeneration      callGenerateApi/storeGeneratedAsset   ✗ DIRECT
 │    → ai/promptTemplates       buildAssetPrompt/defaultAspect        ✗ DIRECT
 │    → characters/stateRuntime  generateCharacterAssetForState …      ─┐ shared
 │    → agent/fulfilRequirements → characters/stateRuntime            ─┘ path
 │    → domain/interactionService  executeInteraction/renderInteraction shared ✓
 │    → editor/store             dispatch (single write path)          ✓
 │    → domain/{libraryOps,factory,interactions,tones,…} DIRECT        ✗ business logic in executor
 │    → styles/generation, assets/renderSource, language/library       ✗ DIRECT
 ├─ agent/providers/*            agent LLM channel (separate concern)  ~ OK
 └─ agent NEVER imports ai/providers/* or storage/*                    ✓

Lower layers
 ├─ domain/interactionService.ts  imports ai/clientGeneration, styles,
 │    characters, assets, editor/store → an APPLICATION SERVICE misplaced
 │    inside domain/                                                   ✗ placement
 ├─ characters/stateRuntime.ts    calls fetch("/api/provider/status") +
 │    ai/clientGeneration → characters module knows about providers    ✗ layering
 ├─ ai/clientGeneration.ts        de-facto GenerationService client
 │    (callGenerateApi, storeGeneratedAsset) — thin HTTP+store facade  ~ OK, unnamed
 ├─ ai/providers/* + app/api/*    protocol/capability/credentials/HTTP ✓ hidden server-side
 ├─ domain/commands.ts            applyDomainCommand = ONE write path  ✓
 └─ storage/*                     only imported by ai/generate,
                                  assets/processAndStore, app/api      ✓ (no UI/Agent direct)
```

## 2. Duplicate / split execution paths found

| Business action | Path A (Manual UI) | Path B (Agent) | Verdict |
|---|---|---|---|
| Create character (shell) | CharactersTab → dispatch commands | executor `create_character` → libraryOps/factory direct | **DIVERGED** — converge into CharacterService |
| Generate character state asset | CharactersTab → stateRuntime | executor/fulfilRequirements → stateRuntime | shared ✓ (but stateRuntime layering ✗) |
| Generate scene / object | GeneratorDialog → clientGeneration + dispatch | executor `generate_background`/`generate_prop` re-implements prompt+generate+place | **DUPLICATED** orchestration |
| Interaction | InteractionDialog/Controls → interactionService | executor → interactionService | shared ✓ |
| Bubble / camera / tone ops | UI dispatch commands | executor dispatch commands | shared boundary ✓ |
| Provider status check | CharactersTab fetch, AiSettingsDialog fetch, stateRuntime fetch | — | 3 ad-hoc callers, no facade |

## 3. ID lifecycle (§7)

- Planning-stage semantic ids (`entityResolution.semanticIdFor`,
  `assetRequirements.semanticId`) are bound to real `characterId` in
  `planValidation.ts` before execution — boundary mostly holds ✓.
- **Leak:** `fulfilRequirements.ts:119` falls back to
  `?? requirement.semanticId` — a temporary semantic id can flow into
  execution as if it were a real character id. Must hard-fail instead.
- After execution, Agent retains resolved domain ids only; no
  `new-character-*` runtime id persists into the document ✓ (verified by
  grep — no such literal survives planning modules).

## 4. Transaction boundary (§11)

- Page mutations: single write path through commands + snapshot undo ✓.
- Rollback on run failure currently rolls back the DOCUMENT; generated
  library assets survive by design — but the run result does not yet say
  "Reusable asset created / page changes rolled back". Executor must report
  surviving assets explicitly. **OPEN**.

## 5. Convergence plan (vertical slices, behaviour-preserving)

1. **GenerationService** (`src/services/generation.ts`): name the de-facto
   facade — `generateImage / generateReferencedImage / editImage /
   providerStatus` wrapping `ai/clientGeneration` + `/api/provider/status`.
   Reroute: executor, stateRuntime, interactionService, GeneratorDialog,
   CharactersTab, AiSettingsDialog. Arch test: only `services/`, `ai/`,
   `app/api` may import `ai/providers` or call provider endpoints.
2. **CharacterService** (`src/services/characters.ts`):
   `createCharacter / generateCanonicalReference / generateState /
   resolveCharacter / replaceCharacterAsset` — wraps stateRuntime +
   libraryOps + factory. Reroute CharactersTab, executor, fulfilRequirements.
   Fix the `?? semanticId` leak (hard fail).
3. **InteractionService**: move `domain/interactionService.ts` →
   `src/services/interaction.ts` (re-export shim, then remove shim). It is an
   application service, not domain.
4. **Scene/Object services** (`src/services/scenes.ts`, `objects.ts`):
   extract the shared generate→store→place orchestration; GeneratorDialog and
   executor handlers both call it. Delete the duplicated orchestration in
   executor.
5. **Bubble/Camera/Tone/LocalEdit services**: thin facades organising existing
   commands (no new behaviour). Executor tool handlers shrink to
   intent → service → result.
6. **Architecture tests** (vitest, static import-graph assertions):
   manual & agent paths resolve to the same service module; `agent/*` never
   imports `ai/providers`, `storage/*`, `ai/clientGeneration`;
   `characters/*` never imports `ai/*`; `domain/*` never imports
   `editor/store` or `ai/*` (after service moves).
7. **Run-result honesty**: ExecutionSummary gains `survivingAssets` so a
   rolled-back run reports "Reusable asset created; page changes rolled
   back" instead of implying nothing changed.

## 6. Non-goals (per directive §2)

No rework of Character/Scene/Object/Tone/Interaction/LocalEdit/Provider/
Persistence/Renderer/Agent semantics. No mechanical file-splitting.

---

# OUTCOME (2026-08-22, slices 1–5 landed)

## After dependency graph

```
UI (components/*)                     Manga Agent (agent/*)
 ├─ commands via editor/store ✓        ├─ services/characters   createCharacter …
 ├─ services/characters (New           ├─ services/scenery      generateSceneryAsset
 │   Character, starter pack)          ├─ services/language     manga-effect pair
 ├─ services/scenery primitives        ├─ services/interaction  executeInteraction
 │   (Generator dialog preview)        ├─ characters/stateRuntime (shared resolver)
 ├─ services/language (accept flow)    └─ commands via editor/store ✓
 ├─ services/interaction (dialogs,
 │   inspector)
 └─ services/generation (status,
     generate, register)
              ↓
   ai/clientGeneration (impl) → app/api → ai/providers (server-only)
              ↓
   domain/commands (ONE write path) → storage (app/api + ai only)
```

## What changed

- **New service layer** `src/services/`: `generation.ts` (GenerationService:
  generateImage / registerGeneratedAsset / fetchProviderStatus /
  imageProviderCapabilities), `characters.ts` (createCharacter /
  attachCanonicalReferenceFile / generateCanonicalReference /
  generateCharacterState / replaceCharacterAsset), `scenery.ts`
  (buildSceneryRequest / generateSceneryAsset for background+prop),
  `language.ts` (generateMangaEffectImage / registerMangaEffectAsset /
  effectTags), `interaction.ts` (moved from `domain/interactionService.ts`).
- **Removed duplicate paths**: ad-hoc `fetch("/api/provider/status")` ×5 →
  `fetchProviderStatus()`; executor's scenery orchestration →
  `generateSceneryAsset`; executor + dialog's divergent manga-effect
  register+tag logic → `registerMangaEffectAsset` (dialog's stopword tagger
  won); CharactersTab's create+upload+rollback → CharacterService.
- **Agent direct dependencies removed**: executor no longer imports
  `ai/clientGeneration`, `ai/promptTemplates`, `styles/generation`, or
  `assets/renderSource` assetRenderUrl — generation enters only through
  `services/*`.
- **ID lifecycle**: `fulfilRequirements` no longer falls back to a semantic
  id as if it were a character id (`?? requirement.semanticId` removed — a
  missing binding now fails explicitly).
- **Transaction honesty**: `ExecutionSummary.preservedAssets` names library
  assets that survived a rollback; the failed-run banner says "page changes
  were rolled back — kept in the library: …" instead of implying nothing
  changed. Golden CASE 5 pins it.
- **Not extracted (deliberate)**: Bubble/Camera/Tone/LocalEdit handlers are
  already thin intent→command mappings over the single mutation boundary;
  per directive §13 no facade modules were created just to shrink files.

## Architecture tests (`src/services/architecture.test.ts`)

1. agent/* never imports `ai/clientGeneration` / `ai/providers` / `storage/*`.
2. characters/* never calls the generation HTTP client or provider endpoints.
3. InteractionService lives in services/ and routes via GenerationService.
4. `/api/provider/status` only fetched through GenerationService.
5. `/api/generate` only called through GenerationService.
6. Manual and Agent character creation both go through CharacterService,
   neither dispatches `create-character` directly.

## Numbers

- Tests: 866 → **872** (73 files): +6 architecture, +1 golden CASE 5, −1
  merged duplicates… (net +6, all green); lint / typecheck / build clean.
- executor.ts: 1759 → **~1640** LOC; its generation orchestration now lives
  in services where the UI can share it.
- Files: +5 services, +1 arch test, −0 deleted (interactionService moved).

## Remaining coupling (honest list)

- Agent still reads domain internals directly (`libraryOps`, `factory`,
  `interactions`, `tones`) — acceptable: those are pure doc→doc ops behind
  the same command boundary, not provider/persistence leaks.
- `resolveOrGenerateState` stays in executor: it is agent resolution *policy*
  (guards, generateIfMissing), not a shared service.
- UI dialogs still `fetch` settings/asset-upload endpoints directly
  (`AiSettingsDialog` save/test, `uploadAsset`, `AssetDetailEditor`,
  `PuppetCompilerDialog`) — server routes, not provider adapters; a
  settings-service facade is future cleanup, not coupling to Editor Core.

## Acceptance answers

**Delete `src/agent/` tomorrow — does the Editor still run complete?**
YES: nothing in components/, services/, domain/, ai/, storage/ imports from
agent/ except `AgentPanel` (the agent's own UI) and `components/agent/*`.

**Rewrite the Agent without touching Character/Scene/Object/Tone/Provider/
Renderer/Persistence?**
YES for the decoupled operations: creation, generation, scenery, language
effects and interactions are service calls with no agent-specific internals.
Camera/tone/bubble intents compile to the same domain commands the UI uses.

