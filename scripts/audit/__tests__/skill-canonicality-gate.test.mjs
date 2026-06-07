// Canonicality-gate tests.
//
// Exercises the scanner + the fingerprint stability that makes the
// no-new-rot ratchet work (matches the extension-import-ban style).

import { describe, expect, it } from "vitest";
import { scan, fingerprintFinding, loadBaseline } from "../skill-canonicality-gate.mjs";

describe("scan() — current source state matches the committed baseline", () => {
  it("all current findings are in the baseline (gate is green on main)", () => {
    const baseline = loadBaseline();
    const findings = scan();
    const novel = findings.filter((f) => !baseline.has(fingerprintFinding(f)));
    expect(novel).toEqual([]);
  });

  it("baseline is non-empty (we INTEND for legacy carve-outs to be enumerated, not whole-file allowlisted)", () => {
    const baseline = loadBaseline();
    expect(baseline.size).toBeGreaterThan(0);
  });

  it("scan returns the expected rule kinds only (data-skills-write + sourcepath-direct-read)", () => {
    const rules = new Set(scan().map((f) => f.rule));
    for (const r of rules) {
      expect(["data-skills-write", "sourcepath-direct-read"]).toContain(r);
    }
  });
});

describe("fingerprintFinding — stable across whitespace + line-number drift", () => {
  it("equal fingerprint for identical structural finding across line numbers", () => {
    const a = { file: "x.ts", rule: "data-skills-write", line: 10, src: "await mkdir(p);" };
    const b = { file: "x.ts", rule: "data-skills-write", line: 99, src: "await mkdir(p);" };
    expect(fingerprintFinding(a)).toBe(fingerprintFinding(b));
  });

  it("equal fingerprint after whitespace normalization", () => {
    const a = { file: "x.ts", rule: "data-skills-write", line: 1, src: "await mkdir(p);" };
    const b = { file: "x.ts", rule: "data-skills-write", line: 1, src: "  await   mkdir(p);  " };
    expect(fingerprintFinding(a)).toBe(fingerprintFinding(b));
  });

  it("different file OR different rule OR different src ⇒ different fingerprint", () => {
    const base = { file: "x.ts", rule: "data-skills-write", line: 1, src: "await mkdir(p);" };
    const diffFile = { ...base, file: "y.ts" };
    const diffRule = { ...base, rule: "sourcepath-direct-read" };
    const diffSrc = { ...base, src: "await writeFile(p, x);" };
    expect(fingerprintFinding(base)).not.toBe(fingerprintFinding(diffFile));
    expect(fingerprintFinding(base)).not.toBe(fingerprintFinding(diffRule));
    expect(fingerprintFinding(base)).not.toBe(fingerprintFinding(diffSrc));
  });
});
