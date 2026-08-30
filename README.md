<p align="center">
  <img src="manga-studio/public/brand/kumanga-mark.svg#gh-light-mode-only" width="88" alt="Kumanga mark">
  <img src="manga-studio/public/brand/kumanga-mark-dark.svg#gh-dark-mode-only" width="88" alt="Kumanga mark">
</p>

# Kumanga — Open-Source, Local-First AI Manga Studio

**Kumanga is a free, open-source (MIT) AI manga creator that runs in your own
browser.** AI generates *reusable* assets — characters, poses, expressions,
backgrounds — a non-destructive editor composes them into manga pages, and a
natural-language **Manga Agent** can build whole panels for you. Bring your own
API key (BYOK); there is no account, no cloud lock-in, and no bundled model.

*Kuma* (bear) + *manga*. Created and maintained by
**[BotTony329](https://github.com/BotTony329)**.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v0.1%20freeze-8A2BE2)](docs/RELEASE_FREEZE_V0.1.md)
[![Tests](https://img.shields.io/badge/tests-991%2F991%20pass-brightgreen)](docs/RELEASE_FREEZE_V0.1.md)
[![Stack](https://img.shields.io/badge/Next.js%2015-TypeScript%205-black)](manga-studio/)

**[🌐 Website](https://kumanga-website.vercel.app/)** ·
**[🎬 Try the live studio](https://mangaharness.vercel.app)** ·
**[📚 Studio docs](manga-studio/README.md)** ·
**[🏛 Architecture](ARCHITECTURE.md)**

---

## What is Kumanga?

Kumanga is an AI manga harness built on one thesis: **AI creates reusable manga
assets; the creator composes those assets into manga.** Generation and
composition are separate systems, and you are always the director. Think
*Figma/Canva + manga editor + AI character studio + AI asset library* — plus a
Manga Agent that operates the same editor through natural-language prompts.

- **Stack**: Next.js 15 · React 19 · TypeScript 5 · npm workspaces
- **Status**: v0.1 open-source preview, release-frozen 2026-08-22 —
  991/991 tests, 98/98 security tests, `npm audit` clean
  ([freeze report](docs/RELEASE_FREEZE_V0.1.md))
- **License**: MIT (keep [`NOTICE.md`](NOTICE.md) attribution on forks)

## Why not just prompt an image generator?

Because one-off images don't make a manga. A 20-page chapter needs the *same*
character, on-model, from panel to panel — plus framing, staging and dialogue
you control. Kumanga treats AI output as an **asset library, not a slot
machine**:

| Need | Generic image AI | Kumanga |
|---|---|---|
| Same character every panel | Re-prompt and pray | Reusable character assets — structured **poses × expressions** collections, reference-image-aware generation |
| Full shot → close-up | New generation each time | **Crop modes**: one full-body asset becomes a full, medium or close-up shot with **zero new generations** |
| Framing & staging | Not supported | Non-destructive panel editor (Figma-frame semantics); instances never modify their source asset |
| Whole-page help | — | **Manga Agent**: natural language → plan → validated tool calls → an editable page |
| Where it runs | Vendor cloud | Your machine (`localhost` out of the box); optional self-deploy |
| Cost & lock-in | Subscription | MIT, free, your own keys |

## What can it do?

- **Asset library, not one-off images.** Characters are structured collections
  (poses × expressions), browsable visually. Backgrounds, props and uploads are
  first-class reusable assets.
- **Non-destructive panel editor.** A panel is a clipping viewport; crop modes
  re-frame assets without new generations; instances never modify their source.
- **Real AI generation.** A provider abstraction with a Google Gemini adapter
  (reference-image aware, for character-consistent poses and expressions) and a
  generic OpenAI-compatible REST adapter.
- **Manga Agent.** Prompt → skill-guided plan → validated tool calls →
  execution through the same editor commands the manual UI uses.
- **Persistence & export.** Projects survive refresh (IndexedDB + remote object
  storage for images); pages export to PNG at 1× / 2×.

## How does the Manga Agent work?

You describe the page in plain language; the agent returns a finished,
fully-editable page region. The LLM acts as a creative director while code alone
owns state, identity and execution: prompts pass through a literal lock, one
server-side planning call, structural and semantic validation, project
resolution (names bound to real IDs), and a transactional executor with
rollback. Because agent runs go through ordinary editor commands, **one Undo
reverts a whole agent run** and every result stays hand-editable. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the full pipeline.

## Which AI providers does it support? (BYOK)

Kumanga never ships a model key. Open **AI Settings** inside the app, pick a
standard, enter base URL + key + model, Test Connection, Save:

| Surface | Supported standards |
|---|---|
| Image generation | SD.Next (`/sdapi/v1/txt2img`, `/sdapi/v1/img2img`, reference-image aware) · Google Gemini (reference-image aware) · any OpenAI-compatible REST endpoint |
| Background removal | SD.Next (`/sdapi/v1/extra-single-image` rembg) · remove.bg · Custom JSON cutout API |
| Manga Agent | OpenAI-compatible · Anthropic-compatible · Gemini |

Credentials are AES-GCM-encrypted into HttpOnly session cookies — never
client-readable, never stored in project data. Replace or forget them any time,
no redeploys.

## Is my data private?

Yes — Kumanga is local-first. Projects, assets and generated images live in
your browser storage (IndexedDB, plus object storage for images when you deploy
it), not in our cloud. There is no account system. Everything works on
`localhost` out of the box; deploying to Vercel is optional, never required.
The deployment surface is audited: SSRF/redirect/size caps, object-storage
traversal and provider-session security all have dedicated test suites
(98/98 passing at the v0.1 freeze).

## Quick start

Requires Node.js 18.18+ (20+ LTS recommended for Next.js 15).

```bash
git clone https://github.com/BotTony329/mangaharness.git
cd mangaharness
npm install
cp .env.example .env.local   # optional — the editor works without any AI key
npm run dev                  # http://localhost:3000
```

No registration, no account, no cloud setup. To use AI, add your own key in
**AI Settings** inside the app.

| Command | What it does |
|---|---|
| `npm run dev` | Start the studio at localhost |
| `npm run build` / `npm start` | Production build / serve it |
| `npm test` | Full test suite (domain, geometry, security, agent) |
| `npm run typecheck` / `npm run lint` | Static gates |

## FAQ

### Is Kumanga free?

Yes. Kumanga is open source under the MIT license — clone it, run it, fork it.
You supply your own AI API keys (BYOK), so there is no Kumanga subscription and
no bundled model. If you fork or reuse it, keep the attribution in
[`NOTICE.md`](NOTICE.md) intact.

### Do I need an account or an API key to try it?

No account, ever. The editor itself works with **no AI key at all** — you can
compose pages and explore the studio first. When you want AI generation or the
Manga Agent, open AI Settings and connect your own provider key.

### Where do my projects and API keys live?

Projects and assets live in your browser's IndexedDB (with object storage for
images on deployments); they survive refresh and never leave your environment
unless you deploy your own instance. API keys are AES-GCM-encrypted into
HttpOnly session cookies — they are never client-readable and never written
into project data, so exports and shares don't leak credentials.

### Can I keep a character consistent across panels?

That is the core design. Characters are structured collections of poses ×
expressions, and the Gemini adapter is reference-image aware: it generates new
poses and expressions *from* your existing character assets instead of
re-rolling from scratch. Framing changes (full / medium / close-up) don't
require any generation at all — crop modes re-frame the same asset.

### What if I don't like what the Manga Agent did?

Undo once. Agent runs execute through the same editor commands as the manual
UI, inside a transaction — a single Undo reverts the entire run, and everything
the agent produced remains fully hand-editable afterwards.

### How do I export my manga?

Pages export to PNG at 1× or 2× resolution. Project data stays in your local
storage, so you keep everything — projects, assets and generated images — even
if you stop using the app.

### Can I deploy Kumanga instead of running it locally?

Yes, deploying (e.g. to Vercel) is optional and fully self-serve. Set
`APP_ENCRYPTION_KEY` (encrypts users' BYOK credentials — it contains no AI key
itself) and optionally `BLOB_READ_WRITE_TOKEN`; users' own BYOK settings
override any operator-default providers. A reference deployment runs at
[mangaharness.vercel.app](https://mangaharness.vercel.app).

### What is the current status of the project?

v0.1 open-source preview, release-frozen on 2026-08-22 with a published
baseline: 991/991 tests passing, 98/98 security tests, clean typecheck, lint
and build, and zero `npm audit` vulnerabilities. Known-good baseline and
architecture notes: [docs/RELEASE_FREEZE_V0.1.md](docs/RELEASE_FREEZE_V0.1.md)
and [ARCHITECTURE.md](ARCHITECTURE.md).

## Repository layout

- `manga-studio/` — the Next.js app (editor core, agent, services, API routes).
  See the [studio README](manga-studio/README.md) for configuration details.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — module boundaries and the agent
  pipeline.
- [`docs/RELEASE_FREEZE_V0.1.md`](docs/RELEASE_FREEZE_V0.1.md) — the v0.1
  known-good baseline.

## License & attribution

Kumanga is MIT-licensed and built by **BotTony329**. If you fork or reuse it,
keep the attribution ([`NOTICE.md`](NOTICE.md)) intact.
