"use client";

/**
 * Custom API configuration — the universal provider form. Users describe an
 * arbitrary AI API declaratively (endpoint, auth, headers, request template,
 * response mapping, optional polling); presets only prefill these editable
 * fields. Everything stays data: no code is ever accepted.
 */

import { useState } from "react";
import { CloseIcon, HiddenIcon, ICON_SIZE_SM, ICON_STROKE, VisibleIcon } from "../ui/icons";

export interface CustomFormState {
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  method: "POST" | "GET";
  authMode: "none" | "bearer" | "header";
  authHeader: string;
  headers: { name: string; value: string }[];
  requestTemplate: string;
  // image
  responseType: "url" | "base64";
  responsePath: string;
  referenceMode: "none" | "url" | "base64";
  execution: "sync" | "async";
  polling: {
    taskIdPath: string;
    statusUrlTemplate: string;
    statusPath: string;
    completedValue: string;
    failedValue: string;
    resultPath: string;
  };
  // agent
  responseTextPath: string;
}

export function emptyCustomForm(kind: "agent" | "image" | "background"): CustomFormState {
  return {
    name: "",
    endpoint: "",
    apiKey: "",
    model: kind === "background" ? "background-removal" : "",
    method: "POST",
    authMode: "bearer",
    authHeader: "x-api-key",
    headers: [],
    requestTemplate:
      kind !== "agent"
        ? '{\n  "model": "{{model}}",\n  "prompt": "{{prompt}}",\n  "width": "{{width}}",\n  "height": "{{height}}"\n}'
        : '{\n  "model": "{{model}}",\n  "messages": "{{messages}}",\n  "temperature": "{{temperature}}"\n}',
    responseType: "url",
    responsePath: "data[0].url",
    referenceMode: kind === "background" ? "base64" : "none",
    execution: "sync",
    polling: {
      taskIdPath: "task_id",
      statusUrlTemplate: "https://api.example.com/tasks/{{taskId}}",
      statusPath: "status",
      completedValue: "SUCCESS",
      failedValue: "FAILED",
      resultPath: "output.image_url",
    },
    responseTextPath: "choices[0].message.content",
  };
}

/** Starting points that prefill the editable fields — convenience, not logic. */
const PRESETS: Record<"agent" | "image" | "background", { label: string; apply: (f: CustomFormState) => CustomFormState }[]> = {
  agent: [
    {
      label: "OpenAI-style chat",
      apply: (f) => ({
        ...f,
        endpoint: f.endpoint || "https://api.example.com/v1/chat/completions",
        authMode: "bearer",
        requestTemplate:
          '{\n  "model": "{{model}}",\n  "messages": "{{messages}}",\n  "response_format": { "type": "json_object" },\n  "temperature": "{{temperature}}"\n}',
        responseTextPath: "choices[0].message.content",
      }),
    },
    {
      label: "Anthropic-style messages",
      apply: (f) => ({
        ...f,
        endpoint: f.endpoint || "https://api.anthropic.com/v1/messages",
        authMode: "header",
        authHeader: "x-api-key",
        headers: [{ name: "anthropic-version", value: "2023-06-01" }],
        requestTemplate:
          '{\n  "model": "{{model}}",\n  "max_tokens": 8192,\n  "system": "{{systemPrompt}}",\n  "messages": [ { "role": "user", "content": "{{userPrompt}}" } ]\n}',
        responseTextPath: "content[0].text",
      }),
    },
  ],
  image: [
    {
      label: "SD.Next txt2img",
      apply: (f) => ({
        ...f,
        endpoint: f.endpoint || "http://127.0.0.1:7860/sdapi/v1/txt2img",
        authMode: "none",
        requestTemplate:
          '{\n  "prompt": "{{prompt}}",\n  "negative_prompt": "{{negativePrompt}}",\n  "width": {{width}},\n  "height": {{height}},\n  "steps": 20,\n  "cfg_scale": 7.0,\n  "sampler_name": "UniPC",\n  "save_images": false,\n  "send_images": true\n}',
        responseType: "base64",
        responsePath: "images[0]",
        referenceMode: "none",
      }),
    },
    {
      label: "OpenAI-style images",
      apply: (f) => ({
        ...f,
        endpoint: f.endpoint || "https://api.example.com/v1/images/generations",
        authMode: "bearer",
        requestTemplate:
          '{\n  "model": "{{model}}",\n  "prompt": "{{prompt}}",\n  "size": "{{width}}x{{height}}",\n  "response_format": "b64_json",\n  "n": 1\n}',
        responseType: "base64",
        responsePath: "data[0].b64_json",
      }),
    },
    {
      label: "Simple URL-result API",
      apply: (f) => ({
        ...f,
        requestTemplate:
          '{\n  "model": "{{model}}",\n  "prompt": "{{prompt}}",\n  "width": "{{width}}",\n  "height": "{{height}}"\n}',
        responseType: "url",
        responsePath: "data.images[0].url",
      }),
    },
  ],
  background: [
    {
      label: "SD.Next rembg",
      apply: (f) => ({
        ...f,
        endpoint: f.endpoint || "http://127.0.0.1:7860/sdapi/v1/extra-single-image",
        authMode: "none",
        model: f.model || "u2net",
        referenceMode: "base64",
        requestTemplate: '{\n  "image": "{{referenceImage}}",\n  "rembg_model": "{{model}}"\n}',
        responseType: "base64",
        responsePath: "image",
      }),
    },
    {
      label: "JSON cutout API",
      apply: (f) => ({
        ...f,
        model: f.model || "background-removal",
        referenceMode: "base64",
        requestTemplate: '{\n  "model": "{{model}}",\n  "image": "{{referenceImage}}",\n  "output_format": "png"\n}',
        responseType: "base64",
        responsePath: "data.image",
      }),
    },
    {
      label: "URL-result cutout API",
      apply: (f) => ({
        ...f,
        model: f.model || "background-removal",
        referenceMode: "url",
        requestTemplate: '{\n  "image_url": "{{referenceImage}}",\n  "format": "png"\n}',
        responseType: "url",
        responsePath: "data.url",
      }),
    },
  ],
};

/** Serialize the form into the API payload's `custom` block. */
export function customPayloadFromForm(kind: "agent" | "image" | "background", form: CustomFormState) {
  return {
    method: form.method,
    auth: { mode: form.authMode, header: form.authMode === "header" ? form.authHeader : undefined },
    headers: form.headers.filter((h) => h.name.trim().length > 0),
    requestTemplate: form.requestTemplate,
    ...(kind !== "agent"
      ? {
          response: { type: form.responseType, path: form.responsePath },
          referenceMode: form.referenceMode,
          execution: form.execution,
          ...(form.execution === "async"
            ? {
                polling: {
                  ...form.polling,
                  failedValue: form.polling.failedValue || undefined,
                  intervalMs: 2000,
                  timeoutMs: 90000,
                },
              }
            : {}),
        }
      : { responseTextPath: form.responseTextPath }),
  };
}

interface CustomProviderFormProps {
  kind: "agent" | "image" | "background";
  form: CustomFormState;
  configured: boolean;
  onChange: (form: CustomFormState) => void;
}

export function CustomProviderForm({ kind, form, configured, onChange }: CustomProviderFormProps) {
  const [showKey, setShowKey] = useState(false);
  const set = (patch: Partial<CustomFormState>) => onChange({ ...form, ...patch });

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">Start from:</span>
        {PRESETS[kind].map((preset) => (
          <button
            key={preset.label}
            className="rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
            onClick={() => onChange(preset.apply(form))}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Provider name">
          <TextInput value={form.name} onChange={(name) => set({ name })} placeholder="My AI Provider" />
        </Field>
        <Field label="Model">
          <TextInput value={form.model} onChange={(model) => set({ model })} placeholder="model-id" mono />
        </Field>
      </div>

      <Field label="Endpoint (full URL)">
        <TextInput
          value={form.endpoint}
          onChange={(endpoint) => set({ endpoint })}
          placeholder="https://api.example.com/v1/generate"
          mono
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Authentication">
          <select
            className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5"
            value={form.authMode}
            onChange={(e) => set({ authMode: e.target.value as CustomFormState["authMode"] })}
          >
            <option value="bearer">Bearer token</option>
            <option value="header">API key header</option>
            <option value="none">None</option>
          </select>
        </Field>
        {form.authMode === "header" && (
          <Field label="Header name">
            <TextInput value={form.authHeader} onChange={(authHeader) => set({ authHeader })} placeholder="x-api-key" mono />
          </Field>
        )}
      </div>

      {form.authMode !== "none" && (
        <Field label="API key">
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 pr-9 font-mono text-xs"
              value={form.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
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
      )}

      <details className="mt-1 rounded border border-zinc-800 bg-zinc-950/50 p-2">
        <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-zinc-400">
          Advanced API mapping
        </summary>
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Field label="HTTP method">
              <select
                className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5"
                value={form.method}
                onChange={(e) => set({ method: e.target.value as "POST" | "GET" })}
              >
                <option>POST</option>
                <option>GET</option>
              </select>
            </Field>
            {kind !== "agent" && (
              <Field label="Reference images">
                <select
                  className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5"
                  value={form.referenceMode}
                  onChange={(e) => set({ referenceMode: e.target.value as CustomFormState["referenceMode"] })}
                  title="How {{referenceImage}} / {{referenceImages}} are filled in the template"
                >
                  <option value="none">Not supported</option>
                  <option value="base64">Base64 in template</option>
                  <option value="url">URL in template</option>
                </select>
              </Field>
            )}
          </div>

          <Field label="Extra headers">
            <div className="space-y-1">
              {form.headers.map((header, i) => (
                <div key={i} className="flex gap-1">
                  <TextInput
                    value={header.name}
                    onChange={(name) => set({ headers: form.headers.map((h, j) => (j === i ? { ...h, name } : h)) })}
                    placeholder="Header-Name"
                    mono
                  />
                  <TextInput
                    value={header.value}
                    onChange={(value) => set({ headers: form.headers.map((h, j) => (j === i ? { ...h, value } : h)) })}
                    placeholder="value"
                    mono
                  />
                  <button
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                    onClick={() => set({ headers: form.headers.filter((_, j) => j !== i) })}
                    aria-label="Remove header"
                    title="Remove header"
                  >
                    <CloseIcon size={12} strokeWidth={2.25} />
                  </button>
                </div>
              ))}
              <button
                className="rounded border border-dashed border-zinc-700 px-2 py-1 text-[11px] text-zinc-500 hover:border-[var(--accent)] hover:text-[var(--accent-text)]"
                onClick={() => set({ headers: [...form.headers, { name: "", value: "" }] })}
              >
                + Add header
              </button>
            </div>
          </Field>

          <Field
            label={`Request body template — variables: ${kind !== "agent" ? "{{model}} {{prompt}} {{negativePrompt}} {{width}} {{height}} {{aspectRatio}} {{seed}} {{referenceImage}} {{referenceImages}}" : "{{model}} {{systemPrompt}} {{userPrompt}} {{messages}} {{temperature}}"}`}
          >
            <textarea
              className="h-32 w-full resize-y rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-[11px]"
              value={form.requestTemplate}
              onChange={(e) => set({ requestTemplate: e.target.value })}
              spellCheck={false}
            />
          </Field>

          {kind !== "agent" ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Response type">
                  <select
                    className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5"
                    value={form.responseType}
                    onChange={(e) => set({ responseType: e.target.value as "url" | "base64" })}
                  >
                    <option value="url">Image URL</option>
                    <option value="base64">Base64 image</option>
                  </select>
                </Field>
                <Field label="Image result path">
                  <TextInput value={form.responsePath} onChange={(responsePath) => set({ responsePath })} placeholder="data.images[0].url" mono />
                </Field>
              </div>

              <Field label="Execution mode">
                <select
                  className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5"
                  value={form.execution}
                  onChange={(e) => set({ execution: e.target.value as "sync" | "async" })}
                >
                  <option value="sync">Synchronous (result in the response)</option>
                  <option value="async">Asynchronous (submit + poll a task)</option>
                </select>
              </Field>

              {form.execution === "async" && (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Task ID path">
                    <TextInput value={form.polling.taskIdPath} onChange={(v) => set({ polling: { ...form.polling, taskIdPath: v } })} mono />
                  </Field>
                  <Field label="Status path">
                    <TextInput value={form.polling.statusPath} onChange={(v) => set({ polling: { ...form.polling, statusPath: v } })} mono />
                  </Field>
                  <div className="col-span-2">
                    <Field label="Status URL template (use {{taskId}})">
                      <TextInput value={form.polling.statusUrlTemplate} onChange={(v) => set({ polling: { ...form.polling, statusUrlTemplate: v } })} mono />
                    </Field>
                  </div>
                  <Field label="Completed value">
                    <TextInput value={form.polling.completedValue} onChange={(v) => set({ polling: { ...form.polling, completedValue: v } })} mono />
                  </Field>
                  <Field label="Failed value (optional)">
                    <TextInput value={form.polling.failedValue} onChange={(v) => set({ polling: { ...form.polling, failedValue: v } })} mono />
                  </Field>
                  <div className="col-span-2">
                    <Field label="Result image path">
                      <TextInput value={form.polling.resultPath} onChange={(v) => set({ polling: { ...form.polling, resultPath: v } })} mono />
                    </Field>
                  </div>
                </div>
              )}
            </>
          ) : (
            <Field label="Response text path (where the model's answer lives)">
              <TextInput value={form.responseTextPath} onChange={(responseTextPath) => set({ responseTextPath })} placeholder="choices[0].message.content" mono />
            </Field>
          )}
        </div>
      </details>
    </div>
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

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      className={`w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-2 py-1.5 ${mono ? "font-mono text-xs" : ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
    />
  );
}
