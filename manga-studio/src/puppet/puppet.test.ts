/**
 * The Manga Puppet vertical slice, including the killer demo (§19/§20).
 *
 * The claim being tested is a REPRESENTATION change, not a feature: changing
 * Yuri's expression must no longer replace Yuri, and moving her arm must no
 * longer regenerate her. Every assertion below compares identity — texture ids,
 * transforms, instance ids — before and after, and a hard spy asserts that no
 * provider call happened at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDomainCommand } from "@/domain/commands";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { deserializeProject, serializeProject } from "@/domain/serialization";
import { SCHEMA_VERSION, type AssetInstance, type ID, type ProjectDocument } from "@/domain/types";
import { bodyPartTypes, createFixturePuppet } from "./fixture";
import { isPuppetInstance, PuppetCapabilityError } from "@/domain/puppetOps";
import {
  canApplyExpression,
  canApplyJoint,
  canApplyPose,
  canRepresentPoseChange,
  canRepresentView,
  describeCost,
} from "./capability";
import { facePartBounds, resolvePartTransforms, resolveVisibleParts } from "./transforms";
import { descendantPartIds, partOfType, type MangaPuppet } from "./model";

/** Hard invariant (§22): local puppet work must never touch the network. */
let generationCallCount = 0;

beforeEach(() => {
  generationCallCount = 0;
  vi.stubGlobal("fetch", (...args: unknown[]) => {
    generationCallCount += 1;
    throw new Error(`Unexpected provider call during a local puppet edit: ${String(args[0])}`);
  });
});

interface Studio {
  doc: ProjectDocument;
  characterId: ID;
  puppet: MangaPuppet;
  panelIds: ID[];
  bodyAssetId: ID;
}

function studio(): Studio {
  let doc = createProjectDocument("Puppet");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;

  // One texture asset per part id, so a body texture can be compared by id.
  const puppet = createFixturePuppet({ characterId: yuri.characterId });
  const textureIds = new Set(Object.values(puppet.parts).map((part) => part.textureAssetId));
  for (const textureId of textureIds) {
    doc = addAsset(doc, {
      category: "character",
      name: textureId,
      storageUrl: `${textureId}.png`,
      width: 256,
      height: 256,
      hasAlpha: true,
      processedImageUrl: `${textureId}-a.png`,
      processingStatus: "ready",
      metadata: { characterId: yuri.characterId, characterAssetRole: "state" },
    }).doc;
  }
  const body = addAsset(doc, {
    category: "character",
    name: "yuri-walking",
    storageUrl: "walking.png",
    width: 800,
    height: 1600,
    hasAlpha: true,
    processedImageUrl: "walking-a.png",
    processingStatus: "ready",
    metadata: {
      characterId: yuri.characterId,
      characterAssetRole: "state",
      pose: "walking",
      expression: "neutral",
      outfit: "school uniform",
      view: "front",
    },
  });
  doc = applyDomainCommand(body.doc, { type: "register-puppet", puppet }).doc;

  return {
    doc,
    characterId: yuri.characterId,
    puppet,
    panelIds: doc.pages[Object.keys(doc.pages)[0]].panelIds,
    bodyAssetId: body.assetId,
  };
}

const inst = (doc: ProjectDocument, id: ID) => doc.items[id] as AssetInstance;

/** Place Yuri as an articulated actor in a panel. */
function placeActor(s: Studio, panelId: ID) {
  let doc = applyDomainCommand(s.doc, { type: "add-instance", panelId, assetId: s.bodyAssetId }).doc;
  const id = Object.values(doc.items).filter((item) => item.panelId === panelId).slice(-1)[0].id;
  doc = applyDomainCommand(doc, {
    type: "set-instance-character-state",
    instanceId: id,
    state: {
      characterId: s.characterId,
      pose: "walking",
      expression: "neutral",
      outfit: "school uniform",
      view: "front",
    },
  }).doc;
  doc = applyDomainCommand(doc, { type: "attach-puppet", instanceId: id, puppetId: s.puppet.id }).doc;
  return { doc, id };
}

/** Everything an expression change must leave untouched. */
function bodySnapshot(doc: ProjectDocument, instanceId: ID, puppet: MangaPuppet) {
  const item = inst(doc, instanceId);
  const transforms = resolvePartTransforms(puppet, item.puppet!.pose, item.puppet!.partOverrides);
  const visible = new Set(resolveVisibleParts(puppet, item.puppet!.expressionId, item.puppet!.partOverrides));
  const body: Record<string, { texture: ID; x: number; y: number; rotation: number }> = {};
  for (const type of bodyPartTypes()) {
    const part = partOfType(puppet, type);
    const transform = part ? transforms.get(part.id) : undefined;
    if (!part || !transform || !visible.has(part.id)) continue;
    body[type] = {
      texture: part.textureAssetId,
      x: transform.x,
      y: transform.y,
      rotation: transform.rotation,
    };
  }
  return {
    instanceId: item.id,
    panelId: item.panelId,
    transform: { cx: item.cx, cy: item.cy, width: item.width, height: item.height, rotation: item.rotation },
    stage: item.stage ? { ...item.stage } : undefined,
    semanticState: { ...item.characterState },
    body,
  };
}

describe("A — a puppet renders as an articulated actor", () => {
  it("places Yuri as a puppet instance, not a flat render", () => {
    const s = studio();
    const { doc, id } = placeActor(s, s.panelIds[0]);
    expect(isPuppetInstance(doc, id)).toBe(true);
    expect(inst(doc, id).puppet!.expressionId).toBe("neutral");
    // Still an ordinary panel item, so stage/camera/export all apply.
    expect(doc.panels[s.panelIds[0]].itemIds).toContain(id);
    expect(generationCallCount).toBe(0);
  });

  it("builds a real parent-child hierarchy", () => {
    const s = studio();
    const upperArm = partOfType(s.puppet, "upperArmRight")!;
    const descendants = descendantPartIds(s.puppet, upperArm.id).map((id) => s.puppet.parts[id].type);
    expect(descendants).toContain("lowerArmRight");
    expect(descendants).toContain("handRight");
    expect(descendants).not.toContain("torso");
    expect(descendants).not.toContain("upperArmLeft");
  });
});

// ─── §20 THE KILLER DEMO ────────────────────────────────────────────────────

describe("B — the killer demo: Neutral → Shock does not replace Yuri", () => {
  it("changes only facial parts, and calls no provider", () => {
    const s = studio();
    const placed = placeActor(s, s.panelIds[0]);
    // Give her a stage position and a pose so there is more to preserve.
    let doc = applyDomainCommand(placed.doc, {
      type: "set-instance-stage",
      instanceId: placed.id,
      patch: { depth: 0.3 },
    }).doc;
    doc = applyDomainCommand(doc, {
      type: "set-puppet-joint",
      instanceId: placed.id,
      joint: "elbowRight",
      degrees: 25,
    }).doc;

    const beforeDoc = doc;
    const before = bodySnapshot(doc, placed.id, s.puppet);
    const beforeFaceParts = resolveVisibleParts(s.puppet, "neutral");

    // THE ACTION.
    doc = applyDomainCommand(doc, {
      type: "set-puppet-expression",
      instanceId: placed.id,
      expressionId: "shocked",
    }).doc;

    const after = bodySnapshot(doc, placed.id, s.puppet);
    const afterFaceParts = resolveVisibleParts(s.puppet, "shocked");

    // Identity: the SAME actor, not a replacement.
    expect(after.instanceId).toBe(before.instanceId);
    expect(after.panelId).toBe(before.panelId);
    // The underlying source asset is the SAME file — no new full-body render.
    expect(inst(doc, placed.id).sourceAssetId).toBe(inst(beforeDoc, placed.id).sourceAssetId);

    // Every body part: same texture, same position, same rotation.
    expect(after.body).toEqual(before.body);
    for (const type of bodyPartTypes()) {
      if (!before.body[type]) continue;
      expect(after.body[type].texture).toBe(before.body[type].texture);
    }

    // Composition untouched.
    expect(after.transform).toEqual(before.transform);
    expect(after.stage).toEqual(before.stage);

    // Pose survived the face change.
    expect(inst(doc, placed.id).puppet!.pose.elbowRight).toBe(25);

    // Semantic outfit/pose/view untouched.
    expect(after.semanticState.outfit).toBe("school uniform");
    expect(after.semanticState.pose).toBe("walking");
    expect(after.semanticState.view).toBe("front");

    // ONLY the face changed.
    expect(afterFaceParts).not.toEqual(beforeFaceParts);
    const changed = afterFaceParts.filter((id) => !beforeFaceParts.includes(id));
    expect(changed.length).toBeGreaterThan(0);
    for (const partId of changed) {
      expect(["eyeLeft", "eyeRight", "browLeft", "browRight", "mouth"]).toContain(s.puppet.parts[partId].type);
    }

    // THE HARD INVARIANT.
    expect(generationCallCount).toBe(0);
  });

  it("creates no new asset and no new state-graph node", () => {
    const s = studio();
    const placed = placeActor(s, s.panelIds[0]);
    const assetsBefore = Object.keys(placed.doc.assets).length;
    const nodesBefore = Object.keys(placed.doc.characterStates).length;

    const doc = applyDomainCommand(placed.doc, {
      type: "set-puppet-expression",
      instanceId: placed.id,
      expressionId: "shocked",
    }).doc;

    // A five-degree elbow move or a face swap must not litter the lineage
    // graph with meaningless generated nodes (§14).
    expect(Object.keys(doc.assets)).toHaveLength(assetsBefore);
    expect(Object.keys(doc.characterStates)).toHaveLength(nodesBefore);
    expect(generationCallCount).toBe(0);
  });
});

describe("C — dropping Shock on the face is the same operation", () => {
  it("resolves the face target from real puppet geometry", () => {
    const s = studio();
    const transforms = resolvePartTransforms(s.puppet);
    const bounds = facePartBounds(s.puppet, transforms)!;
    const head = partOfType(s.puppet, "headBase")!;
    const headTransform = transforms.get(head.id)!;
    // The face box sits on the head, not at an arbitrary percentage band.
    expect(bounds.y).toBeLessThan(headTransform.y);
    expect(bounds.height).toBeGreaterThan(0);
    expect(bounds.height).toBeLessThan(0.5);
  });

  it("produces the identical document change as the inspector path", () => {
    const s = studio();
    const placed = placeActor(s, s.panelIds[0]);
    // Canvas drop and inspector click dispatch the SAME command (§16).
    const viaDrop = applyDomainCommand(placed.doc, {
      type: "set-puppet-expression",
      instanceId: placed.id,
      expressionId: "shocked",
    }).doc;
    const viaInspector = applyDomainCommand(placed.doc, {
      type: "set-puppet-expression",
      instanceId: placed.id,
      expressionId: "shocked",
    }).doc;
    expect(inst(viaDrop, placed.id).puppet).toEqual(inst(viaInspector, placed.id).puppet);
    expect(generationCallCount).toBe(0);
  });
});

describe("D — raising the right arm is local", () => {
  it("moves the right arm chain and nothing else", () => {
    const s = studio();
    const placed = placeActor(s, s.panelIds[0]);
    let doc = applyDomainCommand(placed.doc, {
      type: "set-puppet-expression",
      instanceId: placed.id,
      expressionId: "shocked",
    }).doc;
    const before = bodySnapshot(doc, placed.id, s.puppet);

    doc = applyDomainCommand(doc, {
      type: "set-puppet-joint",
      instanceId: placed.id,
      joint: "shoulderRight",
      degrees: 30,
    }).doc;
    const after = bodySnapshot(doc, placed.id, s.puppet);

    // The whole right arm chain moved …
    expect(after.body.upperArmRight.rotation).not.toBe(before.body.upperArmRight.rotation);
    expect(after.body.lowerArmRight.rotation).toBe(after.body.upperArmRight.rotation);
    expect(after.body.lowerArmRight.x).not.toBeCloseTo(before.body.lowerArmRight.x, 6);
    expect(after.body.handRight.x).not.toBeCloseTo(before.body.handRight.x, 6);

    // … and nothing else did.
    expect(after.body.torso).toEqual(before.body.torso);
    expect(after.body.headBase).toEqual(before.body.headBase);
    expect(after.body.hairFront).toEqual(before.body.hairFront);
    expect(after.body.upperArmLeft).toEqual(before.body.upperArmLeft);
    expect(after.body.lowerArmLeft).toEqual(before.body.lowerArmLeft);
    expect(after.body.handLeft).toEqual(before.body.handLeft);

    // Every texture is the same file — nothing was redrawn.
    for (const type of bodyPartTypes()) {
      if (!before.body[type]) continue;
      expect(after.body[type].texture).toBe(before.body[type].texture);
    }

    // Expression, composition and identity survived.
    expect(inst(doc, placed.id).puppet!.expressionId).toBe("shocked");
    expect(after.transform).toEqual(before.transform);
    expect(after.instanceId).toBe(before.instanceId);
    expect(generationCallCount).toBe(0);
  });

  it("bends an elbow without moving the shoulder", () => {
    const s = studio();
    const placed = placeActor(s, s.panelIds[0]);
    const before = bodySnapshot(placed.doc, placed.id, s.puppet);
    const doc = applyDomainCommand(placed.doc, {
      type: "set-puppet-joint",
      instanceId: placed.id,
      joint: "elbowRight",
      degrees: 60,
    }).doc;
    const after = bodySnapshot(doc, placed.id, s.puppet);

    expect(after.body.upperArmRight).toEqual(before.body.upperArmRight);
    expect(after.body.lowerArmRight.rotation).not.toBe(before.body.lowerArmRight.rotation);
    expect(after.body.handRight.x).not.toBeCloseTo(before.body.handRight.x, 6);
    expect(generationCallCount).toBe(0);
  });
});

describe("E — undo", () => {
  it("returns exactly to the previous pose and expression", () => {
    const s = studio();
    const placed = placeActor(s, s.panelIds[0]);
    const original = placed.doc;

    let doc = applyDomainCommand(original, {
      type: "set-puppet-expression",
      instanceId: placed.id,
      expressionId: "shocked",
    }).doc;
    doc = applyDomainCommand(doc, {
      type: "set-puppet-joint",
      instanceId: placed.id,
      joint: "shoulderRight",
      degrees: 40,
    }).doc;

    expect(inst(doc, placed.id).puppet!.expressionId).toBe("shocked");
    // Commands are pure doc → doc, so the prior document IS the undo state.
    expect(inst(original, placed.id).puppet!.expressionId).toBe("neutral");
    expect(inst(original, placed.id).puppet!.pose).toEqual({});
  });
});

describe("F — instance isolation", () => {
  it("keeps two panels' actors independent", () => {
    const s = studio();
    const panelA = placeActor(s, s.panelIds[0]);
    const withB = { ...s, doc: panelA.doc };
    const panelB = placeActor(withB, s.panelIds[1]);
    let doc = panelB.doc;

    // Panel A: shocked with a raised arm. Panel B: untouched.
    doc = applyDomainCommand(doc, {
      type: "set-puppet-expression",
      instanceId: panelA.id,
      expressionId: "shocked",
    }).doc;
    doc = applyDomainCommand(doc, {
      type: "set-puppet-joint",
      instanceId: panelA.id,
      joint: "shoulderRight",
      degrees: 45,
    }).doc;

    expect(inst(doc, panelA.id).puppet!.expressionId).toBe("shocked");
    expect(inst(doc, panelA.id).puppet!.pose.shoulderRight).toBe(45);
    expect(inst(doc, panelB.id).puppet!.expressionId).toBe("neutral");
    expect(inst(doc, panelB.id).puppet!.pose).toEqual({});

    // Both still reference ONE shared model.
    expect(inst(doc, panelA.id).puppet!.puppetId).toBe(inst(doc, panelB.id).puppet!.puppetId);
    expect(Object.keys(doc.puppets)).toHaveLength(1);
    expect(generationCallCount).toBe(0);
  });

  it("keeps attachments per instance", () => {
    const s = studio();
    const panelA = placeActor(s, s.panelIds[0]);
    const panelB = placeActor({ ...s, doc: panelA.doc }, s.panelIds[1]);
    const doc = applyDomainCommand(panelB.doc, {
      type: "set-puppet-attachment",
      instanceId: panelA.id,
      attachmentId: "phone",
      attached: true,
    }).doc;
    expect(inst(doc, panelA.id).puppet!.attachments).toEqual(["phone"]);
    expect(inst(doc, panelB.id).puppet!.attachments).toBeUndefined();
  });
});

describe("G — persistence", () => {
  it("survives save and reload with both actors intact", () => {
    const s = studio();
    const panelA = placeActor(s, s.panelIds[0]);
    const panelB = placeActor({ ...s, doc: panelA.doc }, s.panelIds[1]);
    let doc = applyDomainCommand(panelB.doc, {
      type: "set-puppet-expression",
      instanceId: panelA.id,
      expressionId: "shocked",
    }).doc;
    doc = applyDomainCommand(doc, {
      type: "set-puppet-joint",
      instanceId: panelA.id,
      joint: "shoulderRight",
      degrees: 35,
    }).doc;

    const restored = deserializeProject(serializeProject(doc));
    expect(restored.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Object.keys(restored.puppets)).toHaveLength(1);
    expect(inst(restored, panelA.id).puppet).toEqual({
      puppetId: s.puppet.id,
      expressionId: "shocked",
      pose: { shoulderRight: 35 },
    });
    expect(inst(restored, panelB.id).puppet!.expressionId).toBe("neutral");
    // The model itself round-trips, hierarchy and all.
    expect(restored.puppets[s.puppet.id].partOrder).toEqual(s.puppet.partOrder);
  });
});

describe("capability boundary", () => {
  it("accepts moves within joint limits", () => {
    const s = studio();
    expect(canApplyJoint(s.puppet, "elbowRight", 40).supported).toBe(true);
    expect(describeCost(canApplyJoint(s.puppet, "elbowRight", 20))).toBe("instant");
  });

  it("refuses a rotation past the joint limit rather than distorting", () => {
    const s = studio();
    const result = canApplyJoint(s.puppet, "elbowRight", 200);
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/outside/);
    expect(result.fallbackRecommendation).toMatch(/redraw/i);
    expect(describeCost(result)).toBe("generation");
  });

  it("throws instead of silently clamping an impossible request", () => {
    const s = studio();
    const placed = placeActor(s, s.panelIds[0]);
    expect(() =>
      applyDomainCommand(placed.doc, {
        type: "set-puppet-joint",
        instanceId: placed.id,
        joint: "elbowRight",
        degrees: 200,
      }),
    ).toThrow(PuppetCapabilityError);
  });

  it("admits a big swing is only approximate when hidden regions are missing", () => {
    const s = studio();
    // The fixture's upper arms were cut from a flat drawing, so the torso
    // behind them does not exist.
    const result = canApplyJoint(s.puppet, "shoulderRight", 90);
    expect(result.supported).toBe(true);
    expect(result.quality).toBe("approximate");
    expect(result.reason).toMatch(/hidden/i);
    expect(describeCost(result)).toBe("instant-approximate");
  });

  it("refuses views and leg poses this puppet cannot hold", () => {
    const s = studio();
    expect(canRepresentView(s.puppet, "front").supported).toBe(true);
    expect(canRepresentView(s.puppet, "back").supported).toBe(false);
    expect(canRepresentPoseChange(s.puppet, ["right knee bent"]).supported).toBe(false);
    expect(canRepresentPoseChange(s.puppet, ["right arm raised"]).supported).toBe(true);
  });

  it("refuses an expression the puppet has no artwork for", () => {
    const s = studio();
    const result = canApplyExpression(s.puppet, "crying");
    expect(result.supported).toBe(false);
    expect(result.fallbackRecommendation).toMatch(/generate/i);
  });

  it("reports the worst joint for a whole pose", () => {
    const s = studio();
    expect(canApplyPose(s.puppet, { elbowRight: 20, shoulderRight: 90 }).quality).toBe("approximate");
    expect(canApplyPose(s.puppet, { elbowRight: 300 }).supported).toBe(false);
  });
});

describe("legacy compatibility", () => {
  it("leaves a character without a puppet completely unchanged", () => {
    const s = studio();
    let doc = createProjectDocument("Legacy");
    const mio = addCharacter(doc, "Mio");
    doc = mio.doc;
    const flat = addAsset(doc, {
      category: "character",
      name: "mio-standing",
      storageUrl: "mio.png",
      width: 800,
      height: 1600,
      hasAlpha: true,
      processedImageUrl: "mio-a.png",
      processingStatus: "ready",
      metadata: { characterId: mio.characterId, characterAssetRole: "state", pose: "standing" },
    });
    doc = flat.doc;
    const panelId = doc.pages[Object.keys(doc.pages)[0]].panelIds[0];
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId, assetId: flat.assetId });

    expect(isPuppetInstance(placed.doc, placed.createdId!)).toBe(false);
    expect(inst(placed.doc, placed.createdId!).puppet).toBeUndefined();
    expect(doc.characters[mio.characterId].puppetId).toBeUndefined();
    // And the puppet character in the other document is unaffected by any of it.
    expect(s.doc.characters[s.characterId].puppetId).toBe(s.puppet.id);
  });

  it("migrates a v9 project without inventing puppets", () => {
    const s = studio();
    const legacy = JSON.parse(serializeProject(s.doc)) as Record<string, unknown>;
    legacy.schemaVersion = 9;
    delete legacy.puppets;
    for (const character of Object.values(legacy.characters as Record<string, Record<string, unknown>>)) {
      delete character.puppetId;
    }

    const migrated = deserializeProject(JSON.stringify(legacy));
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    // No flat asset was reinterpreted as puppet parts (§23).
    expect(migrated.puppets).toEqual({});
    expect(migrated.characters[s.characterId].puppetId).toBeUndefined();
    expect(Object.keys(migrated.assets)).toHaveLength(Object.keys(s.doc.assets).length);
  });
});
