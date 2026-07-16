/**
 * Variable-URL dynamic-import ratchet (epic #1620 M1 Slice A — cinatra#1630,
 * plan §2.4/G4): the AST detector flags a computed `import()` and passes a
 * literal one; the live `src/**` tree has NO un-sanctioned variable-URL import.
 */
import { describe, expect, it } from "vitest";

import {
  SANCTIONED_VARIABLE_URL_IMPORT_FILES,
  detectVariableUrlDynamicImports,
  scanRepo,
} from "../no-variable-url-dynamic-import.mjs";

describe("AST detector", () => {
  it("passes a string-literal specifier (even wrapped across lines)", () => {
    expect(detectVariableUrlDynamicImports('const m = await import("@/x/y");', "a.ts")).toHaveLength(0);
    expect(
      detectVariableUrlDynamicImports('const m = await import(\n  "@/x/y"\n);', "a.ts"),
    ).toHaveLength(0);
  });

  it("passes a no-substitution template literal", () => {
    expect(detectVariableUrlDynamicImports("const m = await import(`@/x/y`);", "a.ts")).toHaveLength(0);
  });

  it("FLAGS a variable / property-access / substituted-template specifier", () => {
    expect(detectVariableUrlDynamicImports("const m = await import(url);", "a.ts")).toHaveLength(1);
    expect(detectVariableUrlDynamicImports("const m = await import(d.href);", "a.ts")).toHaveLength(1);
    expect(detectVariableUrlDynamicImports("const m = await import(`/x/${id}.js`);", "a.ts")).toHaveLength(1);
    expect(detectVariableUrlDynamicImports("const m = await import(fn());", "a.ts")).toHaveLength(1);
  });

  it("reports the line + a snippet", () => {
    const f = detectVariableUrlDynamicImports("\n\nconst m = await import(u);", "a.ts");
    expect(f[0].line).toBe(3);
    expect(f[0].snippet).toContain("import(u)");
  });
});

describe("repo ratchet", () => {
  it("the live src/** tree has zero un-sanctioned variable-URL imports", () => {
    expect(scanRepo()).toEqual([]);
  });

  it("the sanctioned client loader seam is on the allowlist", () => {
    expect(SANCTIONED_VARIABLE_URL_IMPORT_FILES).toContain(
      "src/app/artifacts/[id]/dynamic-renderer-loader.tsx",
    );
  });
});
