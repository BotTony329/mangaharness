/**
 * Canonical editor command layer. UI controls and Agent tools dispatch these
 * serializable intents; the command layer alone coordinates domain modules.
 */

import { addAsset, addCharacter, addGenerationRecord, setAssetProcessedImage, setCharacterReference, type NewAssetInput } from "./libraryOps";
import { deleteAsset, deleteCharacter, renameAsset, renameCharacter, replaceAssetReferences, setAssetArchived, type DeleteAssetMode, type DeleteCharacterMode } from "./assetLifecycle";
import { addBubble, addEffect, duplicateItem, placeAsset, removeItem, reorderItem, setCropMode, swapInstanceAsset, updateBubble, updateItemProps, updateItemTransform, type ReorderDirection } from "./itemOps";
import { addPage, removePage, setPageLayout } from "./pageOps";
import { panelPxRect } from "./docHelpers";
import { reshapePanel } from "./panelOps";
import { addSceneRelationship, setSceneCharacterSemantics, setSceneContinuity } from "./sceneOps";
import { addCustomStyle, setProjectStyle } from "./styleOps";
import { addWorkspaceItem, instanceToWorkspaceItem, removeWorkspaceItem, updateWorkspaceItem, workspaceItemToInstance } from "./workspaceOps";
import type {
  BubbleType,
  CropMode,
  EffectKind,
  ID,
  LayoutPresetId,
  Point,
  ProjectDocument,
  SceneDepth,
  SceneFacing,
  ScenePosition,
  GenerationRecord,
  SourceAsset,
  StyleProfile,
} from "./types";
import { validateAndCorrectComposition, type CompositionIssue, type CompositionRequirements } from "./compositionValidation";

export type SemanticFraming = "full-body" | "medium-full" | "medium" | "upper-body" | "close-up" | "face";

export type DomainCommand =
  | { type: "create-character"; name: string; appearance?: string; personalityNotes?: string }
  | { type: "create-asset"; input: NewAssetInput; generation?: Omit<GenerationRecord, "id" | "createdAt" | "resultAssetId"> }
  | { type: "set-asset-processed"; assetId: ID; update: Pick<SourceAsset, "processedImageUrl" | "hasAlpha" | "backgroundRemoved" | "processingStatus" | "processingReason"> }
  | { type: "set-character-reference"; characterId: ID; assetId: ID }
  | { type: "record-failed-generation"; record: Omit<GenerationRecord, "id" | "createdAt" | "resultAssetId"> }
  | { type: "delete-character"; characterId: ID; mode: DeleteCharacterMode }
  | { type: "rename-character"; characterId: ID; name: string }
  | { type: "delete-asset"; assetId: ID; mode: DeleteAssetMode }
  | { type: "archive-asset"; assetId: ID }
  | { type: "restore-asset"; assetId: ID }
  | { type: "rename-asset"; assetId: ID; name: string }
  | { type: "replace-asset"; oldAssetId: ID; newAssetId: ID }
  | { type: "add-instance"; panelId: ID; assetId: ID; cropMode?: CropMode; at?: Point }
  | { type: "delete-instance"; instanceId: ID }
  | { type: "duplicate-instance"; instanceId: ID }
  | { type: "reorder-instance"; instanceId: ID; direction: ReorderDirection }
  | { type: "swap-instance-asset"; instanceId: ID; assetId: ID }
  | { type: "set-framing"; instanceId: ID; cropMode: CropMode }
  | { type: "update-instance-transform"; instanceId: ID; patch: { cx?: number; cy?: number; width?: number; height?: number; rotation?: number } }
  | { type: "set-instance-props"; instanceId: ID; patch: { opacity?: number; flipX?: boolean; visible?: boolean; locked?: boolean } }
  | { type: "set-panel-background"; panelId: ID; assetId: ID; location?: string; sourcePanelId?: ID }
  | {
      type: "compose-character";
      panelId: ID;
      characterId: ID;
      assetId: ID;
      framing?: SemanticFraming;
      position?: ScenePosition;
      facing?: SceneFacing;
      depth?: SceneDepth;
      role?: string;
    }
  | { type: "reuse-panel-background"; sourcePanelId: ID; targetPanelId: ID }
  | { type: "add-scene-relationship"; panelId: ID; subjectCharacterId: ID; action: string; targetCharacterId?: ID }
  | { type: "add-bubble"; panelId: ID; bubbleType: BubbleType; text: string; at?: Point }
  | { type: "update-bubble"; itemId: ID; patch: { text?: string; bubbleType?: BubbleType; fontSize?: number; tail?: Point } }
  | { type: "add-effect"; panelId: ID; effectKind: EffectKind }
  | { type: "reshape-panel"; panelId: ID; points: Point[] }
  | { type: "set-page-layout"; pageId: ID; layout: LayoutPresetId }
  | { type: "add-page"; layout?: LayoutPresetId }
  | { type: "remove-page"; pageId: ID }
  | { type: "add-workspace-instance"; assetId: ID; at: Point }
  | { type: "update-workspace-instance"; itemId: ID; patch: { x?: number; y?: number; width?: number; height?: number; rotation?: number; flipX?: boolean; opacity?: number } }
  | { type: "workspace-to-panel"; itemId: ID; panelId: ID }
  | { type: "panel-to-workspace"; instanceId: ID; at?: Point }
  | { type: "delete-workspace-instance"; itemId: ID }
  | { type: "set-project-style"; styleId: ID }
  | { type: "add-custom-style"; input: Omit<StyleProfile, "id" | "family"> }
  | { type: "validate-composition"; panelIds: ID[]; requirements?: CompositionRequirements };

export interface CommandResult {
  doc: ProjectDocument;
  createdId?: ID;
  issues?: CompositionIssue[];
}

export function applyDomainCommand(doc: ProjectDocument, command: DomainCommand): CommandResult {
  switch (command.type) {
    case "create-character": {
      const result = addCharacter(doc, command.name, command.appearance, command.personalityNotes);
      return { doc: result.doc, createdId: result.characterId };
    }
    case "create-asset": {
      const result = addAsset(doc, command.input);
      const next = command.generation
        ? addGenerationRecord(result.doc, { ...command.generation, resultAssetId: result.assetId })
        : result.doc;
      return { doc: next, createdId: result.assetId };
    }
    case "set-asset-processed":
      return { doc: setAssetProcessedImage(doc, command.assetId, command.update) };
    case "set-character-reference":
      return { doc: setCharacterReference(doc, command.characterId, command.assetId) };
    case "record-failed-generation":
      return { doc: addGenerationRecord(doc, command.record) };
    case "delete-character":
      return { doc: deleteCharacter(doc, command.characterId, command.mode) };
    case "rename-character":
      return { doc: renameCharacter(doc, command.characterId, command.name) };
    case "delete-asset":
      return { doc: deleteAsset(doc, command.assetId, command.mode) };
    case "archive-asset":
      return { doc: setAssetArchived(doc, command.assetId, true) };
    case "restore-asset":
      return { doc: setAssetArchived(doc, command.assetId, false) };
    case "rename-asset":
      return { doc: renameAsset(doc, command.assetId, command.name) };
    case "replace-asset":
      return { doc: replaceAssetReferences(doc, command.oldAssetId, command.newAssetId) };
    case "add-instance": {
      const result = placeAsset(doc, command.panelId, command.assetId, { cropMode: command.cropMode, at: command.at });
      return { doc: result.doc, createdId: result.itemId };
    }
    case "delete-instance":
      return { doc: removeItem(doc, command.instanceId) };
    case "duplicate-instance": {
      const result = duplicateItem(doc, command.instanceId);
      return { doc: result.doc, createdId: result.itemId };
    }
    case "reorder-instance":
      return { doc: reorderItem(doc, command.instanceId, command.direction) };
    case "swap-instance-asset":
      return { doc: swapInstanceAsset(doc, command.instanceId, command.assetId) };
    case "set-framing":
      return { doc: setCropMode(doc, command.instanceId, command.cropMode) };
    case "update-instance-transform":
      return { doc: updateItemTransform(doc, command.instanceId, command.patch) };
    case "set-instance-props":
      return { doc: updateItemProps(doc, command.instanceId, command.patch) };
    case "set-panel-background":
      return { doc: setPanelBackground(doc, command.panelId, command.assetId, command.location, command.sourcePanelId) };
    case "compose-character":
      return composeCharacter(doc, command);
    case "reuse-panel-background": {
      const source = doc.scenes[command.sourcePanelId];
      if (!source?.backgroundAssetId) throw new Error("Source scene has no reusable background");
      return {
        doc: setPanelBackground(doc, command.targetPanelId, source.backgroundAssetId, source.location, command.sourcePanelId),
      };
    }
    case "add-scene-relationship":
      return {
        doc: addSceneRelationship(doc, command.panelId, {
          subjectCharacterId: command.subjectCharacterId,
          action: command.action,
          targetCharacterId: command.targetCharacterId,
        }),
      };
    case "add-bubble": {
      const result = addBubble(doc, command.panelId, command.bubbleType, command.text, command.at);
      return { doc: result.doc, createdId: result.itemId };
    }
    case "update-bubble":
      return { doc: updateBubble(doc, command.itemId, command.patch) };
    case "add-effect": {
      const result = addEffect(doc, command.panelId, command.effectKind);
      return { doc: result.doc, createdId: result.itemId };
    }
    case "reshape-panel":
      return { doc: reshapePanel(doc, command.panelId, command.points) };
    case "set-page-layout":
      return { doc: setPageLayout(doc, command.pageId, command.layout) };
    case "add-page": {
      const result = addPage(doc, command.layout);
      return { doc: result.doc, createdId: result.pageId };
    }
    case "remove-page":
      return { doc: removePage(doc, command.pageId) };
    case "add-workspace-instance": {
      const result = addWorkspaceItem(doc, command.assetId, command.at);
      return { doc: result.doc, createdId: result.itemId };
    }
    case "update-workspace-instance":
      return { doc: updateWorkspaceItem(doc, command.itemId, command.patch) };
    case "workspace-to-panel": {
      const result = workspaceItemToInstance(doc, command.itemId, command.panelId);
      return { doc: result.doc, createdId: result.instanceId };
    }
    case "panel-to-workspace": {
      const result = instanceToWorkspaceItem(doc, command.instanceId, command.at);
      return { doc: result.doc, createdId: result.itemId };
    }
    case "delete-workspace-instance":
      return { doc: removeWorkspaceItem(doc, command.itemId) };
    case "set-project-style":
      return { doc: setProjectStyle(doc, command.styleId) };
    case "add-custom-style": {
      const result = addCustomStyle(doc, command.input);
      return { doc: result.doc, createdId: result.styleId };
    }
    case "validate-composition": {
      const result = validateAndCorrectComposition(doc, command.panelIds, command.requirements);
      return { doc: result.doc, issues: result.issues };
    }
  }
}

function setPanelBackground(
  doc: ProjectDocument,
  panelId: ID,
  assetId: ID,
  location?: string,
  sourcePanelId?: ID,
): ProjectDocument {
  const asset = doc.assets[assetId];
  if (!asset || asset.category !== "background") throw new Error("Panel background must be a background asset");
  const panel = doc.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  let next = panel.itemIds.reduce((current, itemId) => {
    const item = current.items[itemId];
    return item?.kind === "asset" && current.assets[item.sourceAssetId]?.category === "background"
      ? removeItem(current, itemId)
      : current;
  }, doc);
  next = placeAsset(next, panelId, assetId, { cropMode: "fill" }).doc;
  next.scenes[panelId].location = location ?? asset.name;
  return setSceneContinuity(next, panelId, sourcePanelId
    ? { backgroundSourcePanelId: sourcePanelId, previousPanelId: sourcePanelId, sceneKey: next.scenes[sourcePanelId]?.continuity?.sceneKey ?? assetId }
    : { sceneKey: assetId });
}

function composeCharacter(
  doc: ProjectDocument,
  command: Extract<DomainCommand, { type: "compose-character" }>,
): CommandResult {
  const asset = doc.assets[command.assetId];
  if (!asset || asset.metadata?.characterId !== command.characterId) throw new Error("Visual asset does not belong to the Character");
  const requestedCropMode = framingCropMode(command.framing);
  const cropMode = requestedCropMode === "face" && !asset.focusRegions?.some((region) => region.kind === "face")
    ? "upper-body"
    : requestedCropMode;
  const placed = placeAsset(doc, command.panelId, command.assetId, { cropMode });
  let next = placed.doc;
  const item = next.items[placed.itemId];
  if (item.kind !== "asset") throw new Error("Character placement failed");
  const panelRect = panelPxRect(next, command.panelId);
  const panelWidth = panelRect.width;
  const positionX = command.position === "left" ? panelWidth * 0.28 : command.position === "right" ? panelWidth * 0.72 : panelWidth * 0.5;
  const depthScale = command.depth === "foreground" ? 1.18 : command.depth === "background" ? 0.72 : 1;
  next = updateItemTransform(next, item.id, {
    cx: positionX,
    width: item.width * depthScale,
    height: item.height * depthScale,
  });
  next = updateItemProps(next, item.id, { flipX: command.facing === "left" });
  next = setSceneCharacterSemantics(next, item.id, {
    role: command.role,
    depth: command.depth ?? "midground",
    facing: command.facing ?? "camera",
    semanticPosition: command.position ?? "center",
  });
  return { doc: next, createdId: item.id };
}

function framingCropMode(framing: SemanticFraming | undefined): CropMode {
  if (framing === "medium" || framing === "upper-body") return "upper-body";
  if (framing === "close-up" || framing === "face") return "face";
  return "fit";
}
