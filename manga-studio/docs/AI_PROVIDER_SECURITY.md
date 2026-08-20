# AI Provider Security

## BYOK key handling (`src/server/secretBox.ts`, `src/server/providerSession.ts`)

Users bring their own API keys through AI Settings. The key travels to the server exactly once (`POST /api/provider/config`), is validated, and is sealed with **AES-256-GCM authenticated encryption** (Node's crypto — no custom cryptography) into an **HttpOnly, SameSite=Lax, Secure-in-production cookie**. From then on:

- browser JavaScript cannot read the credential (HttpOnly) — verified in the E2E by scanning `document.cookie`, `localStorage`, IndexedDB, and the serialized project for the key;
- every AI call goes browser → our server route → decrypt cookie → provider adapter → external API; the raw key never reaches client code;
- `/api/provider/status` returns configuration presence, provider identity, and capabilities — **never the key, not even masked** (unit-tested on the summary builder);
- the API-key input never round-trips the stored secret: once saved it shows "Configured — enter a new key to replace", and saving with an empty key field keeps the stored one;
- **Forget credentials** deletes the cookie; credentials are per-browser-session by design (no accounts were built just for this) and the UI says so;
- tampered or wrong-key ciphertexts decrypt to null (GCM auth tag), so a corrupted cookie degrades to "not configured", never to garbage config.

`APP_ENCRYPTION_KEY` is the one deployment secret this system needs: it encrypts user configs and contains no AI key itself. Production refuses BYOK saves without it; development uses a fixed fallback key (dev cookies never leave the machine).

Deployment env vars (`GEMINI_API_KEY`, `AGENT_API_KEY`, …) remain an **optional operator fallback**; a user's session configuration always overrides them.

Error paths still pass through `redactSecrets()` (configured env values, bearer tokens, `key=` params) before logging or surfacing, and provider error bodies are truncated + redacted.

## SSRF protection (`src/ai/security.ts`)

Configurable endpoints (generic REST base URL, agent base URL) are validated by `assertSafeProviderUrl`:

- https only in production;
- rejects localhost, loopback, RFC-1918 ranges, link-local (`169.254.*` — cloud metadata), IPv6 loopback/ULA/link-local, `.local`, and `metadata.google.internal`;
- `ALLOW_PRIVATE_NETWORKS=1` relaxes this **only** when `NODE_ENV !== "production"` (used by the local E2E harness).

Reference images are only fetched from **our own storage** (`isAllowedReferenceUrl`: the Vercel Blob public host or the local `/api/files/` route). The server never fetches arbitrary user-supplied URLs. Reference fetches have a 15 s timeout and a 10 MB cap.

With BYOK, provider base URLs are user input — every saved endpoint passes `assertSafeProviderUrl` at configuration time and again at adapter construction. Known limitation: hostname-based checks don't resolve DNS, so a public hostname pointing at a private IP (DNS rebinding) isn't caught; accepted for MVP because the request executes from a serverless egress with nothing else reachable on its network, and documented here rather than hidden. `ALLOW_PRIVATE_NETWORKS=1` enables localhost endpoints (Ollama, LM Studio, ComfyUI) in local development only — a hosted Vercel function couldn't reach a user's localhost anyway; future desktop builds can support local models directly.

## Upload validation (`src/storage/imageValidation.ts`)

Uploads are validated by magic bytes (PNG/JPEG/WebP only — filenames and client MIME are untrusted), capped at 8 MB, and dimension-checked client-side (4–8192 px). Stored under generated UUID keys, so user filenames never become storage paths.

## Agent containment

The agent model's output is data, never code: a JSON plan validated per-step against zod schemas (unknown tools and malformed args are rejected). Tools are the only mutation surface; there is no eval, no shell, no arbitrary network access, no env var access. Prompt lengths, panel indices, and text fields are all bounded. See AGENT_ARCHITECTURE.md.

## Error hygiene

`ProviderError.safeMessage` is the only provider-error text that reaches the browser: "Provider not configured", "Authentication failed — check the API key", "Provider rate limit reached", "Generation timed out", "Invalid image response", with any provider body excerpt passed through redaction and truncated.
