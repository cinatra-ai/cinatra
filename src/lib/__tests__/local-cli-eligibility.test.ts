import { describe, it, expect } from "vitest";
import { localCliEligible, isPreviewInstallation } from "@/lib/runtime-mode";

// The single server-resolved eligibility predicate for the connectors' dev/preview
// "Local CLI" connection mode (cinatra#1926). Exhaustively env-parameterized so it
// is proven without mutating process.env.

describe("isPreviewInstallation", () => {
  it("is true ONLY for the exact server-side install-class string 'preview'", () => {
    expect(isPreviewInstallation({ CINATRA_INSTALL_CLASS: "preview" })).toBe(true);
  });

  it("fails safe for every other (or absent) install-class value", () => {
    for (const v of [undefined, "", "Preview", "prod", "production", "PREVIEW", "demo", "preview "]) {
      expect(isPreviewInstallation({ CINATRA_INSTALL_CLASS: v })).toBe(false);
    }
  });
});

describe("localCliEligible", () => {
  it("is eligible in development mode (regardless of install class)", () => {
    expect(localCliEligible({ CINATRA_RUNTIME_MODE: "development" })).toBe(true);
    expect(localCliEligible({ APP_RUNTIME_MODE: "development" })).toBe(true);
    // Unset runtime mode normalizes to development (matches getAppRuntimeMode).
    expect(localCliEligible({})).toBe(true);
  });

  it("is eligible for a preview installation even in production runtime", () => {
    expect(
      localCliEligible({ CINATRA_RUNTIME_MODE: "production", CINATRA_INSTALL_CLASS: "preview" }),
    ).toBe(true);
  });

  it("is INELIGIBLE for a production, non-preview installation", () => {
    expect(localCliEligible({ CINATRA_RUNTIME_MODE: "production" })).toBe(false);
    expect(localCliEligible({ CINATRA_RUNTIME_MODE: "prod" })).toBe(false);
    expect(
      localCliEligible({ CINATRA_RUNTIME_MODE: "production", CINATRA_INSTALL_CLASS: "normal" }),
    ).toBe(false);
  });

  it("CINATRA_RUNTIME_MODE takes precedence over APP_RUNTIME_MODE (getAppRuntimeMode order)", () => {
    expect(
      localCliEligible({ CINATRA_RUNTIME_MODE: "production", APP_RUNTIME_MODE: "development" }),
    ).toBe(false);
  });
});
