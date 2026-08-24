/**
 * Canonical editor command layer. UI controls and Agent tools dispatch these
 * serializable intents; the command layer alone coordinates domain modules.
 */

import { addAsset, addCharacter, addGenerationRecord, setAssetProcessedImage, setCharacterReference, type NewAssetInput } from "./libraryOps";
import { deleteAsset, deleteCharacter, renameAsset, renameCharacter, replaceAssetReferences, setAssetArchived, type DeleteAssetMode, type DeleteCharacterMode } from "./assetLifecycle";
import { addBubble, addEffect, duplicateItem, moveItemToIndex, placeAsset, removeItem, reorderItem, setCropMode, swapInstanceAsset, updateBubble, updateItemProps, updateItemTransform, type ReorderDirection } from "./itemOps";
import { addTone, updateTone, type TonePatch } from "./toneOps";
import type { ProceduralToneParams, ToneMask } from "./tones";
import { addPage, removePage, setPageLayout } from "./pageOps";
import { renameProject } from "./projectOps";
import { addRelationship, removeRelationship } from "./relationships";
import {
  createInteraction,
  recordInteractionRender,
  removeInteraction,
  setInteractionAnchor,
  updateInteraction,
  type CreateInteractionInput,
} from "./interactions";
import {
  addLanguageAsset,
  applyAttachments,
  attachItem,
  deleteLanguageAsset,
  detachItem,
  duplicateLanguageAsset,
  placeLanguageAsset,
  updateLanguageAsset,
  type NewLanguageAssetInput,
} from "./languageOps";
import { cloneDoc, panelPxRect, touch } from "./docHelpers";
import { reshapePanel } from "./panelOps";
import { addSceneRelationship, setSceneCharacterSemantics, setSceneContinuity } from "./sceneOps";
import { addCustomStyle, setProjectStyle } from "./styleOps";
import { addWorkspaceItem, instanceToWorkspaceItem, removeWorkspaceItem, updateWorkspaceItem, workspaceItemToInstance } from "./workspaceOps";
import type {
  BubbleStyle,
  BubbleType,
  CropMode,
  MangaLanguageCategory,
  RelationshipType,
  InteractionAnchor,
  InteractionRender,
  EffectKind,
  ID,
  LayoutPresetId,
  Point,
  ProjectDocument,
  CharacterState,
  InstanceStage,
  SceneDepth,
  SceneFacing,
  ScenePosition,
  GenerationRecord,
  SourceAsset,
  StyleProfile,
} from "./types";
import { validateAndCorrectComposition, type CompositionIssue, type CompositionRequirements } from "./compositionValidation";
import type { PoseCalibration } from "@/characters/poseRig";
import { setStateCalibration } from "./characterStateOps";
import { frameSubject, resolveShotType } from "./staging";
import {
  attachPuppetToInstance,
  detachPuppetFromInstance,
  registerPuppet,
  resetPuppetPose,
  setPuppetAttachment,
  setPuppetExpression,
  setPuppetJoint,
  setPuppetPartOverride,
} from "./puppetOps";
import type { MangaPuppet, PuppetJoint, PuppetPartType } from "@/puppet/model";
import type { CameraPatch } from "./camera";
import type { PerspectivePatch } from "./perspective";
import {
  clearInstanceStage,
  movePanelVanishingPoint,
  refreshBubbleTails,
  setBubbleTarget,
  setEffectParams,
  setEffectTarget,
  setInstanceCharacterState,
  setInstanceStage,
  placeOnStage,
  setPanelAutoDepthOrder,
  setPanelCamera,
  setPanelFocalItem,
  setPanelPerspective,
} from "./stageOps";

/**
 * Legacy framing vocabulary kept for existing tool calls. Every value resolves
 * to a canonical ShotType via `resolveShotType`; there is no second engine.
 */
export type SemanticFraming = "full-body" | "medium-full" | "medium" | "upper-body" | "close-up" | "face";

export type DomainCommand =
  | { type: "create-character"; name: string; appearance?: string; personalityNotes?: string }
  | { type: "create-asset"; input: NewAssetInput; generation?: Omit<GenerationRecord, "id" | "createdAt" | "resultAssetId"> }
  | { type: "set-asset-processed"; assetId: ID; update: Pick<SourceAsset, "processedImageUrl" | "hasAlpha" | "backgroundRemoved" | "processingStatus" | "backgroundRemovalStatus" | "processingReason" | "backgroundRemovalMethod" | "backgroundRemovalProvider"> }
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
  | { type: "move-item-to-index"; itemId: ID; index: number }
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
  | {
      type: "update-bubble";
      itemId: ID;
      patch: { text?: string; bubbleType?: BubbleType; fontSize?: number; tail?: Point; style?: Partial<BubbleStyle> };
    }
  | { type: "add-effect"; panelId: ID; effectKind: EffectKind }
  // ── Tones (non-destructive shading layers) ──
  | { type: "add-tone"; panelId: ID; presetId?: string; params?: Partial<ProceduralToneParams>; assetId?: ID; tileable?: boolean; mask?: ToneMask }
  | { type: "update-tone"; itemId: ID; patch: TonePatch }
  // ── Manga Language Library ──
  | { type: "add-language-asset"; input: NewLanguageAssetInput }
  | { type: "update-language-asset"; languageAssetId: ID; patch: { name?: string; tags?: string[]; category?: MangaLanguageCategory } }
  | { type: "duplicate-language-asset"; languageAssetId: ID }
  | { type: "delete-language-asset"; languageAssetId: ID }
  | { type: "place-language-asset"; panelId: ID; languageAssetId: ID; at?: Point; text?: string; attachToItemId?: ID }
  | { type: "attach-item"; itemId: ID; targetItemId: ID; anchor?: Point }
  | { type: "detach-item"; itemId: ID }
  | { type: "apply-attachments"; panelId: ID }
  | { type: "reshape-panel"; panelId: ID; points: Point[] }
  | { type: "set-page-layout"; pageId: ID; layout: LayoutPresetId }
  | { type: "add-page"; layout?: LayoutPresetId }
  | { type: "remove-page"; pageId: ID }
  | { type: "add-workspace-instance"; assetId: ID; at: Point }
  | { type: "update-workspace-instance"; itemId: ID; patch: { x?: number; y?: number; width?: number; height?: number; rotation?: number; flipX?: boolean; opacity?: number } }
  | { type: "workspace-to-panel"; itemId: ID; panelId: ID }
  | { type: "panel-to-workspace"; instanceId: ID; at?: Point }
  | { type: "delete-workspace-instance"; itemId: ID }
  | { type: "rename-project"; name: string }
  // ── Relationships and interactions ──
  | { type: "add-relationship"; characterAId: ID; characterBId: ID; relationshipType: RelationshipType; label?: string }
  | { type: "remove-relationship"; relationshipId: ID }
  | { type: "create-interaction"; input: CreateInteractionInput }
  | { type: "update-interaction"; interactionId: ID; patch: Parameters<typeof updateInteraction>[2] }
  | { type: "remove-interaction"; interactionId: ID }
  | { type: "set-interaction-anchor"; interactionId: ID; anchor: InteractionAnchor }
  | { type: "record-interaction-render"; input: Omit<InteractionRender, "id" | "createdAt"> }
  | { type: "set-project-style"; styleId: ID }
  | { type: "add-custom-style"; input: Omit<StyleProfile, "id" | "family"> }
  | { type: "validate-composition"; panelIds: ID[]; requirements?: CompositionRequirements; before?: ProjectDocument }
  // ── Virtual manga stage ──
  | { type: "set-panel-camera"; panelId: ID; patch: CameraPatch }
  | { type: "set-panel-perspective"; panelId: ID; patch: PerspectivePatch }
  | { type: "move-vanishing-point"; panelId: ID; index: number; point: Point }
  | { type: "set-instance-stage"; instanceId: ID; patch: Partial<InstanceStage> }
  | { type: "clear-instance-stage"; instanceId: ID }
  | { type: "set-instance-character-state"; instanceId: ID; state: CharacterState }
  | { type: "set-effect-params"; itemId: ID; patch: Record<string, unknown> }
  | { type: "set-effect-target"; itemId: ID; targetItemId?: ID }
  | { type: "set-bubble-target"; itemId: ID; characterId?: ID; instanceId?: ID }
  | { type: "refresh-bubble-tails"; panelId: ID }
  | { type: "set-state-calibration"; stateId: ID; calibration?: PoseCalibration }
  | { type: "set-panel-focal-item"; panelId: ID; itemId?: ID }
  | { type: "set-panel-auto-depth-order"; panelId: ID; enabled: boolean }
  | { type: "place-on-stage"; instanceId: ID; at: Point }
  // ── Manga Puppet: local, generation-free character edits (D36) ──
  | { type: "register-puppet"; puppet: MangaPuppet }
  | { type: "attach-puppet"; instanceId: ID; puppetId: ID }
  | { type: "detach-puppet"; instanceId: ID }
  | { type: "set-puppet-expression"; instanceId: ID; expressionId: string }
  | { type: "set-puppet-joint"; instanceId: ID; joint: PuppetJoint; degrees: number }
  | { type: "reset-puppet-pose"; instanceId: ID }
  | { type: "set-puppet-part"; instanceId: ID; partType: PuppetPartType; partId?: ID }
  | { type: "set-puppet-attachment"; instanceId: ID; attachmentId: ID; attached: boolean };

export interface CommandResult {
  doc: ProjectDocument;
  createdId?: ID;
  issues?: CompositionIssue[];
}

/**
 * Commands that can move or resize an item, and therefore have to drag any
 * attached manga-language effects along with it (§11). Listing them here keeps
 * "the sweat drop follows Yuri" a property of the document rather than
 * something every UI path has to remember to maintain.
 */
const ATTACHMENT_AFFECTING = new Set<DomainCommand["type"]>([
  "update-instance-transform",
  "set-framing",
  "set-instance-stage",
  "place-on-stage",
  "compose-character",
  "set-panel-camera",
  "set-panel-perspective",
  "swap-instance-asset",
  "attach-item",
  "delete-instance",
  "reshape-panel",
]);

export function applyDomainCommand(doc: ProjectDocument, command: DomainCommand): CommandResult {
  const result = applyCommandCore(doc, command);
  if (!ATTACHMENT_AFFECTING.has(command.type)) return result;
  // The pre-command document is consulted too, because a deletion removes the
  // very item whose panel we need — and a deleted subject is exactly when
  // stale attachments must be released.
  const panelId = affectedPanelId(result.doc, command) ?? affectedPanelId(doc, command);
  return panelId ? { ...result, doc: applyAttachments(result.doc, panelId) } : result;
}

function affectedPanelId(doc: ProjectDocument, command: DomainCommand): ID | undefined {
  if ("panelId" in command && typeof command.panelId === "string") return command.panelId;
  const itemId =
    "instanceId" in command && typeof command.instanceId === "string"
      ? command.instanceId
      : "itemId" in command && typeof command.itemId === "string"
        ? command.itemId
        : undefined;
  return itemId ? doc.items[itemId]?.panelId : undefined;
}

function applyCommandCore(doc: ProjectDocument, command: DomainCommand): CommandResult {
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
    case "move-item-to-index":
      return { doc: moveItemToIndex(doc, command.itemId, command.index) };
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
    case "add-tone": {
      const result = addTone(doc, command);
      return { doc: result.doc, createdId: result.itemId };
    }
    case "update-tone":
      return { doc: updateTone(doc, command.itemId, command.patch) };
    case "add-language-asset": {
      const result = addLanguageAsset(doc, command.input);
      return { doc: result.doc, createdId: result.languageAssetId };
    }
    case "update-language-asset":
      return { doc: updateLanguageAsset(doc, command.languageAssetId, command.patch) };
    case "duplicate-language-asset": {
      const result = duplicateLanguageAsset(doc, command.languageAssetId);
      return { doc: result.doc, createdId: result.languageAssetId };
    }
    case "delete-language-asset":
      return { doc: deleteLanguageAsset(doc, command.languageAssetId) };
    case "place-language-asset": {
      const result = placeLanguageAsset(doc, {
        panelId: command.panelId,
        languageAssetId: command.languageAssetId,
        at: command.at,
        text: command.text,
        attachToItemId: command.attachToItemId,
      });
      return { doc: result.doc, createdId: result.itemId };
    }
    case "attach-item":
      return { doc: attachItem(doc, command.itemId, command.targetItemId, command.anchor) };
    case "detach-item":
      return { doc: detachItem(doc, command.itemId) };
    case "apply-attachments":
      return { doc: applyAttachments(doc, command.panelId) };
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
    case "add-relationship": {
      const result = addRelationship(doc, {
        characterAId: command.characterAId,
        characterBId: command.characterBId,
        type: command.relationshipType,
        label: command.label,
      });
      return { doc: result.doc, createdId: result.relationshipId };
    }
    case "remove-relationship":
      return { doc: removeRelationship(doc, command.relationshipId) };
    case "create-interaction": {
      const result = createInteraction(doc, command.input);
      return { doc: result.doc, createdId: result.interactionId };
    }
    case "remove-interaction":
      return { doc: removeInteraction(doc, command.interactionId) };
    case "update-interaction":
      return { doc: updateInteraction(doc, command.interactionId, command.patch) };
    case "set-interaction-anchor":
      return { doc: setInteractionAnchor(doc, command.interactionId, command.anchor) };
    case "record-interaction-render": {
      const result = recordInteractionRender(doc, command.input);
      return { doc: result.doc, createdId: result.renderId };
    }
    case "rename-project":
      return { doc: renameProject(doc, command.name) };
    case "set-project-style":
      return { doc: setProjectStyle(doc, command.styleId) };
    case "add-custom-style": {
      const result = addCustomStyle(doc, command.input);
      return { doc: result.doc, createdId: result.styleId };
    }
    case "set-panel-camera":
      return { doc: setPanelCamera(doc, command.panelId, command.patch) };
    case "set-panel-perspective":
      return { doc: setPanelPerspective(doc, command.panelId, command.patch) };
    case "move-vanishing-point":
      return { doc: movePanelVanishingPoint(doc, command.panelId, command.index, command.point) };
    case "set-instance-stage":
      return { doc: setInstanceStage(doc, command.instanceId, command.patch) };
    case "clear-instance-stage":
      return { doc: clearInstanceStage(doc, command.instanceId) };
    case "set-instance-character-state":
      return { doc: setInstanceCharacterState(doc, command.instanceId, command.state) };
    case "set-effect-params":
      return { doc: setEffectParams(doc, command.itemId, command.patch) };
    case "set-effect-target":
      return { doc: setEffectTarget(doc, command.itemId, command.targetItemId) };
    case "set-bubble-target":
      return { doc: setBubbleTarget(doc, command.itemId, { characterId: command.characterId, instanceId: command.instanceId }) };
    case "refresh-bubble-tails":
      return { doc: refreshBubbleTails(doc, command.panelId) };
    case "set-panel-focal-item":
      return { doc: setPanelFocalItem(doc, command.panelId, command.itemId) };
    case "set-panel-auto-depth-order":
      return { doc: setPanelAutoDepthOrder(doc, command.panelId, command.enabled) };
    case "place-on-stage":
      return { doc: placeOnStage(doc, command.instanceId, command.at) };
    case "register-puppet":
      return { doc: registerPuppet(doc, command.puppet) };
    case "attach-puppet":
      return { doc: attachPuppetToInstance(doc, command.instanceId, command.puppetId) };
    case "detach-puppet":
      return { doc: detachPuppetFromInstance(doc, command.instanceId) };
    case "set-puppet-expression":
      return { doc: setPuppetExpression(doc, command.instanceId, command.expressionId) };
    case "set-puppet-joint":
      return { doc: setPuppetJoint(doc, command.instanceId, command.joint, command.degrees) };
    case "reset-puppet-pose":
      return { doc: resetPuppetPose(doc, command.instanceId) };
    case "set-puppet-part":
      return { doc: setPuppetPartOverride(doc, command.instanceId, command.partType, command.partId) };
    case "set-puppet-attachment":
      return { doc: setPuppetAttachment(doc, command.instanceId, command.attachmentId, command.attached) };
    case "set-state-calibration": {
      const next = cloneDoc(doc);
      setStateCalibration(next, command.stateId, command.calibration);
      touch(next);
      return { doc: next };
    }
    case "validate-composition": {
      const result = validateAndCorrectComposition(doc, command.panelIds, command.requirements, command.before);
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
  const placed = placeAsset(doc, command.panelId, command.assetId, { cropMode: "fit" });
  let next = placed.doc;
  const item = next.items[placed.itemId];
  if (item.kind !== "asset") throw new Error("Character placement failed");
  const panelRect = panelPxRect(next, command.panelId);
  const panelWidth = panelRect.width;
  const positionX = command.position === "left" ? panelWidth * 0.28 : command.position === "right" ? panelWidth * 0.72 : panelWidth * 0.5;

  // ONE framing engine (§1). A framing word resolves to the canonical ShotType
  // and is laid out by the same `frameSubject` the panel camera uses, so the
  // camera and a composed character can no longer disagree about what
  // "close-up" means.
  const shot = resolveShotType(command.framing);
  if (shot) {
    const framed = frameSubject({
      instance: item,
      panel: panelRect,
      shot,
      angle: next.panels[command.panelId]?.camera?.angle,
    });
    next = updateItemTransform(next, item.id, { cx: positionX, width: framed.width, height: framed.height });
    next = updateItemTransform(next, item.id, { cy: framed.cy });
  } else {
    const depthScale = command.depth === "foreground" ? 1.18 : command.depth === "background" ? 0.72 : 1;
    next = updateItemTransform(next, item.id, {
      cx: positionX,
      width: item.width * depthScale,
      height: item.height * depthScale,
    });
  }
  next = updateItemProps(next, item.id, { flipX: command.facing === "left" });
  next = setSceneCharacterSemantics(next, item.id, {
    role: command.role,
    depth: command.depth ?? "midground",
    facing: command.facing ?? "camera",
    semanticPosition: command.position ?? "center",
  });
  return { doc: next, createdId: item.id };
}


