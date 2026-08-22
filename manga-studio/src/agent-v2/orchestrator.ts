"use client";

import { type CompositionIssue } from "@/domain/compositionValidation";
import type { Character } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { tonePreset } from "@/domain/tones";
import { toneForMood } from "@/tones/mood";
import type { AgentRunScope } from "@/agent/scope";
import { validateStepScope, ScopeViolationError, type AgentPlan, type ToolName } from "@/agent/tools/schemas";
import type { SequencePlan } from "@/agent/sequencePlan";
import { runStatusOf, stepPolicyFor, type FallbackUse, type StepFailure } from "@/agent/stepPolicy";
import { DENY_ALL_CREATION, type ExecutionSummary, type InteractionArgs, type RunContext, type RunGuards, type StepStatus } from "./types";
import { createRunContext } from "./process/shared";
import {
  doCreateCharacter,
  doGenerateCharacterAsset,
  doPlaceCharacter,
  doComposeCharacter,
  doSetCharacterSlot,
  doSetCharacterPoseRig,
} from "./process/characterProcess";
import { doGenerateScenery, doPlaceAsset, doReuseSceneBackground, doAddSceneRelationship } from "./process/sceneProcess";
import { doSetPageLayout, doReshapePanel, doSetCropMode, doRemoveItems } from "./process/panelProcess";
import { doAddBubble, doAttachBubble } from "./process/dialogueProcess";
import { doAddEffect, doApplyTone, doPlaceMangaEffect, doGenerateMangaEffect } from "./process/toneProcess";
import {
  doSetCamera,
  doSetPerspective,
  doSetCharacterDepth,
  doSetFocalCharacter,
  doSetPuppetExpression,
  doSetPuppetJoint,
} from "./process/cameraProcess";
import { approximateInteraction, doCreateInteraction } from "./process/interactionProcess";
import { doEditAssetRegion } from "./process/localEditProcess";
import { validatePlanResult, validateSequencePostConditions } from "./validation";

export function describeStep(step: AgentPlan["steps"][number]): string {
  const args = step.args as Record<string, unknown>;
  switch (step.tool as ToolName) {
    case "create_character":
      return `Create character "${args.name}"`;
    case "generate_character_asset":
      return `Generate ${args.kind}${args.pose ? ` (${args.pose})` : ""}${args.expression ? ` (${args.expression})` : ""} for ${args.characterName}`;
    case "generate_background":
      return `Generate background: ${String(args.description).slice(0, 40)}`;
    case "generate_prop":
      return `Generate prop: ${String(args.description).slice(0, 40)}`;
    case "set_page_layout":
      return `Set page layout to ${args.layout}`;
    case "place_asset":
      return args.target === "workspace"
        ? `Stage ${args.characterName ?? args.assetName ?? args.category ?? "asset"} on the workspace`
        : `Place ${args.characterName ?? args.assetName ?? args.category ?? "asset"} in panel ${args.panel}`;
    case "place_character":
      return `Place ${args.characterName}${args.pose ? ` (${args.pose})` : ""} in panel ${args.panel}`;
    case "compose_character":
      return `Compose ${args.characterName} in panel ${args.panel}${args.framing ? ` · ${args.framing}` : ""}`;
    case "reuse_scene_background":
      return `Reuse panel ${args.sourcePanel} background in panel ${args.targetPanel}`;
    case "add_scene_relationship":
      return `Set scene action: ${args.subjectCharacterName} ${args.action}`;
    case "set_character_slot":
      return `Change ${args.characterName ?? "selected character"} to ${[args.pose, args.expression].filter(Boolean).join(" + ") || "new slot"}`;
    case "reshape_panel":
      return `Reshape panel ${args.panel}`;
    case "set_crop_mode":
      return `Set panel ${args.panel} framing to ${args.mode}`;
    case "add_speech_bubble":
      return `Add ${args.bubbleType} to panel ${args.panel}`;
    case "add_effect":
      return `Add ${args.effectKind} to panel ${args.panel}`;
    case "apply_tone": {
      const named = args.toneAssetName ?? (args.presetId ? (tonePreset(String(args.presetId))?.name ?? args.presetId) : undefined);
      const tone = named ?? toneForMood(args.mood as string | undefined)?.name ?? "tone";
      const where = args.maskToCharacterName ? ` over ${args.maskToCharacterName}` : "";
      return `Apply ${tone} to panel ${args.panel}${where}`;
    }
    case "remove_items":
      return `Clear ${args.kind ?? "items"} from panel ${args.panel}`;
    case "edit_asset_region":
      return `Edit ${args.characterName ?? args.assetName ?? "asset"} in panel ${args.panel}: ${String(args.instruction).slice(0, 40)}`;
    case "set_camera": {
      const parts = [args.shot, args.angle, args.lens ? `${args.lens} lens` : undefined]
        .filter(Boolean)
        .map((value) => String(value).replace(/-/g, " "));
      if (typeof args.mangaPerspective === "number" && args.mangaPerspective > 0) {
        parts.push(`manga perspective ${args.mangaPerspective}`);
      }
      return `Set panel ${args.panel} camera: ${parts.join(", ") || "defaults"}`;
    }
    case "set_perspective":
      return `Set panel ${args.panel} perspective to ${String(args.type).replace(/-/g, " ")}`;
    case "set_character_depth":
      return `Move ${args.characterName ?? "character"} to the ${args.placement ?? `depth ${args.depth}`} of panel ${args.panel}`;
    case "set_focal_character":
      return `Focus panel ${args.panel} on ${args.characterName}`;
    case "set_puppet_expression":
      return `Set ${args.characterName ?? "character"} to ${args.expression} (instant)`;
    case "set_puppet_joint":
      return `Rotate ${args.characterName ?? "character"} ${args.joint} to ${args.degrees}° (instant)`;
    case "place_manga_effect":
      return `Add ${args.query} to panel ${args.panel}${args.targetCharacterName ? ` on ${args.targetCharacterName}` : ""}`;
    case "generate_manga_effect":
      return `Generate manga ${args.category}: ${String(args.description).slice(0, 40)}`;
    case "create_interaction":
      return `${args.subjectCharacterName} + ${args.targetCharacterName}: ${String(args.interaction).replace(/_/g, " ")} in panel ${args.panel}`;
    case "attach_bubble":
      return `Add ${args.bubbleType} for ${args.characterName} in panel ${args.panel}`;
    case "set_character_pose_rig": {
      const adjustments = Array.isArray(args.adjustments) ? args.adjustments.join(", ") : "";
      return `Adjust ${args.characterName ?? "character"} pose in panel ${args.panel}${adjustments ? `: ${adjustments}` : ""}`;
    }
  }
}

/**
 * Runtime authorization for one agent run.
 *
 * This is the §19 generation boundary. It is deliberately *not* derived from
 * the plan or from anything the model said: it comes from the grounding phase,
 * which read the user's own prompt. A planner that decides to create a
 * character cannot widen its own permission.
 */

export function countGenerations(plan: AgentPlan): number {
  return plan.steps.filter((s) => s.tool.startsWith("generate_")).length;
}

export async function executePlan(
  plan: AgentPlan,
  onProgress: (index: number, status: StepStatus, detail?: string) => void,
  guards: RunGuards = DENY_ALL_CREATION,
  /** The enforced semantic structure, when the request had one. */
  sequence?: SequencePlan,
): Promise<ExecutionSummary> {
  const store = useEditorStore.getState();
  const before = store.doc;
  if (!before) throw new Error("No open project");
  let completed = 0;
  let failed = 0;
  let validationIssues: CompositionIssue[] = [];
  const fallbacks: FallbackUse[] = [];
  const skippedSteps: StepFailure[] = [];

  const ctx = createRunContext(guards);

  /**
   * Snapshot → execute → validate → commit OR roll back.
   *
   * The previous shape committed unconditionally: per-step failures were
   * swallowed, validation ran after the fact, and a run that wrecked a composed
   * panel reported "Done with 1 warning". Existing work is now preserved by
   * default — a run either lands whole or does not land at all.
   */
  let rolledBack = false;
  let abortReason: string | undefined;
  store.beginTransaction();
  try {
    for (let i = 0; i < plan.steps.length; i++) {
      onProgress(i, "running", runningDetail(ctx, plan.steps[i].tool));
      try {
        await executeStep(ctx, plan.steps[i], plan.targetScope);
        completed += 1;
        onProgress(i, "done", completedDetail(ctx, plan.steps[i].tool));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Step failed";
        // A scope breach is never skippable or fallback-able, whatever the tool.
        if (error instanceof ScopeViolationError) {
          failed += 1;
          onProgress(i, "failed", message);
          abortReason = message;
          break;
        }
        const policy = stepPolicyFor(plan.steps[i].tool);

        /**
         * What a failed step MEANS is policy, not a shrug.
         *
         * A noncritical decoration is skipped and named. A required step with
         * an explicit fallback runs the fallback and the run is honest about
         * being partial. Anything else aborts and rolls the page back — the
         * rest of the plan would be composing around a hole, and "Done with 1
         * failed step" is how a shout bubble once landed in a panel with
         * nobody there to shout it.
         */
        if (!policy.required) {
          skippedSteps.push({ index: i, tool: plan.steps[i].tool, message });
          onProgress(i, "failed", `${message} — skipped (not critical to the scene)`);
          continue;
        }
        if (policy.fallback === "APPROXIMATE_COMPOSITION" && plan.steps[i].tool === "create_interaction") {
          try {
            await approximateInteraction(ctx, plan.steps[i].args as InteractionArgs);
            fallbacks.push({
              index: i,
              tool: plan.steps[i].tool,
              detail: "Approximate composition used — the joint render failed, so both characters were placed from their existing reusable assets instead.",
            });
            completed += 1;
            onProgress(i, "done", "Approximate composition used (joint render failed)");
            continue;
          } catch (fallbackError) {
            failed += 1;
            abortReason = `${message} Approximate composition also failed: ${fallbackError instanceof Error ? fallbackError.message : "no usable assets"}`;
            onProgress(i, "failed", abortReason);
            break;
          }
        }
        failed += 1;
        onProgress(i, "failed", message);
        abortReason = message;
        break;
      }
    }

    if (!abortReason) {
      validationIssues = [
        ...validatePlanResult(ctx, plan, before),
        ...(sequence ? validateSequencePostConditions(ctx, sequence, before, ctx.currentDoc()) : []),
      ];
      const fatal = validationIssues.find((issue) => issue.severity === "fatal");
      if (fatal) abortReason = fatal.message;
    }
  } catch (error) {
    abortReason = error instanceof Error ? error.message : "The run could not be completed";
  } finally {
    if (abortReason) {
      useEditorStore.getState().abortTransaction();
      rolledBack = true;
    } else {
      useEditorStore.getState().endTransaction();
    }
    ctx.guards = DENY_ALL_CREATION;
  }

  const unresolvedWarnings = validationIssues.filter(
    (issue) => !issue.corrected && issue.severity !== "info",
  ).length;
  const preservedAssets = rolledBack
    ? Object.values(ctx.currentDoc().assets)
        .filter((asset) => !before.assets[asset.id])
        .map((asset) => asset.name)
    : [];
  return {
    completed,
    failed,
    validationIssues,
    rolledBack,
    abortReason,
    fallbacks,
    skippedSteps,
    preservedAssets,
    status: runStatusOf({ rolledBack, fallbacks, skippedSteps, unresolvedWarnings }),
  };
}

export function runningDetail(ctx: RunContext, tool: ToolName): string | undefined {
  if (tool === "generate_character_asset") return "Generating image · removing background · validating cutout";
  if (tool === "place_character" || tool === "compose_character") return "Resolving a ready character cutout before composition";
}

export function completedDetail(ctx: RunContext, tool: ToolName): string | undefined {
  if (tool === "generate_character_asset") return "Image generated · character cutout ready";
  if (tool === "place_character" || tool === "compose_character") return "Character cutout ready · composed";
  // §13: reuse and generation are both stated explicitly in the run log, so a
  // creator can always see whether an image was paid for.
  if (tool === "place_manga_effect" || tool === "generate_manga_effect") return ctx.lastLanguageAction;
  // A puppet that had to escalate to generation says why.
  if (tool === "set_character_slot") return ctx.lastLanguageAction;
}

// ─── Step dispatch ──────────────────────────────────────────────────────────

export async function executeStep(ctx: RunContext, step: AgentPlan["steps"][number], scope?: AgentRunScope): Promise<void> {
  const scopeError = scope ? validateStepScope(step.tool, step.args, scope) : null;
  if (scopeError) throw new ScopeViolationError(scopeError);
  const args = step.args as never;
  switch (step.tool) {
    case "create_character":
      return doCreateCharacter(ctx, args);
    case "generate_character_asset":
      return doGenerateCharacterAsset(ctx, args);
    case "generate_background":
      return doGenerateScenery(ctx, args, "background");
    case "generate_prop":
      return doGenerateScenery(ctx, args, "prop");
    case "set_page_layout":
      return doSetPageLayout(ctx, args);
    case "place_asset":
      return doPlaceAsset(ctx, args);
    case "place_character":
      return doPlaceCharacter(ctx, args);
    case "compose_character":
      return doComposeCharacter(ctx, args);
    case "reuse_scene_background":
      return doReuseSceneBackground(ctx, args);
    case "add_scene_relationship":
      return doAddSceneRelationship(ctx, args);
    case "set_character_slot":
      return doSetCharacterSlot(ctx, args, scope);
    case "reshape_panel":
      return doReshapePanel(ctx, args);
    case "set_crop_mode":
      return doSetCropMode(ctx, args);
    case "add_speech_bubble":
      return doAddBubble(ctx, args);
    case "add_effect":
      return doAddEffect(ctx, args);
    case "apply_tone":
      return doApplyTone(ctx, args);
    case "set_camera":
      return doSetCamera(ctx, args);
    case "set_perspective":
      return doSetPerspective(ctx, args);
    case "set_character_depth":
      return doSetCharacterDepth(ctx, args);
    case "attach_bubble":
      return doAttachBubble(ctx, args);
    case "set_character_pose_rig":
      return doSetCharacterPoseRig(ctx, args);
    case "set_focal_character":
      return doSetFocalCharacter(ctx, args);
    case "set_puppet_expression":
      return doSetPuppetExpression(ctx, args);
    case "set_puppet_joint":
      return doSetPuppetJoint(ctx, args);
    case "create_interaction":
      return doCreateInteraction(ctx, args);
    case "place_manga_effect":
      return doPlaceMangaEffect(ctx, args);
    case "generate_manga_effect":
      return doGenerateMangaEffect(ctx, args);
    case "remove_items":
      return doRemoveItems(ctx, args);
    case "edit_asset_region":
      return doEditAssetRegion(ctx, args);
  }
}
