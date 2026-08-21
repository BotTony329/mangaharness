/**
 * Scope — WHERE the Agent may write.
 *
 * Scope is a blast radius, not a subject. It never asserts what KIND of thing
 * is selected: a page may hold panels, characters, scenes, objects, bubbles,
 * effects and composite renders, and which of those a request needs is decided
 * by the planner after it understands the request — not here.
 *
 * See `subject.ts` for the other half of the pair.
 */

import type { ID, ProjectDocument } from "@/domain/types";
import type { Selection } from "@/editor/store";
import type { SubjectResolution } from "./subject";

export type AgentScopeKind = "selected-object" | "selected-panel" | "current-page" | "whole-project";

export interface AgentRunScope {
  kind: AgentScopeKind;
  pageId: ID;
  pageName: string;
  panelCount: number;
  panelId?: ID;
  panelNumber?: number;
  itemId?: ID;
  label: string;
  /**
   * Set when the scope was widened because the request named somebody other
   * than the selected object. Surfaced in the run log so the creator can see
   * that their selection was treated as context rather than as a target.
   */
  demotedFrom?: AgentScopeKind;
  demotionReason?: string;
}

export type AgentScopePreference = "auto" | AgentScopeKind;

const PROJECT_EXPANSION = /\b(whole project|entire project|all pages|every page)\b/i;
const PAGE_EXPANSION =
  /\b(whole page|entire page|current page|all (?:the )?(?:\d+|four|three|two)?\s*panels?|every panel|yonkoma|four[- ]panel|4[- ]panel)\b/i;

/** Resolve scope once at Run time. The returned snapshot is authoritative for the whole run. */
export function resolveAgentScope(input: {
  doc: ProjectDocument;
  currentPageId: ID | null;
  selection: Selection;
  prompt: string;
  preference?: AgentScopePreference;
}): AgentRunScope {
  const { doc, selection, prompt } = input;
  const page = input.currentPageId ? doc.pages[input.currentPageId] : undefined;
  if (!page) throw new Error("No current page");

  const explicit = input.preference && input.preference !== "auto" ? input.preference : undefined;
  const expanded = !explicit
    ? PROJECT_EXPANSION.test(prompt)
      ? "whole-project"
      : PAGE_EXPANSION.test(prompt)
        ? "current-page"
        : undefined
    : undefined;
  const kind = explicit ?? expanded ?? inferSelectionScope(selection);
  const selectedItem = selection.itemId ? doc.items[selection.itemId] : undefined;
  const selectedPanelId = selectedItem?.panelId ?? selection.panelId;
  const panelNumber = selectedPanelId ? page.panelIds.indexOf(selectedPanelId) + 1 : undefined;

  if (kind === "selected-object" && selectedItem && panelNumber && panelNumber > 0) {
    const selectedAsset = selectedItem.kind === "asset" ? doc.assets[selectedItem.sourceAssetId] : undefined;
    const selectedCharacter = selectedAsset?.metadata?.characterId
      ? doc.characters[selectedAsset.metadata.characterId]
      : undefined;
    return {
      kind,
      pageId: page.id,
      pageName: page.name,
      panelCount: page.panelIds.length,
      panelId: selectedItem.panelId,
      panelNumber,
      itemId: selectedItem.id,
      label: selectedCharacter
        ? `Selected Character · ${selectedCharacter.name}`
        : `Selected Object · ${selectedAsset?.name ?? describeItemKind(selectedItem.kind)} · Panel ${panelNumber}`,
    };
  }
  if (kind === "selected-panel" && selectedPanelId && panelNumber && panelNumber > 0) {
    return {
      kind,
      pageId: page.id,
      pageName: page.name,
      panelCount: page.panelIds.length,
      panelId: selectedPanelId,
      panelNumber,
      label: `Selected Panel · Panel ${panelNumber}`,
    };
  }
  if (kind === "whole-project") {
    return {
      kind,
      pageId: page.id,
      pageName: page.name,
      panelCount: page.panelIds.length,
      label: "Whole Project",
    };
  }
  return {
    kind: "current-page",
    pageId: page.id,
    pageName: page.name,
    panelCount: page.panelIds.length,
    label: `Current Page · ${page.name}`,
  };
}

/** A creator-facing word for a non-asset item, for the scope label. */
function describeItemKind(kind: string): string {
  if (kind === "bubble") return "Speech bubble";
  if (kind === "effect") return "Effect";
  return "Object";
}

/**
 * Widen a selection-locked scope when the request is about somebody else.
 *
 * "Let Cute Girl run" with a lamp selected used to produce a scope that
 * permitted only edits to the lamp, so every step the request needed was
 * rejected as a scope violation and the run did nothing. The selection stays
 * useful — it still says WHICH PANEL the creator is working in — but it stops
 * being a target the named subject has to match.
 *
 * The widening is deliberately minimal: one step, object → panel, never
 * straight to the whole page. A request about another character in the panel
 * the creator is looking at should not gain permission to rewrite the page.
 */
export function scopeForSubject(scope: AgentRunScope, subject: SubjectResolution, doc: ProjectDocument): AgentRunScope {
  if (scope.kind !== "selected-object") return scope;

  const selectedItem = scope.itemId ? doc.items[scope.itemId] : undefined;
  const selectedCharacterId =
    selectedItem?.kind === "asset"
      ? selectedItem.characterState?.characterId ?? doc.assets[selectedItem.sourceAssetId]?.metadata?.characterId
      : undefined;

  // The request is about the selected thing, or about no character at all.
  if (subject.basis === "none" || subject.usedSelection) return scope;
  if (selectedCharacterId && subject.characterIds.includes(selectedCharacterId)) return scope;

  const panelNumber = scope.panelNumber;
  if (!scope.panelId || !panelNumber) return scope;
  return {
    kind: "selected-panel",
    pageId: scope.pageId,
    pageName: scope.pageName,
    panelCount: scope.panelCount,
    panelId: scope.panelId,
    panelNumber,
    label: `Selected Panel · Panel ${panelNumber}`,
    demotedFrom: "selected-object",
    demotionReason: `The request names ${subject.characterIds.length > 1 ? "characters" : "a character"} other than the selected object, so the selection was used as context rather than as the target.`,
  };
}

function inferSelectionScope(selection: Selection): AgentScopeKind {
  if (selection.itemId) return "selected-object";
  if (selection.panelId) return "selected-panel";
  return "current-page";
}

export function scopeInstruction(scope: AgentRunScope): string {
  if (scope.kind === "selected-object") {
    return `AUTHORITATIVE TARGET SCOPE: ${scope.label}. Modify only item ${scope.itemId}; do not add, remove, or alter other panel content.`;
  }
  if (scope.kind === "selected-panel" && scope.demotedFrom === "selected-object") {
    return `AUTHORITATIVE TARGET SCOPE: ${scope.label}. The creator has an object selected, but the request names a different subject, so the selection is CONTEXT ONLY. Every panel-targeting tool MUST target panel ${scope.panelNumber}. Panels outside this scope must remain unchanged.`;
  }
  if (scope.kind === "selected-panel") {
    return `AUTHORITATIVE TARGET SCOPE: ${scope.label}. Every panel-targeting tool MUST target panel ${scope.panelNumber}. Panels outside this scope must remain unchanged.`;
  }
  if (scope.kind === "current-page") {
    return `AUTHORITATIVE TARGET SCOPE: ${scope.label}. You may target panels 1-${scope.panelCount} on this page only.`;
  }
  return `AUTHORITATIVE TARGET SCOPE: ${scope.label}. Tools currently execute against the active page (${scope.pageName}, panels 1-${scope.panelCount}).`;
}
