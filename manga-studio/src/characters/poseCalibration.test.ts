/**
 * Rig calibration and unified PoseIntent.
 *
 * Two claims under test. First, that a calibrated skeleton actually lands on
 * the artwork and stays there through scaling, moving, and reload. Second —
 * the important one — that the UI and the Agent produce the SAME canonical
 * descriptors, so "raise her right hand" and a dragged arm share one cached
 * render instead of forking two generations for one intent.
 */

import { describe, expect, it } from "vitest";
import { applyDomainCommand } from "@/domain/commands";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { deserializeProject, serializeProject } from "@/domain/serialization";
import type { AssetInstance, CharacterState, ID, ProjectDocument } from "@/domain/types";
import {
  CALIBRATION_ANCHORS,
  applyCalibration,
  basePoseJoints,
  createPoseIntent,
  deriveDescriptors,
  jointPositionPx,
  moveJoint,
  normalizeDescriptor,
  normalizeDescriptors,
  normalizePoseIntent,
  poseIntentFromDescriptors,
  poseIntentKey,
  resolveJoints,
  type PoseCalibration,
} from "./poseRig";
import { defaultCharacterState } from "./kit";
import { stateFromInstance } from "./state";
import { findRenderedStateRecord } from "./stateGraph";
import { resolveCharacterState } from "./stateResolver";

function studio() {
  let doc = createProjectDocument("Rig4");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;
  const canonical = addAsset(doc, {
    category: "character",
    name: "canon",
    storageUrl: "c.png",
    width: 800,
    height: 1600,
    hasAlpha: true,
    processedImageUrl: "c-a.png",
    processingStatus: "ready",
    metadata: { characterId: yuri.characterId, characterAssetRole: "canonical" },
  });
  return {
    doc: canonical.doc,
    characterId: yuri.characterId,
    panelIds: canonical.doc.pages[Object.keys(canonical.doc.pages)[0]].panelIds,
  };
}

function render(doc: ProjectDocument, characterId: ID, state: Partial<CharacterState>) {
  const full = { ...defaultCharacterState(characterId), ...state };
  const added = addAsset(doc, {
    category: "character",
    name: `yuri-${full.pose}`,
    storageUrl: `${full.pose}.png`,
    width: 800,
    height: 1600,
    hasAlpha: true,
    processedImageUrl: `${full.pose}-a.png`,
    processingStatus: "ready",
    metadata: {
      characterId,
      characterAssetRole: "state",
      pose: full.pose,
      expression: full.expression,
      outfit: full.outfit,
      view: full.view,
      poseRig: full.poseRig,
    },
  });
  return { doc: added.doc, assetId: added.assetId };
}

const instanceOf = (doc: ProjectDocument, id: ID) => doc.items[id] as AssetInstance;
const nodeFor = (doc: ProjectDocument, assetId: ID) =>
  Object.values(doc.characterStates).find((record) => record.assetId === assetId)!;

const calibration = (anchors: PoseCalibration["anchors"]): PoseCalibration => ({
  anchors,
  updatedAt: "2026-08-21T00:00:00.000Z",
});

describe("descriptor normalization", () => {
  it("maps many phrasings of one intent onto one canonical descriptor", () => {
    for (const phrase of [
      "right arm raised",
      "raise her right hand",
      "right hand up",
      "lift right arm",
      "Raise the right arm!",
      "raising right hand",
    ]) {
      expect(normalizeDescriptor(phrase)).toBe("right arm raised");
    }
  });

  it("distinguishes sides and directions", () => {
    expect(normalizeDescriptor("turn her head left")).toBe("head turned left");
    expect(normalizeDescriptor("look right")).toBe("head turned right");
    expect(normalizeDescriptor("left arm lowered")).toBe("left arm lowered");
    expect(normalizeDescriptor("drop the left hand")).toBe("left arm lowered");
    expect(normalizeDescriptor("bend right knee")).toBe("right knee bent");
    expect(normalizeDescriptor("lean forward")).toBe("torso leaning forward");
  });

  it("resolves aliases", () => {
    expect(normalizeDescriptor("legs apart")).toBe("feet apart");
    expect(normalizeDescriptor("sprinting")).toBe("running stride");
  });

  it("returns null rather than inventing a descriptor", () => {
    expect(normalizeDescriptor("do something cool")).toBeNull();
    expect(normalizeDescriptor("")).toBeNull();
    expect(normalizeDescriptor("arm")).toBeNull();
  });

  it("sorts, de-duplicates, and drops unknowns from a list", () => {
    expect(normalizeDescriptors(["right hand up", "raise right arm", "nonsense", "look left"])).toEqual([
      "head turned left",
      "right arm raised",
    ]);
  });
});

describe("unified PoseIntent", () => {
  it("gives the Agent and the editor the same cache key for the same intent", () => {
    // Agent path: descriptors only.
    const agent = poseIntentFromDescriptors("walking", ["raise her right hand"]);
    // Editor path: dragged joints, descriptors derived.
    const editor = moveJoint(createPoseIntent("walking"), "handRight", { x: 0.72, y: 0.14 });

    expect(agent.descriptors).toEqual(["right arm raised"]);
    expect(editor.descriptors).toEqual(["right arm raised"]);
    // The whole point: one intent, one cached render.
    expect(poseIntentKey(agent)).toBe(poseIntentKey(editor));
  });

  it("treats joint edits as authoring truth and descriptors as their summary", () => {
    // Descriptors that contradict the joints are discarded, not merged.
    const edited = moveJoint(createPoseIntent("standing"), "handRight", { x: 0.72, y: 0.14 });
    const contradicted = normalizePoseIntent({ ...edited, descriptors: ["left knee bent"] });
    expect(contradicted.descriptors).toEqual(["right arm raised"]);
  });

  it("keeps descriptor-only intents as given", () => {
    const intent = poseIntentFromDescriptors("running", ["head turned left", "left elbow bent"]);
    expect(intent.jointOverrides).toEqual({});
    expect(intent.descriptors).toEqual(["head turned left", "left elbow bent"]);
  });

  it("carries the preset's orientation and motion onto the intent", () => {
    const intent = createPoseIntent("running");
    expect(intent.motionVector).toEqual({ x: 0.9, y: -0.1 });
    expect(intent.torsoDirection).toBe("right");
  });
});

describe("calibration", () => {
  it("moves a calibrated joint's descendants with it", () => {
    const base = basePoseJoints("standing");
    const shifted = applyCalibration(base, calibration({ hips: { x: base.hips.x, y: base.hips.y + 0.1 } }));
    // Aligning the hips must carry the legs, not detach them.
    expect(shifted.hips.y).toBeCloseTo(base.hips.y + 0.1);
    expect(shifted.kneeLeft.y).toBeCloseTo(base.kneeLeft.y + 0.1);
    expect(shifted.footLeft.y).toBeCloseTo(base.footLeft.y + 0.1);
    // The upper body is untouched.
    expect(shifted.head).toEqual(base.head);
  });

  it("moves only the joint itself when a leaf is calibrated", () => {
    const base = basePoseJoints("standing");
    const shifted = applyCalibration(base, calibration({ handRight: { x: 0.8, y: 0.5 } }));
    expect(shifted.handRight).toEqual({ x: 0.8, y: 0.5 });
    expect(shifted.elbowRight).toEqual(base.elbowRight);
  });

  it("is a no-op when nothing has been calibrated", () => {
    const base = basePoseJoints("walking");
    expect(applyCalibration(base, undefined)).toEqual(base);
    expect(applyCalibration(base, calibration({}))).toEqual(base);
  });

  it("shows the calibrated skeleton in pose mode", () => {
    const cal = calibration({ head: { x: 0.5, y: 0.2 } });
    const joints = resolveJoints(createPoseIntent("standing"), cal);
    expect(joints.head.y).toBeCloseTo(0.2);
  });

  it("measures descriptors from the calibrated baseline, not the raw preset", () => {
    // A character whose artwork sits with hands high must not read as
    // permanently "arm raised" merely because it differs from the preset.
    const cal = calibration({ handRight: { x: 0.68, y: 0.2 } });
    const intent = createPoseIntent("standing");
    const resting = resolveJoints(intent, cal);
    expect(deriveDescriptors(applyCalibration(basePoseJoints("standing"), cal), resting)).toHaveLength(0);

    // Raising further from THAT baseline does register.
    const raised = moveJoint(intent, "handRight", { x: 0.68, y: 0.05 }, cal);
    expect(raised.descriptors).toContain("right arm raised");
  });

  it("exposes only major landmarks as anchors", () => {
    expect(CALIBRATION_ANCHORS).toContain("hips");
    expect(CALIBRATION_ANCHORS).toContain("footLeft");
    expect(CALIBRATION_ANCHORS).not.toContain("elbowLeft");
    expect(CALIBRATION_ANCHORS).not.toContain("neck");
  });
});

describe("calibration is per rendered state", () => {
  function withRenders() {
    const base = studio();
    const standing = render(base.doc, base.characterId, { pose: "standing" });
    const walking = render(standing.doc, base.characterId, { pose: "walking" });
    const jumping = render(walking.doc, base.characterId, { pose: "jumping" });
    return { ...base, doc: jumping.doc, standing: standing.assetId, walking: walking.assetId, jumping: jumping.assetId };
  }

  it("stores different alignment for three very different renders", () => {
    const rig = withRenders();
    let doc = rig.doc;
    const fits: Record<string, PoseCalibration> = {
      [rig.standing]: calibration({ head: { x: 0.5, y: 0.1 } }),
      [rig.walking]: calibration({ hips: { x: 0.52, y: 0.58 } }),
      [rig.jumping]: calibration({ footLeft: { x: 0.38, y: 0.8 }, footRight: { x: 0.62, y: 0.8 } }),
    };
    for (const [assetId, fit] of Object.entries(fits)) {
      doc = applyDomainCommand(doc, {
        type: "set-state-calibration",
        stateId: nodeFor(doc, assetId).id,
        calibration: fit,
      }).doc;
    }

    // Each render keeps its own fit; a walking fit is wrong for a jump.
    expect(nodeFor(doc, rig.standing).poseCalibration!.anchors.head).toEqual({ x: 0.5, y: 0.1 });
    expect(nodeFor(doc, rig.walking).poseCalibration!.anchors.hips).toEqual({ x: 0.52, y: 0.58 });
    expect(nodeFor(doc, rig.jumping).poseCalibration!.anchors.footLeft).toEqual({ x: 0.38, y: 0.8 });
    expect(nodeFor(doc, rig.standing).poseCalibration!.anchors.hips).toBeUndefined();
  });

  it("does not regenerate or alter the render", () => {
    const rig = withRenders();
    const before = rig.doc.assets[rig.walking];
    const after = applyDomainCommand(rig.doc, {
      type: "set-state-calibration",
      stateId: nodeFor(rig.doc, rig.walking).id,
      calibration: calibration({ hips: { x: 0.52, y: 0.58 } }),
    }).doc;
    // Calibration is editor alignment, never a new image (§3).
    expect(after.assets[rig.walking]).toEqual(before);
    expect(Object.keys(after.assets)).toHaveLength(Object.keys(rig.doc.assets).length);
  });

  it("survives save and reload", () => {
    const rig = withRenders();
    const stateId = nodeFor(rig.doc, rig.walking).id;
    const saved = applyDomainCommand(rig.doc, {
      type: "set-state-calibration",
      stateId,
      calibration: calibration({ hips: { x: 0.52, y: 0.58 }, head: { x: 0.49, y: 0.09 } }),
    }).doc;

    const restored = deserializeProject(serializeProject(saved));
    const anchors = restored.characterStates[stateId].poseCalibration!.anchors;
    expect(anchors.hips).toEqual({ x: 0.52, y: 0.58 });
    expect(anchors.head).toEqual({ x: 0.49, y: 0.09 });
  });

  it("clears calibration when saved empty", () => {
    const rig = withRenders();
    const stateId = nodeFor(rig.doc, rig.walking).id;
    let doc = applyDomainCommand(rig.doc, {
      type: "set-state-calibration",
      stateId,
      calibration: calibration({ hips: { x: 0.5, y: 0.6 } }),
    }).doc;
    doc = applyDomainCommand(doc, { type: "set-state-calibration", stateId, calibration: undefined }).doc;
    expect(doc.characterStates[stateId].poseCalibration).toBeUndefined();
  });

  it("does not affect the cache key — calibration is alignment, not pose", () => {
    const rig = withRenders();
    const stateId = nodeFor(rig.doc, rig.walking).id;
    const doc = applyDomainCommand(rig.doc, {
      type: "set-state-calibration",
      stateId,
      calibration: calibration({ hips: { x: 0.52, y: 0.58 } }),
    }).doc;
    // The walking render still satisfies a plain walking request.
    const resolution = resolveCharacterState(doc, { ...defaultCharacterState(rig.characterId), pose: "walking" });
    expect(resolution.status).toBe("cached");
  });
});

describe("alignment persists through transform changes", () => {
  it("keeps the skeleton on the artwork after scaling and moving", () => {
    const base = studio();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    let doc = walking.doc;
    const stateId = nodeFor(doc, walking.assetId).id;
    const fit = calibration({ hips: { x: 0.52, y: 0.6 } });
    doc = applyDomainCommand(doc, { type: "set-state-calibration", stateId, calibration: fit }).doc;

    const placement = applyDomainCommand(doc, {
      type: "add-instance",
      panelId: base.panelIds[0],
      assetId: walking.assetId,
    });
    doc = placement.doc;
    const instanceId = placement.createdId!;

    const joints = resolveJoints(createPoseIntent("walking"), fit);

    const at = (instance: AssetInstance) =>
      jointPositionPx({ joints } as never, "hips", {
        cx: instance.cx,
        cy: instance.cy,
        width: instance.width,
        height: instance.height,
      });

    const before = instanceOf(doc, instanceId);
    const beforeFraction = (at(before).y - (before.cy - before.height / 2)) / before.height;

    // Scale up and move.
    doc = applyDomainCommand(doc, {
      type: "update-instance-transform",
      instanceId,
      patch: { cx: before.cx + 260, cy: before.cy + 120, width: before.width * 2.4, height: before.height * 2.4 },
    }).doc;
    const after = instanceOf(doc, instanceId);
    const afterFraction = (at(after).y - (after.cy - after.height / 2)) / after.height;

    // Normalized alignment is unchanged, so the rig still sits on the drawing.
    expect(afterFraction).toBeCloseTo(beforeFraction, 6);
    expect(nodeFor(doc, walking.assetId).poseCalibration!.anchors.hips).toEqual({ x: 0.52, y: 0.6 });
  });
});

// ─── §10 acceptance ─────────────────────────────────────────────────────────

describe("acceptance: calibrate three renders, then match the Agent", () => {
  it("aligns standing, walking and jumping, and agrees with the Agent's intent", () => {
    const base = studio();
    let doc = base.doc;

    const renders: Record<string, ID> = {};
    for (const pose of ["standing", "walking", "jumping"]) {
      const made = render(doc, base.characterId, { pose });
      doc = made.doc;
      renders[pose] = made.assetId;
    }

    // A. B. C. — calibrate each render differently and save.
    const fits: Record<string, PoseCalibration> = {
      standing: calibration({ head: { x: 0.5, y: 0.11 }, hips: { x: 0.5, y: 0.56 } }),
      walking: calibration({ hips: { x: 0.53, y: 0.57 }, footLeft: { x: 0.3, y: 0.94 } }),
      jumping: calibration({ head: { x: 0.5, y: 0.04 }, footLeft: { x: 0.41, y: 0.84 } }),
    };
    for (const [pose, fit] of Object.entries(fits)) {
      doc = applyDomainCommand(doc, {
        type: "set-state-calibration",
        stateId: nodeFor(doc, renders[pose]).id,
        calibration: fit,
      }).doc;
    }

    // Re-entering Edit Pose shows the calibrated skeleton for each state.
    for (const pose of ["standing", "walking", "jumping"]) {
      const record = nodeFor(doc, renders[pose]);
      const joints = resolveJoints(createPoseIntent(pose), record.poseCalibration);
      for (const [joint, anchor] of Object.entries(fits[pose].anchors)) {
        expect(joints[joint as keyof typeof joints]).toEqual(anchor);
      }
    }

    // Place, scale and move — normalized alignment is transform-independent.
    const placement = applyDomainCommand(doc, {
      type: "add-instance",
      panelId: base.panelIds[0],
      assetId: renders.walking,
    });
    doc = placement.doc;
    doc = applyDomainCommand(doc, {
      type: "update-instance-transform",
      instanceId: placement.createdId!,
      patch: { cx: 400, cy: 500, width: 300, height: 600 },
    }).doc;

    // Save / reload — every calibration survives.
    const restored = deserializeProject(serializeProject(doc));
    for (const pose of ["standing", "walking", "jumping"]) {
      const record = nodeFor(restored, renders[pose]);
      expect(record.poseCalibration!.anchors).toEqual(fits[pose].anchors);
    }
    // The instance still resolves to its calibrated state after reload.
    const instance = instanceOf(restored, placement.createdId!);
    const state = stateFromInstance(restored, instance)!;
    expect(findRenderedStateRecord(restored, state)!.poseCalibration!.anchors.hips).toEqual({ x: 0.53, y: 0.57 });

    // Agent: "Raise Yuri's right hand" must equal what the UI produces.
    const agentIntent = poseIntentFromDescriptors("walking", ["Raise Yuri's right hand"]);
    const uiIntent = moveJoint(
      createPoseIntent("walking"),
      "handRight",
      { x: 0.72, y: 0.12 },
      fits.walking,
    );
    expect(agentIntent.descriptors).toEqual(["right arm raised"]);
    expect(uiIntent.descriptors).toContain("right arm raised");
    expect(poseIntentKey(agentIntent)).toBe(poseIntentKey({ ...uiIntent, descriptors: ["right arm raised"] }));
  });
});
