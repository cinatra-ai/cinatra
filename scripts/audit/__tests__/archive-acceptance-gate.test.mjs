// Fixture tests for the archive-acceptance coverage-completeness gate
// (cinatra#1943 A0, Decision 1). Every matcher under test is IMPORTED from
// the gate itself, so a fixture can never assert a rule CI doesn't actually
// enforce.
//
// Covers:
//   1. Manifest shape validation — the well-formedness rules audit mode
//      enforces (exactly 15 rows matching the canonical criteria 1:1, no
//      duplicates, required fields, the trackingIssue-while-red rule, and
//      Decision 1's AND-of-subproofs rule for the bounded-contention row).
//   2. Grep-findability — a planted STALE reference (a renamed test, a
//      typo'd testName, a comment-only mention) is caught; a genuine
//      reference is not.
//   3. GitHub Actions workflow YAML parsing (hand-rolled, no library) — all
//      three `needs:` shapes (scalar, flow array, block list), plus a
//      not-found job.
//   4. Strict-mode row verification, including the cross-workflow finding
//      this gate surfaces (a `needs:` edge cannot cross workflow files).
//   5. strictVerdict — the FULL strict-mode pass condition ("all 15 rows
//      green and verified", not merely "no false green claim found"): an
//      all-red manifest (this PR's own committed state) must report NOT
//      READY, never "clean" — the honesty bug an early draft had.
//   6. The gate is green on the REAL committed manifest against the REAL
//      tree (zero-baseline) — this also makes the gate RUN in CI:
//      scripts/audit/__tests__/** is inside the root Vitest include glob.

import { describe, it, expect } from "vitest";
import {
  CANONICAL_CRITERIA,
  validateManifestShape,
  isProofGrepFindable,
  auditManifest,
  extractJobBlock,
  extractNeeds,
  strictCheckRow,
  strictVerdict,
  loadManifest,
  SELF_WORKFLOW,
  SELF_JOB,
} from "../archive-acceptance-gate.mjs";

// ---------------------------------------------------------------------------
// Helpers — a minimal, always-valid synthetic manifest to mutate per test.
// ---------------------------------------------------------------------------

function baseManifest() {
  return {
    note: "test fixture",
    version: 1,
    rows: CANONICAL_CRITERIA.map((criterion, i) => ({
      criterion,
      owner: "self",
      ciDependency: { workflow: "build-image.yml", job: `job-${i}` },
      status: "red",
      trackingIssue: 1943,
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. Manifest shape validation
// ---------------------------------------------------------------------------

describe("validateManifestShape", () => {
  it("accepts a well-formed 15-row manifest", () => {
    expect(validateManifestShape(baseManifest())).toEqual([]);
  });

  it("catches a row count that isn't exactly 15", () => {
    const m = baseManifest();
    m.rows.pop();
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes("expected exactly 15 rows"))).toBe(true);
    expect(errors.some((e) => e.includes("missing a row for criterion"))).toBe(true);
  });

  it("catches a duplicated criterion", () => {
    const m = baseManifest();
    m.rows[1] = { ...m.rows[1], criterion: m.rows[0].criterion };
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes("duplicate criterion"))).toBe(true);
  });

  it("catches a criterion that drifted from the canonical issue-body wording", () => {
    const m = baseManifest();
    m.rows[0] = { ...m.rows[0], criterion: "A criterion nobody wrote in the issue" };
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes("not in the canonical 15"))).toBe(true);
    expect(errors.some((e) => e.includes("missing a row for criterion"))).toBe(true);
  });

  it("catches an invalid owner / status", () => {
    const m = baseManifest();
    m.rows[0].owner = "nobody";
    m.rows[1].status = "yellow";
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes('owner" must be "self" or "sibling"'))).toBe(true);
    expect(errors.some((e) => e.includes('status" must be "red" or "green"'))).toBe(true);
  });

  it("requires ciDependency.workflow and ciDependency.job", () => {
    const m = baseManifest();
    delete m.rows[0].ciDependency.job;
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes("ciDependency.job must be a non-empty string"))).toBe(true);
  });

  it("requires a trackingIssue on every red row", () => {
    const m = baseManifest();
    delete m.rows[0].trackingIssue;
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes("a red row must carry a trackingIssue"))).toBe(true);
  });

  it("a green row needs no trackingIssue", () => {
    const m = baseManifest();
    m.rows[0].status = "green";
    delete m.rows[0].trackingIssue;
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes("trackingIssue"))).toBe(false);
  });

  it("rejects a kernelProof/e2eProof object missing file or testName", () => {
    const m = baseManifest();
    m.rows[0].kernelProof = { file: "x.test.ts" }; // testName missing
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes('kernelProof: "testName" must be a non-empty string'))).toBe(true);
  });

  it("Decision 1 D5 AND-rule: the bounded-contention row cannot be green with only ONE proof kind populated", () => {
    const m = baseManifest();
    const row = m.rows.find(
      (r) => r.criterion === "BOUNDED, deterministic eventual-successful-archive under contention (a fixed retry ceiling, not an unbounded spin)",
    );
    row.status = "green";
    row.kernelProof = { file: "a.test.ts", testName: "kernel half" };
    // e2eProof deliberately absent — this MUST fail per Decision 1 D5.
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes("requires BOTH kernelProof and e2eProof"))).toBe(true);

    // Populating both clears the violation.
    row.e2eProof = { file: "b.spec.ts", testName: "e2e half" };
    expect(validateManifestShape(m).some((e) => e.includes("requires BOTH"))).toBe(false);
  });

  it("any OTHER row may be green with only kernelProof populated (the AND-rule is row-specific, not a blanket requirement)", () => {
    const m = baseManifest();
    m.rows[0].status = "green";
    m.rows[0].kernelProof = { file: "a.test.ts", testName: "kernel-only proof" };
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes("requires BOTH"))).toBe(false);
  });

  it("a green row with NEITHER kernelProof nor e2eProof populated is rejected (nothing to point at)", () => {
    const m = baseManifest();
    m.rows[0].status = "green"; // no kernelProof, no e2eProof
    const errors = validateManifestShape(m);
    expect(errors.some((e) => e.includes("at least one of kernelProof/e2eProof"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Grep-findability — audit mode's honesty check.
// ---------------------------------------------------------------------------

describe("isProofGrepFindable", () => {
  it("finds a real it() declaration", () => {
    const src = 'describe("x", () => {\n  it("the exact test name", () => {});\n});\n';
    expect(isProofGrepFindable(src, "the exact test name")).toBe(true);
  });

  it("finds it.each / it.only / test( forms too", () => {
    expect(isProofGrepFindable('it.each([1])("the exact test name", () => {});', "the exact test name")).toBe(true);
    expect(isProofGrepFindable('it.only("the exact test name", () => {});', "the exact test name")).toBe(true);
    expect(isProofGrepFindable('test("the exact test name", () => {});', "the exact test name")).toBe(true);
  });

  it("does NOT count a comment-only mention (planted staleness)", () => {
    const src = '// TODO: write "the exact test name" someday\n';
    expect(isProofGrepFindable(src, "the exact test name")).toBe(false);
  });

  it("does NOT count a renamed/typo'd test — a stale manifest reference is caught", () => {
    const src = 'it("the EXACT test name (renamed)", () => {});';
    expect(isProofGrepFindable(src, "the exact test name")).toBe(false);
  });

  it("does NOT match when the file is missing the string entirely", () => {
    expect(isProofGrepFindable("nothing here", "the exact test name")).toBe(false);
  });

  it("finds a REAL declaration even when an earlier, non-declaration occurrence of the same string appears first in the file", () => {
    // A prior comment mentioning the same words must not shadow a genuine
    // later `it(...)` — checking only the FIRST occurrence would miss this.
    const src = '// see "the exact test name" for context\nit("the exact test name", () => {});';
    expect(isProofGrepFindable(src, "the exact test name")).toBe(true);
  });

  it("does NOT match a commented-out test declaration (a disabled test is not a live proof)", () => {
    const src = '// it("the exact test name", () => {});';
    expect(isProofGrepFindable(src, "the exact test name")).toBe(false);
  });

  it("still matches a real declaration on a line with a trailing comment (comment AFTER the declaration)", () => {
    const src = 'it("the exact test name", () => {}); // trailing note';
    expect(isProofGrepFindable(src, "the exact test name")).toBe(true);
  });
});

describe("auditManifest — planted violation must fail (not vacuously pass)", () => {
  it("a kernelProof pointing at a real file but a STALE testName fails audit", () => {
    const m = baseManifest();
    m.rows[0].kernelProof = { file: "fixture.test.ts", testName: "a test that does not exist" };
    const files = { "fixture.test.ts": 'it("a DIFFERENT test", () => {});' };
    const errors = auditManifest(m, { repoRoot: "/repo", readFileImpl: (p) => {
      const rel = p.replace("/repo/", "");
      if (!(rel in files)) throw new Error("ENOENT");
      return files[rel];
    } });
    expect(errors.some((e) => e.includes("testName not grep-findable"))).toBe(true);
  });

  it("a kernelProof pointing at a MISSING file fails audit", () => {
    const m = baseManifest();
    m.rows[0].kernelProof = { file: "does-not-exist.test.ts", testName: "whatever" };
    const errors = auditManifest(m, { repoRoot: "/repo", readFileImpl: () => { throw new Error("ENOENT"); } });
    expect(errors.some((e) => e.includes("file not found"))).toBe(true);
  });

  it("a genuinely correct reference passes audit", () => {
    const m = baseManifest();
    m.rows[0].kernelProof = { file: "fixture.test.ts", testName: "the real test" };
    const files = { "fixture.test.ts": 'it("the real test", () => {});' };
    const errors = auditManifest(m, { repoRoot: "/repo", readFileImpl: (p) => files[p.replace("/repo/", "")] });
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. GitHub Actions workflow YAML parsing (needs:, all three shapes).
// ---------------------------------------------------------------------------

const SAMPLE_WORKFLOW = `
name: Sample

jobs:
  detect:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi

  scalar-needs:
    needs: detect
    runs-on: ubuntu-latest

  flow-array-needs:
    needs: [detect, scalar-needs]
    runs-on: ubuntu-latest

  block-list-needs:
    needs:
      - detect
      - scalar-needs
      - flow-array-needs
    runs-on: ubuntu-latest

  no-needs:
    runs-on: ubuntu-latest

  nested-needs-in-a-step:
    runs-on: ubuntu-latest
    steps:
      - name: A step with an unrelated nested "needs" key, deeper than the job body
        env:
          needs: not-a-real-dependency
        run: echo hi
`;

describe("extractJobBlock", () => {
  it("extracts a job's block up to (not including) the next top-level job", () => {
    const block = extractJobBlock(SAMPLE_WORKFLOW, "scalar-needs");
    expect(block).toContain("needs: detect");
    expect(block).not.toContain("flow-array-needs:");
  });

  it("returns null for a job that does not exist", () => {
    expect(extractJobBlock(SAMPLE_WORKFLOW, "nonexistent-job")).toBeNull();
  });

  it("extracts the LAST job's block through EOF", () => {
    const block = extractJobBlock(SAMPLE_WORKFLOW, "no-needs");
    expect(block).toContain("no-needs:");
    expect(block).toContain("runs-on: ubuntu-latest");
  });
});

describe("extractNeeds", () => {
  it("parses the scalar form", () => {
    expect(extractNeeds(extractJobBlock(SAMPLE_WORKFLOW, "scalar-needs"))).toEqual(["detect"]);
  });

  it("parses the flow-array form", () => {
    expect(extractNeeds(extractJobBlock(SAMPLE_WORKFLOW, "flow-array-needs"))).toEqual(["detect", "scalar-needs"]);
  });

  it("parses the block-list form", () => {
    expect(extractNeeds(extractJobBlock(SAMPLE_WORKFLOW, "block-list-needs"))).toEqual([
      "detect",
      "scalar-needs",
      "flow-array-needs",
    ]);
  });

  it("returns an empty array when needs: is absent", () => {
    expect(extractNeeds(extractJobBlock(SAMPLE_WORKFLOW, "no-needs"))).toEqual([]);
  });

  it("returns an empty array for a null block", () => {
    expect(extractNeeds(null)).toEqual([]);
  });

  it("does NOT pick up a nested 'needs:' key inside a step (only the job's OWN body indent counts)", () => {
    // A regression case: an earlier draft matched `needs:` at ANY indent
    // inside the job block, so an unrelated nested key at a deeper indent
    // (here, a step's `env.needs`) was silently mis-parsed as the job's own
    // dependency edge.
    expect(extractNeeds(extractJobBlock(SAMPLE_WORKFLOW, "nested-needs-in-a-step"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Strict-mode row verification.
// ---------------------------------------------------------------------------

describe("strictCheckRow", () => {
  const workflows = {
    [`${SELF_WORKFLOW}`]: `
jobs:
  ${SELF_JOB}:
    needs: [wired-job]
    runs-on: ubuntu-latest

  wired-job:
    runs-on: ubuntu-latest
`,
    "other-workflow.yml": `
jobs:
  unwired-job:
    runs-on: ubuntu-latest
`,
  };
  const readFileImpl = (p) => {
    for (const [name, content] of Object.entries(workflows)) {
      if (p.endsWith(`.github/workflows/${name}`)) return content;
    }
    throw new Error("ENOENT");
  };
  const opts = { repoRoot: "/repo", readFileImpl };

  it("a red row trivially passes strict (nothing to verify yet)", () => {
    const row = { status: "red", ciDependency: { workflow: SELF_WORKFLOW, job: "wired-job" } };
    expect(strictCheckRow(row, opts)).toEqual({ ok: true, reasons: [] });
  });

  it("a green row wired via needs: in the SAME workflow as the gate itself passes", () => {
    const row = { status: "green", ciDependency: { workflow: SELF_WORKFLOW, job: "wired-job" } };
    const result = strictCheckRow(row, opts);
    expect(result.ok).toBe(true);
  });

  it("a green row NOT yet in the gate's own needs: fails, naming the missing edge", () => {
    const row = {
      status: "green",
      ciDependency: {
        workflow: SELF_WORKFLOW,
        job: "wired-job",
      },
    };
    // A workflow set where the gate's own job has NO needs: at all.
    const unwiredOpts = {
      repoRoot: "/repo",
      readFileImpl: (p) => {
        if (p.endsWith(`.github/workflows/${SELF_WORKFLOW}`)) {
          return `jobs:\n  ${SELF_JOB}:\n    runs-on: ubuntu-latest\n\n  wired-job:\n    runs-on: ubuntu-latest\n`;
        }
        throw new Error("ENOENT");
      },
    };
    const result = strictCheckRow(row, unwiredOpts);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("does not needs:"))).toBe(true);
  });

  it("a green row pointing at a DIFFERENT workflow than the gate's own fails with the cross-workflow finding (needs: cannot cross files)", () => {
    const row = { status: "green", ciDependency: { workflow: "other-workflow.yml", job: "unwired-job" } };
    const result = strictCheckRow(row, opts);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("cross-workflow"))).toBe(true);
  });

  it("a green row whose ciDependency job does not exist in its workflow fails", () => {
    const row = { status: "green", ciDependency: { workflow: SELF_WORKFLOW, job: "no-such-job" } };
    const result = strictCheckRow(row, opts);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('job "no-such-job" not found'))).toBe(true);
  });
});

describe("strictVerdict — the FULL strict-mode pass condition", () => {
  it("is NOT ready when every row is honestly red (an all-red manifest must never report 'ready' — the honesty bug this fixes)", () => {
    const m = baseManifest(); // every row status: "red"
    const verdict = strictVerdict(m);
    expect(verdict.ready).toBe(false);
    expect(verdict.notYetGreen).toHaveLength(CANONICAL_CRITERIA.length);
    expect(verdict.rowFailures).toEqual([]);
    expect(verdict.shapeErrors).toEqual([]);
  });

  it("is NOT ready when the manifest itself is malformed, even if that malformation would otherwise dodge per-row checks", () => {
    const m = baseManifest();
    m.rows.pop(); // 14 rows — a shape violation strictCheckRow alone would never see
    const verdict = strictVerdict(m);
    expect(verdict.ready).toBe(false);
    expect(verdict.shapeErrors.length).toBeGreaterThan(0);
  });

  it("IS ready only when every row is green AND every row passes structural verification", () => {
    const workflowText = `jobs:\n  ${SELF_JOB}:\n    needs: [wired-job]\n    runs-on: ubuntu-latest\n\n  wired-job:\n    runs-on: ubuntu-latest\n`;
    const m = {
      rows: CANONICAL_CRITERIA.map((criterion) => ({
        criterion,
        owner: "self",
        kernelProof: { file: "x.test.ts", testName: "the proof" },
        e2eProof: { file: "x.test.ts", testName: "the proof" },
        ciDependency: { workflow: SELF_WORKFLOW, job: "wired-job" },
        status: "green",
      })),
    };
    const readFileImpl = (p) => {
      if (p.endsWith(`.github/workflows/${SELF_WORKFLOW}`)) return workflowText;
      if (p.endsWith("x.test.ts")) return 'it("the proof", () => {});';
      throw new Error("ENOENT");
    };
    const verdict = strictVerdict(m, { repoRoot: "/repo", readFileImpl });
    expect(verdict.ready).toBe(true);
    expect(verdict.notYetGreen).toEqual([]);
    expect(verdict.rowFailures).toEqual([]);
  });

  it("is NOT ready when all rows are green but ONE fails structural verification (a single bad row blocks the whole precondition)", () => {
    const workflowText = `jobs:\n  ${SELF_JOB}:\n    needs: [wired-job]\n    runs-on: ubuntu-latest\n\n  wired-job:\n    runs-on: ubuntu-latest\n`;
    const m = {
      rows: CANONICAL_CRITERIA.map((criterion, i) => ({
        criterion,
        owner: "self",
        kernelProof: { file: "x.test.ts", testName: "the proof" },
        e2eProof: { file: "x.test.ts", testName: "the proof" },
        // Row 0 points at a job that doesn't exist — everything else is wired correctly.
        ciDependency: { workflow: SELF_WORKFLOW, job: i === 0 ? "no-such-job" : "wired-job" },
        status: "green",
      })),
    };
    const readFileImpl = (p) => {
      if (p.endsWith(`.github/workflows/${SELF_WORKFLOW}`)) return workflowText;
      if (p.endsWith("x.test.ts")) return 'it("the proof", () => {});';
      throw new Error("ENOENT");
    };
    const verdict = strictVerdict(m, { repoRoot: "/repo", readFileImpl });
    expect(verdict.ready).toBe(false);
    expect(verdict.rowFailures).toHaveLength(1);
  });

  it("the real committed manifest (all red) is honestly NOT READY under strict mode today — expected pre-P1-CI, not a bug", () => {
    const manifest = loadManifest();
    const verdict = strictVerdict(manifest);
    expect(verdict.ready).toBe(false);
    expect(verdict.notYetGreen).toHaveLength(15);
  });
});

// ---------------------------------------------------------------------------
// 6. Green on the real committed manifest against the REAL tree — this ALSO
//    makes the gate run in CI (scripts/audit/__tests__/** is in the root
//    Vitest include glob), the same zero-baseline shape as
//    system-writer-manifest-gate.test.mjs's own final case.
// ---------------------------------------------------------------------------

describe("the real committed manifest", () => {
  it("is well-formed (audit mode, real tree)", () => {
    const manifest = loadManifest();
    const errors = auditManifest(manifest);
    expect(errors).toEqual([]);
  });

  it("has exactly 15 rows, one per canonical criterion", () => {
    const manifest = loadManifest();
    expect(manifest.rows).toHaveLength(15);
    expect(new Set(manifest.rows.map((r) => r.criterion))).toEqual(new Set(CANONICAL_CRITERIA));
  });

  it("every row is red at this authoring stage (Decision 1's zero-baseline) with a trackingIssue", () => {
    const manifest = loadManifest();
    for (const row of manifest.rows) {
      expect(row.status).toBe("red");
      expect(row.trackingIssue).toBeGreaterThan(0);
    }
  });
});
