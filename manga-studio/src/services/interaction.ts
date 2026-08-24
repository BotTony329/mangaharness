"use client";

/**
 * The single interaction execution path.
 *
 * Both the Inspector's Hug button and the Agent's `create_interaction` tool go
 * through here. Two pipelines would drift: the UI would grow a preview step the
 * Agent never got, or the Agent would learn a capability rule the UI did not
 * have, and a hug would mean two different things depending on how it was
 * asked for.
 *
 * What this owns:
 *   - capability evaluation (local placement vs shared anchor vs joint render)
 *   - cache reuse before spending a generation
 *   - the real provider call for joint renders
 *   - provenance recording so the image is known to contain both characters
 *
 * What it does NOT do: satisfy a joint interaction by overlapping two existing
 * sprites. A hug that cannot be generated fails loudly instead.
 */

import { generateImage, registerGeneratedAsset } from "@/services/generation";
import { buildAssetPrompt } from "@/ai/promptTemplates";
import { assetRenderUrl } from "@/assets/renderSource";
import { resolveCharacterIdentityReference, resolveIdentityReferences } from "@/characters/identityReference";
import { stateFromInstance } from "@/characters/state";
import { getStyleGenerationContext, isMonochromeStyle, styleMetadata } from "@/styles/generation";
import type { AssetInstance, ID, InteractionParameters, InteractionParticipant, InteractionType, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { puppetForInstance } from "@/domain/puppetOps";
import { resolveInteraction, type InteractionResolution } from "./interactionResolver";
import {
  interactionLabel,
  buildInteractionRenderRequest,
  interactionParticipants,
  evaluateInteractionCapability,
  findInteractionRender,
  interactionCacheKey,
  midpointAnchor,
  type InteractionCapabilityResult,
} from "@/domain/interactions";

export interface InteractionRequest {
  panelId: ID;
  /** Character ids, subject first (legacy character-only shorthand). */
  participantIds: ID[];
  /** Full participant list when objects/scenes take part (v0.2). */
  participants?: InteractionParticipant[];
  type: InteractionType | (string & {});
  /** Editable semantics (direction, hand, custom instruction…). */
  parameters?: InteractionParameters;
  source?: "manual" | "agent" | "preset";
  /** Expressions to apply per participant, when the request named any. */
  expressions?: Record<ID, string>;
}

export interface InteractionOutcome {
  interactionId: ID;
  capability: InteractionCapabilityResult;
  /** The joint render, when one was produced or reused. */
  assetId?: ID;
  reusedCache: boolean;
  /** Instance created in the panel, for composite renders. */
  placedItemId?: ID;
  generationCalls: number;
}

/** Which placed instance represents a character in this panel, if any. */
function instanceFor(doc: ProjectDocument, panelId: ID, characterId: ID): AssetInstance | undefined {
  return (doc.panels[panelId]?.itemIds ?? [])
    .map((id) => doc.items[id])
    .find((item): item is AssetInstance => {
      if (item?.kind !== "asset") return false;
      const owner = stateFromInstance(doc, item)?.characterId ?? doc.assets[item.sourceAssetId]?.metadata?.characterId;
      return owner === characterId;
    });
}

function outfitOf(doc: ProjectDocument, panelId: ID, characterId: ID): string {
  const item = instanceFor(doc, panelId, characterId);
  return (item && stateFromInstance(doc, item)?.outfit) || "default outfit";
}

/**
 * Decide how an interaction can be realised, without doing anything yet.
 *
 * Exposed so the UI can label a button "Instant" or "Generate" and the Agent
 * can decide whether the run needs a cost confirmation — both from the same
 * verdict.
 */
export function planInteraction(doc: ProjectDocument, request: InteractionRequest): InteractionCapabilityResult {
  return evaluateInteractionCapability({
    type: request.type as InteractionType,
    participantIds: request.participantIds,
    puppets: request.participantIds.map((characterId) => {
      const item = instanceFor(doc, request.panelId, characterId);
      return item ? puppetForInstance(doc, item) : undefined;
    }),
  });
}

/**
 * v0.2 strategy verdict for any participant mix. COMPOSE/TRANSFORM keep the
 * v0.1 local paths; GENERATE means one interaction-aware render with every
 * participant's reference — never overlapping sprites.
 */
export function planInteractionStrategy(doc: ProjectDocument, request: InteractionRequest): InteractionResolution {
  return resolveInteraction(doc, {
    panelId: request.panelId,
    type: request.type,
    parameters: request.parameters,
    participants: request.participants,
    participantIds: request.participantIds,
  });
}

/**
 * Create and realise an interaction.
 *
 * Runs inside whatever transaction the caller opened, so a failure here rolls
 * back with the rest of the run rather than leaving a half-built interaction.
 */
export async function executeInteraction(request: InteractionRequest): Promise<InteractionOutcome> {
  const store = () => useEditorStore.getState();
  const doc = () => {
    const current = store().doc;
    if (!current) throw new Error("No open project");
    return current;
  };

  const resolution = planInteractionStrategy(doc(), request);
  const capability = resolution.capability ?? planInteraction(doc(), request);
  const locallySupported = resolution.strategy !== "GENERATE";
  const participants =
    request.participants ??
    request.participantIds.map((id, index) => ({ id, kind: "character" as const, role: index === 0 ? "initiator" : "target" }));
  const created = store().dispatch({
    type: "create-interaction",
    input: {
      panelId: request.panelId,
      participantIds: request.participantIds,
      participants,
      type: request.type,
      roles: { subject: request.participantIds[0], target: request.participantIds[1] },
      parameters: request.parameters,
      source: request.source,
      renderMode: locallySupported ? "synchronized" : "composite",
      status: locallySupported ? "active" : "planned",
    },
  });
  const interactionId = created.createdId;
  if (!interactionId) throw new Error("The interaction could not be created");

  /**
   * Expressions are applied to the participants BEFORE any joint render, so a
   * generated hug shows the faces the creator asked for rather than whatever
   * the source renders happened to have.
   */
  for (const [characterId, expression] of Object.entries(request.expressions ?? {})) {
    const item = instanceFor(doc(), request.panelId, characterId);
    if (!item) continue;
    // Local when the character has a puppet; otherwise left to the caller's
    // semantic-state path, because silently generating here would hide a cost.
    if (puppetForInstance(doc(), item)) {
      store().dispatch({ type: "set-puppet-expression", instanceId: item.id, expressionId: expression });
    }
  }

  // ── Locally representable: shared anchor, no provider ──
  if (locallySupported) {
    if (capability.mode === "LOCAL_PUPPET" && needsAnchor(request.type)) {
      const [a, b] = request.participantIds.map((id) => instanceFor(doc(), request.panelId, id));
      if (a && b) {
        store().dispatch({
          type: "set-interaction-anchor",
          interactionId,
          anchor: midpointAnchor(a, b, {
            [request.participantIds[0]]: "rightHand",
            [request.participantIds[1]]: "leftHand",
          }),
        });
      }
    }
    return { interactionId, capability, reusedCache: false, generationCalls: 0 };
  }

  // ── Joint render ──
  const render = await renderInteraction(interactionId, request.expressions);
  const placedItemId = placeInteractionRender(interactionId, render.assetId);
  return {
    interactionId,
    capability,
    assetId: render.assetId,
    reusedCache: render.reusedCache,
    placedItemId,
    generationCalls: render.generationCalls,
  };
}

export interface RenderOutcome {
  assetId: ID;
  reusedCache: boolean;
  generationCalls: number;
}

/**
 * Draw (or reuse) the single image that shows an existing interaction.
 *
 * Split out from placement so the Inspector can preview the result before it
 * replaces anything on the page, while the Agent runs the same code without a
 * preview step. Nothing here touches the panel.
 */
export async function renderInteraction(
  interactionId: ID,
  expressions?: Record<ID, string>,
): Promise<RenderOutcome> {
  const doc = () => {
    const current = useEditorStore.getState().doc;
    if (!current) throw new Error("No open project");
    return current;
  };
  const interaction = doc().interactions[interactionId];
  if (!interaction) throw new Error("That interaction no longer exists");
  const participants = interactionParticipants(interaction);
  const participantIds = interaction.participantIds;
  const panelId = interaction.panelId;

  const style = getStyleGenerationContext(doc());
  const cacheKey = interactionCacheKey({
    participantCharacterIds: participantIds,
    // Socket/zone are part of the cache identity: "drive" in the driver-seat is
    // a different drawing from "drive" standing at the doorway.
    participantKeys: participants.map(
      (participant) =>
        `${participant.kind}:${participant.id}${participant.socket ? `@${participant.socket}` : ""}${participant.zone ? `#${participant.zone}` : ""}`,
    ),
    type: interaction.type,
    roles: interaction.roles,
    parameters: interaction.parameters,
    outfits: participantIds.map((id) => outfitOf(doc(), panelId, id)),
    view: "front",
    styleProfileId: style.profile.id,
    expressions,
  });

  // Reuse before generating: an identical interaction may already exist.
  const cached = findInteractionRender(doc(), cacheKey);
  if (cached) return { assetId: cached.generatedAssetId, reusedCache: true, generationCalls: 0 };

  /**
   * Heal the document before generating.
   *
   * A stored pointer that is missing or unusable, while the character owns a
   * perfectly good picture, is a data fault — not a decision for the creator.
   * Repairing it here means old projects, transparency repairs and replaced
   * originals all start working without anybody being asked to understand
   * metadata.
   */
  for (const characterId of participantIds) {
    const reference = resolveCharacterIdentityReference(doc(), characterId);
    if (reference.status === "resolved" && reference.needsRepair && reference.assetId) {
      useEditorStore.getState().dispatch({
        type: "set-character-reference",
        characterId,
        assetId: reference.assetId,
      });
    }
  }

  const model = buildInteractionRenderRequest(doc(), interaction, {
    styleProfileId: style.profile.id,
    outfits: Object.fromEntries(participantIds.map((id) => [id, outfitOf(doc(), panelId, id)])),
  });

  /**
   * Every participant contributes their OWN reference image. `buildMultiCharacterRequest`
   * already throws when one lacks a canonical render, so a missing identity is a
   * hard failure rather than a text description the model will blend away.
   */
  const referenceUrls = model.participantReferenceAssetIds
    .map((id) => assetRenderUrl(doc().assets[id]))
    .filter((url): url is string => Boolean(url));
  if (referenceUrls.length !== participants.length) {
    /**
     * Name who is missing what. The old message named nobody, so a creator
     * looking at two characters had no idea which one to fix or how.
     */
    const missing = resolveIdentityReferences(doc(), participantIds).filter(
      (reference) => reference.status !== "resolved",
    );
    const names = missing.map((reference) => reference.characterName);
    throw new Error(
      names.length > 0
        ? `${names.join(" and ")} ${names.length > 1 ? "need" : "needs"} a reference image before they can be drawn together.`
        : "One of these characters has no finished reference image yet.",
    );
  }

  /** Distinct references, or the model is being asked to draw one thing twice. */
  if (new Set(referenceUrls).size !== referenceUrls.length) {
    throw new Error("Two participants resolved to the same reference image, so their identities could not be kept apart.");
  }

  /**
   * Expressions must reach the PROMPT for a joint render.
   *
   * A puppet swap cannot reach inside an image that has not been drawn yet, so
   * "they both smile" would otherwise be silently dropped and come back as two
   * neutral faces — the request quietly half-executed.
   */
  const expressionConstraints = Object.entries(expressions ?? {})
    .filter(([characterId]) => participantIds.includes(characterId))
    .map(([characterId, expression]) => `${doc().characters[characterId]?.name ?? characterId} is ${expression}.`);

  const prompt = [
    buildAssetPrompt({
      assetType: "character",
      description: model.interactionConstraints.join(" "),
      style: style.profile,
      monochrome: isMonochromeStyle(style.profile),
    }),
    ...model.identityConstraints,
    ...model.outfitConstraints,
    ...expressionConstraints,
  ].join(" ");

  const result = await generateImage({
    assetType: "character",
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: "portrait",
    expectMonochrome: isMonochromeStyle(style.profile),
    referenceUrls,
  });

  const names = participants.map((participant) =>
    participant.kind === "character"
      ? (doc().characters[participant.id]?.name ?? participant.id)
      : (doc().assets[participant.id]?.name ?? participant.id),
  );
  const assetId = await registerGeneratedAsset({
    result,
    assetType: "character",
    category: "character",
    name: `${names.join(" + ")} · ${interactionLabel(interaction.type)}`,
    prompt,
    metadata: styleMetadata(style),
  });

  // Provenance: the system must know this image contains BOTH characters.
  useEditorStore.getState().dispatch({
    type: "record-interaction-render",
    input: {
      interactionId,
      participantCharacterIds: [...participantIds],
      participantReferenceAssetIds: model.participantReferenceAssetIds,
      generatedAssetId: assetId,
      cacheKey,
    },
  });

  return { assetId, reusedCache: false, generationCalls: 1 };
}

/**
 * Put the joint render on the page and retire the sprites it replaces.
 *
 * A composite hug already contains both people; leaving the separate sprites
 * visible would show each character twice. They are HIDDEN rather than deleted,
 * so undo and "discard this interaction" both restore the panel exactly as it
 * was — and so a creator can bring one back by clicking the eye in Layers.
 */
export function placeInteractionRender(interactionId: ID, assetId: ID): ID | undefined {
  const doc = useEditorStore.getState().doc;
  const interaction = doc?.interactions[interactionId];
  if (!doc || !interaction) return undefined;
  for (const characterId of interaction.participantIds) {
    const item = instanceFor(useEditorStore.getState().doc!, interaction.panelId, characterId);
    if (!item) continue;
    useEditorStore
      .getState()
      .dispatch({ type: "set-instance-props", instanceId: item.id, patch: { visible: false } });
  }
  const placed = useEditorStore
    .getState()
    .dispatch({ type: "add-instance", panelId: interaction.panelId, assetId });
  return placed.createdId;
}


/**
 * Re-draw an existing interaction after its semantics were edited.
 *
 * Editing direction/hand/zone changes the cache key, so the old composite can
 * never silently stand in for the new meaning. The superseded composite is
 * HIDDEN, not deleted — undo and layer-visibility recovery both keep working.
 * A cache hit that is already on the page is left alone (no duplicate instance).
 */
export async function rerenderInteraction(interactionId: ID): Promise<RenderOutcome> {
  const doc = useEditorStore.getState().doc;
  const interaction = doc?.interactions[interactionId];
  if (!doc || !interaction) throw new Error("That interaction no longer exists");

  const priorAssetIds = new Set(
    Object.values(doc.interactionRenders)
      .filter((render) => render.interactionId === interactionId)
      .map((render) => render.generatedAssetId),
  );
  const outcome = await renderInteraction(interactionId);

  const panelItemIds = useEditorStore.getState().doc?.panels[interaction.panelId]?.itemIds ?? [];
  const items = panelItemIds
    .map((id) => useEditorStore.getState().doc?.items[id])
    .filter((item): item is AssetInstance => item?.kind === "asset");
  const alreadyPlaced = items.some((item) => item.sourceAssetId === outcome.assetId && item.visible !== false);

  if (!alreadyPlaced) {
    for (const item of items) {
      if (item.sourceAssetId !== outcome.assetId && priorAssetIds.has(item.sourceAssetId) && item.visible !== false) {
        useEditorStore.getState().dispatch({ type: "set-instance-props", instanceId: item.id, patch: { visible: false } });
      }
    }
    placeInteractionRender(interactionId, outcome.assetId);
  }
  return outcome;
}

function needsAnchor(type: string): boolean {
  return type === "hold_hands" || type === "high_five" || type === "hand_object";
}
