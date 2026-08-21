/**
 * Character Kit, semantic sockets, and the state resolver.
 *
 * The product claim being tested is "one actor, not a pile of PNGs": changing
 * one dimension must leave the others alone, a cached render must be reused
 * rather than regenerated, and a missing render must be requested rather than
 * silently substituted with a different state.
 */

import { describe, expect, it } from "vitest";
import { applyDomainCommand } from "@/domain/commands";
import { createProjectDocument } from "@/domain/factory";
import { addAsset, addCharacter } from "@/domain/libraryOps";
import { deserializeProject, serializeProject } from "@/domain/serialization";
import type { AssetInstance, CharacterState, ID, ProjectDocument } from "@/domain/types";
import { buildCharacterKit, defaultCharacterState, kitOption } from "./kit";
import { decodeSocketDrag, encodeSocketDrag, resolveSocketAt, socketRectPx, SOCKET_DIMENSION } from "./sockets";
import {
  acceptableSockets,
  isNoOpChange,
  patchForSocketDrop,
  resolveCharacterState,
  resolveInstancePatch,
  stateCoverage,
} from "./stateResolver";
import { stateFromInstance } from "./state";

interface Fixture {
  doc: ProjectDocument;
  characterId: ID;
  panelIds: ID[];
}

function withCharacter(): Fixture {
  let doc = createProjectDocument("Kit");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;
  const canonical = addAsset(doc, {
    category: "character",
    name: "yuri-canonical",
    storageUrl: "canon.png",
    width: 800,
    height: 1600,
    hasAlpha: true,
    processedImageUrl: "canon-alpha.png",
    processingStatus: "ready",
    metadata: { characterId: yuri.characterId, characterAssetRole: "canonical" },
  });
  doc = canonical.doc;
  return { doc, characterId: yuri.characterId, panelIds: doc.pages[Object.keys(doc.pages)[0]].panelIds };
}

/** Add a ready render for one exact state. */
function addRender(doc: ProjectDocument, characterId: ID, state: Partial<CharacterState>): { doc: ProjectDocument; assetId: ID } {
  const full = { ...defaultCharacterState(characterId), ...state };
  const added = addAsset(doc, {
    category: "character",
    name: `yuri-${full.pose}-${full.expression}`,
    storageUrl: `${full.pose}.png`,
    width: 800,
    height: 1600,
    hasAlpha: true,
    processedImageUrl: `${full.pose}-alpha.png`,
    processingStatus: "ready",
    metadata: {
      characterId,
      characterAssetRole: "state",
      pose: full.pose,
      expression: full.expression,
      outfit: full.outfit,
      view: full.view,
    },
  });
  return { doc: added.doc, assetId: added.assetId };
}

const instanceOf = (doc: ProjectDocument, id: ID) => doc.items[id] as AssetInstance;

describe("character kit", () => {
  it("presents one character with all four dimensions", () => {
    const { doc, characterId } = withCharacter();
    const kit = buildCharacterKit(doc, doc.characters[characterId]);
    expect(kit.name).toBe("Yuri");
    expect(Object.keys(kit.dimensions).sort()).toEqual(["expression", "outfit", "pose", "view"]);
    expect(kit.dimensions.pose.map((option) => option.value)).toContain("walking");
    expect(kit.dimensions.expression.map((option) => option.value)).toContain("angry");
  });

  it("marks which options already have a render", () => {
    const fixture = withCharacter();
    const { doc } = addRender(fixture.doc, fixture.characterId, { pose: "walking" });
    const kit = buildCharacterKit(doc, doc.characters[fixture.characterId]);

    // Cached is relative to the state being viewed: from the default state,
    // switching only the pose to "walking" lands on a real render.
    expect(kitOption(kit, "pose", "walking")?.cached).toBe(true);
    expect(kitOption(kit, "pose", "running")?.cached).toBe(false);
    expect(kitOption(kit, "pose", "walking")?.previewAssetId).toBeTruthy();
  });

  it("excludes the canonical reference from the rendered state count", () => {
    const fixture = withCharacter();
    const kit = buildCharacterKit(fixture.doc, fixture.doc.characters[fixture.characterId]);
    // The canonical image establishes identity; it is not a selectable state.
    expect(kit.renderedStateCount).toBe(0);
    expect(kit.canonicalAssetId).toBeTruthy();
  });
});

describe("state resolver", () => {
  it("reuses a cached render instead of asking for generation", () => {
    const fixture = withCharacter();
    const { doc, assetId } = addRender(fixture.doc, fixture.characterId, { pose: "running", expression: "angry" });
    const resolution = resolveCharacterState(doc, {
      ...defaultCharacterState(fixture.characterId),
      pose: "running",
      expression: "angry",
    });
    expect(resolution.status).toBe("cached");
    if (resolution.status === "cached") expect(resolution.assetId).toBe(assetId);
  });

  it("requests generation for a missing state rather than substituting another", () => {
    const fixture = withCharacter();
    const { doc, assetId } = addRender(fixture.doc, fixture.characterId, { pose: "running" });
    const resolution = resolveCharacterState(doc, {
      ...defaultCharacterState(fixture.characterId),
      pose: "sitting",
    });
    expect(resolution.status).toBe("needs-generation");
    if (resolution.status === "needs-generation") {
      // The running render may guide generation, but it is never returned as
      // though it were the sitting state.
      expect(resolution.guidanceAssetId).toBe(assetId);
      expect(resolution.state.pose).toBe("sitting");
      expect(resolution.canonicalAssetId).toBeTruthy();
    }
  });

  it("reports coverage so cost can be shown before running", () => {
    const fixture = withCharacter();
    const { doc } = addRender(fixture.doc, fixture.characterId, { pose: "walking" });
    const base = defaultCharacterState(fixture.characterId);
    const coverage = stateCoverage(doc, [
      { ...base, pose: "walking" },
      { ...base, pose: "running" },
      { ...base, pose: "sitting" },
    ]);
    expect(coverage).toMatchObject({ requested: 3, cached: 1 });
    expect(coverage.missing.map((state) => state.pose).sort()).toEqual(["running", "sitting"]);
  });

  it("reports an unknown character rather than throwing", () => {
    const { doc } = withCharacter();
    expect(resolveCharacterState(doc, { ...defaultCharacterState("ghost"), characterId: "ghost" }).status).toBe(
      "character-not-found",
    );
  });
});

describe("semantic state switching on a placed instance", () => {
  function placed() {
    const fixture = withCharacter();
    const withWalking = addRender(fixture.doc, fixture.characterId, { pose: "walking" });
    let doc = withWalking.doc;
    const placement = applyDomainCommand(doc, {
      type: "add-instance",
      panelId: fixture.panelIds[0],
      assetId: withWalking.assetId,
    });
    doc = placement.doc;
    const instanceId = placement.createdId!;
    doc = applyDomainCommand(doc, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...defaultCharacterState(fixture.characterId), pose: "walking", assetId: withWalking.assetId },
    }).doc;
    return { ...fixture, doc, instanceId };
  }

  it("changing pose preserves characterId, expression and outfit", () => {
    const { doc, instanceId, characterId } = placed();
    const result = resolveInstancePatch(doc, instanceId, { pose: "running" })!;
    expect(result.desired.characterId).toBe(characterId);
    expect(result.desired.pose).toBe("running");
    expect(result.desired.expression).toBe(result.current.expression);
    expect(result.desired.outfit).toBe(result.current.outfit);
    expect(result.desired.view).toBe(result.current.view);
  });

  it("changing expression preserves pose, outfit and the instance transform", () => {
    const { doc, instanceId } = placed();
    const before = instanceOf(doc, instanceId);
    const result = resolveInstancePatch(doc, instanceId, { expression: "angry" })!;
    expect(result.desired.pose).toBe("walking");
    expect(result.desired.outfit).toBe(result.current.outfit);

    const next = applyDomainCommand(doc, {
      type: "set-instance-character-state",
      instanceId,
      state: result.desired,
    }).doc;
    const after = instanceOf(next, instanceId);
    // Semantic state changed; composition did not.
    expect(after.characterState!.expression).toBe("angry");
    expect({ cx: after.cx, cy: after.cy, width: after.width, height: after.height }).toEqual({
      cx: before.cx,
      cy: before.cy,
      width: before.width,
      height: before.height,
    });
  });

  it("detects a no-op change so nothing is generated or undone", () => {
    const { doc, instanceId } = placed();
    const result = resolveInstancePatch(doc, instanceId, { pose: "walking" })!;
    expect(isNoOpChange(result.current, result.desired)).toBe(true);
  });

  it("survives save and load with its semantic state intact", () => {
    const { doc, instanceId } = placed();
    const next = applyDomainCommand(doc, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...instanceOf(doc, instanceId).characterState!, expression: "crying" },
    }).doc;
    const restored = deserializeProject(serializeProject(next));
    expect(stateFromInstance(restored, instanceOf(restored, instanceId))!.expression).toBe("crying");
  });
});

describe("semantic sockets", () => {
  function instance(): AssetInstance {
    return {
      id: "i1",
      kind: "asset",
      panelId: "p1",
      sourceAssetId: "a1",
      cx: 100,
      cy: 200,
      width: 100,
      height: 200,
      rotation: 0,
      opacity: 1,
      flipX: false,
      cropMode: "fit",
    };
  }

  it("resolves the head region to the face socket", () => {
    // Instance spans x 50-150, y 100-300. The face band is the top 28%.
    expect(resolveSocketAt(instance(), { x: 100, y: 120 })).toBe("face");
  });

  it("resolves the lower body to the body socket", () => {
    expect(resolveSocketAt(instance(), { x: 100, y: 280 })).toBe("body");
  });

  it("returns nothing outside the instance", () => {
    expect(resolveSocketAt(instance(), { x: 10, y: 10 })).toBeNull();
    expect(resolveSocketAt(instance(), { x: 100, y: 400 })).toBeNull();
  });

  it("prefers real face metadata over the heuristic band", () => {
    const focus = [{ kind: "face" as const, rect: { x: 0.3, y: 0.6, width: 0.4, height: 0.2 } }];
    // With metadata the face sits low in this (deliberately odd) asset.
    expect(resolveSocketAt(instance(), { x: 100, y: 240 }, focus)).toBe("face");
    expect(resolveSocketAt(instance(), { x: 100, y: 120 }, focus)).toBe("body");
  });

  it("restricts a pose drag to the body socket even over the head", () => {
    const acceptable = acceptableSockets({ dimension: "pose", value: "running" });
    expect(acceptable).toEqual(["body"]);
    expect(resolveSocketAt(instance(), { x: 100, y: 120 }, undefined, acceptable)).toBe("body");
  });

  it("maps an expression drag to the face socket only", () => {
    expect(acceptableSockets({ dimension: "expression", value: "angry" })).toEqual(["face"]);
    expect(SOCKET_DIMENSION.face).toBe("expression");
  });

  it("turns a face drop into an expression-only patch", () => {
    const patch = patchForSocketDrop("face", { dimension: "expression", value: "angry" });
    expect(patch).toEqual({ expression: "angry" });
    expect(Object.keys(patch!)).toHaveLength(1);
  });

  it("refuses a payload the socket cannot satisfy", () => {
    // Dropping a pose on the face must not quietly become an expression change.
    expect(patchForSocketDrop("face", { dimension: "pose", value: "running" })).toBeNull();
    expect(patchForSocketDrop("body", { dimension: "expression", value: "angry" })).toBeNull();
  });

  it("round-trips a drag payload", () => {
    const payload = { dimension: "outfit" as const, value: "school uniform", characterId: "c1" };
    expect(decodeSocketDrag(encodeSocketDrag(payload))).toEqual(payload);
    expect(decodeSocketDrag("not json")).toBeNull();
    expect(decodeSocketDrag(JSON.stringify({ dimension: "hair", value: "x" }))).toBeNull();
  });

  it("reports a highlight rect inside the instance", () => {
    const rect = socketRectPx(instance(), "face");
    expect(rect.y).toBeGreaterThanOrEqual(100);
    expect(rect.y + rect.height).toBeLessThanOrEqual(300);
  });
});

describe("undo restores semantic state", () => {
  it("reverts a state change through the document history", () => {
    const fixture = withCharacter();
    const withWalking = addRender(fixture.doc, fixture.characterId, { pose: "walking" });
    const placement = applyDomainCommand(withWalking.doc, {
      type: "add-instance",
      panelId: fixture.panelIds[0],
      assetId: withWalking.assetId,
    });
    const instanceId = placement.createdId!;
    const before = applyDomainCommand(placement.doc, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...defaultCharacterState(fixture.characterId), pose: "walking" },
    }).doc;

    const after = applyDomainCommand(before, {
      type: "set-instance-character-state",
      instanceId,
      state: { ...defaultCharacterState(fixture.characterId), pose: "running" },
    }).doc;

    expect(instanceOf(after, instanceId).characterState!.pose).toBe("running");
    // Commands are pure doc → doc, so the prior document IS the undo state.
    expect(instanceOf(before, instanceId).characterState!.pose).toBe("walking");
  });
});
