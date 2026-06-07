import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  rewriteUiImports,
  plannedFiles,
  resolveUiClosure,
  findOrphans,
  VENDOR_MANIFEST,
} from "../vendor-extension-primitives.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

  it("vendors at least the google-calendar primitive closure", () => {
    expect(VENDOR_MANIFEST[0].extensionDir).toContain("google-calendar-connector");
    expect(VENDOR_MANIFEST[0].uiItems).toEqual(
      expect.arrayContaining(["alert", "button", "field", "input-group"]),
    );
  });
});
