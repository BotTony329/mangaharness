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

## 4. Configure the image-generation provider

Project → **Settings → Environment Variables** (Production; add to Preview if you want):

| Name | Value |
|---|---|
| `IMAGE_PROVIDER` | `gemini` |
| `GEMINI_API_KEY` | your Google AI Studio key (aistudio.google.com → Get API key) |
| `IMAGE_MODEL` | *(optional)* defaults to `gemini-2.5-flash-image` |

For an OpenAI-compatible gateway instead: `IMAGE_PROVIDER=generic-rest`, `IMAGE_API_BASE_URL=https://…/v1`, `IMAGE_API_KEY=…`, `IMAGE_MODEL=…`. Note the generic adapter cannot send character reference images.

## 5. Configure the Manga Agent LLM

| Name | Value |
|---|---|
| `AGENT_API_KEY` | your DeepSeek key (platform.deepseek.com) |
| `AGENT_API_BASE_URL` | *(optional)* defaults to `https://api.deepseek.com` |
| `AGENT_MODEL` | *(optional)* defaults to `deepseek-chat` |

Any OpenAI-compatible chat-completions endpoint with JSON-mode support works.

**Redeploy after adding variables** (env changes need a new deployment).

## 6. Verify after deployment

1. Open the app → **AI Settings** — both providers should show *Configured*, storage `vercel-blob`.
2. Click **Test Connection** — performs a real round-trip to the image provider.
3. Create a character → *Create & Generate* → a real image should arrive and enter the library.
4. Run the acceptance flow: agent prompt → compose → edit → save → refresh → export PNG.

## Local development

```bash
npm install
npm run dev                # editor works with zero configuration
```

- With no env vars: full editor, uploads to `./.data`, AI disabled with clear status.
- With real keys in `.env.local`: real generation locally.
- With fake providers (no keys needed): `node scripts/fake-providers.mjs &` plus the `.env.local` values shown in that script's header comment, then `node scripts/e2e.mjs` runs the whole acceptance loop headlessly.

Production build locally: `npm run build && npm start`.
