// Fixture tests for the ONE-CARD-PER-INTERACTION gate (cinatra#2573, epic
// #2564 S7).
//
// The gate's whole value is that a SECOND renderer of a lifecycle interaction
// fails CI. These tests hold both halves of that claim:
//
//   1. A synthetic violation FAILS — in each of the four rules the gate claims
//      to enforce (a second card definition; each of the three retired parallel
//      renderers; an undeclared-host mount; a duplicated registry row).
//   2. The REAL modules pass, and pass BECAUSE they are correct rather than
//      because the matcher is blind: the owner modules are asserted to contain
//      the definitions the gate looks for, so the allowlist can never rot into
//      a vacuously-green list of files that stopped rendering anything.
//   3. The false-positive half: prose about a retired renderer, inside a
//      comment, does NOT trip the gate.
//   4. The gate exits 0 on the real tree — which is also what makes it RUN in
//      CI, since `scripts/audit/__tests__/**` is inside the root vitest include.
//
// The matcher is IMPORTED from the gate rather than re-implemented, so a fixture
// can never assert a rule that differs from what CI enforces.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CARD_OWNERS,
  cardDefinitionPattern,
  RETIRED_PARALLELS,
  REGISTRY_MODULE,
  REGISTRY_KINDS,
  HOST_PROVIDED_BY_PARENT,
  collectViolations,
  isExempt,
  scanModule,
  scanRegistry,
} from "../chat-hitl-one-card-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts", "audit", "chat-hitl-one-card-gate.mjs");
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("R1 — a second card implementation is a violation", () => {
  it("flags a second review-gate card definition outside its owner module", () => {
    const hits = scanModule(
      "packages/agents/src/somewhere-else.tsx",
      "export function CompactReviewGateCard() { return null; }",
    );
    expect(hits.map((h) => h.rule)).toContain("R1");
  });

  it("a SECOND review-gate card definition outside its owner module fails R1", () => {
    const hits = scanModule("src/app/some/route/card.tsx", "const MyReviewGateCard = () => null;");
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toMatch(/second 'artifact_review_gate' card implementation/);
  });

  it("does NOT flag the definition in its own owner module — the owner is the point", () => {
    const owner = CARD_OWNERS.artifact_review_gate.owner;
    expect(scanModule(owner, "export function ReviewGateCard() { return null; }")).toEqual([]);
  });

  it("every declared owner module really contains the definition the gate keys on", () => {
    for (const [kind, spec] of Object.entries(CARD_OWNERS)) {
      const src = read(spec.owner);
      const re = cardDefinitionPattern(spec.component);
      expect(re.test(src), `${kind}: ${spec.owner} no longer defines ${spec.component}`).toBe(true);
    }
  });

  it("the pattern is a LOOK-ALIKE detector, not just a name match", () => {
    const re = cardDefinitionPattern("ReviewGateCard");
    expect(re.test("function ReviewGateCard() {}")).toBe(true);
    expect(cardDefinitionPattern("ReviewGateCard").test("class CompactReviewGateCard {}")).toBe(true);
    // …and it does not fire on an unrelated symbol that merely mentions it.
    expect(cardDefinitionPattern("ReviewGateCard").test("const reviewGateCardRef = x;")).toBe(false);
  });
});

describe("R2 — each retired parallel renderer is banned by name", () => {
  for (const parallel of RETIRED_PARALLELS) {
    it(`flags '${parallel.id}' coming back`, () => {
      const sample = {
        "review-redirect-card": "return <ArtifactReviewRedirectCard gate={g} />;",
        "direct-chip-row-mount": "return <RunRecommendationChipRow runId={id} />;",
        "page-direct-decision-composition": "return <ReviewDecisionBar action={a} />;",
      }[parallel.id];
      const hits = scanModule("src/app/new-surface/page.tsx", sample);
      expect(hits.map((h) => h.rule)).toContain("R2");
      expect(hits.find((h) => h.rule === "R2").detail).toContain(parallel.id);
    });
  }

  it("FALSE-POSITIVE CONTROL: prose in a comment about a retired renderer is clean", () => {
    const src = [
      "// The ArtifactReviewRedirectCard was deleted by S2; nothing renders it.",
      "/* A host must not mount <RunRecommendationChipRow> directly. */",
      "export const NOTE = 1;",
    ].join("\n");
    expect(scanModule("src/app/some/module.ts", src)).toEqual([]);
  });

  it("the allowlisted composer really does mount the row — the exception is not vacuous", () => {
    const owner = read("packages/agents/src/run-recommendation-chip-row.tsx");
    expect(owner).toMatch(/<\s*RunRecommendationChipRow\b/);
  });
});

describe("R3 — a card mount must be host-declared", () => {
  it("flags a mount with no provider in the file", () => {
    const hits = scanModule("src/app/x/page.tsx", "return <ReviewGateCard view={v} />;");
    expect(hits.map((h) => h.rule)).toContain("R3");
  });

  it("is clean when the file declares the host itself", () => {
    const src =
      '<LifecycleCardSurfaceProvider host="page_gate_region"><ReviewGateCard view={v} /></LifecycleCardSurfaceProvider>';
    expect(scanModule("src/app/x/page.tsx", src).filter((h) => h.rule === "R3")).toEqual([]);
  });

  it("the parent-provided exceptions are real: each named parent declares a host", () => {
    const parents = new Set(
      Object.values(HOST_PROVIDED_BY_PARENT).map((v) => v.split(" ")[0]),
    );
    expect(parents.size).toBeGreaterThan(0);
    for (const parent of parents) {
      expect(read(parent), parent).toMatch(/<\s*LifecycleCardSurfaceProvider\b/);
    }
  });
});

describe("R4 — one registry row per data-part kind", () => {
  it("flags a duplicated mapping", () => {
    const src = [
      "const M = {",
      "  artifact_review_gate: ReviewGateCard,",
      "  artifact_review_gate: OtherCard,",
      "  verification_summary: LifecycleCard,",
      "  trigger_schedule_proposal: LifecycleCard,",
      "};",
    ].join("\n");
    const hits = scanRegistry(src);
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/artifact_review_gate' 2 time/);
  });

  it("flags a MISSING mapping just as loudly as a duplicate", () => {
    const hits = scanRegistry("const M = { verification_summary: X, trigger_schedule_proposal: Y };");
    expect(hits.map((h) => h.detail).join(" ")).toMatch(/artifact_review_gate' 0 time/);
  });

  it("the real registry maps each data-part kind exactly once", () => {
    expect(scanRegistry(read(REGISTRY_MODULE))).toEqual([]);
    // …and the interrupt-carried kind is deliberately NOT there.
    expect(REGISTRY_KINDS).not.toContain("recommendation_hold");
  });
});

describe("exemptions and the live tree", () => {
  it("tests, fixtures, evidence and docs are exempt — they may name anything", () => {
    for (const rel of [
      "packages/agents/src/__tests__/review-gate-card.test.tsx",
      "evidence/2566-s2/README.md",
      "docs/internals/whatever.md",
      "tests/e2e/agents-run/fixtures.ts",
    ]) {
      expect(isExempt(rel), rel).toBe(true);
    }
    expect(isExempt("packages/agents/src/review-gate-card.tsx")).toBe(false);
  });

  it("the gate is CLEAN on the real tree", () => {
    expect(collectViolations()).toEqual([]);
  });

  it("the CLI exits 0 on the real tree", () => {
    const res = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(res.stdout + res.stderr).toMatch(/clean/);
    expect(res.status).toBe(0);
  });
});
