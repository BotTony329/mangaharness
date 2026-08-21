/**
 * Interactive pose rig: normalized joints, semantic descriptors, constraints,
 * and the Apply workflow.
 *
 * The central claims under test are that dragging joints never touches the
 * document, that a pose edit changes only the pose, and that the pose's
 * IDENTITY is its meaning rather than its pixel coordinates.
 */

import { describe, expect, it, vi } from "vitest";
import { applyDomainCommand } from "@/domain/commands";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { deserializeProject, serializeProject } from "@/domain/serialization";
import type { AssetInstance, CharacterState, ID, ProjectDocument } from "@/domain/types";
import {
  BONES,
  DRAGGABLE_JOINTS,
  JOINT_IDS,
  applyConstraints,
  createPoseRigState,
  describePoseRig,
  findPoseDefinition,
  isPoseEdited,
  jointPositionPx,
  moveJoint,
  poseDelta,
  poseRigKey,
  resetPoseRig,
  resolveJoints,
} from "./poseRig";
import { defaultCharacterState } from "./kit";
import { mergeCharacterState, stateFromInstance } from "./state";
import { resolveCharacterState, resolveInstancePatch } from "./stateResolver";
import { lineageOf, renderedStateRecords, stateDistance } from "./stateGraph";

function studio() {
  let doc = createProjectDocument("Rig3");
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
  doc = canonical.doc;
  return {
    doc,
    characterId: yuri.characterId,
    canonicalAssetId: canonical.assetId,
    panelIds: doc.pages[Object.keys(doc.pages)[0]].panelIds,
  };
}

function render(
  doc: ProjectDocument,
  characterId: ID,
  state: Partial<CharacterState>,
  lineage: { parentStateId?: ID; referenceAssetId?: ID; canonicalReferenceAssetId?: ID } = {},
) {
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
      props: full.props,
      poseRig: full.poseRig,
      parentStateId: lineage.parentStateId,
      referenceAssetIds: lineage.referenceAssetId ? [lineage.referenceAssetId] : undefined,
      canonicalReferenceAssetId: lineage.canonicalReferenceAssetId,
    },
  });
  return { doc: added.doc, assetId: added.assetId };
}

const instanceOf = (doc: ProjectDocument, id: ID) => doc.items[id] as AssetInstance;
const stateOf = (doc: ProjectDocument, id: ID) => stateFromInstance(doc, instanceOf(doc, id))!;
const nodeFor = (doc: ProjectDocument, assetId: ID) =>
  Object.values(doc.characterStates).find((record) => record.assetId === assetId);

/** Raise the right hand well above its resting position. */
const raiseRightHand = (rig = createPoseRigState("walking")) => moveJoint(rig, "handRight", { x: 0.72, y: 0.14 });

describe("normalized joints", () => {
  it("keeps every joint inside the character bounds", () => {
    const rig = moveJoint(createPoseRigState("standing"), "handRight", { x: 4.2, y: -3 });
    const joints = resolveJoints(rig);
    for (const id of JOINT_IDS) {
      expect(joints[id].x).toBeGreaterThanOrEqual(0);
      expect(joints[id].x).toBeLessThanOrEqual(1);
      expect(joints[id].y).toBeGreaterThanOrEqual(0);
      expect(joints[id].y).toBeLessThanOrEqual(1);
    }
  });

  it("survives scaling because positions are relative, not pixels", () => {
    const rig = raiseRightHand();
    const pose = { ...findPoseDefinition("walking")!, joints: resolveJoints(rig) };
    const small = jointPositionPx(pose, "handRight", { cx: 100, cy: 100, width: 100, height: 200 });
    const large = jointPositionPx(pose, "handRight", { cx: 100, cy: 100, width: 400, height: 800 });

    // Same normalized fraction of the box at both sizes.
    const smallFraction = (small.x - (100 - 50)) / 100;
    const largeFraction = (large.x - (100 - 200)) / 400;
    expect(smallFraction).toBeCloseTo(largeFraction, 6);
  });

  it("mirrors with the artwork when the instance is flipped", () => {
    const pose = findPoseDefinition("standing")!;
    const box = { cx: 100, cy: 100, width: 100, height: 200 };
    const normal = jointPositionPx(pose, "handRight", box, false);
    const flipped = jointPositionPx(pose, "handRight", box, true);
    expect(normal.x).not.toBeCloseTo(flipped.x);
    // Flip is a mirror about the box centre.
    expect((normal.x + flipped.x) / 2).toBeCloseTo(box.cx);
  });

  it("stores only the joints that actually moved", () => {
    const rig = raiseRightHand();
    expect(Object.keys(rig.joints).length).toBeGreaterThan(0);
    expect(Object.keys(rig.joints).length).toBeLessThan(JOINT_IDS.length);
    expect(rig.joints.handRight).toBeDefined();
    expect(rig.joints.footLeft).toBeUndefined();
  });

  it("draws a connected skeleton", () => {
    const reachable = new Set<string>(["torso"]);
    // Every bone endpoint is a known joint, and the skeleton is one piece.
    for (const [a, b] of BONES) {
      expect(JOINT_IDS).toContain(a);
      expect(JOINT_IDS).toContain(b);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [a, b] of BONES) {
        if (reachable.has(a) && !reachable.has(b)) {
          reachable.add(b);
          changed = true;
        }
        if (reachable.has(b) && !reachable.has(a)) {
          reachable.add(a);
          changed = true;
        }
      }
    }
    expect(reachable.size).toBe(JOINT_IDS.length);
  });

  it("exposes limbs as draggable but not the torso", () => {
    expect(DRAGGABLE_JOINTS).toContain("handRight");
    expect(DRAGGABLE_JOINTS).not.toContain("torso");
    expect(DRAGGABLE_JOINTS).not.toContain("neck");
  });
});

describe("constraints", () => {
  it("keeps an elbow from drifting off its limb", () => {
    const joints = resolveJoints(createPoseRigState("standing"));
    const broken = { ...joints, elbowRight: { x: 0.02, y: 0.98 } };
    const fixed = applyConstraints(broken);
    const midX = (fixed.shoulderRight.x + fixed.handRight.x) / 2;
    const midY = (fixed.shoulderRight.y + fixed.handRight.y) / 2;
    expect(Math.hypot(fixed.elbowRight.x - midX, fixed.elbowRight.y - midY)).toBeLessThanOrEqual(0.29);
  });

  it("leaves a naturally bent elbow alone", () => {
    const joints = resolveJoints(createPoseRigState("jumping"));
    const fixed = applyConstraints(joints);
    expect(fixed.elbowRight).toEqual(joints.elbowRight);
  });

  it("does not solve the whole chain — the dragged joint keeps its position", () => {
    const rig = moveJoint(createPoseRigState("standing"), "handRight", { x: 0.78, y: 0.12 });
    // No IK: the hand stays exactly where the creator put it.
    expect(resolveJoints(rig).handRight).toEqual({ x: 0.78, y: 0.12 });
  });
});

describe("semantic descriptors", () => {
  it("reads a raised arm", () => {
    expect(raiseRightHand().descriptors).toContain("right arm raised");
  });

  it("reads a turned head", () => {
    const rig = moveJoint(createPoseRigState("standing"), "head", { x: 0.38, y: 0.08 });
    expect(rig.descriptors).toContain("head turned left");
  });

  it("reads a lifted leg", () => {
    const rig = moveJoint(createPoseRigState("standing"), "footRight", { x: 0.57, y: 0.8 });
    expect(rig.descriptors).toContain("right leg lifted");
  });

  it("ignores movement too small to draw differently", () => {
    const rig = moveJoint(createPoseRigState("standing"), "handRight", { x: 0.685, y: 0.545 });
    expect(rig.descriptors).toHaveLength(0);
    expect(isPoseEdited(rig)).toBe(false);
  });

  it("produces a readable sentence", () => {
    const rig = moveJoint(raiseRightHand(), "head", { x: 0.4, y: 0.08 });
    const sentence = describePoseRig(rig, "walking");
    expect(sentence).toContain("Walking");
    expect(sentence).toContain("right arm raised");
    expect(sentence).toContain("head turned left");
  });

  it("reports the delta the agent and the UI both produce", () => {
    const delta = poseDelta(raiseRightHand());
    expect(delta.basePose).toBe("walking");
    expect(delta.descriptors).toContain("right arm raised");
    expect(delta.movedJoints).toContain("handRight");
  });

  it("identifies a pose by meaning, not by coordinates", () => {
    // Two different drags that both mean "right arm raised".
    const a = moveJoint(createPoseRigState("walking"), "handRight", { x: 0.72, y: 0.14 });
    const b = moveJoint(createPoseRigState("walking"), "handRight", { x: 0.7, y: 0.17 });
    expect(a.joints.handRight).not.toEqual(b.joints.handRight);
    expect(poseRigKey(a)).toBe(poseRigKey(b));
  });

  it("treats an unedited rig as no pose key at all", () => {
    expect(poseRigKey(createPoseRigState("walking"))).toBe("");
    expect(poseRigKey(undefined)).toBe("");
  });
});

describe("pose presets are a starting point", () => {
  it("switching the base preset discards an edit built on the old one", () => {
    const current: CharacterState = { ...defaultCharacterState("c1"), pose: "walking", poseRig: raiseRightHand() };
    const next = mergeCharacterState(current, { pose: "running" });
    // "Walking, right arm raised" says nothing about where the arm goes running.
    expect(next.poseRig).toBeUndefined();
    expect(next.pose).toBe("running");
  });

  it("keeps the edit when other dimensions change", () => {
    const current: CharacterState = { ...defaultCharacterState("c1"), pose: "walking", poseRig: raiseRightHand() };
    const next = mergeCharacterState(current, { expression: "shocked" });
    expect(next.poseRig?.descriptors).toContain("right arm raised");
  });

  it("reset returns to the clean preset", () => {
    const rig = resetPoseRig(raiseRightHand());
    expect(isPoseEdited(rig)).toBe(false);
    expect(rig.basePose).toBe("walking");
  });
});

describe("apply workflow", () => {
  function placed() {
    const base = studio();
    const walking = render(base.doc, base.characterId, { pose: "walking", expression: "shocked", props: ["phone"] });
    const placement = applyDomainCommand(walking.doc, {
      type: "add-instance",
      panelId: base.panelIds[0],
      assetId: walking.assetId,
    });
    const instanceId = placement.createdId!;
    const doc = applyDomainCommand(placement.doc, {
      type: "set-instance-character-state",
      instanceId,
      state: {
        ...defaultCharacterState(base.characterId),
        pose: "walking",
        expression: "shocked",
        props: ["phone"],
        assetId: walking.assetId,
      },
    }).doc;
    return { ...base, doc, instanceId, walkingAssetId: walking.assetId };
  }

  it("makes no network call while dragging", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    let rig = createPoseRigState("walking");
    for (let step = 0; step < 20; step += 1) {
      rig = moveJoint(rig, "handRight", { x: 0.7, y: 0.5 - step * 0.02 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rig.descriptors).toContain("right arm raised");
    vi.unstubAllGlobals();
  });

  it("resolves a pose edit as needing generation when it is new", () => {
    const { doc, instanceId } = placed();
    const result = resolveInstancePatch(doc, instanceId, { poseRig: raiseRightHand() })!;
    expect(result.resolution.status).toBe("needs-generation");
    if (result.resolution.status === "needs-generation") {
      // Anchored on the character's CURRENT render (§6).
      expect(result.resolution.reference.kind).toBe("nearest-state");
      expect(result.resolution.delta.changed).toContain("pose");
    }
  });

  it("reuses an exact cached pose instead of regenerating", () => {
    const base = studio();
    const rig = raiseRightHand();
    const posed = render(base.doc, base.characterId, { pose: "walking", poseRig: rig });
    const resolution = resolveCharacterState(posed.doc, {
      ...defaultCharacterState(base.characterId),
      pose: "walking",
      // A different drag with the same meaning must still hit the cache.
      poseRig: moveJoint(createPoseRigState("walking"), "handRight", { x: 0.7, y: 0.17 }),
    });
    expect(resolution.status).toBe("cached");
    if (resolution.status === "cached") expect(resolution.assetId).toBe(posed.assetId);
  });

  it("preserves expression, outfit, props, view and identity", () => {
    const { doc, instanceId, characterId } = placed();
    const before = stateOf(doc, instanceId);
    const result = resolveInstancePatch(doc, instanceId, { poseRig: raiseRightHand() })!;

    expect(result.desired.characterId).toBe(characterId);
    expect(result.desired.expression).toBe("shocked");
    expect(result.desired.outfit).toBe(before.outfit);
    expect(result.desired.view).toBe(before.view);
    expect(result.desired.props).toEqual(["phone"]);
  });

  it("preserves the panel transform and membership", () => {
    const { doc, instanceId } = placed();
    const before = instanceOf(doc, instanceId);
    const snapshot = { cx: before.cx, cy: before.cy, width: before.width, height: before.height, panelId: before.panelId };

    const next = applyDomainCommand(doc, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...stateOf(doc, instanceId), poseRig: raiseRightHand() },
    }).doc;
    const after = instanceOf(next, instanceId);
    expect({ cx: after.cx, cy: after.cy, width: after.width, height: after.height, panelId: after.panelId }).toEqual(snapshot);
  });

  it("counts a pose edit as a pose difference even on the same preset", () => {
    const base = studio();
    const plain = render(base.doc, base.characterId, { pose: "walking" });
    const record = nodeFor(plain.doc, plain.assetId)!;
    const distance = stateDistance(record, {
      ...defaultCharacterState(base.characterId),
      pose: "walking",
      poseRig: raiseRightHand(),
    });
    expect(distance.cost).toBeGreaterThan(0);
    expect(distance.changed).toContain("pose");
  });

  it("survives save and load", () => {
    const { doc, instanceId } = placed();
    const rig = raiseRightHand();
    const next = applyDomainCommand(doc, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...stateOf(doc, instanceId), poseRig: rig },
    }).doc;

    const restored = deserializeProject(serializeProject(next));
    const state = stateOf(restored, instanceId);
    expect(state.poseRig?.descriptors).toContain("right arm raised");
    expect(state.poseRig?.joints.handRight).toEqual(rig.joints.handRight);
    expect(state.expression).toBe("shocked");
  });

  it("never creates a document item for the overlay", () => {
    const { doc, instanceId, panelIds } = placed();
    const before = doc.panels[panelIds[0]].itemIds.length;
    // Dragging is pure UI state; the rig produces no item and therefore cannot
    // reach the exported page.
    const rig = moveJoint(createPoseRigState("walking"), "handRight", { x: 0.72, y: 0.14 });
    expect(isPoseEdited(rig)).toBe(true);
    expect(doc.panels[panelIds[0]].itemIds).toHaveLength(before);
    expect(Object.values(doc.items).some((item) => item.kind === "effect")).toBe(false);
    expect(instanceOf(doc, instanceId).kind).toBe("asset");
  });
});

// ─── §15 acceptance ─────────────────────────────────────────────────────────

describe("acceptance: pose the action figure", () => {
  it("raises a hand and turns the head while everything else holds", () => {
    // Start: Yuri, walking, shocked, phone in hand.
    const base = studio();
    const start = render(
      base.doc,
      base.characterId,
      { pose: "walking", expression: "shocked", props: ["phone"] },
      { canonicalReferenceAssetId: base.canonicalAssetId },
    );
    let doc = start.doc;
    const startNode = nodeFor(doc, start.assetId)!;

    // Place in Panel 1.
    const placement = applyDomainCommand(doc, {
      type: "add-instance",
      panelId: base.panelIds[0],
      assetId: start.assetId,
    });
    doc = placement.doc;
    const instanceId = placement.createdId!;
    doc = applyDomainCommand(doc, {
      type: "set-instance-character-state",
      instanceId,
      state: {
        ...defaultCharacterState(base.characterId),
        pose: "walking",
        expression: "shocked",
        props: ["phone"],
        assetId: start.assetId,
      },
    }).doc;
    const placed = instanceOf(doc, instanceId);
    const transform = { cx: placed.cx, cy: placed.cy, width: placed.width, height: placed.height };
    const beforeApply = doc;

    // Enter Edit Pose: raise the free hand, turn the head slightly left.
    let draft = createPoseRigState("walking");
    draft = moveJoint(draft, "handRight", { x: 0.72, y: 0.14 });
    draft = moveJoint(draft, "head", { x: 0.4, y: 0.08 });
    expect(draft.descriptors).toContain("right arm raised");
    expect(draft.descriptors).toContain("head turned left");

    // The draft has not touched the document.
    expect(stateOf(doc, instanceId).poseRig).toBeUndefined();

    // Apply: resolve first.
    const resolved = resolveInstancePatch(doc, instanceId, { poseRig: draft })!;
    expect(resolved.resolution.status).toBe("needs-generation");
    if (resolved.resolution.status === "needs-generation") {
      // Reference is the CURRENT rendered state (§6).
      expect(resolved.resolution.reference.assetId).toBe(start.assetId);
      expect(resolved.resolution.parentStateId).toBe(startNode.id);
      expect(resolved.resolution.delta.changed).toEqual(["pose"]);
    }

    // Simulate the generated child render landing in the library.
    const generated = render(
      doc,
      base.characterId,
      { pose: "walking", expression: "shocked", props: ["phone"], poseRig: draft },
      { parentStateId: startNode.id, referenceAssetId: start.assetId, canonicalReferenceAssetId: base.canonicalAssetId },
    );
    doc = generated.doc;
    doc = applyDomainCommand(doc, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...resolved.desired, assetId: generated.assetId },
    }).doc;
    doc = applyDomainCommand(doc, { type: "swap-instance-asset", instanceId, assetId: generated.assetId }).doc;

    // Everything except pose geometry is unchanged.
    const after = stateOf(doc, instanceId);
    const afterInstance = instanceOf(doc, instanceId);
    expect(after.characterId).toBe(base.characterId);
    expect(after.pose).toBe("walking");
    expect(after.expression).toBe("shocked");
    expect(after.props).toEqual(["phone"]);
    expect(after.outfit).toBe("default outfit");
    expect(after.view).toBe("front");
    expect(after.poseRig?.descriptors).toEqual(draft.descriptors);
    expect({ cx: afterInstance.cx, cy: afterInstance.cy, width: afterInstance.width, height: afterInstance.height }).toEqual(transform);
    expect(afterInstance.panelId).toBe(placed.panelId);

    // Lineage: a child of the starting state, anchored on identity.
    const childNode = nodeFor(doc, generated.assetId)!;
    expect(childNode.parentStateId).toBe(startNode.id);
    expect(childNode.referenceAssetId).toBe(start.assetId);
    expect(childNode.canonicalReferenceAssetId).toBe(base.canonicalAssetId);
    expect(lineageOf(doc, childNode.id)).toHaveLength(2);

    // Undo restores the previous state (commands are pure doc → doc).
    expect(stateOf(beforeApply, instanceId).poseRig).toBeUndefined();
    expect(stateOf(beforeApply, instanceId).expression).toBe("shocked");

    // Save/reload keeps the applied pose and the graph.
    const restored = deserializeProject(serializeProject(doc));
    expect(renderedStateRecords(restored, base.characterId)).toHaveLength(2);
    expect(stateOf(restored, instanceId).poseRig?.descriptors).toEqual(draft.descriptors);
    expect(nodeFor(restored, generated.assetId)!.parentStateId).toBe(startNode.id);

    // Re-applying the identical pose now hits the cache — no second generation.
    const again = resolveCharacterState(restored, {
      ...defaultCharacterState(base.characterId),
      pose: "walking",
      expression: "shocked",
      props: ["phone"],
      poseRig: draft,
    });
    expect(again.status).toBe("cached");
  });
});
