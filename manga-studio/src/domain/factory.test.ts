/**
 * Regression: opening the app over a LAN IP (insecure context) leaves
 * crypto.randomUUID undefined — newId must still produce valid v4 UUIDs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "./factory";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("produces v4 UUIDs in secure contexts", () => {
    expect(newId()).toMatch(UUID_V4);
  });

  it("still works when crypto.randomUUID is unavailable (insecure context)", () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      randomUUID: undefined,
      getRandomValues: (arr: Uint8Array) => realCrypto.getRandomValues.call(realCrypto, arr),
    });
    // Re-import not needed: newId checks availability at call time.
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(ids.size).toBe(200); // no collisions across many calls
    vi.unstubAllGlobals();
  });
});
