/**
 * State-graph maintenance.
 *
 * A graph node is created whenever a character render enters the library, so
 * the graph can never diverge from the assets — it is maintained AT the write
 * path rather than alongside it. Lineage fields come from the generation that
 * produced the asset, which is why `AssetGenerationMetadata` carries the
 * reference and parent it was built from.
 */

import { newId, now } from "./factory";
import { DEFAULT_STYLE_PROFILE_ID } from "@/styles/profiles";
import type {
  CharacterStateDelta,
  CharacterStateRecord,
  ID,
  ProjectDocument,
  SourceAsset,
} from "./types";

const DEFAULTS = { pose: "standing", expression: "neutral", outfit: "default outfit", view: "front" };

function normalize(value: string | undefined, fallback: string): string {
  return value?.trim().toLowerCase() || fallback;
}

function normalizeProps(props: string[] | undefined): string[] {
  if (!props || props.length === 0) return [];
  return [...new Set(props.map((prop) => prop.trim().toLowerCase()).filter(Boolean))].sort();
}

function keyOf(record: Pick<CharacterStateRecord, "characterId" | "pose" | "expression" | "outfit" | "view" | "props">): string {
  return [record.characterId, record.pose, record.expression, record.outfit, record.view, record.props.join("+")].join("|");
}

/**
 * Create or update the graph node for a character render. Mutates `doc` in
 * place; callers are already working on a cloned document.
 *
 * Canonical images are identity anchors rather than selectable states, so they
 * get no node — otherwise "standing/neutral" would appear cached the moment a
 * character was created, before any state had been rendered.
 */
export function recordAssetState(doc: ProjectDocument, asset: SourceAsset): CharacterStateRecord | undefined {
  const metadata = asset.metadata;
  const characterId = metadata?.characterId;
  if (!characterId || !doc.characters[characterId]) return undefined;
  if (metadata?.characterAssetRole === "canonical") return undefined;
  if (asset.category !== "character") return undefined;

  const candidate = {
    characterId,
    pose: normalize(metadata?.pose, DEFAULTS.pose),
    expression: normalize(metadata?.expression, DEFAULTS.expression),
    outfit: normalize(metadata?.outfit, DEFAULTS.outfit),
    view: normalize(metadata?.view, DEFAULTS.view),
    props: normalizeProps(asset.provenance?.characterState?.props),
  };

  const existing = Object.values(doc.characterStates).find(
    (record) => keyOf(record) === keyOf(candidate) && record.assetId === asset.id,
  );
  const id = existing?.id ?? newId();
  const record: CharacterStateRecord = {
    id,
    ...candidate,
    assetId: asset.id,
    parentStateId: metadata?.parentStateId ?? existing?.parentStateId,
    referenceAssetId: metadata?.referenceAssetIds?.[0] ?? metadata?.canonicalReferenceAssetId,
    canonicalReferenceAssetId: metadata?.canonicalReferenceAssetId,
    delta: metadata?.stateDelta ?? existing?.delta,
    styleProfileId: metadata?.styleProfileId ?? DEFAULT_STYLE_PROFILE_ID,
    createdAt: existing?.createdAt ?? asset.createdAt ?? now(),
  };
  doc.characterStates[id] = record;
  return record;
}

/** Drop nodes whose render no longer exists, so the graph cannot hold ghosts. */
export function pruneCharacterStates(doc: ProjectDocument): void {
  for (const [id, record] of Object.entries(doc.characterStates)) {
    const assetGone = record.assetId !== undefined && !doc.assets[record.assetId];
    const characterGone = !doc.characters[record.characterId];
    if (assetGone || characterGone) delete doc.characterStates[id];
  }
  // Re-parent orphans rather than leaving dangling lineage.
  for (const record of Object.values(doc.characterStates)) {
    if (record.parentStateId && !doc.characterStates[record.parentStateId]) {
      record.parentStateId = undefined;
    }
  }
}

/** Attach lineage discovered after the fact (e.g. once a generation completes). */
export function setStateLineage(
  doc: ProjectDocument,
  stateId: ID,
  lineage: { parentStateId?: ID; referenceAssetId?: ID; canonicalReferenceAssetId?: ID; delta?: CharacterStateDelta },
): void {
  const record = doc.characterStates[stateId];
  if (!record) return;
  if (lineage.parentStateId !== undefined) record.parentStateId = lineage.parentStateId;
  if (lineage.referenceAssetId !== undefined) record.referenceAssetId = lineage.referenceAssetId;
  if (lineage.canonicalReferenceAssetId !== undefined) {
    record.canonicalReferenceAssetId = lineage.canonicalReferenceAssetId;
  }
  if (lineage.delta !== undefined) record.delta = lineage.delta;
}

/** Backfill the graph from every character render already in a document. */
export function rebuildCharacterStates(doc: ProjectDocument): void {
  doc.characterStates ??= {};
  for (const asset of Object.values(doc.assets)) recordAssetState(doc, asset);
  pruneCharacterStates(doc);
}
