/**
 * resolveVendorPresentation — the single vendor-byline resolver (cinatra#1528).
 *
 * Locks the discriminated missing-vendor contract at the resolver level:
 *   - a real display name → `known` (carrying the trimmed name + store URL);
 *   - null / undefined / empty / whitespace-only → `missing`;
 *   - the input type has no slug/packageName field, so a machine identifier can
 *     never become the label — the surfaces feed ONLY a display-name candidate;
 *   - the result is a BRANDED type, so ONLY this resolver can mint a
 *     presentation — a surface can never be handed a hand-forged `known` label;
 *   - EVERY `missing` resolution emits a deduplicated structured diagnostic; the
 *     diagnostic context is REQUIRED, so there is no silent-omission path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveVendorPresentation,
  VENDOR_BY_CONNECTIVE,
  VENDOR_MISSING_LABEL,
} from "../vendor-presentation";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveVendorPresentation — known state", () => {
  it("resolves a real display name to known, carrying the store URL", () => {
    expect(
      resolveVendorPresentation(
        { name: "Foundry", storeUrl: "https://marketplace.cinatra.ai/store/foundry" },
        { surface: "unit-test-surface", ref: "@scope/foundry" },
      ),
    ).toEqual({
      kind: "known",
      displayName: "Foundry",
      storeUrl: "https://marketplace.cinatra.ai/store/foundry",
    });
  });

  it("trims the display name and defaults an absent store URL to null", () => {
    expect(
      resolveVendorPresentation({ name: "  Acme Labs  " }, { surface: "unit-test-surface", ref: "@scope/acme" }),
    ).toEqual({
      kind: "known",
      displayName: "Acme Labs",
      storeUrl: null,
    });
  });

  it("preserves a long / Unicode display name verbatim (never slug-ifies it)", () => {
    const name = "Ştefan & Associés — Ελληνικά Εργαλεία 日本語ツール";
    const result = resolveVendorPresentation({ name }, { surface: "unit-test-surface", ref: "@scope/unicode" });
    expect(result).toEqual({ kind: "known", displayName: name, storeUrl: null });
  });
});

describe("resolveVendorPresentation — missing state (never a slug / scope)", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["tab/newline only", "\t\n "],
  ])("resolves a %s display name to missing", (label, name) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      resolveVendorPresentation({ name }, { surface: "unit-test-surface", ref: `@scope/missing-${label}` }),
    ).toEqual({ kind: "missing" });
  });

  it("drops any surviving store URL on missing (the placeholder is never linked)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveVendorPresentation(
      { name: "", storeUrl: "https://evil.example/store" },
      { surface: "unit-test-surface", ref: "@scope/missing-url" },
    );
    expect(result).toEqual({ kind: "missing" });
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

  it("has no silent-omission path — a required diagnostic means every missing resolution logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      resolveVendorPresentation({ name: "" }, { surface: "unit-test-surface", ref: "@scope/no-silent-path" }),
    ).toEqual({ kind: "missing" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      event: "vendor.display_name.missing",
      ref: "@scope/no-silent-path",
    });
  });

  it("states the DATA defect and never asserts what the surface drew", () => {
    // The resolver returns a STATE; it does not render. A message that names a
    // rendering is a claim the resolver cannot make, and it became false the
    // moment a surface drew the missing state some other way — the run, chat and
    // widget Skills pill, which the ratified drawing gives "the skill's name and
    // then by its vendor" and no stand-in for an absent one, draws the name
    // alone. The diagnostic reports the missing display name; each surface owns
    // its own reading of it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveVendorPresentation({ name: null }, { surface: "unit-test-surface", ref: "@scope/no-claim" });
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("missing vendor display name");
    expect(message).not.toContain("rendered");
    expect(message).not.toContain(VENDOR_MISSING_LABEL);
  });
});

describe("centralized byline copy", () => {
  it("exposes a single definition of the connective and placeholder", () => {
    expect(VENDOR_BY_CONNECTIVE).toBe("by");
    expect(VENDOR_MISSING_LABEL).toBe("Unknown vendor");
  });
});
