"use client";

/**
 * AI provider status. Read-only by design: credentials live in server
 * environment variables and are never sent to (or from) the browser —
 * this dialog only shows safe status metadata.
 */

import { useEffect, useState } from "react";

interface ProviderStatus {
  configured: boolean;
  provider?: string;
  model?: string;
  capabilities?: Record<string, boolean>;
  agent?: { configured: boolean; provider?: string; model?: string };
  storage?: { configured: boolean; backend: string };
}

export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/provider/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setError("Could not reach the server"));
  }, []);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/provider/status", { method: "POST" });
      const body = await response.json();
      setTestResult(body.ok ? "Connection OK — provider responded." : `Failed: ${body.error ?? "unknown error"}`);
    } catch {
      setTestResult("Failed: could not reach the server");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60" onMouseDown={onClose}>
      <div
        className="w-[420px] rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-sm shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 font-semibold text-zinc-100">AI Providers</h2>
        {error && <p className="text-red-400">{error}</p>}
        {!status && !error && <p className="text-zinc-500">Checking…</p>}
        {status && (
          <div className="space-y-4">
            <StatusBlock
              title="Image generation"
              configured={status.configured}
              lines={
                status.configured
                  ? [
                      `Provider: ${status.provider}`,
                      `Model: ${status.model}`,
                      `Reference images: ${status.capabilities?.referenceImage ? "supported" : "not supported"}`,
                    ]
                  : []
              }
            />
            <StatusBlock
              title="Manga Agent (LLM)"
              configured={Boolean(status.agent?.configured)}
              lines={status.agent?.configured ? [`Provider: ${status.agent.provider}`, `Model: ${status.agent.model}`] : []}
            />
            <StatusBlock
              title="Asset storage"
              configured={Boolean(status.storage?.configured)}
              lines={[`Backend: ${status.storage?.backend ?? "unknown"}`]}
            />
            {!status.configured && (
              <p className="rounded border border-zinc-700 bg-zinc-950 p-2 text-xs leading-5 text-zinc-400">
                Configure providers with server environment variables (see <code>.env.example</code> and{" "}
                <code>docs/DEPLOYMENT.md</code>): set <code>GEMINI_API_KEY</code> and <code>AGENT_API_KEY</code> in
                Vercel → Project → Settings → Environment Variables, then redeploy.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700 disabled:opacity-40"
                onClick={testConnection}
                disabled={testing || !status.configured}
              >
                {testing ? "Testing…" : "Test Connection"}
              </button>
              <button className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500" onClick={onClose}>
                Close
              </button>
            </div>
            {testResult && <p className="text-xs text-zinc-300">{testResult}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBlock({ title, configured, lines }: { title: string; configured: boolean; lines: string[] }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/60 p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">{title}</span>
        <span className={`text-xs ${configured ? "text-emerald-400" : "text-amber-400"}`}>
          {configured ? "● Configured" : "○ Not configured"}
        </span>
      </div>
      {lines.map((line) => (
        <p key={line} className="mt-1 text-[11px] text-zinc-500">
          {line}
        </p>
      ))}
    </div>
  );
}
