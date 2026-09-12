/**
 * The fleet's install-blocking edges close over the fleet itself.
 *
 * Every REQUIRED, non-peer dependency edge is install-blocking
 * (`isInstallBlockingEdge`); a target that is absent from the installed set
 * lands in `missingRequired` and becomes a `REQUIRED_MISSING` execution block.
 * The static manifest IS the installed set for a pinned host, so an edge in it
 * that points at a package the manifest does not carry is a broken closure
 * shipped to every boot.
 *
 * This is the seam a package RETIREMENT has to cross: dropping a package from
 * `cinatra.devExtensions` drops its record from this manifest, and any surviving
 * dependent that still declares a required edge to it breaks here. Wave P3 of
 * cinatra#3034 measured exactly that — retiring `blog-image-prompt-agent` while
 * `blog-pipeline-agent` still declared a required runtime edge to it took the
 * broken-edge count from 0 to 1 — which is why the retirement waited for the
 * pipeline's own re-pin instead of shipping the break.
 *
 * That re-pin has LANDED: `blog-pipeline-agent` is pinned here at a commit whose
 * own manifest no longer declares the image-prompt edge, so the generated record
 * carries its required runtime targets without that one. The second test below is
 * the same tripwire read from the far side — it holds the re-pinned shape, so a
 * later re-pin that puts the edge back has to be seen and decided on rather than
 * silently blocking the retirement again.
 *
 *   pnpm exec vitest run src/lib/__tests__/static-extension-manifest-required-closure.test.ts
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isInstallBlockingEdge } from "@cinatra-ai/extensions/dependency-closure";
import type { ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";

import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";

describe("the static extension manifest's install-blocking edges close", () => {
  it("carries a record for every required, non-peer dependency target", () => {
    const present = new Set(Object.keys(STATIC_EXTENSION_MANIFEST));
    const broken: string[] = [];
    for (const [packageName, record] of Object.entries(STATIC_EXTENSION_MANIFEST)) {
      const deps = (record.dependencies ?? []) as ExtensionDependency[];
      for (const dep of deps) {
        if (!isInstallBlockingEdge(dep)) continue;
        if (!present.has(dep.packageName)) {
          broken.push(`${packageName} -> ${dep.packageName}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("no longer requires the image-prompt agent now that the pipeline is re-pinned", () => {
    // The retirement's tripwire, read from the far side of the re-pin: the
    // pipeline's pinned manifest has dropped the image-prompt edge, so dropping
    // the image-prompt record no longer breaks the closure above. A re-pin that
    // reinstates the edge goes red here and has to be decided on.
    const pipeline = STATIC_EXTENSION_MANIFEST["@cinatra-ai/blog-pipeline-agent"];
    expect(pipeline, "the pipeline agent is pinned in this fleet").toBeDefined();
    const required = ((pipeline!.dependencies ?? []) as ExtensionDependency[])
      .filter((dep) => isInstallBlockingEdge(dep))
      .map((dep) => dep.packageName);
    expect(required).not.toContain("@cinatra-ai/blog-image-prompt-agent");
    expect(required.length).toBeGreaterThan(0);
    for (const target of required) {
      expect(Object.keys(STATIC_EXTENSION_MANIFEST)).toContain(target);
    }
  });
});
