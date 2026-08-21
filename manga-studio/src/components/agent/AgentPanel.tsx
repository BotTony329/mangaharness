"use client";

/**
 * The Manga Agent: natural-language prompt → validated tool plan →
 * execution through the editor command layer. The plan and per-step status
 * stay visible so the creator always knows what the agent did — and one
 * Undo reverts the whole run.
 */

import { useEffect, useState } from "react";
import { buildAgentContext } from "@/agent/contextBuilder";
import { countGenerations, describeStep, executePlan, type StepProgress } from "@/agent/executor";
import { resolveAgentScope, type AgentScopePreference } from "@/agent/scope";
import type { AgentPlan } from "@/agent/tools/schemas";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";

type Phase = "idle" | "planning" | "confirm" | "executing" | "done" | "error";

interface QuickAction {
  label: string;
  prompt: string;
  needs?: "character" | "panel";
}

interface AgentDiagnostics {
  requestId?: string;
  provider?: string;
  model?: string;
  stage?: string;
  reason?: string;
  elapsedMs?: number;
  providerStatus?: number;
  finishReason?: string;
  timings?: Record<string, number | undefined>;
}

const QUICK_ACTIONS: QuickAction[] = [
  { label: "Create scene", prompt: "Create a four-panel scene on the current page using the existing characters." },
  { label: "Add dialogue", prompt: "Add fitting speech bubbles to the panels that have characters but no dialogue." },
  { label: "More dramatic", prompt: "Make the selected panel more dramatic.", needs: "panel" },
  { label: "Convert to yonkoma", prompt: "Turn this page into a Japanese four-panel yonkoma layout." },
];

/** How many planned generations trigger an explicit confirmation. */
const CONFIRM_THRESHOLD = 3;

export function AgentPanel() {
  const selection = useEditorStore((s) => s.selection);
  const doc = useEditorStore((s) => s.doc);
  const currentPageId = useEditorStore((s) => s.currentPageId);
  const [prompt, setPrompt] = useState("");
  const [scopePreference, setScopePreference] = useState<AgentScopePreference>("auto");
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [skillsUsed, setSkillsUsed] = useState<string[]>([]);
  const [steps, setSteps] = useState<StepProgress[]>([]);
  const [activity, setActivity] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<AgentDiagnostics | null>(null);
  const [agentConfigured, setAgentConfigured] = useState<boolean | null>(null);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const openSettings = useUiStore((s) => s.openSettings);

  // Re-check when settings close so connecting a model enables Run instantly.
  useEffect(() => {
    if (settingsOpen) return;
    fetch("/api/provider/status")
      .then((r) => r.json())
      .then((s) => setAgentConfigured(Boolean(s?.agent?.configured)))
      .catch(() => setAgentConfigured(false));
  }, [settingsOpen]);

  const run = async (requestPrompt: string) => {
    const state = useEditorStore.getState();
    if (!state.doc) return;
    setPhase("planning");
    setError(null);
    setErrorDetails(null);
    setPlan(null);
    setSteps([]);
    setActivity(["Understanding"]);
    setStatusLine("Understanding request…");

    const progressTimers = [
      window.setTimeout(() => setStatusLine("Sending to your agent model…"), 350),
      window.setTimeout(() => setStatusLine("Waiting for a concise tool plan…"), 2_500),
      window.setTimeout(() => setStatusLine("Your model is responding…"), 7_000),
      window.setTimeout(() => setStatusLine("This is taking longer than usual…"), 18_000),
    ];
    try {
      const scope = resolveAgentScope({
        doc: state.doc,
        currentPageId: state.currentPageId,
        selection: state.selection,
        prompt: requestPrompt,
        preference: scopePreference,
      });
      const context = buildAgentContext({
        doc: state.doc,
        currentPageId: state.currentPageId,
        selection: state.selection,
        scope,
      });
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: requestPrompt, context, scope }),
      });
      const body = await response.json() as { error?: string; details?: AgentDiagnostics; diagnostics?: AgentDiagnostics };
      if (!response.ok) {
        setErrorDetails(body.details ?? null);
        throw new Error(body.error ?? "Agent planning failed");
      }

      const received = body as typeof body & { plan: AgentPlan; skillsUsed: string[]; rejected: { tool: string; error: string }[] };
      setSkillsUsed(received.skillsUsed);
      setActivity((current) => [...current, "Scene plan"]);
      setPlan(received.plan);
      setStatusLine(received.diagnostics?.provider ? `Plan received from ${received.diagnostics.provider}.` : "Plan received.");
      setSteps(received.plan.steps.map((s) => ({ label: describeStep(s), status: "pending" })));

      if (received.plan.steps.length === 0) {
        setStatusLine(received.plan.summary || "The agent had nothing to do for that request.");
        setPhase("done");
        return;
      }
      if (countGenerations(received.plan) > CONFIRM_THRESHOLD) {
        setStatusLine(`This plan generates ${countGenerations(received.plan)} images.`);
        setPhase("confirm");
        return;
      }
      await execute(received.plan);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Agent failed");
      setPhase("error");
    } finally {
      for (const timer of progressTimers) window.clearTimeout(timer);
    }
  };

  const execute = async (planToRun: AgentPlan) => {
    setPhase("executing");
    setActivity((current) => [...current, "Asset search", "Composition"]);
    setStatusLine("Composing…");
    const summary = await executePlan(planToRun, (index, status, detail) => {
      setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, status, detail } : s)));
      if (status === "running") setStatusLine(describeStep(planToRun.steps[index]) + "…");
    });
    setActivity((current) => [...current, "Validation", "Done"]);
    const unresolved = summary.validationIssues.filter((issue) => !issue.corrected);
    setStatusLine(
      summary.failed === 0 && unresolved.length === 0
        ? "Done. Everything stays editable — one Undo reverts the whole run."
        : `Done with ${summary.failed} failed step${summary.failed !== 1 ? "s" : ""} and ${unresolved.length} validation warning${unresolved.length !== 1 ? "s" : ""}.`,
    );
    if (summary.validationIssues.length > 0) {
      setSteps((current) => [
        ...current,
        ...summary.validationIssues.map((issue) => ({
          label: `Validation · ${issue.message}`,
          status: issue.corrected ? "done" as const : "failed" as const,
          detail: issue.corrected ? "Automatically corrected" : undefined,
        })),
      ]);
    }
    setPhase("done");
  };

  const busy = phase === "planning" || phase === "executing";
  const displayedScope = doc
    ? resolveAgentScope({ doc, currentPageId, selection, prompt, preference: scopePreference })
    : null;

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-xs">
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">What do you want to create?</p>
        <textarea
          className="h-24 w-full resize-none rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
          placeholder={'e.g. "Create a 4-panel manga where Akari gets her exam result, celebrates, then realizes she misread the score."'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <label className="min-w-0 text-[10px] text-zinc-500">
            <span className="sr-only">Agent target scope</span>
            <select
              aria-label="Agent target scope"
              className="max-w-52 rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-[10px] text-zinc-300"
              value={scopePreference}
              disabled={busy}
              onChange={(event) => setScopePreference(event.target.value as AgentScopePreference)}
            >
              <option value="auto">Auto · {displayedScope?.label ?? "Current Page"}</option>
              <option value="selected-object" disabled={!selection.itemId}>Selected Object</option>
              <option value="selected-panel" disabled={!selection.panelId && !selection.itemId}>Selected Panel</option>
              <option value="current-page">Current Page</option>
              <option value="whole-project">Whole Project</option>
            </select>
          </label>
          <button
            className="rounded bg-indigo-600 px-4 py-1.5 text-white hover:bg-indigo-500 disabled:opacity-40"
            disabled={busy || prompt.trim().length < 3 || agentConfigured === false}
            onClick={() => run(prompt.trim())}
          >
            {phase === "planning" ? "Planning…" : phase === "executing" ? "Working…" : "Run"}
          </button>
        </div>
      </div>

      {agentConfigured === false && (
        <div className="rounded border border-zinc-700 bg-zinc-950/80 p-3 text-center">
          <p className="mb-2 text-zinc-400">Connect an AI model to use the Manga Agent.</p>
          <button
            className="rounded bg-indigo-600 px-4 py-1.5 text-white hover:bg-indigo-500"
            onClick={openSettings}
          >
            Connect Model
          </button>
        </div>
      )}

      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Quick actions</p>
        <div className="flex flex-wrap gap-1">
          {QUICK_ACTIONS.filter((a) => a.needs !== "panel" || selection.panelId).map((action) => (
            <button
              key={action.label}
              className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 hover:border-indigo-500 hover:text-indigo-300 disabled:opacity-40"
              disabled={busy || agentConfigured === false}
              onClick={() => {
                setPrompt(action.prompt);
                run(action.prompt);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>

      {skillsUsed.length > 0 && (
        <p className="text-[10px] text-zinc-500">Skills: {skillsUsed.join(" · ")}</p>
      )}

      {statusLine && <p className="text-zinc-300">{statusLine}</p>}
      {activity.length > 0 && (
        <p className="text-[10px] text-zinc-500" aria-label="Agent activity">
          {activity.join(" → ")}
        </p>
      )}
      {error && (
        <div className="rounded border border-red-900 bg-red-950/50 p-3 text-red-200">
          <p className="font-medium">Agent planning failed</p>
          <p className="mt-1 text-[11px] text-red-300">{error}</p>
          {errorDetails && (
            <details className="mt-2 text-[10px] text-zinc-400">
              <summary className="cursor-pointer text-zinc-300">Details</summary>
              <dl className="mt-2 grid grid-cols-[76px_1fr] gap-x-2 gap-y-1">
                {errorDetails.provider && <><dt>Provider</dt><dd>{errorDetails.provider}</dd></>}
                {errorDetails.model && <><dt>Model</dt><dd>{errorDetails.model}</dd></>}
                {errorDetails.stage && <><dt>Stage</dt><dd>{titleCase(errorDetails.stage)}</dd></>}
                {errorDetails.elapsedMs !== undefined && <><dt>Elapsed</dt><dd>{formatMs(errorDetails.elapsedMs)}</dd></>}
                {errorDetails.providerStatus && <><dt>HTTP status</dt><dd>{errorDetails.providerStatus}</dd></>}
                {errorDetails.finishReason && <><dt>Finish reason</dt><dd>{errorDetails.finishReason}</dd></>}
                {errorDetails.requestId && <><dt>Request ID</dt><dd className="break-all">{errorDetails.requestId}</dd></>}
              </dl>
              {errorDetails.timings && (
                <div className="mt-2 border-t border-red-900/70 pt-2">
                  {Object.entries(errorDetails.timings).filter((entry) => entry[1] !== undefined).map(([name, value]) => (
                    <p key={name}>{titleCase(name)}: {formatMs(value!)}</p>
                  ))}
                </div>
              )}
            </details>
          )}
          <button className="mt-2 rounded border border-red-800 px-2.5 py-1 text-[10px] hover:bg-red-900/40" onClick={() => run(prompt.trim())}>Retry</button>
        </div>
      )}

      {plan && steps.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/60 p-2">
          <p className="mb-1 text-[10px] font-medium text-indigo-300">Target: {plan.targetScope?.label ?? "Current Page"}</p>
          <p className="mb-2 text-zinc-400">{plan.summary}</p>
          <ul className="space-y-1">
            {steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5">
                  {step.status === "pending" && <span className="text-zinc-600">○</span>}
                  {step.status === "running" && <span className="animate-pulse text-indigo-400">◐</span>}
                  {step.status === "done" && <span className="text-emerald-400">●</span>}
                  {step.status === "failed" && <span className="text-red-400">✕</span>}
                </span>
                <span className={step.status === "failed" ? "text-red-300" : "text-zinc-300"}>
                  {step.label}
                  {step.detail && (
                    <span className={`block text-[10px] ${step.status === "failed" ? "text-red-400/80" : "text-zinc-500"}`}>
                      {step.detail}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {phase === "confirm" && plan && (
            <div className="mt-3 flex gap-2">
              <button
                className="rounded bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-500"
                onClick={() => execute(plan)}
              >
                Continue ({countGenerations(plan)} generations)
              </button>
              <button
                className="rounded border border-zinc-700 px-3 py-1.5 text-zinc-400 hover:text-zinc-200"
                onClick={() => {
                  setPhase("idle");
                  setStatusLine(null);
                  setPlan(null);
                  setSteps([]);
                  setActivity([]);
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {phase === "idle" && !plan && (
        <p className="text-[11px] leading-5 text-zinc-600">
          The agent operates the same editor you do: it reuses your library first, generates only missing assets, and
          everything it makes stays fully editable.
        </p>
      )}
    </div>
  );
}

function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function titleCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}
