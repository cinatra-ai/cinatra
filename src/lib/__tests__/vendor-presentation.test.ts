/**
 * resolveVendorPresentation — the single vendor-byline resolver (cinatra#1528).
 *
 * Locks the discriminated missing-vendor contract at the resolver level:
 *   - a real display name → `known` (carrying the trimmed name + store URL);
 *   - null / undefined / empty / whitespace-only → `missing`;
 *   - the input type has no slug/packageName field, so a machine identifier can
 *     never become the label — the surfaces feed ONLY a display-name candidate;
 *   - a `missing` resolution emits a deduplicated structured diagnostic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveVendorPresentation,
  VENDOR_BY_CONNECTIVE,
  VENDOR_MISSING_LABEL,
  type VendorPresentation,
} from "../vendor-presentation";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveVendorPresentation — known state", () => {
  it("resolves a real display name to known, carrying the store URL", () => {
    expect(
      resolveVendorPresentation({ name: "Foundry", storeUrl: "https://marketplace.cinatra.ai/store/foundry" }),
    ).toEqual<VendorPresentation>({
      kind: "known",
      displayName: "Foundry",
      storeUrl: "https://marketplace.cinatra.ai/store/foundry",
    });
  });

  it("trims the display name and defaults an absent store URL to null", () => {
    expect(resolveVendorPresentation({ name: "  Acme Labs  " })).toEqual<VendorPresentation>({
      kind: "known",
      displayName: "Acme Labs",
      storeUrl: null,
    });
  });

  it("preserves a long / Unicode display name verbatim (never slug-ifies it)", () => {
    const name = "Ştefan & Associés — Ελληνικά Εργαλεία 日本語ツール";
    const result = resolveVendorPresentation({ name });
    expect(result).toEqual<VendorPresentation>({ kind: "known", displayName: name, storeUrl: null });
  });
});

describe("resolveVendorPresentation — missing state (never a slug / scope)", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["tab/newline only", "\t\n "],
  ])("resolves a %s display name to missing", (_label, name) => {
    expect(resolveVendorPresentation({ name })).toEqual<VendorPresentation>({ kind: "missing" });
  });

  it("drops any surviving store URL on missing (the placeholder is never linked)", () => {
    const result = resolveVendorPresentation({ name: "", storeUrl: "https://evil.example/store" });
    expect(result).toEqual<VendorPresentation>({ kind: "missing" });
    expect(result).not.toHaveProperty("storeUrl");
  });
});

describe("resolveVendorPresentation — structured, deduplicated diagnostic", () => {
  it("emits a structured diagnostic once per surface/ref on a missing resolution", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = { surface: "unit-test-surface", ref: "@scope/dedup-once" };
    resolveVendorPresentation({ name: "" }, ctx);
    resolveVendorPresentation({ name: "   " }, ctx);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      event: "vendor.display_name.missing",
      surface: "unit-test-surface",
      ref: "@scope/dedup-once",
    });
  });

  it("never emits a diagnostic on a known resolution", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveVendorPresentation({ name: "Foundry" }, { surface: "unit-test-surface", ref: "@scope/known" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not require a diagnostic context (pure result)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveVendorPresentation({ name: "" })).toEqual<VendorPresentation>({ kind: "missing" });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("centralized byline copy", () => {
  it("exposes a single definition of the connective and placeholder", () => {
    expect(VENDOR_BY_CONNECTIVE).toBe("by");
    expect(VENDOR_MISSING_LABEL).toBe("Unknown vendor");
  });
});
