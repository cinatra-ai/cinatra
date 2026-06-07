/**
 * Live golden eval against the labelled reference dataset.
 *
 * GATED BY `process.env.OPENAI_API_KEY`. The entire suite is `describe.skipIf`-
 * skipped when the key is absent so the unit suite stays offline. Hosted CI
 * provides the key via a workflow secret; developers running `pnpm typecheck`
 * locally do NOT trigger this suite.
 *
 * --- WHAT THIS PROVES ------------------------------------------------------
 *
 * For every row in `__tests__/__fixtures__/golden-matches.jsonl`:
 *
 *   1. If `expectedSource === "rule"` — the rule short-circuit fires and
 *      `result.row.source === "rule"`. Zero LLM calls happen on these rows.
 *   2. If `expectedSource === "llm"` — the LLM is called via `evaluatePair`
 *      against the REAL OpenAI API. We collect (llmMatched, llmScore) and
 *      pass them into `computeCalibration` from `eval-calibration.ts`.
 *
 * The aggregate gate (per https://docs.cinatra.ai/references/platform/skill-matching/):
 *
 *   accuracy ≥ 0.85   AND   spearman ≥ 0.7
 *
 * Rationale for the borderline-row handling:
 *
 *   - Borderline rows are EXCLUDED from accuracy because the consensus
 *     rationale acknowledges either answer as defensible.
 *   - Borderline rows are INCLUDED in Spearman because rank-correlation
 *     rewards a model that ranks borderline cases between high and low
 *     (vs collapsing them to one extreme).
 *
 * --- WHY `.live.test.ts` SUFFIX --------------------------------------------
 *
 * Vitest's default test discovery picks up `*.test.ts` AND `*.live.test.ts`,
 * but the `.live.` infix lets a future CI workflow grep-include only the
 * gated tests when `OPENAI_API_KEY` is in scope. The suffix is documentation
 * for both humans and the workflow file.
 *
 * --- LIVE EVAL: COST + LATENCY NOTES ---------------------------------------
 *
 * 17 LLM rows × ~1KB prompt × gpt-4o-mini = ~$0.005 per full run at the
 * snapshot pricing in `constants.ts`. End-to-end wall time is ~30s on a
 * cold cache (provider RTT dominates). The test does NOT use the BullMQ
 * inline transport; it calls `evaluatePair` directly so the gate is
 * exclusively on the matcher core (the surface under audit).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GoldenMatchRowSchema,
  type GoldenMatchRow,
} from "./__fixtures__/golden-fixture-schema";
import { evaluatePair } from "../evaluate-pair";
import { computeCalibration, type CalibrationPair } from "../eval-calibration";

// The suite gates on TWO env vars:
//
//   - OPENAI_API_KEY=...  — required to make the real OpenAI gateway call.
//   - GOLDEN_EVAL_LIVE=1  — required to skip vitest.config's
//                            @cinatra-ai/llm stub (otherwise the
//                            "live" test would call the stub and emit
//                            status=error rows for every fixture).
//
// Both must be set, or the suite is skipped. This double-gate keeps the
// unit suite truly offline AND makes the "live" command in
// https://docs.cinatra.ai/references/platform/skill-matching/ call the real gateway.
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const LIVE_FLAG_SET = process.env.GOLDEN_EVAL_LIVE === "1";
const SHOULD_RUN_LIVE = HAS_OPENAI_KEY && LIVE_FLAG_SET;

// Production trust thresholds (per https://docs.cinatra.ai/references/platform/skill-matching/).
const ACCURACY_THRESHOLD = 0.85;
const SPEARMAN_THRESHOLD = 0.7;

const FIXTURE_PATH = resolve(
  __dirname,
  "__fixtures__",
  "golden-matches.jsonl",
);

function loadFixture(): GoldenMatchRow[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => GoldenMatchRowSchema.parse(JSON.parse(line)));
}

// In-memory store stub used by `evaluatePair` to bypass the real DB during
// the live eval. The test only cares about the LLM decision, not persistence
// — we want a fast, hermetic round-trip that doesn't pollute the matcher's
// production table with eval rows. Per `upsert.ts`, the store override is
// passed as `storeOverride` (a partial module mirroring `skill-matches-store.ts`).
function makeNoopStoreDeps() {
  const noopStore = {
    readSkillMatch: async () => null,
    upsertSkillMatch: async () => undefined,
    readSkillMatchesByAgent: async () => [],
    readSkillMatchesBySkill: async () => [],
    deleteSkillMatchesForSkill: async () => undefined,
    deleteSkillMatchesForAgent: async () => undefined,
  } as unknown as Parameters<typeof evaluatePair>[1]["storeOverride"];

  const now = new Date();
  return {
    now: () => now,
    jobStartedAt: now,
    storeOverride: noopStore,
  };
}

describe.skipIf(!SHOULD_RUN_LIVE)(
  "golden-eval.live — calibration vs labelled reference dataset (gated by OPENAI_API_KEY)",
  () => {
    it(
      `accuracy ≥ ${ACCURACY_THRESHOLD} AND spearman ≥ ${SPEARMAN_THRESHOLD} across the golden set`,
      async () => {
        const rows = loadFixture();
        expect(rows.length).toBe(20);

        const storeDeps = makeNoopStoreDeps();
        const pairs: CalibrationPair[] = [];

        for (const row of rows) {
          const result = await evaluatePair(
            { agent: row.agent, skill: row.skill },
            storeDeps,
          );

          const persistedRow = result.row;
          if (!persistedRow) {
            throw new Error(
              `evaluatePair returned no row for ${row.id} — store stub bug or upsert path skipped`,
            );
          }

          // Rule-source rows: assert the short-circuit fired BEFORE collecting
          // calibration data (the rule path doesn't produce a usable LLM score).
          if (row.expectedSource === "rule") {
            expect(persistedRow.source, `row=${row.id} expected source="rule"`).toBe(
              "rule",
            );
            expect(persistedRow.matched, `row=${row.id} expected matched=${row.expectedMatched}`).toBe(
              row.expectedMatched,
            );
          } else {
            // LLM-source rows: assert source="llm" and collect the calibration tuple.
            expect(persistedRow.source, `row=${row.id} expected source="llm"`).toBe(
              "llm",
            );
            expect(persistedRow.status, `row=${row.id} expected status="ok"`).toBe(
              "ok",
            );
          }

          pairs.push({
            rowId: row.id,
            category: row.category,
            expectedMatched: row.expectedMatched,
            expectedScoreBand: row.expectedScoreBand,
            expectedSource: row.expectedSource,
            llmMatched: persistedRow.matched,
            llmScore: persistedRow.score ?? 0,
          });
        }

        const report = computeCalibration(pairs);

        // Diagnostic logging — the test runner shows this when the gate fails.
        // eslint-disable-next-line no-console
        console.log("Skill-match calibration report:", {
          accuracy: report.accuracy,
          spearman: report.spearman,
          mismatchCount: report.mismatchCount,
          perBandAccuracy: report.perBandAccuracy,
          mismatches: report.mismatches,
        });

        // Hard gate.
        expect(report.accuracy, "accuracy gate").not.toBeNull();
        expect(report.accuracy as number).toBeGreaterThanOrEqual(ACCURACY_THRESHOLD);

        expect(report.spearman, "spearman gate").not.toBeNull();
        expect(report.spearman as number).toBeGreaterThanOrEqual(SPEARMAN_THRESHOLD);
      },
      // 60s wall-clock budget — 17 sequential LLM calls × ~3s each = ~50s.
      // Concurrency is intentionally not used here: the production matcher
      // runs SCOPED inline jobs, the eval should mirror that single-thread
      // path so calibration reflects production conditions.
      60_000,
    );
  },
);

describe("golden-eval.live — gating", () => {
  it("documents the OPENAI_API_KEY + GOLDEN_EVAL_LIVE double-gate", () => {
    if (!SHOULD_RUN_LIVE) {
      // eslint-disable-next-line no-console
      console.log(
        `[golden-eval.live] skipped (offline run). OPENAI_API_KEY=${HAS_OPENAI_KEY ? "set" : "unset"}, GOLDEN_EVAL_LIVE=${LIVE_FLAG_SET ? "1" : "unset"}. Both required.`,
      );
    }
    expect(typeof SHOULD_RUN_LIVE).toBe("boolean");
  });
});
