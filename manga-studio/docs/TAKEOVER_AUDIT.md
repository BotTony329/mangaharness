# Takeover Audit — 2026-08-21

New lead-agent intake audit. Read after `PROJECT_CONTEXT.md`. Classification:
**A** working · **B** partial · **C** data-only / misleading · **D** broken · **E** missing.

## 0. Baseline

- HEAD: `764350a` ("Tell the planner apply_tone exists"), `main`, clean tree.
- Node deps: `npm ci` clean. Typecheck ✓ · ESLint ✓ · **Vitest 851/851 (70 files)** ✓ · `next build` ✓.
- App root is `manga-studio/` (repo root also carries a stale `manga-studio.tar.gz` and a stray top-level `node_modules/` — housekeeping candidates, not runtime).

## 1. Architecture map

Next.js 15 App Router + React 19 + TS strict + Zustand + Konva. One write path:
every mutation is a `DomainCommand` → `domain/commands.ts` → pure `domain/*Ops.ts`.
Undo is snapshot-based (`editor/store.ts`). Persistence is IndexedDB per project;
images live in object storage by URL. Schema v12, forward-only migrations.
BYOK keys are AES-GCM HttpOnly cookies; the browser never talks to a provider.

## 2. Agent runtime map

```
prompt → agent/grounding.ts (deterministic, 3-way entity resolution)
       → agent/entityResolution.ts  EXISTING / CREATE / UNRESOLVED
       → agent/subject.ts · scope.ts · sceneIntent.ts · sequencePlan.ts · panelAllocation.ts
       → agent/assetRequirements.ts → fulfilRequirements.ts (creation OUTSIDE the page tx)
       → planner.ts (ONE semantic model call) → tools/schemas.ts validatePlan
       → capabilityRouter.ts → executor.ts (transaction: snapshot → steps → post-conditions → commit/rollback)
```

- **A** — One planner call per run; deterministic pre/post stages; transactional
  execution with fatal-severity rollback; golden tests (`sequenceGolden`, `goldenRun`,
  `generationArrow`) cover CASE 1 ("Roach Man") end-to-end with only the model stubbed.
- **D — apposition co-resolution is NOT implemented.** CASE 2/4 from the takeover
  brief: "his rival, **the bad character Roachman**" / "her sister, **Mori**" have no
  scene-local alias merge. Grep confirms: relationship lookup and stored aliases exist,
  but nothing merges an appositive phrase with the named entity into one participant.
  A run of CASE 2 today still yields `rival → unresolved` + `Roachman → create` as two
  separate references. **This is the top Agent gap.**
- **B — planner/system-prompt contradiction.** `planner.ts` still instructs the model
  "If the user names someone who is not in it, do NOT create them" while
  `groundingContext()` injects "NEW CHARACTER … Do NOT refuse". Conflicting instructions
  to the same model in the same prompt — a real instability source for CASE 1/2.

## 3. Provider runtime map

- **A — protocol-first holds in the runtime.** Dispatch is by `providerType`
  (`ai/providerRegistry.ts`, `agent/providers/registry.ts`); no `providerName ===` /
  `switch(provider)` vendor branching anywhere in `src/`.
- **A — Save vs Test.** `POST /api/provider/config` validates + seals the cookie and
  never calls the remote API; `POST /api/provider/test` does the round-trip.
- **A — HTML-guard.** Agent/image adapters check `content-type` before parsing
  (`openaiResponse.ts`, `customAgent.ts`); the "Unexpected token '<'" class of failure
  is handled at the adapter boundary with safe messages.
- **A — provider-agnostic acceptance.** `buildProviderConfig` accepts any `name`;
  `custom` is the universal declarative type; unknown vendor names are never rejected.
- **B — UI preset labels are protocol names** ("OpenAI Compatible", "Anthropic
  Compatible", "Google Gemini") — these are API standards, not vendors, and a free
  Provider Name field + Custom API mode exist. Acceptable per protocol-first, but the
  preset tab is what the takeover brief saw as "hardcoded"; consider renaming the tab
  copy to "API Standard" emphasis (it already labels the select "API standard").
- **C — `envAgentConfig()` defaults to `https://api.deepseek.com`.** A deployment-only
  fallback, not the BYOK path, but it is a baked-in vendor default worth de-vendoring.
- Gemini native is an adapter (`ai/providers/gemini.ts`), not a whitelist. ✓

## 4. Generation runtime map

`ai/generate.ts` → `providerRegistry` → adapter → bytes → `assets/postProcessor.ts`
(white-policy validation → connectivity flood → matte decontamination → alpha contract)
→ `storage/objectStore.ts` → library. Local edit goes through
`assets/localEdit.ts` (outside-mask byte-exact compositor). All **A** at architecture +
test level; **live provider round-trip remains UNVERIFIED** (no credential here) —
status stays `IMPLEMENTATION COMPLETE — LIVE PROVIDER UNVERIFIED`.

## 5. Character identity map

`characters/identity.ts` is the ONE resolver (3-link confidence order), used by
Inspector, InteractionControls, pair banner, canvas hit stack and the Agent. **A**.
`characters/kit.ts` survives only as `defaultCharacterState` inside `stateResolver.ts` —
the old CharacterKit path is effectively shrunk already.

## 6. Interaction map

`domain/interactions.ts` + `interactionService.ts`: capability pick
LOCAL_STAGE / LOCAL_PUPPET / HYBRID / JOINT_GENERATION; joint render carries BOTH
identity references; Agent has `create_interaction` through the same service. **A** for
architecture and UI reachability (Inspector → Interactions, pair banner). **B**: no
live joint-generation provider verification; Agent scene-local role ("his rival")
cannot yet feed an interaction because apposition resolution is missing (see §2).

## 7. UI reachability map

Inspector tabs (State · Interactions · Details), pair banner, Relationships in Details,
Generator dialog, Asset Detail Editor, AI Settings (Custom API + presets), tone shelf —
all present in the tree and referenced from `Studio.tsx`. Puppet rig UI is behind
Advanced (`PuppetControls.tsx`), matching D49. **B overall** — presence verified by
code/tests; per-flow browser verification on production not yet redone this intake.

## 8. Tone system

Fully present: `domain/toneOps.ts`, `render/tonePainter.ts` (procedural tones stored as
parameters, redrawn at output resolution), `apply_tone` agent tool, shared
SelectionPainter masks. **A** (test-covered), contradicting the "please confirm whether
implemented" open question — it is implemented at HEAD.

## 9. Bubble drag

Fix commit `919a458` present: bubble hit rect participates in the canvas hit stack and
`update-bubble` dispatches move body+tail together (`CanvasStage.tsx:191`). **B** —
code + tests in place; direct-drag browser verification on production pending.

## 10. Dead / legacy inventory & performance candidates

- No second resolver per concept found for identity/scope/interaction/provider —
  the "ONE resolver" goal is largely already true at HEAD.
- Quick unreferenced-file scan is inconclusive (barrel + dynamic imports defeat naive
  grep). Run `knip`/`ts-prune` before deleting anything; do NOT trust a raw import count.
- Housekeeping: repo-root `manga-studio.tar.gz`, stray root `node_modules/`.
- Performance: executor is sequential by design (steps depend on prior creations);
  the planner makes ONE model call. Real profiling against a live provider is the
  P1 gate — no internal redundancy was obvious from static reading, but
  `agent/executor.ts` at 1668 lines is the prime slimming candidate (split per-tool
  handlers into modules; no behaviour change).

## Module classification

| Module | Class | Note |
|---|---|---|
| Projects / persistence | A | IndexedDB, autosave, migrations |
| Characters / identity | A | one resolver, repair path |
| Scenes / Objects / FX | A | |
| Tone / screentone | A | implemented, non-destructive layer |
| Relationships | A | persistent metadata, Inspector UI |
| Interactions | B | joint-gen path complete, live provider unverified |
| Agent grounding / entity resolution | B | 3-way resolution ✓; apposition co-resolution **missing** |
| Agent planner prompt | B | contradictory creation instructions |
| Agent execution | A | transactional, post-conditions, golden tests |
| Provider system | A− | protocol-first ✓; deepseek env default; preset-tab copy |
| Generation / transparency pipeline | A | live provider unverified |
| Local edit compositor | A | live provider unverified |
| Camera / stage | B | functional; discoverability weak (no dedicated mode) |
| Bubble drag | B | fix in tree; browser verify pending |
| Puppet / rig | B | correctly isolated behind Advanced; slimming candidate |
| Performance | — | needs live profiling, not guesses |

## P0 order (confirmed against code)

1. **P0-3 apposition/alias co-resolution** — the one clearly-missing Agent capability
   (blocks CASE 2 and CASE 4).
2. **P0-1 planner prompt contradiction** — remove the stale "do NOT create" clause so
   system prompt and grounding context say one thing.
3. Browser-verify bubble drag + provider flows on production with a real BYOK session
   (cannot be done from this environment — requires the user's session).
4. Then P1: `knip`-based dead-code inventory, executor split, live profiling.
