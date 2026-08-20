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
import { findSlotAsset } from "@/characters/slotSwitch";
import { addCharacter } from "@/domain/libraryOps";
import {
  addBubble,
  addEffect,
  placeAsset,
  removeItem,
  setCropMode,
  swapInstanceAsset,
  updateItemProps,
} from "@/domain/itemOps";
import { setPageLayout } from "@/domain/pageOps";
import { reshapePanel } from "@/domain/panelOps";
import { addWorkspaceItem } from "@/domain/workspaceOps";
import { panelPxRect } from "@/domain/docHelpers";
import type {
  AssetInstance,
  BubbleType,
  Character,
  CropMode,
  EffectKind,
  ID,
  LayoutPresetId,
  Point,
  ProjectDocument,
} from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { findCharacter, resolveCharacterAsset, resolveLibraryAsset } from "./resolver";
import type { AgentPlan, ToolName } from "./tools/schemas";

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

interface ProviderCaps {
  referenceImage: boolean;
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
  const caps = await fetchProviderCaps();
  let completed = 0;
  let failed = 0;

  store.beginTransaction();
  try {
    for (let i = 0; i < plan.steps.length; i++) {
      onProgress(i, "running");
      try {
        await executeStep(plan.steps[i], caps);
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

async function fetchProviderCaps(): Promise<ProviderCaps> {
  try {
    const status = await fetch("/api/provider/status").then((r) => r.json());
    return { referenceImage: Boolean(status?.capabilities?.referenceImage) };
  } catch {
    return { referenceImage: false };
  }
}

// ─── Step dispatch ──────────────────────────────────────────────────────────

async function executeStep(step: AgentPlan["steps"][number], caps: ProviderCaps): Promise<void> {
  const args = step.args as never;
  switch (step.tool) {
    case "create_character":
      return doCreateCharacter(args);
    case "generate_character_asset":
      return doGenerateCharacterAsset(args, caps);
    case "generate_background":
      return doGenerateScenery(args, "background");
    case "generate_prop":
      return doGenerateScenery(args, "prop");
    case "set_page_layout":
      return doSetPageLayout(args);
    case "place_asset":
      return doPlaceAsset(args);
    case "set_character_slot":
      return doSetCharacterSlot(args, caps);
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

function doCreateCharacter(args: { name: string; description?: string }): void {
  // Idempotent: re-creating an existing character would fork the library.
  if (findCharacter(currentDoc(), args.name)) return;
  useEditorStore.getState().commit((d) => addCharacter(d, args.name, args.description).doc);
}

async function doGenerateCharacterAsset(
  args: { characterName: string; kind: "reference" | "pose" | "expression"; pose?: string; expression?: string; instruction?: string },
  caps: ProviderCaps,
): Promise<void> {
  const character = findCharacter(currentDoc(), args.characterName);
  if (!character) throw new Error(`Character "${args.characterName}" not found`);
  const assetId = await generateCharacterSlotAsset(character, args, caps);
  stageOnWorkspace(assetId);
}

/**
 * Generate one character slot asset and register it in the library.
 * Shared by explicit generation steps and set_character_slot's
 * generate-on-miss path — one implementation of the generation flow.
 */
async function generateCharacterSlotAsset(
  character: Character,
  args: { kind: "reference" | "pose" | "expression"; pose?: string; expression?: string; instruction?: string },
  caps: ProviderCaps,
): Promise<ID> {
  const reference = character.referenceAssetId ? currentDoc().assets[character.referenceAssetId] : undefined;
  const useReference = caps.referenceImage && Boolean(reference) && args.kind !== "reference";

  const assetType = args.kind === "expression" ? "character-expression" : args.kind === "pose" ? "character-pose" : "character";
  const prompt = buildAssetPrompt({
    assetType,
    characterName: character.name,
    characterDescription: character.description,
    pose: args.pose,
    expression: args.expression,
    description: args.instruction,
    hasReference: useReference,
  });

  const result = await callGenerateApi({
    assetType,
    prompt,
    size: defaultAspect(assetType),
    referenceUrls: useReference && reference ? [reference.storageUrl] : undefined,
  });
  return storeGeneratedAsset({
    result,
    assetType,
    category: "character",
    name: `${character.name} ${args.pose ?? args.expression ?? "reference"}`.trim(),
    prompt,
    metadata: {
      characterId: character.id,
      pose: args.pose,
      expression: args.expression,
      referenceAssetIds: useReference && reference ? [reference.id] : undefined,
    },
  });
}

async function doGenerateScenery(
  args: { description: string; name?: string },
  category: "background" | "prop",
): Promise<void> {
  const prompt = buildAssetPrompt({ assetType: category, description: args.description });
  const result = await callGenerateApi({ assetType: category, prompt, size: defaultAspect(category) });
  const assetId = await storeGeneratedAsset({
    result,
    assetType: category,
    category,
    name: args.name ?? args.description.slice(0, 40),
    prompt,
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

function doPlaceAsset(args: {
  panel?: number;
  target?: "panel" | "workspace";
  characterName?: string;
  pose?: string;
  expression?: string;
  assetName?: string;
  category?: "character" | "background" | "prop" | "upload";
  cropMode?: CropMode;
  flipX?: boolean;
}): void {
  const doc = currentDoc();
  const asset = args.characterName
    ? resolveFromCharacter(doc, args)
    : resolveLibraryAsset(doc, { assetName: args.assetName, category: args.category });
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

/**
 * Semantic slot change on an already-placed character instance — the tool
 * behind "make her cry". Reuse an exact-matching library asset when one
 * exists; otherwise generate the missing slot, then swap the instance while
 * the composition stays put.
 */
async function doSetCharacterSlot(
  args: { panel?: number; characterName?: string; pose?: string; expression?: string; generateIfMissing?: boolean },
  caps: ProviderCaps,
): Promise<void> {
  if (!args.pose && !args.expression) throw new Error("set_character_slot needs a pose or an expression");
  const doc = currentDoc();
  const instance = findTargetInstance(doc, args);
  const asset = doc.assets[instance.sourceAssetId];
  const characterId = asset?.metadata?.characterId;
  const character = characterId ? doc.characters[characterId] : null;
  if (!character) throw new Error("The targeted instance is not a character");

  const current = { pose: asset?.metadata?.pose, expression: asset?.metadata?.expression };
  const existing = findSlotAsset(doc, character, { pose: args.pose, expression: args.expression }, current);

  let replacementId = existing?.id;
  if (!replacementId) {
    if (args.generateIfMissing === false) {
      throw new Error(`${character.name} has no ${[args.pose, args.expression].filter(Boolean).join("/")} asset`);
    }
    replacementId = await generateCharacterSlotAsset(
      character,
      { kind: args.pose ? "pose" : "expression", pose: args.pose, expression: args.expression },
      caps,
    );
  }
  const swapId = replacementId;
  useEditorStore.getState().commit((d) => swapInstanceAsset(d, instance.id, swapId));
}

/** Resolve which character instance a slot change targets: explicit panel/name, else the user's selection. */
function findTargetInstance(
  doc: ProjectDocument,
  args: { panel?: number; characterName?: string },
): AssetInstance {
  const state = useEditorStore.getState();
  const characterByName = args.characterName ? findCharacter(doc, args.characterName) : null;

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

function resolveFromCharacter(
  doc: ProjectDocument,
  args: { characterName?: string; pose?: string; expression?: string },
) {
  const character = findCharacter(doc, args.characterName!);
  if (!character) throw new Error(`Character "${args.characterName}" not found`);
  return resolveCharacterAsset(doc, character, { pose: args.pose, expression: args.expression });
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
