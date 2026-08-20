/**
 * Loose workspace objects: reference sheets, staged generations, working
 * material arranged beside the manga pages. Conversions between workspace
 * items and panel instances are the only place item coordinates cross
 * coordinate spaces — the conversion is explicit here (see coords.ts).
 */

import { pageToPanelLocal, pageToWorkspace, panelBoundsPx, panelLocalToPage, workspaceToPage } from "./coords";
import { cloneDoc, touch } from "./docHelpers";
import { newId } from "./factory";
import { placeAsset } from "./itemOps";
import type { CropMode, ID, Point, ProjectDocument, WorkspaceItem } from "./types";

/** Default display size for a freshly dropped loose asset. */
const MAX_LOOSE_SIZE = 360;

export function addWorkspaceItem(
  doc: ProjectDocument,
  sourceAssetId: ID,
  at: Point,
): { doc: ProjectDocument; itemId: ID } {
  const asset = doc.assets[sourceAssetId];
  if (!asset) throw new Error(`Unknown asset: ${sourceAssetId}`);
  const next = cloneDoc(doc);
  const scale = Math.min(1, MAX_LOOSE_SIZE / Math.max(asset.width, asset.height));
  const item: WorkspaceItem = {
    id: newId(),
    sourceAssetId,
    x: at.x,
    y: at.y,
    width: asset.width * scale,
    height: asset.height * scale,
    rotation: 0,
    flipX: false,
    opacity: 1,
  };
  next.workspaceItems[item.id] = item;
  next.workspaceOrder.push(item.id);
  touch(next);
  return { doc: next, itemId: item.id };
}

export function updateWorkspaceItem(
  doc: ProjectDocument,
  itemId: ID,
  patch: Partial<Pick<WorkspaceItem, "x" | "y" | "width" | "height" | "rotation" | "flipX" | "opacity">>,
): ProjectDocument {
  const next = cloneDoc(doc);
  const item = next.workspaceItems[itemId];
  if (!item) throw new Error(`Unknown workspace item: ${itemId}`);
  Object.assign(item, patch);
  touch(next);
  return next;
}

export function removeWorkspaceItem(doc: ProjectDocument, itemId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  delete next.workspaceItems[itemId];
  next.workspaceOrder = next.workspaceOrder.filter((id) => id !== itemId);
  touch(next);
  return next;
}

/**
 * Drop a loose item into a panel: it becomes a regular panel instance at the
 * equivalent panel-local position, keeping its rendered size. The source
 * asset is untouched either way.
 */
export function workspaceItemToInstance(
  doc: ProjectDocument,
  itemId: ID,
  panelId: ID,
  options: { cropMode?: CropMode } = {},
): { doc: ProjectDocument; instanceId: ID } {
  const item = doc.workspaceItems[itemId];
  if (!item) throw new Error(`Unknown workspace item: ${itemId}`);
  const panel = doc.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  const page = doc.pages[panel.pageId];

  // workspace → page → panel-local, one visible hop each.
  const inPage = workspaceToPage({ x: item.x, y: item.y }, page);
  const local = pageToPanelLocal(inPage, panelBoundsPx(doc, panel));

  const placed = placeAsset(doc, panelId, item.sourceAssetId, {
    at: local,
    cropMode: options.cropMode ?? "custom",
  });
  let next = placed.doc;
  const instance = next.items[placed.itemId];
  if (instance.kind === "asset" && !options.cropMode) {
    // Keep the size it had on the workspace instead of the crop-mode default.
    instance.width = item.width;
    instance.height = item.height;
    instance.rotation = item.rotation;
    instance.flipX = item.flipX;
  }
  next = removeLooseItem(next, itemId);
  touch(next);
  return { doc: next, instanceId: placed.itemId };
}

/**
 * Drag a panel instance out onto the workspace: it becomes a loose item at
 * the equivalent workspace position. Never deletes the source asset.
 */
export function instanceToWorkspaceItem(
  doc: ProjectDocument,
  instanceId: ID,
  atWorkspace?: Point,
): { doc: ProjectDocument; itemId: ID } {
  const instance = doc.items[instanceId];
  if (!instance || instance.kind !== "asset") throw new Error("Only asset instances can leave a panel");
  const panel = doc.panels[instance.panelId];
  const page = doc.pages[panel.pageId];

  const inPage = panelLocalToPage({ x: instance.cx, y: instance.cy }, panelBoundsPx(doc, panel));
  const position = atWorkspace ?? pageToWorkspace(inPage, page);

  const next = cloneDoc(doc);
  const item: WorkspaceItem = {
    id: newId(),
    sourceAssetId: instance.sourceAssetId,
    x: position.x,
    y: position.y,
    width: instance.width,
    height: instance.height,
    rotation: instance.rotation,
    flipX: instance.flipX,
    opacity: instance.opacity,
  };
  next.workspaceItems[item.id] = item;
  next.workspaceOrder.push(item.id);
  delete next.items[instanceId];
  next.panels[instance.panelId].itemIds = next.panels[instance.panelId].itemIds.filter((id) => id !== instanceId);
  touch(next);
  return { doc: next, itemId: item.id };
}

function removeLooseItem(doc: ProjectDocument, itemId: ID): ProjectDocument {
  delete doc.workspaceItems[itemId];
  doc.workspaceOrder = doc.workspaceOrder.filter((id) => id !== itemId);
  return doc;
}
