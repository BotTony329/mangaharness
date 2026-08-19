/** Small shared lookups used by the mutation modules. */

import { panelRectToPx } from "./geometry";
import type { ID, PanelItem, ProjectDocument, Rect } from "./types";

/** All mutations clone-then-edit so callers can keep snapshots for undo. */
export function cloneDoc(doc: ProjectDocument): ProjectDocument {
  return structuredClone(doc);
}

export function touch(doc: ProjectDocument): void {
  doc.project.updatedAt = new Date().toISOString();
}

export function panelPxRect(doc: ProjectDocument, panelId: ID): Rect {
  const panel = doc.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  const { pageWidth, pageHeight } = doc.project.settings;
  return panelRectToPx(panel.rect, pageWidth, pageHeight);
}

/**
 * Default stacking bands (bottom → top): background, props/uploads,
 * characters, effects, bubbles. New items are inserted at the top of their
 * band; the user can still reorder freely afterwards — bands are defaults,
 * not cages.
 */
export function itemBand(doc: ProjectDocument, item: PanelItem): number {
  if (item.kind === "bubble") return 4;
  if (item.kind === "effect") return 3;
  const category = doc.assets[item.sourceAssetId]?.category;
  if (category === "background") return 0;
  if (category === "character") return 2;
  return 1;
}

export function insertIndexForBand(doc: ProjectDocument, panelItemIds: ID[], band: number): number {
  // Insert above the last item whose band is <= the new item's band.
  let index = 0;
  panelItemIds.forEach((id, i) => {
    const existing = doc.items[id];
    if (existing && itemBand(doc, existing) <= band) index = i + 1;
  });
  return index;
}
