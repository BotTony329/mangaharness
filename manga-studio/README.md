# Manga Studio — AI-Native Asset-Based Manga Creation

A browser-based creative studio built on one thesis: **AI creates reusable manga assets; creators compose those assets into manga.** Generation and composition are separate systems, and the creator is always the director.

Think *Figma/Canva + manga editor + AI character studio + AI asset library* — plus a **Manga Agent** that operates the same editor through natural-language prompts.

## What it does

- **Asset library, not one-off images.** Characters are structured collections (poses × expressions), browsable visually. Backgrounds, props, and uploads are first-class reusable assets.
- **Non-destructive panel editor.** A panel is a clipping viewport (Figma-frame semantics). The same full-body character asset becomes a full shot, medium shot, or close-up in different panels through crop modes — with zero new generations. Instances never modify their source asset.
- **Real AI generation.** A provider abstraction with a Google Gemini adapter (reference-image aware, for character-consistent poses/expressions) and a generic OpenAI-compatible REST adapter. All keys stay server-side.
- **Manga Agent.** Prompt → skill-guided plan → validated tool calls → execution through the same editor commands the manual UI uses. Results stay fully editable; one Undo reverts a whole agent run.
- **Persistence & export.** Projects survive refresh (IndexedDB + remote object storage for images); pages export to PNG at 1×/2×.

## Quick start (local)

```bash
npm install
cp .env.example .env.local   # fill in keys — optional; the editor works without AI
npm run dev                  # http://localhost:3000
```

```bash
npm test          # vitest suites (domain, geometry, security, agent)
npm run lint      # eslint
npm run typecheck # tsc --noEmit
npm run build     # production build
```

## Configuration — bring your own API (BYOK)

AI providers are configured **inside the app**: open AI Settings, pick an API standard (OpenAI-compatible / Anthropic-compatible / Gemini for the agent; Gemini / OpenAI-compatible for images), enter base URL + key + model, Test Connection, Save. Credentials are AES-GCM-encrypted into HttpOnly session cookies — never client-readable, never in project data. Replace or forget them anytime; no redeploys.

Deployment env vars (server-side only):

| Variable | Purpose |
|---|---|
| `APP_ENCRYPTION_KEY` | **Required.** Encrypts users' BYOK credentials (contains no AI key itself) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (auto-injected on Vercel) |
| `GEMINI_API_KEY`, `AGENT_API_KEY`, … | *Optional* operator-default providers; user BYOK settings override them |
| `ALLOW_PRIVATE_NETWORKS=1` | Dev only: allow localhost model servers (Ollama, LM Studio) |

Deployment walkthrough: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, data flow, boundaries
- [docs/MVP_SCOPE.md](docs/MVP_SCOPE.md) — what's in, what's deferred
- [docs/EDITOR_MODEL.md](docs/EDITOR_MODEL.md) — source assets vs instances, panel viewport, undo
- [docs/AI_PROVIDER_ARCHITECTURE.md](docs/AI_PROVIDER_ARCHITECTURE.md) — provider abstraction & adapters
- [docs/AI_PROVIDER_SECURITY.md](docs/AI_PROVIDER_SECURITY.md) — key handling, SSRF, redaction
- [docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md) — tools, skills, planner, executor
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — GitHub → Vercel, env vars, storage
- [docs/DECISIONS.md](docs/DECISIONS.md) — architecture decision records
