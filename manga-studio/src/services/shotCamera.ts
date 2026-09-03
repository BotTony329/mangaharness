"use client";

/**
 * Shot-level Camera Application Service (v0.3 Phase 4) — the ONE boundary the
 * UI calls when a panel camera must become artwork.
 *
 * ## Why this exists
 *
 * A camera belongs to the SHOT, not to an asset. When a panel holds an
 * interaction (Yuri hugging Mio, Mika walking down Tokyo Street), redrawing
 * each participant under the camera separately and overlaying them guarantees
 * perspective, lighting, scale and contact mismatches. This service is the
 * routing boundary that prevents it:
 *
 *   CameraResolver gate (LOCAL → zero API, always)
 *     └─ GENERATIVE → inspect the shot's FORMAL records:
 *          composite interaction → Phase 4 joint path (ONE generation for
 *                                  the whole shot, camera in cache identity)
 *          single character      → Phase 2 character camera
 *          single scene          → Phase 3 scene camera
 *
 * ## Hard rules encoded here
 *
 *   - INTERACTION > SINGLE ASSET: a formal interaction covering the target
 *     always wins over per-asset redraws.
 *   - Formal records only: routing reads doc.interactions, never "the panel
 *     happens to contain two characters". Unrelated assets are NEVER silently
 *     merged into a joint generation.
 *   - No provider access, no request assembly: those live in the routed-to
 *     services. This module only decides and delegates.
 */

import type { ID, PanelCamera, PanelPerspective, ProjectDocument, ShotType } from "@/domain/types";
import { interactionParticipants } from "@/domain/interactions";
import { stateFromInstance } from "@/characters/state";
import { useEditorStore } from "@/editor/store";
import { resolveCameraExecution } from "@/services/cameraResolver";
import { redrawCharacterForCamera } from "@/services/characterCamera";
import { redrawSceneForCamera } from "@/services/sceneCamera";
import { rerenderInteraction } from "@/services/interaction";
import { recordGenerationEvidence } from "@/services/generation";

export type ShotCameraRoute = "interaction" | "character" | "scene";

export interface ShotCameraResult {
  route: ShotCameraRoute;
  /** The interaction or instance the camera was applied to. */
  targetId: ID;
  assetId?: ID;
  reusedCache?: boolean;
  generationCalls: number;
}

export interface ShotCameraPlan {
  requiresRedraw: boolean;
  reason?: string;
  /** A redraw verdict with somewhere to go (interaction or single asset). */
  routable: boolean;
  route?: ShotCameraRoute;
}

/**
 * The SYNC verdict behind both the UI's "Generate Camera View" visibility and
 * `applyCameraToShot`'s gate — one judgement, two consumers, so the button can
 * never disagree with the service about whether a redraw is needed.
 */
export function planShotCamera(
  doc: ProjectDocument,
  input: { panelId: ID; instanceId?: ID; camera: PanelCamera; perspective?: PanelPerspective },
): ShotCameraPlan {
  const interaction = findShotInteraction(doc, input.panelId, input.instanceId);
  const target = interaction ? undefined : resolveSingleTarget(doc, input.panelId, input.instanceId);
  const fromShot = interaction
    ? currentInteractionShot(doc, interaction.id)
    : currentAssetShot(doc, target?.sourceAssetId);

  const decisions = [
    resolveCameraExecution({ change: "angle", camera: input.camera }),
    resolveCameraExecution({ change: "yaw", camera: input.camera }),
    resolveCameraExecution({ change: "mangaPerspective", camera: input.camera }),
    ...(input.perspective && input.perspective.type !== "none"
      ? [resolveCameraExecution({ change: "perspective", camera: input.camera })]
      : []),
    resolveCameraExecution({ change: "shot", camera: input.camera, fromShot, toShot: input.camera.shot }),
  ];
  const verdict = decisions.find((d) => d.execution === "GENERATIVE_REDRAW");
  if (!verdict) return { requiresRedraw: false, routable: Boolean(interaction ?? target) };
  return {
    requiresRedraw: true,
    reason: verdict.reason,
    routable: Boolean(interaction ?? target),
    route: interaction ? "interaction" : target ? (doc.assets[target.sourceAssetId]?.category === "background" ? "scene" : "character") : undefined,
  };
}

export async function applyCameraToShot(input: {
  panelId: ID;
  /** Explicitly selected instance, when the creator has one. */
  instanceId?: ID;
  camera: PanelCamera;
  perspective?: PanelPerspective;
}): Promise<ShotCameraResult> {
  const doc = useEditorStore.getState().doc;
  const panel = doc?.panels[input.panelId];
  if (!doc || !panel) throw new Error("Panel not found");

  // One resolver gate for the whole shot. LOCAL means the existing pixels
  // suffice — zero API calls no matter how the shot would route.
  const plan = planShotCamera(doc, input);
  if (!plan.requiresRedraw) {
    throw new Error("This camera change is achievable with the existing artwork — no generation needed.");
  }

  const interaction = findShotInteraction(doc, input.panelId, input.instanceId);
  // INTERACTION > SINGLE ASSET — one unified generated shot, never overlays.
  if (interaction) {
    const outcome = await rerenderInteraction(interaction.id, { camera: input.camera, perspective: input.perspective });
    // Runtime evidence: which route served a real click, with what result.
    recordGenerationEvidence({
      kind: "camera-route",
      route: "interaction",
      interactionId: interaction.id,
      assetId: outcome.assetId,
      reusedCache: outcome.reusedCache,
      generationCalls: outcome.generationCalls,
    });
    return {
      route: "interaction",
      targetId: interaction.id,
      assetId: outcome.assetId,
      reusedCache: outcome.reusedCache,
      generationCalls: outcome.generationCalls,
    };
  }

  const target = resolveSingleTarget(doc, input.panelId, input.instanceId);
  if (!target) {
    throw new Error(
      "Select the character or scene this camera should redraw — unrelated assets in one panel are never merged automatically.",
    );
  }
  const category = doc.assets[target.sourceAssetId]?.category;
  if (category === "background") {
    const result = await redrawSceneForCamera({ instanceId: target.id, camera: input.camera, perspective: input.perspective });
    recordGenerationEvidence({
      kind: "camera-route",
      route: "scene",
      instanceId: target.id,
      previousAssetId: result.previousAssetId,
      assetId: result.assetId,
      generationCalls: 1,
    });
    return { route: "scene", targetId: target.id, assetId: result.assetId, generationCalls: 1 };
  }
  if (stateFromInstance(doc, target)) {
    const result = await redrawCharacterForCamera({ instanceId: target.id, camera: input.camera });
    recordGenerationEvidence({
      kind: "camera-route",
      route: "character",
      instanceId: target.id,
      previousAssetId: result.previousAssetId,
      assetId: result.assetId,
      generationCalls: 1,
    });
    return { route: "character", targetId: target.id, assetId: result.assetId, generationCalls: 1 };
  }
  // Known limitation (v0.3): a standalone object has no single-asset camera
  // path — objects join shots through formal interactions only.
  throw new Error("A standalone object cannot be camera-redrawn on its own; create an interaction with it first.");
}

/**
 * The formal interaction this camera applies to, if any.
 *
 * Reads ONLY doc.interactions — never guesses from what happens to be placed.
 * A composite (joint-render) interaction qualifies; a synchronized puppet
 * interaction has no joint pixels to redraw, so the camera falls through to
 * the single-asset path instead of inventing a composite.
 */
function findShotInteraction(doc: ProjectDocument, panelId: ID, instanceId?: ID) {
  const panelInteractions = Object.values(doc.interactions ?? {}).filter(
    (interaction) => interaction.panelId === panelId && interaction.renderMode === "composite",
  );
  if (panelInteractions.length === 0) return undefined;

  if (instanceId) {
    const instance = doc.items[instanceId];
    if (instance?.kind === "asset") {
      const characterId = stateFromInstance(doc, instance)?.characterId ?? doc.assets[instance.sourceAssetId]?.metadata?.characterId;
      const hit = panelInteractions.find((interaction) =>
        interactionParticipants(interaction).some(
          (participant) =>
            (participant.kind === "character" && participant.id === characterId) ||
            (participant.kind !== "character" && participant.id === instance.sourceAssetId),
        ),
      );
      if (hit) return hit;
    }
  }
  // Without a selection, an unambiguous panel shot routes to its one
  // interaction; several interactions mean the creator must pick a target.
  return panelInteractions.length === 1 ? panelInteractions[0] : undefined;
}

/** Which asset instance a single-asset camera applies to: the selection, or the panel's only character/scene. */
function resolveSingleTarget(doc: ProjectDocument, panelId: ID, instanceId?: ID) {
  const items = (doc.panels[panelId]?.itemIds ?? [])
    .map((id) => doc.items[id])
    .filter((item): item is Extract<NonNullable<typeof item>, { kind: "asset" }> => item?.kind === "asset");
  if (instanceId) {
    const selected = items.find((item) => item.id === instanceId);
    if (selected) return selected;
  }
  const characters = items.filter((item) => stateFromInstance(doc, item));
  if (characters.length === 1) return characters[0];
  const scenes = items.filter((item) => doc.assets[item.sourceAssetId]?.category === "background");
  if (scenes.length === 1) return scenes[0];
  return undefined;
}

/** How the current composite was framed, for the widening test. Defaults to the scene establishing shot. */
function currentInteractionShot(doc: ProjectDocument, interactionId: ID): ShotType {
  const renders = Object.values(doc.interactionRenders ?? {}).filter((render) => render.interactionId === interactionId);
  const latest = renders[renders.length - 1];
  return (latest && doc.assets[latest.generatedAssetId]?.metadata?.cameraShot) || "wide";
}

function currentAssetShot(doc: ProjectDocument, assetId: ID | undefined): ShotType {
  if (!assetId) return "wide";
  const asset = doc.assets[assetId];
  // Default state renders are full-body for characters, wide for scenes.
  return asset?.metadata?.cameraShot ?? (asset?.category === "background" ? "wide" : "full");
}
