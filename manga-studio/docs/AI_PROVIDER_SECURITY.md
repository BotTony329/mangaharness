# AI Provider Security

## Key handling

All credentials (`GEMINI_API_KEY`, `IMAGE_API_KEY`, `AGENT_API_KEY`, `BLOB_READ_WRITE_TOKEN`) are **server-side environment variables**. They are:

- never sent to the browser (the status endpoint returns configuration presence and capabilities only);
- never stored in React props, client state, Zustand, localStorage, IndexedDB, project JSON, or exports;
- never logged — error paths pass through `redactSecrets()` (strips configured key values, bearer tokens, and `key=` query params) before anything is logged or surfaced;
- never committed — `.gitignore` excludes every `.env*` except `.env.example`, which contains names only.

The architecture is strictly `Browser → our server API → provider adapter → external API`. There is no browser-side provider call anywhere.

## No temporary key input

The optional "paste a key in the UI" idea was **deliberately not built**: any browser-entered credential path either touches client persistence or requires server session state that Vercel's serverless model doesn't provide safely. Production configuration is Vercel environment variables; local testing uses `.env.local` (gitignored) or the fake-provider scripts. This follows the spec's instruction to prefer no feature over a weak one.

## SSRF protection (`src/ai/security.ts`)

Configurable endpoints (generic REST base URL, agent base URL) are validated by `assertSafeProviderUrl`:

- https only in production;
- rejects localhost, loopback, RFC-1918 ranges, link-local (`169.254.*` — cloud metadata), IPv6 loopback/ULA/link-local, `.local`, and `metadata.google.internal`;
- `ALLOW_PRIVATE_NETWORKS=1` relaxes this **only** when `NODE_ENV !== "production"` (used by the local E2E harness).

Reference images are only fetched from **our own storage** (`isAllowedReferenceUrl`: the Vercel Blob public host or the local `/api/files/` route). The server never fetches arbitrary user-supplied URLs. Reference fetches have a 15 s timeout and a 10 MB cap.

Known limitation: hostname-based checks don't resolve DNS, so a public hostname pointing at a private IP isn't caught. Mitigated by the reference allow-list (the only server-side fetch of non-configured URLs) and by provider URLs being deploy-time configuration, not user input.

## Upload validation (`src/storage/imageValidation.ts`)

Uploads are validated by magic bytes (PNG/JPEG/WebP only — filenames and client MIME are untrusted), capped at 8 MB, and dimension-checked client-side (4–8192 px). Stored under generated UUID keys, so user filenames never become storage paths.

## Agent containment

The agent model's output is data, never code: a JSON plan validated per-step against zod schemas (unknown tools and malformed args are rejected). Tools are the only mutation surface; there is no eval, no shell, no arbitrary network access, no env var access. Prompt lengths, panel indices, and text fields are all bounded. See AGENT_ARCHITECTURE.md.

## Error hygiene

`ProviderError.safeMessage` is the only provider-error text that reaches the browser: "Provider not configured", "Authentication failed — check the API key", "Provider rate limit reached", "Generation timed out", "Invalid image response", with any provider body excerpt passed through redaction and truncated.
