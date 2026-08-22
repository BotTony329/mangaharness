# Kumanga Architecture

Layered, with static boundary tests (`manga-studio/src/services/architecture.test.ts`)
that fail the suite if a layer is bypassed.

- `src/domain/` — document model, commands, validation. Pure, no IO.
- `src/editor/` — zustand store and command dispatch; the only mutation path.
- `src/services/` — application services (generation, characters, scenery,
  language, interaction, localEdit). UI and the agent BOTH call these; neither
  touches provider adapters, `/api/*` internals, or storage directly.
- `src/agent/` — planning side: grounding, subject, scene intent, sequence
  plan, tool schemas, plan validation, step policy.
- `src/agent-v2/` — execution engine: `pipeline.ts` (UNDERSTAND → PLAN →
  RESOLVE → CALL → VALIDATE), `orchestrator.ts` (transaction + policy +
  summary), `process/*` (per-domain step execution), `validation/`.
- `src/ai/` + `src/server/` — provider registry and credential/session
  handling, server-side only.
- `src/app/api/` — HTTP routes: generate, assets/edit, remove-background,
  agent, provider status.

Invariants worth knowing:

- The agent's run either lands whole or rolls back; generated library assets
  survive by design (they were paid for) and are named in the run summary.
- Local edits always create a NEW asset with provenance; originals never mutate.
