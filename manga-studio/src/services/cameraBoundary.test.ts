/**
 * v0.3 Phase 6 — CAMERA ARCHITECTURE BOUNDARY ENFORCEMENT (task §17).
 *
 * Source-level dependency contracts. These guard the ONE-boundary rule:
 * UI and Agent converge on the Panel Camera application service; nothing
 * camera-related reaches a provider directly; the camera core would survive
 * deleting the Agent directories untouched.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const PROVIDER_OR_GENERATION = /@\/services\/generation|@\/agent\/providers|openai|gemini|qwen/i;
const STAGING_EXECUTION = /projectInstance|applyCameraPatch|frameSubject|applyPerspectivePatch|depthFromGroundPoint/;

const CAMERA_CORE = [
  "src/services/panelCamera.ts",
  "src/services/cameraResolver.ts",
  "src/domain/camera.ts",
  "src/domain/cameraRender.ts",
  "src/domain/stageOps.ts",
];

describe("UI camera boundary", () => {
  it("PanelStageControls never imports a provider/generation seam, and DOES use the Panel Camera service", () => {
    const ui = source("src/components/inspector/PanelStageControls.tsx");
    expect(ui).not.toMatch(/@\/services\/generation|@\/agent\/providers/);
    expect(ui).toMatch(/@\/services\/panelCamera/);
    // No legacy per-participant camera services.
    expect(ui).not.toMatch(/characterCamera|sceneCamera/);
  });
});

describe("Agent camera boundary", () => {
  const AGENT_CAMERA = [
    "src/agent-v2/process/cameraProcess.ts",
    "src/agent-v3/routing/cameraSemantics.ts",
    "src/agent-v3/routing/capabilityRouter.ts",
    "src/agent-v3/resolution/cameraTarget.ts",
  ];

  it("no direct provider, no direct staging execution, no legacy camera services", () => {
    for (const file of AGENT_CAMERA) {
      const text = source(file);
      expect(text, file).not.toMatch(PROVIDER_OR_GENERATION);
      expect(text, file).not.toMatch(STAGING_EXECUTION);
      expect(text, file).not.toMatch(/characterCamera|sceneCamera/);
    }
  });
});

describe("camera core is Agent-free and UI-free", () => {
  it("camera core imports neither the Agent nor the UI — deleting either leaves Camera intact", () => {
    for (const file of CAMERA_CORE) {
      const text = source(file);
      expect(text, file).not.toMatch(/@\/agent(-v2|-v3)?\//);
      expect(text, file).not.toMatch(/@\/components\//);
    }
  });

  it("CameraResolver never touches a provider (LOCAL verdicts are pure)", () => {
    expect(source("src/services/cameraResolver.ts")).not.toMatch(PROVIDER_OR_GENERATION);
  });

  it("the Panel Camera service is the ONLY generation caller among camera modules", () => {
    expect(source("src/services/panelCamera.ts")).toMatch(/@\/services\/generation/);
    expect(source("src/services/cameraResolver.ts")).not.toMatch(/generateImage/);
  });
});

describe("provider agnostic (§15)", () => {
  it("camera core names no vendor — the request is semantic, adapters own the API contract", () => {
    for (const file of CAMERA_CORE) {
      expect(source(file), file).not.toMatch(/gemini|openai|qwen/i);
    }
  });
});

describe("runtime observability hygiene (§16)", () => {
  it("the evidence record carries route/panel/camera/participants — never secrets or pixels", () => {
    const text = source("src/services/panelCamera.ts");
    const evidenceCall = text.slice(text.indexOf("recordGenerationEvidence({"));
    expect(evidenceCall).toContain("panel-shot");
    expect(evidenceCall).toContain("panelId");
    expect(evidenceCall).toContain("participantCount");
    expect(evidenceCall).toContain("referenceCount");
    expect(evidenceCall).toContain("generationCalls");
    expect(evidenceCall).not.toMatch(/apiKey|token|base64/i);
  });
});
