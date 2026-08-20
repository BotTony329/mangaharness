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
import type { AgentPlan } from "@/agent/tools/schemas";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";

type Phase = "idle" | "planning" | "confirm" | "executing" | "done" | "error";

interface QuickAction {
  label: string;
  prompt: string;
  needs?: "character" | "panel";
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
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [skillsUsed, setSkillsUsed] = useState<string[]>([]);
  const [steps, setSteps] = useState<StepProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
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
    setPlan(null);
    setSteps([]);
    setStatusLine("Understanding request…");

    try {
      const context = buildAgentContext({
        doc: state.doc,
        currentPageId: state.currentPageId,
        selection: state.selection,
      });
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: requestPrompt, context }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Agent planning failed");

      const received = body as { plan: AgentPlan; skillsUsed: string[]; rejected: { tool: string; error: string }[] };
      setSkillsUsed(received.skillsUsed);
      setPlan(received.plan);
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
    }
  };

  const execute = async (planToRun: AgentPlan) => {
    setPhase("executing");
    setStatusLine("Composing…");
    const summary = await executePlan(planToRun, (index, status, detail) => {
      setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, status, detail } : s)));
      if (status === "running") setStatusLine(describeStep(planToRun.steps[index]) + "…");
    });
    setStatusLine(
      summary.failed === 0
        ? "Done. Everything stays editable — one Undo reverts the whole run."
        : `Done with ${summary.failed} failed step${summary.failed > 1 ? "s" : ""} (see below).`,
    );
    setPhase("done");
  };

  const busy = phase === "planning" || phase === "executing";

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
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[10px] text-zinc-500">
            Context: current page{selection.panelId ? " · selected panel" : ""}
            {selection.itemId ? " · selected object" : ""} · Skills: auto
          </span>
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
      {error && <p className="rounded border border-red-900 bg-red-950/50 p-2 text-red-300">{error}</p>}

      {plan && steps.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/60 p-2">
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
                  {step.detail && <span className="block text-[10px] text-red-400/80">{step.detail}</span>}
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
