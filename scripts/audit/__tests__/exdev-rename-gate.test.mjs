// exdev-rename-gate tests (cinatra#874).
//
// Exercises the scanner, the surface scoping, the sanctioned-helper exclusion,
// the multiset (occurrence-count-aware) baseline diff, and the fingerprint
// stability that makes the no-new-rot ratchet work (matches the
// skill-canonicality-gate / extension-import-ban style).

import { describe, expect, it } from "vitest";
import {
  scan,
  fingerprintFinding,
  loadBaselineFindings,
  computeNewFindings,
  isSurfaceFile,
} from "../exdev-rename-gate.mjs";

describe("scan() — current source state matches the committed baseline", () => {
  it("no current surface finding exceeds the baseline (gate is green on main)", () => {
    expect(computeNewFindings(scan(), loadBaselineFindings())).toEqual([]);
  });

  it("baseline is non-empty (known same-fs/legacy renames are enumerated, not whole-file allowlisted)", () => {
    expect(loadBaselineFindings().length).toBeGreaterThan(0);
  });

  it("every finding is a bare rename/renameSync call", () => {
    for (const f of scan()) expect(/\brename(?:Sync)?\s*\(/.test(f.src)).toBe(true);
  });

  it("the cinatra#873-fixed sites are NOT in the baseline (they route through a primitive now)", () => {
    const files = new Set(scan().map((f) => f.file));
    expect(files.has("packages/skills/src/verdaccio.ts")).toBe(false);
    expect(files.has("src/lib/extension-materialization-plan-executor.ts")).toBe(false);
  });
});

describe("computeNewFindings — occurrence-count aware (a duplicate of a baselined line is NEW)", () => {
  const mk = (file, src) => ({ file, rule: "bare-rename", line: 1, src });

  it("a SECOND identical bare rename beyond the baselined count is a new finding", () => {
    const baseline = [mk("a.ts", "await rename(x, y);")]; // tolerates ONE
    const current = [mk("a.ts", "await rename(x, y);"), mk("a.ts", "await rename(x, y);")]; // TWO
    const novel = computeNewFindings(current, baseline);
    expect(novel).toHaveLength(1); // the extra occurrence, not collapsed by a Set
  });

  it("the exact baselined multiset yields zero new findings", () => {
    const baseline = [mk("a.ts", "await rename(x, y);"), mk("a.ts", "await rename(x, y);")];
    const current = [mk("a.ts", "await rename(x, y);"), mk("a.ts", "await rename(x, y);")];
    expect(computeNewFindings(current, baseline)).toEqual([]);
  });

  it("a brand-new fingerprint is new; a removed baselined one is stale (symmetric diff)", () => {
    const baseline = [mk("a.ts", "await rename(x, y);")];
    const current = [mk("b.ts", "await rename(p, q);")];
    expect(computeNewFindings(current, baseline)).toHaveLength(1); // b.ts is new
    expect(computeNewFindings(baseline, current)).toHaveLength(1); // a.ts is stale
  });
});

describe("isSurfaceFile — scopes to the extension install/materialize/store/boot surface", () => {
  it("includes the install/materialize/store/boot surfaces", () => {
    for (const f of [
      "packages/skills/src/verdaccio.ts",
      "packages/agents/src/materialize-agent-package.ts",
      "packages/cli/src/prod-extension-acquisition.mjs",
      "src/lib/extension-store-io.ts",
      "src/lib/required-extension-materialize.ts",
      "src/lib/boot/phases/required-extension-materialize.ts",
    ]) {
      expect(isSurfaceFile(f)).toBe(true);
    }
  });

  it("excludes the sanctioned EXDEV-safe primitive modules (raw rename there IS the primitive)", () => {
    for (const f of [
      "src/lib/fs-safety.ts",
      "packages/agents/src/exdev-safe-move.ts",
      "packages/skills/src/exdev-safe-move.ts",
    ]) {
      expect(isSurfaceFile(f)).toBe(false);
    }
  });

  it("excludes non-surface files (unrelated fs renames are out of scope)", () => {
    for (const f of [
      "src/lib/artifacts/local-disk-blob-store.ts",
      "src/components/workflows/workflow-editable-title.tsx",
      "scripts/audit/exdev-rename-gate.mjs",
    ]) {
      expect(isSurfaceFile(f)).toBe(false);
    }
  });
});

describe("fingerprintFinding — stable across whitespace + line-number drift", () => {
  it("equal fingerprint for identical structural finding across line numbers", () => {
    const a = { file: "x.ts", rule: "bare-rename", line: 10, src: "await rename(a, b);" };
    const b = { file: "x.ts", rule: "bare-rename", line: 99, src: "await rename(a, b);" };
    expect(fingerprintFinding(a)).toBe(fingerprintFinding(b));
  });

  it("equal fingerprint after whitespace normalization", () => {
    const a = { file: "x.ts", rule: "bare-rename", line: 1, src: "await rename(a, b);" };
    const b = { file: "x.ts", rule: "bare-rename", line: 1, src: "  await   rename(a,  b);  " };
    expect(fingerprintFinding(a)).toBe(fingerprintFinding(b));
  });

  it("different file OR different src ⇒ different fingerprint", () => {
    const base = { file: "x.ts", rule: "bare-rename", line: 1, src: "await rename(a, b);" };
    expect(fingerprintFinding(base)).not.toBe(fingerprintFinding({ ...base, file: "y.ts" }));
    expect(fingerprintFinding(base)).not.toBe(
      fingerprintFinding({ ...base, src: "await rename(a, c);" }),
    );
  });
});
