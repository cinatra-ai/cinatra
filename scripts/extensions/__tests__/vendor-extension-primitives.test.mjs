import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  rewriteUiImports,
  plannedFiles,
  resolveUiClosure,
  localItemName,
  findOrphans,
  VENDOR_MANIFEST,
} from "../vendor-extension-primitives.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The declared extension kind of a vendored entry, read from its own package.json. */
function kindOf(extensionDir) {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, extensionDir, "package.json"), "utf8"));
  return pkg?.cinatra?.kind ?? null;
}

describe("rewriteUiImports", () => {
  it("rewrites double-quoted @/lib/utils to a relative path", () => {
    expect(rewriteUiImports('import { cn } from "@/lib/utils"', "x.tsx")).toContain(
      'from "../../lib/utils"',
    );
  });

  // Regression: src/components/ui mixes quote styles; a double-quote-only
  // rewrite silently left single-quoted `@/lib/utils` coupled to the app.
  it("rewrites single-quoted '@/lib/utils' to a relative path", () => {
    expect(rewriteUiImports("import { cn } from '@/lib/utils'", "x.tsx")).toContain(
      'from "../../lib/utils"',
    );
  });

  it("rewrites @/components/ui/<x> to a sibling relative import (both quote styles)", () => {
    expect(rewriteUiImports('import { Label } from "@/components/ui/label"', "x.tsx")).toContain(
      'from "./label"',
    );
    expect(rewriteUiImports("import { Input } from '@/components/ui/input'", "x.tsx")).toContain(
      'from "./input"',
    );
  });

  it("throws on an un-vendorable @/ import (port-level coupling, either quote style)", () => {
    expect(() => rewriteUiImports('import { x } from "@/lib/auth-session"', "x.tsx")).toThrow(
      /un-vendorable app import/,
    );
    expect(() => rewriteUiImports("import { x } from '@/components/nango-user-connect-button'", "x.tsx")).toThrow(
      /un-vendorable app import/,
    );
  });

  it("leaves non-@/ imports untouched", () => {
    const src = 'import { cva } from "class-variance-authority"\nimport * as React from "react"';
    expect(rewriteUiImports(src, "x.tsx")).toBe(src);
  });
});

describe("resolveUiClosure", () => {
  it("auto-pulls the transitive sibling closure (field -> label + separator)", () => {
    const c = resolveUiClosure(["field"]);
    expect(c).toContain("field");
    expect(c).toContain("label");
    expect(c).toContain("separator");
  });

  it("auto-pulls input-group's button/input/textarea closure", () => {
    const c = resolveUiClosure(["input-group"]);
    expect(c).toEqual(expect.arrayContaining(["input-group", "button", "input", "textarea"]));
  });

  it("excludes the utils lib (vendored separately) and is cycle-safe", () => {
    const c = resolveUiClosure(["field", "input-group", "card", "badge"]);
    expect(c).not.toContain("utils");
    // terminates + dedupes (no throw, finite)
    expect(new Set(c).size).toBe(c.length);
  });

  it("a cn-only primitive resolves to just itself", () => {
    expect(resolveUiClosure(["card"])).toEqual(["card"]);
  });
});

describe("localItemName - the namespace rule the registry closure depends on", () => {
  it("strips our namespace", () => {
    expect(localItemName("@cinatra-ai/label")).toBe("label");
  });

  // Regression guard for the 2026-09-04 break: a BARE entry resolves against the
  // consumer's default registry, which is how upstream's like-named utils item
  // overwrote ours and dropped clsx + tailwind-merge.
  it("rejects a bare entry", () => {
    expect(() => localItemName("label")).toThrow(/not namespaced/);
  });

  it("rejects a foreign namespace", () => {
    expect(() => localItemName("@acme/label")).toThrow(/not namespaced/);
  });

  it("every registryDependencies entry in registry.json is namespaced", () => {
    const registry = JSON.parse(readFileSync(join(REPO_ROOT, "registry.json"), "utf8"));
    for (const item of registry.items) {
      for (const dep of item.registryDependencies ?? []) {
        expect(() => localItemName(dep)).not.toThrow();
      }
    }
  });
});

describe("findOrphans", () => {
  it("reports no orphans for the committed vendored state", () => {
    expect(findOrphans()).toEqual([]);
  });
});

describe("provenance — vendored files match registry source modulo rewrite", () => {
  it("every planned vendored file on disk equals transform(source)", () => {
    for (const file of plannedFiles()) {
      const source = readFileSync(join(REPO_ROOT, file.source), "utf8");
      const expected = file.transform(source);
      const actual = readFileSync(join(REPO_ROOT, file.target), "utf8");
      expect(actual, `${file.target} drifted from ${file.source}`).toBe(expected);
    }
  });

  // DECISION 407 A (2026-09-13, cinatra-ai/cinatra#3471, epic #2926): connectors
  // render the setup page themselves and artifacts render the artifact view
  // themselves, and the host shares its primitives with extension bundles at run
  // time — so the COPY CHANNEL IS RETIRED for those two kinds. Their remaining
  // copies are recorded from now on by the shrink-only border-gate baseline
  // (scripts/extensions/self-rendering-extensions-border.baseline.json), the ONLY
  // record of them, so a primitive change no longer forces a release of every
  // copying package. The kind is read from each entry's OWN package.json, so a
  // re-added connector/artifact entry fails here whatever it is called.
  it("vendors no kind:connector and no kind:artifact package (decision 407 A)", () => {
    const retired = VENDOR_MANIFEST.filter((entry) =>
      ["connector", "artifact"].includes(kindOf(entry.extensionDir)),
    ).map((entry) => entry.extensionDir);
    expect(retired).toEqual([]);
  });
});

// Every vendored file is copied byte-for-byte into ~20 extension repositories,
// so the vendoring SOURCES are a shared, cross-repository surface: an addition
// to src/lib/utils.ts is an addition to every one of those repositories, and
// until each has re-vendored, the provenance gate is red for all of them.
// src/lib/utils.ts is the registry `utils` item — `cn` and the small pure
// string/number helpers around it. Browser-shell geometry (the app header band,
// the impersonation banner custom property) is NOT that: it belongs to a module
// the vendoring channel never copies. This case pins the boundary so such a
// helper cannot be parked in the vendored lib again.
describe("the vendored lib source stays free of app-shell geometry", () => {
  const VENDORED_LIB = "src/lib/utils.ts";

  it("src/lib/utils.ts reads no document and no shell custom property", () => {
    const source = readFileSync(join(REPO_ROOT, VENDORED_LIB), "utf8");
    expect(source, `${VENDORED_LIB} must not touch the DOM`).not.toMatch(
      /\bdocument\b|getComputedStyle/,
    );
    expect(source, `${VENDORED_LIB} must not read a shell custom property`).not.toContain(
      "--banner-height",
    );
  });

  it("the overlay collision bound lives outside the vendored lib", () => {
    const source = readFileSync(join(REPO_ROOT, VENDORED_LIB), "utf8");
    expect(source).not.toContain("overlayCollisionPadding");
    const bound = readFileSync(join(REPO_ROOT, "src/lib/overlay-collision.ts"), "utf8");
    expect(bound).toContain("export function overlayCollisionPadding");
  });

  it("no planned vendored file is the overlay-collision module", () => {
    for (const file of plannedFiles()) {
      expect(file.source).not.toContain("overlay-collision");
    }
  });
});
