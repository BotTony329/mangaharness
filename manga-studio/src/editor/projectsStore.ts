"use client";

/**
 * Project lifecycle: the list, the active project, and switching between them.
 *
 * Kept out of the editor store on purpose. The editor store holds ONE open
 * document and its undo history; a project switch replaces that document
 * wholesale, so undo must not be able to step backwards into a project the
 * creator has left. Loading through here always calls `loadDocument`, which
 * resets history.
 *
 * These are real persisted projects, not in-memory tabs: every operation goes
 * through IndexedDB and survives a reload.
 */

import { create } from "zustand";
import { createProjectDocument } from "@/domain/factory";
import { duplicateProjectDocument } from "@/domain/projectOps";
import type { LayoutPresetId, ProjectDocument } from "@/domain/types";
import { indexedDbPersistence, type PersistenceService, type ProjectSummary } from "@/storage/projectStore";
import { useEditorStore } from "./store";

export interface NewProjectInput {
  name: string;
  layout?: LayoutPresetId;
  styleId?: string;
}

interface ProjectsState {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;

  bootstrap(): Promise<void>;
  refresh(): Promise<void>;
  createProject(input: NewProjectInput): Promise<string>;
  openProject(projectId: string): Promise<void>;
  renameProject(projectId: string, name: string): Promise<void>;
  duplicateProject(projectId: string): Promise<string>;
  deleteProject(projectId: string): Promise<void>;
}

/** Swappable so tests can drive the lifecycle without IndexedDB. */
let persistence: PersistenceService = indexedDbPersistence;

export function setProjectPersistence(service: PersistenceService): void {
  persistence = service;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  loading: true,
  error: null,

  async bootstrap() {
    set({ loading: true, error: null });
    try {
      const projects = await persistence.listProjects();
      const lastId = await persistence.lastProjectId();
      /**
       * Migration (§14): a user who has only ever had the implicit single
       * project keeps it. It already carries a stable `project.id`, so it needs
       * no conversion — it simply becomes the first entry in the list.
       *
       * An empty store is left empty so the welcome state can show, rather than
       * silently manufacturing a project the creator never asked for.
       */
      const target = projects.find((project) => project.id === lastId) ?? projects[0];
      if (!target) {
        set({ projects, activeProjectId: null, loading: false });
        return;
      }
      await loadInto(target.id);
      set({ projects, activeProjectId: target.id, loading: false });
    } catch (error) {
      set({ loading: false, error: message(error) });
    }
  },

  async refresh() {
    set({ projects: await persistence.listProjects() });
  },

  async createProject(input) {
    const doc = createProjectDocument(input.name.trim() || "Untitled project", input.layout);
    // Art style is optional at creation; an unknown id is ignored rather than
    // blocking project creation over a cosmetic default.
    if (input.styleId) {
      doc.project.settings.artStyle = { ...doc.project.settings.artStyle, activeStyleId: input.styleId };
    }
    await saveActive();
    await persistence.saveProject(doc);
    await persistence.setLastProjectId(doc.project.id);
    useEditorStore.getState().loadDocument(doc);
    useEditorStore.getState().markSaved();
    set({ activeProjectId: doc.project.id, projects: await persistence.listProjects() });
    return doc.project.id;
  },

  async openProject(projectId) {
    if (get().activeProjectId === projectId) return;
    // Persist whatever is open before replacing it — switching must never be a
    // way to lose the last few seconds of work.
    await saveActive();
    await loadInto(projectId);
    await persistence.setLastProjectId(projectId);
    set({ activeProjectId: projectId, projects: await persistence.listProjects() });
  },

  async renameProject(projectId, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (get().activeProjectId === projectId) {
      // The open document is the source of truth; rename it through the command
      // layer so the change is undoable and autosave picks it up.
      useEditorStore.getState().dispatch({ type: "rename-project", name: trimmed });
      const doc = useEditorStore.getState().doc;
      if (doc) await persistence.saveProject(doc);
    } else {
      const doc = await persistence.loadProject(projectId);
      if (!doc) return;
      doc.project.name = trimmed;
      doc.project.updatedAt = new Date().toISOString();
      await persistence.saveProject(doc);
    }
    set({ projects: await persistence.listProjects() });
  },

  async duplicateProject(projectId) {
    await saveActive();
    const source =
      get().activeProjectId === projectId
        ? useEditorStore.getState().doc
        : await persistence.loadProject(projectId);
    if (!source) throw new Error("That project could not be read");
    const copy = duplicateProjectDocument(source);
    await persistence.saveProject(copy);
    set({ projects: await persistence.listProjects() });
    return copy.project.id;
  },

  async deleteProject(projectId) {
    await persistence.deleteProject(projectId);
    const projects = await persistence.listProjects();
    if (get().activeProjectId !== projectId) {
      set({ projects });
      return;
    }
    /**
     * Deleting the ACTIVE project must not leave a broken editor (§6). Fall
     * back to another project if one exists; otherwise clear the document and
     * let the welcome state take over.
     */
    const next = projects[0];
    if (next) {
      await loadInto(next.id);
      await persistence.setLastProjectId(next.id);
      set({ projects, activeProjectId: next.id });
    } else {
      await persistence.setLastProjectId(null);
      useEditorStore.getState().closeDocument();
      set({ projects, activeProjectId: null });
    }
  },
}));

async function loadInto(projectId: string): Promise<void> {
  const doc = await persistence.loadProject(projectId);
  if (!doc) throw new Error("That project could not be opened");
  useEditorStore.getState().loadDocument(doc);
  useEditorStore.getState().markSaved();
}

/** Flush the open document so a switch or duplicate never loses recent edits. */
async function saveActive(): Promise<void> {
  const state = useEditorStore.getState();
  const doc: ProjectDocument | null = state.doc;
  if (!doc || !state.dirty) return;
  await persistence.saveProject(doc);
  state.markSaved();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Projects could not be loaded";
}
