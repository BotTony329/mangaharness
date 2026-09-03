/**
 * CameraResolver contract — the decision tables for LOCAL vs GENERATIVE.
 *
 * Phase 1 proves the boundary only: every LOCAL verdict must be achievable
 * with zero generation calls (the resolver owns no generation path at all),
 * and every viewpoint that must be DRAWN must come back GENERATIVE_REDRAW.
 * The canonical judgements themselves are delegated to
 * `cameraChangeRequiresRedraw`; these tests also guard that delegation from
 * silently forking.
 */
import { describe, expect, it } from "vitest";
import { createPanelCamera } from "@/domain/camera";
import { resolveCameraExecution } from "./cameraResolver";

const LOCAL = "LOCAL_TRANSFORM";
const GENERATIVE = "GENERATIVE_REDRAW";

describe("CameraResolver — LOCAL decisions (zero API)", () => {
  it.each([
    ["shot tightening: full → medium is a crop", { change: "shot", camera: createPanelCamera({ shot: "medium" }), fromShot: "full", toShot: "medium" }],
    ["shot tightening: medium → close-up", { change: "shot", camera: createPanelCamera({ shot: "close-up" }), fromShot: "medium", toShot: "close-up" }],
    ["lens staging is depth falloff, not new artwork", { change: "lens", camera: createPanelCamera({ lens: "wide" }) }],
    ["dutch tilt is a frame rotation", { change: "angle", camera: createPanelCamera({ angle: "dutch" }) }],
    ["eye level is the neutral viewpoint", { change: "angle", camera: createPanelCamera({ angle: "eye-level" }) }],
    ["a minor pan reframes what exists", { change: "yaw", camera: { ...createPanelCamera(), yaw: 12 } }],
    ["subtle manga perspective stays transformable", { change: "mangaPerspective", camera: createPanelCamera({ mangaPerspectiveStrength: 1 }) }],
  ] as const)("%s", (_label, input) => {
    const decision = resolveCameraExecution(input);
    expect(decision.execution).toBe(LOCAL);
    expect(decision.reason).toBeUndefined();
  });

  it("shot widening is LOCAL when the source artwork provably contains the content (extension point)", () => {
    const decision = resolveCameraExecution({
      change: "shot",
      camera: createPanelCamera({ shot: "full" }),
      fromShot: "close-up",
      toShot: "full",
      // The source holds ~3 subject-heights; a full shot needs 0.92.
      availableCoverage: 3,
    });
    expect(decision.execution).toBe(LOCAL);
  });
});

describe("CameraResolver — GENERATIVE decisions (viewpoint must be drawn)", () => {
  it.each([
    ["high angle", { change: "angle", camera: createPanelCamera({ angle: "high" }) }],
    ["low angle", { change: "angle", camera: createPanelCamera({ angle: "low" }) }],
    ["overhead / bird's-eye", { change: "angle", camera: createPanelCamera({ angle: "overhead" }) }],
    ["large yaw shows another side of the subject", { change: "yaw", camera: { ...createPanelCamera(), yaw: 45 } }],
    ["dramatic manga perspective needs foreshortening", { change: "mangaPerspective", camera: createPanelCamera({ mangaPerspectiveStrength: 3 }) }],
    ["three-point perspective convergence", { change: "perspective", camera: createPanelCamera() }],
  ] as const)("%s", (_label, input) => {
    const decision = resolveCameraExecution(input);
    expect(decision.execution).toBe(GENERATIVE);
    expect(decision.reason).toBeTruthy();
  });

  it("shot widening without coverage evidence is GENERATIVE — pixels cannot be invented", () => {
    const decision = resolveCameraExecution({
      change: "shot",
      camera: createPanelCamera({ shot: "full" }),
      fromShot: "close-up",
      toShot: "full",
    });
    expect(decision.execution).toBe(GENERATIVE);
    expect(decision.reason).toContain("cannot invent");
  });
});

/**
 * Documented Phase 1 limitation: worm's-eye, rear view and over-the-shoulder
 * are not expressible in the current CameraAngle vocabulary. Extending that
 * vocabulary is Phase 6 semantic work, deliberately NOT done here.
 */
