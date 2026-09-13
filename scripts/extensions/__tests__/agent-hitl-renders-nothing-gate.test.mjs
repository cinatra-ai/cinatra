// Agent-HITL renders-nothing ratchet (cinatra#3470, epic cinatra#2926).
//
// THE THREE-KIND RULE, made deterministic in the build: connectors
// render the setup page themselves, artifacts render the artifact view
// themselves, agents do NOT render the HITL view themselves. These cases pin the
// gate's shrink-only contract on SYNTHETIC extension trees written to a temp dir
// (the real scanner, not a toy), plus the committed baseline against the real
// synced tree.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE_FILE,
  EXTENSIONS_DIR,
  RULE_ISSUE,
  RULE_SENTENCE,
  assertBaselineShape,
  baselineFromTree,
  baselineGrowth,
  baselinePairs,
  baselinedComponentBindingIds,
  evaluate,
  incompleteTreeError,
  loadBaseline,
  scanExtensionTree,
  unknownKindPackages,
  vendoringManifestDirs,
} from "../agent-hitl-renders-nothing-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-hitl-gate-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write one synthetic extension package into the fixture tree. */
function writePackage({ name, kind, fieldRenderers = [], uiFiles = [] }) {
  const dir = name.replace(/^@/, "").split("/");
  const pkgDir = join(root, ...dir);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name, version: "0.0.0", cinatra: { kind, fieldRenderers } }, null, 2),
  );
  if (uiFiles.length > 0) {
    const uiDir = join(pkgDir, "src/components/ui");
    mkdirSync(uiDir, { recursive: true });
    for (const f of uiFiles) writeFileSync(join(uiDir, f), "export const x = 1;\n");
  }
  return `${root}/${dir.join("/")}`;
}

const EMPTY_BASELINE = { componentBindings: {}, vendoredPrimitives: {}, vendoringManifestEntries: {} };
const NO_VENDOR_DIRS = new Set();

describe("agent-hitl-renders-nothing gate — the agent clause", () => {
  it("a kind:agent manifest declaring a fieldRenderers[].component is RED", () => {
    writePackage({
      name: "@acme/rogue-agent",
      kind: "agent",
      fieldRenderers: [
        { id: "@acme/rogue-agent:review", kind: "cta", priority: 90, component: { entry: "./src/r.tsx" } },
      ],
    });
    const { violations, stale } = evaluate(scanExtensionTree(root), EMPTY_BASELINE, NO_VENDOR_DIRS);
    expect(stale).toEqual([]);
    expect(violations).toEqual([
      { kind: "component-binding", packageName: "@acme/rogue-agent", detail: "@acme/rogue-agent:review" },
    ]);
  });

  it("the SAME (package, binding id) pair listed in the baseline is GREEN", () => {
    writePackage({
      name: "@acme/rogue-agent",
      kind: "agent",
      fieldRenderers: [
        { id: "@acme/rogue-agent:review", kind: "cta", priority: 90, component: { entry: "./src/r.tsx" } },
      ],
    });
    const baseline = {
      ...EMPTY_BASELINE,
      componentBindings: { "@acme/rogue-agent": ["@acme/rogue-agent:review"] },
    };
    const { violations, stale } = evaluate(scanExtensionTree(root), baseline, NO_VENDOR_DIRS);
    expect(violations).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("a DIFFERENT binding id on a baselined package is still RED (the pair is exact, not the package)", () => {
    writePackage({
      name: "@acme/rogue-agent",
      kind: "agent",
      fieldRenderers: [
        { id: "@acme/rogue-agent:review", kind: "cta", priority: 90, component: { entry: "./src/r.tsx" } },
        { id: "@acme/rogue-agent:second", kind: "cta", priority: 90, component: { entry: "./src/s.tsx" } },
      ],
    });
    const baseline = {
      ...EMPTY_BASELINE,
      componentBindings: { "@acme/rogue-agent": ["@acme/rogue-agent:review"] },
    };
    const { violations } = evaluate(scanExtensionTree(root), baseline, NO_VENDOR_DIRS);
    expect(violations).toEqual([
      { kind: "component-binding", packageName: "@acme/rogue-agent", detail: "@acme/rogue-agent:second" },
    ]);
  });

  it("a kind:agent fieldRenderer WITHOUT a component is GREEN (the host renders it)", () => {
    writePackage({
      name: "@acme/plain-agent",
      kind: "agent",
      fieldRenderers: [{ id: "@acme/plain-agent:list-picker", kind: "list-picker", priority: 90 }],
    });
    expect(evaluate(scanExtensionTree(root), EMPTY_BASELINE, NO_VENDOR_DIRS)).toEqual({
      violations: [],
      stale: [],
    });
  });
});

describe("agent-hitl-renders-nothing gate — the rule is AGENT-ONLY", () => {
  it("a kind:connector package declaring a component is GREEN (connectors render the setup page themselves)", () => {
    writePackage({
      name: "@acme/thing-connector",
      kind: "connector",
      fieldRenderers: [
        { id: "@acme/thing-connector:setup", kind: "cta", priority: 90, component: { entry: "./src/c.tsx" } },
      ],
      uiFiles: ["button.tsx", "card.tsx"],
    });
    expect(evaluate(scanExtensionTree(root), EMPTY_BASELINE, NO_VENDOR_DIRS)).toEqual({
      violations: [],
      stale: [],
    });
  });

  it("a kind:artifact package declaring a component is GREEN (artifacts render the artifact view themselves)", () => {
    writePackage({
      name: "@acme/thing-artifact",
      kind: "artifact",
      fieldRenderers: [
        { id: "@acme/other-agent:review", kind: "cta", priority: 90, component: { entry: "./src/a.tsx" } },
      ],
      uiFiles: ["button.tsx"],
    });
    expect(evaluate(scanExtensionTree(root), EMPTY_BASELINE, NO_VENDOR_DIRS)).toEqual({
      violations: [],
      stale: [],
    });
  });
});

describe("agent-hitl-renders-nothing gate — vendored design-registry primitives", () => {
  it("a kind:agent package carrying files under src/components/ui/ is RED per file", () => {
    writePackage({ name: "@acme/drawing-agent", kind: "agent", uiFiles: ["button.tsx", "card.tsx"] });
    const { violations } = evaluate(scanExtensionTree(root), EMPTY_BASELINE, NO_VENDOR_DIRS);
    expect(violations).toEqual([
      { kind: "vendored-primitive", packageName: "@acme/drawing-agent", detail: "src/components/ui/button.tsx" },
      { kind: "vendored-primitive", packageName: "@acme/drawing-agent", detail: "src/components/ui/card.tsx" },
    ]);
  });

  it("the same (package, vendored file) pairs in the baseline are GREEN", () => {
    writePackage({ name: "@acme/drawing-agent", kind: "agent", uiFiles: ["button.tsx", "card.tsx"] });
    const baseline = {
      ...EMPTY_BASELINE,
      vendoredPrimitives: {
        "@acme/drawing-agent": ["src/components/ui/button.tsx", "src/components/ui/card.tsx"],
      },
    };
    expect(evaluate(scanExtensionTree(root), baseline, NO_VENDOR_DIRS)).toEqual({ violations: [], stale: [] });
  });

  it("a kind:agent package named by the VENDORING MANIFEST is RED even with no ui/ files on disk", () => {
    const dir = writePackage({ name: "@acme/claimant-agent", kind: "agent" });
    const { violations } = evaluate(scanExtensionTree(root), EMPTY_BASELINE, new Set([dir]));
    expect(violations).toEqual([
      { kind: "vendoring-manifest-entry", packageName: "@acme/claimant-agent", detail: dir },
    ]);
  });
});

describe("agent-hitl-renders-nothing gate — shrink-only (a baseline pair that no longer exists)", () => {
  it("a baselined component binding whose PACKAGE is gone is RED", () => {
    writePackage({ name: "@acme/plain-agent", kind: "agent" });
    const baseline = {
      ...EMPTY_BASELINE,
      componentBindings: { "@acme/retired-agent": ["@acme/retired-agent:review"] },
    };
    const { violations, stale } = evaluate(scanExtensionTree(root), baseline, NO_VENDOR_DIRS);
    expect(violations).toEqual([]);
    expect(stale).toEqual([
      { kind: "component-binding", packageName: "@acme/retired-agent", detail: "@acme/retired-agent:review" },
    ]);
  });

  it("a baselined component binding the package NO LONGER declares is RED (the win must be recorded)", () => {
    writePackage({ name: "@acme/migrated-agent", kind: "agent" });
    const baseline = {
      ...EMPTY_BASELINE,
      componentBindings: { "@acme/migrated-agent": ["@acme/migrated-agent:review"] },
    };
    const { stale } = evaluate(scanExtensionTree(root), baseline, NO_VENDOR_DIRS);
    expect(stale).toEqual([
      { kind: "component-binding", packageName: "@acme/migrated-agent", detail: "@acme/migrated-agent:review" },
    ]);
  });

  it("a baselined vendored file that was deleted is RED", () => {
    writePackage({ name: "@acme/migrated-agent", kind: "agent", uiFiles: ["button.tsx"] });
    const baseline = {
      ...EMPTY_BASELINE,
      vendoredPrimitives: {
        "@acme/migrated-agent": ["src/components/ui/button.tsx", "src/components/ui/card.tsx"],
      },
    };
    const { stale } = evaluate(scanExtensionTree(root), baseline, NO_VENDOR_DIRS);
    expect(stale).toEqual([
      { kind: "vendored-primitive", packageName: "@acme/migrated-agent", detail: "src/components/ui/card.tsx" },
    ]);
  });

  it("a baselined vendoring-manifest entry that was dropped from the manifest is RED", () => {
    const dir = writePackage({ name: "@acme/claimant-agent", kind: "agent" });
    const baseline = { ...EMPTY_BASELINE, vendoringManifestEntries: { "@acme/claimant-agent": [dir] } };
    const { stale } = evaluate(scanExtensionTree(root), baseline, NO_VENDOR_DIRS);
    expect(stale).toEqual([{ kind: "vendoring-manifest-entry", packageName: "@acme/claimant-agent", detail: dir }]);
  });
});

describe("agent-hitl-renders-nothing gate — the committed baseline vs the live synced tree", () => {
  it("names the rule and the issue", () => {
    expect(RULE_ISSUE).toBe("cinatra#3470");
    expect(RULE_SENTENCE).toContain("Agents do NOT render the HITL view themselves");
  });

  it("the committed baseline exists and carries the rule + the issue in its note", () => {
    expect(existsSync(BASELINE_FILE)).toBe(true);
    const baseline = loadBaseline();
    expect(baseline.note).toContain(RULE_ISSUE);
    expect(baseline.note).toContain("Agents do NOT render the HITL view themselves");
  });

  it("the committed baseline lists NO vendoring-manifest entry (the agent packages were dropped from it)", () => {
    expect(loadBaseline().vendoringManifestEntries).toEqual({});
    const scanned = scanExtensionTree(EXTENSIONS_DIR);
    const dirs = vendoringManifestDirs();
    for (const pkg of scanned) {
      if (pkg.kind !== "agent") continue;
      expect(dirs.has(pkg.extensionDir), `${pkg.packageName} is still a vendoring-manifest claimant`).toBe(false);
    }
  });

  it("the live synced tree is clean against the committed baseline (no additions, no stale entries)", () => {
    expect(evaluate(scanExtensionTree(EXTENSIONS_DIR), loadBaseline())).toEqual({ violations: [], stale: [] });
  });

  it("the committed baseline is byte-exact what --write-baseline would emit from the live tree", () => {
    const regenerated = JSON.stringify(baselineFromTree(scanExtensionTree(EXTENSIONS_DIR)), null, 2) + "\n";
    expect(readFileSync(BASELINE_FILE, "utf8")).toBe(regenerated);
  });

  it("baselinedComponentBindingIds reads the exact per-package list the validator consumes", () => {
    const baseline = loadBaseline();
    for (const [packageName, ids] of Object.entries(baseline.componentBindings)) {
      expect(baselinedComponentBindingIds(baseline, packageName)).toEqual(ids);
    }
    expect(baselinedComponentBindingIds(baseline, "@acme/never-heard-of-it")).toEqual([]);
  });

  it("every baselined vendored file is really on disk under the repo", () => {
    const live = scanExtensionTree(EXTENSIONS_DIR);
    for (const [packageName, files] of Object.entries(loadBaseline().vendoredPrimitives)) {
      const pkg = live.find((p) => p.packageName === packageName);
      expect(pkg, `${packageName} missing from the synced tree`).toBeDefined();
      for (const file of files) {
        expect(existsSync(join(REPO_ROOT, pkg.extensionDir, file)), `${pkg.extensionDir}/${file}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Convergence round (cinatra#3470): the holes a read-only review found in the
// first cut — a scanner that saw only immediate `*.tsx` children, a kind filter
// that exempted anything not spelled exactly "agent", a tolerated malformed or
// half-synced input, and the regenerate-to-pass bypass the base-ref arm closes.
// ---------------------------------------------------------------------------
describe("the scanner sees every vendored primitive, not only immediate *.tsx children", () => {
  it("a nested vendored primitive is RED", () => {
    const pkgDir = writePackage({ name: "@acme/nested-agent", kind: "agent", uiFiles: ["card.tsx"] });
    mkdirSync(join(pkgDir, "src/components/ui/nested"), { recursive: true });
    writeFileSync(join(pkgDir, "src/components/ui/nested/button.tsx"), "export const x = 1;\n");
    const { violations } = evaluate(scanExtensionTree(root), EMPTY_BASELINE, NO_VENDOR_DIRS);
    expect(violations.map((v) => v.detail)).toEqual([
      "src/components/ui/card.tsx",
      "src/components/ui/nested/button.tsx",
    ]);
  });

  it("a vendored primitive with a NON-.tsx extension is RED (a .ts/.jsx copy draws just as well)", () => {
    writePackage({ name: "@acme/ts-agent", kind: "agent", uiFiles: ["card.ts", "button.jsx"] });
    const { violations } = evaluate(scanExtensionTree(root), EMPTY_BASELINE, NO_VENDOR_DIRS);
    expect(violations.map((v) => v.detail)).toEqual(["src/components/ui/button.jsx", "src/components/ui/card.ts"]);
  });

  it("a DIRECTORY named like a primitive is not counted as one (no false red)", () => {
    const pkgDir = writePackage({ name: "@acme/dir-agent", kind: "agent" });
    mkdirSync(join(pkgDir, "src/components/ui/card.tsx"), { recursive: true });
    expect(evaluate(scanExtensionTree(root), EMPTY_BASELINE, NO_VENDOR_DIRS)).toEqual({ violations: [], stale: [] });
  });
});

describe("a package the kind filter cannot classify is refused, never exempted", () => {
  it("reports a MISSING cinatra.kind", () => {
    writePackage({
      name: "@acme/kindless",
      kind: undefined,
      fieldRenderers: [{ id: "@acme/kindless:review", kind: "cta", priority: 90, component: { entry: "./r.tsx" } }],
    });
    expect(unknownKindPackages(scanExtensionTree(root))).toEqual(["@acme/kindless"]);
  });

  it("reports a MISSPELLED kind (the typo bypass)", () => {
    writePackage({ name: "@acme/typo", kind: "agents" });
    expect(unknownKindPackages(scanExtensionTree(root))).toEqual(["@acme/typo"]);
  });

  it("says nothing about the known vocabulary", () => {
    for (const kind of ["agent", "connector", "artifact", "skill", "workflow"]) {
      writePackage({ name: `@acme/${kind}-pkg`, kind });
    }
    expect(unknownKindPackages(scanExtensionTree(root))).toEqual([]);
  });

  it("refuses an unreadable manifest instead of skipping it", () => {
    const pkgDir = join(root, "acme", "broken");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), "{ not json");
    expect(() => scanExtensionTree(root)).toThrow(/unreadable extension manifest/);
  });
});

describe("an incomplete tree is never read as clean", () => {
  it("an EMPTY tree is a scanner error", () => {
    expect(incompleteTreeError([], EMPTY_BASELINE)).toMatch(/0 extension packages/);
  });

  it("no agent package while the baseline still records agent-side drawing is a scanner error", () => {
    writePackage({ name: "@acme/a-connector", kind: "connector" });
    const baseline = { ...EMPTY_BASELINE, componentBindings: { "@acme/gone-agent": ["@acme/gone-agent:review"] } };
    expect(incompleteTreeError(scanExtensionTree(root), baseline)).toMatch(/incomplete/);
  });

  it("no agent package and an EMPTY baseline is fine (the migration finished)", () => {
    writePackage({ name: "@acme/a-connector", kind: "connector" });
    expect(incompleteTreeError(scanExtensionTree(root), EMPTY_BASELINE)).toBeNull();
  });
});

describe("the base-ref arm closes the regenerate-to-pass bypass", () => {
  const base = {
    ...EMPTY_BASELINE,
    componentBindings: { "@acme/rogue-agent": ["@acme/rogue-agent:review"] },
    vendoredPrimitives: { "@acme/rogue-agent": ["src/components/ui/card.tsx"] },
  };

  it("an ADDED pair vs the base baseline is growth", () => {
    const committed = {
      ...base,
      componentBindings: { "@acme/rogue-agent": ["@acme/rogue-agent:review", "@acme/rogue-agent:second"] },
    };
    expect(baselineGrowth(base, committed)).toEqual(["componentBindings|@acme/rogue-agent|@acme/rogue-agent:second"]);
  });

  it("a SWAP (one pair out, one in) is growth too — a count check would miss it", () => {
    const committed = { ...base, componentBindings: { "@acme/rogue-agent": ["@acme/rogue-agent:second"] } };
    expect(baselineGrowth(base, committed)).toEqual(["componentBindings|@acme/rogue-agent|@acme/rogue-agent:second"]);
  });

  it("a pure SHRINK is not growth", () => {
    const committed = { ...base, componentBindings: {} };
    expect(baselineGrowth(base, committed)).toEqual([]);
    expect(baselinePairs(committed)).toEqual(["vendoredPrimitives|@acme/rogue-agent|src/components/ui/card.tsx"]);
  });

  it("the committed baseline has not grown against ITSELF (the identity case)", () => {
    expect(baselineGrowth(loadBaseline(), loadBaseline())).toEqual([]);
  });
});

describe("the baseline contract is validated, not assumed", () => {
  it("accepts the committed baseline", () => {
    expect(() => assertBaselineShape(loadBaseline())).not.toThrow();
  });

  it("refuses a section that is not an object", () => {
    expect(() => assertBaselineShape({ ...EMPTY_BASELINE, componentBindings: [] })).toThrow(/not an object/);
  });

  it("refuses a missing section", () => {
    expect(() => assertBaselineShape({ componentBindings: {}, vendoredPrimitives: {} })).toThrow(/missing section/);
  });

  it("refuses a STRING where a package's pair list belongs (silently defeats the stale arm)", () => {
    expect(() =>
      assertBaselineShape({ ...EMPTY_BASELINE, componentBindings: { "@acme/x": "@acme/x:review" } }),
    ).toThrow(/is not an array/);
  });

  it("refuses a non-string entry", () => {
    expect(() => assertBaselineShape({ ...EMPTY_BASELINE, vendoredPrimitives: { "@acme/x": [42] } })).toThrow(
      /non-string entry/,
    );
  });
});
