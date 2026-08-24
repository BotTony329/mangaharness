"use client";

/**
 * InteractionResolver — the ONE place that decides how an interaction intent
 * becomes pixels. It never calls a provider; it returns a strategy and the
 * reason, so the UI can label the action and the Agent can price the run.
 *
 * Decision rules (deliberately few):
 *
 *   COMPOSE   — pure placement; existing assets suffice (v0.1 LOCAL_STAGE).
 *   TRANSFORM — rigs/anchors can express it without new artwork
 *               (v0.1 LOCAL_PUPPET / HYBRID).
 *   GENERATE  — the interaction changes what is depicted: any object or scene
 *               participant, any depiction-changing parameter (direction,
 *               contact, pose, custom instruction…), or the v0.1 joint-render
 *               verdict for overlapping characters.
 *
 * An object has no rig to transform and a scene is the stage itself, so their
 * presence always means GENERATE — "Yuri eats ramen" is not Yuri's sprite plus
 * a ramen sprite.
 */

import {
  evaluateInteractionCapability,
  interactionParticipants,
  type InteractionCapabilityResult,
} from "@/domain/interactions";
import { puppetForInstance } from "@/domain/puppetOps";
import { stateFromInstance } from "@/characters/state";
import type { AssetInstance, CharacterInteraction, ID, InteractionParameters, InteractionType, ProjectDocument } from "@/domain/types";

export type InteractionStrategy = "COMPOSE" | "TRANSFORM" | "GENERATE";

export interface InteractionResolution {
  strategy: InteractionStrategy;
  /** Maps to the v0.1 capability verdict for character-only interactions. */
  capability?: InteractionCapabilityResult;
  reason?: string;
}

/** Parameters that change what is drawn rather than where things stand. */
const DEPICTION_PARAMETERS: (keyof InteractionParameters)[] = [
  "direction",
  "contact",
  "facing",
  "pose",
  "customInstruction",
];

function hasDepictionParameters(parameters?: InteractionParameters): boolean {
  if (!parameters) return false;
  return DEPICTION_PARAMETERS.some((key) => {
    const value = parameters[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  });
}

export function resolveInteraction(
  doc: ProjectDocument,
  interaction: Pick<CharacterInteraction, "panelId" | "type" | "parameters" | "participants" | "participantIds">,
): InteractionResolution {
  const participants = interactionParticipants(interaction as CharacterInteraction);
  const nonCharacters = participants.filter((p) => p.kind !== "character");
  if (nonCharacters.length > 0) {
    const kinds = [...new Set(nonCharacters.map((p) => p.kind))].join("/");
    return {
      strategy: "GENERATE",
      reason: `An interaction with a ${kinds} participant changes what is depicted, so it is drawn once with every participant as reference.`,
    };
  }

  if (hasDepictionParameters(interaction.parameters)) {
    return {
      strategy: "GENERATE",
      reason: "Parameters like direction or contact change the depiction itself.",
    };
  }

  const capability = evaluateInteractionCapability({
    type: interaction.type as InteractionType,
    participantIds: interaction.participantIds,
    puppets: interaction.participantIds.map((characterId) => {
      const item = characterInstanceInPanel(doc, interaction.panelId, characterId);
      return item ? puppetForInstance(doc, item) : undefined;
    }),
  });

  if (capability.supportedLocally) {
    return {
      strategy: capability.mode === "LOCAL_STAGE" ? "COMPOSE" : "TRANSFORM",
      capability,
    };
  }
  return { strategy: "GENERATE", capability, reason: capability.reason };
}

/** Instance lookup shared with the service: which placed item plays a character. */
export function characterInstanceInPanel(doc: ProjectDocument, panelId: ID, characterId: ID) {
  return (doc.panels[panelId]?.itemIds ?? [])
    .map((id) => doc.items[id])
    .find((item): item is AssetInstance => {
      if (item?.kind !== "asset") return false;
      const owner = stateFromInstance(doc, item)?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId;
      return owner === characterId;
    });
}
