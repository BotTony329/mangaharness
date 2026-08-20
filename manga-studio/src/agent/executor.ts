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
import { addCharacter } from "@/domain/libraryOps";
import {
  addBubble,
  addEffect,
  placeAsset,
  removeItem,
  setCropMode,
  updateItemProps,
} from "@/domain/itemOps";
import { setPageLayout } from "@/domain/pageOps";
import { reshapePanel } from "@/domain/panelOps";
import { addWorkspaceItem } from "@/domain/workspaceOps";
import { panelPxRect } from "@/domain/docHelpers";
import type {
  AssetInstance,
  BubbleType,
  CropMode,
  EffectKind,
  ID,
  LayoutPresetId,
  Point,
  ProjectDocument,
} from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { getStyleGenerationContext, styleMetadata } from "@/styles/generation";
import { assetRenderUrl } from "@/assets/renderSource";
import { findCharacter, resolveCharacterState, resolveLibraryAsset } from "./resolver";
import type { AgentRunScope } from "./scope";
import { validateStepScope, type AgentPlan, type ToolName } from "./tools/schemas";

export type StepStatus = "pending" | "running" | "done" | "failed";

export interface StepProgress {
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface ExecutionSummary {
  completed: number;
  failed: number;
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
    case "remove_items":
      return `Clear ${args.kind ?? "items"} from panel ${args.panel}`;
  }
}

export function countGenerations(plan: AgentPlan): number {
  return plan.steps.filter((s) => s.tool.startsWith("generate_")).length;
}

export async function executePlan(
  plan: AgentPlan,
  onProgress: (index: number, status: StepStatus, detail?: string) => void,
): Promise<ExecutionSummary> {
  const store = useEditorStore.getState();
  let completed = 0;
  let failed = 0;

  store.beginTransaction();
  try {
    for (let i = 0; i < plan.steps.length; i++) {
      onProgress(i, "running");
      try {
        await executeStep(plan.steps[i], plan.targetScope);
        completed += 1;
        onProgress(i, "done");
      } catch (error) {
        failed += 1;
        onProgress(i, "failed", error instanceof Error ? error.message : "Step failed");
      }
    }
  } finally {
    useEditorStore.getState().endTransaction();
  }
  return { completed, failed };
}

// ─── Step dispatch ──────────────────────────────────────────────────────────

async function executeStep(step: AgentPlan["steps"][number], scope?: AgentRunScope): Promise<void> {
  const scopeError = scope ? validateStepScope(step.tool, step.args, scope) : null;
  if (scopeError) throw new Error(scopeError);
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
    case "remove_items":
      return doRemoveItems(args);
  }
}

function currentDoc(): ProjectDocument {
  const doc = useEditorStore.getState().doc;
  if (!doc) throw new Error("No open project");
  return doc;
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

function doCreateCharacter(args: { name: string; appearance?: string; personalityNotes?: string; description?: string }): void {
  // Idempotent: re-creating an existing character would fork the library.
  if (findCharacter(currentDoc(), args.name)) return;
  useEditorStore.getState().commit((d) =>
    addCharacter(d, args.name, args.appearance ?? args.description, args.personalityNotes).doc,
  );
}

async function doGenerateCharacterAsset(
  args: { characterName: string; kind: "reference" | "pose" | "expression"; pose?: string; expression?: string; outfit?: string; view?: string; instruction?: string },
): Promise<void> {
  const character = findCharacter(currentDoc(), args.characterName);
  if (!character) throw new Error(`Character "${args.characterName}" not found`);
  const assetId = await generateCharacterAssetForState({
    characterId: character.id,
    role: args.kind === "reference" ? "canonical" : "state",
    instruction: args.instruction,
    state: {
      characterId: character.id,
      pose: args.pose?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.pose,
      expression: args.expression?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.expression,
      outfit: args.outfit?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.outfit,
      view: args.view?.toLowerCase() ?? DEFAULT_CHARACTER_STATE.view,
    },
  });
  stageOnWorkspace(assetId);
}

async function doGenerateScenery(
  args: { description: string; name?: string },
  category: "background" | "prop",
): Promise<void> {
  const doc = currentDoc();
  const style = getStyleGenerationContext(doc);
  const prompt = buildAssetPrompt({ assetType: category, description: args.description, style: style.profile });
  const result = await callGenerateApi({
    assetType: category,
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: defaultAspect(category),
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
  state.commit((d) => addWorkspaceItem(d, assetId, at).doc);
}

function doSetPageLayout(args: { layout: LayoutPresetId }): void {
  const pageId = useEditorStore.getState().currentPageId;
  if (!pageId) throw new Error("No current page");
  useEditorStore.getState().commit((d) => setPageLayout(d, pageId, args.layout));
}

async function doPlaceAsset(args: {
  panel?: number;
  target?: "panel" | "workspace";
  characterName?: string;
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
  useEditorStore.getState().commit((d) => {
    const placed = placeAsset(d, panelId, asset.id, { cropMode: args.cropMode });
    return args.flipX ? updateItemProps(placed.doc, placed.itemId, { flipX: true }) : placed.doc;
  });
}

async function doPlaceCharacter(args: {
  panel?: number;
  target?: "panel" | "workspace";
  characterName: string;
  pose?: string;
  expression?: string;
  outfit?: string;
  view?: string;
  cropMode?: CropMode;
  flipX?: boolean;
  generateIfMissing?: boolean;
}): Promise<void> {
  let doc = currentDoc();
  const resolution = resolveCharacterState(doc, args.characterName, {
    pose: args.pose,
    expression: args.expression,
    outfit: args.outfit,
    view: args.view,
  });
  if (resolution.status === "character-not-found") throw new Error(`Character "${args.characterName}" not found`);
  const { character } = resolution;
  let asset = resolution.asset;
  if (!asset) {
    if (args.generateIfMissing === false) {
      throw new Error(`No cached state matches ${character.name}; generation was disabled`);
    }
    const assetId = await generateCharacterAssetForState({
      characterId: character.id,
      role: "state",
      state: resolution.desired,
      instruction: `Create the missing reusable state requested for placement in the manga page.`,
    });
    doc = currentDoc();
    asset = doc.assets[assetId];
  }
  if (!asset) throw new Error(`Unable to resolve a reusable state for ${character.name}`);

  if (args.target === "workspace" || args.panel === undefined) {
    stageOnWorkspace(asset.id);
    return;
  }
  const panelId = panelIdByNumber(args.panel);
  useEditorStore.getState().commit((d) => {
    const placed = placeAsset(d, panelId, asset!.id, { cropMode: args.cropMode });
    return args.flipX ? updateItemProps(placed.doc, placed.itemId, { flipX: true }) : placed.doc;
  });
}

/**
 * Semantic slot change on an already-placed character instance — the tool
 * behind "make her cry". Reuse an exact-matching library asset when one
 * exists; otherwise generate the missing slot, then swap the instance while
 * the composition stays put.
 */
async function doSetCharacterSlot(
  args: { panel?: number; characterName?: string; pose?: string; expression?: string; outfit?: string; view?: string; generateIfMissing?: boolean },
  scope?: AgentRunScope,
): Promise<void> {
  if (!args.pose && !args.expression && !args.outfit && !args.view) {
    throw new Error("set_character_slot needs a pose, expression, outfit, or view");
  }
  const doc = currentDoc();
  const instance = findTargetInstance(doc, args, scope);
  if (!stateFromInstance(doc, instance)) throw new Error("The targeted instance is not a character");
  await applyCharacterStateToInstance({
    instanceId: instance.id,
    patch: { pose: args.pose, expression: args.expression, outfit: args.outfit, view: args.view },
    generateIfMissing: args.generateIfMissing,
  });
}

/** Resolve which character instance a slot change targets: explicit panel/name, else the user's selection. */
function findTargetInstance(
  doc: ProjectDocument,
  args: { panel?: number; characterName?: string },
  scope?: AgentRunScope,
): AssetInstance {
  const state = useEditorStore.getState();
  const characterByName = args.characterName ? findCharacter(doc, args.characterName) : null;

  if (scope?.kind === "selected-object" && scope.itemId) {
    const item = doc.items[scope.itemId];
    if (item?.kind !== "asset") throw new Error("The scoped object is not a character asset");
    const characterId = doc.assets[item.sourceAssetId]?.metadata?.characterId;
    if (!characterId || (characterByName && characterByName.id !== characterId)) {
      throw new Error("The scoped object does not match the requested character");
    }
    return item;
  }

  const candidates: AssetInstance[] = [];
  if (args.panel !== undefined) {
    const panel = doc.panels[panelIdByNumber(args.panel)];
    for (const id of panel.itemIds) {
      const item = doc.items[id];
      if (item?.kind === "asset") candidates.push(item);
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
      args.panel !== undefined
        ? `No character instance found in panel ${args.panel}`
        : "No character instance is selected — select one or specify a panel",
    );
  }
  return target;
}

function doReshapePanel(args: { panel: number; points: Point[] }): void {
  const panelId = panelIdByNumber(args.panel);
  useEditorStore.getState().commit((d) => reshapePanel(d, panelId, args.points));
}

function doSetCropMode(args: {
  panel: number;
  characterName?: string;
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
      if (args.characterName) {
        const character = findCharacter(doc, args.characterName);
        return Boolean(character && asset.metadata?.characterId === character.id);
      }
      if (args.category) return asset.category === args.category;
      return asset.category === "character"; // default target: the character shot
    });
  const target = targets[targets.length - 1];
  if (!target) throw new Error(`Nothing to reframe in panel ${args.panel}`);
  useEditorStore.getState().commit((d) => setCropMode(d, target.id, args.mode));
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
  useEditorStore.getState().commit((d) => addBubble(d, panelId, args.bubbleType, args.text, at).doc);
}

function doAddEffect(args: { panel: number; effectKind: EffectKind }): void {
  const panelId = panelIdByNumber(args.panel);
  useEditorStore.getState().commit((d) => addEffect(d, panelId, args.effectKind).doc);
}

function doRemoveItems(args: { panel: number; kind?: "asset" | "bubble" | "effect" }): void {
  const doc = currentDoc();
  const panelId = panelIdByNumber(args.panel);
  const toRemove = doc.panels[panelId].itemIds.filter((id) => {
    const item = doc.items[id];
    return item && (!args.kind || item.kind === args.kind);
  });
  useEditorStore.getState().commit((d) => toRemove.reduce((acc, id) => removeItem(acc, id), d));
}
