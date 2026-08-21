/**
 * V3.2 acceptance: a REAL character asset compiled through the compiler flow.
 *
 * §10 is explicit that the hand-authored fixture is not enough. Everything here
 * runs against a puppet built by `compilePuppet` from a canonical render that
 * exists in a project document — the same path the wizard drives.
 *
 * The invariant under test is the same one V3.1 proved and V3.2 must not lose:
 * local edits touch the document only, and never a provider.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { applyDomainCommand } from "@/domain/commands";
import { deserializeProject, serializeProject } from "@/domain/serialization";
import type { AssetInstance, ID, ProjectDocument } from "@/domain/types";
import { useEditorStore } from "@/editor/store";
import { executePlan } from "@/agent/executor";
import { validatePlan } from "@/agent/tools/schemas";
import { compilePuppet, compilerIssues, isCompilable, proposePartRegions } from "./compiler";
import { canApplyJoint, canRepresentView } from "./capability";
import { jointAngleFromPointer, jointHandles, faceDropTarget, isOverFace, toPuppetUnits } from "./interaction";
import { resolvePartTransforms } from "./transforms";
import type { MangaPuppet, PuppetPartType } from "./model";

// ─── A real character, compiled ────────────────────────────────────────────

interface Fixture {
  doc: ProjectDocument;
  characterId: ID;
  canonicalId: ID;
  puppet: MangaPuppet;
  panelId: ID;
  instanceId: ID;
}

/** Confirm every proposed region, as a creator does in step 2. */
function confirmedRegions() {
  return proposePartRegions().map((region) => ({ ...region, confirmed: true }));
}

function fixture(): Fixture {
  let doc = createProjectDocument("V3.2");
  const character = addCharacter(doc, "Yuri", "black-haired high school girl");
  doc = character.doc;

  // A real canonical render: a transparent, processed character asset.
  const canonical = addAsset(doc, {
    category: "character",
    name: "Yuri canonical",
    storageUrl: "https://example.com/yuri.png",
    processedImageUrl: "https://example.com/yuri-cut.png",
    width: 800,
    height: 1600,
    hasAlpha: true,
    backgroundRemoved: true,
    processingStatus: "ready",
    metadata: { characterId: character.characterId, characterAssetRole: "canonical" },
  });
  doc = canonical.doc;
  doc = applyDomainCommand(doc, {
    type: "set-character-reference",
    characterId: character.characterId,
    assetId: canonical.assetId,
  }).doc;

  const puppet = compilePuppet({
    characterId: character.characterId,
    canonicalAssetId: canonical.assetId,
    regions: confirmedRegions(),
    sourceAspect: 800 / 1600,
    expressionRegions: {
      shocked: {
        name: "Shocked",
        parts: {
          eyeLeft: { x: 0.38, y: 0.11, width: 0.11, height: 0.05 },
          eyeRight: { x: 0.51, y: 0.11, width: 0.11, height: 0.05 },
          mouth: { x: 0.45, y: 0.16, width: 0.10, height: 0.04 },
        },
      },
    },
  });
  doc = applyDomainCommand(doc, { type: "register-puppet", puppet }).doc;

  const panelId = doc.pages[Object.keys(doc.pages)[0]].panelIds[0];
  const placed = applyDomainCommand(doc, { type: "add-instance", panelId, assetId: canonical.assetId });
  doc = placed.doc;
  doc = applyDomainCommand(doc, {
    type: "attach-puppet",
    instanceId: placed.createdId!,
    puppetId: puppet.id,
  }).doc;

  return {
    doc,
    characterId: character.characterId,
    canonicalId: canonical.assetId,
    puppet,
    panelId,
    instanceId: placed.createdId!,
  };
}

function inst(doc: ProjectDocument, id: ID): AssetInstance {
  const item = doc.items[id];
  if (item?.kind !== "asset") throw new Error("not an asset instance");
  return item;
}

// ─── Compiler ──────────────────────────────────────────────────────────────

describe("puppet compiler v1", () => {
  it("proposes every required part, unconfirmed", () => {
    const regions = proposePartRegions();
    const types = regions.map((region) => region.type);
    for (const required of [
      "torso",
      "headBase",
      "hairBack",
      "hairFront",
      "faceBase",
      "eyeLeft",
      "eyeRight",
      "browLeft",
      "browRight",
      "mouth",
      "upperArmLeft",
      "lowerArmLeft",
      "handLeft",
      "upperArmRight",
      "lowerArmRight",
      "handRight",
    ] as PuppetPartType[]) {
      expect(types, required).toContain(required);
    }
    // A proposal is a guess, and says so.
    expect(regions.every((region) => !region.confirmed)).toBe(true);
  });

  it("warns about unconfirmed regions rather than pretending they were detected", () => {
    const issues = compilerIssues(proposePartRegions());
    expect(issues.some((issue) => issue.message.includes("proposed proportion"))).toBe(true);
    expect(issues.every((issue) => issue.severity !== "blocking")).toBe(true);
  });

  it("blocks compilation on an invalid region", () => {
    const regions = confirmedRegions();
    regions[0].rect = { x: 0.9, y: 0.9, width: 0.5, height: 0.5 };
    expect(isCompilable(regions)).toBe(false);
    expect(() =>
      compilePuppet({ characterId: "c", canonicalAssetId: "a", regions, sourceAspect: 0.5 }),
    ).toThrow(/Cannot compile/);
  });

  it("cuts parts out of the canonical render rather than inventing assets", () => {
    const { puppet, canonicalId } = fixture();
    for (const part of Object.values(puppet.parts)) {
      expect(part.textureAssetId).toBe(canonicalId);
      expect(part.sourceRect).toBeDefined();
    }
    expect(puppet.compilerMetadata.source).toBe("compiled");
    expect(puppet.compilerMetadata.notes).toContain("No automatic segmentation");
  });

  it("reports arms as hidden-region incomplete until reconstruction runs (§8)", () => {
    const { puppet } = fixture();
    expect(puppet.parts.upperArmRight.readiness.hiddenRegionComplete).toBe(false);
    expect(puppet.parts.torso.readiness.hiddenRegionComplete).toBe(true);

    // And the capability system must not claim a big swing is safe.
    expect(canApplyJoint(puppet, "shoulderRight", 90)).toMatchObject({
      supported: true,
      quality: "approximate",
    });
  });

  it("marks a reconstructed arm as complete, and then reports the swing as safe", () => {
    const regions = confirmedRegions().map((region) =>
      region.type.startsWith("upperArm") || region.type.startsWith("lowerArm")
        ? { ...region, hiddenRegionAssetId: "reconstructed-asset" }
        : region,
    );
    const puppet = compilePuppet({
      characterId: "c",
      canonicalAssetId: "a",
      regions,
      sourceAspect: 0.5,
    });
    expect(puppet.parts.upperArmRight.readiness.hiddenRegionComplete).toBe(true);
    expect(canApplyJoint(puppet, "shoulderRight", 90)).toMatchObject({ supported: true, quality: "safe" });
  });

  it("derives anchors from the confirmed regions so limbs stay attached", () => {
    const { puppet } = fixture();
    const transforms = resolvePartTransforms(puppet, {});
    const shoulder = transforms.get("upperArmRight")!;
    const torso = transforms.get("torso")!;
    // The shoulder sits on the torso's right and above its centre.
    expect(shoulder.x).toBeGreaterThan(torso.x);
    expect(shoulder.y).toBeLessThan(torso.y + torso.size.y / 2);
  });
});

// ─── §10 acceptance, on a compiled real character ──────────────────────────

let generationCalls: string[] = [];

describe("V3.2 acceptance: compiled real character", () => {
  beforeEach(() => {
    generationCalls = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      generationCalls.push(String(input));
      throw new Error(`Unexpected provider call during a local puppet edit: ${String(input)}`);
    });
  });

  it("A. Neutral → Shock changes only facial parts and generates nothing", () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);
    const before = inst(useEditorStore.getState().doc!, base.instanceId);
    const beforeTransforms = resolvePartTransforms(base.puppet, before.puppet!.pose);

    useEditorStore.getState().dispatch({
      type: "set-puppet-expression",
      instanceId: base.instanceId,
      expressionId: "shocked",
    });

    const doc = useEditorStore.getState().doc!;
    const after = inst(doc, base.instanceId);

    // Same actor, same body, same stage.
    expect(after.id).toBe(before.id);
    expect(after.panelId).toBe(before.panelId);
    expect(after.sourceAssetId).toBe(before.sourceAssetId);
    expect({ cx: after.cx, cy: after.cy, width: after.width, height: after.height }).toEqual({
      cx: before.cx,
      cy: before.cy,
      width: before.width,
      height: before.height,
    });
    expect(after.puppet!.pose).toEqual(before.puppet!.pose);
    expect(after.puppet!.expressionId).toBe("shocked");

    // Body geometry is byte-identical; only the swapped face slots differ.
    const afterTransforms = resolvePartTransforms(base.puppet, after.puppet!.pose);
    for (const type of ["torso", "headBase", "hairFront", "hairBack", "upperArmRight", "handLeft"]) {
      expect(afterTransforms.get(type), type).toEqual(beforeTransforms.get(type));
    }

    // Nothing was created and nothing was requested.
    expect(Object.keys(doc.assets)).toHaveLength(Object.keys(base.doc.assets).length);
    expect(Object.keys(doc.characterStates)).toHaveLength(Object.keys(base.doc.characterStates).length);
    expect(generationCalls).toHaveLength(0);
  });

  it("A2. undo restores the previous expression", () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);
    const original = inst(base.doc, base.instanceId).puppet!.expressionId;

    useEditorStore.getState().dispatch({
      type: "set-puppet-expression",
      instanceId: base.instanceId,
      expressionId: "shocked",
    });
    expect(inst(useEditorStore.getState().doc!, base.instanceId).puppet!.expressionId).toBe("shocked");

    useEditorStore.getState().undo();
    expect(inst(useEditorStore.getState().doc!, base.instanceId).puppet!.expressionId).toBe(original);
    expect(generationCalls).toHaveLength(0);
  });

  it("B. raising the right arm moves that arm only, keeps Shock, and generates nothing", () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);
    useEditorStore.getState().dispatch({
      type: "set-puppet-expression",
      instanceId: base.instanceId,
      expressionId: "shocked",
    });
    const before = resolvePartTransforms(base.puppet, inst(useEditorStore.getState().doc!, base.instanceId).puppet!.pose);

    useEditorStore.getState().dispatch({
      type: "set-puppet-joint",
      instanceId: base.instanceId,
      joint: "shoulderRight",
      degrees: 70,
    });

    const doc = useEditorStore.getState().doc!;
    const after = inst(doc, base.instanceId);
    const afterTransforms = resolvePartTransforms(base.puppet, after.puppet!.pose);

    // The whole right arm chain moved.
    for (const type of ["upperArmRight", "lowerArmRight", "handRight"]) {
      expect(afterTransforms.get(type), type).not.toEqual(before.get(type));
    }
    // Nothing else did.
    for (const type of ["torso", "headBase", "hairFront", "hairBack", "upperArmLeft", "lowerArmLeft", "handLeft"]) {
      expect(afterTransforms.get(type), type).toEqual(before.get(type));
    }
    // The face survives the pose change.
    expect(after.puppet!.expressionId).toBe("shocked");
    // Every part still draws the same texture.
    for (const part of Object.values(base.puppet.parts)) expect(part.textureAssetId).toBe(base.canonicalId);
    expect(generationCalls).toHaveLength(0);
  });

  it("C. duplicating into another panel gives independent instances", () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);
    const secondPanel = base.doc.pages[Object.keys(base.doc.pages)[0]].panelIds[1];

    const copy = useEditorStore.getState().dispatch({
      type: "add-instance",
      panelId: secondPanel,
      assetId: base.canonicalId,
    });
    useEditorStore.getState().dispatch({
      type: "attach-puppet",
      instanceId: copy.createdId!,
      puppetId: base.puppet.id,
    });

    useEditorStore.getState().dispatch({
      type: "set-puppet-expression",
      instanceId: base.instanceId,
      expressionId: "shocked",
    });
    useEditorStore.getState().dispatch({
      type: "set-puppet-joint",
      instanceId: copy.createdId!,
      joint: "shoulderRight",
      degrees: 40,
    });

    const doc = useEditorStore.getState().doc!;
    const first = inst(doc, base.instanceId);
    const second = inst(doc, copy.createdId!);

    expect(first.puppet!.expressionId).toBe("shocked");
    expect(second.puppet!.expressionId).toBe("neutral");
    expect(first.puppet!.pose).toEqual({});
    expect(second.puppet!.pose).toEqual({ shoulderRight: 40 });
    // Both still share ONE puppet model — divergence is per instance.
    expect(first.puppet!.puppetId).toBe(second.puppet!.puppetId);
    expect(generationCalls).toHaveLength(0);
  });

  it("D. the puppet survives save and reload", () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);
    useEditorStore.getState().dispatch({
      type: "set-puppet-expression",
      instanceId: base.instanceId,
      expressionId: "shocked",
    });
    useEditorStore.getState().dispatch({
      type: "set-puppet-joint",
      instanceId: base.instanceId,
      joint: "elbowRight",
      degrees: 35,
    });

    const restored = deserializeProject(serializeProject(useEditorStore.getState().doc!));
    const puppet = restored.puppets[base.puppet.id];
    expect(puppet).toBeDefined();
    expect(Object.keys(puppet.parts)).toHaveLength(Object.keys(base.puppet.parts).length);
    expect(puppet.parts.torso.sourceRect).toEqual(base.puppet.parts.torso.sourceRect);

    const instance = inst(restored, base.instanceId);
    expect(instance.puppet!.expressionId).toBe("shocked");
    expect(instance.puppet!.pose).toEqual({ elbowRight: 35 });
    expect(restored.characters[base.characterId].puppetId).toBe(base.puppet.id);
  });
});

// ─── §11: camera / stage inheritance, with no puppet-specific code ──────────

describe("camera and stage inheritance", () => {
  it("depth still scales the puppet and anchors it to the ground", () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);
    const before = inst(base.doc, base.instanceId);

    useEditorStore.getState().dispatch({
      type: "set-instance-stage",
      instanceId: base.instanceId,
      patch: { depth: 0.85, groundY: 0.8, scaleLocked: false },
    });
    const after = inst(useEditorStore.getState().doc!, base.instanceId);

    // Further away is smaller — the same projection flat instances get.
    expect(after.height).toBeLessThan(before.height);
    expect(after.stage?.depth).toBe(0.85);
    // Still a puppet, still the same model.
    expect(after.puppet!.puppetId).toBe(base.puppet.id);
  });

  it("focal framing and camera shot frame the puppet", () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);
    const before = inst(base.doc, base.instanceId);

    useEditorStore.getState().dispatch({
      type: "set-panel-focal-item",
      panelId: base.panelId,
      itemId: base.instanceId,
    });
    useEditorStore.getState().dispatch({
      type: "set-panel-camera",
      panelId: base.panelId,
      patch: { shot: "close-up" },
    });

    const doc = useEditorStore.getState().doc!;
    expect(doc.panels[base.panelId].focalItemId).toBe(base.instanceId);
    const after = inst(doc, base.instanceId);
    // A close-up genuinely reframes the actor rather than only storing a value.
    expect(after.height).not.toBe(before.height);
  });

  it("z-order still works on a puppet instance", () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);
    const other = useEditorStore.getState().dispatch({
      type: "add-instance",
      panelId: base.panelId,
      assetId: base.canonicalId,
    });
    const before = useEditorStore.getState().doc!.panels[base.panelId].itemIds.indexOf(base.instanceId);

    useEditorStore.getState().dispatch({
      type: "reorder-instance",
      instanceId: base.instanceId,
      direction: "front",
    });
    const after = useEditorStore.getState().doc!.panels[base.panelId].itemIds.indexOf(base.instanceId);
    expect(after).toBeGreaterThan(before);
    expect(other.createdId).toBeDefined();
  });

  it("a puppet instance is still an ordinary asset instance to the rest of the editor", () => {
    const base = fixture();
    const instance = inst(base.doc, base.instanceId);
    // This is why camera/stage/framing/export needed no new code (D39).
    expect(instance.kind).toBe("asset");
    expect(instance.sourceAssetId).toBe(base.canonicalId);
  });
});

// ─── §1 / §2: direct manipulation geometry ─────────────────────────────────

describe("canvas direct manipulation", () => {
  it("offers a handle for every joint the puppet actually has", () => {
    const { puppet } = fixture();
    const handles = jointHandles(puppet, {});
    expect(handles.map((handle) => handle.joint).sort()).toEqual(
      ["elbowLeft", "elbowRight", "head", "shoulderLeft", "shoulderRight", "wristLeft", "wristRight"].sort(),
    );
  });

  it("offers no handle for a limb the puppet does not have", () => {
    const regions = confirmedRegions().filter((region) => !region.type.startsWith("upperArmLeft"));
    // A missing part is a blocking issue, so build a puppet then remove the part.
    const puppet = compilePuppet({ characterId: "c", canonicalAssetId: "a", regions: confirmedRegions(), sourceAspect: 0.5 });
    delete puppet.parts.upperArmLeft;
    puppet.partOrder = puppet.partOrder.filter((id) => id !== "upperArmLeft");
    expect(jointHandles(puppet, {}).some((handle) => handle.joint === "shoulderLeft")).toBe(false);
    expect(regions.length).toBeLessThan(confirmedRegions().length);
  });

  it("converts a pointer position into the rotation that puts the bone under it", () => {
    const { puppet } = fixture();
    const handle = jointHandles(puppet, {}).find((candidate) => candidate.joint === "shoulderRight")!;
    // Straight down from the pivot is the rest direction → 0°.
    const down = jointAngleFromPointer(puppet, "shoulderRight", handle, { x: handle.x, y: handle.y + 0.2 });
    expect(down.applied).toBeCloseTo(0, 4);
    expect(down.clamped).toBe(false);

    // Straight out to the right is a quarter turn from "down". The conversion
    // reports that faithfully — and then the JOINT LIMIT, not the pointer,
    // decides what is actually applied: shoulderRight only opens to -60°.
    const out = jointAngleFromPointer(puppet, "shoulderRight", handle, { x: handle.x + 0.2, y: handle.y });
    expect(out.requested).toBeCloseTo(-90, 4);
    expect(out.applied).toBe(-60);
    expect(out.clamped).toBe(true);
  });

  it("refuses to distort past the joint limit and reports the boundary", () => {
    const { puppet } = fixture();
    const handle = jointHandles(puppet, {}).find((candidate) => candidate.joint === "head")!;
    // Far past the head's ±28° range.
    const result = jointAngleFromPointer(puppet, "head", handle, { x: handle.x + 0.3, y: handle.y });
    expect(result.clamped).toBe(true);
    expect(Math.abs(result.applied)).toBeLessThanOrEqual(28);
    expect(result.capability.supported).toBe(false);
    expect(result.capability.fallbackRecommendation).toBeTruthy();
  });

  it("tracks the face drop target through a head rotation", () => {
    const { puppet } = fixture();
    const upright = faceDropTarget(puppet, {})!;
    const tilted = faceDropTarget(puppet, { head: 25 })!;
    expect(tilted).not.toEqual(upright);
    // Still a real region, not a collapsed box.
    expect(tilted.width).toBeGreaterThan(0);
    expect(tilted.height).toBeGreaterThan(0);
  });

  it("hit-tests a drop against the real face, not a percentage band", () => {
    const { doc, instanceId, puppet } = fixture();
    const instance = inst(doc, instanceId);
    const target = faceDropTarget(puppet, {})!;

    const faceCentre = {
      x: (target.x + target.width / 2) * instance.height + (instance.cx - instance.width / 2),
      y: (target.y + target.height / 2) * instance.height + (instance.cy - instance.height / 2),
    };
    expect(isOverFace(target, toPuppetUnits(instance, faceCentre))).toBe(true);

    const feet = { x: faceCentre.x, y: instance.cy + instance.height / 2 - 1 };
    expect(isOverFace(target, toPuppetUnits(instance, feet))).toBe(false);
  });
});

// ─── §12: the Agent must not skip the capability gate ──────────────────────

describe("agent capability gate", () => {
  beforeEach(() => {
    generationCalls = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      generationCalls.push(String(input));
      throw new Error(`Unexpected provider call: ${String(input)}`);
    });
  });

  it('"Make Yuri shocked" runs as a local expression command', async () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);

    const summary = await executePlan(
      validatePlan({
        summary: "shock",
        steps: [{ tool: "set_puppet_expression", args: { panel: 1, characterName: "Yuri", expression: "shocked" } }],
      }).plan,
      () => {},
      { creationAuthorized: false, authorizedCreationNames: [] },
    );

    expect(summary.failed).toBe(0);
    expect(inst(useEditorStore.getState().doc!, base.instanceId).puppet!.expressionId).toBe("shocked");
    expect(generationCalls).toHaveLength(0);
  });

  it('"Raise Yuri\'s right hand" runs as a local pose command', async () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);

    const summary = await executePlan(
      validatePlan({
        summary: "raise",
        steps: [
          { tool: "set_puppet_joint", args: { panel: 1, characterName: "Yuri", joint: "shoulderRight", degrees: 80 } },
        ],
      }).plan,
      () => {},
      { creationAuthorized: false, authorizedCreationNames: [] },
    );

    expect(summary.failed).toBe(0);
    expect(inst(useEditorStore.getState().doc!, base.instanceId).puppet!.pose.shoulderRight).toBe(80);
    expect(generationCalls).toHaveLength(0);
  });

  it("an out-of-range rotation is REFUSED, not silently distorted", async () => {
    const base = fixture();
    useEditorStore.getState().loadDocument(base.doc);
    const details: (string | undefined)[] = [];

    const summary = await executePlan(
      validatePlan({
        summary: "over-rotate",
        // Far outside the head's ±28° range.
        steps: [{ tool: "set_puppet_joint", args: { panel: 1, characterName: "Yuri", joint: "head", degrees: 175 } }],
      }).plan,
      (_index, status, detail) => {
        if (status === "failed") details.push(detail);
      },
      { creationAuthorized: false, authorizedCreationNames: [] },
    );

    expect(summary.failed).toBe(1);
    // The pose is unchanged — the puppet was not bent to satisfy the request.
    expect(inst(useEditorStore.getState().doc!, base.instanceId).puppet!.pose.head).toBeUndefined();
    // And the refusal names the boundary and the fallback.
    expect(details[0]).toMatch(/rotate between/);
    expect(generationCalls).toHaveLength(0);
  });

  it('"Turn Yuri completely around" is outside what the puppet can represent', () => {
    const { puppet } = fixture();
    const capability = canRepresentView(puppet, "back");
    expect(capability.supported).toBe(false);
    expect(capability.fallbackRecommendation).toContain("Generate");
  });
});
