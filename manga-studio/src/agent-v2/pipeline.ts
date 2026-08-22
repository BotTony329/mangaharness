"use client";

/**
 * Agent pipeline — UNDERSTAND → PLAN → RESOLVE → CALL → VALIDATE.
 *
 * The deterministic chain that used to live inline in AgentPanel. The UI now
 * only renders what the pipeline reports through `PipelineSink`; every
 * product decision (grounding before the model is paid for, subject before
 * scope, compiled structure over model output) lives here, testable without a
 * component.
 *
 * Execution itself is the orchestrator's job (`./orchestrator`); the pipeline
 * ends with a validated plan plus the guards the run must carry.
 */

import { deriveAssetRequirements, type RequirementReport } from "@/agent/assetRequirements";
import { buildAgentContext } from "@/agent/contextBuilder";
import { groundPrompt, type GroundingReport } from "@/agent/grounding";
import { validateGroundedPlan } from "@/agent/planValidation";
import { deriveSceneIntent, type SceneIntent } from "@/agent/sceneIntent";
import { resolveAgentScope, scopeForPanels, scopeForSubject, type AgentScopePreference } from "@/agent/scope";
import { buildSequencePlan, compileSequencePlan, type SequencePlan } from "@/agent/sequencePlan";
import { resolveSubject, type SubjectResolution } from "@/agent/subject";
import type { AgentPlan } from "@/agent/tools/schemas";
import { characterIdOfInstance } from "@/characters/identity";
import type { AssetInstance, ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { countGenerations } from "./orchestrator";
import type { RunGuards } from "./types";

/** The character behind the user's selection — the pronoun anchor of §13. */
function selectedCharacterId(doc: ProjectDocument, itemId?: ID): ID | undefined {
  const item = itemId ? doc.items[itemId] : undefined;
  if (item?.kind !== "asset") return undefined;
  return characterIdOfInstance(doc, item as AssetInstance);
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

/** How many planned generations trigger an explicit confirmation. */
export const CONFIRM_THRESHOLD = 3;

export interface PipelineDiagnostics {
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

/** Everything the pipeline surfaces; each callback is optional UI plumbing. */
export interface PipelineSink {
  activity?(label: string): void;
  status?(line: string | null): void;
  grounding?(report: GroundingReport): void;
  subject?(subject: SubjectResolution | null): void;
  intent?(intent: SceneIntent | null): void;
  sequence?(plan: SequencePlan | null): void;
  requirements?(report: RequirementReport | null): void;
  scope?(scope: { label: string; demotionReason?: string }): void;
  plan?(plan: AgentPlan | null): void;
  assetTrace?(lines: string[]): void;
  skillsUsed?(skills: string[]): void;
  guards?(guards: RunGuards | null): void;
  errorDetails?(details: PipelineDiagnostics | null): void;
}

export interface PreparedRun {
  plan: AgentPlan;
  guards: RunGuards;
  sequence: SequencePlan | null;
  requirements: RequirementReport | null;
}

export type PipelineOutcome =
  | { kind: "blocked"; reason: string }
  | { kind: "empty"; message: string }
  | { kind: "confirm"; run: PreparedRun; generationCount: number }
  | { kind: "ready"; run: PreparedRun };

export async function runPipeline(
  prompt: string,
  scopePreference: AgentScopePreference,
  sink: PipelineSink = {},
): Promise<PipelineOutcome> {
  const state = useEditorStore.getState();
  if (!state.doc) throw new Error("No open project");
  const doc = state.doc;

  let scope = resolveAgentScope({
    doc,
    currentPageId: state.currentPageId,
    selection: state.selection,
    prompt,
    preference: scopePreference,
  });

  /**
   * Entity grounding runs BEFORE the model is called. Identity is decided
   * deterministically from the project, and the planner is handed the answer
   * instead of being asked to guess it.
   */
  const report = groundPrompt({
    doc,
    prompt,
    selectedCharacterId: selectedCharacterId(doc, state.selection.itemId),
    selectedInstanceId: state.selection.itemId,
    sceneCharacterIds: panelCharacterIds(doc, scope.panelId),
  });
  sink.grounding?.(report);
  sink.intent?.(null);
  sink.subject?.(null);
  sink.sequence?.(null);
  sink.requirements?.(null);

  // A reference we could not ground stops the run here — before the model is
  // paid for, before anything is generated, before anything is mutated.
  if (report.blocking.length > 0) {
    return { kind: "blocked", reason: report.blocking[0] };
  }

  /**
   * Subject, then scope, then intent — in that order. Grounding says WHO;
   * only then can scope decide whether the selection is a target or merely
   * the panel being looked at.
   */
  const resolvedSubject = resolveSubject({ doc, grounding: report });
  sink.subject?.(resolvedSubject);
  scope = scopeForSubject(scope, resolvedSubject, doc);
  sink.scope?.({ label: scope.label, demotionReason: scope.demotionReason });

  const sceneIntent = deriveSceneIntent({ doc, prompt, grounding: report, subject: resolvedSubject, scope });
  sink.intent?.(sceneIntent);
  sink.activity?.("Scene intent");

  /**
   * The sequence plan is the ENFORCED structure. Beat-to-panel mapping, layout
   * growth and camera compilation are decided deterministically here; for
   * structured requests these compiled steps replace the model's.
   */
  const sequencePlan = buildSequencePlan({
    doc,
    intent: sceneIntent,
    scope,
    characterIds:
      resolvedSubject.characterIds.length > 0
        ? resolvedSubject.characterIds
        : report.entities.filter((e) => e.characterId).map((e) => e.characterId as ID),
  });
  // A named panel widens the scope, just as a named character does.
  scope = scopeForPanels(scope, sequencePlan.allocation.panelNumbers, sequencePlan.needsPanelLevel);
  sink.scope?.({ label: scope.label, demotionReason: scope.demotionReason });
  sink.sequence?.(sequencePlan);

  /**
   * What this request NEEDS, before anything is spent. A missing asset is a
   * requirement, not a failure — the creator sees it in the plan rather than
   * discovering afterwards that the run refused.
   */
  const requirementReport = deriveAssetRequirements({
    doc,
    plan: sequencePlan,
    newCharacters: resolvedSubject.newCharacters,
  });
  sink.requirements?.(requirementReport);
  sink.activity?.("Asset requirements");

  const compiled = compileSequencePlan(sequencePlan, doc);
  const deterministic =
    compiled.length > 0 && (sequencePlan.requiredPanelCount > 1 || sequencePlan.beats.some((beat) => beat.camera));
  sink.activity?.("Panel allocation");

  const context = buildAgentContext({
    doc,
    currentPageId: state.currentPageId,
    selection: state.selection,
    scope,
    grounding: report,
    intent: sceneIntent,
  });
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, context, scope }),
  });
  const body = (await response.json()) as { error?: string; details?: PipelineDiagnostics; diagnostics?: PipelineDiagnostics };
  if (!response.ok) {
    sink.errorDetails?.(body.details ?? null);
    throw new Error(body.error ?? "Agent planning failed");
  }

  const received = body as typeof body & {
    plan: AgentPlan;
    skillsUsed: string[];
    rejected: { tool: string; error: string }[];
  };
  sink.skillsUsed?.(received.skillsUsed);
  sink.activity?.("Scene plan");

  /**
   * Deterministic steps replace the model's for structured requests. The model
   * still ran — it remains the interpretation layer for prompts with no
   * explicit structure, which is the majority.
   */
  const sourcePlan = deterministic
    ? { ...received.plan, steps: compiled, summary: received.plan.summary || sequencePlan.allocation.reason }
    : received.plan;

  // Bind names to IDs and refuse anything unresolvable, unauthorized, or
  // already satisfied by the library — all before the first mutation.
  const validated = validateGroundedPlan({
    plan: sourcePlan,
    doc,
    grounding: report,
    prompt,
    scope,
    panelCount: Math.max(scope.panelCount, ...sequencePlan.allocation.panelNumbers, 1),
  });
  sink.plan?.(validated.plan);
  sink.assetTrace?.(validated.rejected.map((entry) => `${entry.tool}: ${entry.error}`));

  if (validated.blocked) {
    return { kind: "blocked", reason: validated.blockReason ?? "The plan referenced a character that could not be resolved." };
  }
  if (validated.plan.steps.length === 0) {
    return { kind: "empty", message: validated.plan.summary || "The agent had nothing to do for that request." };
  }

  const guards: RunGuards = {
    creationAuthorized: validated.creationAuthorized,
    authorizedCreationNames: validated.authorizedCreationNames,
    selectedCharacterId: report.selectedCharacterId,
  };
  sink.guards?.(guards);
  sink.status?.(received.diagnostics?.provider ? `Plan received from ${received.diagnostics.provider}.` : "Plan received.");

  const run: PreparedRun = { plan: validated.plan, guards, sequence: sequencePlan, requirements: requirementReport };
  const generationCount = countGenerations(validated.plan);
  if (generationCount > CONFIRM_THRESHOLD) {
    return { kind: "confirm", run, generationCount };
  }
  return { kind: "ready", run };
}
