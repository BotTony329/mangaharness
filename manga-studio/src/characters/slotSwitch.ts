/**
 * Semantic slot switching for character instances ("Pose: Standing →
 * Running"). Unlike the agent's fuzzy resolver, switching is strict: the
 * requested slot value must actually exist — a miss means the UI offers
 * generation instead of silently substituting something else.
 */

import type { Character, ID, ProjectDocument, SourceAsset } from "@/domain/types";

export interface SlotQuery {
  pose?: string;
  expression?: string;
}

export function characterOfAsset(doc: ProjectDocument, sourceAssetId: ID): Character | null {
  const characterId = doc.assets[sourceAssetId]?.metadata?.characterId;
  return characterId ? (doc.characters[characterId] ?? null) : null;
}

/** Distinct slot values available for a character, for dropdown options. */
export function availableSlotValues(doc: ProjectDocument, character: Character, key: "pose" | "expression"): string[] {
  const values = character.assetIds
    .map((id) => doc.assets[id]?.metadata?.[key])
    .filter((v): v is string => Boolean(v));
  return [...new Set(values)];
}

/**
 * Find the asset for a requested slot change. The changed field must match
 * exactly; among those, prefer keeping the instance's other current slot
 * value, then the newest asset (later generations refine earlier ones).
 */
export function findSlotAsset(
  doc: ProjectDocument,
  character: Character,
  requested: SlotQuery,
  current: SlotQuery = {},
): SourceAsset | null {
  const assets = character.assetIds.map((id) => doc.assets[id]).filter(Boolean) as SourceAsset[];
  const matches = assets.filter((asset) =>
    (["pose", "expression"] as const).every(
      (key) => !requested[key] || asset.metadata?.[key]?.toLowerCase() === requested[key]!.toLowerCase(),
    ),
  );
  if (matches.length === 0) return null;

  const keepsContext = matches.filter((asset) =>
    (["pose", "expression"] as const).every((key) => {
      if (requested[key] || !current[key]) return true;
      return asset.metadata?.[key]?.toLowerCase() === current[key]!.toLowerCase();
    }),
  );
  const pool = keepsContext.length > 0 ? keepsContext : matches;
  return pool[pool.length - 1];
}
