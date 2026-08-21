/**
 * Project lifecycle.
 *
 * These are real persisted projects, not in-memory tabs, so the suite drives a
 * fake persistence service with the same contract IndexedDB implements — every
 * assertion about "survives reload" is a genuine round trip through stored
 * JSON, not a assertion about a live object graph.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import { deserializeProject, serializeProject } from "@/domain/serialization";
import { duplicateProjectDocument, isProjectScoped, referencedProjectIds, renameProject } from "@/domain/projectOps";
import type { ProjectDocument } from "@/domain/types";
import { useEditorStore } from "./store";
import { setProjectPersistence, useProjectsStore } from "./projectsStore";
import type { PersistenceService, ProjectSummary } from "@/storage/projectStore";
import { groundPrompt } from "@/agent/grounding";
import { buildAgentContext } from "@/agent/contextBuilder";

/** In-memory stand-in for IndexedDB, storing serialized JSON exactly as it does. */
function fakePersistence() {
  const store = new Map<string, string>();
  let lastId: string | null = null;

  const service: PersistenceService = {
    async saveProject(doc) {
      store.set(doc.project.id, serializeProject(doc));
      lastId = doc.project.id;
    },
    async loadProject(projectId) {
      const json = store.get(projectId);
      return json ? deserializeProject(json) : null;
    },
    async loadLastProject() {
      return lastId ? service.loadProject(lastId) : null;
    },
    async listProjects() {
      const summaries: ProjectSummary[] = [];
      for (const [id, json] of store) {
        const parsed = JSON.parse(json) as ProjectDocument;
        summaries.push({
          id,
          name: parsed.project.name,
          updatedAt: parsed.project.updatedAt,
          createdAt: parsed.project.createdAt,
          pageCount: Object.keys(parsed.pages).length,
        });
      }
      return summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    },
    async deleteProject(projectId) {
      store.delete(projectId);
      if (lastId === projectId) lastId = null;
    },
    async lastProjectId() {
      return lastId;
    },
    async setLastProjectId(projectId) {
      lastId = projectId;
    },
  };
  return { service, store, setLast: (id: string | null) => (lastId = id), getLast: () => lastId };
}

function seedProject(name: string, characterName: string): ProjectDocument {
  let doc = createProjectDocument(name);
  const character = addCharacter(doc, characterName);
  doc = character.doc;
  doc = addAsset(doc, {
    category: "character",
    name: `${characterName} canonical`,
    storageUrl: `https://example.com/${characterName}.png`,
    processedImageUrl: `https://example.com/${characterName}-cut.png`,
    width: 800,
    height: 1600,
    hasAlpha: true,
    backgroundRemoved: true,
    processingStatus: "ready",
    metadata: { characterId: character.characterId, characterAssetRole: "canonical" },
  }).doc;
  return doc;
}

let fake: ReturnType<typeof fakePersistence>;

beforeEach(() => {
  fake = fakePersistence();
  setProjectPersistence(fake.service);
  useProjectsStore.setState({ projects: [], activeProjectId: null, loading: true, error: null });
  useEditorStore.getState().closeDocument();
});

// ─── Pure document operations ──────────────────────────────────────────────

describe("project document operations", () => {
  it("rename changes only the display name", () => {
    const doc = seedProject("My Manga", "Yuri");
    const renamed = renameProject(doc, "Tokyo Story");

    expect(renamed.project.name).toBe("Tokyo Story");
    // Everything identity-bearing survives.
    expect(renamed.project.id).toBe(doc.project.id);
    expect(Object.keys(renamed.pages)).toEqual(Object.keys(doc.pages));
    expect(Object.keys(renamed.panels)).toEqual(Object.keys(doc.panels));
    expect(Object.keys(renamed.assets)).toEqual(Object.keys(doc.assets));
    expect(Object.keys(renamed.characters)).toEqual(Object.keys(doc.characters));
    expect(renamed.characterStates).toEqual(doc.characterStates);
    expect(renamed.puppets).toEqual(doc.puppets);
    expect(renamed.language).toEqual(doc.language);
  });

  it("rename refuses an empty name", () => {
    expect(() => renameProject(seedProject("A", "Yuri"), "   ")).toThrow();
  });

  it("duplicate produces a new project id and repoints every back-reference", () => {
    const doc = seedProject("My Manga", "Yuri");
    const copy = duplicateProjectDocument(doc);

    expect(copy.project.id).not.toBe(doc.project.id);
    expect(copy.project.name).toBe("My Manga copy");
    // No record still claims to belong to the original project.
    expect(referencedProjectIds(copy).has(doc.project.id)).toBe(false);
    expect(isProjectScoped(copy)).toBe(true);
    expect(isProjectScoped(doc)).toBe(true);
  });

  it("duplicate shares no mutable state with the original", () => {
    const doc = seedProject("My Manga", "Yuri");
    const copy = duplicateProjectDocument(doc);
    const panelId = copy.pages[Object.keys(copy.pages)[0]].panelIds[0];

    const edited = applyDomainCommand(copy, {
      type: "add-bubble",
      panelId,
      bubbleType: "speech",
      text: "Only in the copy",
    });

    expect(Object.keys(edited.doc.items)).toHaveLength(1);
    // The original is untouched — this is the property that actually matters.
    expect(Object.keys(doc.items)).toHaveLength(0);
  });

  it("duplicate references the same immutable image blobs", () => {
    const doc = seedProject("My Manga", "Yuri");
    const copy = duplicateProjectDocument(doc);
    const original = Object.values(doc.assets)[0];
    const copied = Object.values(copy.assets)[0];
    // Storage blobs are immutable and content-addressed, so sharing them is
    // correct; the project-scoped REFERENCE is what was copied.
    expect(copied.storageUrl).toBe(original.storageUrl);
    expect(copied.projectId).toBe(copy.project.id);
    expect(copied.projectId).not.toBe(original.projectId);
  });
});

// ─── Lifecycle through the store ───────────────────────────────────────────

describe("project lifecycle", () => {
  it("creates a project and opens it immediately", async () => {
    await useProjectsStore.getState().bootstrap();
    const id = await useProjectsStore.getState().createProject({ name: "Tokyo Story" });

    expect(useProjectsStore.getState().activeProjectId).toBe(id);
    expect(useEditorStore.getState().doc?.project.name).toBe("Tokyo Story");
    expect(useProjectsStore.getState().projects.map((p) => p.name)).toContain("Tokyo Story");
  });

  it("shows the welcome state rather than inventing a project", async () => {
    await useProjectsStore.getState().bootstrap();
    expect(useProjectsStore.getState().projects).toEqual([]);
    expect(useProjectsStore.getState().activeProjectId).toBeNull();
    expect(useEditorStore.getState().doc).toBeNull();
  });

  it("switches between projects and loads the right document", async () => {
    await fake.service.saveProject(seedProject("My Manga", "Yuri"));
    await fake.service.saveProject(seedProject("School Life", "Mio"));
    await useProjectsStore.getState().bootstrap();

    const [first, second] = useProjectsStore.getState().projects;
    await useProjectsStore.getState().openProject(first.id);
    expect(useEditorStore.getState().doc?.project.id).toBe(first.id);

    await useProjectsStore.getState().openProject(second.id);
    expect(useEditorStore.getState().doc?.project.id).toBe(second.id);
    expect(useProjectsStore.getState().activeProjectId).toBe(second.id);
  });

  it("switching clears undo history so it cannot step into another project", async () => {
    await fake.service.saveProject(seedProject("A", "Yuri"));
    await fake.service.saveProject(seedProject("B", "Mio"));
    await useProjectsStore.getState().bootstrap();
    const [first, second] = useProjectsStore.getState().projects;

    await useProjectsStore.getState().openProject(first.id);
    const panelId = useEditorStore.getState().doc!.pages[useEditorStore.getState().currentPageId!].panelIds[0];
    useEditorStore.getState().dispatch({ type: "add-bubble", panelId, bubbleType: "speech", text: "hi" });
    expect(useEditorStore.getState().past.length).toBeGreaterThan(0);

    await useProjectsStore.getState().openProject(second.id);
    expect(useEditorStore.getState().past).toEqual([]);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().doc!.project.id).toBe(second.id);
  });

  it("renames the active project through the command layer", async () => {
    await fake.service.saveProject(seedProject("My Manga", "Yuri"));
    await useProjectsStore.getState().bootstrap();
    const id = useProjectsStore.getState().activeProjectId!;

    await useProjectsStore.getState().renameProject(id, "Tokyo Story");

    expect(useEditorStore.getState().doc!.project.name).toBe("Tokyo Story");
    expect(useProjectsStore.getState().projects.find((p) => p.id === id)!.name).toBe("Tokyo Story");
    // Reload proves it persisted.
    expect((await fake.service.loadProject(id))!.project.name).toBe("Tokyo Story");
  });

  it("renames an inactive project without opening it", async () => {
    await fake.service.saveProject(seedProject("A", "Yuri"));
    const other = seedProject("B", "Mio");
    await fake.service.saveProject(other);
    await useProjectsStore.getState().bootstrap();
    const activeId = useProjectsStore.getState().activeProjectId!;
    const inactiveId = useProjectsStore.getState().projects.find((p) => p.id !== activeId)!.id;

    await useProjectsStore.getState().renameProject(inactiveId, "Renamed");

    expect(useEditorStore.getState().doc!.project.id).toBe(activeId);
    expect((await fake.service.loadProject(inactiveId))!.project.name).toBe("Renamed");
  });

  it("duplicates a project into an independent document", async () => {
    await fake.service.saveProject(seedProject("My Manga", "Yuri"));
    await useProjectsStore.getState().bootstrap();
    const sourceId = useProjectsStore.getState().activeProjectId!;

    const copyId = await useProjectsStore.getState().duplicateProject(sourceId);
    expect(copyId).not.toBe(sourceId);
    expect(useProjectsStore.getState().projects).toHaveLength(2);
    // Duplicating does not switch away from what you were working on.
    expect(useProjectsStore.getState().activeProjectId).toBe(sourceId);

    // Editing the copy leaves the original alone, after a real round trip.
    const copy = (await fake.service.loadProject(copyId))!;
    const panelId = copy.pages[Object.keys(copy.pages)[0]].panelIds[0];
    await fake.service.saveProject(
      applyDomainCommand(copy, { type: "add-bubble", panelId, bubbleType: "speech", text: "copy only" }).doc,
    );

    expect(Object.keys((await fake.service.loadProject(copyId))!.items)).toHaveLength(1);
    expect(Object.keys((await fake.service.loadProject(sourceId))!.items)).toHaveLength(0);
  });

  it("deletes an inactive project without touching the active one", async () => {
    await fake.service.saveProject(seedProject("A", "Yuri"));
    await fake.service.saveProject(seedProject("B", "Mio"));
    await useProjectsStore.getState().bootstrap();
    const activeId = useProjectsStore.getState().activeProjectId!;
    const otherId = useProjectsStore.getState().projects.find((p) => p.id !== activeId)!.id;

    await useProjectsStore.getState().deleteProject(otherId);

    expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual([activeId]);
    expect(useEditorStore.getState().doc!.project.id).toBe(activeId);
    expect(await fake.service.loadProject(activeId)).not.toBeNull();
  });

  it("deleting the ACTIVE project falls back to another one", async () => {
    await fake.service.saveProject(seedProject("A", "Yuri"));
    await fake.service.saveProject(seedProject("B", "Mio"));
    await useProjectsStore.getState().bootstrap();
    const activeId = useProjectsStore.getState().activeProjectId!;

    await useProjectsStore.getState().deleteProject(activeId);

    const state = useProjectsStore.getState();
    expect(state.projects).toHaveLength(1);
    expect(state.activeProjectId).toBe(state.projects[0].id);
    // Never a broken editor.
    expect(useEditorStore.getState().doc).not.toBeNull();
    expect(useEditorStore.getState().doc!.project.id).toBe(state.projects[0].id);
  });

  it("deleting the LAST project lands on the welcome state, not a broken editor", async () => {
    await fake.service.saveProject(seedProject("Only", "Yuri"));
    await useProjectsStore.getState().bootstrap();
    const id = useProjectsStore.getState().activeProjectId!;

    await useProjectsStore.getState().deleteProject(id);

    expect(useProjectsStore.getState().projects).toEqual([]);
    expect(useProjectsStore.getState().activeProjectId).toBeNull();
    expect(useEditorStore.getState().doc).toBeNull();
    // And the stale pointer is gone, so a reload does not try to open it.
    expect(fake.getLast()).toBeNull();
  });

  it("reload restores the project list and the last active project", async () => {
    await fake.service.saveProject(seedProject("A", "Yuri"));
    await fake.service.saveProject(seedProject("B", "Mio"));
    await useProjectsStore.getState().bootstrap();
    const [, second] = useProjectsStore.getState().projects;
    await useProjectsStore.getState().openProject(second.id);

    // Simulate a reload: fresh stores, same persistence.
    useProjectsStore.setState({ projects: [], activeProjectId: null, loading: true });
    useEditorStore.getState().closeDocument();
    await useProjectsStore.getState().bootstrap();

    expect(useProjectsStore.getState().projects).toHaveLength(2);
    expect(useProjectsStore.getState().activeProjectId).toBe(second.id);
    expect(useEditorStore.getState().doc!.project.id).toBe(second.id);
  });

  it("recovers when the stored last-project pointer is stale", async () => {
    await fake.service.saveProject(seedProject("Real", "Yuri"));
    fake.setLast("a-project-that-was-deleted");
    await useProjectsStore.getState().bootstrap();

    // Falls back to a project that exists rather than erroring.
    expect(useProjectsStore.getState().error).toBeNull();
    expect(useEditorStore.getState().doc!.project.name).toBe("Real");
  });

  it("migrates an existing single-project user by listing what they already have", async () => {
    // The pre-multi-project world: exactly one stored document, no list UI.
    const legacy = seedProject("My Manga", "Yuri");
    await fake.service.saveProject(legacy);

    await useProjectsStore.getState().bootstrap();

    expect(useProjectsStore.getState().projects.map((p) => p.name)).toEqual(["My Manga"]);
    expect(useProjectsStore.getState().activeProjectId).toBe(legacy.project.id);
    // Their work opens exactly as before — no conversion, no data loss.
    expect(Object.keys(useEditorStore.getState().doc!.characters)).toHaveLength(1);
  });
});

// ─── §8 / §11: asset and agent scoping ─────────────────────────────────────

describe("project scoping", () => {
  it("assets do not leak across projects", async () => {
    await fake.service.saveProject(seedProject("Project A", "Yuri"));
    await fake.service.saveProject(seedProject("Project B", "Mio"));
    await useProjectsStore.getState().bootstrap();
    const [first, second] = useProjectsStore.getState().projects;

    await useProjectsStore.getState().openProject(first.id);
    const namesA = Object.values(useEditorStore.getState().doc!.characters).map((c) => c.name);

    await useProjectsStore.getState().openProject(second.id);
    const namesB = Object.values(useEditorStore.getState().doc!.characters).map((c) => c.name);

    expect(namesA).not.toEqual(namesB);
    expect(namesA.concat(namesB).sort()).toEqual(["Mio", "Yuri"]);
    expect(isProjectScoped(useEditorStore.getState().doc!)).toBe(true);
  });

  it("agent grounding resolves only characters in the ACTIVE project", async () => {
    const projectA = seedProject("Project A", "Yuri");
    const projectB = seedProject("Project B", "Mio");
    await fake.service.saveProject(projectA);
    await fake.service.saveProject(projectB);
    await useProjectsStore.getState().bootstrap();

    await useProjectsStore.getState().openProject(projectB.project.id);
    const active = useEditorStore.getState().doc!;

    // Yuri exists — in another project. Grounding must NOT reach her.
    const report = groundPrompt({ doc: active, prompt: "Yuri walks in." });
    const yuri = report.entities.find((entity) => entity.surface === "Yuri");
    // The property that matters: she is NOT reached across the project boundary.
    expect(yuri?.status).toBe("not-found");
    expect(yuri?.characterId).toBeUndefined();
    // In this project she is simply somebody new, not a fatal error.
    expect(yuri?.resolution).toMatchObject({ status: "create", proposedName: "Yuri" });

    // Mio, who does belong here, resolves normally.
    const local = groundPrompt({ doc: active, prompt: "Mio walks in." });
    expect(local.blocking).toEqual([]);
  });

  it("agent context names the active project id", async () => {
    await fake.service.saveProject(seedProject("Project A", "Yuri"));
    await useProjectsStore.getState().bootstrap();
    const doc = useEditorStore.getState().doc!;

    const context = buildAgentContext({
      doc,
      currentPageId: useEditorStore.getState().currentPageId,
      selection: {},
    });
    expect(context).toContain(`PROJECT ID: ${doc.project.id}`);
    expect(context).toContain("Yuri");
    expect(context).not.toContain("Mio");
  });

  it("switching project switches the grounding context with it", async () => {
    const projectA = seedProject("Project A", "Yuri");
    const projectB = seedProject("Project B", "Mio");
    await fake.service.saveProject(projectA);
    await fake.service.saveProject(projectB);
    await useProjectsStore.getState().bootstrap();

    await useProjectsStore.getState().openProject(projectA.project.id);
    const inA = groundPrompt({ doc: useEditorStore.getState().doc!, prompt: "Yuri walks in." });
    expect(inA.entities.find((e) => e.surface === "Yuri")?.resolution?.status).toBe("existing");

    await useProjectsStore.getState().openProject(projectB.project.id);
    const inB = groundPrompt({ doc: useEditorStore.getState().doc!, prompt: "Yuri walks in." });
    // Same word, different project: she is not carried across.
    expect(inB.entities.find((e) => e.surface === "Yuri")?.resolution?.status).toBe("create");
  });
});

// ─── Autosave interaction ──────────────────────────────────────────────────

describe("unsaved work", () => {
  it("flushes the open document before switching away", async () => {
    await fake.service.saveProject(seedProject("A", "Yuri"));
    await fake.service.saveProject(seedProject("B", "Mio"));
    await useProjectsStore.getState().bootstrap();
    const [first, second] = useProjectsStore.getState().projects;

    await useProjectsStore.getState().openProject(first.id);
    const panelId = useEditorStore.getState().doc!.pages[useEditorStore.getState().currentPageId!].panelIds[0];
    useEditorStore.getState().dispatch({ type: "add-bubble", panelId, bubbleType: "speech", text: "unsaved" });
    expect(useEditorStore.getState().dirty).toBe(true);

    await useProjectsStore.getState().openProject(second.id);

    // Switching is not a way to lose the last few seconds of work.
    const reloaded = (await fake.service.loadProject(first.id))!;
    expect(Object.keys(reloaded.items)).toHaveLength(1);
  });
});
