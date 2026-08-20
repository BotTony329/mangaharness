/**
 * Coordinate spaces — read this before touching canvas math.
 *
 * There are three spaces, converted in this order:
 *
 *   Viewport (screen px)
 *     ↓ Konva stage transform (pan + zoom) — handled by the canvas layer only
 *   Workspace (infinite canvas px) — pages and loose items live here
 *     ↓ subtract page.workspace (the page's top-left)
 *   Page (page px) — panel polygons live here (normalized, × page size)
 *     ↓ subtract the panel polygon's bounding-box origin
 *   Panel-local (px) — panel item transforms (cx/cy) live here
 *
 * Every function below converts exactly one hop. Never chain conversions
 * implicitly inside feature code — compose these helpers so the hop is
 * visible at the call site.
 */

import { polygonBounds, polygonToPx } from "./geometry";
import type { Page, Panel, Point, ProjectDocument, Rect } from "./types";

export function pageSize(doc: ProjectDocument): { width: number; height: number } {
  return { width: doc.project.settings.pageWidth, height: doc.project.settings.pageHeight };
}

/** Panel polygon in page pixels. */
export function panelPolygonPx(doc: ProjectDocument, panel: Panel): Point[] {
  const { width, height } = pageSize(doc);
  return polygonToPx(panel.points, width, height);
}

/** Panel bounding box in page pixels — the origin of panel-local space. */
export function panelBoundsPx(doc: ProjectDocument, panel: Panel): Rect {
  return polygonBounds(panelPolygonPx(doc, panel));
}

export function workspaceToPage(point: Point, page: Page): Point {
  return { x: point.x - page.workspace.x, y: point.y - page.workspace.y };
}

export function pageToWorkspace(point: Point, page: Page): Point {
  return { x: point.x + page.workspace.x, y: point.y + page.workspace.y };
}

export function pageToPanelLocal(point: Point, panelBounds: Rect): Point {
  return { x: point.x - panelBounds.x, y: point.y - panelBounds.y };
}

export function panelLocalToPage(point: Point, panelBounds: Rect): Point {
  return { x: point.x + panelBounds.x, y: point.y + panelBounds.y };
}
