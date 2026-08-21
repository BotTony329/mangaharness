/**
 * The one answer to "which image IS this character?"
 *
 * ## Why this is a module
 *
 * Joint generation used to read `character.canonicalReferenceAssetId ??
 * character.referenceAssetId` and give up if that one pointer led nowhere
 * usable — even when the project plainly contained several perfectly good
 * pictures of the same character. The creator saw
 *
 *     "Every participant needs a usable identity reference before a joint render."
 *
 * which names nobody, explains nothing, and offers no way out.
 *
 * Two failures were tangled together there. A pointer can be MISSING (an old or
 * repaired document lost the forward link) or it can be PRESENT BUT UNUSABLE
 * (the asset it names never passed the transparency contract). The first is
 * recoverable without asking the creator anything; the second needs a decision,
 * and the decision needs a name attached to it.
 *
 * ## Identity is not current state
 *
 * A character standing in the panel mid-jump, laughing, seen from behind is a
 * bad identity anchor: a model handed that will reproduce the pose and lose the
 * face. Identity comes from the canonical reference; the current state travels
 * separately as pose and expression. That is why the ladder prefers a canonical
 * or front/neutral image over whatever happens to be selected.
 */

import { assetRenderUrl } from "@/assets/renderSource";
import type { Character, ID, ProjectDocument, SourceAsset } from "@/domain/types";
import { characterIdOfAsset } from "./identity";

export type IdentityReferenceSource =
  | "canonical"
  | "legacy-reference"
  | "character-library"
  | "tagged-asset"
  | "none";

export interface IdentityReference {
  characterId: ID;
  characterName: string;
  status: "resolved" | "missing";
  assetId?: ID;
  /** The URL the generator will actually send. */
  url?: string;
  source: IdentityReferenceSource;
  /**
   * True when the character's stored pointer was absent or unusable and the
   * resolver found the answer elsewhere. The caller should heal the document.
   */
  needsRepair: boolean;
  /** Creator-facing, names no internals. */
  reason?: string;
  /** Usable alternatives, best first — the "Choose Existing" list. */
  candidates: ID[];
}

/** Everything legitimately linked to this character, by any surviving link. */
export function characterAssets(doc: ProjectDocument, characterId: ID): SourceAsset[] {
  const seen = new Set<ID>();
  const out: SourceAsset[] = [];
  const push = (assetId: ID | undefined) => {
    if (!assetId || seen.has(assetId)) return;
    const asset = doc.assets[assetId];
    if (!asset || asset.status === "archived") return;
    seen.add(assetId);
    out.push(asset);
  };

  const character = doc.characters[characterId];
  push(character?.canonicalReferenceAssetId);
  push(character?.referenceAssetId);
  for (const assetId of character?.assetIds ?? []) push(assetId);
  /**
   * The reverse sweep catches assets whose forward metadata link was lost —
   * transparency repairs, replaced originals, imported documents. Without it a
   * character can own a perfectly good picture the resolver cannot see.
   */
  for (const asset of Object.values(doc.assets)) {
    if (characterIdOfAsset(doc, asset.id) === characterId) push(asset.id);
  }
  return out;
}

/** Usable means: it has a URL the compositor and the generator will both accept. */
export function isUsableIdentityAsset(asset: SourceAsset | undefined): boolean {
  return Boolean(asset) && Boolean(assetRenderUrl(asset));
}

/**
 * How good an identity anchor is this?
 *
 * Lower is better. A canonical image wins outright; after that a neutral,
 * front-facing, standing render beats an action pose, because the face is what
 * has to survive into the joint render.
 */
function identityRank(asset: SourceAsset): number {
  const meta = asset.metadata;
  if (meta?.characterAssetRole === "canonical") return 0;
  // A panel-only composite shows this character inside somebody else's scene.
  if (meta?.characterAssetRole === "panel-only") return 100;
  let score = 10;
  const neutral = (value: string | undefined, wanted: string[]) =>
    value === undefined || wanted.includes(value.toLowerCase());
  if (neutral(meta?.view, ["front"])) score -= 3;
  if (neutral(meta?.expression, ["neutral"])) score -= 2;
  if (neutral(meta?.pose, ["standing"])) score -= 2;
  if (meta?.characterAssetRole === "variation") score += 1;
  return score;
}

/**
 * Resolve, in deterministic priority order:
 *
 *   1. the character's canonical reference, if it is usable
 *   2. the legacy reference pointer, if it is usable
 *   3. the best usable image in the character's own library
 *   4. the best usable image tagged with this character anywhere in the project
 *
 * Steps 3 and 4 set `needsRepair`, because reaching them means the stored
 * pointer is wrong and the document should be healed.
 */
export function resolveCharacterIdentityReference(doc: ProjectDocument, characterId: ID): IdentityReference {
  const character: Character | undefined = doc.characters[characterId];
  const name = character?.name ?? "This character";
  const base = { characterId, characterName: name };

  if (!character) {
    return { ...base, status: "missing", source: "none", needsRepair: false, candidates: [], reason: "This character no longer exists in the project." };
  }

  const all = characterAssets(doc, characterId);
  const usable = all.filter(isUsableIdentityAsset).sort((a, b) => identityRank(a) - identityRank(b));
  const candidates = usable.map((asset) => asset.id);

  const canonical = doc.assets[character.canonicalReferenceAssetId ?? ""];
  if (isUsableIdentityAsset(canonical)) {
    return { ...base, status: "resolved", assetId: canonical.id, url: assetRenderUrl(canonical), source: "canonical", needsRepair: false, candidates };
  }

  const legacy = doc.assets[character.referenceAssetId ?? ""];
  if (isUsableIdentityAsset(legacy)) {
    return { ...base, status: "resolved", assetId: legacy.id, url: assetRenderUrl(legacy), source: "legacy-reference", needsRepair: true, candidates };
  }

  const best = usable[0];
  if (best) {
    const inLibrary = (character.assetIds ?? []).includes(best.id);
    return {
      ...base,
      status: "resolved",
      assetId: best.id,
      url: assetRenderUrl(best),
      source: inLibrary ? "character-library" : "tagged-asset",
      needsRepair: true,
      candidates,
    };
  }

  /**
   * Nothing usable. Say WHY in the creator's terms: having no pictures at all
   * and having pictures whose cut-out failed need different repairs.
   */
  const hasUnusable = all.length > 0;
  return {
    ...base,
    status: "missing",
    source: "none",
    needsRepair: false,
    candidates: [],
    reason: hasUnusable
      ? `${name} has images, but none of them has a finished cut-out yet.`
      : `${name} has no reference image yet.`,
  };
}

/** Resolve for several participants at once. */
export function resolveIdentityReferences(doc: ProjectDocument, characterIds: ID[]): IdentityReference[] {
  return characterIds.map((id) => resolveCharacterIdentityReference(doc, id));
}

export function missingIdentityReferences(references: IdentityReference[]): IdentityReference[] {
  return references.filter((reference) => reference.status === "missing");
}
