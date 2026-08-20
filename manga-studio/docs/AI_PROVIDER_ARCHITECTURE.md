# AI Provider Architecture

## The universal provider: Custom API

The harness is not bounded by a vendor catalog. The fundamental provider type is **Custom API** (`src/server/customApi/`): a declarative description — endpoint, method, auth mode, headers, JSON request template with `{{variables}}`, response mapping path, reference-image mode, sync or polling execution — that the executors (`src/ai/providers/customImage.ts`, `src/agent/providers/customAgent.ts`) run against any compatible endpoint. Template rendering is pure substitution (exact-match placeholders inject structured JSON values like `{{messages}}`; inline placeholders interpolate as text; unknown variables are rejected; nothing is ever evaluated), and response mapping is a traversal-only property path. Presets — both the coded adapters below and the "Start from" chips in the Custom form — are conveniences layered on top. Projects reference capabilities, never vendors: switching providers never touches project data.

## Shape

```
Browser (GeneratorDialog / Agent executor)
   ↓ POST /api/generate  { assetType, prompt, referenceUrls?, size }
Server route (validates with zod)
   ↓ src/ai/generate.ts  (loads references from OUR storage only)
   ↓ providerRegistry → ImageGenerationProvider adapter
   ↓ external provider API (key attached server-side)
   ↓ result stored in object storage (Vercel Blob / local dev)
   ← { url, mimeType, provider, model, referenceUsed }
```

The editor never sees provider SDKs, keys, or raw provider responses. Adapters implement:

```ts
interface ImageGenerationProvider {
  id: string; label: string; model: string;
  capabilities: ProviderCapabilities;   // textToImage, referenceImage, …
  testConnection(): Promise<ProviderStatus>;
  generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult>;
}
```

## Implemented adapters

### Gemini (`src/ai/providers/gemini.ts`) — the real provider

- Models: `gemini-2.5-flash-image` by default (override with `IMAGE_MODEL`).
- **Reference images supported natively**: character reference images are sent as `inline_data` parts, which is what powers "generate another pose/expression of the same character". Consistency is provider-dependent and the UI says so — it is never claimed as guaranteed.
- Synchronous request/response; 90 s timeout; bounded response reads.

### Generic REST (`src/ai/providers/genericRest.ts`)

- Any OpenAI-compatible `POST {base}/images/generations` endpoint (`response_format: b64_json`).
- Declares `referenceImage: false` — the UI adapts (no "preserve character" claims) instead of pretending.
- Base URL passes the SSRF guard at construction time.

## Capabilities drive the UI

`/api/provider/status` returns `{ configured, provider, model, capabilities }` (never keys). The generator dialog and agent executor check `capabilities.referenceImage` before attaching references and tell the user which mode they're in.

## Prompt composition

`src/ai/promptTemplates.ts` converts semantic requests (character/pose/expression/background/prop + descriptions) into provider-neutral prompts — creator vocabulary in, provider strings out, in exactly one place. It is isomorphic: the dialog shows a prompt preview with the same code the executor uses.

## Async providers

The current adapters are synchronous. The abstraction leaves room for job-based providers (`asyncGeneration` capability flag); a polling loop would live inside that adapter's `generateImage`, behind the same interface — no editor changes. A full job queue is deliberately not built (YAGNI until a provider requires it).

## Generation rules

1. Results land in the **library** first (with provenance metadata + a Generation History record) — never directly on the canvas.
2. Regeneration never overwrites: same-slot results stack as variations in the character browser.
3. Failures are recorded in Generation History with safe error messages.
