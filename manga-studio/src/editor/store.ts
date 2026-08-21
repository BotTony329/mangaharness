/**
 * Editor state: the single source of truth the canvas and panels project from.
 *
 * All document mutations flow through `commit` (history-tracked) or
 * `transient` (drag previews — no history entry until commitTransient).
 * The Manga Agent uses the same commit path via a transaction group, so one
 * agent run is one undo step and there is no privileged write path.
 */

import { create } from "zustand";
import type { ID, ProjectDocument } from "@/domain/types";
import { applyDomainCommand, type CommandResult, type DomainCommand } from "@/domain/commands";

const HISTORY_LIMIT = 50;

export interface Selection {
  itemId?: ID;
  panelId?: ID;
  /** A loose asset on the workspace (outside any page). */
  workspaceItemId?: ID;
  /**
   * Additional selected items, for actions that need two actors — an
   * interaction needs both participants.
   *
   * `itemId` remains the PRIMARY selection so every existing single-selection
   * surface keeps working unchanged; this is strictly additive.
   */
  alsoItemIds?: ID[];
}

/** Mutations are doc → doc pure functions (see src/domain/*Ops.ts). */
export type DocMutation = (doc: ProjectDocument) => ProjectDocument;

interface EditorState {
  doc: ProjectDocument | null;
  currentPageId: ID | null;
  selection: Selection;
  past: ProjectDocument[];
  future: ProjectDocument[];
  /** Snapshot captured at transaction/transient start; null when not active. */
  pendingSnapshot: ProjectDocument | null;
  inTransaction: boolean;
  dirty: boolean;

  loadDocument(doc: ProjectDocument): void;
  /** Close the open project without opening another (the welcome state). */
  closeDocument(): void;
  setCurrentPage(pageId: ID): void;
  select(selection: Selection): void;
  dispatch(command: DomainCommand): CommandResult;
  transientDispatch(command: DomainCommand): void;

  /** Apply a mutation and push one undo entry. */
  commit(mutation: DocMutation): void;
  /** Apply a mutation without history (live drag). Call commitTransient when done. */
  transient(mutation: DocMutation): void;
  commitTransient(): void;

  /** Group many commits into one undo entry (used for agent runs). */
  beginTransaction(): void;
  endTransaction(): void;
  /**
   * Discard everything done since `beginTransaction` and restore the snapshot.
   *
   * Without this an Agent run that failed halfway committed its partial work:
   * a destroyed panel stayed destroyed. Rollback is what makes "preserve
   * existing work" enforceable rather than aspirational.
   */
  abortTransaction(): void;

  undo(): void;
  redo(): void;
  markSaved(): void;
}

/**
 * Roll the PAGE back without throwing away images the creator paid for, or the
 * record of what was attempted.
 *
 * A rejected run must leave the composition exactly as it was — but images
 * already generated cost real money and real time, and discarding them would
 * mean a retry pays for them twice. Library assets are orphan-safe: nothing on
 * the restored page points at them, and the creator can drag them in by hand.
 *
 * State records come back with their asset so a later run can still find the
 * cached pose, but only when the character they belong to survived the
 * rollback — a state record pointing at a character that no longer exists is
 * exactly the dangling reference the rollback was meant to prevent.
 *
 * The generation log survives unconditionally. It is append-only diagnostics,
 * and erasing the reason a run failed is precisely the wrong thing to do at the
 * moment the creator most wants to know it.
 */
function preserveRunArtifacts(snapshot: ProjectDocument, attempted: ProjectDocument): ProjectDocument {
  const restored: ProjectDocument = { ...snapshot, generationHistory: attempted.generationHistory };
  const newAssetIds = Object.keys(attempted.assets).filter((id) => !snapshot.assets[id]);
  if (newAssetIds.length === 0) return restored;

  const assets = { ...snapshot.assets };
  for (const id of newAssetIds) {
    const asset = attempted.assets[id];
    const owner = asset.metadata?.characterId;
    if (owner && !snapshot.characters[owner]) continue;
    assets[id] = asset;
  }

  const characterStates = { ...snapshot.characterStates };
  for (const [id, record] of Object.entries(attempted.characterStates)) {
    if (snapshot.characterStates[id]) continue;
    // Only records that actually carry a surviving render are worth keeping;
    // a record still awaiting its image describes work that never happened.
    if (!record.assetId || !assets[record.assetId]) continue;
    if (!snapshot.characters[record.characterId]) continue;
    characterStates[id] = record;
  }

  return { ...restored, assets, characterStates };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  doc: null,
  currentPageId: null,
  selection: {},
  past: [],
  future: [],
  pendingSnapshot: null,
  inTransaction: false,
  dirty: false,

  loadDocument(doc) {
    const firstPage = Object.values(doc.pages).sort((a, b) => a.index - b.index)[0];
    set({
      doc,
      currentPageId: firstPage?.id ?? null,
      selection: {},
      past: [],
      future: [],
      pendingSnapshot: null,
      inTransaction: false,
      dirty: false,
    });
  },

  closeDocument() {
    // History is cleared with the document: undo must never be able to step
    // back into a project the creator has left or deleted.
    set({
      doc: null,
      currentPageId: null,
      selection: {},
      past: [],
      future: [],
      pendingSnapshot: null,
      inTransaction: false,
      dirty: false,
    });
  },

  setCurrentPage(pageId) {
    set({ currentPageId: pageId, selection: {} });
  },

  select(selection) {
    set({ selection });
  },

  dispatch(command) {
    let result: CommandResult | undefined;
    get().commit((doc) => {
      result = applyDomainCommand(doc, command);
      return result.doc;
    });
    if (!result) throw new Error("No open project");
    return result;
  },

  transientDispatch(command) {
    get().transient((doc) => applyDomainCommand(doc, command).doc);
  },

  commit(mutation) {
    const { doc, inTransaction, past } = get();
    if (!doc) return;
    const next = mutation(doc);
    if (next === doc) return;
    // Inside a transaction the group snapshot already covers this change.
    set({
      doc: next,
      dirty: true,
      ...(inTransaction ? {} : { past: pushBounded(past, doc), future: [] }),
    });
  },

  transient(mutation) {
    const { doc, pendingSnapshot, inTransaction } = get();
    if (!doc) return;
    set({
      doc: mutation(doc),
      dirty: true,
      // First transient in a gesture captures the pre-gesture state once.
      pendingSnapshot: inTransaction ? pendingSnapshot : (pendingSnapshot ?? doc),
    });
  },

  commitTransient() {
    const { pendingSnapshot, past, inTransaction } = get();
    if (!pendingSnapshot || inTransaction) return;
    set({ past: pushBounded(past, pendingSnapshot), future: [], pendingSnapshot: null });
  },

  beginTransaction() {
    const { doc, inTransaction } = get();
    if (!doc || inTransaction) return;
    set({ inTransaction: true, pendingSnapshot: doc });
  },

  abortTransaction() {
    const { pendingSnapshot, inTransaction, doc } = get();
    if (!inTransaction || !pendingSnapshot) {
      set({ inTransaction: false, pendingSnapshot: null });
      return;
    }
    // History is untouched: a rolled-back run never happened, so it must not
    // occupy an undo slot the creator would have to step through.
    set({
      doc: doc ? preserveRunArtifacts(pendingSnapshot, doc) : pendingSnapshot,
      inTransaction: false,
      pendingSnapshot: null,
      selection: {},
    });
  },

  endTransaction() {
    const { pendingSnapshot, past, doc, inTransaction } = get();
    if (!inTransaction) return;
    const changed = pendingSnapshot && doc !== pendingSnapshot;
    set({
      inTransaction: false,
      pendingSnapshot: null,
      ...(changed ? { past: pushBounded(past, pendingSnapshot), future: [] } : {}),
    });
  },

  undo() {
    const { past, future, doc } = get();
    if (!doc || past.length === 0) return;
    const previous = past[past.length - 1];
    set({
      doc: previous,
      past: past.slice(0, -1),
      future: [doc, ...future],
      selection: pruneSelection(get().selection, previous),
      dirty: true,
    });
  },

  redo() {
    const { past, future, doc } = get();
    if (!doc || future.length === 0) return;
    const [next, ...rest] = future;
    set({
      doc: next,
      past: pushBounded(past, doc),
      future: rest,
      selection: pruneSelection(get().selection, next),
      dirty: true,
    });
  },

  markSaved() {
    set({ dirty: false });
  },
}));

function pushBounded(past: ProjectDocument[], doc: ProjectDocument): ProjectDocument[] {
  const next = [...past, doc];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** Undo may remove the selected item/panel; drop stale references. */
function pruneSelection(selection: Selection, doc: ProjectDocument): Selection {
  return {
    itemId: selection.itemId && doc.items[selection.itemId] ? selection.itemId : undefined,
    panelId: selection.panelId && doc.panels[selection.panelId] ? selection.panelId : undefined,
    workspaceItemId:
      selection.workspaceItemId && doc.workspaceItems[selection.workspaceItemId]
        ? selection.workspaceItemId
        : undefined,
  };
}
