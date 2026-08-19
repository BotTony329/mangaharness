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

const HISTORY_LIMIT = 50;

export interface Selection {
  itemId?: ID;
  panelId?: ID;
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
  setCurrentPage(pageId: ID): void;
  select(selection: Selection): void;

  /** Apply a mutation and push one undo entry. */
  commit(mutation: DocMutation): void;
  /** Apply a mutation without history (live drag). Call commitTransient when done. */
  transient(mutation: DocMutation): void;
  commitTransient(): void;

  /** Group many commits into one undo entry (used for agent runs). */
  beginTransaction(): void;
  endTransaction(): void;

  undo(): void;
  redo(): void;
  markSaved(): void;
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

  setCurrentPage(pageId) {
    set({ currentPageId: pageId, selection: {} });
  },

  select(selection) {
    set({ selection });
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
  };
}
