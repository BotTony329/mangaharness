"use client";

/**
 * Browser persistence for project documents (IndexedDB). Image binaries are
 * NOT stored here — they live in remote object storage and the document only
 * references URLs, which keeps documents small and lets cloud project storage
 * replace this adapter later without touching the editor.
 */

import { deserializeProject, serializeProject } from "@/domain/serialization";
import type { ProjectDocument } from "@/domain/types";

const DB_NAME = "manga-studio";
const DB_VERSION = 1;
const PROJECTS = "projects";
const META = "meta";

/** Enough to render the project list without loading every document. */
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt?: string;
  createdAt?: string;
  pageCount: number;
  /** First usable asset image, used as a cover. */
  coverUrl?: string;
}

export interface PersistenceService {
  saveProject(doc: ProjectDocument): Promise<void>;
  loadProject(projectId: string): Promise<ProjectDocument | null>;
  loadLastProject(): Promise<ProjectDocument | null>;
  listProjects(): Promise<ProjectSummary[]>;
  deleteProject(projectId: string): Promise<void>;
  lastProjectId(): Promise<string | null>;
  setLastProjectId(projectId: string | null): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function withStores<T>(
  mode: IDBTransactionMode,
  fn: (projects: IDBObjectStore, meta: IDBObjectStore) => T | Promise<T>,
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction([PROJECTS, META], mode);
    const result = await fn(tx.objectStore(PROJECTS), tx.objectStore(META));
    await txDone(tx);
    return result;
  } finally {
    db.close();
  }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const indexedDbPersistence: PersistenceService = {
  async saveProject(doc) {
    // Serialize through the domain layer so what we store is exactly what
    // deserializeProject accepts — no canvas objects can leak in.
    const json = serializeProject(doc);
    await withStores("readwrite", (projects, meta) => {
      projects.put(json, doc.project.id);
      meta.put(doc.project.id, "lastProjectId");
    });
  },

  async loadProject(projectId) {
    const json = await withStores("readonly", (projects) =>
      requestValue<string | undefined>(projects.get(projectId) as IDBRequest<string | undefined>),
    );
    return json ? deserializeProject(json) : null;
  },

  async loadLastProject() {
    const lastId = await this.lastProjectId();
    return lastId ? this.loadProject(lastId) : null;
  },

  /**
   * Project list.
   *
   * Reads every stored document and derives a summary rather than maintaining
   * a separate index. An index would be faster but can drift out of sync with
   * the documents it describes — and a project list that disagrees with what is
   * actually stored is worse than one that takes a few milliseconds longer.
   * Documents hold no binaries, so they stay small.
   */
  async listProjects() {
    const entries = await withStores("readonly", async (projects) => {
      const keys = await requestValue<IDBValidKey[]>(projects.getAllKeys() as IDBRequest<IDBValidKey[]>);
      const values = await requestValue<string[]>(projects.getAll() as IDBRequest<string[]>);
      return keys.map((key, index) => ({ key: String(key), json: values[index] }));
    });

    const summaries: ProjectSummary[] = [];
    for (const entry of entries) {
      const summary = summarize(entry.key, entry.json);
      if (summary) summaries.push(summary);
    }
    // Most recently edited first: the list is a "resume work" surface.
    return summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  },

  async deleteProject(projectId) {
    await withStores("readwrite", async (projects, meta) => {
      projects.delete(projectId);
      const lastId = await requestValue<string | undefined>(meta.get("lastProjectId") as IDBRequest<string | undefined>);
      // Never leave a pointer to a project that no longer exists — that is how
      // a reload lands in a broken empty editor.
      if (lastId === projectId) meta.delete("lastProjectId");
    });
  },

  async lastProjectId() {
    const lastId = await withStores("readonly", (_projects, meta) =>
      requestValue<string | undefined>(meta.get("lastProjectId") as IDBRequest<string | undefined>),
    );
    return lastId ?? null;
  },

  async setLastProjectId(projectId) {
    await withStores("readwrite", (_projects, meta) => {
      if (projectId) meta.put(projectId, "lastProjectId");
      else meta.delete("lastProjectId");
    });
  },
};

/**
 * Derive a summary from stored JSON without a full domain migration.
 *
 * Deliberately tolerant: a document written by a newer build, or one that is
 * subtly corrupt, must not take the whole project list down with it. An entry
 * we cannot read is skipped, and the rest of the list still renders.
 */
function summarize(key: string, json: string | undefined): ProjectSummary | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as {
      project?: { id?: string; name?: string; createdAt?: string; updatedAt?: string };
      pages?: Record<string, unknown>;
      assets?: Record<string, { processedImageUrl?: string; storageUrl?: string; status?: string }>;
    };
    const cover = Object.values(parsed.assets ?? {}).find(
      (asset) => asset.status !== "archived" && (asset.processedImageUrl ?? asset.storageUrl),
    );
    return {
      id: parsed.project?.id ?? key,
      name: parsed.project?.name?.trim() || "Untitled project",
      createdAt: parsed.project?.createdAt,
      updatedAt: parsed.project?.updatedAt ?? parsed.project?.createdAt,
      pageCount: Object.keys(parsed.pages ?? {}).length,
      coverUrl: cover?.processedImageUrl ?? cover?.storageUrl,
    };
  } catch {
    return null;
  }
}
