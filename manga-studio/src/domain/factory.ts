/** Constructors for domain objects. IDs are uuid v4; time is injected-able for tests. */

import { LAYOUT_PRESETS } from "./layouts";
import {
  SCHEMA_VERSION,
  type Character,
  type ID,
  type LayoutPresetId,
  type Page,
  type Panel,
  type ProjectDocument,
  type Rect,
} from "./types";

export function newId(): ID {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export const DEFAULT_PANEL_BORDER = { visible: true, strokeWidthPx: 4, color: "#111111" };

export function createPanel(pageId: ID, rect: Rect): Panel {
  return { id: newId(), pageId, rect, border: { ...DEFAULT_PANEL_BORDER }, itemIds: [] };
}

export function createCharacter(projectId: ID, name: string, description?: string): Character {
  return { id: newId(), projectId, name, description, assetIds: [], createdAt: now() };
}

/** A fresh project starts with one four-grid page so the canvas is never empty. */
export function createProjectDocument(name: string, layout: LayoutPresetId = "four-grid"): ProjectDocument {
  const projectId = newId();
  const page: Page = { id: newId(), projectId, name: "Page 1", index: 0, panelIds: [] };
  const panels: Record<ID, Panel> = {};
  for (const rect of LAYOUT_PRESETS[layout].rects) {
    const panel = createPanel(page.id, rect);
    panels[panel.id] = panel;
    page.panelIds.push(panel.id);
  }
  const created = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      id: projectId,
      name,
      // B5-ish proportions at screen-friendly resolution; export can scale 2x.
      settings: { pageWidth: 1200, pageHeight: 1800, readingDirection: "rtl" },
      createdAt: created,
      updatedAt: created,
    },
    assets: {},
    characters: {},
    pages: { [page.id]: page },
    panels,
    items: {},
    generationHistory: [],
  };
}
