/**
 * Shared review-merge helper.
 *
 * Aggregates per-lane `ReviewFinding[]` arrays produced by the reviewer
 * lanes (lint-policy + LLM advisors), runs `normalizeReviewFindings`
 * (downgrades any non-policy `blocker` to `warning` so only lint policy can
 * assert blocker authority), and buckets the result.
 *
 * Two call sites consume this:
 *   1. `src/app/api/review/merge/route.ts` - the HTTP endpoint kept for
 *      paths that POST raw JSON findings strings, including callers outside
 *      the TS package.
 *   2. `packages/agents/src/agent-creation-review.ts` - the
 *      `agent_creation_review` MCP primitive that calls scanners + LLM
 *      reviewers in-process and feeds their findings here.
 *
 * Both paths converge on this helper so normalization + source identity
 * stamping is single-source-of-truth. The route still re-stamps lane source
 * BEFORE invoking this helper (it can't trust helper-reported source since
 * it parses arbitrary JSON from upstream callers). The MCP primitive
 * stamps source as it calls each lane, so by the time it reaches here the
 * findings are already trusted.
 */

import {
  normalizeReviewFindings,
  type ReviewFinding,
} from "./validate-agent-json";

export type ReviewLaneSource =
  | "agent-lint-policy"
  | "agent-security-reviewer"
  | "agent-code-reviewer"
  | "agent-planner";

export type PerLaneFindings = {
  lintFindings: ReviewFinding[];
  securityFindings: ReviewFinding[];
  codeFindings: ReviewFinding[];
  plannerFindings: ReviewFinding[];
};

export type MergedReviewReport = {
  blockers: ReviewFinding[];
  warnings: ReviewFinding[];
  suggestions: ReviewFinding[];
  /** Canonical full list in lint -> security -> code -> planner order. */
  findings: ReviewFinding[];
};

/**
 * Stamp `source` on each finding per the lane it came from. Callers that
 * receive arbitrary JSON findings (the HTTP route) MUST re-stamp before
 * trusting source identity - a helper agent could otherwise claim
 * `source: "agent-lint-policy"` and survive the downgrade check. Callers
 * that synthesize findings in-process (the MCP primitive) can skip this
 * step and pass already-stamped findings.
 */
export function restampLaneSource(
  findings: ReviewFinding[],
  laneSource: ReviewLaneSource,
): ReviewFinding[] {
  return findings.map((f) => ({ ...f, source: laneSource }));
}

/**
 * Merge per-lane findings into a single bucketed report. Always runs the
 * normalizer (downgrades non-policy `blocker` to `warning`). Concatenation
 * order matches the canonical reviewer order documented in `/api/review/merge`.
 */
export function mergeReviewLanes(perLane: PerLaneFindings): MergedReviewReport {
  const combined = [
    ...perLane.lintFindings,
    ...perLane.securityFindings,
    ...perLane.codeFindings,
    ...perLane.plannerFindings,
  ];
  const normalized = normalizeReviewFindings(combined);

  const blockers: ReviewFinding[] = [];
  const warnings: ReviewFinding[] = [];
  const suggestions: ReviewFinding[] = [];
  for (const f of normalized) {
    if (f.severity === "blocker") blockers.push(f);
    else if (f.severity === "warning") warnings.push(f);
    else suggestions.push(f);
  }

  return { blockers, warnings, suggestions, findings: normalized };
}
