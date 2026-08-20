# Deployment (GitHub → Vercel)

## 1. Push to GitHub

```bash
cd manga-studio
git init            # already done if you received this repo with .git
git add -A
git commit -m "Manga Studio MVP"
gh repo create manga-studio --private --source . --push
# or: create an empty repo on github.com, then
git remote add origin git@github.com:<you>/manga-studio.git
git push -u origin main
```

`.gitignore` already excludes `.env*` (except `.env.example`), `.data/`, and build output. Nothing secret is in the repo.

## 2. Import into Vercel

1. vercel.com → **Add New → Project** → import the GitHub repo.
2. Framework preset: **Next.js** (auto-detected). No build settings need changing.
3. Deploy once — the app runs immediately; AI features stay disabled until you add keys.

## 3. Connect persistent storage (required for generated images)

1. Project → **Storage** → **Create Database → Blob**.
2. Connect it to the project. Vercel injects `BLOB_READ_WRITE_TOKEN` automatically.
3. Redeploy. (Without Blob, image uploads/generations fail loudly on Vercel — the local `.data/` fallback is dev-only by design.)

## 4. Set the one required app secret

Project → **Settings → Environment Variables** (Production):

| Name | Value |
|---|---|
| `APP_ENCRYPTION_KEY` | a long random string, e.g. `openssl rand -base64 32` |

This encrypts users' BYOK provider credentials into HttpOnly session cookies. It is **not** an AI API key. Redeploy after adding it.

## 5. AI providers are configured IN THE APP (BYOK)

No AI keys go into Vercel. Each user opens **AI Settings** in the deployed app and connects their own providers:

- **Manga Agent (LLM):** pick an API standard (OpenAI Compatible / Anthropic Compatible / Google Gemini), enter base URL, API key, and model — e.g. DeepSeek, Kimi/Moonshot, OpenRouter, Claude, Gemini, or any compatible gateway.
- **Image Generation:** Google Gemini (supports reference images for character consistency) or any OpenAI-compatible image endpoint.

Test Connection, Save — done. Credentials are encrypted per browser session; "Forget credentials" removes them. Replacing an endpoint/key/model later needs no redeploy and doesn't touch projects.

*(Optional operator fallback: the old `GEMINI_API_KEY` / `AGENT_API_KEY` env vars still work as deployment-wide defaults, but any user's own AI Settings override them.)*

## 6. Verify after deployment

1. Open the app → **AI Settings** → enter your agent + image providers → **Test Connection** on both → Save.
2. Create a character → *Create & Generate* → a real image should arrive and enter the library.
3. Run the acceptance flow: agent prompt → compose → edit → save → refresh → export PNG.
4. Storage should read `vercel-blob` in AI Settings' status (via the API) — if uploads fail, the Blob store isn't connected.

## Local development

```bash
npm install
npm run dev                # editor works with zero configuration
```

- With no env vars: full editor, uploads to `./.data`, AI disabled with clear status.
- With real keys in `.env.local`: real generation locally.
- With fake providers (no keys needed): `node scripts/fake-providers.mjs &` plus the `.env.local` values shown in that script's header comment, then `node scripts/e2e.mjs` runs the whole acceptance loop headlessly.

Production build locally: `npm run build && npm start`.
