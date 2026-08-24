import { describe, expect, it } from "vitest";
import { resolveInteraction } from "./interactionSemantics";

describe("resolveInteraction", () => {
  it("maps known verbs to editor types", () => {
    expect(resolveInteraction("hug")?.type).toBe("hug");
    expect(resolveInteraction("comforts")?.type).toBe("hug");
    expect(resolveInteraction("leans on")?.type).toBe("lean_on");
  });

  it("extracts direction wording into editable parameters", () => {
    // Golden CASE 1: "hug from behind" is a hug with a direction, not an
    // unmapped intent.
    const resolved = resolveInteraction("hug from behind");
    expect(resolved?.type).toBe("hug");
    expect(resolved?.parameters).toEqual({ direction: "from behind" });
    expect(resolved?.warning).toBeUndefined();
  });

  it("treats object/scene verbs as first-class custom interactions", () => {
    expect(resolveInteraction("eat")?.type).toBe("eat");
    expect(resolveInteraction("driving")?.type).toBe("driving");
    expect(resolveInteraction("eat")?.warning).toBeUndefined();
  });

  it("keeps the soft fallback for genuinely unknown wording", () => {
    const resolved = resolveInteraction("teleports beside");
    expect(resolved?.type).toBeUndefined();
    expect(resolved?.raw).toBe("teleports beside");
    expect(resolved?.warning).toMatch(/Unsupported interaction intent/);
  });

  it("returns undefined for empty input", () => {
    expect(resolveInteraction(undefined)).toBeUndefined();
  });
});
