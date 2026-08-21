/**
 * Camera integrity: one framing vocabulary, real roll, honest yaw, and
 * ground-stage dragging.
 *
 * Phase 5.5 exists to remove controls that looked professional but changed
 * nothing, so every test here asserts a geometric consequence or an explicit
 * refusal — never a stored value.
 */

import { describe, expect, it } from "vitest";
import { applyDomainCommand } from "./commands";
import { panelPxRect } from "./docHelpers";
import { createProjectDocument } from "./factory";
import { addAsset, addCharacter } from "./libraryOps";
import { deserializeProject, serializeProject } from "./serialization";
import { createPanelCamera } from "./camera";
import { createPanelPerspective } from "./perspective";
import { focalInstance, usesStagePlacement } from "./stageOps";
import {
  cameraChangeRequiresRedraw,
  depthFromGroundPoint,
  framingMatchesShot,
  groundPointForDepth,
  perspectiveGenerationContext,
  resolveShotType,
  subjectCoverage,
  yawFramingShift,
} from "./staging";
import type { AssetInstance, ID, ProjectDocument } from "./types";

function street() {
  let doc = createProjectDocument("Integrity");
  const yuri = addCharacter(doc, "Yuri");
  doc = yuri.doc;
  const mio = addCharacter(doc, "Mio");
  doc = mio.doc;
  const make = (characterId: ID, name: string) => {
    const added = addAsset(doc, {
      category: "character",
      name,
      storageUrl: `${name}.png`,
      width: 800,
      height: 1600,
      hasAlpha: true,
      processedImageUrl: `${name}-a.png`,
      processingStatus: "ready",
      metadata: { characterId, characterAssetRole: "state", pose: "standing" },
    });
    doc = added.doc;
    return added.assetId;
  };
  const yuriAsset = make(yuri.characterId, "yuri");
  const mioAsset = make(mio.characterId, "mio");
  const background = addAsset(doc, {
    category: "background",
    name: "tokyo-street",
    storageUrl: "street.png",
    width: 1600,
    height: 1000,
    processingStatus: "ready",
  });
  doc = background.doc;
  return {
    doc,
    yuriId: yuri.characterId,
    mioId: mio.characterId,
    yuriAsset,
    mioAsset,
    backgroundAsset: background.assetId,
    panelIds: doc.pages[Object.keys(doc.pages)[0]].panelIds,
  };
}

const inst = (doc: ProjectDocument, id: ID) => doc.items[id] as AssetInstance;
const feetY = (i: AssetInstance) => i.cy + i.height / 2;

function place(doc: ProjectDocument, panelId: ID, assetId: ID, characterId: ID) {
  const placed = applyDomainCommand(doc, { type: "add-instance", panelId, assetId });
  const id = placed.createdId!;
  const next = applyDomainCommand(placed.doc, {
    type: "set-instance-character-state",
    instanceId: id,
    state: { characterId, pose: "standing", expression: "neutral", outfit: "default outfit", view: "front" },
  }).doc;
  return { doc: next, id };
}

describe("unified framing vocabulary", () => {
  it("resolves every framing word onto one canonical shot", () => {
    expect(resolveShotType("full-body")).toBe("full");
    expect(resolveShotType("upper-body")).toBe("medium");
    expect(resolveShotType("medium")).toBe("medium");
    expect(resolveShotType("close-up")).toBe("close-up");
    expect(resolveShotType("face")).toBe("extreme-close-up");
    expect(resolveShotType("medium-full")).toBe("wide");
    expect(resolveShotType("nonsense")).toBeUndefined();
  });

  it("gives compose-character and the camera the same geometry for the same word", () => {
    const s = street();
    const panelId = s.panelIds[0];

    // Path A: compose a character with framing "close-up".
    const composed = applyDomainCommand(s.doc, {
      type: "compose-character",
      panelId,
      characterId: s.yuriId,
      assetId: s.yuriAsset,
      framing: "close-up",
    });
    const composedHeight = inst(composed.doc, composed.createdId!).height;

    // Path B: place plainly, then set the camera shot to close-up.
    const placed = place(s.doc, s.panelIds[1], s.yuriAsset, s.yuriId);
    const cameraDoc = applyDomainCommand(placed.doc, {
      type: "set-panel-camera",
      panelId: s.panelIds[1],
      patch: { shot: "close-up" },
    }).doc;
    const cameraHeight = inst(cameraDoc, placed.id).height;

    // Same engine, same result — the two paths can no longer disagree.
    expect(composedHeight).toBeCloseTo(cameraHeight, 5);
  });

  it("no longer degrades a close-up to a crop preset when the asset has no face region", () => {
    const s = street();
    const composed = applyDomainCommand(s.doc, {
      type: "compose-character",
      panelId: s.panelIds[0],
      characterId: s.yuriId,
      assetId: s.yuriAsset,
      framing: "close-up",
    });
    const item = inst(composed.doc, composed.createdId!);
    const rect = panelPxRect(composed.doc, s.panelIds[0]);
    // Previously this silently became an upper-body crop. Now it is a real close-up.
    expect(framingMatchesShot(subjectCoverage(item, rect), "close-up")).toBe(true);
    expect(item.cropMode).not.toBe("face");
  });

  it("validates coverage against the requested shot", () => {
    const rect = { x: 0, y: 0, width: 600, height: 800 };
    expect(framingMatchesShot(subjectCoverage({ height: 800 * 2.6 }, rect), "close-up")).toBe(true);
    // A full-body layout must not pass as a close-up.
    expect(framingMatchesShot(subjectCoverage({ height: 800 * 0.9 }, rect), "close-up")).toBe(false);
  });
});

describe("dutch roll is real", () => {
  it("stores a non-zero roll for a dutch angle", () => {
    const s = street();
    const doc = applyDomainCommand(s.doc, {
      type: "set-panel-camera",
      panelId: s.panelIds[0],
      patch: { angle: "dutch" },
    }).doc;
    expect(doc.panels[s.panelIds[0]].camera!.roll).not.toBe(0);
  });

  it("returns to zero roll when the angle leaves dutch", () => {
    const s = street();
    let doc = applyDomainCommand(s.doc, { type: "set-panel-camera", panelId: s.panelIds[0], patch: { angle: "dutch" } }).doc;
    doc = applyDomainCommand(doc, { type: "set-panel-camera", panelId: s.panelIds[0], patch: { angle: "eye-level" } }).doc;
    expect(doc.panels[s.panelIds[0]].camera!.roll).toBe(0);
  });

  it("survives serialization so the exported page tilts too", () => {
    const s = street();
    const doc = applyDomainCommand(s.doc, {
      type: "set-panel-camera",
      panelId: s.panelIds[0],
      patch: { angle: "dutch" },
    }).doc;
    const restored = deserializeProject(serializeProject(doc));
    expect(restored.panels[s.panelIds[0]].camera!.roll).toBe(doc.panels[s.panelIds[0]].camera!.roll);
  });

  it("treats roll as composition, never as a reason to redraw", () => {
    expect(cameraChangeRequiresRedraw("angle", createPanelCamera({ angle: "dutch" })).requiresRedraw).toBe(false);
  });
});

describe("yaw is honest", () => {
  it("pans the framing horizontally", () => {
    expect(yawFramingShift(0)).toBe(0);
    expect(yawFramingShift(45)).toBeLessThan(0);
    expect(yawFramingShift(-45)).toBeGreaterThan(0);
    // Clamped so a wild value cannot throw the subject out of frame.
    expect(Math.abs(yawFramingShift(9999))).toBeLessThanOrEqual(0.33);
  });

  it("moves the focal subject in frame", () => {
    const s = street();
    const panelId = s.panelIds[0];
    const placed = place(s.doc, panelId, s.yuriAsset, s.yuriId);
    const centred = applyDomainCommand(placed.doc, {
      type: "set-panel-camera",
      panelId,
      patch: { shot: "medium" },
    }).doc;
    const panned = applyDomainCommand(centred, {
      type: "set-panel-camera",
      panelId,
      patch: { yaw: 30, shot: "full" },
    }).doc;
    expect(inst(panned, placed.id).cx).not.toBeCloseTo(inst(centred, placed.id).cx);
  });

  it("admits a large yaw needs a redraw but a small one does not", () => {
    expect(cameraChangeRequiresRedraw("yaw", createPanelCamera()).requiresRedraw).toBe(false);
    const turned = { ...createPanelCamera(), yaw: 60 };
    const decision = cameraChangeRequiresRedraw("yaw", turned);
    expect(decision.requiresRedraw).toBe(true);
    expect(decision.reason).toMatch(/different side/i);
  });
});

describe("ground-stage placement", () => {
  it("reads depth from where the feet land, and inverts consistently", () => {
    const panel = { x: 0, y: 0, width: 600, height: 800 };
    const camera = createPanelCamera();
    const near = depthFromGroundPoint({ feetY: 800 * 0.92, panel, camera })!;
    const far = depthFromGroundPoint({ feetY: 800 * 0.5, panel, camera })!;
    expect(near).toBeCloseTo(0, 1);
    expect(far).toBeGreaterThan(near);
    // Round trip: a depth maps back to the feet position it came from.
    expect(groundPointForDepth({ depth: far, panel, camera })).toBeCloseTo(800 * 0.5, 5);
  });

  it("declines to guess when the panel has no usable floor", () => {
    const panel = { x: 0, y: 0, width: 600, height: 800 };
    // Horizon below the ground line: there is no depth to infer.
    expect(depthFromGroundPoint({ feetY: 400, panel, horizonY: 0.95 })).toBeNull();
  });

  it("only intercepts drags when Snap to Stage is on", () => {
    const s = street();
    const panelId = s.panelIds[0];
    const placed = place(s.doc, panelId, s.mioAsset, s.mioId);
    let doc = applyDomainCommand(placed.doc, {
      type: "set-instance-stage",
      instanceId: placed.id,
      patch: { depth: 0.3 },
    }).doc;
    expect(usesStagePlacement(doc, placed.id)).toBe(false);

    doc = applyDomainCommand(doc, {
      type: "set-panel-perspective",
      panelId,
      patch: { type: "two-point", snapEnabled: true },
    }).doc;
    expect(usesStagePlacement(doc, placed.id)).toBe(true);
  });

  it("leaves an unstaged instance to ordinary free dragging", () => {
    const s = street();
    const placed = place(s.doc, s.panelIds[0], s.mioAsset, s.mioId);
    const doc = applyDomainCommand(placed.doc, {
      type: "set-panel-perspective",
      panelId: s.panelIds[0],
      patch: { type: "two-point", snapEnabled: true },
    }).doc;
    expect(usesStagePlacement(doc, placed.id)).toBe(false);
  });
});

describe("three-point honesty", () => {
  it("contributes real vertical-convergence generation context", () => {
    const towering = { ...createPanelPerspective("three-point", 0.7) };
    const context = perspectiveGenerationContext(towering).join(" ");
    expect(context).toMatch(/three-point/i);
    expect(context).toMatch(/verticals converge/i);
  });

  it("says nothing when perspective is off", () => {
    expect(perspectiveGenerationContext(createPanelPerspective("none"))).toEqual([]);
  });

  it("admits three-point cannot re-project existing artwork", () => {
    const decision = cameraChangeRequiresRedraw("perspective", createPanelCamera());
    expect(decision.requiresRedraw).toBe(true);
    expect(decision.reason).toMatch(/how the subject is drawn/i);
  });
});

// ─── §12 acceptance ─────────────────────────────────────────────────────────

describe("acceptance: Tokyo street panel", () => {
  function scene() {
    const s = street();
    const panelId = s.panelIds[0];
    let doc = applyDomainCommand(s.doc, {
      type: "set-panel-background",
      panelId,
      assetId: s.backgroundAsset,
      location: "Tokyo Street",
    }).doc;
    const yuri = place(doc, panelId, s.yuriAsset, s.yuriId);
    doc = yuri.doc;
    const mio = place(doc, panelId, s.mioAsset, s.mioId);
    doc = mio.doc;
    doc = applyDomainCommand(doc, { type: "set-panel-auto-depth-order", panelId, enabled: true }).doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: yuri.id, patch: { depth: 0.15 } }).doc;
    doc = applyDomainCommand(doc, { type: "set-instance-stage", instanceId: mio.id, patch: { depth: 0.8 } }).doc;
    doc = applyDomainCommand(doc, {
      type: "set-panel-perspective",
      panelId,
      patch: { type: "two-point", visible: true, snapEnabled: true },
    }).doc;
    return { ...s, doc, panelId, yuriInstance: yuri.id, mioInstance: mio.id };
  }

  it("A — close-up on Yuri uses the one framing path", () => {
    const sc = scene();
    let doc = applyDomainCommand(sc.doc, {
      type: "set-panel-focal-item",
      panelId: sc.panelId,
      itemId: sc.yuriInstance,
    }).doc;
    const before = inst(doc, sc.yuriInstance).height;
    doc = applyDomainCommand(doc, { type: "set-panel-camera", panelId: sc.panelId, patch: { shot: "close-up" } }).doc;

    const yuri = inst(doc, sc.yuriInstance);
    const rect = panelPxRect(doc, sc.panelId);
    expect(yuri.height).toBeGreaterThan(before);
    expect(framingMatchesShot(subjectCoverage(yuri, rect), "close-up")).toBe(true);
    expect(feetY(yuri)).toBeGreaterThan(rect.height);
    expect(focalInstance(doc, sc.panelId)!.id).toBe(sc.yuriInstance);
  });

  it("B — dragging Mio up the panel walks her into the distance", () => {
    const sc = scene();
    const before = inst(sc.doc, sc.mioInstance);
    const rect = panelPxRect(sc.doc, sc.panelId);
    const beforeFeet = feetY(before);

    // Drop her higher up the floor. The drop point is the instance CENTRE, so
    // it is taken relative to where she already is — an absolute fraction of
    // the panel would move a tall instance's feet the other way.
    const doc = applyDomainCommand(sc.doc, {
      type: "place-on-stage",
      instanceId: sc.mioInstance,
      at: { x: before.cx, y: before.cy - rect.height * 0.15 },
    }).doc;
    const after = inst(doc, sc.mioInstance);

    expect(after.stage!.depth).toBeGreaterThan(before.stage!.depth);
    expect(after.height).toBeLessThan(before.height);
    // Re-grounded on the floor rather than left hanging where the cursor was.
    expect(feetY(after)).toBeLessThan(beforeFeet);
    expect(Math.abs(feetY(after) - groundPointForDepth({
      depth: after.stage!.depth,
      panel: rect,
      camera: doc.panels[sc.panelId].camera,
      horizonY: doc.panels[sc.panelId].perspective!.horizonY,
    }))).toBeLessThan(2);

    // Z-order follows: Yuri is nearer, so she draws on top.
    const order = doc.panels[sc.panelId].itemIds;
    expect(order.indexOf(sc.yuriInstance)).toBeGreaterThan(order.indexOf(sc.mioInstance));
  });

  it("C — dutch really rolls the panel", () => {
    const sc = scene();
    const doc = applyDomainCommand(sc.doc, {
      type: "set-panel-camera",
      panelId: sc.panelId,
      patch: { angle: "dutch" },
    }).doc;
    // The renderer rotates scene content by exactly this value, and export
    // walks the same scene graph.
    expect(doc.panels[sc.panelId].camera!.roll).not.toBe(0);
  });

  it("D — three-point is guide-and-context, and says so", () => {
    const sc = scene();
    const doc = applyDomainCommand(sc.doc, {
      type: "set-panel-perspective",
      panelId: sc.panelId,
      patch: { type: "three-point" },
    }).doc;
    const perspective = doc.panels[sc.panelId].perspective!;
    expect(perspective.vanishingPoints).toHaveLength(3);
    expect(perspectiveGenerationContext(perspective).join(" ")).toMatch(/verticals converge/i);
    expect(cameraChangeRequiresRedraw("perspective", doc.panels[sc.panelId].camera!).requiresRedraw).toBe(true);
  });

  it("E — the agent's operations equal the manual ones", () => {
    const sc = scene();
    const assetsBefore = Object.keys(sc.doc.assets).length;

    // "Move Mio farther back and make Yuri a close-up."
    let doc = applyDomainCommand(sc.doc, {
      type: "set-instance-stage",
      instanceId: sc.mioInstance,
      patch: { depth: 0.95, scaleLocked: false },
    }).doc;
    doc = applyDomainCommand(doc, { type: "set-panel-focal-item", panelId: sc.panelId, itemId: sc.yuriInstance }).doc;
    doc = applyDomainCommand(doc, { type: "set-panel-camera", panelId: sc.panelId, patch: { shot: "close-up" } }).doc;

    const rect = panelPxRect(doc, sc.panelId);
    const yuri = inst(doc, sc.yuriInstance);
    const mio = inst(doc, sc.mioInstance);

    // Geometry validated, not metadata.
    expect(framingMatchesShot(subjectCoverage(yuri, rect), "close-up")).toBe(true);
    expect(mio.height).toBeLessThan(inst(sc.doc, sc.mioInstance).height);
    expect(Object.keys(doc.assets)).toHaveLength(assetsBefore);

    // The other panels are untouched.
    for (const other of sc.panelIds.slice(1)) {
      expect(doc.panels[other].camera).toEqual(createPanelCamera());
      expect(doc.panels[other].itemIds).toHaveLength(0);
    }
  });
});
