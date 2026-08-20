import { cloneDoc, panelPxRect, touch } from "./docHelpers";
import type {
  ID,
  PanelScene,
  ProjectDocument,
  SceneCharacter,
  SceneContinuity,
  SceneDepth,
  SceneFacing,
  ScenePosition,
  SceneRelationship,
} from "./types";

export function createEmptyScene(panelId: ID): PanelScene {
  return { panelId, characters: [], relationships: [], dialogue: [] };
}

/** Synchronize structural scene facts while retaining authored semantic annotations. */
export function syncPanelScene(doc: ProjectDocument, panelId: ID): void {
  const panel = doc.panels[panelId];
  if (!panel) {
    delete doc.scenes[panelId];
    return;
  }
  const previous = doc.scenes[panelId] ?? createEmptyScene(panelId);
  const previousCharacters = new Map(previous.characters.map((entry) => [entry.characterInstanceId, entry]));
  let backgroundAssetId: ID | undefined;
  const characters: SceneCharacter[] = [];
  const dialogue: string[] = [];
  const panelRect = panelPxRect(doc, panelId);

  for (const itemId of panel.itemIds) {
    const item = doc.items[itemId];
    if (!item) continue;
    if (item.kind === "bubble") {
      dialogue.push(item.text);
      continue;
    }
    if (item.kind !== "asset") continue;
    const asset = doc.assets[item.sourceAssetId];
    if (asset?.category === "background") backgroundAssetId = asset.id;
    const characterId = item.characterState?.characterId ?? asset?.metadata?.characterId;
    if (!characterId) continue;
    const prior = previousCharacters.get(item.id);
    characters.push({
      characterInstanceId: item.id,
      characterId,
      role: prior?.role,
      depth: prior?.depth ?? "midground",
      facing: prior?.facing ?? (item.flipX ? "left" : "right"),
      semanticPosition: prior?.semanticPosition ?? positionFromX(item.cx, panelRect.width),
    });
  }

  const liveCharacterIds = new Set(characters.map((entry) => entry.characterId));
  doc.scenes[panelId] = {
    ...previous,
    panelId,
    backgroundAssetId,
    characters,
    dialogue,
    relationships: previous.relationships.filter(
      (relation) => liveCharacterIds.has(relation.subjectCharacterId) &&
        (!relation.targetCharacterId || liveCharacterIds.has(relation.targetCharacterId)),
    ),
  };
}

export function rebuildAllScenes(doc: ProjectDocument): void {
  doc.scenes ??= {};
  for (const panelId of Object.keys(doc.panels)) syncPanelScene(doc, panelId);
  for (const panelId of Object.keys(doc.scenes)) {
    if (!doc.panels[panelId]) delete doc.scenes[panelId];
  }
}

export function setSceneCharacterSemantics(
  doc: ProjectDocument,
  instanceId: ID,
  patch: { role?: string; depth?: SceneDepth; facing?: SceneFacing; semanticPosition?: ScenePosition },
): ProjectDocument {
  const next = cloneDoc(doc);
  const item = next.items[instanceId];
  if (!item || item.kind !== "asset") throw new Error("Character instance not found");
  syncPanelScene(next, item.panelId);
  const entry = next.scenes[item.panelId].characters.find((candidate) => candidate.characterInstanceId === instanceId);
  if (!entry) throw new Error("Instance is not linked to a Character");
  Object.assign(entry, patch);
  touch(next);
  return next;
}

export function addSceneRelationship(
  doc: ProjectDocument,
  panelId: ID,
  relationship: Omit<SceneRelationship, "id">,
): ProjectDocument {
  const next = cloneDoc(doc);
  syncPanelScene(next, panelId);
  const characterIds = new Set(next.scenes[panelId].characters.map((entry) => entry.characterId));
  if (!characterIds.has(relationship.subjectCharacterId)) throw new Error("Relationship subject is not in the scene");
  if (relationship.targetCharacterId && !characterIds.has(relationship.targetCharacterId)) {
    throw new Error("Relationship target is not in the scene");
  }
  next.scenes[panelId].relationships.push({ id: crypto.randomUUID(), ...relationship });
  touch(next);
  return next;
}

export function setSceneContinuity(
  doc: ProjectDocument,
  panelId: ID,
  continuity: SceneContinuity,
): ProjectDocument {
  const next = cloneDoc(doc);
  syncPanelScene(next, panelId);
  next.scenes[panelId].continuity = continuity;
  touch(next);
  return next;
}

function positionFromX(x: number, panelWidth: number): ScenePosition {
  if (x < panelWidth / 3) return "left";
  if (x > (panelWidth * 2) / 3) return "right";
  return "center";
}
