# AI Manga Harness (Kumanga) — v0.1 Release Freeze

This document records the known-good baseline for the v0.1 open-source preview.
Any future change that regresses the results below should be measured against
this commit (or reverted to it).

## Release Snapshot

| Item | Value |
| --- | --- |
| Version | v0.1.2 (freeze tag; follows the repo's existing `v0.1.0` / `v0.1.1` tag series) |
| Date | 2026-08-22 |
| Baseline commit | The commit that adds this document (parent: `f6eed3d` — security hardening release) |
| Tests | 991/991 PASS (`npm test`, includes all security tests — no separate command needed) |
| Security tests | 98/98 PASS (outboundFetch SSRF/redirect/size caps, objectStore traversal, provider session, custom API, URL guard) |
| Typecheck | PASS (`npm run typecheck`) |
| Lint | PASS — 0 errors, 4 known non-blocker warnings (unused imports in `src/agent-v2/*`, pre-existing) |
| Build | PASS (`npm run build`, webpack) |
| npm audit | 0 vulnerabilities (root tree and `manga-studio` standalone lockfile) |
| Production | https://mangaharness.vercel.app — homepage 200, `/api/provider/status` 200, all security headers present |
| Attribution | `BotTony329` present in README.md, NOTICE.md, and the UI (`Studio.tsx`) |

## Architecture Baseline

```
Editor Core
  ↓
Application Services
  ↓
Domain Commands
  ↓
Renderer / Persistence
```

Agent path (V3 engine):

```
Creative Director → Creative Task Map → Semantic / Capability Resolution
  ↓
Application Services → Domain Commands
```

Security path:

```
Untrusted Input → Validation → Central Security Boundaries
  ↓
Provider / Storage / Network
```

Rules already enforced by `src/services/architecture.test.ts` (in the default
`npm test` run): the editor/domain/services never import agent engines; agents
never import provider adapters, the generation HTTP client, or persistence
directly; manual UI and Agent paths share the same services.

## Architecture Invariants (release baseline)

1. Editor does not depend on Agent.
2. Agent does not bypass Application Services.
3. Runtime IDs are owned by deterministic harness logic, never by LLM output.
4. LLM output is untrusted semantic intent.
5. Manual and Agent paths share capabilities where applicable.
6. Provider secrets never enter project documents.
7. Server outbound requests use the centralized security boundary
   (`src/server/outboundFetch.ts`).
8. Project persistence remains local-first.
9. BYOK remains supported.
10. No registration is required for local use.
11. Attribution to BotTony329 remains present (README, NOTICE, UI).
12. Security protections must not be bypassed for provider compatibility.

## Security Freeze

Security review baseline (closed 2026-08-22):

- P0: 0
- Known P1s: closed (SSRF DNS/redirect bypass, unbounded provider responses)
- SSRF boundary: centralized in `src/server/outboundFetch.ts`
- Secret scan: pass
- Dependency audit: pass (sharp ≥ 0.35.3, postcss ≥ 8.5.26)
- Security headers: enabled (CSP + baseline headers)
- BYOK secret handling: pass (AES-256-GCM HttpOnly cookies, redacted errors)

Future changes touching any of the following must receive **targeted security
regression testing** (the existing suites in `npm test` cover them):

- `src/server/outboundFetch.ts` (egress boundary)
- `src/server/providerSession.ts` / `src/server/secretBox.ts` (provider session, secret storage)
- `src/app/api/**` (API routes)
- `src/assets/**` upload & processing entry points
- `src/storage/objectStore.ts` (object storage / dev file server)
- project import logic
- CSP / security headers in `next.config.ts`

## Known Limitations (not release blockers)

- Camera / advanced staging is complete for creator language but has no camera
  tools beyond the existing ones; complex staging remains unreliable.
- Generative local editing has never run against a live image-edit provider
  ("working, provider-untested"); one result per Generate; no lasso or pan.
- Some AI provider/model combinations may behave differently (custom provider
  templates are inherently provider-specific).
- Live generation depends on user-provided API/provider availability (BYOK);
  provider refusal may cause individual generation operations to fail.
- No Object-to-hand attachment flow from the UI (puppet attachment system
  exists, no Object→prop UI path).
- The Agent has no `create_interaction` tool yet.
- Assets generated before a pipeline fix keep their old bytes ("Fix
  transparency" rebuilds them).
- No Project Settings surface (lifecycle actions live in the `⋯` menu).
- v0.1 is an Open-Source Preview, not a production-stable 1.0 release.

## Development Freeze Rule

**AI MANGA HARNESS v0.1 IS FROZEN.**

Bugs do not auto-fix. Only these may lift the freeze: P0/P1 security
vulnerability, data loss, project corruption, app cannot start, core generation
completely unavailable, release/install blocker.

Everything else (UX improvement, camera enhancement, provider compatibility
edge cases, new tones/effects/Agent features/workflows, code cleanup,
architecture elegance, performance optimization) goes to the backlog.
