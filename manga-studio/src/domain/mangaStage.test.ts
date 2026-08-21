/**
 * Virtual manga stage: camera, perspective, depth, effects, and bubble targets.
 *
 * These exercise real document operations through the command layer, not the
 * type system — a compiling model proves nothing about whether a preset
 * survives a save or whether a tail follows its speaker.
 */

import { describe, expect, it } from "vitest";
import { applyDomainCommand } from "./commands";
import { panelPxRect } from "./docHelpers";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import { deserializeProject, serializeProject } from "./serialization";
import { createPanelCamera, cameraMatchesPresets, describeCamera } from "./camera";
import { createPanelPerspective, perspectiveGuideLines, vanishingPointCount } from "./perspective";
import { depthScale, FAR_PLANE_SCALE } from "./stage";
import { defaultEffectParams, normalizeEffectParams, suggestSpeedLineDirection } from "./effects";
import { poseMotionVector } from "@/characters/poseRig";
import { SCHEMA_VERSION, type AssetInstance, type EffectItem, type ProjectDocument, type SpeechBubbleItem } from "./types";

function studio() {
  let doc = createProjectDocument("Stage");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;
  const render = addAsset(doc, {
    category: "character",
    name: "yuri-walking",
    storageUrl: "yuri.png",
    width: 800,
    height: 1600,
    hasAlpha: true,
    processedImageUrl: "yuri-alpha.png",
    processingStatus: "ready",
    metadata: { characterId: yuri.characterId, characterAssetRole: "state", pose: "walking" },
  });
  doc = render.doc;
  const panelIds = doc.pages[Object.keys(doc.pages)[0]].panelIds;
  return { doc, characterId: yuri.characterId, assetId: render.assetId, panelIds };
}

const instanceOf = (doc: ProjectDocument, id: string) => doc.items[id] as AssetInstance;

describe("panel camera", () => {
  it("gives every new panel a neutral camera", () => {
    const { doc, panelIds } = studio();
    const camera = doc.panels[panelIds[0]].camera!;
    expect(camera).toMatchObject({ shot: "medium", angle: "eye-level", lens: "normal", mangaPerspectiveStrength: 0 });
    expect(camera.horizonY).toBe(0.5);
    expect(cameraMatchesPresets(camera)).toBe(true);
  });

  it("derives geometry from angle and lens presets", () => {
    const { doc, panelIds } = studio();
    const low = applyDomainCommand(doc, {
      type: "set-panel-camera",
      panelId: panelIds[0],
      patch: { shot: "close-up", angle: "low", lens: "telephoto" },
    }).doc;
    const camera = low.panels[panelIds[0]].camera!;
    expect(camera.shot).toBe("close-up");
    // A low angle looks up: horizon rises in frame and pitch tips upward.
    expect(camera.pitch).toBeGreaterThan(0);
    expect(camera.horizonY).toBeLessThan(0.5);
    expect(camera.fov).toBeLessThan(50);
    expect(describeCamera(camera)).toContain("close up");
  });

  it("keeps a hand-set advanced value when the preset later changes", () => {
    const { doc, panelIds } = studio();
    let next = applyDomainCommand(doc, {
      type: "set-panel-camera",
      panelId: panelIds[0],
      patch: { pitch: 41 },
    }).doc;
    expect(next.panels[panelIds[0]].camera!.pitch).toBe(41);
    expect(cameraMatchesPresets(next.panels[panelIds[0]].camera!)).toBe(false);

    // Changing the lens must not resurrect the preset pitch.
    next = applyDomainCommand(next, {
      type: "set-panel-camera",
      panelId: panelIds[0],
      patch: { lens: "wide" },
    }).doc;
    expect(next.panels[panelIds[0]].camera!.pitch).toBe(41);
    expect(next.panels[panelIds[0]].camera!.fov).toBe(84);
  });

  it("clamps manga perspective strength to its documented range", () => {
    const { doc, panelIds } = studio();
    const next = applyDomainCommand(doc, {
      type: "set-panel-camera",
      panelId: panelIds[0],
      patch: { mangaPerspectiveStrength: 99 },
    }).doc;
    expect(next.panels[panelIds[0]].camera!.mangaPerspectiveStrength).toBe(3);
  });

  it("serializes camera presets across save and load", () => {
    const { doc, panelIds } = studio();
    const configured = applyDomainCommand(doc, {
      type: "set-panel-camera",
      panelId: panelIds[0],
      patch: { shot: "extreme-close-up", angle: "dutch", lens: "wide", mangaPerspectiveStrength: 2 },
    }).doc;
    const restored = deserializeProject(serializeProject(configured));
    expect(restored.panels[panelIds[0]].camera).toEqual(configured.panels[panelIds[0]].camera);
    expect(restored.panels[panelIds[0]].camera!.roll).not.toBe(0);
  });
});

describe("panel perspective", () => {
  it("creates the right number of vanishing points per type", () => {
    for (const type of ["none", "one-point", "two-point", "three-point"] as const) {
      expect(createPanelPerspective(type).vanishingPoints).toHaveLength(vanishingPointCount(type));
    }
  });

  it("keeps two-point vanishing points outside the frame by default", () => {
    const perspective = createPanelPerspective("two-point", 0.5);
    // Convergence inside the panel reads as distortion, not as a room.
    expect(perspective.vanishingPoints.every((vp) => vp.x < 0 || vp.x > 1)).toBe(true);
  });

  it("moves horizontal vanishing points with the horizon but leaves the vertical one", () => {
    const { doc, panelIds } = studio();
    let next = applyDomainCommand(doc, {
      type: "set-panel-perspective",
      panelId: panelIds[0],
      patch: { type: "three-point", horizonY: 0.5 },
    }).doc;
    const before = next.panels[panelIds[0]].perspective!;
    const verticalBefore = before.vanishingPoints[2].y;

    next = applyDomainCommand(next, {
      type: "set-panel-perspective",
      panelId: panelIds[0],
      patch: { horizonY: 0.8 },
    }).doc;
    const after = next.panels[panelIds[0]].perspective!;
    expect(after.vanishingPoints[0].y).toBeCloseTo(0.8);
    expect(after.vanishingPoints[1].y).toBeCloseTo(0.8);
    expect(after.vanishingPoints[2].y).toBeCloseTo(verticalBefore);
  });

  it("lets a vanishing point be dragged outside the panel", () => {
    const { doc, panelIds } = studio();
    let next = applyDomainCommand(doc, {
      type: "set-panel-perspective",
      panelId: panelIds[0],
      patch: { type: "one-point" },
    }).doc;
    next = applyDomainCommand(next, {
      type: "move-vanishing-point",
      panelId: panelIds[0],
      index: 0,
      point: { x: -2.4, y: 0.3 },
    }).doc;
    expect(next.panels[panelIds[0]].perspective!.vanishingPoints[0]).toEqual({ x: -2.4, y: 0.3 });
  });

  it("produces guides only while visible, and never as page content", () => {
    const hidden = createPanelPerspective("two-point");
    expect(perspectiveGuideLines(hidden).length).toBeGreaterThan(0);
    expect(perspectiveGuideLines({ ...hidden, visible: false })).toHaveLength(0);
    expect(perspectiveGuideLines(createPanelPerspective("none"))).toHaveLength(0);
  });

  it("keeps guides out of the document's rendered items", () => {
    const { doc, panelIds } = studio();
    const next = applyDomainCommand(doc, {
      type: "set-panel-perspective",
      panelId: panelIds[0],
      patch: { type: "two-point", visible: true },
    }).doc;
    // Guides live on the panel as editor data; export walks items, and no item
    // was created. This is the structural guarantee behind §10.
    expect(next.panels[panelIds[0]].itemIds).toHaveLength(0);
    expect(Object.values(next.items)).toHaveLength(0);
  });
});

describe("depth stage", () => {
  it("shrinks a character pushed away from the camera", () => {
    const { doc, characterId, assetId, panelIds } = studio();
    void characterId;
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[0], assetId });
    const instanceId = placed.createdId!;
    const nearHeight = instanceOf(placed.doc, instanceId).height;

    const far = applyDomainCommand(placed.doc, {
      type: "set-instance-stage",
      instanceId,
      patch: { depth: 1 },
    }).doc;
    expect(instanceOf(far, instanceId).height).toBeLessThan(nearHeight);
    expect(depthScale(1)).toBeCloseTo(FAR_PLANE_SCALE);
  });

  it("keeps the ground anchor fixed while depth changes size", () => {
    const { doc, assetId, panelIds } = studio();
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[0], assetId });
    const instanceId = placed.createdId!;
    const deep = applyDomainCommand(placed.doc, {
      type: "set-instance-stage",
      instanceId,
      patch: { depth: 0.9, groundY: 0.8 },
    }).doc;
    const instance = instanceOf(deep, instanceId);
    const panelHeight = panelPxRect(deep, panelIds[0]).height;
    // Feet stay on the ground line rather than sliding up the frame.
    expect(instance.cy + instance.height / 2).toBeCloseTo(0.8 * panelHeight, 0);
  });

  it("stops driving size once the creator resizes by hand", () => {
    const { doc, assetId, panelIds } = studio();
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[0], assetId });
    const instanceId = placed.createdId!;
    let next = applyDomainCommand(placed.doc, { type: "set-instance-stage", instanceId, patch: { depth: 0.2 } }).doc;
    next = applyDomainCommand(next, {
      type: "update-instance-transform",
      instanceId,
      patch: { width: 500, height: 900 },
    }).doc;
    next = applyDomainCommand(next, { type: "set-instance-stage", instanceId, patch: { scaleLocked: true } }).doc;
    next = applyDomainCommand(next, { type: "set-instance-stage", instanceId, patch: { depth: 1 } }).doc;
    expect(instanceOf(next, instanceId).height).toBe(900);
  });

  it("leaves instances without depth on pure free transform", () => {
    const { doc, assetId, panelIds } = studio();
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[0], assetId });
    expect(instanceOf(placed.doc, placed.createdId!).stage).toBeUndefined();
  });

  it("survives save and load", () => {
    const { doc, assetId, panelIds } = studio();
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[0], assetId });
    const staged = applyDomainCommand(placed.doc, {
      type: "set-instance-stage",
      instanceId: placed.createdId!,
      patch: { depth: 0.73, groundY: 0.61, anchor: "feet" },
    }).doc;
    const restored = deserializeProject(serializeProject(staged));
    expect(instanceOf(restored, placed.createdId!).stage).toMatchObject({
      depth: 0.73,
      groundY: 0.61,
      anchor: "feet",
    });
  });
});

describe("structured manga effects", () => {
  it("creates typed params and keeps them editable", () => {
    const { doc, panelIds } = studio();
    const created = applyDomainCommand(doc, {
      type: "add-effect",
      panelId: panelIds[0],
      effectKind: "speed-lines",
    });
    const effectId = created.createdId!;
    expect((created.doc.items[effectId] as EffectItem).params).toEqual(defaultEffectParams("speed-lines"));

    const edited = applyDomainCommand(created.doc, {
      type: "set-effect-params",
      itemId: effectId,
      patch: { density: 0.9, direction: 1.2 },
    }).doc;
    const params = (edited.items[effectId] as EffectItem).params;
    expect(params).toMatchObject({ kind: "speed-lines", density: 0.9, direction: 1.2 });
    // Untouched fields keep their values — editing one control is not a reset.
    expect(params).toMatchObject({ length: 0.7, spread: 0.25 });
  });

  it("clamps out-of-range edits instead of storing nonsense", () => {
    const { doc, panelIds } = studio();
    const created = applyDomainCommand(doc, { type: "add-effect", panelId: panelIds[0], effectKind: "focus-lines" });
    const edited = applyDomainCommand(created.doc, {
      type: "set-effect-params",
      itemId: created.createdId!,
      patch: { intensity: 42 },
    }).doc;
    expect((edited.items[created.createdId!] as EffectItem).params).toMatchObject({ intensity: 1 });
  });

  it("normalizes legacy untyped params", () => {
    // Pre-v7 documents stored a loose bag with different field names.
    const normalized = normalizeEffectParams("screentone", { spacing: 10, dotRadius: 1.6, unknown: "x" });
    expect(normalized.kind).toBe("screentone");
    expect(normalized).toHaveProperty("dotSize");
    expect(normalized).not.toHaveProperty("dotRadius");
  });

  it("attaches an effect to the subject it describes", () => {
    const { doc, assetId, panelIds } = studio();
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[0], assetId });
    const effect = applyDomainCommand(placed.doc, {
      type: "add-effect",
      panelId: panelIds[0],
      effectKind: "speed-lines",
    });
    const attached = applyDomainCommand(effect.doc, {
      type: "set-effect-target",
      itemId: effect.createdId!,
      targetItemId: placed.createdId!,
    }).doc;
    expect((attached.items[effect.createdId!] as EffectItem).targetItemId).toBe(placed.createdId);
  });

  it("suggests speed-line direction from pose motion, and stays silent for static poses", () => {
    expect(suggestSpeedLineDirection(poseMotionVector("running"))).not.toBeNull();
    expect(suggestSpeedLineDirection(poseMotionVector("standing"))).toBeNull();
    expect(suggestSpeedLineDirection(poseMotionVector("unknown-pose"))).toBeNull();
  });

  it("refuses an effect targeting itself", () => {
    const { doc, panelIds } = studio();
    const effect = applyDomainCommand(doc, { type: "add-effect", panelId: panelIds[0], effectKind: "impact-burst" });
    expect(() =>
      applyDomainCommand(effect.doc, {
        type: "set-effect-target",
        itemId: effect.createdId!,
        targetItemId: effect.createdId!,
      }),
    ).toThrow();
  });
});

describe("semantic bubbles", () => {
  it("keeps the tail on the speaker after the speaker moves", () => {
    const { doc, characterId, assetId, panelIds } = studio();
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[0], assetId });
    const instanceId = placed.createdId!;
    const bubble = applyDomainCommand(placed.doc, {
      type: "add-bubble",
      panelId: panelIds[0],
      bubbleType: "speech",
      text: "Hello",
    });
    let next = applyDomainCommand(bubble.doc, {
      type: "set-bubble-target",
      itemId: bubble.createdId!,
      characterId,
      instanceId,
    }).doc;
    const firstTail = (next.items[bubble.createdId!] as SpeechBubbleItem).tail!;

    next = applyDomainCommand(next, {
      type: "update-instance-transform",
      instanceId,
      patch: { cx: instanceOf(next, instanceId).cx + 220 },
    }).doc;
    next = applyDomainCommand(next, { type: "refresh-bubble-tails", panelId: panelIds[0] }).doc;

    const movedTail = (next.items[bubble.createdId!] as SpeechBubbleItem).tail!;
    expect(movedTail.x).toBeCloseTo(firstTail.x + 220);
    expect((next.items[bubble.createdId!] as SpeechBubbleItem).targetCharacterId).toBe(characterId);
  });

  it("never repositions an untargeted bubble", () => {
    const { doc, assetId, panelIds } = studio();
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[0], assetId });
    const bubble = applyDomainCommand(placed.doc, {
      type: "add-bubble",
      panelId: panelIds[0],
      bubbleType: "speech",
      text: "Manual",
    });
    const manual = applyDomainCommand(bubble.doc, {
      type: "update-bubble",
      itemId: bubble.createdId!,
      patch: { tail: { x: 12, y: 34 } },
    }).doc;
    const refreshed = applyDomainCommand(manual, { type: "refresh-bubble-tails", panelId: panelIds[0] }).doc;
    // A hand-placed tail is the creator's decision.
    expect((refreshed.items[bubble.createdId!] as SpeechBubbleItem).tail).toEqual({ x: 12, y: 34 });
  });

  it("refuses a speaker in a different panel", () => {
    const { doc, assetId, panelIds } = studio();
    const placed = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[1], assetId });
    const bubble = applyDomainCommand(placed.doc, {
      type: "add-bubble",
      panelId: panelIds[0],
      bubbleType: "speech",
      text: "Across panels",
    });
    expect(() =>
      applyDomainCommand(bubble.doc, {
        type: "set-bubble-target",
        itemId: bubble.createdId!,
        instanceId: placed.createdId!,
      }),
    ).toThrow(/share a panel/);
  });
});

describe("backward compatibility", () => {
  it("migrates a v6 project into the stage model without changing its look", () => {
    const { doc, assetId, panelIds } = studio();
    const withContent = applyDomainCommand(doc, { type: "add-instance", panelId: panelIds[0], assetId }).doc;

    // Simulate a document written before the stage existed.
    const legacy = JSON.parse(serializeProject(withContent)) as Record<string, unknown>;
    legacy.schemaVersion = 6;
    for (const panel of Object.values(legacy.panels as Record<string, Record<string, unknown>>)) {
      delete panel.camera;
      delete panel.perspective;
    }
    const legacyItems = legacy.items as Record<string, Record<string, unknown>>;
    legacyItems["legacy-effect"] = {
      id: "legacy-effect",
      kind: "effect",
      panelId: panelIds[0],
      effectKind: "screentone",
      params: { spacing: 10, dotRadius: 1.6 },
      cx: 10,
      cy: 10,
      width: 100,
      height: 100,
      rotation: 0,
      opacity: 1,
    };
    (legacy.panels as Record<string, { itemIds: string[] }>)[panelIds[0]].itemIds.push("legacy-effect");

    const migrated = deserializeProject(JSON.stringify(legacy));

    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.panels[panelIds[0]].camera).toEqual(createPanelCamera());
    expect(migrated.panels[panelIds[0]].perspective!.type).toBe("none");
    // Existing artwork is untouched.
    expect(Object.keys(migrated.items)).toHaveLength(2);
    // The loose effect bag became typed without losing the effect.
    const effect = migrated.items["legacy-effect"] as EffectItem;
    expect(effect.params.kind).toBe("screentone");
    expect(effect.params).toHaveProperty("dotSize");
  });
});
