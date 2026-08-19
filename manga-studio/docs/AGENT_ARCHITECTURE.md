# Manga Agent Architecture

The agent is an AI assistant that **operates the studio**, not an image generator. It plans with an LLM, then executes typed tool calls through the same domain commands the manual UI uses. Output is always an editable composition.

## Pipeline

```
Prompt (+ current page / selection)
  ↓ buildAgentContext()            client: concise structured inventory —
  |                                characters with pose/expression slots,
  |                                backgrounds, props, panel contents
  ↓ POST /api/agent
  ↓ selectSkills()                 server: deterministic keyword scoring
  ↓ planner system prompt          role + tool docs + selected skill texts
  ↓ AgentModelProvider             OpenAI-compatible JSON-mode completion
  |                                (DeepSeek by default; AGENT_* env vars)
  ↓ validatePlan()                 zod per-step validation; unknown tools &
  |                                malformed args rejected individually
  ↓ response { summary, steps, skillsUsed, rejected }
  ↓ executePlan()                  client: one history transaction;
  |                                steps run in order through domain commands;
  |                                generate_* steps call /api/generate and
  |                                land results in the library first
  ↓ editable page (one Undo reverts the whole run)
```

## Tools (`src/agent/tools/schemas.ts`)

`create_character`, `generate_character_asset`, `generate_background`, `generate_prop`, `set_page_layout`, `place_asset`, `set_crop_mode`, `add_speech_bubble`, `add_effect`, `remove_items`.

Tools address things **semantically** — panel numbers in reading order, character names, slot descriptors — instead of internal IDs. That lets a single planning pass place assets that earlier steps will create, with the executor's resolver mapping semantics onto real IDs at execution time.

## Asset resolution (`src/agent/resolver.ts`)

Reuse-first matching on slot metadata (never filenames): exact pose/expression match → compatible near-match (expression outweighs pose) → identity reference → newest asset. A close variant plus a crop mode beats a regeneration — the resolver is where the anti-regeneration economics live at execution time; the composition skill enforces it at planning time.

## Skills (`src/agent/skills/`)

Modular instruction sets in plain markdown text: Manga Panel Composition (always on), Character Asset Creation, Page Layout, Dialogue Placement, Yonkoma, Action Scene. Selection is deterministic keyword scoring (no extra LLM round-trip); the UI shows which skills were used. Stored as text-in-TS-modules so serverless bundling can never drop them — the content is still inspectable prose anyone can edit, and the format can move to loose `.md` files when a bundler-safe loader is worth it.

## Safety & control

- The model can only call registered tools; every call is schema-validated server-side before it reaches the client, and re-checked at execution (panel bounds, character existence).
- No arbitrary code, shell, network, or state access — tool execution is the whole surface.
- Plans with more than 3 generations pause for explicit confirmation with the count shown; smaller plans run immediately.
- The agent must not destroy manual work: `remove_items` exists but skills instruct it only for explicit replace/clear requests, and every run is undoable in one step.
- Failed steps are reported per-step and skipped; the run continues so successful generations aren't wasted.

## Interoperability

Manual editing and agent runs interleave freely: both go through the same command layer, the context builder reads whatever the current document is (including the user's selection for "make this panel more dramatic"-style contextual prompts), and quick-action chips prefill common prompts.
