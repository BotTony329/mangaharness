/**
 * Project document ⇄ JSON. Documents carry a schemaVersion so stored projects
 * survive model evolution: migrations are forward-only functions applied in
 * order before validation.
 */

import { SCHEMA_VERSION, type ProjectDocument } from "./types";

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

/** Index N migrates version N → N+1. Empty until schema v2 exists. */
const MIGRATIONS: Record<number, Migration> = {};

function migrate(input: unknown): ProjectDocument {
  if (typeof input !== "object" || input === null) throw new Error("Project file is not an object");
  let doc = input as Record<string, unknown>;
  let version = typeof doc.schemaVersion === "number" ? doc.schemaVersion : 0;
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
}
