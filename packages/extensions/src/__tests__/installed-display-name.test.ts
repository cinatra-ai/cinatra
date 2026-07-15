/**
 * §VI installed-page card title hydration (cinatra#1570 AC3b/AC5b): the
 * declared `cinatra.displayName` must reach the card, so a locked/system
 * extension with no marketplace catalog entry no longer falls to its raw
 * package name. This pins the precedence — and, critically, the fail-closed
 * degradation (a genuinely nameless package still renders SOMETHING, never an
 * empty title) — independently of the server-only row loader (AC4).
 */
import { describe, expect, it } from "vitest";

import { resolveInstalledDisplayName } from "../screens/installed-display-name";

const PKG = "@cinatra-ai/default-artifact";

describe("resolveInstalledDisplayName (cinatra#1570 §VI card title)", () => {
  it("prefers the per-kind native descriptor name above everything", () => {
    expect(
      resolveInstalledDisplayName({
        nativeName: "Live Capability Name",
        registryTitle: "Catalog Title",
        manifestDisplayName: "Manifest Name",
        packageName: PKG,
      }),
    ).toBe("Live Capability Name");
  });

  it("keeps the registry catalog title when a package is listed (no behaviour change)", () => {
    // A catalog-listed extension already rendered its packument title — the new
    // manifest tier must NOT displace it.
    expect(
      resolveInstalledDisplayName({
        nativeName: null,
        registryTitle: "Catalog Title",
        manifestDisplayName: "Manifest Name",
        packageName: PKG,
      }),
    ).toBe("Catalog Title");
  });

  it("rescues the locked/system class from the raw package name via cinatra.displayName", () => {
    // The #1570 case: an artifact-kind descriptor carries no name AND a locked
    // system extension has no catalog summary — so the self-declared manifest
    // displayName is the only human source. Before the fix the row fell to
    // `@cinatra-ai/default-artifact`.
    expect(
      resolveInstalledDisplayName({
        nativeName: null,
        registryTitle: null,
        manifestDisplayName: "Default Artifact",
        packageName: PKG,
      }),
    ).toBe("Default Artifact");
  });

  it("generalises: any locked extension with a declared displayName resolves it", () => {
    expect(
      resolveInstalledDisplayName({
        nativeName: null,
        registryTitle: null,
        manifestDisplayName: "Some Other System Extension",
        packageName: "@cinatra-ai/some-system-skill",
      }),
    ).toBe("Some Other System Extension");
  });

  it("degrades to the raw package name only when NO human source exists — never an empty title", () => {
    expect(
      resolveInstalledDisplayName({
        nativeName: null,
        registryTitle: null,
        manifestDisplayName: null,
        packageName: PKG,
      }),
    ).toBe(PKG);
    expect(
      resolveInstalledDisplayName({
        nativeName: undefined,
        registryTitle: undefined,
        manifestDisplayName: undefined,
        packageName: PKG,
      }),
    ).toBe(PKG);
  });

  it("treats blank/whitespace at any tier as absent (fail-closed to the next source)", () => {
    // A blank descriptor name falls through to the catalog title…
    expect(
      resolveInstalledDisplayName({
        nativeName: "   ",
        registryTitle: "Catalog Title",
        manifestDisplayName: "Manifest Name",
        packageName: PKG,
      }),
    ).toBe("Catalog Title");
    // …a blank descriptor + blank title falls through to the manifest name…
    expect(
      resolveInstalledDisplayName({
        nativeName: "",
        registryTitle: "  ",
        manifestDisplayName: "Default Artifact",
        packageName: PKG,
      }),
    ).toBe("Default Artifact");
    // …and an all-blank set still yields the package name, trimmed of nothing.
    expect(
      resolveInstalledDisplayName({
        nativeName: " ",
        registryTitle: "",
        manifestDisplayName: "   ",
        packageName: PKG,
      }),
    ).toBe(PKG);
  });

  it("trims a surrounding-whitespace human name to the clean value", () => {
    expect(
      resolveInstalledDisplayName({
        nativeName: null,
        registryTitle: null,
        manifestDisplayName: "  Default Artifact  ",
        packageName: PKG,
      }),
    ).toBe("Default Artifact");
  });
});
