/** Mutations for source assets, characters, and generation history. */

import { cloneDoc, touch } from "./docHelpers";
import { recordAssetState } from "./characterStateOps";
import { newId, now } from "./factory";
import type {
  AssetCategory,
  AssetGenerationMetadata,
  Character,
  GenerationRecord,
  ID,
  ProjectDocument,
  SourceAsset,
} from "./types";
import { deleteAsset, deleteCharacter } from "./assetLifecycle";

export interface NewAssetInput {
  category: AssetCategory;
  name: string;
  storageUrl: string;
  processedImageUrl?: string;
  width: number;
  height: number;
  mimeType?: string;
  hasAlpha?: boolean;
  backgroundRemoved?: boolean;
  processingStatus?: SourceAsset["processingStatus"];
  backgroundRemovalStatus?: SourceAsset["backgroundRemovalStatus"];
  processingReason?: string;
  backgroundRemovalMethod?: string;
  backgroundRemovalProvider?: string;
  metadata?: AssetGenerationMetadata;
  type?: SourceAsset["type"];
  provenance?: SourceAsset["provenance"];
}

/** Record a processed derivative without overwriting the immutable source. */
export function setAssetProcessedImage(
  doc: ProjectDocument,
  assetId: ID,
  update: Pick<SourceAsset, "processedImageUrl" | "hasAlpha" | "backgroundRemoved" | "processingStatus" | "backgroundRemovalStatus" | "processingReason" | "backgroundRemovalMethod" | "backgroundRemovalProvider">,
): ProjectDocument {
  const next = cloneDoc(doc);
  const asset = next.assets[assetId];
  if (!asset) throw new Error(`Unknown asset: ${assetId}`);
  Object.assign(asset, update);
  asset.status = update.processingStatus === "processing"
    ? "processing"
    : update.processingStatus === "failed" ? "failed" : asset.status === "archived" ? "archived" : "ready";
  asset.updatedAt = now();
  touch(next);
  return next;
}

export function addAsset(doc: ProjectDocument, input: NewAssetInput): { doc: ProjectDocument; assetId: ID } {
  const next = cloneDoc(doc);
  const createdAt = now();
  const asset: SourceAsset = {
    id: newId(),
    projectId: next.project.id,
    ...input,
    backgroundRemovalStatus: input.backgroundRemovalStatus ?? input.processingStatus,
    type: input.type ?? assetTypeFromInput(input),
    sourceUrl: input.storageUrl,
    status: input.processingStatus === "processing" ? "processing" : input.processingStatus === "failed" ? "failed" : "ready",
    provenance: input.provenance ?? provenanceFromMetadata(input.metadata),
    createdAt,
    updatedAt: createdAt,
  };
  next.assets[asset.id] = asset;
  // Character-tagged assets also join their character's library.
  const characterId = input.metadata?.characterId;
  if (characterId && next.characters[characterId]) {
    next.characters[characterId].assetIds.push(asset.id);
    if (input.metadata?.characterAssetRole === "canonical" || !next.characters[characterId].referenceAssetId) {
      next.characters[characterId].referenceAssetId = asset.id;
      next.characters[characterId].canonicalReferenceAssetId = asset.id;
    }
  }
  /**
   * Maintaining the graph here — rather than beside it — is what stops the
   * state graph and the asset library from ever disagreeing.
   *
   * A COSMETIC local edit is deliberately excluded. Fixing a malformed finger
   * produces better pixels for a state that already exists; registering it as a
   * new semantic node would fill the character's state graph with entries that
   * are indistinguishable from one another and mean nothing to a creator.
   * Visual edit lineage lives in `provenance.localEdit`, not in the graph.
   */
  if (asset.provenance?.localEdit?.intent === "cosmetic") {
    promoteVariation(next, asset);
  } else {
    recordAssetState(next, asset);
  }
  touch(next);
  return { doc: next, assetId: asset.id };
}

/**
 * A cosmetic edit REPLACES the render it improved.
 *
 * Fixing a malformed hand in "Yuri, standing" produces better pixels for a
 * state that already exists. Without this the state graph still points at the
 * broken original, so every later "place Yuri standing" quietly reintroduces
 * the very defect the creator just paid to fix — the edit would only ever
 * apply to the one instance they were looking at.
 *
 * The superseded image is kept, not deleted: it is still referenced by any
 * instance already placed from it, and lineage is what makes the change
 * reversible.
 */
function promoteVariation(doc: ProjectDocument, asset: SourceAsset): void {
  const parentId = asset.provenance?.localEdit?.parentAssetId;
  const characterId = asset.metadata?.characterId;
  if (!parentId || !characterId) return;
  const record = Object.values(doc.characterStates).find(
    (candidate) => candidate.characterId === characterId && candidate.assetId === parentId,
  );
  if (!record) return;
  record.supersededAssetIds = [...(record.supersededAssetIds ?? []), parentId];
  record.assetId = asset.id;
  doc.assets[asset.id].metadata = { ...doc.assets[asset.id].metadata, characterAssetRole: "variation" };
  /**
   * The character's identity anchor follows the repair too. Generating future
   * poses from an image with a broken hand would propagate the defect into
   * everything drawn afterwards.
   */
  const character = doc.characters[characterId];
  if (character?.canonicalReferenceAssetId === parentId) {
    character.canonicalReferenceAssetId = asset.id;
    character.referenceAssetId = asset.id;
  }
}

function assetTypeFromInput(input: NewAssetInput): SourceAsset["type"] {
  if (input.category === "character") return input.metadata?.characterAssetRole === "canonical" ? "reference" : "character-visual";
  return input.category;
}

function provenanceFromMetadata(metadata: AssetGenerationMetadata | undefined): SourceAsset["provenance"] {
  if (!metadata) return undefined;
  return {
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

/**
 * Removing a source asset removes every instance of it — the only case where
 * library changes cascade into panels. The inverse never happens.
 */
export function removeAsset(doc: ProjectDocument, assetId: ID): ProjectDocument {
  return deleteAsset(doc, assetId, "cascade");
}

export function addCharacter(
  doc: ProjectDocument,
  name: string,
  appearance?: string,
  personalityNotes?: string,
): { doc: ProjectDocument; characterId: ID } {
  const next = cloneDoc(doc);
  const character: Character = {
    id: newId(),
    projectId: next.project.id,
    name,
    description: appearance,
    appearance,
    personalityNotes,
    assetIds: [],
    createdAt: now(),
  };
  next.characters[character.id] = character;
  touch(next);
  return { doc: next, characterId: character.id };
}

export function removeCharacter(doc: ProjectDocument, characterId: ID): ProjectDocument {
  return deleteCharacter(doc, characterId, "delete-all");
}

export function setCharacterReference(doc: ProjectDocument, characterId: ID, assetId: ID): ProjectDocument {
  const next = cloneDoc(doc);
  const character = next.characters[characterId];
  if (!character) throw new Error(`Unknown character: ${characterId}`);
  if (!next.assets[assetId]) throw new Error(`Unknown asset: ${assetId}`);
  character.referenceAssetId = assetId;
  character.canonicalReferenceAssetId = assetId;
  next.assets[assetId].metadata = {
    ...next.assets[assetId].metadata,
    characterId,
    characterAssetRole: "canonical",
    canonicalReferenceAssetId: assetId,
  };
  touch(next);
  return next;
}

export function addGenerationRecord(doc: ProjectDocument, record: Omit<GenerationRecord, "id" | "createdAt">): ProjectDocument {
  const next = cloneDoc(doc);
  next.generationHistory.push({ id: newId(), createdAt: now(), ...record });
  touch(next);
  return next;
}
