"use client";

import type { DomainCommand } from "@/domain/commands";
import type { AssetInstance, Character, ID, Point, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { requireCharacter } from "@/agent/resolver";
import type { AgentRunScope } from "@/agent/scope";
import type { RunContext, RunGuards } from "../types";

/** Set by createRunContext at run start; a run is strictly sequential in the browser. */
let ctxGuards: RunGuards = { creationAuthorized: false, authorizedCreationNames: [] };

function currentDoc(): ProjectDocument {
  const doc = useEditorStore.getState().doc;
  if (!doc) throw new Error("No open project");
  return doc;
}

function dispatch(command: DomainCommand) {
  return useEditorStore.getState().dispatch(command);
}

function panelIdByNumber(panel: number): ID {
  const state = useEditorStore.getState();
  const doc = currentDoc();
  const page = state.currentPageId ? doc.pages[state.currentPageId] : null;
  if (!page) throw new Error("No current page");
  const panelId = page.panelIds[panel - 1];
  if (!panelId) throw new Error(`Panel ${panel} does not exist (page has ${page.panelIds.length})`);
  return panelId;
}

/**
 * Persistent Character creation — the privileged operation.
 *
 * The guard here is the last line of defence and repeats the plan-validation
 * check on purpose: plan validation protects against a bad plan, this protects
 * against a bad *executor caller*. Failing to resolve a name is never grounds
 * for creating a character, so an unauthorized run throws instead of quietly
 * adding one to the library.
 */

/** Resolution that reports "no unambiguous match" rather than throwing. */
function requireCharacterOrNull(
  doc: ProjectDocument,
  args: { characterId?: string; characterName?: string },
): ReturnType<typeof requireCharacter> | null {
  try {
    return requireCharacter(doc, args, { selectedCharacterId: ctxGuards.selectedCharacterId });
  } catch {
    return null;
  }
}

/**
 * Agent-generated results are staged as loose items beside the page — the
 * creator reviews spatially (compare, drag into a panel, or delete) instead
 * of results vanishing into the library.
 */
function stageOnWorkspace(assetId: ID): void {
  const state = useEditorStore.getState();
  const doc = state.doc;
  const page = state.currentPageId ? doc?.pages[state.currentPageId] : null;
  if (!doc || !page) return;
  const index = doc.workspaceOrder.length;
  const at: Point = {
    x: page.workspace.x + doc.project.settings.pageWidth + 300 + Math.floor(index / 4) * 400,
    y: page.workspace.y + 220 + (index % 4) * 420,
  };
  dispatch({ type: "add-workspace-instance", assetId, at });
}

/** Resolve which character instance a slot change targets: explicit panel/name, else the user's selection. */
function findTargetInstance(
  doc: ProjectDocument,
  args: { panel?: number; characterName?: string; characterId?: ID },
  scope?: AgentRunScope,
): AssetInstance {
  const state = useEditorStore.getState();
  const named = args.characterId !== undefined || args.characterName !== undefined;
  const characterByName = named
    ? requireCharacter(doc, args, { selectedCharacterId: ctxGuards.selectedCharacterId })
    : null;

  /**
   * Precedence: an explicitly grounded character outranks the selection.
   *
   * This block used to run FIRST and unconditionally, so a selected lamp became
   * the target of "make Cute Girl run" and the step died on "the scoped object
   * is not a character asset". Selection is evidence about which panel the
   * creator is working in; it is not a claim about who they mean.
   *
   * The selected object is consulted only when the step named nobody.
   */
  if (!named && scope?.kind === "selected-object" && scope.itemId) {
    const item = doc.items[scope.itemId];
    /**
     * A non-character selection is not an error here. It simply carries no
     * character, so resolution falls through to the panel search below and
     * fails with a message about what was actually missing.
     */
    if (item?.kind === "asset") {
      const characterId = item.characterState?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId;
      if (characterId) return item;
    }
  }

  const candidates: AssetInstance[] = [];
  const collect = (panelId: ID | undefined) => {
    for (const id of (panelId && doc.panels[panelId]?.itemIds) || []) {
      const item = doc.items[id];
      if (item?.kind === "asset") candidates.push(item);
    }
  };

  if (args.panel !== undefined) {
    collect(panelIdByNumber(args.panel));
  } else if (characterByName) {
    /**
     * A named character with no panel given: look in the panel the creator is
     * working in first, then across the scoped page. Falling back to "whatever
     * is selected" is what let an unrelated object answer for a named subject.
     */
    collect(scope?.panelId);
    if (candidates.length === 0) {
      const page = scope ? doc.pages[scope.pageId] : undefined;
      for (const panelId of page?.panelIds ?? []) collect(panelId);
    }
  } else if (state.selection.itemId) {
    const item = doc.items[state.selection.itemId];
    if (item?.kind === "asset") candidates.push(item);
  }

  const matching = candidates.filter((item) => {
    const meta = doc.assets[item.sourceAssetId]?.metadata;
    if (!meta?.characterId) return false;
    return characterByName ? meta.characterId === characterByName.id : true;
  });
  const target = matching[matching.length - 1];
  if (!target) {
    throw new Error(
      characterByName
        ? `${characterByName.name} is not placed in ${args.panel !== undefined ? `panel ${args.panel}` : "this scope"} yet — place them first`
        : args.panel !== undefined
          ? `No character instance found in panel ${args.panel}`
          : "No character instance is selected — select one or specify a panel",
    );
  }
  return target;
}

/**
 * One run = one context. Replaces the old module-global guard slots: handlers
 * can never read a stale authorization from a previous run because the context
 * is created by the orchestrator and passed down explicitly.
 */
export function createRunContext(guards: RunGuards): RunContext {
  ctxGuards = guards;
  const ctx: RunContext = {
    guards,
    createdCharacterIds: [],
    lastLanguageAction: undefined,
    currentDoc,
    dispatch,
    panelIdByNumber,
    stageOnWorkspace,
    requireCharacterOrNull,
    findTargetInstance,
  };
  return ctx;
}
