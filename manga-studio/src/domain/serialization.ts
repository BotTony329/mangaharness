/**
 * Project document ⇄ JSON. Documents carry a schemaVersion so stored projects
 * survive model evolution: migrations are forward-only functions applied in
 * order before validation.
 */

import { defaultPageWorkspacePosition } from "./factory";
import { rectToPoints } from "./geometry";
import { SCHEMA_VERSION, type ProjectDocument, type Rect } from "./types";

export function serializeProject(doc: ProjectDocument): string {
  return JSON.stringify(doc);
}

export function deserializeProject(json: string): ProjectDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Project file is not valid JSON");
  }
  const migrated = migrate(parsed);
  assertDocumentShape(migrated);
  return migrated;
}

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Index N migrates version N → N+1. */
const MIGRATIONS: Record<number, Migration> = {
  // v1 → v2: panels move from rect to polygon points; pages gain a workspace
  // position; loose workspace items are introduced.
  1: (doc) => {
    const panels = (doc.panels ?? {}) as Record<string, { rect?: Rect; points?: unknown }>;
    for (const panel of Object.values(panels)) {
      if (panel.rect && !panel.points) {
        panel.points = rectToPoints(panel.rect);
        delete panel.rect;
      }
    }
    const settings = (doc.project as { settings?: { pageWidth?: number } } | undefined)?.settings;
    const pages = (doc.pages ?? {}) as Record<string, { index?: number; workspace?: unknown }>;
    for (const page of Object.values(pages)) {
      page.workspace ??= defaultPageWorkspacePosition(page.index ?? 0, settings?.pageWidth ?? 1200);
    }
    doc.workspaceItems ??= {};
    doc.workspaceOrder ??= [];
    return { ...doc, schemaVersion: 2 };
  },
};

function migrate(input: unknown): ProjectDocument {
  if (typeof input !== "object" || input === null) throw new Error("Project file is not an object");
  let doc = input as Record<string, unknown>;
  // v1 documents predate explicit versioning discipline but always carried
  // schemaVersion: 1; treat a missing field as v1 rather than refusing.
  let version = typeof doc.schemaVersion === "number" ? doc.schemaVersion : 1;
  if (version > SCHEMA_VERSION) {
    throw new Error(`Project was saved by a newer app version (schema ${version})`);
  }
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`No migration path from schema ${version}`);
    doc = step(doc);
    version += 1;
  }
  return doc as unknown as ProjectDocument;
}

function assertDocumentShape(doc: ProjectDocument): void {
  const missing = (["project", "assets", "characters", "pages", "panels", "items"] as const).filter(
    (key) => typeof doc[key] !== "object" || doc[key] === null,
  );
  if (missing.length > 0) throw new Error(`Corrupt project document: missing ${missing.join(", ")}`);
  if (!Array.isArray(doc.generationHistory)) doc.generationHistory = [];
  if (typeof doc.workspaceItems !== "object" || doc.workspaceItems === null) doc.workspaceItems = {};
  if (!Array.isArray(doc.workspaceOrder)) doc.workspaceOrder = [];
}
