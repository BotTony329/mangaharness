"use client";

/**
 * Camera target resolution — WHICH panel a camera intent applies to.
 *
 * Phase 5 contract: the camera belongs to exactly ONE panel, and the Agent
 * never guesses that panel. The deterministic ladder:
 *
 *   1. The director explicitly named a panel (map.target.panel).
 *   2. The creator has a panel selected on the current page.
 *   3. The current page holds exactly one panel.
 *
 * Anything else is AMBIGUOUS and becomes a clarification — never a silent
 * pick of the first/last/largest panel.
 */

import type { ID, ProjectDocument } from "@/domain/types";
import type { CreativeTaskMap } from "../contract/creativeTaskMap";

export type CameraTargetResolution =
  | { kind: "resolved"; panel: number; source: "explicit" | "selection" | "single-panel" }
  | { kind: "ambiguous"; question: string }
  | { kind: "no-camera" };

function panelNumberOf(doc: ProjectDocument, pageId: ID, panelId: ID): number | undefined {
  const index = doc.pages[pageId]?.panelIds.indexOf(panelId) ?? -1;
  return index >= 0 ? index + 1 : undefined;
}

export function resolveCameraTargetPanel(
  map: CreativeTaskMap,
  doc: ProjectDocument,
  context: { currentPageId: ID | null; selection: { panelId?: ID } },
): CameraTargetResolution {
  if (!map.cameraIntent) return { kind: "no-camera" };

  const page = context.currentPageId ? doc.pages[context.currentPageId] : undefined;
  const panelCount = page?.panelIds.length ?? 0;

  if (map.target.panel !== undefined) {
    return { kind: "resolved", panel: map.target.panel, source: "explicit" };
  }
  if (panelCount === 0) {
    return { kind: "ambiguous", question: "There is no panel on the current page to aim the camera at." };
  }

  const selected = context.selection.panelId && context.currentPageId
    ? panelNumberOf(doc, context.currentPageId, context.selection.panelId)
    : undefined;
  if (selected !== undefined) return { kind: "resolved", panel: selected, source: "selection" };

  if (panelCount === 1) return { kind: "resolved", panel: 1, source: "single-panel" };

  return {
    kind: "ambiguous",
    question: `Camera target is ambiguous — this page has ${panelCount} panels and none is selected. Select a panel or name one ("panel 2"), then repeat the camera change.`,
  };
}
