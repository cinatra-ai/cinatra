/**
 * THE HOST-SERVED READ-ONLY DASHBOARD COMPOSITION (cinatra#3092, epic #3087) —
 * the extension checks and the bundle builder.
 *
 * The plan: "the dashboard extension lives outside this repository and cannot
 * import the host's composition". The fix admits exactly the one composition
 * module and its two promoted views as a HOST-SERVED module — the road the
 * shared design primitives already take — and nothing wider: the base package
 * `@cinatra-ai/sdk-dashboard` and every other subpath of it stay extraction-
 * blocking coupling.
 *
 * Every case drives the REAL predicates: the inventory's `isSdkOnlyViolation`
 * and its two scanners, the phantom-dependency gate's third-party scan, and the
 * builder's own externals allowlist beside the SDK's.
 */
import { describe, expect, it } from "vitest";

import * as builder from "../build-client-renderer-bundle.mjs";
import * as inventory from "../inventory.mjs";
import { extractThirdPartyImports } from "../../audit/workspace-phantom-deps.mjs";
import * as sdk from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

// The one admitted specifier, written out here so a red reads as the predicate's
// answer and never as a missing constant.
const COMPOSITION = "@cinatra-ai/sdk-dashboard/components";
const SELF = "@fixture/dashboard-display";

describe("the inventory admits the composition specifier EXACTLY", () => {
  it("(a1) the composition specifier is not SDK-only coupling", () => {
    expect(inventory.isSdkOnlyViolation(COMPOSITION)).toBe(false);
  });

  it("(a1) the base package and every other subpath stay violations", () => {
    for (const nearMiss of [
      "@cinatra-ai/sdk-dashboard",
      "@cinatra-ai/sdk-dashboard/adapters/drizzle-cube",
      "@cinatra-ai/sdk-dashboard/components/narrow-to-single-portlet",
    ]) {
      expect(inventory.isSdkOnlyViolation(nearMiss), nearMiss).toBe(true);
    }
  });

  it("(a1) an import of the composition is reported as host-served, never as coupling", () => {
    const text = `import { ReadOnlyComposedDashboard, ReadOnlySinglePortlet } from "${COMPOSITION}";`;
    expect([...inventory.scanSdkOnlyImportsInText(text, SELF)]).toEqual([]);
    expect([...inventory.scanHostServedImportsInText(text, SELF)]).toEqual([COMPOSITION]);
  });

  it("(a1) a sibling subpath import still reads as coupling on the base package", () => {
    const text = `import { narrowToSinglePortlet } from "${COMPOSITION}/narrow-to-single-portlet";`;
    expect([...inventory.scanSdkOnlyImportsInText(text, SELF)]).toEqual(["@cinatra-ai/sdk-dashboard"]);
    expect([...inventory.scanHostServedImportsInText(text, SELF)]).toEqual([]);
  });

  it("(a1) the inventory's mirror of the admitted pairs names the one specifier and its two views", () => {
    const mirror = inventory.HOST_SERVED_READ_ONLY_COMPOSITIONS;
    expect(Array.isArray(mirror)).toBe(true);
    expect(mirror.map((c) => [c.specifier, c.exportName])).toEqual([
      [COMPOSITION, "ReadOnlyComposedDashboard"],
      [COMPOSITION, "ReadOnlySinglePortlet"],
    ]);
  });
});

describe("the phantom-dependency gate skips the exact composition specifier", () => {
  it("(a2) an undeclared import of the composition specifier is not a phantom dependency", () => {
    const src = `import { ReadOnlyComposedDashboard } from "${COMPOSITION}";`;
    expect([...extractThirdPartyImports(src, new Set(), SELF)]).toEqual([]);
  });

  it("(a2) a near-miss subpath of it is still reported", () => {
    const src = `import { narrowToSinglePortlet } from "${COMPOSITION}/narrow-to-single-portlet";`;
    expect([...extractThirdPartyImports(src, new Set(), SELF)]).toEqual(["@cinatra-ai/sdk-dashboard"]);
  });
});

describe("the bundle builder leaves the composition external", () => {
  it("(a3) the builder's allowlist holds the specifier, and its constant is that specifier", () => {
    expect(builder.HOST_DASHBOARD_COMPOSITION_MODULE).toBe(COMPOSITION);
    expect(builder.CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toContain(COMPOSITION);
    expect(builder.isAllowedClientBundleExternal(COMPOSITION)).toBe(true);
    expect(builder.isAllowedClientBundleExternal("@cinatra-ai/sdk-dashboard")).toBe(false);
    expect(builder.isAllowedClientBundleExternal(`${COMPOSITION}/narrow-to-single-portlet`)).toBe(false);
  });

  it("(a3) the builder's allowlist equals the SDK's, member for member", () => {
    expect(builder.CLIENT_BUNDLE_EXTERNAL_ALLOWLIST).toEqual([...sdk.CLIENT_BUNDLE_EXTERNAL_ALLOWLIST]);
    expect(builder.HOST_DASHBOARD_COMPOSITION_MODULE).toBe(sdk.HOST_DASHBOARD_COMPOSITION_MODULE);
  });
});
