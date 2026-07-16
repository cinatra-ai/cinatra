import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const at = (p) => join(REPO_ROOT, p);

// G5 — the artifact-UI boundary is closed on TWO sides: G1–G4 are the HOST-side
// arm (this PR); the EXTENSION / publish-side arm is the conformance + publish
// checks already shipped by S1/S3/S5. This test pins those cross-references so
// the boundary doc (which the gate error messages link) cannot silently rot —
// if a referenced publish-side check is renamed/removed, this fails and forces
// the reference to be updated.
describe("G5 — publish-side (extension-side arm) references + gate docs", () => {
  it("the boundary authoring doc exists (linked by every gate error message)", () => {
    expect(existsSync(at("scripts/audit/artifact-ui-boundary-gate.md"))).toBe(true);
  });

  it("S1: the cinatra.artifact.ui sub-schema leaf + its conformance test exist", () => {
    expect(existsSync(at("packages/sdk-extensions/src/artifact-contract.ts"))).toBe(true);
    expect(existsSync(at("packages/sdk-extensions/src/__tests__/artifact-ui-contract.test.ts"))).toBe(true);
  });

  it("S3: the extension conformance gate (fleet publish-side check) exists", () => {
    expect(existsSync(at("scripts/extensions/conformance-gate.mjs"))).toBe(true);
    expect(existsSync(at(".github/workflows/extension-conformance-gate.yml"))).toBe(true);
  });

  it("the G1 gate + shrink-only baseline + G2 matrix + G4 rule are all present", () => {
    expect(existsSync(at("scripts/audit/artifact-ui-boundary-gate.mjs"))).toBe(true);
    expect(existsSync(at("scripts/audit/artifact-ui-boundary-gate.baseline.json"))).toBe(true);
    expect(existsSync(at("packages/objects/src/artifact-ui-cutover-matrix.ts"))).toBe(true);
    expect(existsSync(at("src/app/artifacts/[id]/boundary/artifact-detail-cutover-probe.ts"))).toBe(true);
  });
});
