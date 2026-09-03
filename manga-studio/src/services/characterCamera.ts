"use client";

/**
 * Generative Character Camera (v0.3 Phase 2) — redraw the SAME character state
 * under a new viewpoint.
 *
 * ## What this is
 *
 * A thin application service over the existing character state runtime. It
 * owns NO generation logic of its own: reference selection, identity locking,
 * prompt assembly, provider call, asset registration and the panel swap all
 * stay in `characters/stateRuntime`. The only thing added here is the camera:
 *
 *   panel camera → camera sentences (domain/staging's own vocabulary)
 *                + shot framing
 *                + an explicit identity+outfit lock (v0.2 discipline)
 *                → applyCharacterStateToInstance(forceRegenerate)
 *
 * ## What it refuses
 *
 *   - LOCAL camera work. If the CameraResolver says LOCAL_TRANSFORM, calling
 *     this service is a bug — it throws rather than burning an API call.
 *   - Redrawing with no identity anchor. A camera redraw without a usable
 *     canonical/current reference would invent a new person; that fails loudly.
 */

import type { ID, PanelCamera } from "@/domain/types";
import { cameraGenerationContext, shotGenerationContext } from "@/domain/staging";
import { resolveCameraExecution } from "@/services/cameraResolver";
import { resolveCharacterIdentityReference } from "@/characters/identityReference";
import { stateFromInstance } from "@/characters/state";
import { applyCharacterStateToInstance } from "@/characters/stateRuntime";
import { useEditorStore } from "@/editor/store";

/**
 * The camera sentences for a character redraw. Uses ONLY the domain's existing
 * generation vocabulary — no second photography dictionary.
 */
export function characterCameraContext(camera: PanelCamera, characterName: string): string[] {
  const lines = [
    ...cameraGenerationContext(camera),
    // The default state render is full-body; any tighter shot needs its framing
    // stated explicitly or the model draws head-to-feet anyway.
    ...(camera.shot !== "full" ? [shotGenerationContext(camera.shot)] : []),
    // v0.2 fidelity discipline, restated for viewpoint changes: the camera may
    // move, the person may not.
    `${characterName}'s identity and outfit are locked: keep the exact face, hairstyle, hair color, body proportions, outfit design, outfit colors, clothing patterns, accessories and shoes from the reference image. Only the camera viewpoint changes — foreshortening, visible surfaces and lighting may adapt to it.`,
  ];
  return lines;
}

export interface CharacterCameraRedrawResult {
  assetId: ID;
  previousAssetId: ID;
  source: "cache" | "generated";
}

/**
 * Redraw the character in an instance under the panel's camera.
 *
 * Non-destructive by construction: the swap-instance-asset command keeps the
 * previous state asset in the library and in undo history.
 */
export async function redrawCharacterForCamera(input: {
  instanceId: ID;
  camera: PanelCamera;
}): Promise<CharacterCameraRedrawResult> {
  const doc = useEditorStore.getState().doc;
  const instance = doc?.items[input.instanceId];
  if (!doc || !instance || instance.kind !== "asset") throw new Error("Character instance not found");
  const state = stateFromInstance(doc, instance);
  if (!state) throw new Error("The selected asset is not a character");

  const decision = resolveCameraExecution({ change: "angle", camera: input.camera });
  const yawDecision = resolveCameraExecution({ change: "yaw", camera: input.camera });
  const perspectiveDecision = resolveCameraExecution({ change: "mangaPerspective", camera: input.camera });
  // Shot widening: the current render's own cameraShot (default state renders
  // are full-body) tells us whether the target frame exists in the pixels.
  const currentShot = doc.assets[instance.sourceAssetId]?.metadata?.cameraShot ?? "full";
  const shotDecision = resolveCameraExecution({
    change: "shot",
    camera: input.camera,
    fromShot: currentShot,
    toShot: input.camera.shot,
  });
  const generative = [decision, yawDecision, perspectiveDecision, shotDecision].some(
    (d) => d.execution === "GENERATIVE_REDRAW",
  );
  if (!generative) {
    throw new Error("This camera change is achievable with the existing artwork — no generation needed.");
  }

  const characterName = doc.characters[state.characterId]?.name ?? state.characterId;
  const identity = resolveCharacterIdentityReference(doc, state.characterId);
  if (identity.status !== "resolved") {
    throw new Error(
      `${characterName} has no usable identity reference, so a camera redraw would invent a new person. Generate a reference first.`,
    );
  }

  const result = await applyCharacterStateToInstance({
    instanceId: input.instanceId,
    // The state itself does not change — same pose, expression, outfit. Only
    // the viewpoint does, so the patch is empty and the redraw is forced.
    patch: {},
    forceRegenerate: true,
    camera: input.camera,
    cameraContext: characterCameraContext(input.camera, characterName),
    // Anchor on the canonical full-body identity: a viewpoint redraw (and a
    // widening shot in particular) needs the whole person, not the current
    // crop of them.
    referenceOverride: { kind: "canonical" },
  });
  return { assetId: result.assetId, previousAssetId: result.previousAssetId, source: result.source };
}
