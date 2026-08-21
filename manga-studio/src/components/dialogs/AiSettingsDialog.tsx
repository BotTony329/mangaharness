"use client";

/**
 * Bring-your-own-key AI settings: users connect their own agent LLM and
 * image provider directly here — no environment variables, no redeploy.
 * Keys go to the server once, come back never (encrypted HttpOnly cookie);
 * this dialog only ever sees "configured / not configured".
 */

import { useCallback, useEffect, useState } from "react";
import { useUiStore } from "@/editor/uiStore";
import {
  CloseIcon,
  DoneIcon,
  HiddenIcon,
  ICON_SIZE,
  ICON_SIZE_SM,
  ICON_STROKE,
  PendingIcon,
  VisibleIcon,
} from "../ui/icons";
import {
  CustomProviderForm,
  customPayloadFromForm,
  emptyCustomForm,
  type CustomFormState,
} from "./CustomProviderForm";

interface ProviderSummary {
  configured: boolean;
  source?: "session" | "deployment";
  providerType?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  custom?: Record<string, unknown>;
}

interface StatusResponse {
  agent: ProviderSummary;
  image: ProviderSummary & { capabilities?: Record<string, boolean> };
  background: ProviderSummary;
}

/**
 * Protocol-first: these are API STANDARDS, not a vendor list. Any provider
 * name, any base URL — the protocol alone decides runtime behaviour. "Custom
 * JSON" is one of the standards, not a separate mode.
 */
const AGENT_PROTOCOLS = [
  { id: "openai-compatible", label: "OpenAI-compatible", placeholder: "https://api.deepseek.com/v1" },
  { id: "anthropic-compatible", label: "Anthropic Messages", placeholder: "https://api.anthropic.com" },
  { id: "gemini", label: "Gemini Native", placeholder: "https://generativelanguage.googleapis.com" },
  { id: "custom", label: "Custom JSON", placeholder: "https://example.com/v1/generate" },
];

const IMAGE_PROTOCOLS = [
  { id: "gemini", label: "Gemini Native", placeholder: "https://generativelanguage.googleapis.com" },
  { id: "openai-compatible", label: "OpenAI-compatible", placeholder: "https://api.example.com/v1" },
  { id: "custom", label: "Custom JSON", placeholder: "https://example.com/v1/generate" },
];

const BACKGROUND_PROTOCOLS = [
  { id: "remove-bg", label: "remove.bg", placeholder: "https://api.remove.bg/v1.0/removebg" },
  { id: "custom", label: "Custom JSON", placeholder: "https://example.com/cutout" },
];

export function AiSettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  const close = useUiStore((s) => s.closeSettings);
  const [status, setStatus] = useState<StatusResponse | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/provider/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center overflow-y-auto bg-black/60 py-6" onMouseDown={close}>
      <div
        className="w-[520px] max-h-[92vh] overflow-y-auto rounded-lg bg-[var(--bg-elevated)] p-4 text-sm shadow-2xl shadow-black/50"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-semibold text-zinc-100">AI Providers</h2>
          <button
            aria-label="Close settings"
            title="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            onClick={close}
          >
            <CloseIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </button>
        </div>
        <p className="mb-4 text-xs leading-5 text-zinc-500">
          Bring your own API. You only need to know which standard your provider speaks — then paste its address, key
          and model. Any provider name works; the standard decides how Kumanga talks to it. Credentials are encrypted
          and stored for this browser session only.
        </p>

        <ProviderCard
          kind="agent"
          title="Manga Agent (LLM)"
          protocols={AGENT_PROTOCOLS}
          summary={status?.agent ?? null}
          onChanged={refresh}
          supportsModelDiscovery
        />
        <ProviderCard
          kind="image"
          title="Image Generation"
          protocols={IMAGE_PROTOCOLS}
          summary={status?.image ?? null}
          onChanged={refresh}
          footnote={
            status?.image?.configured
              ? (status.image.capabilities?.supportsReferenceImage ?? status.image.capabilities?.referenceImage)
                ? "This provider supports reference images — character identity can be carried into pose/expression generation (provider-dependent, never guaranteed)."
                : "This provider does not support reference images: identity preservation relies on text descriptions only."
              : undefined
          }
        />
        <BackgroundRemovalCard summary={status?.background ?? null} onChanged={refresh} />
      </div>
    </div>
  );
}

/**
 * Background removal is a FALLBACK, not a third provider to configure.
 *
 * The primary path needs no setup at all: foreground assets are generated on
 * pure white and the built-in extractor cuts them out. A removal API is only
 * ever consulted when that fails — and only if the creator chose to connect
 * one here.
 */
function BackgroundRemovalCard({ summary, onChanged }: { summary: ProviderSummary | null; onChanged: () => void }) {
  const configured = summary?.configured ?? false;
  const [configuring, setConfiguring] = useState(false);
  return (
    <section className="mb-4 rounded-md p-3" style={{ background: "var(--bg-elevated)" }}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">Background Removal</h3>
        <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--success)" }}>
          <DoneIcon size={12} strokeWidth={2} />
          Built-in
        </span>
      </div>
      <p className="mb-2 text-[11px] leading-4 text-zinc-500">
        <span className="text-zinc-400">Primary:</span> built-in white-background extraction — always on, nothing to
        configure.
      </p>
      <p className="mb-2 text-[11px] leading-4 text-zinc-500">
        <span className="text-zinc-400">Fallback:</span>{" "}
        {configured
          ? `${summary?.name || summary?.providerType || "custom"} — used only if built-in extraction fails`
          : "none — if extraction fails, you get a repair prompt instead"}
      </p>
      {!configuring && (
        <button
          className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700"
          onClick={() => setConfiguring(true)}
        >
          {configured ? "Edit fallback" : "Configure fallback (optional)"}
        </button>
      )}
      {configuring && (
        <div className="mt-2 border-t border-zinc-800 pt-2">
          <ProviderCard kind="background" title="Fallback provider" protocols={BACKGROUND_PROTOCOLS} summary={summary} onChanged={onChanged} />
          <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setConfiguring(false)}>
            Collapse
          </button>
        </div>
      )}
    </section>
  );
}

// ─── One provider configuration card ────────────────────────────────────────

interface ProviderCardProps {
  kind: "agent" | "image" | "background";
  title: string;
  protocols: { id: string; label: string; placeholder: string }[];
  summary: ProviderSummary | null;
  onChanged: () => void;
  supportsModelDiscovery?: boolean;
  footnote?: string;
}

function ProviderCard({ kind, title, protocols, summary, onChanged, supportsModelDiscovery, footnote }: ProviderCardProps) {
  const simpleProtocols = protocols.filter((p) => p.id !== "custom");
  const [customForm, setCustomForm] = useState<CustomFormState>(() => emptyCustomForm(kind));
  const [providerType, setProviderType] = useState(simpleProtocols[0].id);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState(kind === "background" ? "background-removal" : "");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"save" | "test" | "forget" | "models" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const isCustom = providerType === "custom";

  // Prefill the form from the saved summary once (never the key — the server
  // doesn't return it; an empty key field means "keep the stored key").
  useEffect(() => {
    if (!summary || hydrated) return;
    if (summary.configured) {
      if (summary.providerType === "custom" && summary.custom) {
        setProviderType("custom");
        setCustomForm(hydrateCustomForm(kind, summary));
      } else {
        setProviderType(summary.providerType ?? simpleProtocols[0].id);
        setName(summary.name ?? "");
        setBaseUrl(summary.baseUrl ?? "");
        setModel(summary.model ?? "");
      }
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, hydrated, kind]);

  const typeInfo = protocols.find((t) => t.id === providerType) ?? protocols[0];
  const configured = summary?.configured ?? false;
  const canSave = isCustom
    ? Boolean(customForm.endpoint && customForm.model && (configured || customForm.apiKey || customForm.authMode === "none"))
    : Boolean((kind === "background" || model) && (configured || apiKey));

  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      const payload = isCustom
        ? {
            kind,
            providerType: "custom",
            name: customForm.name || undefined,
            baseUrl: customForm.endpoint,
            apiKey: customForm.apiKey || undefined,
            model: customForm.model,
            custom: customPayloadFromForm(kind, customForm),
          }
        : {
            kind,
            providerType,
            name: name || undefined,
            baseUrl: baseUrl || undefined,
            // Empty field + already configured = keep the stored key.
            apiKey: apiKey || undefined,
            model: model || (kind === "background" ? "background-removal" : ""),
          };
      const response = await fetch("/api/provider/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Save failed");
      setApiKey("");
      setCustomForm((f) => ({ ...f, apiKey: "" }));
      setMessage({ ok: true, text: "Saved. Credentials are stored securely for this browser session." });
      onChanged();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    setPreview(null);
    try {
      const response = await fetch("/api/provider/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const body = await response.json();
      setMessage(
        body.ok
          ? { ok: true, text: body.detail ? `Connected — ${body.detail.replace(/^Connected( — )?/, "")}` : "Connected" }
          : { ok: false, text: body.error ?? "Connection failed" },
      );
      if (body.preview) setPreview(body.preview);
    } catch {
      setMessage({ ok: false, text: "Endpoint unreachable" });
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    if (!confirm(`Forget the ${title} credentials for this browser?`)) return;
    setBusy("forget");
    await fetch(`/api/provider/config?kind=${kind}`, { method: "DELETE" });
    setApiKey("");
    setModel("");
    setName("");
    setBaseUrl("");
    setMessage({ ok: true, text: "Credentials forgotten." });
    setBusy(null);
    onChanged();
  };

  const fetchModels = async () => {
    setBusy("models");
    try {
      const response = await fetch("/api/provider/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const body = await response.json();
      setModels(Array.isArray(body.models) ? body.models : []);
      if (!body.models?.length) setMessage({ ok: false, text: "This provider doesn't expose a model list — enter the model ID manually." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-4 rounded-md p-3" style={{ background: "var(--bg-elevated)" }}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">{title}</h3>
        <span
          className="flex items-center gap-1.5 text-xs"
          style={{ color: configured ? "var(--success)" : "var(--text-muted)" }}
        >
          {configured ? <DoneIcon size={12} strokeWidth={2} /> : <PendingIcon size={12} strokeWidth={2} />}
          {configured ? `Connected${summary?.source === "deployment" ? " (deployment default)" : ""}` : "Not configured"}
        </span>
      </div>

      {/*
        One simple setup: pick the API STANDARD, name the provider anything,
        paste address, key, model. "Custom JSON" is one of the standards and is
        the only one that unfolds the request/response mapping.
      */}
      <div className="grid grid-cols-2 gap-2">
        <Field label="API standard / protocol">
          <select
            className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5"
            value={providerType}
            onChange={(e) => {
              setProviderType(e.target.value);
              setBaseUrl("");
              setModels([]);
              if (kind === "background") setModel("background-removal");
            }}
          >
            {protocols.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Provider name (any label)">
          <input
            className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Kimi, MiniMax, OpenRouter, My Gateway…"
          />
        </Field>
      </div>

      {isCustom ? (
        <details className="mb-2" open>
          <summary className="mb-2 cursor-pointer text-[10px] uppercase tracking-wider text-zinc-500">
            Advanced API mapping
          </summary>
          <CustomProviderForm kind={kind} form={customForm} configured={configured} onChange={setCustomForm} />
        </details>
      ) : (
        <>
          <Field label="Base URL">
            <input
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 font-mono text-xs"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={typeInfo.placeholder}
            />
          </Field>

          <Field label="API key">
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 pr-9 font-mono text-xs"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={configured ? "Configured — enter a new key to replace" : "sk-…"}
                autoComplete="off"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                onClick={() => setShowKey(!showKey)}
                title={showKey ? "Hide key" : "Show key while typing"}
                aria-label={showKey ? "Hide key" : "Show key while typing"}
              >
                {showKey ? (
                  <HiddenIcon size={ICON_SIZE_SM} strokeWidth={ICON_STROKE} />
                ) : (
                  <VisibleIcon size={ICON_SIZE_SM} strokeWidth={ICON_STROKE} />
                )}
              </button>
            </div>
          </Field>

          {kind !== "background" && <Field label="Model">
            <div className="flex gap-2">
              <input
                className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 font-mono text-xs"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="model-name"
                list={models.length > 0 ? `${kind}-models` : undefined}
              />
              {supportsModelDiscovery && providerType === "openai-compatible" && configured && (
                <button
                  className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-2 text-xs hover:bg-zinc-700"
                  onClick={fetchModels}
                  disabled={busy !== null}
                  title="Fetch the provider's model list (optional)"
                >
                  {busy === "models" ? "…" : "Fetch models"}
                </button>
              )}
            </div>
            {models.length > 0 && (
              <datalist id={`${kind}-models`}>
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
          </Field>}
        </>
      )}

      <div className="mt-2 flex items-center gap-2">
        <button
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--accent-hover)] disabled:opacity-40"
          onClick={save}
          disabled={busy !== null || !canSave}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button
          className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700 disabled:opacity-40"
          onClick={test}
          disabled={busy !== null || !configured}
          title={
            !configured
              ? "Save first, then test"
              : (kind === "image" || kind === "background") && summary?.providerType === "custom"
                ? "Runs one real minimal generation to verify the mapping"
                : "Round-trip to the provider"
          }
        >
          {busy === "test" ? "Testing…" : "Test Connection"}
        </button>
        <div className="flex-1" />
        {configured && summary?.source === "session" && (
          <button className="text-xs text-zinc-500 hover:text-red-400" onClick={forget} disabled={busy !== null}>
            Forget credentials
          </button>
        )}
      </div>

      {message && (
        <p className={`mt-2 text-xs ${message.ok ? "text-emerald-400" : "text-red-400"}`}>{message.text}</p>
      )}
      {preview && (
        <details className="mt-2 rounded-md bg-[var(--bg-elevated)] p-2">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-zinc-500">
            Request preview (secrets redacted)
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-zinc-400">
            {`${preview.method} ${preview.url}\n` +
              Object.entries((preview.headers as Record<string, string>) ?? {})
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n") +
              `\n\n${JSON.stringify(preview.body, null, 2)}`}
          </pre>
        </details>
      )}
      {footnote && <p className="mt-2 text-[11px] leading-4 text-zinc-500">{footnote}</p>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

/** Rebuild the custom form from a saved (non-secret) summary for re-editing. */
function hydrateCustomForm(kind: "agent" | "image" | "background", summary: ProviderSummary): CustomFormState {
  const base = emptyCustomForm(kind);
  const custom = (summary.custom ?? {}) as Record<string, never>;
  const auth = (custom.auth ?? {}) as { mode?: string; header?: string };
  const response = (custom.response ?? {}) as { type?: string; path?: string };
  const polling = (custom.polling ?? {}) as Record<string, string>;
  return {
    ...base,
    name: summary.name ?? "",
    endpoint: summary.baseUrl ?? "",
    model: summary.model ?? "",
    method: (custom.method as "POST" | "GET") ?? base.method,
    authMode: (auth.mode as CustomFormState["authMode"]) ?? base.authMode,
    authHeader: auth.header ?? base.authHeader,
    headers: (custom.headers as { name: string; value: string }[]) ?? [],
    requestTemplate: (custom.requestTemplate as string) ?? base.requestTemplate,
    responseType: (response.type as "url" | "base64") ?? base.responseType,
    responsePath: response.path ?? base.responsePath,
    referenceMode: (custom.referenceMode as CustomFormState["referenceMode"]) ?? base.referenceMode,
    execution: (custom.execution as "sync" | "async") ?? base.execution,
    polling: { ...base.polling, ...polling },
    responseTextPath: (custom.responseTextPath as string) ?? base.responseTextPath,
  };
}
