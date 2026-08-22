"use client";

/**
 * The Manga Agent: natural-language prompt → Creative Task Map (one LLM call,
 * server-side) → deterministic resolution/compile → execution through the
 * editor command layer → deterministic verification.
 *
 * The LLM is the Creative Director; it never touches IDs or state. The plan
 * and per-step status stay visible, and one Undo reverts the whole run.
 */

import { useEffect, useState } from "react";
import { countGenerations, describeStep, type ExecutionSummary, type StepProgress } from "@/agent-v2";
import type { AgentPlan } from "@/agent/tools/schemas";
import {
  executeCreativeRun,
  runCreativeDirection,
  type RunV3Outcome,
} from "@/agent-v3/run";
import type { VerificationIssue } from "@/agent-v3/verification/deterministicVerifier";
import { useEditorStore } from "@/editor/store";
import { useUiStore } from "@/editor/uiStore";
import { fetchProviderStatus } from "@/services/generation";
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  DoneIcon,
  PendingIcon,
  SpinnerIcon,
} from "../ui/icons";

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

/** What executeCreativeRun needs after the planning phase. */
type Prepared = Extract<RunV3Outcome, { kind: "confirm" | "ready" }>;

export function AgentPanel() {
  const selection = useEditorStore((s) => s.selection);
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [steps, setSteps] = useState<StepProgress[]>([]);
  const [activity, setActivity] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runSummary, setRunSummary] = useState<ExecutionSummary | null>(null);
  const [issues, setIssues] = useState<VerificationIssue[]>([]);
  const [agentConfigured, setAgentConfigured] = useState<boolean | null>(null);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const openSettings = useUiStore((s) => s.openSettings);

  // Re-check when settings close so connecting a model enables Run instantly.
  useEffect(() => {
    if (settingsOpen) return;
    fetchProviderStatus()
      .then((s) => setAgentConfigured(Boolean(s?.agent?.configured)))
      .catch(() => setAgentConfigured(false));
  }, [settingsOpen]);

  const run = async (requestPrompt: string) => {
    const state = useEditorStore.getState();
    if (!state.doc) return;
    setPhase("planning");
    setError(null);
    setPlan(null);
    setPrepared(null);
    setRunSummary(null);
    setIssues([]);
    setSteps([]);
    setActivity(["Understanding your scene"]);
    setStatusLine("Understanding your scene…");

    const progressTimers = [
      window.setTimeout(() => setStatusLine("Planning the shot…"), 2_500),
      window.setTimeout(() => setStatusLine("Your model is responding…"), 7_000),
      window.setTimeout(() => setStatusLine("This is taking longer than usual…"), 18_000),
    ];
    try {
      const outcome = await runCreativeDirection(requestPrompt, {
        activity: (label) => setActivity((current) => (current[current.length - 1] === label ? current : [...current, label])),
        status: setStatusLine,
        plan: setPlan,
      });

      if (outcome.kind === "blocked") {
        setStatusLine(outcome.reason);
        setPhase("done");
        return;
      }
      if (outcome.kind === "clarify") {
        setStatusLine(`One question before I start: ${outcome.question}`);
        setPhase("done");
        return;
      }

      setPrepared(outcome);
      setSteps(outcome.plan.steps.map((step) => ({ label: describeStep(step), status: "pending" })));
      if (outcome.kind === "confirm") {
        setStatusLine(`This plan generates ${outcome.generationCount} images.`);
        setPhase("confirm");
        return;
      }
      await execute(outcome);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Agent failed");
      setPhase("error");
    } finally {
      for (const timer of progressTimers) window.clearTimeout(timer);
    }
  };

  const execute = async (toRun: Prepared) => {
    setPhase("executing");
    setStatusLine("Composing panel…");
    setActivity((current) => [...current, "Composing panel"]);

    const result = await executeCreativeRun(
      toRun,
      (index, status, detail) => {
        setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, status, detail } : s)));
        if (status === "running") setStatusLine(describeStep(toRun.plan.steps[index]) + "…");
      },
      { activity: (label) => setActivity((current) => [...current, label]) },
    );
    setIssues(result.issues);
    setRunSummary(result.execution);

    setActivity((current) => [...current, "Checking result"]);

    if (result.execution.rolledBack || result.status === "failed") {
      setError(
        `${result.execution.abortReason ?? "The run could not be completed."} Nothing was changed — your page is exactly as it was.`,
      );
      setStatusLine(null);
      setPhase("error");
      return;
    }

    setActivity((current) => [...current, "Done"]);
    setStatusLine(
      result.issues.length === 0 && result.status === "completed"
        ? "Completed. Everything stays editable — one Undo reverts the whole run."
        : null,
    );
    setPhase("done");
  };

  const busy = phase === "planning" || phase === "executing";

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-xs">
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">What do you want to create?</p>
        <textarea
          className="h-24 w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] p-2 text-sm"
          placeholder={'e.g. "Create a 4-panel manga where Akari gets her exam result, celebrates, then realizes she misread the score."'}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy}
        />
        <div className="mt-1 flex items-center justify-end gap-2">
          <button
            className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-white hover:bg-[var(--accent-hover)] disabled:opacity-40"
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
            className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-white hover:bg-[var(--accent-hover)]"
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
              className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 hover:border-[var(--accent)] hover:text-[var(--accent-text)] disabled:opacity-40"
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

      {statusLine && <p className="text-zinc-300">{statusLine}</p>}
      {activity.length > 0 && (
        <p className="text-[10px] text-zinc-500" aria-label="Agent activity">
          {activity.join(" → ")}
        </p>
      )}
      {error && (
        <div className="rounded border border-red-900 bg-red-950/50 p-3 text-red-200">
          <p className="font-medium">{runSummary?.status === "failed" ? "Run failed" : "Agent planning failed"}</p>
          <p className="mt-1 text-[11px] text-red-300">{error}</p>
          <button className="mt-2 rounded border border-red-800 px-2.5 py-1 text-[10px] hover:bg-red-900/40" onClick={() => run(prompt.trim())}>Retry</button>
        </div>
      )}

      {plan && steps.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md bg-[var(--bg-elevated)] p-2">
          <p className="mb-1 text-[10px] font-medium text-[var(--accent-text)]">Target: {plan.targetScope?.label ?? "Current Page"}</p>
          <p className="mb-1 text-zinc-400">{plan.summary}</p>
          <p className="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Execution</p>
          <ul className="space-y-1">
            {steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">
                  {step.status === "pending" && (
                    <PendingIcon size={12} strokeWidth={2} className="text-[var(--text-muted)]" />
                  )}
                  {step.status === "running" && (
                    <SpinnerIcon size={12} strokeWidth={2} className="animate-spin text-[var(--accent-text)]" />
                  )}
                  {step.status === "done" && (
                    <DoneIcon size={12} strokeWidth={2} className="text-[var(--success)]" />
                  )}
                  {step.status === "failed" && (
                    <AlertIcon size={12} strokeWidth={2} className="text-[var(--danger)]" />
                  )}
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
          {phase === "confirm" && prepared && (
            <div className="mt-3 flex gap-2">
              <button
                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-white hover:bg-[var(--accent-hover)]"
                onClick={() => execute(prepared)}
              >
                Continue ({countGenerations(plan)} generations)
              </button>
              <button
                className="rounded border border-zinc-700 px-3 py-1.5 text-zinc-400 hover:text-zinc-200"
                onClick={() => {
                  setPhase("idle");
                  setStatusLine(null);
                  setPlan(null);
                  setPrepared(null);
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

      {/*
        Deterministic verification failures are shown verbatim. The creator is
        told what is missing and offered the two honest next actions: retry,
        or revert the whole run.
      */}
      {phase === "done" && issues.length > 0 && (
        <div className="rounded-md border border-amber-900/60 bg-amber-950/20 p-3" aria-label="Run partially completed">
          <p className="text-xs font-medium text-amber-300">Some things did not land</p>
          <ul className="mt-1.5 space-y-1 text-[11px] text-amber-200/90">
            {issues.map((issue) => (
              <li key={issue.message} className="flex items-start gap-1.5">
                <CloseIcon size={10} strokeWidth={2} className="mt-1 shrink-0 opacity-70" />
                {issue.message}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] text-amber-200/70">
            What changed is on the page and stays editable. What is missing is listed above.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded border border-amber-800 px-2.5 py-1 text-[10px] text-amber-200 hover:bg-amber-900/40"
              onClick={() => run(prompt.trim())}
            >
              Retry
            </button>
            <button
              className="rounded border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:text-zinc-200"
              onClick={() => {
                useEditorStore.getState().undo();
                setRunSummary(null);
                setIssues([]);
                setPhase("idle");
                setPlan(null);
                setPrepared(null);
                setSteps([]);
                setActivity([]);
                setStatusLine("Run reverted — your page is exactly as it was.");
              }}
            >
              Revert this run
            </button>
          </div>
        </div>
      )}

      {phase === "idle" && !plan && (
        <p className="text-[11px] leading-5 text-zinc-600">
          The agent operates the same editor you do: it reuses your library first, generates only missing assets, and
          everything it makes stays fully editable.
        </p>
      )}

      {/* runSummary is retained for the preserved-assets truth in future UI. */}
      {runSummary && runSummary.preservedAssets.length > 0 && (
        <p className="flex items-center gap-1 text-[10px] text-amber-300">
          <CheckIcon size={11} strokeWidth={2.25} />
          Kept in the library for reuse: {runSummary.preservedAssets.join(", ")}
        </p>
      )}
    </div>
  );
}
