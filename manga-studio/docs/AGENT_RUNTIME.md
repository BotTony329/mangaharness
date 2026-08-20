# Agent Runtime

## Execution path

1. Resolve an immutable authoritative scope from selection, explicit scope control, and limited widening language.
2. Build concise semantic context: Characters and available states, active assets, current visual contents, Panel Scenes, relationships, and continuity.
3. Ask the configured BYOK Agent provider for a concise JSON plan, with a 25-second application deadline.
4. For OpenAI-compatible Chat Completions, consume SSE incrementally and normalize content or tool-call-only responses inside the adapter.
5. Validate every tool name, argument schema, step count, panel bound, and scope rule.
6. Preview the plan and confirm generation-heavy runs.
7. Execute each tool through the canonical Domain Command Layer inside one undo transaction.
8. Validate affected panel composition and structurally audit the before/after documents for scope integrity.
9. Show Understanding → Scene plan → Asset search → Composition → Validation → Done activity and any unresolved warnings.

## Semantic tools

- `compose_character` resolves an exact cached Character state first, generates only a missing state when allowed, then applies framing, semantic position, facing, depth, and role.
- `set_character_slot` changes only specified state dimensions while preserving composition.
- `reuse_scene_background` places the exact source background from another panel and records continuity.
- `add_scene_relationship` records subject/action/target meaning in the Panel Scene.
- Legacy placement tools remain for compatible simple plans, but they also dispatch commands.

## Safety boundaries

The Agent cannot mutate Zustand internals or call domain mutation helpers directly. Scope is checked during plan validation and immediately before every step. Selected-object scope permits only semantic changes to that object; selected-panel scope rejects other target panels, page layout changes, and loose workspace placement. A post-run structural audit detects any breach even if a future tool guard is incomplete.

AI providers remain outside the domain. User API keys are encrypted in HttpOnly cookies under the deployment-owned `APP_ENCRYPTION_KEY`; commands and project documents never contain provider secrets.

## Planning reliability and diagnostics

The route runs on the Node runtime with `maxDuration = 120`, but does not use that infrastructure ceiling as request control. A planner-owned 25-second signal covers both the outbound connection and streamed body. Timeout, request cancellation, provider 429/5xx, unreadable output, and invalid plans are distinct normalized failures.

Safe trace stages are: request received, context built, provider configuration loaded, outbound request started, first response byte, tool calls discovered when applicable, provider response complete, response parse start/complete, plan normalized, tool validation complete, and response returned. Logs and browser Details never include API keys, authorization headers, cookies, encryption keys, or complete provider configurations.

Planning and execution remain split: `/api/agent` returns a validated plan; the client executes tools incrementally. While waiting, the UI advances from understanding to sending, waiting, responding, and longer-than-usual states. A failure exposes retry plus provider/model/stage/elapsed/status/finish-reason/request-ID/timing metadata when available.
