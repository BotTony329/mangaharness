import { cloneDoc, panelPxRect, touch } from "./docHelpers";
import type { AssetInstance, ID, ProjectDocument, Rect } from "./types";

export type CompositionIssueCode =
  | "required-character-missing"
  | "character-outside-panel"
  | "character-too-small"
  | "background-missing"
  | "character-obscured"
  | "scope-integrity"
  /** A step asked for one character and the document ended up with another. */
  | "identity-mismatch"
  /** A persistent Character appeared that the user never asked for. */
  | "unauthorized-character-creation";

export interface CompositionIssue {
  code: CompositionIssueCode;
  panelId: ID;
  itemId?: ID;
  message: string;
  corrected: boolean;
}

export interface CompositionRequirements {
  requiredCharacterIds?: ID[];
  requireBackground?: boolean;
}

export function validateAndCorrectComposition(
  doc: ProjectDocument,
  panelIds: ID[],
  requirements: CompositionRequirements = {},
): { doc: ProjectDocument; issues: CompositionIssue[] } {
  const next = cloneDoc(doc);
  const issues: CompositionIssue[] = [];
  for (const panelId of panelIds) {
    const panel = next.panels[panelId];
    if (!panel) continue;
    const scene = next.scenes[panelId];
    const rect = panelPxRect(next, panelId);
    if (requirements.requireBackground && !scene?.backgroundAssetId) {
      issues.push({ code: "background-missing", panelId, message: "Required background is missing", corrected: false });
    }
    for (const characterId of requirements.requiredCharacterIds ?? []) {
      if (!scene?.characters.some((entry) => entry.characterId === characterId)) {
        issues.push({ code: "required-character-missing", panelId, message: `Required Character ${characterId} is missing`, corrected: false });
      }
    }
    const characterItems = panel.itemIds
      .map((id) => next.items[id])
      .filter((item): item is AssetInstance => item?.kind === "asset" && Boolean(item.characterState));
    for (const item of characterItems) {
      const visibleRatio = intersectionArea(itemRect(item), { x: 0, y: 0, width: rect.width, height: rect.height }) /
        Math.max(1, item.width * item.height);
      if (visibleRatio < 0.18) {
        item.cx = rect.width / 2;
        item.cy = rect.height / 2;
        issues.push({ code: "character-outside-panel", panelId, itemId: item.id, message: "Character was mostly outside the panel and was recentered", corrected: true });
      }
      const sizeRatio = (item.width * item.height) / Math.max(1, rect.width * rect.height);
      if (sizeRatio < 0.025) {
        const scale = Math.sqrt(0.12 / Math.max(sizeRatio, 0.0001));
        item.width *= scale;
        item.height *= scale;
        issues.push({ code: "character-too-small", panelId, itemId: item.id, message: "Character was extremely small and was enlarged", corrected: true });
      }
      const index = panel.itemIds.indexOf(item.id);
      const obscured = panel.itemIds.slice(index + 1).some((otherId) => {
        const other = next.items[otherId];
        return other?.kind === "asset" && other.opacity >= 0.95 && contains(itemRect(other), itemRect(item));
      });
      if (obscured) issues.push({ code: "character-obscured", panelId, itemId: item.id, message: "Character is completely obscured by a higher layer", corrected: false });
    }
  }
  if (issues.some((issue) => issue.corrected)) touch(next);
  return { doc: next, issues };
}

export function validateScopeIntegrity(
  before: ProjectDocument,
  after: ProjectDocument,
  scope: { kind: "selected-object" | "selected-panel" | "current-page" | "whole-project"; pageId: ID; panelId?: ID; itemId?: ID },
): CompositionIssue[] {
  if (scope.kind === "current-page" || scope.kind === "whole-project") return [];
  const allowedPanelId = scope.panelId;
  const issues: CompositionIssue[] = [];
  if (scope.kind === "selected-object" && allowedPanelId) {
    const beforePanel = before.panels[allowedPanelId];
    const afterPanel = after.panels[allowedPanelId];
    const otherIds = new Set([
      ...(beforePanel?.itemIds ?? []),
      ...(afterPanel?.itemIds ?? []),
    ].filter((id) => id !== scope.itemId));
    const siblingsChanged = [...otherIds].some((id) => JSON.stringify(before.items[id]) !== JSON.stringify(after.items[id]));
    const membershipChanged = JSON.stringify(beforePanel?.itemIds) !== JSON.stringify(afterPanel?.itemIds);
    if (siblingsChanged || membershipChanged) {
      issues.push({ code: "scope-integrity", panelId: allowedPanelId, message: "Content outside the selected object changed", corrected: false });
    }
  }
  const page = before.pages[scope.pageId];
  for (const panelId of page?.panelIds ?? []) {
    if (panelId === allowedPanelId) continue;
    const beforePanel = before.panels[panelId];
    const afterPanel = after.panels[panelId];
    const beforeItems = beforePanel?.itemIds.map((id) => before.items[id]);
    const afterItems = afterPanel?.itemIds.map((id) => after.items[id]);
    if (JSON.stringify({ panel: beforePanel, items: beforeItems }) !== JSON.stringify({ panel: afterPanel, items: afterItems })) {
      issues.push({ code: "scope-integrity", panelId, message: "A panel outside the authoritative scope changed", corrected: false });
    }
  }
  return issues;
}

function itemRect(item: AssetInstance): Rect {
  return { x: item.cx - item.width / 2, y: item.cy - item.height / 2, width: item.width, height: item.height };
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function contains(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}
