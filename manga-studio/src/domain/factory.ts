/** Constructors for domain objects. IDs are uuid v4; time is injected-able for tests. */

import { createPanelCamera } from "./camera";
import { createPanelPerspective } from "./perspective";
import { rectToPoints } from "./geometry";
import { LAYOUT_PRESETS } from "./layouts";
import {
  SCHEMA_VERSION,
  type Character,
  type ID,
  type LayoutPresetId,
  type Page,
  type Panel,
  type Point,
  type ProjectDocument,
  type Rect,
} from "./types";
import { DEFAULT_STYLE_PROFILE_ID } from "@/styles/profiles";
import { createEmptyScene } from "./sceneOps";

export function newId(): ID {
  // crypto.randomUUID only exists in secure contexts (https / localhost);
  // opening the dev server via a LAN IP would crash on boot without this
  // fallback, which builds a v4 UUID from getRandomValues instead.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export const DEFAULT_PANEL_BORDER = { visible: true, strokeWidthPx: 4, color: "#111111" };

/** Pages sit side by side on the workspace with a fixed gap. */
export function defaultPageWorkspacePosition(index: number, pageWidth: number): Point {
  return { x: index * (pageWidth + 240), y: 0 };
}

export function createPanel(pageId: ID, points: Point[]): Panel {
  return {
    id: newId(),
    pageId,
    points,
    border: { ...DEFAULT_PANEL_BORDER },
    itemIds: [],
    camera: createPanelCamera(),
    perspective: createPanelPerspective(),
  };
}

export function createPanelFromRect(pageId: ID, rect: Rect): Panel {
  return createPanel(pageId, rectToPoints(rect));
}

export function createCharacter(projectId: ID, name: string, description?: string): Character {
  return { id: newId(), projectId, name, description, assetIds: [], createdAt: now() };
}

/** A fresh project starts with one four-grid page so the canvas is never empty. */
export function createProjectDocument(name: string, layout: LayoutPresetId = "four-grid"): ProjectDocument {
  const projectId = newId();
  const page: Page = {
    id: newId(),
    projectId,
    name: "Page 1",
    index: 0,
    panelIds: [],
    workspace: defaultPageWorkspacePosition(0, 1200),
  };
  const panels: Record<ID, Panel> = {};
  const scenes: ProjectDocument["scenes"] = {};
  for (const rect of LAYOUT_PRESETS[layout].rects) {
    const panel = createPanelFromRect(page.id, rect);
    panels[panel.id] = panel;
    scenes[panel.id] = createEmptyScene(panel.id);
    page.panelIds.push(panel.id);
  }
  const created = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      id: projectId,
      name,
      // B5-ish proportions at screen-friendly resolution; export can scale 2x.
      settings: {
        pageWidth: 1200,
        pageHeight: 1800,
        readingDirection: "rtl",
        artStyle: { activeStyleId: DEFAULT_STYLE_PROFILE_ID, customProfiles: {} },
      },
      createdAt: created,
      updatedAt: created,
    },
    assets: {},
    characters: {},
    pages: { [page.id]: page },
    panels,
    scenes,
    characterStates: {},
    puppets: {},
    items: {},
    workspaceItems: {},
    workspaceOrder: [],
    generationHistory: [],
  };
}
