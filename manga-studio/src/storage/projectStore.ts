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

export interface PersistenceService {
  saveProject(doc: ProjectDocument): Promise<void>;
  loadProject(projectId: string): Promise<ProjectDocument | null>;
  loadLastProject(): Promise<ProjectDocument | null>;
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
    const lastId = await withStores("readonly", (_projects, meta) =>
      requestValue<string | undefined>(meta.get("lastProjectId") as IDBRequest<string | undefined>),
    );
    return lastId ? this.loadProject(lastId) : null;
  },
};
