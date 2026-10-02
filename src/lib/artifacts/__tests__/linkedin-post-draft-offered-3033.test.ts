/**
 * cinatra#3033 (CELL4, the picker) — meaningExtensionFor: the extension a
 * person asserts when they give an upload a meaning. A host-registered type
 * that a pinned pack CLAIMS cross-namespace (as the
 * `@cinatra-ai/linkedin-artifacts` pack claims its post draft) names that sole
 * claimant; two claimants are an ambiguity no picker resolves.
 */
import { describe, expect, it } from "vitest";

import { meaningExtensionFor } from "../installed-type-picker";

const LINKEDIN_PACK = "@cinatra-ai/linkedin-artifacts";

describe("meaningExtensionFor — the extension a meaning assertion names (cinatra#3033)", () => {
  it("names the registering package when there is one", () => {
    expect(
      meaningExtensionFor({
        registeringPackage: "@acme/legal",
        crossNamespaceClaimants: ["@acme/other"],
      }),
    ).toBe("@acme/legal");
  });

  it("names the sole claimant of a host-registered type", () => {
    expect(
      meaningExtensionFor({
        registeringPackage: null,
        crossNamespaceClaimants: [LINKEDIN_PACK],
      }),
    ).toBe(LINKEDIN_PACK);
  });

  it("answers null for two claimants — an ambiguity no picker resolves", () => {
    expect(
      meaningExtensionFor({
        registeringPackage: null,
        crossNamespaceClaimants: ["@acme/a", "@acme/b"],
      }),
    ).toBeNull();
  });

  it("answers null for no registering package and no claimant", () => {
    expect(
      meaningExtensionFor({ registeringPackage: null, crossNamespaceClaimants: [] }),
    ).toBeNull();
  });
});
