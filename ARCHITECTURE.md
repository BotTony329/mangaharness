# Kumanga Architecture

Layered, with static boundary tests (`manga-studio/src/services/architecture.test.ts`)
that fail the suite if a layer is bypassed.

## Editor Core (agent-independent)

- `src/domain/` — document model, commands, validation, camera math, tones.
  Pure, no IO.
- `src/editor/` — zustand store and command dispatch; the only mutation path.
- `src/services/` — application services (generation, characters, scenery,
  language, interaction, localEdit). UI and the agent BOTH call these; neither
  touches provider adapters, `/api/*` internals, or storage directly.
- `src/characters/`, `src/tones/`, `src/language/` — domain helpers shared by
  UI and services.

**Editor Core does not depend on the Agent.** The dependency only ever points
inward: agent → services → domain.

## Manga Agent V3

Natural language in, a finished page region out — with the LLM as Creative
Director and code as the only owner of state, identity and execution.

```
User prompt
→ Literal Lock            (agent-v3/contract/literalLock — immutable evidence)
→ Creative Director LLM   (ONE call, server-side /api/agent/direct)
→ Creative Task Map       (zod contract; names only, never runtime IDs)
→ Structural validation   (normalize → single canonical schema; field-path errors)
→ Semantic capability resolution
     routing/cameraSemantics       creative camera words → editor camera enums
     routing/interactionSemantics  creative interaction words → InteractionType
     routing/dialogueSemantics     delivery words → BubbleType
     (unknown wording = fallback + warning, raw intent preserved; never fatal)
→ Project resolution      (agent-v3/resolution — names bound to real IDs or
                           marked create; "existing but missing" = blocked)
→ Executable plan         (routing/capabilityRouter — agent-v2 tool steps,
                           REUSE/TRANSFORM/GENERATE decided here)
→ agent-v2 orchestrator   (transaction, rollback, step policy, preserved assets)
→ Services → Domain commands
→ Deterministic verifier  (agent-v3/verification — participants exist, actors
                           placed, dialogue byte-exact, scope untouched)
→ Commit
```

- `src/agent-v3/` — contract / director / context / resolution / routing /
  verification / run (client orchestration).
- `src/agent-v2/` — execution engine: `orchestrator.ts` (transaction + policy
  + summary), `process/*` (per-domain step execution), `validation/`.
- `src/agent/` — shared planning-side vocabulary (literal evidence, resolver,
  tool schemas, step policy) plus provider plumbing.

## Providers & storage

- `src/ai/` + `src/server/` — provider registry and credential/session
  handling, server-side only. BYOK: keys never leave the user's own setup.
- `src/app/api/` — HTTP routes: generate, assets/edit, remove-background,
  agent, agent/direct, provider status.
- `src/storage/` — projects in IndexedDB; generated/edited images via
  objectStore (Vercel Blob when a token exists, local `.data/` otherwise).
  Nothing requires Vercel.

Invariants worth knowing:

- The agent's run either lands whole or rolls back; generated library assets
  survive by design (they were paid for) and are named in the run summary.
- Local edits always create a NEW asset with provenance; originals never mutate.
- One canonical Creative Director system prompt; one camera normalization
  boundary; one tone registry (`domain/tones.ts` + `tones/mood.ts`) shared by
  the Tones shelf and the Agent.
