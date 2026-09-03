"use client";

/**
 * Generative Scene Camera (v0.3 Phase 3) — redraw the SAME environment under
 * a new viewpoint.
 *
 * ## What this is
 *
 * A thin camera application boundary over the SAME generation surface the
 * SceneryService uses (`services/generation` + `buildAssetPrompt`). It owns no
 * provider handling, no generation client and no registration architecture of
 * its own.
 *
 *   panel camera → camera sentences (domain/staging's own vocabulary)
 *                + scene identity lock
 *                + the scene's OWN image as a hard reference
 *                → generateImage(assetType "background") → opaque derivative
 *                → non-destructive panel swap
 *
 * "assetType: background" is what keeps the opaque contract intact server-side:
 * no transparency request, no white-background requirement, no background
 * removal — the same lesson v0.2's scene composites proved.
 *
 * ## What it refuses
 *
 *   - LOCAL camera work (resolver says LOCAL_TRANSFORM): throws, zero API.
 *   - Redrawing from text alone: a scene without a renderable reference would
 *     come back as a DIFFERENT street. That fails loudly instead.
 */

import type { ID, PanelCamera, PanelPerspective, ProjectDocument } from "@/domain/types";
import { cameraGenerationContext, perspectiveGenerationContext, shotGenerationContext } from "@/domain/staging";
import { panelAspectFor, resolveCameraExecution } from "@/services/cameraResolver";
import { generateImage, registerGeneratedAsset } from "@/services/generation";
import { buildAssetPrompt } from "@/ai/promptTemplates";
import { assetRenderUrl } from "@/assets/renderSource";
import { getStyleGenerationContext, isMonochromeStyle, styleMetadata } from "@/styles/generation";
import { useEditorStore } from "@/editor/store";

/**
 * Camera sentences for a scene redraw: the domain's own camera vocabulary plus
 * the one scene-specific rule — the environment's identity is locked, only the
 * viewpoint moves.
 */
export function sceneCameraContext(camera: PanelCamera, sceneName: string, perspective?: PanelPerspective): string[] {
  return [
    ...cameraGenerationContext(camera),
    ...perspectiveGenerationContext(perspective),
    ...(camera.shot !== "wide" ? [shotGenerationContext(camera.shot)] : []),
    `Preserve the identity and recognizable structure of "${sceneName}": its architecture, layout cues, landmarks, materials and visual style stay the same environment. Only the camera viewpoint changes — perspective, horizon, framing and which surfaces are visible may be reconstructed.`,
  ];
}

export interface SceneCameraRedrawResult {
  assetId: ID;
  previousAssetId: ID;
}

export async function redrawSceneForCamera(input: {
  instanceId: ID;
  camera: PanelCamera;
  /** Active perspective rig, when the panel has one (three-point etc.). */
  perspective?: PanelPerspective;
}): Promise<SceneCameraRedrawResult> {
  const doc = useEditorStore.getState().doc;
  const instance = doc?.items[input.instanceId];
  if (!doc || !instance || instance.kind !== "asset") throw new Error("Scene instance not found");
  const scene = doc.assets[instance.sourceAssetId];
  if (!scene || scene.category !== "background") throw new Error("The selected asset is not a scene");

  // Gate on the same resolver boundary every surface uses.
  const panel = doc.panels[findPanelOf(doc, input.instanceId) ?? ""];
  const decisions = [
    resolveCameraExecution({ change: "angle", camera: input.camera }),
    resolveCameraExecution({ change: "yaw", camera: input.camera }),
    resolveCameraExecution({ change: "mangaPerspective", camera: input.camera }),
    // A perspective rig (three-point convergence) is a redraw by the canonical
    // rule regardless of the camera numbers.
    ...(input.perspective && input.perspective.type !== "none"
      ? [resolveCameraExecution({ change: "perspective", camera: input.camera })]
      : []),
    resolveCameraExecution({
      change: "shot",
      camera: input.camera,
      // A scene render's own cameraShot records how it was framed; scenes
      // default to a wide establishing view of the whole environment.
      fromShot: scene.metadata?.cameraShot ?? "wide",
      toShot: input.camera.shot,
    }),
  ];
  if (!decisions.some((d) => d.execution === "GENERATIVE_REDRAW")) {
    throw new Error("This camera change is achievable with the existing artwork — no generation needed.");
  }

  // Hard reference: the scene's LINEAGE ROOT image, never a text description —
  // and never the latest camera derivative. Anchoring each redraw to the
  // previous derivative compounds drift ("street · high" → "street · high ·
  // low" was observed in production); the root is the identity anchor.
  const referenceAsset = sceneLineageRoot(doc, scene.id);
  const referenceUrl = assetRenderUrl(referenceAsset);
  if (!referenceUrl) {
    throw new Error(
      `"${scene.name}" has no usable image to anchor a camera redraw; regenerating from text alone would produce a different place.`,
    );
  }

  const style = getStyleGenerationContext(doc);
  const aspect = panelAspectFor(panel);
  const prompt = [
    buildAssetPrompt({
      assetType: "background",
      description: `Redraw the exact same environment from the reference image, seen from the requested camera viewpoint: "${scene.name}".`,
      style: style.profile,
      monochrome: isMonochromeStyle(style.profile),
      // The prompt's orientation sentence must match the size parameter —
      // "Landscape orientation, 3:2" alongside size=portrait was observed in
      // production fighting the panel's actual frame.
      aspect,
    }),
    ...sceneCameraContext(input.camera, scene.name, input.perspective),
  ].join(" ");

  const result = await generateImage({
    assetType: "background",
    prompt,
    negativePrompt: style.profile.negativePrompt,
    size: aspect,
    expectMonochrome: isMonochromeStyle(style.profile),
    referenceUrls: [referenceUrl],
  });

  const assetId = await registerGeneratedAsset({
    result,
    assetType: "background",
    category: "background",
    name: `${scene.name} · ${input.camera.angle} · ${input.camera.shot}`,
    prompt,
    metadata: {
      referenceAssetIds: [scene.id],
      cameraShot: input.camera.shot,
      cameraAngle: input.camera.angle,
      cameraLens: input.camera.lens,
      ...styleMetadata(style),
    },
  });

  // Non-destructive: the original scene asset stays in the library; the panel
  // instance points at the derivative, and undo restores the swap.
  useEditorStore.getState().dispatch({ type: "swap-instance-asset", instanceId: input.instanceId, assetId });
  return { assetId, previousAssetId: instance.sourceAssetId };
}

/** Which panel currently hosts this instance, if any. */
function findPanelOf(doc: { panels: Record<string, { itemIds: ID[] }> }, instanceId: ID): ID | undefined {
  return Object.keys(doc.panels).find((panelId) => doc.panels[panelId].itemIds.includes(instanceId));
}

/**
 * Walk a scene asset's provenance chain (metadata.referenceAssetIds) to its
 * original image. Camera derivatives record their source scene there; the
 * chain is short and acyclic by construction, but the hop cap keeps a corrupt
 * document from looping forever.
 */
function sceneLineageRoot(doc: ProjectDocument, assetId: ID) {
  let current = doc.assets[assetId];
  for (let hops = 0; current && hops < 10; hops++) {
    const parentId = current.metadata?.referenceAssetIds?.[0];
    const parent = parentId ? doc.assets[parentId] : undefined;
    if (!parent || parent.category !== "background") return current;
    current = parent;
  }
  return current;
}
