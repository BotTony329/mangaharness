"use client";

/**
 * The Manga Agent: natural-language prompt → validated tool plan →
 * execution through the editor command layer. The plan and per-step status
 * stay visible so the creator always knows what the agent did — and one
 * Undo reverts the whole run.
 */

import { useEffect, useState } from "react";
import { buildAgentContext } from "@/agent/contextBuilder";
import { countGenerations, describeStep, executePlan, type ExecutionSummary, type RunGuards, type StepProgress } from "@/agent/executor";
import { groundPrompt, type GroundingReport } from "@/agent/grounding";
import { validateGroundedPlan } from "@/agent/planValidation";
import { resolveAgentScope, scopeForPanels, scopeForSubject, type AgentScopePreference } from "@/agent/scope";
import { resolveSubject, type SubjectResolution } from "@/agent/subject";
import { deriveSceneIntent, describeIntent, type SceneIntent } from "@/agent/sceneIntent";
import { buildSequencePlan, compileSequencePlan, describeSequencePlan, type SequencePlan } from "@/agent/sequencePlan";
import { describeCameraIntent } from "@/agent/cameraIntent";
import { deriveAssetRequirements, type RequirementReport } from "@/agent/assetRequirements";
import { fulfilRequirements } from "@/agent/fulfilRequirements";
import type { AgentPlan } from "@/agent/tools/schemas";
import type { AssetInstance, ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { characterIdOfInstance } from "@/characters/identity";
import { useUiStore } from "@/editor/uiStore";
import {
  AlertIcon,
  CheckIcon,
  GenerateIcon,
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
  const [grounding, setGrounding] = useState<GroundingReport | null>(null);
  const [subject, setSubject] = useState<SubjectResolution | null>(null);
  const [intent, setIntent] = useState<SceneIntent | null>(null);
  const [sequence, setSequence] = useState<SequencePlan | null>(null);
  const [requirements, setRequirements] = useState<RequirementReport | null>(null);
  const [runScope, setRunScope] = useState<{ label: string; demotionReason?: string } | null>(null);
  const [guards, setGuards] = useState<RunGuards | null>(null);
  const [assetTrace, setAssetTrace] = useState<string[]>([]);
  const [skillsUsed, setSkillsUsed] = useState<string[]>([]);
  const [steps, setSteps] = useState<StepProgress[]>([]);
  const [activity, setActivity] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<AgentDiagnostics | null>(null);
  /** The final run verdict: completed / partially_completed / failed, with named fallbacks. */
  const [runSummary, setRunSummary] = useState<ExecutionSummary | null>(null);
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
    setGrounding(null);
    setRunSummary(null);
    setGuards(null);
    setAssetTrace([]);
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
      let scope = resolveAgentScope({
        doc: state.doc,
        currentPageId: state.currentPageId,
        selection: state.selection,
        prompt: requestPrompt,
        preference: scopePreference,
      });
      /**
       * Entity grounding runs BEFORE the model is called. Identity is decided
       * deterministically from the project, and the planner is handed the
       * answer instead of being asked to guess it.
       */
      const report = groundPrompt({
        doc: state.doc,
        prompt: requestPrompt,
        selectedCharacterId: selectedCharacterId(state.doc, state.selection.itemId),
        selectedInstanceId: state.selection.itemId,
        sceneCharacterIds: panelCharacterIds(state.doc, scope.panelId),
      });
      setGrounding(report);
      setIntent(null);
      setSubject(null);
      setSequence(null);
      setRequirements(null);

      // A reference we could not ground stops the run here — before the model
      // is paid for, before anything is generated, before anything is mutated.
      if (report.blocking.length > 0) {
        setStatusLine(report.blocking[0]);
        setPhase("done");
        return;
      }

      /**
       * Subject, then scope, then intent — in that order.
       *
       * Grounding says WHO. Only then can scope decide whether the creator's
       * selection is a target or merely the panel they are looking at, and only
       * then can the semantic plan be built. Doing scope first is what let a
       * selected lamp overrule a named character.
       */
      const resolvedSubject = resolveSubject({ doc: state.doc, grounding: report });
      setSubject(resolvedSubject);
      scope = scopeForSubject(scope, resolvedSubject, state.doc);
      setRunScope({ label: scope.label, demotionReason: scope.demotionReason });

      const sceneIntent = deriveSceneIntent({
        doc: state.doc,
        prompt: requestPrompt,
        grounding: report,
        subject: resolvedSubject,
        scope,
      });
      setIntent(sceneIntent);
      setActivity((current) => [...current, "Scene intent"]);

      /**
       * The sequence plan is the ENFORCED structure.
       *
       * Beat-to-panel mapping, layout growth and camera compilation are decided
       * here, deterministically, before the model is asked for anything. When
       * the request has explicit structure — sequential moments, a named panel,
       * or camera language — these compiled steps are what runs, and the
       * planner is not given the opportunity to collapse two moments into one
       * panel or to quietly drop a framing instruction.
       */
      const plan = buildSequencePlan({
        doc: state.doc,
        intent: sceneIntent,
        scope,
        characterIds: resolvedSubject.characterIds.length > 0
          ? resolvedSubject.characterIds
          : report.entities.filter((e) => e.characterId).map((e) => e.characterId as ID),
      });
      // A named panel widens the scope, just as a named character does.
      scope = scopeForPanels(scope, plan.allocation.panelNumbers, plan.needsPanelLevel);
      setRunScope({ label: scope.label, demotionReason: scope.demotionReason });
      setSequence(plan);
      /**
       * What this request NEEDS, before anything is spent.
       *
       * A missing asset is a requirement, not a failure. Deriving it here means
       * the creator sees "Roach Man — not in the library, create the character"
       * in the plan rather than discovering afterwards that the run refused.
       */
      const requirementReport = deriveAssetRequirements({
        doc: state.doc,
        plan,
        newCharacters: resolvedSubject.newCharacters,
      });
      setRequirements(requirementReport);
      setActivity((current) => [...current, "Asset requirements"]);

      const compiled = compileSequencePlan(plan, state.doc);
      const deterministic = compiled.length > 0 && (plan.requiredPanelCount > 1 || plan.beats.some((beat) => beat.camera));
      setActivity((current) => [...current, "Panel allocation"]);

      const context = buildAgentContext({
        doc: state.doc,
        currentPageId: state.currentPageId,
        selection: state.selection,
        scope,
        grounding: report,
        intent: sceneIntent,
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

      // Bind names to IDs and refuse anything unresolvable, unauthorized, or
      // already satisfied by the library — all before the first mutation.
      /**
       * Deterministic steps replace the model's for structured requests. The
       * model still ran — its reading of the sentence produced nothing we keep,
       * but it remains the interpretation layer for prompts with no explicit
       * structure, which is the majority.
       */
      const sourcePlan = deterministic
        ? { ...received.plan, steps: compiled, summary: received.plan.summary || plan.allocation.reason }
        : received.plan;

      const validated = validateGroundedPlan({
        plan: sourcePlan,
        doc: state.doc,
        grounding: report,
        scope,
        panelCount: Math.max(scope.panelCount, ...plan.allocation.panelNumbers, 1),
      });
      setPlan(validated.plan);
      setAssetTrace(validated.rejected.map((entry) => `${entry.tool}: ${entry.error}`));
      setSteps(validated.plan.steps.map((s) => ({ label: describeStep(s), status: "pending" })));

      if (validated.blocked) {
        setStatusLine(validated.blockReason ?? "The plan referenced a character that could not be resolved.");
        setPhase("done");
        return;
      }
      if (validated.plan.steps.length === 0) {
        setStatusLine(validated.plan.summary || "The agent had nothing to do for that request.");
        setPhase("done");
        return;
      }
      const runGuards: RunGuards = {
        creationAuthorized: validated.creationAuthorized,
        authorizedCreationNames: validated.authorizedCreationNames,
        selectedCharacterId: report.selectedCharacterId,
      };
      setGuards(runGuards);
      setStatusLine(received.diagnostics?.provider ? `Plan received from ${received.diagnostics.provider}.` : "Plan received.");

      if (countGenerations(validated.plan) > CONFIRM_THRESHOLD) {
        setStatusLine(`This plan generates ${countGenerations(validated.plan)} images.`);
        setPhase("confirm");
        return;
      }
      await execute(validated.plan, runGuards, plan, requirementReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Agent failed");
      setPhase("error");
    } finally {
      for (const timer of progressTimers) window.clearTimeout(timer);
    }
  };

  const execute = async (
    planToRun: AgentPlan,
    runGuards?: RunGuards,
    sequencePlan?: SequencePlan | null,
    requirementReport?: RequirementReport | null,
  ) => {
    setPhase("executing");

    /**
     * Assets first, page second.
     *
     * Generated library assets survive a failed composition — they were paid
     * for, and a retry must not pay twice — while the page itself is what the
     * transaction rolls back. Doing this inside the transaction would discard
     * a character the creator now owns.
     */
    const report = requirementReport ?? requirements;
    if (report && report.generationCount > 0) {
      setStatusLine("Making the assets this needs…");
      try {
        const fulfilment = await fulfilRequirements(report.requirements);
        if (fulfilment.created.length > 0) {
          setActivity((current) => [...current, `Created ${fulfilment.created.map((c) => c.name).join(", ")}`]);
        }
      } catch (cause) {
        // The truth: what could not be MADE, never "it does not exist".
        setError(cause instanceof Error ? cause.message : "The assets this needs could not be generated.");
        setStatusLine(null);
        setPhase("error");
        return;
      }
    }

    setActivity((current) => [...current, "Asset search", "Composition"]);
    setStatusLine("Composing…");
    const summary = await executePlan(
      planToRun,
      (index, status, detail) => {
        setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, status, detail } : s)));
        if (status === "running") setStatusLine(describeStep(planToRun.steps[index]) + "…");
      },
      runGuards ?? guards ?? { creationAuthorized: false, authorizedCreationNames: [] },
      sequencePlan ?? sequence ?? undefined,
    );
    setActivity((current) => [...current, "Validation"]);

    if (summary.validationIssues.length > 0) {
      setSteps((current) => [
        ...current,
        ...summary.validationIssues.map((issue) => ({
          label: `Validation · ${issue.message}`,
          status: issue.severity === "info" || issue.corrected ? ("done" as const) : ("failed" as const),
          detail: issue.corrected ? "Automatically corrected" : issue.severity === "fatal" ? "Blocking" : undefined,
        })),
      ]);
    }

    /**
     * A run that was rolled back is not "done with warnings" — nothing landed.
     * Saying "Done" after the agent damaged or failed to build a page is how a
     * creator loses trust in every message this panel prints, so the two
     * outcomes get visibly different endings.
     */
    if (summary.rolledBack) {
      setError(
        `${summary.abortReason ?? "The run could not be completed."} Nothing was changed — your page is exactly as it was.`,
      );
      setRunSummary(summary);
      setStatusLine(null);
      setPhase("error");
      return;
    }

    setActivity((current) => [...current, "Done"]);
    setRunSummary(summary);
    /**
     * The verdict is the run STATUS, never "done with N failed steps".
     * Partial means something the creator asked for is missing, and they are
     * told what, why, and what they can do about it.
     */
    setStatusLine(
      summary.status === "completed"
        ? "Completed. Everything stays editable — one Undo reverts the whole run."
        : null,
    );
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
          className="h-24 w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] p-2 text-sm"
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

      {skillsUsed.length > 0 && (
        <p className="text-[10px] text-zinc-500">Skills: {skillsUsed.join(" · ")}</p>
      )}

      {grounding && grounding.entities.length > 0 && (
        <div className="rounded-md bg-[var(--bg-elevated)] p-2" aria-label="Agent understanding">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Understanding</p>
          <ul className="space-y-0.5">
            {grounding.entities.map((entity) => (
              <li key={entity.surface} className="flex items-start gap-1.5">
                <span className="mt-0.5 shrink-0">
                  {entity.resolution?.status === "existing" ? (
                    <CheckIcon size={12} strokeWidth={2.25} className="text-[var(--success)]" />
                  ) : entity.resolution?.status === "create" ? (
                    <GenerateIcon size={12} strokeWidth={2.25} className="text-[var(--accent-text)]" />
                  ) : (
                    <CloseIcon size={12} strokeWidth={2.25} className="text-[var(--danger)]" />
                  )}
                </span>
                <span
                  className={
                    entity.resolution?.status === "unresolved" ? "text-red-300" : "text-zinc-300"
                  }
                >
                  {entity.resolution?.status === "existing" ? (
                    <>
                      {entity.surface} → existing Character &ldquo;{entity.name}&rdquo;
                    </>
                  ) : entity.resolution?.status === "create" ? (
                    <>
                      {entity.resolution.proposedName}
                      <span className="block text-[10px] text-[var(--text-muted)]">New character</span>
                    </>
                  ) : (
                    <>
                      Could not resolve &ldquo;{entity.surface}&rdquo;
                      {entity.reason && <span className="block text-[10px] text-red-400/80">{entity.reason}</span>}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {/* Creation is only ever announced when the user actually asked for it. */}
          {grounding.creation.allowed && (
            <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-300">
              <CheckIcon size={11} strokeWidth={2.25} />
              New character requested{grounding.creation.requestedNames.length > 0 ? `: ${grounding.creation.requestedNames.join(", ")}` : ""}
            </p>
          )}
        </div>
      )}

      {/*
        Why the run did what it did.
        
        A planning failure used to print one sentence about an internal type
        check. The creator could not see who the Agent thought the subject was,
        whether their selection had been treated as a target, or what sequence
        it understood — so there was nothing to correct. All four are now on
        screen before execution starts.
      */}
      {(subject || intent) && (
        <div className="rounded-md bg-[var(--bg-elevated)] p-2" aria-label="Agent plan">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Plan</p>
          {subject && (
            <dl className="space-y-0.5 text-[10px]">
              <Row label="Subject" value={subject.explanation} />
              {runScope && <Row label="Scope" value={runScope.label} />}
              <Row
                label="Selection used as subject"
                value={subject.usedSelection ? "Yes" : "No — an explicitly named entity has precedence"}
              />
              {runScope?.demotionReason && <Row label="Selection note" value={runScope.demotionReason} />}
            </dl>
          )}
          {intent && intent.beats.length > 0 && doc && (
            <div className="mt-1.5">
              <p className="text-[10px] text-[var(--text-muted)]">
                Sequence{intent.sequential ? ` · ${intent.panelsRequested} panels` : " · one panel"}
              </p>
              <ul className="mt-0.5 space-y-0.5 text-[10px] text-[var(--text-secondary)]">
                {describeIntent(intent, doc).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {/*
            Panel allocation and camera are shown BEFORE the run, because they
            are the two things a creator cannot infer from the result — a beat
            in the wrong panel and a dropped framing instruction both look like
            "the Agent ignored me".
          */}
          {/*
            What this will make. Shown before execution because "not in the
            library" is a plan step here, not a refusal — the creator should see
            what they are about to be given, and what it costs.
          */}
          {requirements && requirements.requirements.length > 0 && (
            <div className="mt-1.5">
              <p className="text-[10px] text-[var(--text-muted)]">
                Assets{requirements.generationCount > 0 ? ` · ${requirements.generationCount} to generate` : " · all in the library"}
              </p>
              <ul className="mt-0.5 space-y-0.5 text-[10px] text-[var(--text-secondary)]">
                {requirements.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {sequence && doc && (
            <div className="mt-1.5">
              <p className="text-[10px] text-[var(--text-muted)]">
                Panel allocation · {sequence.requiredPanelCount} {sequence.requiredPanelCount === 1 ? "moment" : "moments"}
              </p>
              <p className="text-[10px] text-[var(--text-muted)]">{sequence.allocation.reason}</p>
              <ul className="mt-0.5 space-y-1 text-[10px] text-[var(--text-secondary)]">
                {sequence.beats.map((beat, index) => (
                  <li key={beat.beatId}>
                    {describeSequencePlan(sequence, doc)[index]}
                    {beat.camera && (
                      <span className="block pl-3 text-[var(--text-muted)]">
                        {describeCameraIntent(beat.camera, doc).join(" · ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {assetTrace.length > 0 && (
        <div className="rounded border border-amber-900/60 bg-amber-950/20 p-2" aria-label="Rejected steps">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-amber-500">Rejected before execution</p>
          <ul className="space-y-0.5 text-[10px] text-amber-200/90">
            {assetTrace.map((entry) => (
              <li key={entry} className="flex items-start gap-1.5">
                <PendingIcon size={10} strokeWidth={2} className="mt-1 shrink-0 opacity-70" />
                {entry}
              </li>
            ))}
          </ul>
        </div>
      )}

      {statusLine && <p className="text-zinc-300">{statusLine}</p>}
      {activity.length > 0 && (
        <p className="text-[10px] text-zinc-500" aria-label="Agent activity">
          {activity.join(" → ")}
        </p>
      )}
      {error && (
        <div className="rounded border border-red-900 bg-red-950/50 p-3 text-red-200">
          <p className="font-medium">{runSummary?.status === "failed" ? "Run failed — nothing was changed" : "Agent planning failed"}</p>
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
          {phase === "confirm" && plan && (
            <div className="mt-3 flex gap-2">
              <button
                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-white hover:bg-[var(--accent-hover)]"
                onClick={() => execute(plan, guards ?? undefined)}
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

      {/*
        The final verdict is a STATUS, not a shrug. "Done with 1 failed step"
        claimed success while the page was missing something; a partial run now
        says what is missing, what was used instead, and offers the two honest
        next actions: retry, or revert the whole run.
      */}
      {runSummary && runSummary.status === "partially_completed" && (
        <div className="rounded-md border border-amber-900/60 bg-amber-950/20 p-3" aria-label="Run partially completed">
          <p className="text-xs font-medium text-amber-300">Partially completed</p>
          <ul className="mt-1.5 space-y-1 text-[11px] text-amber-200/90">
            {runSummary.fallbacks.map((fallback) => (
              <li key={`fallback-${fallback.index}`}>
                <span className="font-medium">Fallback:</span> {fallback.detail}
              </li>
            ))}
            {runSummary.skippedSteps.map((step) => (
              <li key={`skipped-${step.index}`}>
                <span className="font-medium">Skipped:</span> {step.message}
              </li>
            ))}
            {runSummary.validationIssues
              .filter((issue) => !issue.corrected && issue.severity !== "info")
              .map((issue) => (
                <li key={issue.message}>
                  <span className="font-medium">Warning:</span> {issue.message}
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
                setPhase("idle");
                setPlan(null);
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
    </div>
  );
}

/** The character behind the user's selection — the pronoun anchor of §13. */
function selectedCharacterId(doc: ProjectDocument, itemId?: ID): ID | undefined {
  const item = itemId ? doc.items[itemId] : undefined;
  if (item?.kind !== "asset") return undefined;
  const instance = item as AssetInstance;
  return characterIdOfInstance(doc, instance);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0 text-[var(--text-muted)]">{label}:</dt>
      <dd className="min-w-0 text-[var(--text-secondary)]">{value}</dd>
    </div>
  );
}

function panelCharacterIds(doc: ProjectDocument, panelId?: ID): ID[] {
  const panel = panelId ? doc.panels[panelId] : undefined;
  if (!panel) return [];
  return panel.itemIds
    .map((id) => doc.items[id])
    .filter((item): item is AssetInstance => item?.kind === "asset")
    .map((item) => characterIdOfInstance(doc, item))
    .filter((id): id is ID => Boolean(id));
}

function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function titleCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}
