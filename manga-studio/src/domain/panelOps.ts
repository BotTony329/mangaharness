/**
 * Panel geometry mutations. Presets create the initial shape; these commands
 * let the creator (or the agent) own the layout afterwards — including
 * non-rectangular manga panels.
 */

import { cloneDoc, touch } from "./docHelpers";
import type { ID, Point, ProjectDocument } from "./types";

export const MIN_PANEL_POINTS = 3;
export const MAX_PANEL_POINTS = 10;

/** Replace a panel's polygon (normalized page coords, clamped to the page). */
export function reshapePanel(doc: ProjectDocument, panelId: ID, points: Point[]): ProjectDocument {
  if (points.length < MIN_PANEL_POINTS || points.length > MAX_PANEL_POINTS) {
    throw new Error(`Panel shape needs ${MIN_PANEL_POINTS}–${MAX_PANEL_POINTS} points`);
  }
  const next = cloneDoc(doc);
  const panel = next.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  panel.points = points.map(clampToPage);
  assertNotDegenerate(panel.points);
  touch(next);
  return next;
}

/** Move a single vertex — the drag interaction in shape-edit mode. */
export function movePanelPoint(doc: ProjectDocument, panelId: ID, index: number, point: Point): ProjectDocument {
  const next = cloneDoc(doc);
  const panel = next.panels[panelId];
  if (!panel) throw new Error(`Unknown panel: ${panelId}`);
  if (index < 0 || index >= panel.points.length) throw new Error("No such panel point");
  panel.points[index] = clampToPage(point);
  touch(next);
  return next;
}

function clampToPage(point: Point): Point {
  return { x: clamp01(point.x), y: clamp01(point.y) };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A zero-area polygon would render nothing and break framing math. */
function assertNotDegenerate(points: Point[]): void {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(area / 2) < 0.0005) throw new Error("Panel shape is degenerate (zero area)");
}
