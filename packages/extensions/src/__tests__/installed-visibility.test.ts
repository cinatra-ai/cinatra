/**
 * cinatra#3447 — the installed row's marketplace visibility, the value the §V
 * settings page reads as "is this published on the marketplace?".
 *
 * The row assembly used to read an ABSENT registry origin as `"public"`, so an
 * extension that was never published anywhere had its §V Marketplace group
 * print the bare line "Published on the marketplace." instead of the gated
 * publish action the drawing gives. An absent origin is not a public
 * visibility; a row that really is public still reads public.
 */
import { describe, expect, it } from "vitest";

import { resolveInstalledRowVisibility } from "../screens/installed-visibility";

/** The catalog summary's origin block, as the registry publishes it. */
const originBlock = (visibility: string) => ({ visibility, scope: "@cinatra-ai" });

describe("resolveInstalledRowVisibility (cinatra#3447)", () => {
  it("reads an extension with NO registry origin as private — never published", () => {
    // The dev-fleet agent case: the native template row carries no origin
    // block, and the package is in no marketplace catalog either.
    expect(resolveInstalledRowVisibility({ nativeVisibility: null, origin: null })).toBe("private");
    expect(resolveInstalledRowVisibility({ nativeVisibility: null, origin: undefined })).toBe(
      "private",
    );
  });

  it("keeps a genuinely public row public", () => {
    expect(
      resolveInstalledRowVisibility({
        nativeVisibility: null,
        origin: originBlock("public"),
      }),
    ).toBe("public");
    expect(
      resolveInstalledRowVisibility({
        nativeVisibility: null,
        origin: originBlock("locked_public"),
      }),
    ).toBe("public");
  });

  it("keeps a private-origin row private", () => {
    expect(
      resolveInstalledRowVisibility({
        nativeVisibility: null,
        origin: originBlock("private"),
      }),
    ).toBe("private");
  });

  it("lets the kind's own native row win over the catalog summary", () => {
    // A private agent beyond the registry page cap must not render public.
    expect(
      resolveInstalledRowVisibility({
        nativeVisibility: "private",
        origin: originBlock("public"),
      }),
    ).toBe("private");
    expect(resolveInstalledRowVisibility({ nativeVisibility: "public", origin: null })).toBe(
      "public",
    );
  });
});

// ---------------------------------------------------------------------------
// The registries grandfather clause (packages/registries/src/types.ts): a
// package PUBLISHED before the visibility convention carries a catalog summary
// with a null `origin`, and its contract defaults that null to "public".
// ---------------------------------------------------------------------------

describe("resolveInstalledRowVisibility — the legacy grandfather clause (cinatra#3447)", () => {
  it("keeps a legacy published package public: a catalog summary, no origin block", () => {
    expect(
      resolveInstalledRowVisibility({
        nativeVisibility: null,
        origin: null,
        hasCatalogSummary: true,
      }),
    ).toBe("public");
  });

  it("reads a package with no catalog summary at all as private", () => {
    expect(
      resolveInstalledRowVisibility({
        nativeVisibility: null,
        origin: null,
        hasCatalogSummary: false,
      }),
    ).toBe("private");
  });

  it("lets an explicit private origin beat the summary's presence", () => {
    expect(
      resolveInstalledRowVisibility({
        nativeVisibility: null,
        origin: originBlock("private"),
        hasCatalogSummary: true,
      }),
    ).toBe("private");
  });
});
