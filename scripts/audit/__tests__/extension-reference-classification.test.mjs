import { describe, it, expect } from "vitest";
import {
  CLASSIFICATIONS,
  PERMANENT_EXEMPT_FILES,
  DATA_CONTRACT_ID_ALLOWLIST,
  MECHANICAL_FILES,
  classifyFile,
  allowlistDefects,
  staleAllowlistEntries,
  summarizeByClassification,
} from "../lib/extension-reference-classification.mjs";

describe("extension-reference classification taxonomy", () => {
  it("exposes exactly the three classes", () => {
    expect([...CLASSIFICATIONS]).toEqual(["runtime-coupling", "mechanical", "permanent-exempt"]);
  });

  it("the permanent-exempt FILE set is ONLY the generated manifest (strict policy)", () => {
    expect([...PERMANENT_EXEMPT_FILES]).toEqual(["src/lib/generated/extensions.server.ts"]);
  });

  it("the generated DERIVATIVES are mechanical, not exempt (strict reading: only the manifest is exempt)", () => {
    expect(classifyFile("src/lib/generated/connector-setup-pages.ts")).toBe("mechanical");
    expect(classifyFile("src/lib/generated/extensions.client.tsx")).toBe("mechanical");
    expect(classifyFile("src/lib/generated/extensions.server.ts")).toBe("permanent-exempt");
  });

  it("inventories/catalogs are mechanical; everything else defaults to runtime-coupling", () => {
    expect(classifyFile("packages/extensions/src/system-extension-inventory.ts")).toBe("mechanical");
    expect(classifyFile("src/lib/objects/surface-inventory.ts")).toBe("mechanical");
    expect(classifyFile("packages/connectors-catalog/src/descriptors.mjs")).toBe("mechanical");
    expect(classifyFile("src/lib/register-transport-connectors.ts")).toBe("runtime-coupling");
    expect(classifyFile("src/lib/connector-setup-pages.ts")).toBe("runtime-coupling");
  });

  it("every mechanical entry carries a written rationale", () => {
    for (const [file, rationale] of MECHANICAL_FILES) {
      expect(typeof rationale, file).toBe("string");
      expect(rationale.trim().length, file).toBeGreaterThan(10);
    }
  });

  it("allowlistDefects flags entries without a written justification", () => {
    expect(allowlistDefects(new Map([["@scope/x:contract", "stable persisted artifact-kind key"]]))).toEqual([]);
    expect(allowlistDefects(new Map([["@scope/x:contract", ""]]))).toEqual(["@scope/x:contract"]);
    expect(allowlistDefects(new Map([["@scope/x:contract", "   "]]))).toEqual(["@scope/x:contract"]);
    expect(allowlistDefects(new Map([["@scope/x:contract", null]]))).toEqual(["@scope/x:contract"]);
  });

  it("the committed allowlist itself has no defects (every entry justified)", () => {
    expect(allowlistDefects(DATA_CONTRACT_ID_ALLOWLIST)).toEqual([]);
  });

  it("staleAllowlistEntries flags entries with zero scan hits (self-policing shrink)", () => {
    const allowlist = new Map([
      ["@scope/x:contract", "stable contract"],
      ["@scope/y:contract", "stable contract"],
    ]);
    const hits = new Map([["@scope/x:contract", 3]]);
    expect(staleAllowlistEntries(hits, allowlist)).toEqual(["@scope/y:contract"]);
    expect(staleAllowlistEntries(new Map(), allowlist)).toEqual(["@scope/x:contract", "@scope/y:contract"]);
  });

  it("summarizeByClassification splits a flat occurrence map per class", () => {
    const occ = {
      "src/lib/foo.ts :: package :: @scope/a": 2,
      "src/lib/foo.ts :: path :: extensions/s/a": 1,
      "src/lib/generated/connector-setup-pages.ts :: package :: @scope/a": 4,
    };
    expect(summarizeByClassification(occ)).toEqual({
      "runtime-coupling": { files: 1, keys: 2, occurrences: 3 },
      mechanical: { files: 1, keys: 1, occurrences: 4 },
    });
  });
});
