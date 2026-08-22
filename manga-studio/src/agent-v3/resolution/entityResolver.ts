"use client";

/**
 * Project Resolution + Runtime Identity Bindings.
 *
 * AFTER the Creative Director produces a Creative Task Map, this module binds
 * every named ref to actual project state:
 *
 *   name in library?      → bind ref → real characterId
 *   create_if_missing     → creation step is planned; the binding is filled at
 *                           execution time from CharacterService's return value
 *   existing but missing  → clarification/block, never invention
 *
 * Only the harness owns these bindings. The Task Map never carries IDs, so
 * there is nothing planner-generated to leak — refs are names, bound here.
 */

import type { ID, ProjectDocument } from "@/domain/types";
import { findCharacter } from "@/agent/resolver";
import type { CreativeTaskMap } from "../contract/creativeTaskMap";

export interface ParticipantBinding {
  name: string;
  status: "existing" | "create";
  /** Real domain ID when the character exists at resolution time. */
  characterId?: ID;
  attributes: string[];
}

export interface Resolution {
  participants: Map<string, ParticipantBinding>;
  /** Scene reuse target, resolved against the library by name. */
  sceneAssetId?: ID;
  /** Names that must exist but don't — the run asks rather than invents. */
  unresolved: string[];
}

export function resolveTaskMap(map: CreativeTaskMap, doc: ProjectDocument): Resolution {
  const participants = new Map<string, ParticipantBinding>();
  const unresolved: string[] = [];

  for (const participant of map.participants) {
    const existing = findCharacter(doc, participant.name);
    if (existing) {
      participants.set(participant.name, {
        name: participant.name,
        status: "existing",
        characterId: existing.id,
        attributes: participant.attributes,
      });
    } else if (participant.resolutionIntent === "create_if_missing") {
      participants.set(participant.name, { name: participant.name, status: "create", attributes: participant.attributes });
    } else {
      unresolved.push(participant.name);
    }
  }

  // Beat actors/targets that are not declared participants must still resolve.
  for (const beat of map.beats) {
    for (const ref of [beat.actor, beat.target]) {
      if (!ref || participants.has(ref)) continue;
      const existing = findCharacter(doc, ref);
      if (existing) {
        participants.set(ref, { name: ref, status: "existing", characterId: existing.id, attributes: [] });
      } else {
        unresolved.push(ref);
      }
    }
  }

  let sceneAssetId: ID | undefined;
  const reuse = map.scene?.reuseExisting;
  if (reuse) {
    sceneAssetId = Object.values(doc.assets).find(
      (a) => a.category === "background" && a.name.trim().toLowerCase() === reuse.trim().toLowerCase(),
    )?.id;
  }

  return { participants, sceneAssetId, unresolved };
}
