/**
 * maskApiKey (cinatra#1690) — the ONLY way a connected key reaches the UI.
 * Pins: prefix+last4 shape for real-length keys, full mask for short ones,
 * null for absent/blank (caller skips the row), and NEVER echoes the middle.
 */
import { describe, expect, it } from "vitest";
import { maskApiKey } from "../mask-api-key";

describe("maskApiKey", () => {
  it("masks a real-length key as first-3 + … + last-4", () => {
    expect(maskApiKey("sk-proj-abcdefghijklmnopqrstuvwxyz1234")).toBe("sk-…1234");
  });

  it("fully masks anything under 20 chars (would otherwise reveal most of it)", () => {
    expect(maskApiKey("sk-short-key-12")).toBe("••••••••");
  });

  it("returns null for missing or whitespace-only input", () => {
    expect(maskApiKey(undefined)).toBeNull();
    expect(maskApiKey(null)).toBeNull();
    expect(maskApiKey("   ")).toBeNull();
  });

  it("never contains the key's middle section", () => {
    const key = "sk-proj-MIDDLESECRETMIDDLE-abcd";
    expect(maskApiKey(key)).not.toContain("MIDDLESECRET");
  });

  it("trims before measuring so padded short keys stay fully masked", () => {
    expect(maskApiKey("  sk-short-key-12  ")).toBe("••••••••");
  });
});
