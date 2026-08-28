/**
 * ENABLER 0.11 — extension-legal read-only compositions. The contract-level
 * acceptance test (cinatra#3027 / epic #3023).
 *
 * THE ENABLER'S OWN SENTENCE: "a host composition an extension display needs is
 * promoted into an SDK surface an extension may depend on and admitted at the
 * extension boundary, and BOTH THE HOST PAGE AND THE EXTENSION CONSUME THE SAME
 * COMPOSITION — the read-only dashboard and single-portlet views are the first."
 *
 * FIXING: "an extension outside this repository may not import the host's
 * compositions, so a display that needs one cannot render at all; and no
 * read-only variant of such a composition exists today."
 *
 * The compositions themselves mount drizzle-cube's client tree, which no node
 * unit tier renders. What IS provable here — and what actually rots — is the
 * promotion: that the admission list is closed and read-only by declaration,
 * that the promoted surface really exports what the list promises, and that the
 * HOST consumes that surface rather than keeping a second copy of it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  findPromotedReadOnlyComposition,
  isCompositionAdmittedForExtension,
  PROMOTED_READ_ONLY_COMPOSITIONS,
} from "@cinatra-ai/sdk-extensions/read-only-compositions";

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

describe("enabler 0.11 — the promotion is an admission list, closed and read-only", () => {
  it("promotes the read-only dashboard and the single-portlet view, exactly as the plan names them", () => {
    expect(PROMOTED_READ_ONLY_COMPOSITIONS.map((c) => c.id).sort()).toEqual([
      "read-only-dashboard",
      "read-only-single-portlet",
    ]);
  });

  it("declares EVERY promoted composition read-only — promoting a writable one is a test failure", () => {
    for (const composition of PROMOTED_READ_ONLY_COMPOSITIONS) {
      expect(composition.mutationAffordances).toBe("none");
      expect(composition.specifier.startsWith("@cinatra-ai/sdk-")).toBe(true);
      expect(composition.promotedFrom.length).toBeGreaterThan(0);
    }
  });

  it("admits the exact (specifier, export) pairs and NOTHING else", () => {
    expect(
      isCompositionAdmittedForExtension({
        specifier: "@cinatra-ai/sdk-dashboard/components",
        exportName: "ReadOnlyComposedDashboard",
      }),
    ).toBe(true);
    // An unpromoted export at a promoted specifier.
    expect(
      isCompositionAdmittedForExtension({
        specifier: "@cinatra-ai/sdk-dashboard/components",
        exportName: "ComposedDashboard",
      }),
    ).toBe(false);
    // A promoted export name at some other specifier.
    expect(
      isCompositionAdmittedForExtension({
        specifier: "@cinatra-ai/dashboards/composed-dashboard",
        exportName: "ReadOnlyComposedDashboard",
      }),
    ).toBe(false);
    expect(findPromotedReadOnlyComposition("nothing-of-the-sort")).toBeNull();
  });
});

describe("enabler 0.11 — ONE composition, consumed by the host and by an extension", () => {
  it("exports what the admission list promises, from the promoted specifier", () => {
    const surface = read("packages/sdk-dashboard/src/components/index.ts");
    for (const composition of PROMOTED_READ_ONLY_COMPOSITIONS) {
      expect(surface).toContain(composition.exportName);
    }
    // And the promoted specifier is a real subpath of the SDK package, not a
    // path only this repository can resolve.
    const pkg = JSON.parse(read("packages/sdk-dashboard/package.json")) as {
      exports?: Record<string, unknown>;
    };
    expect(pkg.exports?.["./components"]).toBe("./src/components/index.ts");
  });

  it("mounts NO mutation surface: no toolbar, no modals, no edit mode", () => {
    const source = read("packages/sdk-dashboard/src/components/read-only-composition.tsx");
    expect(source).not.toMatch(/DashboardModals/);
    expect(source).not.toMatch(/DashboardToolbar/);
    expect(source).toContain("DashboardGridSurface");
    expect(source).toContain("editable={false}");
  });

  it("makes the HOST composition call the promoted one rather than copy it", () => {
    const host = read("packages/dashboards/src/components/composed-dashboard.tsx");
    expect(host).toContain('from "@cinatra-ai/sdk-dashboard/components"');
    expect(host).toContain("ReadOnlyComposedDashboard");
    // The host's read-only branch DELEGATES; it does not assemble a second one.
    expect(host).toMatch(/if \(readOnly\)[\s\S]{0,200}<ReadOnlyComposedDashboard/);
  });
});
