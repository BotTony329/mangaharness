/**
 * Project document ⇄ JSON. Documents carry a schemaVersion so stored projects
 * survive model evolution: migrations are forward-only functions applied in
 * order before validation.
 */

import { defaultPageWorkspacePosition } from "./factory";
import { rectToPoints } from "./geometry";
import { createPanelCamera } from "./camera";
import { createPanelPerspective } from "./perspective";
import { normalizeEffectParams } from "./effects";
import { SCHEMA_VERSION, type EffectKind, type ProjectDocument, type Rect } from "./types";
import { DEFAULT_STYLE_PROFILE_ID } from "@/styles/profiles";
import { rebuildAllScenes } from "./sceneOps";

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
  // v2 → v3: character assets and placed instances gain complete semantic
  // state. Missing legacy fields receive explicit, predictable defaults.
  2: (doc) => {
    const characters = (doc.characters ?? {}) as Record<
      string,
      { referenceAssetId?: string; canonicalReferenceAssetId?: string; assetIds?: string[] }
    >;
    const assets = (doc.assets ?? {}) as Record<
      string,
      { id?: string; metadata?: Record<string, unknown> }
    >;
    for (const character of Object.values(characters)) {
      character.canonicalReferenceAssetId ??= character.referenceAssetId;
      for (const assetId of character.assetIds ?? []) {
        const asset = assets[assetId];
        if (!asset?.metadata) continue;
        asset.metadata.pose ??= "standing";
        asset.metadata.expression ??= "neutral";
        asset.metadata.outfit ??= "default outfit";
        asset.metadata.view ??= "front";
        asset.metadata.characterAssetRole ??=
          assetId === character.canonicalReferenceAssetId ? "canonical" : "state";
        asset.metadata.canonicalReferenceAssetId ??= character.canonicalReferenceAssetId;
      }
    }
    const items = (doc.items ?? {}) as Record<
      string,
      { kind?: string; sourceAssetId?: string; characterState?: unknown }
    >;
    for (const item of Object.values(items)) {
      if (item.kind !== "asset" || item.characterState || !item.sourceAssetId) continue;
      const asset = assets[item.sourceAssetId];
      const metadata = asset?.metadata;
      if (!metadata?.characterId) continue;
      item.characterState = {
        characterId: metadata.characterId,
        pose: metadata.pose ?? "standing",
        expression: metadata.expression ?? "neutral",
        outfit: metadata.outfit ?? "default outfit",
        view: metadata.view ?? "front",
        assetId: item.sourceAssetId,
      };
    }
    return { ...doc, schemaVersion: 3 };
  },
  // v3 → v4: art direction becomes persistent project state and legacy
  // character descriptions are normalized into identity-only appearance.
  3: (doc) => {
    const project = doc.project as { settings?: Record<string, unknown> } | undefined;
    if (project?.settings) {
      project.settings.artStyle ??= {
        activeStyleId: DEFAULT_STYLE_PROFILE_ID,
        customProfiles: {},
      };
    }
    const characters = (doc.characters ?? {}) as Record<
      string,
      { description?: string; appearance?: string; personalityNotes?: string }
    >;
    for (const character of Object.values(characters)) {
      character.appearance ??= character.description;
    }
    return { ...doc, schemaVersion: 4 };
  },
  // v4 → v5: source images remain immutable while optional transparent
  // derivatives become the preferred compositing surface. Legacy assets stay
  // raw so users can process them explicitly without losing their originals.
  4: (doc) => {
    const assets = (doc.assets ?? {}) as Record<string, { processingStatus?: string }>;
    for (const asset of Object.values(assets)) asset.processingStatus ??= "raw";
    return { ...doc, schemaVersion: 5 };
  },
  // v5 → v6: assets gain canonical lifecycle/provenance fields while legacy
  // URL/metadata aliases remain readable; panels gain semantic Scene records.
  5: (doc) => {
    const assets = (doc.assets ?? {}) as Record<string, {
      category?: string;
      storageUrl?: string;
      processedImageUrl?: string;
      processingStatus?: string;
      type?: string;
      sourceUrl?: string;
      status?: string;
      provenance?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      createdAt?: string;
      updatedAt?: string;
    }>;
    for (const asset of Object.values(assets)) {
      const metadata = asset.metadata;
      asset.type ??= asset.category === "character"
        ? metadata?.characterAssetRole === "canonical" ? "reference" : "character-visual"
        : asset.category ?? "upload";
      asset.sourceUrl ??= asset.storageUrl ?? "";
      asset.status ??= asset.processingStatus === "processing"
        ? "processing"
        : asset.processingStatus === "failed" ? "failed" : "ready";
      asset.updatedAt ??= asset.createdAt ?? new Date(0).toISOString();
      if (!asset.provenance && metadata) {
        asset.provenance = {
          provider: metadata.provider,
          model: metadata.model,
          prompt: metadata.prompt,
          negativePrompt: metadata.negativePrompt,
          generatedFromAssetIds: metadata.referenceAssetIds,
          characterId: metadata.characterId,
          characterState: {
            pose: metadata.pose,
            expression: metadata.expression,
            outfit: metadata.outfit,
            view: metadata.view,
          },
          canonicalReferenceAssetId: metadata.canonicalReferenceAssetId,
          projectStyleId: metadata.styleProfileId,
          generatedAt: metadata.generatedAt,
        };
      }
    }
    doc.scenes ??= {};
    const migrated = { ...doc, schemaVersion: 6 } as unknown as ProjectDocument;
    if (doc.panels && doc.items && doc.assets && doc.project) rebuildAllScenes(migrated);
    return migrated as unknown as Record<string, unknown>;
  },
  /**
   * v6 → v7: the virtual manga stage.
   *
   * Panels gain a camera and perspective guides; effect params become typed;
   * bubbles gain a semantic speaker. Every addition is defaulted rather than
   * inferred, so an existing project opens looking exactly as it did — the new
   * controls simply start at neutral values instead of being absent.
   */
  6: (doc) => {
    const panels = (doc.panels ?? {}) as Record<string, Record<string, unknown>>;
    for (const panel of Object.values(panels)) {
      panel.camera ??= createPanelCamera();
      panel.perspective ??= createPanelPerspective();
    }

    const items = (doc.items ?? {}) as Record<string, Record<string, unknown>>;
    for (const item of Object.values(items)) {
      if (item.kind !== "effect") continue;
      const kind = (item.effectKind as EffectKind) ?? "speed-lines";
      // Legacy params were an untyped bag; normalize tolerates every shape.
      item.effectKind = kind;
      item.params = normalizeEffectParams(kind, item.params as Record<string, unknown> | undefined);
    }

    return { ...doc, schemaVersion: 7 };
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
  if (typeof doc.scenes !== "object" || doc.scenes === null) {
    doc.scenes = {};
    rebuildAllScenes(doc);
  }
}
