/**
 * Laying a tone on a panel — the one implementation.
 *
 * Clicking a swatch, dragging one onto a panel, and the Agent applying one all
 * come through here and end at the same `add-tone` command. A second path would
 * be a second set of rules about which panel, what defaults and what gets
 * selected afterwards, and they would drift.
 */

import type { ID } from "@/domain/types";
import { useEditorStore } from "@/editor/store";

export const TONE_DRAG_TYPE = "application/x-kumanga-tone";

export interface ToneChoice {
  presetId?: string;
  assetId?: ID;
}

export function toneDragPayload(choice: ToneChoice): string {
  return JSON.stringify(choice);
}

export function parseToneDragPayload(raw: string): ToneChoice | null {
  try {
    const parsed = JSON.parse(raw) as ToneChoice;
    if (!parsed.presetId && !parsed.assetId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The panel a click should act on.
 *
 * Whatever the creator is working in: the selected panel, the panel holding the
 * selected item, else the first panel of the current page. Refusing to act
 * because nothing is selected would make the shelf feel broken — there is
 * always an obvious panel a click means.
 */
export function workingPanelId(): ID | undefined {
  const state = useEditorStore.getState();
  const doc = state.doc;
  if (!doc) return undefined;
  const { panelId, itemId } = state.selection;
  if (panelId && doc.panels[panelId]) return panelId;
  if (itemId && doc.items[itemId]) return doc.items[itemId].panelId;
  const page = state.currentPageId ? doc.pages[state.currentPageId] : undefined;
  return page?.panelIds[0];
}

export interface ApplyToneResult {
  itemId?: ID;
  error?: string;
}

/** Apply to an explicit panel. Returns the new layer so callers can select it. */
export function applyToneToPanel(panelId: ID, choice: ToneChoice): ApplyToneResult {
  const state = useEditorStore.getState();
  if (!state.doc?.panels[panelId]) return { error: "That panel is no longer there." };
  const result = state.dispatch({
    type: "add-tone",
    panelId,
    presetId: choice.presetId,
    assetId: choice.assetId,
  });
  if (result.createdId) state.select({ itemId: result.createdId, panelId });
  return { itemId: result.createdId };
}

/** Apply to whatever panel the creator is working in. */
export function applyToneToWorkingPanel(choice: ToneChoice): ApplyToneResult {
  const panelId = workingPanelId();
  if (!panelId) return { error: "Add a panel first, then choose a tone." };
  return applyToneToPanel(panelId, choice);
}
