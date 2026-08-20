import { describe, expect, it } from "vitest";
import { validateReferenceFileBasics } from "./referenceImage";

describe("reference image selection", () => {
  it("accepts supported image formats", () => {
    expect(validateReferenceFileBasics({ size: 1024, type: "image/png" })).toBeNull();
    expect(validateReferenceFileBasics({ size: 1024, type: "image/jpeg" })).toBeNull();
    expect(validateReferenceFileBasics({ size: 1024, type: "image/webp" })).toBeNull();
  });

  it("rejects unsupported images with a user-facing error", () => {
    expect(validateReferenceFileBasics({ size: 1024, type: "image/gif" })).toBe(
      "Unsupported image format. Use PNG, JPG, or WEBP.",
    );
  });

  it("rejects files above 10 MB", () => {
    expect(validateReferenceFileBasics({ size: 10 * 1024 * 1024 + 1, type: "image/png" })).toBe(
      "Image is too large. Maximum size: 10 MB.",
    );
  });
});
