/**
 * Skill-matcher production-trust calibration helpers.
 *
 * Pure functions used by the live golden-eval test (`golden-eval.live.test.ts`)
 * to score the LLM judge against the labelled reference dataset
 * (`__tests__/__fixtures__/golden-matches.jsonl`).
 *
 * --- Trust thresholds (per https://docs.cinatra.ai/references/platform/skill-matching/) -----------------------
 *
 *   accuracy   ≥ 0.85   — fraction of expectedMatched that the LLM matched.
 *                          Borderline rows are EXCLUDED from accuracy because
 *                          the consensus rationale itself acknowledges either
 *                          answer as defensible — including them would punish
 *                          a defensible but minority decision.
 *
 *   spearman   ≥ 0.7    — Spearman rank correlation between the LLM `score`
 *                          and the expected score band (high=0.92, medium=0.67,
 *                          low=0.20 — midpoints of the prompt's documented
 *                          decision criteria). Borderline rows ARE included
 *                          because rank-correlation is robust to consensus
 *                          ambiguity AND we want the calibration to reward
 *                          a model that ranks borderline cases between high
 *                          and low (vs collapsing them to one extreme).
 *
 *   rule-source rows are EXCLUDED from BOTH metrics because they exercise the
 *   deterministic short-circuit (no LLM call); the live test asserts those
 *   separately via `result.row.source === "rule"`.
 *
 * The functions in this module take pre-aligned arrays — extraction from the
 * fixture + LLM result is the caller's job (handled in the test).
 *
 * --- LEAF-SAFETY ------------------------------------------------------------
 *
 * No imports from the `@cinatra-ai/skills` barrel, no `import "server-only"`, no
 * runtime side effects. Pure helpers; safe to import from a unit-test
 * environment AND from a future operator-facing report renderer that may run
 * in a non-server context.
 */

/**
 * Numeric midpoint of each prompt-defined band (per `prompt.md` decision
 * criteria). These are the "ground-truth scores" we calibrate against.
 *
 *   high   = 0.92  — prompt says "0.85-1.00 — clearly applicable"
 *   medium = 0.67  — prompt says "0.50-0.84 — plausibly useful"
 *   low    = 0.20  — prompt says "0.0 — clearly irrelevant" but a
 *                     model often scores low-but-nonzero (~0.1-0.3) for
 *                     borderline-low calls; midpoint of that observed band.
 */
export const SCORE_BAND_MIDPOINTS = {
  high: 0.92,
  medium: 0.67,
  low: 0.20,
} as const satisfies Record<string, number>;

export type ScoreBand = keyof typeof SCORE_BAND_MIDPOINTS;

/**
 * Per-row pairing of "what the fixture said" + "what the LLM returned".
 * Caller builds this array AFTER iterating the fixture and calling
 * `evaluatePair()` (or by parsing live model output).
 */
export type CalibrationPair = {
  rowId: string;
  category:
    | "obvious-match"
    | "obvious-no-match"
    | "borderline"
    | "rule-short-circuit"
    | "rule-fallthrough-to-llm";
  expectedMatched: boolean;
  expectedScoreBand: ScoreBand;
  expectedSource: "rule" | "llm";
  llmMatched: boolean;
  llmScore: number;
};

export type CalibrationReport = {
  /** Total rows considered for accuracy (excludes borderline + rule-source). */
  accuracyDenominator: number;
  /** Rows where llmMatched === expectedMatched (within accuracy denominator). */
  accuracyNumerator: number;
  /**
   * accuracyNumerator / accuracyDenominator — `null` when denominator is 0
   * (e.g. caller passed only borderline rows). Production gate: ≥ 0.85.
   */
  accuracy: number | null;
  /** Total rows considered for Spearman (excludes rule-source only). */
  spearmanCount: number;
  /**
   * Spearman rank correlation between llmScore and expectedScoreBand
   * midpoint, computed across `spearmanCount` rows. `null` when count < 2
   * or when one side is constant (no rank variance). Production gate: ≥ 0.7.
   */
  spearman: number | null;
  /** Per-band accuracy breakdown (for diagnostics; not gated). */
  perBandAccuracy: Record<ScoreBand, { matched: number; total: number; ratio: number | null }>;
  /** Rows where llmMatched !== expectedMatched (within accuracy denominator). */
  mismatchCount: number;
  /** Diagnostic list of mismatched rows for the test failure message. */
  mismatches: Array<{
    rowId: string;
    category: CalibrationPair["category"];
    expectedMatched: boolean;
    llmMatched: boolean;
    llmScore: number;
  }>;
};

/**
 * Spearman rank correlation. Standard formula; handles tied ranks via the
 * midrank method. Returns `null` when input has fewer than 2 points or when
 * either side is constant (would divide by zero in Pearson on the ranks).
 */
export function spearmanCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length) {
    throw new Error(
      `spearmanCorrelation: input length mismatch (xs=${xs.length}, ys=${ys.length})`,
    );
  }
  if (xs.length < 2) return null;

  const ranksX = midrank(xs);
  const ranksY = midrank(ys);
  return pearson(ranksX, ranksY);
}

function midrank(values: number[]): number[] {
  // Indexes sorted ascending by value
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j += 1;
    // Average rank for the tie group [i..j] (1-indexed ranks).
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[indexed[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

/**
 * Compute accuracy + Spearman + per-band breakdown + mismatch list.
 *
 * Filtering rules (encoded here, NOT in the test, so the policy stays in
 * one place):
 *
 *  - Accuracy: skip rows with `category === "borderline"` AND skip rows with
 *    `expectedSource === "rule"` (rule rows have no LLM decision to score).
 *  - Spearman: skip rows with `expectedSource === "rule"` only — borderline
 *    rows ARE included because rank-correlation rewards a model that ranks
 *    borderline between high and low.
 */
export function computeCalibration(pairs: CalibrationPair[]): CalibrationReport {
  const accuracyEligible = pairs.filter(
    (p) => p.expectedSource === "llm" && p.category !== "borderline",
  );
  const spearmanEligible = pairs.filter((p) => p.expectedSource === "llm");

  const mismatches = accuracyEligible.filter((p) => p.llmMatched !== p.expectedMatched);
  const mismatchCount = mismatches.length;
  const accuracyNumerator = accuracyEligible.length - mismatchCount;
  const accuracyDenominator = accuracyEligible.length;
  const accuracy = accuracyDenominator > 0 ? accuracyNumerator / accuracyDenominator : null;

  const perBandAccuracy: CalibrationReport["perBandAccuracy"] = {
    high: { matched: 0, total: 0, ratio: null },
    medium: { matched: 0, total: 0, ratio: null },
    low: { matched: 0, total: 0, ratio: null },
  };
  for (const p of accuracyEligible) {
    const band = perBandAccuracy[p.expectedScoreBand];
    band.total += 1;
    if (p.llmMatched === p.expectedMatched) band.matched += 1;
  }
  for (const band of Object.values(perBandAccuracy)) {
    band.ratio = band.total > 0 ? band.matched / band.total : null;
  }

  const xs = spearmanEligible.map((p) => p.llmScore);
  const ys = spearmanEligible.map((p) => SCORE_BAND_MIDPOINTS[p.expectedScoreBand]);
  const spearman = spearmanCorrelation(xs, ys);

  return {
    accuracyDenominator,
    accuracyNumerator,
    accuracy,
    spearmanCount: spearmanEligible.length,
    spearman,
    perBandAccuracy,
    mismatchCount,
    mismatches: mismatches.map((p) => ({
      rowId: p.rowId,
      category: p.category,
      expectedMatched: p.expectedMatched,
      llmMatched: p.llmMatched,
      llmScore: p.llmScore,
    })),
  };
}
