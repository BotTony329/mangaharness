# Kumanga

A local-first, bring-your-own-key manga creation harness: characters, panels,
camera, dialogue, tone, interactions and a natural-language Manga Agent — all
in one editor that runs entirely on your machine.

Created and maintained by **[BotTony329](https://github.com/BotTony329)**.

## Quick Start

```bash
git clone https://github.com/BotTony329/mangaharness.git
cd mangaharness
npm install
npm run dev
```

Open http://localhost:3000 — no registration, no account, no cloud setup.

## Your keys, your model

Kumanga never ships a model key. Open **Settings** inside the app and connect
any compatible image/agent provider with your own API key (BYOK). Keys are
held in your local session and used only for your own generations.

## Local-first

- Projects, assets and generated images live on your machine (`.data/`), not
  in our cloud.
- Everything works on `localhost` out of the box; deploying to Vercel is
  optional, never required.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the studio at localhost |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm test` | Full test suite |
| `npm run typecheck` / `npm run lint` | Static gates |

## Repository layout

- `manga-studio/` — the Next.js app (editor core, agent, services, API routes).

See `ARCHITECTURE.md` for the module boundaries and `NOTICE.md` for credits.

## License & attribution

Kumanga is built by BotTony329. If you fork or reuse it, keep the attribution
(`NOTICE.md`) intact.
