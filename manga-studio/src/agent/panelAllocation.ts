/**
 * Panel allocation — which panel each beat actually lands in.
 *
 * ## Why this is deterministic and not the planner's job
 *
 * A sequence of beats is a claim about TIME, and in manga time passes between
 * panels. The planner may recognise "then"; it may not be trusted to allocate
 * panels, because a model that puts beat two in panel one produces a drawing of
 * somebody running and shouting at the same instant, and nothing downstream
 * would notice. Allocation is arithmetic over the page, so the harness does it.
 *
 * ## Preservation
 *
 * Beats are placed in reading order starting at the panel the creator is
 * working in. Existing panels are never overwritten to make room: if the page
 * has too few panels the layout GROWS to the smallest preset that fits, which
 * carries every existing item forward (`pageOps.setPageLayout`). If even the
 * largest preset is too small the tail of the sequence moves to a new page
 * rather than displacing anything.
 */

import { LAYOUT_PRESETS } from "@/domain/layouts";
import type { ID, LayoutPresetId, ProjectDocument } from "@/domain/types";

export interface PanelAllocation {
  /** 1-based panel numbers on `pageId`, one per requested moment, in order. */
  panelNumbers: number[];
  pageId: ID;
  /** Set when the page must grow to fit; applied before any beat executes. */
  layoutUpgrade?: LayoutPresetId;
  /** Moments that did not fit on this page at all. */
  overflow: number;
  /** One line for the run log. */
  reason: string;
}

/**
 * Presets in growth order.
 *
 * Growth only ever ADDS panels, so a page never loses a frame to make room for
 * a sequence. `yonkoma` is preferred over `four-grid` at four panels only when
 * the page already is a yonkoma — a creator's chosen layout is not a detail to
 * be overwritten.
 */
const GROWTH: LayoutPresetId[] = ["single", "two-vertical", "three-vertical", "four-grid"];

function panelCount(layout: LayoutPresetId): number {
  return LAYOUT_PRESETS[layout].rects.length;
}

/** The smallest preset that holds `needed` panels, or null if none does. */
function smallestFitting(needed: number, current: LayoutPresetId | undefined): LayoutPresetId | null {
  // A yonkoma page that already fits stays a yonkoma.
  if (current && panelCount(current) >= needed) return null;
  for (const layout of GROWTH) if (panelCount(layout) >= needed) return layout;
  return null;
}

export interface AllocateInput {
  doc: ProjectDocument;
  pageId: ID;
  /** Where the creator is working; beats start here. 1-based. */
  anchorPanelNumber?: number;
  /** How many distinct visual moments the sequence needs. */
  requiredMoments: number;
  /** The page's current layout, when known. */
  currentLayout?: LayoutPresetId;
}

export function allocatePanels(input: AllocateInput): PanelAllocation {
  const { doc, pageId, requiredMoments } = input;
  const page = doc.pages[pageId];
  if (!page) throw new Error("No such page");

  const existing = page.panelIds.length;
  const anchor = Math.min(Math.max(1, input.anchorPanelNumber ?? 1), Math.max(1, existing));

  if (requiredMoments <= 1) {
    return {
      panelNumbers: [anchor],
      pageId,
      overflow: 0,
      reason: `One visual moment — panel ${anchor}.`,
    };
  }

  const lastNeeded = anchor + requiredMoments - 1;
  const upgrade = lastNeeded > existing ? smallestFitting(lastNeeded, input.currentLayout) : null;
  const capacity = upgrade ? panelCount(upgrade) : existing;

  const panelNumbers: number[] = [];
  for (let i = 0; i < requiredMoments; i += 1) {
    const number = anchor + i;
    if (number <= capacity) panelNumbers.push(number);
  }

  return {
    panelNumbers,
    pageId,
    layoutUpgrade: upgrade ?? undefined,
    overflow: requiredMoments - panelNumbers.length,
    reason: upgrade
      ? `${requiredMoments} sequential moments from panel ${anchor}: the page grows to ${LAYOUT_PRESETS[upgrade].label.toLowerCase()} so nothing is overwritten.`
      : `${requiredMoments} sequential moments from panel ${anchor}, using panels ${panelNumbers.join(", ")}.`,
  };
}

/** The layout a page is currently using, inferred from its panel count. */
export function inferLayout(doc: ProjectDocument, pageId: ID): LayoutPresetId | undefined {
  const count = doc.pages[pageId]?.panelIds.length ?? 0;
  return (Object.keys(LAYOUT_PRESETS) as LayoutPresetId[]).find((id) => panelCount(id) === count);
}
