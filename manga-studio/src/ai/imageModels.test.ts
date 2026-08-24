/**
 * Capability registry pins: model families resolve to the right contract,
 * unknown models keep the legacy conservative shape, and size snapping
 * preserves orientation within the allowed set.
 */

import { describe, expect, it } from "vitest";
import { capabilitiesForModel, snapSize } from "./imageModels";

describe("capabilitiesForModel", () => {
  it("gpt-image-1: no response_format, native background, restricted sizes", () => {
    const caps = capabilitiesForModel("gpt-image-1");
    expect(caps.responseFormat).toBe(false);
    expect(caps.background).toBe(true);
    expect(caps.quality).toBe(true);
    expect(caps.allowedSizes).toEqual(["1024x1024", "1536x1024", "1024x1536"]);
    expect(caps.outputTypes).toEqual(["base64"]);
  });

  it("future gpt-image revisions inherit the family contract", () => {
    expect(capabilitiesForModel("gpt-image-2").responseFormat).toBe(false);
  });

  it("dall-e-3: response_format allowed, no background", () => {
    const caps = capabilitiesForModel("dall-e-3");
    expect(caps.responseFormat).toBe(true);
    expect(caps.background).toBe(false);
    expect(caps.allowedSizes).toContain("1792x1024");
  });

  it("dall-e-2: response_format allowed, no quality knob", () => {
    const caps = capabilitiesForModel("dall-e-2");
    expect(caps.responseFormat).toBe(true);
    expect(caps.quality).toBe(false);
  });

  it("unknown OpenAI-compatible model: legacy conservative defaults", () => {
    const caps = capabilitiesForModel("some-gateway-model");
    expect(caps.responseFormat).toBe(true);
    expect(caps.background).toBe(false);
    expect(caps.referenceImages).toBe(false);
    expect(caps.allowedSizes).toBeUndefined();
  });
});

describe("snapSize", () => {
  it("passes through allowed sizes unchanged", () => {
    expect(snapSize(1536, 1024, capabilitiesForModel("gpt-image-1"))).toBe("1536x1024");
  });

  it("snaps to the nearest allowed size preserving orientation", () => {
    expect(snapSize(1216, 832, capabilitiesForModel("gpt-image-1"))).toBe("1536x1024");
    expect(snapSize(832, 1216, capabilitiesForModel("dall-e-3"))).toBe("1024x1792");
    expect(snapSize(1024, 1024, capabilitiesForModel("dall-e-2"))).toBe("1024x1024");
  });

  it("unknown models are unrestricted", () => {
    expect(snapSize(832, 1216, capabilitiesForModel("x"))).toBe("832x1216");
  });
});
