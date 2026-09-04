"use client";

/**
 * Panel-level Unified Generative Camera (v0.3 Phase 4.5) — the ONE boundary
 * the UI calls when a panel camera must become artwork.
 *
 * ## Camera owner: the PANEL
 *
 * A camera belongs to the shot, and the shot is the whole panel. A generative
 * camera change therefore produces ONE unified picture of the entire panel —
 * every character, the scene, objects and interaction participants drawn
 * together under one viewpoint — never per-asset redraws overlaid afterwards
 * (which guarantee perspective, scale and contact mismatches), and never a
 * selection/fallback that happens to redraw only the scene while Yuri stays
 * flat (the pre-4.5 target-routing failure this service replaces).
 *
 *   CameraResolver gate (LOCAL → zero API, always)
 *     └─ GENERATIVE → resolvePanelVisualParticipants (structured, from the
 *                     document — bubbles, effects, tones and borders are NOT
 *                     visual participants and never reach the prompt)
 *                   → reference policy (character canonical, scene/object
 *                     lineage ROOT, interaction participants — never a
 *                     previous composite, never a derivative chain)
 *                   → ONE generateImage → Panel Camera Render asset
 *                   → panel.activeCameraRenderAssetId (non-destructive:
 *                     source instances stay; undo restores the composition)
 *
 * ## What this refuses
 *
 *   - LOCAL camera work: throws, zero API calls.
 *   - Inventing relationships: participants come from placed instances and
 *     formal interaction records only; the prompt states what IS there.
 *   - Silent reference drops: when the provider's reference budget is smaller
 *     than the participant list, a documented priority decides, and the
 *     omission is recorded in evidence and asset metadata.
 */

import type { AssetInstance, ID, PanelCamera, PanelPerspective, ProjectDocument, ShotType } from "@/domain/types";
import { buildInteractionRenderRequest, interactionParticipants } from "@/domain/interactions";
import { stateFromInstance } from "@/characters/state";
import { resolveCharacterIdentityReference, resolveIdentityReferences } from "@/characters/identityReference";
import { useEditorStore } from "@/editor/store";
import { cameraContextForPanel, panelAspectFor, resolveCameraExecution } from "@/services/cameraResolver";
import { generateImage, recordGenerationEvidence, registerGeneratedAsset } from "@/services/generation";
import { buildPanelShotPrompt } from "@/ai/promptTemplates";
import { assetRenderUrl } from "@/assets/renderSource";
import { getStyleGenerationContext, isMonochromeStyle, styleMetadata } from "@/styles/generation";

/**
 * The client-visible provider status carries no reference COUNT, and the two
 * image providers currently shipped both cap at 3 (ai/providers/*). Until the
 * capability surface exposes maxImages, the panel shot budgets conservatively
 * at 3 — and NEVER drops past the cap silently: omissions are prioritised,
 * recorded in runtime evidence and stored on the render asset's metadata.
 */
export const MAX_PANEL_REFERENCES = 3;

export type PanelParticipantKind = "character" | "scene" | "object";

export interface PanelVisualParticipant {
  kind: PanelParticipantKind;
  /** The placed instance this participant was resolved from, when placed. */
  instanceId?: ID;
  /** Character id for characters; source asset id otherwise. */
  id: ID;
  name: ID | string;
  /** The reference image that travels to the provider. */
  referenceAssetId: ID;
  /** Where the reference sits in the asset's lineage. */
  lineage: "canonical" | "root";
  /** Current semantic state, for characters ("pose: walking" etc.). */
  stateSentences: string[];
  /** True when a formal composite interaction covers this participant. */
  inInteraction: boolean;
}

export interface PanelCameraPlan {
  requiresRedraw: boolean;
  reason?: string;
  /** A redraw verdict with at least one visual participant to draw. */
  routable: boolean;
  participantCount: number;
}

export interface PanelCameraResult {
  route: "panel-shot";
  assetId: ID;
  generationCalls: number;
  /** Participants omitted by the reference budget, when any. */
  omittedParticipants: string[];
}

/* ── Participant resolution ──────────────────────────────────────────────── */

/**
 * The panel's visual participants, resolved from the DOCUMENT — instances →
 * assets — never from a screenshot or a guess.
 *
 * Excluded by construction: bubbles, effects, tones and language items (they
 * are not `kind: "asset"`), plus generated composites (interaction renders and
 * earlier panel camera renders): those are OUTPUTS of generation, and feeding
 * one back as a participant is exactly how derivative chains and "redraw only
 * the street" regressions start. Hidden source instances DO participate — a
 * composite interaction retires its sprites by hiding them, and they are the
 * structured source graph the next shot is drawn from.
 */
export function resolvePanelVisualParticipants(doc: ProjectDocument, panelId: ID): PanelVisualParticipant[] {
  const panel = doc.panels[panelId];
  if (!panel) return [];
  const compositeInteractions = Object.values(doc.interactions ?? {}).filter(
    (interaction) => interaction.panelId === panelId && interaction.renderMode === "composite",
  );
  const interactionMember = (characterId: ID | undefined, assetId: ID) =>
    compositeInteractions.some((interaction) =>
      interactionParticipants(interaction).some(
        (participant) =>
          (participant.kind === "character" && participant.id === characterId) ||
          (participant.kind !== "character" && participant.id === assetId),
      ),
    );

  const participants: PanelVisualParticipant[] = [];
  /**
   * One participant per character/asset, not per instance. Placing Yuri twice
   * must not send her canonical image to the provider twice — the duplicate
   * reference guard exists to catch two DIFFERENT identities sharing one
   * image, and duplicate instances of the same identity are not that.
   */
  const seen = new Set<string>();
  for (const itemId of panel.itemIds) {
    const item = doc.items[itemId];
    if (item?.kind !== "asset") continue;
    const asset = doc.assets[item.sourceAssetId];
    if (!asset) continue;
    // Generated composites are results, not sources.
    if (asset.metadata?.panelCameraRender || asset.metadata?.interactionId) continue;

    const state = stateFromInstance(doc, item);
    const characterId = state?.characterId ?? (asset.metadata?.characterId as ID | undefined);
    if (characterId && doc.characters[characterId]) {
      if (seen.has(`character:${characterId}`)) continue;
      const reference = resolveCharacterIdentityReference(doc, characterId);
      if (reference.status !== "resolved" || !reference.assetId) continue;
      seen.add(`character:${characterId}`);
      participants.push({
        kind: "character",
        instanceId: item.id,
        id: characterId,
        name: doc.characters[characterId].name,
        referenceAssetId: reference.assetId,
        lineage: "canonical",
        stateSentences: characterStateSentences(doc, item),
        inInteraction: interactionMember(characterId, item.sourceAssetId),
      });
      continue;
    }
    if (asset.category === "background") {
      if (seen.has(`scene:${asset.id}`)) continue;
      seen.add(`scene:${asset.id}`);
      const root = lineageRootAsset(doc, asset.id);
      participants.push({
        kind: "scene",
        instanceId: item.id,
        id: asset.id,
        name: asset.name,
        referenceAssetId: root?.id ?? asset.id,
        lineage: "root",
        stateSentences: [],
        inInteraction: interactionMember(undefined, item.sourceAssetId),
      });
      continue;
    }
    // Objects and props join the shot through their lineage root as well.
    if (seen.has(`object:${asset.id}`)) continue;
    seen.add(`object:${asset.id}`);
    const root = lineageRootAsset(doc, asset.id);
    participants.push({
      kind: "object",
      instanceId: item.id,
      id: asset.id,
      name: asset.name,
      referenceAssetId: root?.id ?? asset.id,
      lineage: "root",
      stateSentences: [],
      inInteraction: interactionMember(undefined, item.sourceAssetId),
    });
  }

  /**
   * Interaction participants that are NOT placed as instances still take part.
   * A composite interaction is a formal record of "these two are together in
   * this panel" — its people may be hidden (retired sprites) or never placed,
   * and the shot must still contain them, anchored on their canonical/root
   * references rather than on any previous composite.
   */
  const covered = new Set(participants.map((participant) => `${participant.kind}:${participant.id}`));
  for (const interaction of compositeInteractions) {
    for (const participant of interactionParticipants(interaction)) {
      const key = `${participant.kind === "character" ? "character" : participant.kind}:${participant.id}`;
      if (covered.has(key)) continue;
      if (participant.kind === "character") {
        const character = doc.characters[participant.id];
        const reference = resolveCharacterIdentityReference(doc, participant.id);
        if (!character || reference.status !== "resolved" || !reference.assetId) continue;
        participants.push({
          kind: "character",
          id: participant.id,
          name: character.name,
          referenceAssetId: reference.assetId,
          lineage: "canonical",
          stateSentences: [],
          inInteraction: true,
        });
      } else {
        const asset = doc.assets[participant.id];
        if (!asset) continue;
        const root = lineageRootAsset(doc, asset.id);
        participants.push({
          kind: participant.kind === "scene" ? "scene" : "object",
          id: asset.id,
          name: asset.name,
          referenceAssetId: root?.id ?? asset.id,
          lineage: "root",
          stateSentences: [],
          inInteraction: true,
        });
      }
      covered.add(key);
    }
  }
  return participants;
}

/** A character's CURRENT semantic state as prompt sentences (pose/expression/outfit). */
function characterStateSentences(doc: ProjectDocument, item: AssetInstance): string[] {
  const state = stateFromInstance(doc, item);
  if (!state) return [];
  const name = doc.characters[state.characterId]?.name ?? "The character";
  const sentences = [`${name} is ${state.pose || "standing"}, with a ${state.expression || "neutral"} expression.`];
  if (state.outfit && state.outfit !== "default outfit") sentences.push(`${name} wears ${state.outfit}, unchanged.`);
  if (state.props?.length) sentences.push(`${name} has ${state.props.join(" and ")}.`);
  return sentences;
}

/**
 * Walk an asset's provenance chain (metadata.referenceAssetIds) to its
 * original image. Camera and edit derivatives record their source there;
 * anchoring each redraw to the previous derivative compounds drift, so the
 * ROOT is the identity anchor. The hop cap keeps a corrupt document from
 * looping forever.
 */
function lineageRootAsset(doc: ProjectDocument, assetId: ID) {
  let current = doc.assets[assetId];
  for (let hops = 0; current && hops < 10; hops++) {
    // Panel camera renders list every participant as references; they are
    // viewpoints, not identities, so the walk never enters them.
    if (current.metadata?.panelCameraRender) return current;
    const parentId = current.metadata?.referenceAssetIds?.[0];
    const parent = parentId ? doc.assets[parentId] : undefined;
    if (!parent) return current;
    current = parent;
  }
  return current;
}

/* ── Plan (sync verdict behind the UI button and the service gate) ───────── */

/**
 * One judgement, two consumers: the Inspector's Generate Camera View button
 * and `applyPanelCamera`'s gate read THIS verdict, so the button can never
 * disagree with the service about whether a redraw is needed.
 */
export function planPanelCamera(
  doc: ProjectDocument,
  input: { panelId: ID; camera: PanelCamera; perspective?: PanelPerspective },
): PanelCameraPlan {
  const participants = resolvePanelVisualParticipants(doc, input.panelId);
  const decisions = [
    resolveCameraExecution({ change: "angle", camera: input.camera }),
    resolveCameraExecution({ change: "yaw", camera: input.camera }),
    resolveCameraExecution({ change: "mangaPerspective", camera: input.camera }),
    ...(input.perspective && input.perspective.type !== "none"
      ? [resolveCameraExecution({ change: "perspective", camera: input.camera })]
      : []),
    resolveCameraExecution({ change: "shot", camera: input.camera, fromShot: currentPanelShot(doc, input.panelId), toShot: input.camera.shot }),
  ];
  const verdict = decisions.find((d) => d.execution === "GENERATIVE_REDRAW");
  if (!verdict) return { requiresRedraw: false, routable: participants.length > 0, participantCount: participants.length };
  return { requiresRedraw: true, reason: verdict.reason, routable: participants.length > 0, participantCount: participants.length };
}

/**
 * How the panel's current artwork is framed, for the widening test: the active
 * camera render's own shot first, then the scene's establishing wide, then the
 * character default full-body.
 */
function currentPanelShot(doc: ProjectDocument, panelId: ID): ShotType {
  const panel = doc.panels[panelId];
  const active = panel?.activeCameraRenderAssetId ? doc.assets[panel.activeCameraRenderAssetId] : undefined;
  if (active?.metadata?.cameraShot) return active.metadata.cameraShot as ShotType;
  for (const itemId of panel?.itemIds ?? []) {
    const item = doc.items[itemId];
    if (item?.kind !== "asset") continue;
    const asset = doc.assets[item.sourceAssetId];
    if (asset?.category === "background") return (asset.metadata?.cameraShot as ShotType) ?? "wide";
  }
  return "full";
}

/* ── Generate ────────────────────────────────────────────────────────────── */

/**
 * Redraw the WHOLE panel under the requested camera as one unified picture,
 * register it as a Panel Camera Render and activate it — non-destructively.
 */
export async function applyPanelCamera(input: {
  panelId: ID;
  camera: PanelCamera;
  perspective?: PanelPerspective;
}): Promise<PanelCameraResult> {
  const doc = useEditorStore.getState().doc;
  const panel = doc?.panels[input.panelId];
  if (!doc || !panel) throw new Error("Panel not found");

  const plan = planPanelCamera(doc, input);
  if (!plan.requiresRedraw) {
    throw new Error("This camera change is achievable with the existing artwork — no generation needed.");
  }
  if (!plan.routable) {
    throw new Error("This panel has no visual participants to redraw — place a character, scene or object first.");
  }

  const participants = resolvePanelVisualParticipants(doc, input.panelId);

  /**
   * Heal stored character pointers before generating: a missing pointer while
   * the character owns a perfectly good picture is a data fault, not a creator
   * decision (same policy as the interaction path).
   */
  for (const participant of participants) {
    if (participant.kind !== "character") continue;
    const reference = resolveCharacterIdentityReference(doc, participant.id);
    if (reference.status === "resolved" && reference.needsRepair && reference.assetId) {
      useEditorStore.getState().dispatch({ type: "set-character-reference", characterId: participant.id, assetId: reference.assetId });
    }
  }

  const missing = resolveIdentityReferences(doc, participants.filter((p) => p.kind === "character").map((p) => p.id)).filter(
    (reference) => reference.status !== "resolved",
  );
  if (missing.length > 0) {
    const names = missing.map((reference) => reference.characterName);
    throw new Error(`${names.join(" and ")} ${names.length > 1 ? "need" : "needs"} a reference image before this panel can be redrawn.`);
  }

  /**
   * Reference-level merge. Identity dedupe happens per character/asset id, but
   * two DIFFERENT assets can legitimately anchor on the SAME image — a placed
   * scene original plus an interaction record pointing at its derivative, or a
   * duplicated library asset, both rooting to one picture. Sending that image
   * twice asks the model to draw one thing twice, so the participants merge
   * into one (names combined, interaction membership preserved).
   *
   * The one case that stays a hard failure: two different CHARACTERS sharing
   * a canonical image — a real identity fault the model would blend away.
   */
  const merged: PanelVisualParticipant[] = [];
  const byReference = new Map<string, PanelVisualParticipant>();
  for (const participant of participants) {
    const referenceKey = assetRenderUrl(doc.assets[participant.referenceAssetId]) ?? participant.referenceAssetId;
    const existing = byReference.get(referenceKey);
    if (!existing) {
      byReference.set(referenceKey, participant);
      merged.push(participant);
      continue;
    }
    if (existing.kind === "character" && participant.kind === "character" && existing.id !== participant.id) {
      throw new Error(
        `${existing.name} and ${participant.name} resolved to the same reference image, so their identities could not be kept apart.`,
      );
    }
    existing.name = `${existing.name} / ${participant.name}`;
    existing.inInteraction = existing.inInteraction || participant.inInteraction;
    if (!existing.instanceId && participant.instanceId) existing.instanceId = participant.instanceId;
    existing.stateSentences = [...existing.stateSentences, ...participant.stateSentences];
    byReference.set(referenceKey, existing);
  }

  /**
   * Reference budget: interaction participants first (their relationship is
   * the hardest to re-invent), then the focus subject, then the scene, then
   * remaining characters, then objects. Beyond the budget the shot still
   * generates, but the omission is recorded everywhere — never silent.
   */
  const focusInstanceId = panel.focalItemId;
  const priority = (participant: PanelVisualParticipant): number => {
    if (participant.inInteraction) return 0;
    if (participant.instanceId === focusInstanceId) return 1;
    if (participant.kind === "scene") return 2;
    if (participant.kind === "character") return 3;
    return 4;
  };
  const ordered = [...merged].sort((a, b) => priority(a) - priority(b));
  const included = ordered.slice(0, MAX_PANEL_REFERENCES);
  const omitted = ordered.slice(MAX_PANEL_REFERENCES);

  const referenceUrls = included.map((participant) => assetRenderUrl(doc.assets[participant.referenceAssetId])).filter((url): url is string => Boolean(url));
  if (referenceUrls.length !== included.length) {
    throw new Error("A participant's reference image has no usable render URL.");
  }

  const style = getStyleGenerationContext(doc);
  const aspect = panelAspectFor(panel);
  const focusParticipant = merged.find((participant) => participant.instanceId === focusInstanceId);

  // Formal interactions contribute their SEMANTICS (never their old composite).
  const compositeInteractions = Object.values(doc.interactions ?? {}).filter(
    (interaction) => interaction.panelId === input.panelId && interaction.renderMode === "composite",
  );
  const interactionConstraints = compositeInteractions.flatMap(
    (interaction) =>
      buildInteractionRenderRequest(doc, interaction, {
        styleProfileId: style.profile.id,
        outfits: Object.fromEntries(
          interaction.participantIds.map((characterId) => {
            const participant = participants.find((p) => p.kind === "character" && p.id === characterId);
            const item = participant?.instanceId ? doc.items[participant.instanceId] : undefined;
            const state = item?.kind === "asset" ? stateFromInstance(doc, item) : undefined;
            return [characterId, state?.outfit ?? "default outfit"];
          }),
        ),
      }).interactionConstraints,
  );

  const identityConstraints = included.map((participant, index) => {
    if (participant.kind === "character") {
      return `Reference image ${index + 1} is ${participant.name}: preserve their exact face, hairstyle, proportions, outfit design, outfit colors and accessories. Do not blend their features with anything else.`;
    }
    if (participant.kind === "scene") {
      return `Reference image ${index + 1} is the scene "${participant.name}": preserve its environment, architecture, layout cues, landmarks, materials and visual style — it is the same place from a new viewpoint.`;
    }
    return `Reference image ${index + 1} is the object "${participant.name}": preserve its recognizable visual identity — shape, proportions, colors, material and distinctive details. Only its orientation, perspective and partial occlusion may change.`;
  });

  const names = merged.map((participant) => String(participant.name));
  const description = `One manga panel containing ${names.join(", ")}. Every listed participant appears exactly once, occupying the same environment at a consistent scale.`;
  const prompt = [
    buildPanelShotPrompt({
      description,
      style: style.profile,
      monochrome: isMonochromeStyle(style.profile),
      aspect,
    }),
    ...identityConstraints,
    ...merged.flatMap((participant) => participant.stateSentences),
    ...interactionConstraints,
    ...(omitted.length > 0
      ? [`Also present in the panel, described in words only: ${omitted.map((p) => `${p.name} (${p.kind})`).join(", ")}.`]
      : []),
    ...(focusParticipant ? [`The composition's focal subject is ${focusParticipant.name}: framing and emphasis serve them first.`] : []),
    ...cameraContextForPanel(input.camera, input.perspective),
    // The camera is authoritative over every reference's baked-in viewpoint.
    "The camera description is authoritative: rebuild the entire panel from that single shared viewpoint — one horizon, consistent vanishing points, matching foreshortening on every participant. Do not preserve the camera orientation of any reference image. Do not merely crop, translate or scale the reference images; redraw the whole panel.",
  ].join(" ");

  const result = await generateImage({
    assetType: "background",
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: aspect,
    expectMonochrome: isMonochromeStyle(style.profile),
    referenceUrls,
  });

  const assetId = await registerGeneratedAsset({
    result,
    assetType: "background",
    // A panel shot is opaque artwork; the background category keeps it
    // compositable and out of the transparency pipeline.
    category: "background",
    name: `Panel camera · ${input.camera.angle} · ${input.camera.shot}`,
    prompt,
    metadata: {
      ...styleMetadata(style),
      panelCameraRender: true,
      panelId: input.panelId,
      sourceInstanceIds: merged.flatMap((participant) => (participant.instanceId ? [participant.instanceId] : [])),
      referenceAssetIds: included.map((participant) => participant.referenceAssetId),
      interactionIds: compositeInteractions.map((interaction) => interaction.id),
      cameraShot: input.camera.shot,
      cameraAngle: input.camera.angle,
      cameraLens: input.camera.lens,
      ...(focusParticipant ? { focusName: String(focusParticipant.name) } : {}),
      ...(omitted.length > 0 ? { omittedParticipants: omitted.map((p) => String(p.name)) } : {}),
    },
  });

  useEditorStore.getState().dispatch({ type: "set-panel-camera-render", panelId: input.panelId, assetId });

  // Runtime evidence for live acceptance (window.__kumangaGenerationLog).
  recordGenerationEvidence({
    kind: "camera-route",
    route: "panel-shot",
    panelId: input.panelId,
    camera: {
      shot: input.camera.shot,
      angle: input.camera.angle,
      lens: input.camera.lens,
      perspective: input.perspective && input.perspective.type !== "none" ? input.perspective.type : undefined,
    },
    focusSubject: focusParticipant ? String(focusParticipant.name) : undefined,
    participantCount: merged.length,
    participants: merged.map((participant) => ({
      type: participant.kind,
      instanceId: participant.instanceId,
      lineage: participant.lineage,
    })),
    referenceCount: referenceUrls.length,
    referenceSources: included.map((participant) => participant.lineage),
    ...(omitted.length > 0 ? { omittedParticipants: omitted.map((p) => String(p.name)) } : {}),
    assetId,
    generationCalls: 1,
  });

  return { route: "panel-shot", assetId, generationCalls: 1, omittedParticipants: omitted.map((p) => String(p.name)) };
}
