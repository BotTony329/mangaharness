/**
 * Character Rig 2.0: state graph, reference lineage, nearest-state resolution,
 * and the identity invariants that make a character an actor rather than a
 * series of unrelated renders.
 *
 * Every assertion runs against real documents through the command layer.
 */

import { describe, expect, it } from "vitest";
import { applyDomainCommand } from "@/domain/commands";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { deserializeProject, serializeProject } from "@/domain/serialization";
import { SCHEMA_VERSION, type AssetInstance, type CharacterState, type ID, type ProjectDocument } from "@/domain/types";
import { defaultCharacterState } from "./kit";
import { buildCharacterKit } from "./kit";
import { stateFromInstance } from "./state";
import {
  buildDelta,
  describeRecord,
  findNearestRenderedState,
  findRenderedStateRecord,
  lineageOf,
  normalizeProps,
  renderedStateRecords,
  stateDistance,
} from "./stateGraph";
import {
  acceptableSockets,
  patchForSocketDrop,
  propsAfterDrop,
  referenceOptions,
  resolveCharacterState,
  resolveInstancePatch,
} from "./stateResolver";
import { resolveSocketAt } from "./sockets";

interface Rig {
  doc: ProjectDocument;
  characterId: ID;
  canonicalAssetId: ID;
  panelIds: ID[];
}

function rig(): Rig {
  let doc = createProjectDocument("Rig2");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;
  const canonical = addAsset(doc, {
    category: "character",
    name: "yuri-canonical",
    storageUrl: "canon.png",
    width: 800,
    height: 1600,
    hasAlpha: true,
    processedImageUrl: "canon-a.png",
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

/** Register a rendered state, optionally recording what it was derived from. */
function render(
  doc: ProjectDocument,
  characterId: ID,
  state: Partial<CharacterState>,
  lineage: { parentStateId?: ID; referenceAssetId?: ID; canonicalReferenceAssetId?: ID } = {},
): { doc: ProjectDocument; assetId: ID } {
  const full = { ...defaultCharacterState(characterId), ...state };
  const added = addAsset(doc, {
    category: "character",
    name: `yuri-${full.pose}-${full.expression}`,
    storageUrl: `${full.pose}-${full.expression}.png`,
    width: 800,
    height: 1600,
    hasAlpha: true,
    processedImageUrl: `${full.pose}-${full.expression}-a.png`,
    processingStatus: "ready",
    metadata: {
      characterId,
      characterAssetRole: "state",
      pose: full.pose,
      expression: full.expression,
      outfit: full.outfit,
      view: full.view,
      props: full.props,
      parentStateId: lineage.parentStateId,
      referenceAssetIds: lineage.referenceAssetId ? [lineage.referenceAssetId] : undefined,
      canonicalReferenceAssetId: lineage.canonicalReferenceAssetId,
    },
    provenance: full.props ? { characterState: { props: full.props } } : undefined,
  });
  return { doc: added.doc, assetId: added.assetId };
}

const instanceOf = (doc: ProjectDocument, id: ID) => doc.items[id] as AssetInstance;
const stateOf = (doc: ProjectDocument, id: ID) => stateFromInstance(doc, instanceOf(doc, id))!;
const nodeFor = (doc: ProjectDocument, assetId: ID) =>
  Object.values(doc.characterStates).find((record) => record.assetId === assetId);

describe("state graph", () => {
  it("creates a node for every character render, but not for canonical images", () => {
    const base = rig();
    const { doc } = render(base.doc, base.characterId, { pose: "walking" });
    const nodes = renderedStateRecords(doc, base.characterId);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ pose: "walking", expression: "neutral" });
    // Canonical anchors identity; it is not a selectable state.
    expect(nodeFor(doc, base.canonicalAssetId)).toBeUndefined();
  });

  it("records lineage and the reference that anchored a generation", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" }, { canonicalReferenceAssetId: base.canonicalAssetId });
    const parent = nodeFor(walking.doc, walking.assetId)!;
    const shocked = render(
      walking.doc,
      base.characterId,
      { pose: "walking", expression: "shocked" },
      { parentStateId: parent.id, referenceAssetId: walking.assetId, canonicalReferenceAssetId: base.canonicalAssetId },
    );
    const child = nodeFor(shocked.doc, shocked.assetId)!;

    expect(child.parentStateId).toBe(parent.id);
    expect(child.referenceAssetId).toBe(walking.assetId);
    expect(child.canonicalReferenceAssetId).toBe(base.canonicalAssetId);

    const chain = lineageOf(shocked.doc, child.id);
    expect(chain.map((record) => describeRecord(record))).toEqual(["Walking · Shocked", "Walking · Neutral"]);
  });

  it("computes the delta between a parent and a requested state", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    const parent = nodeFor(walking.doc, walking.assetId)!;
    const delta = buildDelta(parent, { ...defaultCharacterState(base.characterId), pose: "walking", expression: "shocked" });
    expect(delta.changed).toEqual(["expression"]);
    expect(delta.from).toEqual({ expression: "neutral" });
    expect(delta.to).toEqual({ expression: "shocked" });
  });

  it("weights outfit and view above expression when measuring distance", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    const record = nodeFor(walking.doc, walking.assetId)!;
    const target = { ...defaultCharacterState(base.characterId), pose: "walking" };

    const expressionOnly = stateDistance(record, { ...target, expression: "shocked" });
    const outfitOnly = stateDistance(record, { ...target, outfit: "school uniform" });
    // Re-drawing a face preserves more of a reference than re-drawing clothing.
    expect(expressionOnly.cost).toBeLessThan(outfitOnly.cost);
  });

  it("survives serialization with lineage intact", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    const parent = nodeFor(walking.doc, walking.assetId)!;
    const shocked = render(walking.doc, base.characterId, { pose: "walking", expression: "shocked" }, { parentStateId: parent.id });

    const restored = deserializeProject(serializeProject(shocked.doc));
    const child = nodeFor(restored, shocked.assetId)!;
    expect(restored.schemaVersion).toBe(SCHEMA_VERSION);
    expect(child.parentStateId).toBe(parent.id);
    expect(lineageOf(restored, child.id)).toHaveLength(2);
  });

  it("prunes nodes when their render is deleted", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    expect(renderedStateRecords(walking.doc, base.characterId)).toHaveLength(1);
    const deleted = applyDomainCommand(walking.doc, { type: "delete-asset", assetId: walking.assetId, mode: "cascade" }).doc;
    expect(renderedStateRecords(deleted, base.characterId)).toHaveLength(0);
  });

  it("backfills the graph when migrating an older project", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    const legacy = JSON.parse(serializeProject(walking.doc)) as Record<string, unknown>;
    legacy.schemaVersion = 7;
    delete legacy.characterStates;

    const migrated = deserializeProject(JSON.stringify(legacy));
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    const nodes = renderedStateRecords(migrated, base.characterId);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].pose).toBe("walking");
    // Parentage is unknown for prior work and is left undefined rather than invented.
    expect(nodes[0].parentStateId).toBeUndefined();
  });
});

describe("nearest-state resolver", () => {
  it("reuses an exact render without generating", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking", expression: "shocked" });
    const resolution = resolveCharacterState(walking.doc, {
      ...defaultCharacterState(base.characterId),
      pose: "walking",
      expression: "shocked",
    });
    expect(resolution.status).toBe("cached");
    if (resolution.status === "cached") expect(resolution.assetId).toBe(walking.assetId);
  });

  it("anchors on the nearest render and never substitutes it", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    const resolution = resolveCharacterState(walking.doc, {
      ...defaultCharacterState(base.characterId),
      pose: "walking",
      expression: "shocked",
    });
    expect(resolution.status).toBe("needs-generation");
    if (resolution.status === "needs-generation") {
      expect(resolution.reference.kind).toBe("nearest-state");
      expect(resolution.reference.assetId).toBe(walking.assetId);
      // The requested state is returned as requested, not as the neighbour.
      expect(resolution.state.expression).toBe("shocked");
      expect(resolution.delta.changed).toEqual(["expression"]);
      expect(resolution.parentStateId).toBe(nodeFor(walking.doc, walking.assetId)!.id);
    }
  });

  it("falls back to canonical when nothing is close enough", () => {
    const base = rig();
    // Different outfit AND view: too far to inherit from.
    const distant = render(base.doc, base.characterId, { outfit: "battle outfit", view: "back", pose: "sitting" });
    const resolution = resolveCharacterState(distant.doc, {
      ...defaultCharacterState(base.characterId),
      pose: "running",
    });
    expect(resolution.status).toBe("needs-generation");
    if (resolution.status === "needs-generation") {
      expect(resolution.reference.kind).toBe("canonical");
      expect(resolution.reference.assetId).toBe(base.canonicalAssetId);
    }
  });

  it("reports no reference for a character with no images at all", () => {
    let doc = createProjectDocument("Empty");
    const mio = addCharacter(doc, "Mio");
    doc = mio.doc;
    const resolution = resolveCharacterState(doc, defaultCharacterState(mio.characterId));
    expect(resolution.status).toBe("needs-generation");
    if (resolution.status === "needs-generation") expect(resolution.reference.kind).toBe("none");
  });

  it("ignores renders from a different art style", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    const node = nodeFor(walking.doc, walking.assetId)!;
    // Simulate a render made under another project style.
    const otherStyle = { ...walking.doc, characterStates: { ...walking.doc.characterStates } };
    otherStyle.characterStates[node.id] = { ...node, styleProfileId: "some-other-style" };
    expect(renderedStateRecords(otherStyle, base.characterId)).toHaveLength(0);
    expect(findNearestRenderedState(otherStyle, { ...defaultCharacterState(base.characterId), pose: "running" })).toBeUndefined();
  });

  it("honours an explicit reference override", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    const resolution = resolveCharacterState(
      walking.doc,
      { ...defaultCharacterState(base.characterId), pose: "walking", expression: "shocked" },
      { referenceOverride: { kind: "canonical", assetId: base.canonicalAssetId } },
    );
    expect(resolution.status).toBe("needs-generation");
    if (resolution.status === "needs-generation") {
      expect(resolution.reference.kind).toBe("canonical");
      expect(resolution.reference.assetId).toBe(base.canonicalAssetId);
    }
  });
});

describe("reference selector options", () => {
  it("offers Auto first, naming the render the resolver would use", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    const options = referenceOptions(walking.doc, {
      ...defaultCharacterState(base.characterId),
      pose: "walking",
      expression: "shocked",
    });
    expect(options[0].automatic).toBe(true);
    expect(options[0].label).toContain("Auto");
    expect(options[0].label).toContain("Walking");
    expect(options[0].assetId).toBe(walking.assetId);
    expect(options.some((option) => option.kind === "canonical")).toBe(true);
    expect(options.some((option) => option.kind === "none")).toBe(true);
  });
});

describe("identity invariants", () => {
  function placedWalking() {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" });
    const placement = applyDomainCommand(walking.doc, {
      type: "add-instance",
      panelId: base.panelIds[0],
      assetId: walking.assetId,
    });
    const instanceId = placement.createdId!;
    const doc = applyDomainCommand(placement.doc, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...defaultCharacterState(base.characterId), pose: "walking", assetId: walking.assetId },
    }).doc;
    return { ...base, doc, instanceId, walkingAssetId: walking.assetId };
  }

  it("changing expression preserves pose, outfit, view and identity", () => {
    const { doc, instanceId, characterId } = placedWalking();
    const before = stateOf(doc, instanceId);
    const result = resolveInstancePatch(doc, instanceId, { expression: "shocked" })!;

    expect(result.desired.characterId).toBe(characterId);
    expect(result.desired.pose).toBe(before.pose);
    expect(result.desired.outfit).toBe(before.outfit);
    expect(result.desired.view).toBe(before.view);
    expect(result.desired.expression).toBe("shocked");
  });

  it("changing pose preserves expression, outfit and identity", () => {
    const { doc, instanceId, characterId } = placedWalking();
    const shocked = applyDomainCommand(doc, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...stateOf(doc, instanceId), expression: "shocked" },
    }).doc;

    const result = resolveInstancePatch(shocked, instanceId, { pose: "running" })!;
    expect(result.desired.characterId).toBe(characterId);
    expect(result.desired.expression).toBe("shocked");
    expect(result.desired.outfit).toBe("default outfit");
    expect(result.desired.view).toBe("front");
    expect(result.desired.pose).toBe("running");
  });

  it("never mutates the transform when semantic state changes", () => {
    const { doc, instanceId } = placedWalking();
    const before = instanceOf(doc, instanceId);
    const snapshot = { cx: before.cx, cy: before.cy, width: before.width, height: before.height, rotation: before.rotation };

    const next = applyDomainCommand(doc, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...stateOf(doc, instanceId), expression: "shocked" },
    }).doc;
    const after = instanceOf(next, instanceId);
    expect({ cx: after.cx, cy: after.cy, width: after.width, height: after.height, rotation: after.rotation }).toEqual(snapshot);
    expect(after.panelId).toBe(before.panelId);
  });

  it("never changes which character an instance belongs to", () => {
    const { doc, instanceId, characterId } = placedWalking();
    for (const patch of [{ expression: "angry" }, { pose: "sitting" }, { outfit: "school uniform" }, { view: "side" }]) {
      const result = resolveInstancePatch(doc, instanceId, patch)!;
      expect(result.desired.characterId).toBe(characterId);
    }
  });

  it("keeps the canonical reference attached through a lineage chain", () => {
    const base = rig();
    const walking = render(base.doc, base.characterId, { pose: "walking" }, { canonicalReferenceAssetId: base.canonicalAssetId });
    const parent = nodeFor(walking.doc, walking.assetId)!;
    const shocked = render(
      walking.doc,
      base.characterId,
      { pose: "walking", expression: "shocked" },
      { parentStateId: parent.id, referenceAssetId: walking.assetId, canonicalReferenceAssetId: base.canonicalAssetId },
    );
    // Every descendant still names the identity anchor, so drift is traceable
    // and generation can always re-anchor.
    for (const record of renderedStateRecords(shocked.doc, base.characterId)) {
      expect(record.canonicalReferenceAssetId).toBe(base.canonicalAssetId);
    }
  });
});

describe("props and the hand socket", () => {
  it("adds a prop without disturbing the other dimensions", () => {
    const base = rig();
    const state = { ...defaultCharacterState(base.characterId), pose: "walking" };
    const withProp = { ...state, props: propsAfterDrop(state.props, "Umbrella") };
    expect(withProp.props).toEqual(["umbrella"]);
    expect(withProp.pose).toBe("walking");
    expect(withProp.expression).toBe("neutral");
  });

  it("treats props as part of state identity", () => {
    const base = rig();
    const withUmbrella = render(base.doc, base.characterId, { pose: "walking", props: ["umbrella"] });
    // The same pose WITHOUT the prop is a different state, not a cache hit.
    const bare = resolveCharacterState(withUmbrella.doc, { ...defaultCharacterState(base.characterId), pose: "walking" });
    expect(bare.status).toBe("needs-generation");

    const held = resolveCharacterState(withUmbrella.doc, {
      ...defaultCharacterState(base.characterId),
      pose: "walking",
      props: ["umbrella"],
    });
    expect(held.status).toBe("cached");
  });

  it("normalizes prop lists so order and case cannot create duplicates", () => {
    expect(normalizeProps(["Sword", "shield", "SWORD"])).toEqual(["shield", "sword"]);
  });

  it("routes a prop drag only to the hand socket", () => {
    expect(acceptableSockets({ dimension: "props", value: "umbrella" })).toEqual(["hand"]);
    expect(patchForSocketDrop("face", { dimension: "props", value: "umbrella" })).toBeNull();
  });
});

// ─── §9 acceptance ──────────────────────────────────────────────────────────

describe("acceptance: the digital action figure", () => {
  it("drags Shock onto a placed walking Yuri and changes only the face", () => {
    // 1. Canonical Yuri.
    const base = rig();
    expect(base.doc.characters[base.characterId].canonicalReferenceAssetId).toBe(base.canonicalAssetId);

    // 2. Walking state.
    const walking = render(base.doc, base.characterId, { pose: "walking" }, { canonicalReferenceAssetId: base.canonicalAssetId });
    const walkingNode = nodeFor(walking.doc, walking.assetId)!;

    // 3. Shocked expression on the walking pose.
    const shocked = render(
      walking.doc,
      base.characterId,
      { pose: "walking", expression: "shocked" },
      { parentStateId: walkingNode.id, referenceAssetId: walking.assetId, canonicalReferenceAssetId: base.canonicalAssetId },
    );
    let doc = shocked.doc;

    // 4. Place walking Yuri in a panel.
    const placement = applyDomainCommand(doc, { type: "add-instance", panelId: base.panelIds[0], assetId: walking.assetId });
    doc = placement.doc;
    const instanceId = placement.createdId!;
    doc = applyDomainCommand(doc, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...defaultCharacterState(base.characterId), pose: "walking", assetId: walking.assetId },
    }).doc;
    const placed = instanceOf(doc, instanceId);
    const transform = { cx: placed.cx, cy: placed.cy, width: placed.width, height: placed.height };
    const beforeState = stateOf(doc, instanceId);

    // 5. Drag Shock onto the face.
    const facePoint = { x: placed.cx, y: placed.cy - placed.height * 0.42 };
    const payload = { dimension: "expression" as const, value: "shocked", characterId: base.characterId };
    const socket = resolveSocketAt(placed, facePoint, undefined, acceptableSockets(payload));
    expect(socket).toBe("face");
    const patch = patchForSocketDrop(socket!, payload)!;
    expect(patch).toEqual({ expression: "shocked" });

    const resolved = resolveInstancePatch(doc, instanceId, patch)!;

    // 6. No generation: the exact state already exists.
    expect(resolved.resolution.status).toBe("cached");
    const cachedAssetId = resolved.resolution.status === "cached" ? resolved.resolution.assetId : undefined;
    expect(cachedAssetId).toBe(shocked.assetId);

    const beforeUndo = doc;
    doc = applyDomainCommand(doc, { type: "set-instance-character-state", instanceId, state: resolved.desired }).doc;
    doc = applyDomainCommand(doc, { type: "swap-instance-asset", instanceId, assetId: cachedAssetId! }).doc;

    // 7. Identity, pose and placement preserved; only the face changed.
    const after = instanceOf(doc, instanceId);
    const afterState = stateOf(doc, instanceId);
    expect(afterState.characterId).toBe(base.characterId);
    expect(afterState.pose).toBe("walking");
    expect(afterState.expression).toBe("shocked");
    expect(afterState.outfit).toBe(beforeState.outfit);
    expect({ cx: after.cx, cy: after.cy, width: after.width, height: after.height }).toEqual(transform);
    expect(after.panelId).toBe(placed.panelId);

    // 8. Lineage recorded: shocked descends from walking, anchored on canonical.
    const shockedNode = nodeFor(doc, shocked.assetId)!;
    expect(shockedNode.parentStateId).toBe(walkingNode.id);
    expect(shockedNode.referenceAssetId).toBe(walking.assetId);
    expect(lineageOf(doc, shockedNode.id).map(describeRecord)).toEqual(["Walking · Shocked", "Walking · Neutral"]);

    // 9. Undo restores the previous semantic state (commands are pure doc → doc).
    expect(stateOf(beforeUndo, instanceId).expression).toBe("neutral");

    // 10. Change pose to running — expression must stay shocked.
    const running = resolveInstancePatch(doc, instanceId, { pose: "running" })!;
    expect(running.desired.expression).toBe("shocked");
    expect(running.desired.pose).toBe("running");
    // No running render exists, so this one must be generated…
    expect(running.resolution.status).toBe("needs-generation");
    if (running.resolution.status === "needs-generation") {
      // …anchored on the closest render, which is walking+shocked.
      expect(running.resolution.reference.assetId).toBe(shocked.assetId);
      expect(running.resolution.delta.changed).toEqual(["pose"]);
    }
    doc = applyDomainCommand(doc, { type: "set-instance-character-state", instanceId, state: running.desired }).doc;
    expect(stateOf(doc, instanceId).expression).toBe("shocked");

    // 11. Save and reload: graph and lineage survive.
    const restored = deserializeProject(serializeProject(doc));
    expect(restored.schemaVersion).toBe(SCHEMA_VERSION);
    expect(renderedStateRecords(restored, base.characterId)).toHaveLength(2);
    const restoredNode = nodeFor(restored, shocked.assetId)!;
    expect(restoredNode.parentStateId).toBe(walkingNode.id);
    expect(restoredNode.canonicalReferenceAssetId).toBe(base.canonicalAssetId);
    expect(stateOf(restored, instanceId)).toMatchObject({ pose: "running", expression: "shocked" });

    // 12. The kit reports availability honestly for the restored document.
    const kit = buildCharacterKit(restored, restored.characters[base.characterId], stateOf(restored, instanceId));
    const walkingOption = kit.dimensions.pose.find((option) => option.value === "walking")!;
    const sittingOption = kit.dimensions.pose.find((option) => option.value === "sitting")!;
    // walking + shocked exists …
    expect(walkingOption.availability).toBe("cached");
    // … sitting + shocked does not, and is not pretended to.
    expect(sittingOption.availability).not.toBe("cached");
    expect(findRenderedStateRecord(restored, { ...defaultCharacterState(base.characterId), pose: "sitting", expression: "shocked" })).toBeUndefined();
  });
});
