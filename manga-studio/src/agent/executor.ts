"use client";

/**
 * Client-side plan executor. Every step runs through the same domain
 * commands the manual UI uses, inside one history transaction — a whole
 * agent run is a single undo step, and the agent has no write path of its
 * own. Failed steps are reported and skipped; the run continues so one bad
 * step doesn't waste the generations that succeeded.
 */

import { callGenerateApi, storeGeneratedAsset } from "@/ai/clientGeneration";
import { buildAssetPrompt, defaultAspect } from "@/ai/promptTemplates";
import { DEFAULT_CHARACTER_STATE, stateFromInstance } from "@/characters/state";
import { applyCharacterStateToInstance, generateCharacterAssetForState } from "@/characters/stateRuntime";
import type { DomainCommand, SemanticFraming } from "@/domain/commands";
import { validateScopeIntegrity, type CompositionIssue } from "@/domain/compositionValidation";
import type {
  AssetInstance,
  BubbleType,
  Character,
  SourceAsset,
  CropMode,
  EffectKind,
  ID,
  LayoutPresetId,
  Point,
  ProjectDocument,
  SceneDepth,
  SceneFacing,
  ScenePosition,
  MangaLanguageCategory,
  InteractionType,
  CameraAngle,
  CameraLens,
  PerspectiveType,
  ShotType,
} from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { getStyleGenerationContext, isMonochromeStyle, styleMetadata } from "@/styles/generation";
import { assetRenderUrl, isAssetReadyForComposition } from "@/assets/renderSource";
import { findUnreadyCharacterAsset, requireCharacter, requestedCharacterState, resolveCharacterAsset, resolveLibraryAsset } from "./resolver";
import { characterIdOfInstance } from "@/characters/identity";
import { tonePreset, type ToneMask } from "@/domain/tones";
import { toneForMood } from "@/tones/mood";
import { panelPxRect } from "@/domain/docHelpers";
import { hasExactState } from "./planValidation";
import { normalizeReference } from "./grounding";
import { bestLanguageAsset } from "@/language/library";
import { executeInteraction } from "@/domain/interactionService";
import { charactersInAsset } from "@/domain/interactions";
import { poseIntentFromDescriptors } from "@/characters/poseRig";
import { isPuppetInstance, puppetForInstance } from "@/domain/puppetOps";
import { canRepresentView } from "@/puppet/capability";
import type { PuppetJoint } from "@/puppet/model";
import { focalInstance } from "@/domain/stageOps";
import { framingMatchesShot, subjectCoverage } from "@/domain/staging";
import type { AgentRunScope } from "./scope";
import { validateStepScope, ScopeViolationError, type AgentPlan, type ToolName } from "./tools/schemas";
import { resolveDepthPlacements } from "./cameraIntent";
import type { SequencePlan } from "./sequencePlan";
import {
  runStatusOf,
  stepPolicyFor,
  type FallbackUse,
  type RunStatus,
  type StepFailure,
} from "./stepPolicy";

export type StepStatus = "pending" | "running" | "done" | "failed";

export interface StepProgress {
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface ExecutionSummary {
  completed: number;
  failed: number;
  validationIssues: CompositionIssue[];
  /** True when nothing was committed and the document was restored. */
  rolledBack: boolean;
  /** Why the run was abandoned, when it was. */
  abortReason?: string;
  /**
   * The product truth of the run: COMPLETED / PARTIALLY_COMPLETED / FAILED.
   * "Done with a failed step" is not a status — see `stepPolicy.ts`.
   */
  status: RunStatus;
  /** Required steps rescued by an explicit fallback, named for the creator. */
  fallbacks: FallbackUse[];
  /** Noncritical steps that failed and were skipped. */
  skippedSteps: StepFailure[];
}

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
export interface RunGuards {
  creationAuthorized: boolean;
  /** Empty means "one unnamed new character"; otherwise creation is limited to these. */
  authorizedCreationNames: string[];
  selectedCharacterId?: ID;
  /** Characters the run is expected to touch, keyed by step index for post-conditions. */
  expectedCharacterIds?: ID[];
}

const DENY_ALL_CREATION: RunGuards = { creationAuthorized: false, authorizedCreationNames: [] };

/**
 * Module-scoped because a run is strictly sequential in the browser and every
 * handler would otherwise need the same parameter threaded through it. Set and
 * cleared by `executePlan`, so a handler can never read a stale authorization
 * from a previous run.
 */
let activeGuards: RunGuards = DENY_ALL_CREATION;

/** Characters actually created during this run, for post-condition checking. */
let createdCharacterIds: ID[] = [];

export function countGenerations(plan: AgentPlan): number {
  return plan.steps.filter((s) => s.tool.startsWith("generate_")).length;
}

/** Human-readable note for the agent log about what a language step did. */
let lastLanguageAction: string | undefined;

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

  activeGuards = guards;
  createdCharacterIds = [];

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
      onProgress(i, "running", runningDetail(plan.steps[i].tool));
      try {
        await executeStep(plan.steps[i], plan.targetScope);
        completed += 1;
        onProgress(i, "done", completedDetail(plan.steps[i].tool));
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
            await approximateInteraction(plan.steps[i].args as InteractionArgs);
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
        ...validatePlanResult(plan, before),
        ...(sequence ? validateSequencePostConditions(sequence, before, currentDoc()) : []),
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
    activeGuards = DENY_ALL_CREATION;
  }

  const unresolvedWarnings = validationIssues.filter(
    (issue) => !issue.corrected && issue.severity !== "info",
  ).length;
  return {
    completed,
    failed,
    validationIssues,
    rolledBack,
    abortReason,
    fallbacks,
    skippedSteps,
    status: runStatusOf({ rolledBack, fallbacks, skippedSteps, unresolvedWarnings }),
  };
}

type InteractionArgs = {
  panel: number;
  interaction: InteractionType;
  subjectCharacterName: string;
  subjectCharacterId?: ID;
  targetCharacterName: string;
  targetCharacterId?: ID;
};

/**
 * Fallback Composition — an explicit product behaviour, not a hidden rescue.
 *
 * A joint render that failed leaves two characters who still have perfectly
 * good reusable assets. The fallback places each of them from EXISTING ready
 * assets only (generateIfMissing is false: a fallback must never spend a
 * second generation trying to fix the first). The run then reports
 * PARTIALLY COMPLETED and names what is missing — the true joint render.
 */
async function approximateInteraction(args: InteractionArgs): Promise<void> {
  const panelId = panelIdByNumber(args.panel);
  for (const who of [
    { characterName: args.subjectCharacterName, characterId: args.subjectCharacterId },
    { characterName: args.targetCharacterName, characterId: args.targetCharacterId },
  ]) {
    const { asset } = await resolveOrGenerateState(
      { characterName: who.characterName, characterId: who.characterId, generateIfMissing: false },
      "Fallback composition reuses existing assets only.",
    );
    dispatch({ type: "add-instance", panelId, assetId: asset.id });
  }
}

function runningDetail(tool: ToolName): string | undefined {
  if (tool === "generate_character_asset") return "Generating image · removing background · validating cutout";
  if (tool === "place_character" || tool === "compose_character") return "Resolving a ready character cutout before composition";
}

function completedDetail(tool: ToolName): string | undefined {
  if (tool === "generate_character_asset") return "Image generated · character cutout ready";
  if (tool === "place_character" || tool === "compose_character") return "Character cutout ready · composed";
  // §13: reuse and generation are both stated explicitly in the run log, so a
  // creator can always see whether an image was paid for.
  if (tool === "place_manga_effect" || tool === "generate_manga_effect") return lastLanguageAction;
  // A puppet that had to escalate to generation says why.
  if (tool === "set_character_slot") return lastLanguageAction;
}

// ─── Step dispatch ──────────────────────────────────────────────────────────

async function executeStep(step: AgentPlan["steps"][number], scope?: AgentRunScope): Promise<void> {
  const scopeError = scope ? validateStepScope(step.tool, step.args, scope) : null;
  if (scopeError) throw new ScopeViolationError(scopeError);
  const args = step.args as never;
  switch (step.tool) {
    case "create_character":
      return doCreateCharacter(args);
    case "generate_character_asset":
      return doGenerateCharacterAsset(args);
    case "generate_background":
      return doGenerateScenery(args, "background");
    case "generate_prop":
      return doGenerateScenery(args, "prop");
    case "set_page_layout":
      return doSetPageLayout(args);
    case "place_asset":
      return doPlaceAsset(args);
    case "place_character":
      return doPlaceCharacter(args);
    case "compose_character":
      return doComposeCharacter(args);
    case "reuse_scene_background":
      return doReuseSceneBackground(args);
    case "add_scene_relationship":
      return doAddSceneRelationship(args);
    case "set_character_slot":
      return doSetCharacterSlot(args, scope);
    case "reshape_panel":
      return doReshapePanel(args);
    case "set_crop_mode":
      return doSetCropMode(args);
    case "add_speech_bubble":
      return doAddBubble(args);
    case "add_effect":
      return doAddEffect(args);
    case "apply_tone":
      return doApplyTone(args);
    case "set_camera":
      return doSetCamera(args);
    case "set_perspective":
      return doSetPerspective(args);
    case "set_character_depth":
      return doSetCharacterDepth(args);
    case "attach_bubble":
      return doAttachBubble(args);
    case "set_character_pose_rig":
      return doSetCharacterPoseRig(args);
    case "set_focal_character":
      return doSetFocalCharacter(args);
    case "set_puppet_expression":
      return doSetPuppetExpression(args);
    case "set_puppet_joint":
      return doSetPuppetJoint(args);
    case "create_interaction":
      return doCreateInteraction(args);
    case "place_manga_effect":
      return doPlaceMangaEffect(args);
    case "generate_manga_effect":
      return doGenerateMangaEffect(args);
    case "remove_items":
      return doRemoveItems(args);
  }
}

function currentDoc(): ProjectDocument {
  const doc = useEditorStore.getState().doc;
  if (!doc) throw new Error("No open project");
  return doc;
}

function dispatch(command: DomainCommand) {
  return useEditorStore.getState().dispatch(command);
}

function panelIdByNumber(panel: number): ID {
  const state = useEditorStore.getState();
  const doc = currentDoc();
  const page = state.currentPageId ? doc.pages[state.currentPageId] : null;
  if (!page) throw new Error("No current page");
  const panelId = page.panelIds[panel - 1];
  if (!panelId) throw new Error(`Panel ${panel} does not exist (page has ${page.panelIds.length})`);
  return panelId;
}

/**
 * Persistent Character creation — the privileged operation.
 *
 * The guard here is the last line of defence and repeats the plan-validation
 * check on purpose: plan validation protects against a bad plan, this protects
 * against a bad *executor caller*. Failing to resolve a name is never grounds
 * for creating a character, so an unauthorized run throws instead of quietly
 * adding one to the library.
 */
function doCreateCharacter(args: { name: string; appearance?: string; personalityNotes?: string; description?: string }): void {
  const doc = currentDoc();
  // Idempotent: re-creating an existing character would fork the library.
  const existing = requireCharacterOrNull(doc, { characterName: args.name });
  if (existing) return;

  if (!activeGuards.creationAuthorized) {
    throw new Error(
      `Refusing to create the character "${args.name}": this run has no character-creation authorization. Ask for a new character explicitly.`,
    );
  }
  const authorized = activeGuards.authorizedCreationNames;
  if (authorized.length > 0 && !authorized.includes(normalizeReference(args.name))) {
    throw new Error(`Creation was authorized for ${authorized.join(", ")}, not "${args.name}".`);
  }
  const created = dispatch({
    type: "create-character",
    name: args.name,
    appearance: args.appearance ?? args.description,
    personalityNotes: args.personalityNotes,
  });
  if (created.createdId) createdCharacterIds.push(created.createdId);
}

/** Resolution that reports "no unambiguous match" rather than throwing. */
function requireCharacterOrNull(
  doc: ProjectDocument,
  args: { characterId?: string; characterName?: string },
): ReturnType<typeof requireCharacter> | null {
  try {
    return requireCharacter(doc, args, { selectedCharacterId: activeGuards.selectedCharacterId });
  } catch {
    return null;
  }
}

async function doGenerateCharacterAsset(
  args: { characterName: string; characterId?: ID; kind: "reference" | "pose" | "expression"; pose?: string; expression?: string; outfit?: string; view?: string; instruction?: string },
): Promise<void> {
  const doc = currentDoc();
  const character = requireCharacter(doc, args, { selectedCharacterId: activeGuards.selectedCharacterId });

  const desired = {
    characterId: character.id,
    pose: args.pose?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.pose,
    expression: args.expression?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.expression,
    outfit: args.outfit?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.outfit,
    view: args.view?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.view,
  };
  // §9: re-check at the generation boundary, against the CURRENT document.
  // The plan was validated against an older document; an earlier step in this
  // same run may have produced exactly this asset.
  if (args.kind !== "reference" && hasExactState(doc, character, desired)) {
    throw new Error(
      `${character.name} already has a ${desired.pose}/${desired.expression} state — reused instead of generating a duplicate.`,
    );
  }
  const assetId = await generateCharacterAssetForState({
    characterId: character.id,
    role: args.kind === "reference" ? "canonical" : "state",
    instruction: args.instruction,
    state: desired,
  });
  stageOnWorkspace(assetId);
}

async function doGenerateScenery(
  args: { description: string; name?: string },
  category: "background" | "prop",
): Promise<void> {
  const doc = currentDoc();
  const style = getStyleGenerationContext(doc);
  const prompt = buildAssetPrompt({
    assetType: category,
    description: args.description,
    style: style.profile,
    monochrome: isMonochromeStyle(style.profile),
  });
  const result = await callGenerateApi({
    assetType: category,
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: defaultAspect(category),
    expectMonochrome: isMonochromeStyle(style.profile),
    referenceUrls: style.referenceAsset ? [assetRenderUrl(style.referenceAsset)!] : undefined,
  });
  const assetId = await storeGeneratedAsset({
    result,
    assetType: category,
    category,
    name: args.name ?? args.description.slice(0, 40),
    prompt,
    metadata: styleMetadata(style),
  });
  stageOnWorkspace(assetId);
}

/**
 * Agent-generated results are staged as loose items beside the page — the
 * creator reviews spatially (compare, drag into a panel, or delete) instead
 * of results vanishing into the library.
 */
function stageOnWorkspace(assetId: ID): void {
  const state = useEditorStore.getState();
  const doc = state.doc;
  const page = state.currentPageId ? doc?.pages[state.currentPageId] : null;
  if (!doc || !page) return;
  const index = doc.workspaceOrder.length;
  const at: Point = {
    x: page.workspace.x + doc.project.settings.pageWidth + 300 + Math.floor(index / 4) * 400,
    y: page.workspace.y + 220 + (index % 4) * 420,
  };
  dispatch({ type: "add-workspace-instance", assetId, at });
}

function doSetPageLayout(args: { layout: LayoutPresetId }): void {
  const pageId = useEditorStore.getState().currentPageId;
  if (!pageId) throw new Error("No current page");
  dispatch({ type: "set-page-layout", pageId, layout: args.layout });
}

async function doPlaceAsset(args: {
  panel?: number;
  target?: "panel" | "workspace";
  characterName?: string;
  characterId?: ID;
  pose?: string;
  expression?: string;
  outfit?: string;
  view?: string;
  assetName?: string;
  category?: "character" | "background" | "prop" | "upload";
  cropMode?: CropMode;
  flipX?: boolean;
}): Promise<void> {
  const doc = currentDoc();
  if (args.characterName) return doPlaceCharacter({ ...args, characterName: args.characterName });
  const asset = resolveLibraryAsset(doc, { assetName: args.assetName, category: args.category });
  if (!asset) {
    throw new Error(
      `No library asset matches ${args.characterName ?? args.assetName ?? args.category ?? "the request"}`,
    );
  }

  if (args.target === "workspace" || args.panel === undefined) {
    stageOnWorkspace(asset.id);
    return;
  }

  const panelId = panelIdByNumber(args.panel);
  const placed = dispatch({ type: "add-instance", panelId, assetId: asset.id, cropMode: args.cropMode });
  if (args.flipX && placed.createdId) dispatch({ type: "set-instance-props", instanceId: placed.createdId, patch: { flipX: true } });
}

async function doPlaceCharacter(args: {
  panel?: number;
  target?: "panel" | "workspace";
  characterName: string;
  characterId?: ID;
  pose?: string;
  expression?: string;
  outfit?: string;
  view?: string;
  cropMode?: CropMode;
  flipX?: boolean;
  generateIfMissing?: boolean;
}): Promise<void> {
  const { asset } = await resolveOrGenerateState(
    args,
    "Create the missing reusable state requested for placement in the manga page.",
  );

  if (args.target === "workspace" || args.panel === undefined) {
    stageOnWorkspace(asset.id);
    return;
  }
  const panelId = panelIdByNumber(args.panel);
  const placed = dispatch({ type: "add-instance", panelId, assetId: asset.id, cropMode: args.cropMode });
  if (args.flipX && placed.createdId) dispatch({ type: "set-instance-props", instanceId: placed.createdId, patch: { flipX: true } });
}


/**
 * REUSE → MODIFY → GENERATE, in that order, for one character state (§8/§9).
 *
 * Identity is resolved first and exactly once, from the ID grounding bound to
 * the step. Only then is the asset searched. The library is re-checked
 * immediately before generation against the CURRENT document, because the plan
 * was validated against an older one and an earlier step in this same run may
 * already have produced the asset.
 */
async function resolveOrGenerateState(
  args: {
    characterName: string;
    characterId?: ID;
    pose?: string;
    expression?: string;
    outfit?: string;
    view?: string;
    generateIfMissing?: boolean;
  },
  instruction: string,
): Promise<{ character: Character; asset: SourceAsset }> {
  let doc = currentDoc();
  const character = requireCharacter(doc, args, { selectedCharacterId: activeGuards.selectedCharacterId });
  const query = { pose: args.pose, expression: args.expression, outfit: args.outfit, view: args.view };
  const desired = requestedCharacterState(character.id, query);

  let asset = resolveCharacterAsset(doc, character, query);
  if (!asset) {
    const blocked = findUnreadyCharacterAsset(doc, character, desired);
    if (blocked) {
      throw new Error(`Background removal failed for "${blocked.name}" — retry it in the library before composing.`);
    }
    if (args.generateIfMissing === false) {
      throw new Error(`No cached state matches ${character.name}; generation was disabled`);
    }
    // Independent re-check at the generation boundary.
    doc = currentDoc();
    const recheck = resolveCharacterAsset(doc, character, query);
    if (recheck) {
      asset = recheck;
    } else {
      const assetId = await generateCharacterAssetForState({
        characterId: character.id,
        role: "state",
        state: desired,
        instruction,
      });
      doc = currentDoc();
      asset = doc.assets[assetId] ?? null;
    }
  }
  if (!asset || !isAssetReadyForComposition(asset)) {
    throw new Error(`Unable to resolve a ready reusable state for ${character.name}`);
  }
  return { character, asset };
}

async function doComposeCharacter(args: {
  panel: number;
  characterName: string;
  characterId?: ID;
  pose?: string;
  expression?: string;
  outfit?: string;
  view?: string;
  framing?: SemanticFraming;
  position?: ScenePosition;
  facing?: SceneFacing;
  depth?: SceneDepth;
  role?: string;
  generateIfMissing?: boolean;
}): Promise<void> {
  const { character, asset } = await resolveOrGenerateState(
    args,
    "Create the missing reusable character state for semantic scene composition.",
  );
  dispatch({
    type: "compose-character",
    panelId: panelIdByNumber(args.panel),
    characterId: character.id,
    assetId: asset.id,
    framing: args.framing,
    position: args.position,
    facing: args.facing,
    depth: args.depth,
    role: args.role,
  });
}

function doReuseSceneBackground(args: { sourcePanel: number; targetPanel: number }): void {
  dispatch({
    type: "reuse-panel-background",
    sourcePanelId: panelIdByNumber(args.sourcePanel),
    targetPanelId: panelIdByNumber(args.targetPanel),
  });
}

function doAddSceneRelationship(args: {
  panel: number;
  subjectCharacterName: string;
  subjectCharacterId?: ID;
  action: string;
  targetCharacterName?: string;
  targetCharacterId?: ID;
}): void {
  const doc = currentDoc();
  const subject = requireCharacter(doc, {
    characterId: args.subjectCharacterId,
    characterName: args.subjectCharacterName,
  });
  const target =
    args.targetCharacterId ?? args.targetCharacterName
      ? requireCharacter(doc, { characterId: args.targetCharacterId, characterName: args.targetCharacterName })
      : null;
  dispatch({
    type: "add-scene-relationship",
    panelId: panelIdByNumber(args.panel),
    subjectCharacterId: subject.id,
    action: args.action,
    targetCharacterId: target?.id,
  });
}

/**
 * Semantic slot change on an already-placed character instance — the tool
 * behind "make her cry". Reuse an exact-matching library asset when one
 * exists; otherwise generate the missing slot, then swap the instance while
 * the composition stays put.
 */
async function doSetCharacterSlot(
  args: { panel?: number; characterName?: string; characterId?: ID; pose?: string; expression?: string; outfit?: string; view?: string; generateIfMissing?: boolean },
  scope?: AgentRunScope,
): Promise<void> {
  if (!args.pose && !args.expression && !args.outfit && !args.view) {
    throw new Error("set_character_slot needs a pose, expression, outfit, or view");
  }
  const doc = currentDoc();
  const instance = findTargetInstance(doc, args, scope);
  if (!stateFromInstance(doc, instance)) throw new Error("The targeted instance is not a character");

  /**
   * The capability gate for puppets (V3.2 §12).
   *
   * A view change — "turn Yuri completely around" — is something a front-facing
   * set of parts genuinely cannot represent. The agent must not discover that
   * by producing something broken, so the boundary is named explicitly here and
   * the run then takes the SANCTIONED fallback: generate the artwork. The point
   * is that the escalation is deliberate and logged, not accidental.
   */
  const puppet = puppetForInstance(doc, instance);
  if (puppet && args.view) {
    const capability = canRepresentView(puppet, args.view);
    if (!capability.supported) {
      lastLanguageAction = `${capability.reason} ${capability.fallbackRecommendation ?? ""}`.trim();
    }
  }
  await applyCharacterStateToInstance({
    instanceId: instance.id,
    patch: { pose: args.pose, expression: args.expression, outfit: args.outfit, view: args.view },
    generateIfMissing: args.generateIfMissing,
  });
}

/** Resolve which character instance a slot change targets: explicit panel/name, else the user's selection. */
function findTargetInstance(
  doc: ProjectDocument,
  args: { panel?: number; characterName?: string; characterId?: ID },
  scope?: AgentRunScope,
): AssetInstance {
  const state = useEditorStore.getState();
  const named = args.characterId !== undefined || args.characterName !== undefined;
  const characterByName = named
    ? requireCharacter(doc, args, { selectedCharacterId: activeGuards.selectedCharacterId })
    : null;

  /**
   * Precedence: an explicitly grounded character outranks the selection.
   *
   * This block used to run FIRST and unconditionally, so a selected lamp became
   * the target of "make Cute Girl run" and the step died on "the scoped object
   * is not a character asset". Selection is evidence about which panel the
   * creator is working in; it is not a claim about who they mean.
   *
   * The selected object is consulted only when the step named nobody.
   */
  if (!named && scope?.kind === "selected-object" && scope.itemId) {
    const item = doc.items[scope.itemId];
    /**
     * A non-character selection is not an error here. It simply carries no
     * character, so resolution falls through to the panel search below and
     * fails with a message about what was actually missing.
     */
    if (item?.kind === "asset") {
      const characterId = item.characterState?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId;
      if (characterId) return item;
    }
  }

  const candidates: AssetInstance[] = [];
  const collect = (panelId: ID | undefined) => {
    for (const id of (panelId && doc.panels[panelId]?.itemIds) || []) {
      const item = doc.items[id];
      if (item?.kind === "asset") candidates.push(item);
    }
  };

  if (args.panel !== undefined) {
    collect(panelIdByNumber(args.panel));
  } else if (characterByName) {
    /**
     * A named character with no panel given: look in the panel the creator is
     * working in first, then across the scoped page. Falling back to "whatever
     * is selected" is what let an unrelated object answer for a named subject.
     */
    collect(scope?.panelId);
    if (candidates.length === 0) {
      const page = scope ? doc.pages[scope.pageId] : undefined;
      for (const panelId of page?.panelIds ?? []) collect(panelId);
    }
  } else if (state.selection.itemId) {
    const item = doc.items[state.selection.itemId];
    if (item?.kind === "asset") candidates.push(item);
  }

  const matching = candidates.filter((item) => {
    const meta = doc.assets[item.sourceAssetId]?.metadata;
    if (!meta?.characterId) return false;
    return characterByName ? meta.characterId === characterByName.id : true;
  });
  const target = matching[matching.length - 1];
  if (!target) {
    throw new Error(
      characterByName
        ? `${characterByName.name} is not placed in ${args.panel !== undefined ? `panel ${args.panel}` : "this scope"} yet — place them first`
        : args.panel !== undefined
          ? `No character instance found in panel ${args.panel}`
          : "No character instance is selected — select one or specify a panel",
    );
  }
  return target;
}

function doReshapePanel(args: { panel: number; points: Point[] }): void {
  const panelId = panelIdByNumber(args.panel);
  dispatch({ type: "reshape-panel", panelId, points: args.points });
}

function doSetCropMode(args: {
  panel: number;
  characterName?: string;
  characterId?: ID;
  category?: "character" | "background" | "prop" | "upload";
  mode: CropMode;
}): void {
  const doc = currentDoc();
  const panelId = panelIdByNumber(args.panel);
  const panel = doc.panels[panelId];

  const targets = panel.itemIds
    .map((id) => doc.items[id])
    .filter((item) => item?.kind === "asset")
    .filter((item) => {
      const asset = doc.assets[(item as { sourceAssetId: ID }).sourceAssetId];
      if (!asset) return false;
      if (args.characterId ?? args.characterName) {
        const character = requireCharacter(doc, args);
        return asset.metadata?.characterId === character.id;
      }
      if (args.category) return asset.category === args.category;
      return asset.category === "character"; // default target: the character shot
    });
  const target = targets[targets.length - 1];
  if (!target) throw new Error(`Nothing to reframe in panel ${args.panel}`);
  dispatch({ type: "set-framing", instanceId: target.id, cropMode: args.mode });
}

function doAddBubble(args: {
  panel: number;
  bubbleType: BubbleType;
  text: string;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
}): void {
  const panelId = panelIdByNumber(args.panel);
  const rect = panelPxRect(currentDoc(), panelId);
  const anchors: Record<string, { x: number; y: number }> = {
    "top-left": { x: rect.width * 0.28, y: rect.height * 0.18 },
    "top-right": { x: rect.width * 0.72, y: rect.height * 0.18 },
    "bottom-left": { x: rect.width * 0.28, y: rect.height * 0.8 },
    "bottom-right": { x: rect.width * 0.72, y: rect.height * 0.8 },
    center: { x: rect.width * 0.5, y: rect.height * 0.5 },
  };
  const at = anchors[args.position ?? "top-left"];
  dispatch({ type: "add-bubble", panelId, bubbleType: args.bubbleType, text: args.text, at });
}

function doAddEffect(args: { panel: number; effectKind: EffectKind }): void {
  const panelId = panelIdByNumber(args.panel);
  dispatch({ type: "add-effect", panelId, effectKind: args.effectKind });
}

/**
 * Lay a tone over a panel (§16).
 *
 * Goes through the SAME `add-tone` command the Tones shelf dispatches, so an
 * Agent-applied tone is an ordinary tone layer the creator can edit, reorder,
 * hide and delete. There is no Agent-only tone path, and nothing here can bake
 * tone into artwork because no such command exists.
 */
function doApplyTone(args: {
  panel: number;
  presetId?: string;
  toneAssetName?: string;
  toneAssetId?: string;
  mood?: string;
  opacity?: number;
  maskToCharacterName?: string;
  maskToCharacterId?: string;
}): void {
  const doc = currentDoc();
  const panelId = panelIdByNumber(args.panel);

  const assetId = args.toneAssetId
    ? args.toneAssetId
    : args.toneAssetName
      ? Object.values(doc.assets).find(
          (asset) => asset.category === "tone" && asset.name.toLowerCase() === args.toneAssetName!.toLowerCase(),
        )?.id
      : undefined;

  let presetId = args.presetId && tonePreset(args.presetId) ? args.presetId : undefined;
  if (!assetId && !presetId) {
    const fromMood = toneForMood(args.mood ?? args.presetId ?? args.toneAssetName);
    if (!fromMood) {
      throw new Error(
        `No tone matches "${args.mood ?? args.presetId ?? args.toneAssetName ?? "that"}". Name a tone from the Tones shelf, or describe the mood.`,
      );
    }
    presetId = fromMood.id;
  }

  /**
   * "Add screentone to her shirt."
   *
   * A shirt is not a region this can resolve — it is inside the character's
   * artwork, and guessing at it would put tone on a face. What CAN be resolved
   * safely is where that character stands, so the tone is confined to them and
   * the creator refines it with the mask editor. Covering the whole panel when
   * a specific character was named would be the wrong answer quietly.
   */
  const mask = args.maskToCharacterName || args.maskToCharacterId ? maskOverCharacter(doc, panelId, args) : undefined;

  const created = dispatch({ type: "add-tone", panelId, presetId, assetId, mask });
  if (created.createdId && args.opacity !== undefined) {
    dispatch({ type: "update-tone", itemId: created.createdId, patch: { opacity: args.opacity } });
  }
}

/** The rectangle a named character occupies in this panel, normalized. */
function maskOverCharacter(
  doc: ProjectDocument,
  panelId: ID,
  args: { maskToCharacterName?: string; maskToCharacterId?: string },
): ToneMask | undefined {
  const character = requireCharacterOrNull(doc, {
    characterId: args.maskToCharacterId,
    characterName: args.maskToCharacterName,
  });
  if (!character) return undefined;
  const instance = doc.panels[panelId]?.itemIds
    .map((id) => doc.items[id])
    .find((item) => item?.kind === "asset" && characterIdOfInstance(doc, item) === character.id);
  if (!instance) return undefined;

  const rect = panelPxRect(doc, panelId);
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    shapes: [
      {
        kind: "rect",
        x: Math.max(0, (instance.cx - instance.width / 2) / rect.width),
        y: Math.max(0, (instance.cy - instance.height / 2) / rect.height),
        width: Math.min(1, instance.width / rect.width),
        height: Math.min(1, instance.height / rect.height),
      },
    ],
  };
}

function doRemoveItems(args: { panel: number; kind?: "asset" | "bubble" | "effect" }): void {
  const doc = currentDoc();
  const panelId = panelIdByNumber(args.panel);
  const toRemove = doc.panels[panelId].itemIds.filter((id) => {
    const item = doc.items[id];
    return item && (!args.kind || item.kind === args.kind);
  });
  for (const itemId of toRemove) dispatch({ type: "delete-instance", instanceId: itemId });
}



/**
 * Coordinated multi-character action (P0.3/P0.4).
 *
 * Delegates to the SAME service the Inspector's Hug button uses, so the Agent
 * cannot acquire a different notion of what a hug is. The service decides
 * whether the action is local placement, a shared anchor, or one joint render
 * carrying both identity references — and performs the real provider call.
 *
 * Never satisfied by overlapping two existing sprites.
 */
async function doCreateInteraction(args: {
  panel: number;
  interaction: InteractionType;
  subjectCharacterName: string;
  subjectCharacterId?: ID;
  targetCharacterName: string;
  targetCharacterId?: ID;
  expressions?: Record<string, string>;
}): Promise<void> {
  const panelId = panelIdByNumber(args.panel);
  const doc = currentDoc();
  const subject = requireCharacter(doc, {
    characterId: args.subjectCharacterId,
    characterName: args.subjectCharacterName,
  });
  const target = requireCharacter(doc, {
    characterId: args.targetCharacterId,
    characterName: args.targetCharacterName,
  });
  if (subject.id === target.id) throw new Error("An interaction needs two different characters");

  // Expressions arrive keyed by NAME; resolve each through the same grounding
  // resolver so "Yuri" cannot quietly become someone else here either.
  const expressions: Record<ID, string> = {};
  for (const [name, expression] of Object.entries(args.expressions ?? {})) {
    const character = requireCharacter(doc, { characterName: name });
    expressions[character.id] = expression.trim().toLowerCase();
  }

  const outcome = await executeInteraction({
    panelId,
    participantIds: [subject.id, target.id],
    type: args.interaction,
    expressions,
  });

  lastLanguageAction = outcome.reusedCache
    ? `Reused an existing ${args.interaction.replace(/_/g, " ")} render`
    : outcome.generationCalls > 0
      ? `Drawn once using both ${subject.name} and ${target.name} as references`
      : `Arranged locally — no generation`;

  /**
   * Post-condition: a joint render must actually contain both participants.
   * A composite that lost someone is a fatal outcome, not a warning.
   */
  if (outcome.assetId) {
    const participants = charactersInAsset(currentDoc(), outcome.assetId);
    for (const id of [subject.id, target.id]) {
      if (!participants.includes(id)) {
        throw new Error(`The generated interaction does not contain ${currentDoc().characters[id]?.name ?? id}`);
      }
    }
  }
}

// ─── Manga Language Library: SEARCH → REUSE → GENERATE → PLACE (§12) ────────

/**
 * Place an existing manga-language asset.
 *
 * The library is searched first and only reused — this handler cannot
 * generate. Failing loudly with the name of the fallback tool is what keeps
 * "add a shocked effect" from silently costing an image generation when a
 * perfectly good built-in Shock effect is already on the shelf.
 */
function doPlaceMangaEffect(args: {
  panel: number;
  query: string;
  category?: MangaLanguageCategory;
  targetCharacterName?: string;
  targetCharacterId?: ID;
  text?: string;
}): void {
  const doc = currentDoc();
  const panelId = panelIdByNumber(args.panel);
  const asset = bestLanguageAsset(doc, { category: args.category, text: args.query });
  if (!asset) {
    throw new Error(
      `No manga-language asset matches "${args.query}". Use generate_manga_effect to create one, then place it.`,
    );
  }
  placeLanguageAssetOnTarget(doc, panelId, asset.id, args, args.text);
  lastLanguageAction = `Reused "${asset.name}" (${asset.source})`;
}

/**
 * Generate a new manga-language asset, add it to the library, then place it.
 *
 * The library is re-checked here against the CURRENT document as well as in
 * plan validation, because an earlier step in this same run may already have
 * created what this step is about to pay for.
 */
async function doGenerateMangaEffect(args: {
  description: string;
  category: MangaLanguageCategory;
  name?: string;
  panel?: number;
  targetCharacterName?: string;
  targetCharacterId?: ID;
}): Promise<void> {
  let doc = currentDoc();
  const existing = bestLanguageAsset(doc, { category: args.category, text: args.description });
  if (existing) {
    throw new Error(`"${existing.name}" already covers that — reuse it with place_manga_effect instead of generating.`);
  }

  const style = getStyleGenerationContext(doc);
  const prompt = buildAssetPrompt({
    assetType: "manga-effect",
    description: args.description,
    languageCategory: args.category,
    style: style.profile,
    // Project style governs generated language too, so a monochrome project
    // cannot acquire a full-colour sparkle (§16).
    monochrome: isMonochromeStyle(style.profile),
  });
  const result = await callGenerateApi({
    assetType: "manga-effect",
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: "square",
    expectMonochrome: isMonochromeStyle(style.profile),
    referenceUrls: style.referenceAsset ? [assetRenderUrl(style.referenceAsset)!] : undefined,
  });
  const name = args.name ?? args.description.slice(0, 40);
  const assetId = await storeGeneratedAsset({
    result,
    assetType: "manga-effect",
    category: "prop",
    name,
    prompt,
    metadata: styleMetadata(style),
  });
  const created = dispatch({
    type: "add-language-asset",
    input: {
      category: args.category,
      name,
      source: "ai-generated",
      format: "visual",
      assetId,
      tags: [args.category, ...args.description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)].slice(0, 12),
      generationMetadata: { prompt, styleProfileId: style.profile.id, createdAt: new Date().toISOString() },
    },
  });
  if (!created.createdId) throw new Error("Generated effect could not be registered in the library");
  lastLanguageAction = `Generated "${name}" and added it to the library`;

  if (args.panel === undefined) return;
  doc = currentDoc();
  placeLanguageAssetOnTarget(doc, panelIdByNumber(args.panel), created.createdId, args);
}

function placeLanguageAssetOnTarget(
  doc: ProjectDocument,
  panelId: ID,
  languageAssetId: ID,
  ref: { targetCharacterName?: string; targetCharacterId?: ID },
  text?: string,
): void {
  // Attaching is what makes "around Yuri" mean something: the effect keeps its
  // relationship to the subject when the subject is moved or restaged.
  const target =
    ref.targetCharacterId ?? ref.targetCharacterName
      ? characterInstanceInPanel(doc, panelId, {
          characterName: ref.targetCharacterName,
          characterId: ref.targetCharacterId,
        })
      : undefined;
  const placed = dispatch({
    type: "place-language-asset",
    panelId,
    languageAssetId,
    text,
    attachToItemId: target?.id,
    at: target ? { x: target.cx, y: target.cy - target.height * 0.35 } : undefined,
  });
  if (!placed.createdId) throw new Error("The effect could not be placed");
}

function validatePlanResult(plan: AgentPlan, before: ProjectDocument): CompositionIssue[] {
  const state = useEditorStore.getState();
  const page = state.currentPageId ? currentDoc().pages[state.currentPageId] : undefined;
  if (!page) return [];
  const panelNumbers = new Set<number>();
  for (const step of plan.steps) {
    const panel = step.tool === "reuse_scene_background" ? step.args.targetPanel : step.args.panel;
    if (typeof panel === "number") panelNumbers.add(panel);
  }
  const panelIds = panelNumbers.size > 0
    ? [...panelNumbers].map((number) => page.panelIds[number - 1]).filter((id): id is ID => Boolean(id))
    : plan.targetScope?.kind === "selected-object" || plan.targetScope?.kind === "selected-panel"
      ? [plan.targetScope.panelId].filter((id): id is ID => Boolean(id))
      : page.panelIds;
  const validated = dispatch({ type: "validate-composition", panelIds, before });
  const after = validated.doc;
  const scopeIssues = plan.targetScope ? validateScopeIntegrity(before, after, plan.targetScope) : [];
  return [...(validated.issues ?? []), ...scopeIssues, ...validateIdentityPostConditions(plan, before, after)];
}


/**
 * Validate the SEMANTIC plan, not merely that commands ran.
 *
 * A run can execute every step it was given and still have failed the request:
 * both beats in one panel, the dialogue attached to the wrong frame, a camera
 * instruction quietly dropped. These invariants are checked against the
 * document that actually exists, and any breach is fatal — a half-executed
 * sequence is worse than none, because the creator has to work out which half.
 */
function validateSequencePostConditions(
  sequence: SequencePlan,
  before: ProjectDocument,
  after: ProjectDocument,
): CompositionIssue[] {
  const issues: CompositionIssue[] = [];
  const page = after.pages[sequence.pageId];
  if (!page) return issues;

  const panelId = (number: number): ID | undefined => page.panelIds[number - 1];
  const fatal = (code: CompositionIssue["code"], panel: ID | undefined, message: string) =>
    issues.push({ code, panelId: panel ?? page.panelIds[0] ?? "", message, corrected: false, severity: "fatal" });

  // 1. The panels the sequence needs must exist.
  const wanted = new Set(sequence.beats.map((beat) => beat.panelNumber));
  for (const number of wanted) {
    if (!panelId(number)) {
      fatal("required-character-missing", undefined, `Panel ${number} was needed for this sequence but does not exist`);
    }
  }
  if (wanted.size < sequence.requiredPanelCount) {
    fatal("required-character-missing", undefined, `The request needed ${sequence.requiredPanelCount} separate moments but only ${wanted.size} panels were used`);
  }

  for (const beat of sequence.beats) {
    const id = panelId(beat.panelNumber);
    if (!id) continue;
    const panel = after.panels[id];
    const items = (panel?.itemIds ?? []).map((itemId) => after.items[itemId]);

    // 2. Every subject is actually in its beat's panel.
    for (const characterId of beat.subjects) {
      const present = items.some((item) => {
        if (item?.kind !== "asset") return false;
        const owner = item.characterState?.characterId ?? after.assets[item.sourceAssetId]?.metadata?.characterId;
        return owner === characterId || charactersInAsset(after, item.sourceAssetId).includes(characterId);
      });
      if (!present) {
        fatal("required-character-missing", id, `${after.characters[characterId]?.name ?? characterId} is missing from panel ${beat.panelNumber}`);
      }
    }

    // 3. Dialogue exists, in the right panel, with the right words.
    if (beat.dialogue) {
      const bubble = items.find((item) => item?.kind === "bubble" && item.text.trim() === beat.dialogue!.text.trim());
      if (!bubble) {
        fatal("required-character-missing", id, `The line “${beat.dialogue.text}” is not in panel ${beat.panelNumber}`);
      }
    }

    // 4. Camera intent reached the document.
    if (beat.camera) {
      const camera = panel?.camera;
      if (beat.camera.shot && camera?.shot !== beat.camera.shot) {
        fatal("scope-integrity", id, `Panel ${beat.panelNumber} should be a ${beat.camera.shot.replace(/-/g, " ")} shot`);
      }
      if (beat.camera.angle && camera?.angle !== beat.camera.angle) {
        fatal("scope-integrity", id, `Panel ${beat.panelNumber} should be a ${beat.camera.angle.replace(/-/g, " ")} angle`);
      }
      if (beat.camera.lens && camera?.lens !== beat.camera.lens) {
        fatal("scope-integrity", id, `Panel ${beat.panelNumber} should use the ${beat.camera.lens} lens`);
      }
      if (beat.camera.perspective && panel?.perspective?.type !== beat.camera.perspective) {
        fatal("scope-integrity", id, `Panel ${beat.panelNumber} should use ${beat.camera.perspective.replace(/-/g, " ")} perspective`);
      }

      /**
       * Depth is checked as ORDER, not as a number: the request said who is in
       * front, and only the relative result is a promise we made.
       */
      const depthOf = (characterId: ID): number | undefined => {
        const item = items.find((entry) => {
          if (entry?.kind !== "asset") return false;
          const owner = entry.characterState?.characterId ?? after.assets[entry.sourceAssetId]?.metadata?.characterId;
          return owner === characterId;
        });
        return item?.kind === "asset" ? item.stage?.depth : undefined;
      };
      for (const relation of beat.camera.relations ?? []) {
        const near = depthOf(relation.nearerCharacterId);
        const far = depthOf(relation.fartherCharacterId);
        if (near !== undefined && far !== undefined && near > far) {
          fatal(
            "scope-integrity",
            id,
            `${after.characters[relation.nearerCharacterId]?.name ?? "one character"} should be nearer the camera than ${after.characters[relation.fartherCharacterId]?.name ?? "the other"}`,
          );
        }
      }
      for (const placement of resolveDepthPlacements(beat.camera)) {
        const item = items.find((entry) => {
          if (entry?.kind !== "asset") return false;
          const owner = entry.characterState?.characterId ?? after.assets[entry.sourceAssetId]?.metadata?.characterId;
          return owner === placement.characterId;
        });
        if (item?.kind === "asset" && item.stage && placement.placement === "foreground" && item.stage.depth > 0.5) {
          fatal("scope-integrity", id, `${after.characters[placement.characterId]?.name ?? "a character"} should be in the foreground of panel ${beat.panelNumber}`);
        }
      }
    }
  }

  /**
   * 5. Panels the sequence never mentioned keep their content. Growing a layout
   * is allowed to move items between panel records, so this compares the SET of
   * items on the page rather than per-panel membership.
   */
  const beforeItems = new Set(
    (before.pages[sequence.pageId]?.panelIds ?? []).flatMap((id) => before.panels[id]?.itemIds ?? []),
  );
  const afterItems = new Set(page.panelIds.flatMap((id) => after.panels[id]?.itemIds ?? []));
  const lost = [...beforeItems].filter((id) => !afterItems.has(id));
  if (lost.length > 0) {
    fatal("unexpected-deletion", undefined, `${lost.length} existing item${lost.length !== 1 ? "s" : ""} disappeared while laying out the sequence`);
  }

  return issues;
}

/**
 * Post-condition validation (§15): check the DOCUMENT, not the return value.
 *
 * "Place Yuri in Panel 2" is only satisfied when panel 2 actually contains an
 * instance whose characterId is Yuri's. A command that returned success while
 * placing someone else — the exact production failure — is reported here as a
 * run failure rather than passing silently.
 */
function validateIdentityPostConditions(
  plan: AgentPlan,
  before: ProjectDocument,
  after: ProjectDocument,
): CompositionIssue[] {
  const issues: CompositionIssue[] = [];
  const page = after.pages[plan.targetScope?.pageId ?? ""] ?? null;

  const PLACEMENT_TOOLS = new Set<ToolName>(["place_character", "compose_character", "place_asset"]);
  for (const step of plan.steps) {
    if (!PLACEMENT_TOOLS.has(step.tool)) continue;
    const characterId = step.args.characterId;
    const panelNumber = step.args.panel;
    if (typeof characterId !== "string" || typeof panelNumber !== "number") continue;
    if (step.args.target === "workspace") continue;
    const panelId = page?.panelIds[panelNumber - 1];
    if (!panelId) continue;
    const present = (after.panels[panelId]?.itemIds ?? []).some((itemId) => {
      const item = after.items[itemId];
      if (item?.kind !== "asset") return false;
      const owner = item.characterState?.characterId ?? after.assets[item.sourceAssetId]?.metadata?.characterId;
      return owner === characterId;
    });
    if (!present) {
      issues.push({
        code: "identity-mismatch",
        panelId,
        message: `${after.characters[characterId]?.name ?? characterId} was requested in panel ${panelNumber} but is not there`,
        corrected: false,
        severity: "fatal",
      });
    }
  }

  /**
   * An interaction must be VISIBLE, not merely recorded.
   *
   * `create_interaction` succeeds if the document gained an Interaction record,
   * but a hug nobody can see in the panel is a failed hug. Both participants
   * must be represented — either as their own instances (local/synchronized) or
   * inside one joint render that provenance says contains them both.
   */
  for (const step of plan.steps) {
    if (step.tool !== "create_interaction") continue;
    const panelNumber = step.args.panel;
    const panelId = typeof panelNumber === "number" ? page?.panelIds[panelNumber - 1] : undefined;
    if (!panelId) continue;
    const present = new Set(
      (after.panels[panelId]?.itemIds ?? []).flatMap((itemId) => {
        const item = after.items[itemId];
        if (item?.kind !== "asset") return [];
        const owner = item.characterState?.characterId;
        return owner ? [owner] : charactersInAsset(after, item.sourceAssetId);
      }),
    );
    for (const key of ["subjectCharacterId", "targetCharacterId"] as const) {
      const characterId = step.args[key];
      if (typeof characterId !== "string" || present.has(characterId)) continue;
      issues.push({
        code: "interaction-participant-missing",
        panelId,
        message: `${after.characters[characterId]?.name ?? characterId} is missing from the ${String(step.args.interaction).replace(/_/g, " ")} in panel ${panelNumber}`,
        corrected: false,
        severity: "fatal",
      });
    }
  }

  /**
   * Nothing that already existed may vanish unless removal was the request.
   *
   * This is the failure that prompted the rule: a run asked to add an
   * interaction wiped a finished panel and still reported success. Additive
   * work must stay additive, inside the target panel as well as outside it.
   */
  const removalRequested = plan.steps.some(
    (step) => step.tool === "remove_items" || step.tool === "set_page_layout",
  );
  if (!removalRequested) {
    for (const panelId of page?.panelIds ?? []) {
      const survivors = new Set(after.panels[panelId]?.itemIds ?? []);
      const lost = (before.panels[panelId]?.itemIds ?? []).filter((id) => !survivors.has(id));
      /**
       * A composite interaction legitimately retires the individual sprites it
       * replaced; those characters are still on the page, inside the joint
       * render. Anything else that disappeared was destroyed.
       */
      const destroyed = lost.filter((itemId) => {
        const item = before.items[itemId];
        if (item?.kind !== "asset") return true;
        const owner = item.characterState?.characterId ?? before.assets[item.sourceAssetId]?.metadata?.characterId;
        if (!owner) return true;
        return !(after.panels[panelId]?.itemIds ?? []).some((survivorId) => {
          const survivor = after.items[survivorId];
          return survivor?.kind === "asset" && charactersInAsset(after, survivor.sourceAssetId).includes(owner);
        });
      });
      if (destroyed.length > 0) {
        issues.push({
          code: "unexpected-deletion",
          panelId,
          message: `${destroyed.length} existing item${destroyed.length !== 1 ? "s" : ""} disappeared from a panel this run was only meant to add to`,
          corrected: false,
          severity: "fatal",
        });
      }
    }
  }

  /**
   * No persistent Character may appear that this run was not authorized to
   * create. This catches creation through any path, not just create_character.
   */
  const authorized = new Set(createdCharacterIds);
  for (const id of Object.keys(after.characters)) {
    if (before.characters[id] || authorized.has(id)) continue;
    issues.push({
      code: "unauthorized-character-creation",
      panelId: plan.targetScope?.panelId ?? page?.panelIds[0] ?? "",
      message: `A new Character "${after.characters[id]?.name ?? id}" was created without authorization`,
      corrected: false,
      severity: "fatal",
    });
  }
  return issues;
}

// ─── Virtual manga stage (§18) ──────────────────────────────────────────────
// The model states intent; these handlers convert it into panel geometry. The
// LLM never computes coordinates.

function doSetCamera(args: {
  panel: number;
  shot?: ShotType;
  angle?: CameraAngle;
  lens?: CameraLens;
  mangaPerspective?: number;
}): void {
  const panelId = panelIdByNumber(args.panel);
  const result = dispatch({
    type: "set-panel-camera",
    panelId,
    patch: {
      shot: args.shot,
      angle: args.angle,
      lens: args.lens,
      mangaPerspectiveStrength: args.mangaPerspective,
    },
  });

  // Verify the geometry, not the metadata (§11). A camera step that stored a
  // value but left the panel unchanged must not report success.
  const camera = result.doc.panels[panelId].camera!;
  if (args.shot) {
    const focal = focalInstance(result.doc, panelId);
    if (focal) {
      const rect = panelPxRect(result.doc, panelId);
      if (!framingMatchesShot(subjectCoverage(focal, rect), args.shot)) {
        throw new Error(`Camera shot "${args.shot}" did not reframe the focal subject`);
      }
    }
  }
  if (args.angle === "dutch" && camera.roll === 0) {
    throw new Error("Dutch angle did not apply any roll");
  }
}

function doSetPerspective(args: { panel: number; type: PerspectiveType; horizonY?: number }): void {
  const panelId = panelIdByNumber(args.panel);
  dispatch({
    type: "set-panel-perspective",
    panelId,
    patch: { type: args.type, horizonY: args.horizonY, visible: args.type !== "none" },
  });
}

/** Characters currently present in a panel — the pronoun context of §13. */
function panelCharacterIds(doc: ProjectDocument, panelId: ID): ID[] {
  const panel = doc.panels[panelId];
  if (!panel) return [];
  return panel.itemIds
    .map((id) => doc.items[id])
    .filter((item): item is AssetInstance => item?.kind === "asset")
    .map((item) => item.characterState?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId)
    .filter((id): id is ID => Boolean(id));
}

/**
 * Find the character instance a semantic panel operation refers to.
 *
 * Identity comes from the ID grounding bound to the step. When only a name
 * survives, `requireCharacter` refuses ambiguity rather than picking the first
 * plausible character, which is what made "make Yuri shocked" reach Cute Girl.
 */
function characterInstanceInPanel(
  doc: ProjectDocument,
  panelId: ID,
  ref: { characterName?: string; characterId?: ID },
): AssetInstance {
  const named = Boolean(ref.characterId ?? ref.characterName);
  const wanted = named
    ? requireCharacter(doc, ref, {
        selectedCharacterId: activeGuards.selectedCharacterId,
        sceneCharacterIds: panelCharacterIds(doc, panelId),
      })
    : null;
  const panel = doc.panels[panelId];
  if (!panel) throw new Error("Unknown panel");
  const matches = panel.itemIds
    .map((id) => doc.items[id])
    .filter((item): item is AssetInstance => item?.kind === "asset")
    .filter((item) => {
      const characterId = item.characterState?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId;
      if (!characterId) return false;
      return wanted ? characterId === wanted.id : true;
    });
  const target = matches[matches.length - 1];
  if (!target) {
    throw new Error(
      wanted ? `${wanted.name} is not placed in that panel` : "No character instance found in that panel",
    );
  }
  return target;
}

/** Semantic placement → depth. The Agent names a plane; the harness picks the number. */
const PLACEMENT_DEPTH: Record<string, number> = { foreground: 0.15, midground: 0.5, background: 0.85 };

function doSetCharacterDepth(args: {
  panel: number;
  characterName?: string;
  characterId?: ID;
  placement?: "foreground" | "midground" | "background";
  depth?: number;
  groundY?: number;
}): void {
  const panelId = panelIdByNumber(args.panel);
  const instance = characterInstanceInPanel(currentDoc(), panelId, args);
  const depth = args.placement ? PLACEMENT_DEPTH[args.placement] : args.depth;
  if (depth === undefined) throw new Error("set_character_depth needs a placement or a depth");
  dispatch({
    type: "set-instance-stage",
    instanceId: instance.id,
    // Releasing the scale lock is what lets depth actually resize a character
    // that was previously framed or hand-resized.
    patch: { depth, groundY: args.groundY, scaleLocked: false },
  });
  // Depth moves the speaker, so any bubble aimed at them follows.
  dispatch({ type: "refresh-bubble-tails", panelId });
}

function doAttachBubble(args: {
  panel: number;
  characterName: string;
  characterId?: ID;
  bubbleType: BubbleType;
  text: string;
}): void {
  const panelId = panelIdByNumber(args.panel);
  const doc = currentDoc();
  const instance = characterInstanceInPanel(doc, panelId, args);
  const characterId = instance.characterState?.characterId ?? doc.assets[instance.sourceAssetId]?.metadata?.characterId;
  const rect = panelPxRect(doc, panelId);
  // Place the balloon above the speaker, clear of the face.
  const at = {
    x: Math.max(rect.width * 0.2, Math.min(rect.width * 0.8, instance.cx)),
    y: rect.height * 0.18,
  };
  const created = dispatch({ type: "add-bubble", panelId, bubbleType: args.bubbleType, text: args.text, at });
  if (!created.createdId) throw new Error("Bubble could not be created");
  dispatch({
    type: "set-bubble-target",
    itemId: created.createdId,
    characterId,
    instanceId: instance.id,
  });
}

/**
 * Semantic pose adjustment (§6).
 *
 * Produces a PoseIntent through the SAME normalizer the joint editor uses, so
 * "raise her right hand" and a dragged arm land on the identical canonical
 * descriptor and therefore the identical cached render. There is no agent-only
 * pose vocabulary and no agent-only pose path.
 */
async function doSetCharacterPoseRig(args: {
  panel: number;
  characterName?: string;
  characterId?: ID;
  basePose?: string;
  adjustments: string[];
}): Promise<void> {
  const panelId = panelIdByNumber(args.panel);
  const doc = currentDoc();
  const instance = characterInstanceInPanel(doc, panelId, args);
  const current = stateFromInstance(doc, instance);
  if (!current) throw new Error("The targeted instance is not a character");

  const basePose = args.basePose ?? current.poseRig?.basePose ?? current.pose;
  const intent = poseIntentFromDescriptors(basePose, args.adjustments);
  if (intent.descriptors.length === 0) {
    throw new Error(
      `None of those adjustments are recognized pose descriptors. Try phrasings like "right arm raised" or "head turned left".`,
    );
  }

  await applyCharacterStateToInstance({ instanceId: instance.id, patch: { poseRig: intent } });
}

function doSetFocalCharacter(args: { panel: number; characterName: string; characterId?: ID }): void {
  const panelId = panelIdByNumber(args.panel);
  const instance = characterInstanceInPanel(currentDoc(), panelId, args);
  dispatch({ type: "set-panel-focal-item", panelId, itemId: instance.id });
}

// ─── Manga Puppet: the Agent uses the SAME local operations as the GUI (§17) ──

/**
 * Change a puppet character's face.
 *
 * The Agent reaches for this instead of generate/compose whenever a puppet
 * exists, so "make Yuri shocked" swaps a face rather than redrawing a person.
 * The error names the fallback explicitly rather than silently generating.
 */
function doSetPuppetExpression(args: { panel: number; characterName?: string; characterId?: ID; expression: string }): void {
  const panelId = panelIdByNumber(args.panel);
  const doc = currentDoc();
  const instance = characterInstanceInPanel(doc, panelId, args);
  if (!isPuppetInstance(doc, instance.id)) {
    throw new Error(
      `${args.characterName ?? "That character"} has no puppet, so the face cannot be changed locally. Use set_character_slot to generate the expression instead.`,
    );
  }
  const expressionId = args.expression.trim().toLowerCase();
  dispatch({ type: "set-puppet-expression", instanceId: instance.id, expressionId });
}

function doSetPuppetJoint(args: {
  panel: number;
  characterName?: string;
  characterId?: ID;
  joint: PuppetJoint;
  degrees: number;
}): void {
  const panelId = panelIdByNumber(args.panel);
  const doc = currentDoc();
  const instance = characterInstanceInPanel(doc, panelId, args);
  if (!isPuppetInstance(doc, instance.id)) {
    throw new Error(
      `${args.characterName ?? "That character"} has no puppet, so the pose cannot be adjusted locally. Use set_character_pose_rig to generate the pose instead.`,
    );
  }
  dispatch({ type: "set-puppet-joint", instanceId: instance.id, joint: args.joint, degrees: args.degrees });
}
