/**
 * RequiredDependenciesSection — pre-install "A requires B, C" surface (cinatra
 * #209 item 2, surface 1). Renders the REAL manifest-derived requires summary;
 * this test drives it with `summarizeRequiredDependencies` over real edge
 * shapes and asserts the rendered structure (auto-installed vs peer vs
 * optional, package names + constraints, hidden when empty).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { RequiredDependenciesSection } from "../extensions/required-dependencies-section";
import { summarizeRequiredDependencies } from "@/lib/extension-dependency-ux";
import type { ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";

function edge(over: Partial<ExtensionDependency> & { packageName: string }): ExtensionDependency {
  return {
    edgeType: "runtime",
    requirement: "required",
    versionConstraint: { kind: "semver-range", range: "^1.0.0" },
    ...over,
  };
}

describe("RequiredDependenciesSection", () => {
  it("renders nothing when the package declares no dependencies", () => {
    const html = renderToStaticMarkup(
      <RequiredDependenciesSection summary={summarizeRequiredDependencies([])} />,
    );
    expect(html).toBe("");
  });

  it("lists auto-installed required deps with names and constraints", () => {
    const html = renderToStaticMarkup(
      <RequiredDependenciesSection
        summary={summarizeRequiredDependencies([
          edge({ packageName: "@scope/dep-a", versionConstraint: { kind: "exact", version: "2.0.0" } }),
        ])}
      />,
    );
    expect(html).toContain("required-dependencies-section");
    expect(html).toContain("@scope/dep-a");
    expect(html).toContain("=2.0.0");
    expect(html).toContain("installs its required dependencies automatically");
    expect(html).toContain('data-relationship="auto"');
  });

  it("separates peer and optional edges with their own labels", () => {
    const html = renderToStaticMarkup(
      <RequiredDependenciesSection
        summary={summarizeRequiredDependencies([
          edge({ packageName: "@scope/peer", edgeType: "peer", requirement: "required" }),
          edge({ packageName: "@scope/opt", edgeType: "runtime", requirement: "optional" }),
        ])}
      />,
    );
    expect(html).toContain('data-relationship="peer"');
    expect(html).toContain('data-relationship="optional"');
    expect(html).toContain("installed separately");
    expect(html).toContain("reduced capability");
  });
});
