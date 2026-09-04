/**
 * Camera and perspective as VISIBLE composition, not metadata.
 *
 * Phase 1 shipped a camera model nothing read. Every test here asserts a real
 * geometric consequence — a size, a position, a draw order — because a control
 * that only changes a stored value is precisely the failure this phase exists
 * to fix.
 */

import { describe, expect, it } from "vitest";
import { applyDomainCommand } from "./commands";
import { panelPxRect } from "./docHelpers";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import { deserializeProject, serializeProject } from "./serialization";
import { perspectiveGuideLines } from "./perspective";
import {
  cameraChangeRequiresRedraw,
  cameraGenerationContext,
  groundLineFor,
  isAirborne,
  lensDepthExponent,
  mangaDepthExponent,
  groundPointForDepth,
  projectedDepthScale,
  shotGenerationContext,
} from "./staging";
import { focalInstance } from "./stageOps";
import { createPanelCamera } from "./camera";
import { SCHEMA_VERSION, type AssetInstance, type ID, type ProjectDocument } from "./types";

function stage() {
  let doc = createProjectDocument("Stage5");
  const mio = addCharacter(doc, "Mio");
  doc = mio.doc;
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;

  const make = (characterId: ID, name: string, pose = "standing") => {
    const added = addAsset(doc, {
      category: "character",
      name,
      storageUrl: `${name}.png`,
      width: 800,
      height: 1600,
      hasAlpha: true,
      processedImageUrl: `${name}-a.png`,
      processingStatus: "ready",
      metadata: { characterId, characterAssetRole: "state", pose },
    });
    doc = added.doc;
    return added.assetId;
  };
  const mioAsset = make(mio.characterId, "mio");
  const yuriAsset = make(yuri.characterId, "yuri");
  const jumpAsset = make(yuri.characterId, "yuri-jump", "jumping");

  return {
    doc,
    mioId: mio.characterId,
    yuriId: yuri.characterId,
    mioAsset,
    yuriAsset,
    jumpAsset,
    panelIds: doc.pages[Object.keys(doc.pages)[0]].panelIds,
  };
}

const inst = (doc: ProjectDocument, id: ID) => doc.items[id] as AssetInstance;
const feetY = (i: AssetInstance) => i.cy + i.height / 2;

function place(doc: ProjectDocument, panelId: ID, assetId: ID, characterId: ID, pose = "standing") {
  const placed = applyDomainCommand(doc, { type: "add-instance", panelId, assetId });
  const id = placed.createdId!;
  const next = applyDomainCommand(placed.doc, {
    type: "set-instance-character-state",
    instanceId: id,
    state: { characterId, pose, expression: "neutral", outfit: "default outfit", view: "front" },
  }).doc;
  return { doc: next, id };
}

describe("projection model", () => {
  it("shrinks with depth, monotonically", () => {
    const camera = createPanelCamera();
    const near = projectedDepthScale(0, camera);
    const mid = projectedDepthScale(0.5, camera);
    const far = projectedDepthScale(1, camera);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(near).toBeCloseTo(1);
  });

  it("makes a wide lens exaggerate depth and a telephoto flatten it", () => {
    const wide = createPanelCamera({ lens: "wide" });
    const tele = createPanelCamera({ lens: "telephoto" });
    expect(lensDepthExponent(wide)).toBeGreaterThan(1);
    expect(lensDepthExponent(tele)).toBeLessThan(1);
    // At the same depth, wide-angle pushes the subject smaller than telephoto.
    expect(projectedDepthScale(0.8, wide)).toBeLessThan(projectedDepthScale(0.8, tele));
  });

  it("keeps manga perspective separate from optics and neutral at zero", () => {
    expect(mangaDepthExponent(0)).toBe(1);
    expect(mangaDepthExponent(3)).toBeGreaterThan(mangaDepthExponent(1));
    const plain = createPanelCamera();
    const dramatic = createPanelCamera({ mangaPerspectiveStrength: 3 });
    expect(projectedDepthScale(0.5, plain)).toEqual(projectedDepthScale(0.5, createPanelCamera()));
    expect(projectedDepthScale(0.8, dramatic)).toBeLessThan(projectedDepthScale(0.8, plain));
  });

  it("moves the ground line with the camera's eye level", () => {
    expect(groundLineFor(createPanelCamera({ angle: "low" }))).toBeLessThan(
      groundLineFor(createPanelCamera({ angle: "high" })),
    );
  });
});

describe("depth is visible", () => {
  it("makes a foreground character larger than a background one", () => {
    const s = stage();
    let doc = s.doc;
    const mio = place(doc, s.panelIds[0], s.mioAsset, s.mioId);
    doc = mio.doc;
    const yuri = place(doc, s.panelIds[0], s.yuriAsset, s.yuriId);
    doc = yuri.doc;

    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: mio.id, patch: { depth: 0.15 } }).doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: yuri.id, patch: { depth: 0.85 } }).doc;

    expect(inst(doc, mio.id).height).toBeGreaterThan(inst(doc, yuri.id).height);
  });

  it("keeps both characters' feet on the same ground line", () => {
    const s = stage();
    let doc = s.doc;
    const mio = place(doc, s.panelIds[0], s.mioAsset, s.mioId);
    doc = mio.doc;
    const yuri = place(doc, s.panelIds[0], s.yuriAsset, s.yuriId);
    doc = yuri.doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: mio.id, patch: { depth: 0.1 } }).doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: yuri.id, patch: { depth: 0.9 } }).doc;

    // Different sizes, same floor — the property that makes it read as one space.
    expect(feetY(inst(doc, mio.id))).toBeCloseTo(feetY(inst(doc, yuri.id)), 1);
  });

  it("does not let a character float when it moves deeper", () => {
    const s = stage();
    const { doc: placedDoc, id } = place(s.doc, s.panelIds[0], s.yuriAsset, s.yuriId);
    let doc = applyDomainCommand(placedDoc, { type: "set-instance-stage", instanceId: id, patch: { depth: 0.2 } }).doc;
    const before = feetY(inst(doc, id));
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: id, patch: { depth: 0.9 } }).doc;
    expect(feetY(inst(doc, id))).toBeCloseTo(before, 1);
  });

  it("lets an airborne pose leave the ground", () => {
    expect(isAirborne("jumping")).toBe(true);
    expect(isAirborne("walking")).toBe(false);
    expect(isAirborne("standing", ["right leg lifted"])).toBe(true);

    const s = stage();
    const { doc: placedDoc, id } = place(s.doc, s.panelIds[0], s.jumpAsset, s.yuriId, "jumping");
    const before = inst(placedDoc, id);
    const doc = applyDomainCommand(placedDoc, {
      type: "set-instance-stage",
      instanceId: id,
      patch: { depth: 0.9 },
    }).doc;
    const after = inst(doc, id);
    // Size still follows depth, but the character is not yanked to the floor.
    expect(after.height).toBeLessThan(before.height);
    expect(after.cy).toBeCloseTo(before.cy);
  });
});

describe("depth ordering", () => {
  function twoCharacters() {
    const s = stage();
    let doc = s.doc;
    const yuri = place(doc, s.panelIds[0], s.yuriAsset, s.yuriId);
    doc = yuri.doc;
    const mio = place(doc, s.panelIds[0], s.mioAsset, s.mioId);
    doc = mio.doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: yuri.id, patch: { depth: 0.85 } }).doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: mio.id, patch: { depth: 0.15 } }).doc;
    return { ...s, doc, yuriInstance: yuri.id, mioInstance: mio.id };
  }

  it("draws the nearer character over the farther one when auto ordering is on", () => {
    const t = twoCharacters();
    const doc = applyDomainCommand(t.doc, {
      type: "set-panel-auto-depth-order",
      panelId: t.panelIds[0],
      enabled: true,
    }).doc;
    const order = doc.panels[t.panelIds[0]].itemIds;
    // Later in the array = drawn on top.
    expect(order.indexOf(t.mioInstance)).toBeGreaterThan(order.indexOf(t.yuriInstance));
  });

  it("respects manual layer order when auto ordering is off", () => {
    const t = twoCharacters();
    // Default is off, so a manual reorder must survive a depth change.
    const reordered = applyDomainCommand(t.doc, {
      type: "reorder-instance",
      instanceId: t.yuriInstance,
      direction: "front",
    }).doc;
    const manual = reordered.panels[t.panelIds[0]].itemIds;
    expect(manual.indexOf(t.yuriInstance)).toBeGreaterThan(manual.indexOf(t.mioInstance));

    const afterDepth = applyDomainCommand(reordered, {
      type: "set-instance-stage",
      instanceId: t.mioInstance,
      patch: { depth: 0.05 },
    }).doc;
    // Manual override holds even though Mio is now nearest.
    const after = afterDepth.panels[t.panelIds[0]].itemIds;
    expect(after.indexOf(t.yuriInstance)).toBeGreaterThan(after.indexOf(t.mioInstance));
  });

  it("re-sorts on depth change while auto ordering is on", () => {
    const t = twoCharacters();
    let doc = applyDomainCommand(t.doc, {
      type: "set-panel-auto-depth-order",
      panelId: t.panelIds[0],
      enabled: true,
    }).doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: t.yuriInstance, patch: { depth: 0.05 } }).doc;
    const order = doc.panels[t.panelIds[0]].itemIds;
    expect(order.indexOf(t.yuriInstance)).toBeGreaterThan(order.indexOf(t.mioInstance));
  });

  it("leaves bubbles and effects where they are", () => {
    const t = twoCharacters();
    let doc = applyDomainCommand(t.doc, {
      type: "add-bubble",
      panelId: t.panelIds[0],
      bubbleType: "speech",
      text: "hi",
    }).doc;
    doc = applyDomainCommand(doc, { type: "set-panel-auto-depth-order", panelId: t.panelIds[0], enabled: true }).doc;
    const items = doc.panels[t.panelIds[0]].itemIds.map((id) => doc.items[id].kind);
    // The bubble keeps its position in the stack; only staged assets move.
    expect(items[items.length - 1]).toBe("bubble");
  });
});

describe("camera framing is visible", () => {
  function framed() {
    const s = stage();
    const { doc, id } = place(s.doc, s.panelIds[0], s.yuriAsset, s.yuriId);
    return { ...s, doc, instanceId: id };
  }

  it("makes a close-up dramatically larger than a full shot", () => {
    const f = framed();
    const full = applyDomainCommand(f.doc, {
      type: "set-panel-camera",
      panelId: f.panelIds[0],
      patch: { shot: "full" },
    }).doc;
    const close = applyDomainCommand(full, {
      type: "set-panel-camera",
      panelId: f.panelIds[0],
      patch: { shot: "close-up" },
    }).doc;
    expect(inst(close, f.instanceId).height).toBeGreaterThan(inst(full, f.instanceId).height * 2);
  });

  it("frames a close-up on the head rather than the middle of the body", () => {
    const f = framed();
    const close = applyDomainCommand(f.doc, {
      type: "set-panel-camera",
      panelId: f.panelIds[0],
      patch: { shot: "close-up" },
    }).doc;
    const instance = inst(close, f.instanceId);
    const rect = panelPxRect(close, f.panelIds[0]);
    // The head band sits near the panel centre; the feet are far below frame.
    const headY = instance.cy - instance.height * 0.38;
    expect(Math.abs(headY - rect.height / 2)).toBeLessThan(rect.height * 0.35);
    expect(feetY(instance)).toBeGreaterThan(rect.height);
  });

  it("fits the whole body for a full shot", () => {
    const f = framed();
    const full = applyDomainCommand(f.doc, {
      type: "set-panel-camera",
      panelId: f.panelIds[0],
      patch: { shot: "full" },
    }).doc;
    const instance = inst(full, f.instanceId);
    const rect = panelPxRect(full, f.panelIds[0]);
    expect(instance.height).toBeLessThanOrEqual(rect.height);
  });

  it("frames the focal subject, not whichever character happens to be last", () => {
    const s = stage();
    let doc = s.doc;
    const yuri = place(doc, s.panelIds[0], s.yuriAsset, s.yuriId);
    doc = yuri.doc;
    const mio = place(doc, s.panelIds[0], s.mioAsset, s.mioId);
    doc = mio.doc;

    doc = applyDomainCommand(doc, { type: "set-panel-focal-item", panelId: s.panelIds[0], itemId: yuri.id }).doc;
    expect(focalInstance(doc, s.panelIds[0])!.id).toBe(yuri.id);

    const before = inst(doc, mio.id).height;
    doc = applyDomainCommand(doc, { type: "set-panel-camera", panelId: s.panelIds[0], patch: { shot: "close-up" } }).doc;
    // Yuri was reframed; Mio was left alone.
    expect(inst(doc, yuri.id).height).toBeGreaterThan(before);
    expect(inst(doc, mio.id).height).toBe(before);
  });

  it("falls back to the last character when no focal subject is set", () => {
    const s = stage();
    let doc = s.doc;
    const yuri = place(doc, s.panelIds[0], s.yuriAsset, s.yuriId);
    doc = yuri.doc;
    const mio = place(doc, s.panelIds[0], s.mioAsset, s.mioId);
    doc = mio.doc;
    expect(focalInstance(doc, s.panelIds[0])!.id).toBe(mio.id);
  });

  it("stores a generative angle as intent WITHOUT faking the shift (Phase 4.5 §19)", () => {
    const f = framed();
    const low = applyDomainCommand(f.doc, {
      type: "set-panel-camera",
      panelId: f.panelIds[0],
      patch: { shot: "medium", angle: "low" },
    }).doc;
    const high = applyDomainCommand(f.doc, {
      type: "set-panel-camera",
      panelId: f.panelIds[0],
      patch: { shot: "medium", angle: "high" },
    }).doc;
    // The REQUESTED camera is stored…
    expect(low.panels[f.panelIds[0]].camera!.angle).toBe("low");
    expect(high.panels[f.panelIds[0]].camera!.angle).toBe("high");
    // …but the old artwork never performs a fake angle shift: both panels
    // stage identically under the LOCAL part of each patch (the medium
    // tightening), and the redraw is left to Generate Camera View.
    expect(inst(low, f.instanceId).cy).toBeCloseTo(inst(high, f.instanceId).cy, 5);
  });

  it("moves the camera horizon when the angle changes", () => {
    const f = framed();
    const low = applyDomainCommand(f.doc, {
      type: "set-panel-camera",
      panelId: f.panelIds[0],
      patch: { angle: "low" },
    }).doc;
    expect(low.panels[f.panelIds[0]].camera!.horizonY).toBeLessThan(0.5);
    expect(low.panels[f.panelIds[0]].camera!.pitch).toBeGreaterThan(0);
  });

  it("re-projects staged characters when the lens changes", () => {
    const f = framed();
    let doc = applyDomainCommand(f.doc, {
      type: "set-instance-stage",
      instanceId: f.instanceId,
      patch: { depth: 0.8 },
    }).doc;
    const before = inst(doc, f.instanceId).height;
    doc = applyDomainCommand(doc, { type: "set-panel-camera", panelId: f.panelIds[0], patch: { lens: "wide" } }).doc;
    // A wide lens exaggerates falloff, so a distant character gets smaller.
    expect(inst(doc, f.instanceId).height).toBeLessThan(before);
  });
});

describe("transform vs redraw boundary", () => {
  it("never regenerates for a shot or lens change", () => {
    const camera = createPanelCamera({ shot: "close-up", lens: "telephoto" });
    expect(cameraChangeRequiresRedraw("shot", camera).requiresRedraw).toBe(false);
    expect(cameraChangeRequiresRedraw("lens", camera).requiresRedraw).toBe(false);
  });

  it("requires a redraw for a genuine viewpoint change", () => {
    const low = cameraChangeRequiresRedraw("angle", createPanelCamera({ angle: "low" }));
    expect(low.requiresRedraw).toBe(true);
    expect(low.reason).toBeTruthy();
    expect(cameraChangeRequiresRedraw("angle", createPanelCamera({ angle: "overhead" })).requiresRedraw).toBe(true);
  });

  it("treats eye level and dutch as transform-only", () => {
    expect(cameraChangeRequiresRedraw("angle", createPanelCamera({ angle: "eye-level" })).requiresRedraw).toBe(false);
    // A dutch tilt rotates the frame; it is not a new viewpoint on the subject.
    expect(cameraChangeRequiresRedraw("angle", createPanelCamera({ angle: "dutch" })).requiresRedraw).toBe(false);
  });

  it("requires a redraw only for strong manga perspective", () => {
    expect(
      cameraChangeRequiresRedraw("mangaPerspective", createPanelCamera({ mangaPerspectiveStrength: 1 })).requiresRedraw,
    ).toBe(false);
    expect(
      cameraChangeRequiresRedraw("mangaPerspective", createPanelCamera({ mangaPerspectiveStrength: 3 })).requiresRedraw,
    ).toBe(true);
  });
});

describe("generation context", () => {
  it("says nothing for a neutral camera", () => {
    expect(cameraGenerationContext(createPanelCamera())).toEqual([]);
  });

  it("describes angle, lens and manga foreshortening", () => {
    const context = cameraGenerationContext(
      createPanelCamera({ angle: "low", lens: "wide", mangaPerspectiveStrength: 3 }),
    );
    expect(context.join(" ")).toMatch(/low camera angle/i);
    expect(context.join(" ")).toMatch(/wide-angle/i);
    expect(context.join(" ")).toMatch(/foreshortening/i);
  });

  it("describes shot framing", () => {
    expect(shotGenerationContext("close-up")).toMatch(/head and shoulders/i);
    expect(shotGenerationContext("full")).toMatch(/head to feet/i);
  });
});

describe("overlays never reach the page", () => {
  it("creates no document item for perspective guides", () => {
    const s = stage();
    const doc = applyDomainCommand(s.doc, {
      type: "set-panel-perspective",
      panelId: s.panelIds[0],
      patch: { type: "two-point", visible: true },
    }).doc;
    expect(doc.panels[s.panelIds[0]].itemIds).toHaveLength(0);
    expect(Object.values(doc.items)).toHaveLength(0);
    // Guides are computed on demand for the overlay only.
    expect(perspectiveGuideLines(doc.panels[s.panelIds[0]].perspective!).length).toBeGreaterThan(0);
  });

  it("emits no guides when perspective is off or hidden", () => {
    const s = stage();
    const doc = applyDomainCommand(s.doc, {
      type: "set-panel-perspective",
      panelId: s.panelIds[0],
      patch: { type: "none" },
    }).doc;
    expect(perspectiveGuideLines(doc.panels[s.panelIds[0]].perspective!)).toHaveLength(0);
  });
});

describe("persistence", () => {
  it("round-trips focal subject, auto ordering, camera and depth", () => {
    const s = stage();
    let doc = s.doc;
    const mio = place(doc, s.panelIds[0], s.mioAsset, s.mioId);
    doc = mio.doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: mio.id, patch: { depth: 0.2 } }).doc;
    doc = applyDomainCommand(doc, { type: "set-panel-focal-item", panelId: s.panelIds[0], itemId: mio.id }).doc;
    doc = applyDomainCommand(doc, { type: "set-panel-auto-depth-order", panelId: s.panelIds[0], enabled: true }).doc;
    doc = applyDomainCommand(doc, {
      type: "set-panel-camera",
      panelId: s.panelIds[0],
      patch: { shot: "medium", angle: "low", mangaPerspectiveStrength: 2 },
    }).doc;

    const restored = deserializeProject(serializeProject(doc));
    const panel = restored.panels[s.panelIds[0]];
    expect(restored.schemaVersion).toBe(SCHEMA_VERSION);
    expect(panel.focalItemId).toBe(mio.id);
    expect(panel.autoDepthOrder).toBe(true);
    expect(panel.camera).toMatchObject({ shot: "medium", angle: "low", mangaPerspectiveStrength: 2 });
    expect(inst(restored, mio.id).stage!.depth).toBeCloseTo(0.2);
  });

  it("migrates a v8 project without changing its composition", () => {
    const s = stage();
    const { doc: placedDoc, id } = place(s.doc, s.panelIds[0], s.yuriAsset, s.yuriId);
    const staged = applyDomainCommand(placedDoc, {
      type: "set-instance-stage",
      instanceId: id,
      patch: { depth: 0.5 },
    }).doc;

    const legacy = JSON.parse(serializeProject(staged)) as Record<string, unknown>;
    legacy.schemaVersion = 8;
    for (const panel of Object.values(legacy.panels as Record<string, Record<string, unknown>>)) {
      delete panel.autoDepthOrder;
      delete panel.focalItemId;
    }
    // Pre-v9 documents pinned the ground line to the old constant.
    const legacyItems = legacy.items as Record<string, Record<string, unknown>>;
    (legacyItems[id].stage as Record<string, unknown>).groundY = 0.92;

    const migrated = deserializeProject(JSON.stringify(legacy));
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    // Auto ordering stays OFF so an existing layout is not silently rearranged.
    expect(migrated.panels[s.panelIds[0]].autoDepthOrder).toBe(false);
    // The pinned default is released so the camera can own the ground line.
    expect((migrated.items[id] as AssetInstance).stage!.groundY).toBeUndefined();
  });
});

// ─── §21 acceptance A: manual ───────────────────────────────────────────────

describe("acceptance A: directing a panel by hand", () => {
  it("stages two characters, frames the focal one, and keeps guides out of export", () => {
    const s = stage();
    const panelId = s.panelIds[0];
    let doc = s.doc;

    // Place Yuri and Mio.
    const yuri = place(doc, panelId, s.yuriAsset, s.yuriId);
    doc = yuri.doc;
    const mio = place(doc, panelId, s.mioAsset, s.mioId);
    doc = mio.doc;

    // Enable two-point perspective: horizon + two VPs + guide rays exist.
    doc = applyDomainCommand(doc, {
      type: "set-panel-perspective",
      panelId,
      patch: { type: "two-point", visible: true },
    }).doc;
    const perspective = doc.panels[panelId].perspective!;
    expect(perspective.vanishingPoints).toHaveLength(2);
    expect(perspective.horizonY).toBeGreaterThan(0);
    expect(perspectiveGuideLines(perspective).length).toBeGreaterThan(0);

    // Mio to the foreground, Yuri to the background.
    doc = applyDomainCommand(doc, { type: "set-panel-auto-depth-order", panelId, enabled: true }).doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: mio.id, patch: { depth: 0.15 } }).doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: yuri.id, patch: { depth: 0.85 } }).doc;

    // Mio visibly larger, Yuri visibly smaller, Mio on top.
    expect(inst(doc, mio.id).height).toBeGreaterThan(inst(doc, yuri.id).height * 1.3);
    // Both stand ON the ground plane. With perspective active that plane
    // recedes toward the horizon, so the nearer character's feet sit LOWER in
    // frame rather than at the same y — which is what depth looks like.
    const rectA = panelPxRect(doc, panelId);
    const horizon = doc.panels[panelId].perspective!.horizonY;
    for (const id of [mio.id, yuri.id]) {
      const item = inst(doc, id);
      const expected = groundPointForDepth({
        depth: item.stage!.depth,
        panel: rectA,
        camera: doc.panels[panelId].camera,
        horizonY: horizon,
      });
      expect(feetY(item)).toBeCloseTo(expected, 1);
    }
    expect(feetY(inst(doc, mio.id))).toBeGreaterThan(feetY(inst(doc, yuri.id)));
    const order = doc.panels[panelId].itemIds;
    expect(order.indexOf(mio.id)).toBeGreaterThan(order.indexOf(yuri.id));

    // Focal = Mio, then Shot = Close-up.
    doc = applyDomainCommand(doc, { type: "set-panel-focal-item", panelId, itemId: mio.id }).doc;
    const mioBefore = inst(doc, mio.id).height;
    const yuriBefore = inst(doc, yuri.id).height;
    doc = applyDomainCommand(doc, { type: "set-panel-camera", panelId, patch: { shot: "close-up" } }).doc;

    const mioClose = inst(doc, mio.id);
    const rect = panelPxRect(doc, panelId);
    expect(mioClose.height).toBeGreaterThan(mioBefore * 1.5);
    // A real close-up: the body runs off the bottom of the frame.
    expect(feetY(mioClose)).toBeGreaterThan(rect.height);
    // Yuri, who is not the focal subject, was not reframed.
    expect(inst(doc, yuri.id).height).toBeCloseTo(yuriBefore, 5);

    // Angle = Low: horizon drops, pitch tips up. The camera metadata answers
    // immediately; the ARTWORK does not fake a low-angle shift (Phase 4.5 §19)
    // — redrawing from the new viewpoint is Generate Camera View's job.
    const cyBefore = inst(doc, mio.id).cy;
    doc = applyDomainCommand(doc, { type: "set-panel-camera", panelId, patch: { angle: "low" } }).doc;
    const camera = doc.panels[panelId].camera!;
    expect(camera.horizonY).toBeLessThan(0.5);
    expect(camera.pitch).toBeGreaterThan(0);
    expect(inst(doc, mio.id).cy).toBeCloseTo(cyBefore, 5);

    // Export: no guide has become a document item, so nothing can be exported.
    const exportable = doc.panels[panelId].itemIds.map((id) => doc.items[id].kind);
    expect(exportable).not.toContain("effect");
    expect(exportable.every((kind) => kind === "asset" || kind === "bubble")).toBe(true);
    expect(Object.values(doc.items).every((item) => item.kind !== "effect")).toBe(true);
  });
});

// ─── §22 acceptance B: agent ────────────────────────────────────────────────

describe("acceptance B: the agent directs semantically", () => {
  it("stages foreground/background, sets focal and camera, and touches no other panel", () => {
    const s = stage();
    const target = s.panelIds[1];
    const untouched = s.panelIds[0];
    let doc = s.doc;

    // A character in the panel the agent must NOT touch.
    const bystander = place(doc, untouched, s.yuriAsset, s.yuriId);
    doc = bystander.doc;
    const bystanderBefore = { ...inst(doc, bystander.id) };

    const yuri = place(doc, target, s.yuriAsset, s.yuriId);
    doc = yuri.doc;
    const mio = place(doc, target, s.mioAsset, s.mioId);
    doc = mio.doc;

    const assetCountBefore = Object.keys(doc.assets).length;

    // "Make Mio dominant in the foreground and put Yuri further back.
    //  Use a dramatic low-angle shot."
    doc = applyDomainCommand(doc, { type: "set-panel-auto-depth-order", panelId: target, enabled: true }).doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: mio.id, patch: { depth: 0.15 } }).doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: yuri.id, patch: { depth: 0.85 } }).doc;
    doc = applyDomainCommand(doc, { type: "set-panel-focal-item", panelId: target, itemId: mio.id }).doc;
    doc = applyDomainCommand(doc, {
      type: "set-panel-camera",
      panelId: target,
      patch: { angle: "low", mangaPerspectiveStrength: 2 },
    }).doc;

    // Mio dominant and in front.
    expect(inst(doc, mio.id).height).toBeGreaterThan(inst(doc, yuri.id).height);
    const order = doc.panels[target].itemIds;
    expect(order.indexOf(mio.id)).toBeGreaterThan(order.indexOf(yuri.id));
    expect(doc.panels[target].focalItemId).toBe(mio.id);
    expect(doc.panels[target].camera).toMatchObject({ angle: "low", mangaPerspectiveStrength: 2 });

    // No generation: existing renders were reused throughout.
    expect(Object.keys(doc.assets)).toHaveLength(assetCountBefore);

    // Panel 1 untouched.
    const after = inst(doc, bystander.id);
    expect({ cx: after.cx, cy: after.cy, width: after.width, height: after.height }).toEqual({
      cx: bystanderBefore.cx,
      cy: bystanderBefore.cy,
      width: bystanderBefore.width,
      height: bystanderBefore.height,
    });
    expect(doc.panels[untouched].camera).toEqual(createPanelCamera());
    expect(doc.panels[untouched].focalItemId).toBeUndefined();

    // The camera now speaks to generation, so a redraw would match the stage.
    const context = cameraGenerationContext(doc.panels[target].camera!).join(" ");
    expect(context).toMatch(/low camera angle/i);
    expect(context).toMatch(/foreshortening/i);
    // And a low angle is honestly flagged as needing a redraw, not a fake scale.
    expect(cameraChangeRequiresRedraw("angle", doc.panels[target].camera!).requiresRedraw).toBe(true);
  });
});
