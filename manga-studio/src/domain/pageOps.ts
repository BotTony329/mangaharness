/** Mutations for pages and panel layouts. */

import { cloneDoc, touch } from "./docHelpers";
import { createPanelFromRect, defaultPageWorkspacePosition, newId } from "./factory";
import { LAYOUT_PRESETS } from "./layouts";
import type { ID, LayoutPresetId, Page, ProjectDocument } from "./types";

export function addPage(
  doc: ProjectDocument,
  layout: LayoutPresetId = "four-grid",
): { doc: ProjectDocument; pageId: ID } {
  const next = cloneDoc(doc);
  const index = Object.keys(next.pages).length;
  const page: Page = {
    id: newId(),
    projectId: next.project.id,
    name: `Page ${index + 1}`,
    index,
    panelIds: [],
    workspace: defaultPageWorkspacePosition(index, next.project.settings.pageWidth),
  };
  next.pages[page.id] = page;
  applyLayout(next, page, layout);
  touch(next);
  return { doc: next, pageId: page.id };
}

/**
 * Replace a page's panel arrangement. Content is never silently deleted:
 * existing panel item stacks are re-homed into the new panels by position
 * (panel 1 → panel 1, …); overflow stacks land in the last new panel.
 */
export function setPageLayout(doc: ProjectDocument, pageId: ID, layout: LayoutPresetId): ProjectDocument {
  const next = cloneDoc(doc);
  const page = next.pages[pageId];
  if (!page) throw new Error(`Unknown page: ${pageId}`);

  const oldStacks = page.panelIds.map((panelId) => {
    const stack = next.panels[panelId]?.itemIds ?? [];
    delete next.panels[panelId];
    return stack;
  });

  applyLayout(next, page, layout);

  page.panelIds.forEach((panelId, i) => {
    const carried = oldStacks[i] ?? [];
    // Panels beyond the new count collapse into the last panel.
    const overflow = i === page.panelIds.length - 1 ? oldStacks.slice(page.panelIds.length).flat() : [];
    const itemIds = [...carried, ...overflow];
    next.panels[panelId].itemIds = itemIds;
    for (const itemId of itemIds) {
      const item = next.items[itemId];
      if (item) item.panelId = panelId;
    }
  });

  touch(next);
  return next;
}

export function removePage(doc: ProjectDocument, pageId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const page = next.pages[pageId];
  if (!page) return next;
  for (const panelId of page.panelIds) {
    for (const itemId of next.panels[panelId]?.itemIds ?? []) delete next.items[itemId];
    delete next.panels[panelId];
  }
  delete next.pages[pageId];
  Object.values(next.pages)
    .sort((a, b) => a.index - b.index)
    .forEach((p, i) => {
      p.index = i;
    });
  touch(next);
  return next;
}

function applyLayout(doc: ProjectDocument, page: Page, layout: LayoutPresetId): void {
  page.panelIds = [];
  for (const rect of LAYOUT_PRESETS[layout].rects) {
    const panel = createPanelFromRect(page.id, rect);
    doc.panels[panel.id] = panel;
    page.panelIds.push(panel.id);
  }
}
