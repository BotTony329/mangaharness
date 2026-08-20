import type { ID, ProjectDocument } from "@/domain/types";
import type { Selection } from "@/editor/store";

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
      label: selectedCharacter ? `Selected Character · ${selectedCharacter.name}` : `Selected Object · Panel ${panelNumber}`,
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

function inferSelectionScope(selection: Selection): AgentScopeKind {
  if (selection.itemId) return "selected-object";
  if (selection.panelId) return "selected-panel";
  return "current-page";
}

export function scopeInstruction(scope: AgentRunScope): string {
  if (scope.kind === "selected-object") {
    return `AUTHORITATIVE TARGET SCOPE: ${scope.label}. Modify only item ${scope.itemId}; do not add, remove, or alter other panel content.`;
  }
  if (scope.kind === "selected-panel") {
    return `AUTHORITATIVE TARGET SCOPE: ${scope.label}. Every panel-targeting tool MUST target panel ${scope.panelNumber}. Panels outside this scope must remain unchanged.`;
  }
  if (scope.kind === "current-page") {
    return `AUTHORITATIVE TARGET SCOPE: ${scope.label}. You may target panels 1-${scope.panelCount} on this page only.`;
  }
  return `AUTHORITATIVE TARGET SCOPE: ${scope.label}. Tools currently execute against the active page (${scope.pageName}, panels 1-${scope.panelCount}).`;
}
