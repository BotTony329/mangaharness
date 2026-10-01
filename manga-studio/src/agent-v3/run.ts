"use client";

/**
 * Agent V3 run — the single production orchestration path.
 *
 * Literal Lock → Inventory → ONE Creative Director call (server) →
 * deterministic resolution → deterministic compile → executePlan
 * (transactional, guarded) → deterministic verification. The LLM decides
 * meaning; code decides state, identity and execution.
 */

import { executePlan } from "@/agent-v2";
import type { ExecutionSummary, RunGuards, StepStatus } from "@/agent-v2/types";
import type { AgentPlan } from "@/agent/tools/schemas";
import type { ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { literalLock } from "./contract/literalLock";
import type { CreativeTaskMap } from "./contract/creativeTaskMap";
import { projectInventory } from "./context/projectInventory";
import { resolveTaskMap, type Resolution } from "./resolution/entityResolver";
import { resolveCameraTargetPanel } from "./resolution/cameraTarget";
import { compileTaskMap, creationAuthorization } from "./routing/capabilityRouter";
import {
  panelScopeFingerprints,
  verifyTaskMap,
  type VerificationIssue,
} from "./verification/deterministicVerifier";

export interface RunV3Sink {
  activity?(label: string): void;
  status?(line: string | null): void;
  plan?(plan: AgentPlan | null): void;
}

export type RunV3Outcome =
  | { kind: "blocked"; reason: string }
  | { kind: "clarify"; question: string }
  | { kind: "confirm"; plan: AgentPlan; guards: RunGuards; generationCount: number; map: CreativeTaskMap; resolution: Resolution }
  | { kind: "ready"; plan: AgentPlan; guards: RunGuards; map: CreativeTaskMap; resolution: Resolution };

export interface RunV3Result {
  status: string;
  issues: VerificationIssue[];
  summary: string;
  execution: ExecutionSummary;
}

function contextLine(state: { currentPageId: string | null; selection: { panelId?: string } }, doc: ProjectDocument): string {
  const page = state.currentPageId ? doc.pages[state.currentPageId] : undefined;
  const panelCount = page?.panelIds.length ?? 0;
  const selectedIndex = page && state.selection.panelId ? page.panelIds.indexOf(state.selection.panelId) : -1;
  const selection = selectedIndex >= 0 ? `panel ${selectedIndex + 1} is selected` : "none";
  return `Current page: ${page?.name ?? "none"} with ${panelCount} panel(s). Selection: ${selection}.`;
}

export async function runCreativeDirection(
  prompt: string,
  sink: RunV3Sink = {},
): Promise<RunV3Outcome> {
  const state = useEditorStore.getState();
  const doc = state.doc;
  if (!doc) throw new Error("No open project");

  sink.activity?.("Understanding your scene");
  const lock = literalLock({ prompt, doc, currentPageId: state.currentPageId, selection: state.selection });
  const inventory = projectInventory(doc, state.currentPageId);

  sink.activity?.("Planning the shot");
  const response = await fetch("/api/agent/direct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      literalLock: JSON.stringify(lock),
      inventory,
      context: contextLine(state, doc),
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { kind: "blocked", reason: body?.error ?? `Creative direction failed (${response.status})` };
  }
  const { map } = (await response.json()) as { map: CreativeTaskMap };

  if (map.clarificationNeeded) return { kind: "clarify", question: map.clarificationNeeded };

  /**
   * Camera target resolution (Phase 5): one panel, never a guess. Explicit
   * target → selected panel → single-panel page; otherwise the run clarifies
   * instead of aiming the camera at an arbitrary panel.
   */
  const cameraTarget = resolveCameraTargetPanel(map, doc, {
    currentPageId: state.currentPageId,
    selection: state.selection,
  });
  if (cameraTarget.kind === "ambiguous") return { kind: "clarify", question: cameraTarget.question };
  const resolvedMap: CreativeTaskMap =
    cameraTarget.kind === "resolved" && map.target.panel === undefined
      ? { ...map, target: { ...map.target, panel: cameraTarget.panel } }
      : map;

  sink.activity?.("Preparing characters");
  const resolution = resolveTaskMap(resolvedMap, doc);
  if (resolution.unresolved.length > 0) {
    return { kind: "blocked", reason: `Could not place: ${resolution.unresolved.join(", ")}` };
  }

  const { plan, warnings } = compileTaskMap(resolvedMap, resolution);
  sink.plan?.(plan);
  for (const warning of warnings) sink.status?.(warning);
  const names = creationAuthorization(resolution);
  const guards: RunGuards = { creationAuthorized: names.length > 0, authorizedCreationNames: names };
  const generationCount = plan.steps.filter((s) => s.tool.startsWith("generate_")).length;

  if (generationCount >= 3) return { kind: "confirm", plan, guards, generationCount, map: resolvedMap, resolution };
  return { kind: "ready", plan, guards, map: resolvedMap, resolution };
}

/** Execute a prepared V3 run and verify the result against the Task Map. */
export async function executeCreativeRun(
  prepared: { plan: AgentPlan; guards: RunGuards; map: CreativeTaskMap; resolution: Resolution },
  onProgress: (index: number, status: StepStatus, detail?: string) => void,
  sink: RunV3Sink = {},
): Promise<RunV3Result> {
  const state = useEditorStore.getState();
  const before = state.doc;
  if (!before) throw new Error("No open project");
  const beforeFingerprints = panelScopeFingerprints(before);

  sink.activity?.("Composing panel");
  const summary = await executePlan(prepared.plan, onProgress, prepared.guards);

  sink.activity?.("Checking result");
  const after = useEditorStore.getState().doc;
  const verification = after
    ? verifyTaskMap(prepared.map, prepared.resolution, before, after, beforeFingerprints, state.currentPageId)
    : { issues: [], fatal: false };

  return { status: summary.status, issues: verification.issues, summary: prepared.plan.summary, execution: summary };
}
