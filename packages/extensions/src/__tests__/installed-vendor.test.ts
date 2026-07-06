/**
 * Wrong-data-field regression pin for the §VI installed-page byline
 * (cinatra#948 reopen, gap 3): the vendor is hydrated from manifest/registry
 * metadata only — the raw npm scope segment must NEVER surface as the vendor.
 */
import { describe, expect, it } from "vitest";

import { resolveInstalledVendorName } from "../screens/installed-vendor";

describe("resolveInstalledVendorName (cinatra#948 §VI byline)", () => {
  it("prefers the manifest-declared vendor identity name", () => {
    expect(
      resolveInstalledVendorName({ manifestVendorName: "Cinatra", author: "someone else" }),
    ).toBe("Cinatra");
  });

  it("falls back to the registry author when the manifest declares no vendor", () => {
    expect(
      resolveInstalledVendorName({ manifestVendorName: null, author: "Meridian Labs" }),
    ).toBe("Meridian Labs");
  });

  it("returns null when neither source carries a human name — never the scope", () => {
    // The caller renders the bare "{Type}" byline for null; the npm scope
    // segment is deliberately NOT an input to this resolver at all.
    expect(resolveInstalledVendorName({ manifestVendorName: null, author: null })).toBeNull();
    expect(resolveInstalledVendorName({ manifestVendorName: undefined, author: undefined })).toBeNull();
  });

  it("treats blank/whitespace values as absent", () => {
    expect(resolveInstalledVendorName({ manifestVendorName: "  ", author: "" })).toBeNull();
    expect(resolveInstalledVendorName({ manifestVendorName: "", author: "  Foundry " })).toBe(
      "Foundry",
    );
  });
});
