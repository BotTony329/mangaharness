/**
 * Every Agent tool must declare, truthfully, whether it can spend a generation.
 *
 * The failure this guards against is silent cost: a tool that looks like a move
 * or a framing change but quietly reaches a provider. The router is the one
 * place that answers, and an unclassified tool must fail SAFE — counted as
 * generative — rather than slipping through as free.
 */

import { describe, expect, it } from "vitest";
import { toolSchemas, type ToolName } from "./tools/schemas";
import { couldGenerate, executionClass, mayEscalateToGeneration } from "./capabilityRouter";

const EXPECTED: Record<string, ToolName[]> = {
  EDITOR_OP: [
    "set_page_layout",
    "place_asset",
    "reshape_panel",
    "add_speech_bubble",
    "attach_bubble",
    "add_effect",
    "set_camera",
    "set_perspective",
    "set_character_depth",
    "set_focal_character",
    "set_crop_mode",
    "remove_items",
    "place_manga_effect",
  ],
  LOCAL_ASSET_OP: ["set_puppet_expression", "set_puppet_joint"],
  AI_GENERATION: [
    "generate_character_asset",
    "generate_background",
    "generate_prop",
    "generate_manga_effect",
    "create_interaction",
  ],
};

describe("execution classes", () => {
  for (const [expected, tools] of Object.entries(EXPECTED)) {
    for (const tool of tools) {
      it(`${tool} is ${expected}`, () => {
        expect(executionClass(tool)).toBe(expected);
      });
    }
  }

  it("classifies every registered tool", () => {
    for (const tool of Object.keys(toolSchemas) as ToolName[]) {
      expect(executionClass(tool)).toMatch(/EDITOR_OP|LOCAL_ASSET_OP|AI_GENERATION/);
    }
  });

  /**
   * The one that matters: a tool nobody remembered to classify must be treated
   * as capable of spending money. Over-warning is recoverable; an unannounced
   * charge is not.
   */
  it("treats an unknown tool as generative", () => {
    expect(executionClass("some_tool_added_next_month" as ToolName)).toBe("AI_GENERATION");
    expect(couldGenerate("some_tool_added_next_month" as ToolName)).toBe(true);
  });

  it("marks reuse-first tools as possibly generative rather than certainly", () => {
    for (const tool of ["place_character", "compose_character", "set_character_slot"] as ToolName[]) {
      expect(mayEscalateToGeneration(tool)).toBe(true);
      expect(couldGenerate(tool)).toBe(true);
    }
  });

  it("never asks a creator to approve a cost for a pure editing tool", () => {
    for (const tool of [...EXPECTED.EDITOR_OP, ...EXPECTED.LOCAL_ASSET_OP]) {
      expect(couldGenerate(tool)).toBe(false);
    }
  });
});
