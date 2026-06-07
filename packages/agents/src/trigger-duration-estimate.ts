/**
 * Run-duration estimation for the trigger form banner.
 *
 * Three tiers are available:
 *   - Tier 1 (preferred): aggregate p50/p90 from completed agent_runs for the
 *     same template ID. Requires >=3 completed runs to be statistically
 *     meaningful; otherwise we fall through to Tier 2.
 *   - Tier 2 (fallback): one deterministic LLM call analyzing the compiled OAS
 *     and the referenced SKILL.md to produce min/max prep + gated estimates
 *     with a confidence label. Used when there is insufficient history.
 *   - Tier 3 (start-only): dynamic agents (langgraph / autogen / oasAdapter)
 *     have a `triggerMode === "start-only"` and produce no estimate at all.
 *
 * Combined entry point `estimateRunDuration()` picks the best available tier.
 *
 * Safety notes:
 *   - LLM-returned numbers are validated with Number.isFinite to reject NaN /
 *     Infinity. Confidence is whitelisted to {low, medium, high}.
 *   - estimateFromHistory filters by exact templateId, so duration data from
 *     unrelated templates is never aggregated into the estimate.
 *   - LLM call failures (network, parse, missing fields) MUST return null; the
 *     form needs a stable degradation path and never crashes on UI render.
 */
import "server-only";
import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { agentRuns } from "./schema";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DurationSource = "history" | "llm-analysis";
export type ConfidenceLevel = "low" | "medium" | "high";

export type DurationEstimate = {
  source: DurationSource;
  prepMinSeconds: number;
  prepMaxSeconds: number;
  gatedMinSeconds: number;
  gatedMaxSeconds: number;
  confidence: ConfidenceLevel;
  notes: string;
  // Populated only when source === "history".
  runCount?: number;
  p50Seconds?: number;
  p90Seconds?: number;
  computedAt: string;
};

export type EstimateRunDurationArgs = {
  template: { id: string };
  compiledOas: { triggerMode?: "full" | "start-only"; [k: string]: unknown };
  skillMd?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Linear-interpolation-free percentile selector (idx = floor((n-1) * p)).
 * Sufficient resolution for the small sample sizes (3–50 runs) we operate on
 * before history confidence saturates.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p));
  return sortedAsc[idx];
}

/** Defensive numeric coercion — rejects NaN, Infinity, and non-number values. */
function finiteNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Whitelist confidence values; unknown strings collapse to "low". */
function normalizeConfidence(v: unknown): ConfidenceLevel {
  return v === "low" || v === "medium" || v === "high" ? v : "low";
}

// ---------------------------------------------------------------------------
// Tier 1 — history aggregation
// ---------------------------------------------------------------------------

/**
 * Tier 1 — aggregate p50/p90 of total wall-clock duration across the
 * template's completed runs.
 *
 * Returns null when fewer than 3 completed runs exist (statistically
 * meaningless — the form falls through to Tier 2).
 *
 * Note on the prep/gated split: the implementation approximates the breakdown
 * as 80% prep / 20% gated of total wall-clock. The actual gated-step boundary
 * timestamp is not instrumented yet. The approximation is documented in the
 * returned `notes` field so reviewers do not mistake it for a measured value.
 */
export async function estimateFromHistory(templateId: string): Promise<DurationEstimate | null> {
  const rows = await db
    .select({
      startedAt:   agentRuns.startedAt,
      completedAt: agentRuns.completedAt,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.templateId, templateId), eq(agentRuns.status, "completed")));

  // Defensive: skip rows with missing timestamps and non-positive durations.
  const durationsSec: number[] = [];
  for (const r of rows) {
    if (r.startedAt && r.completedAt) {
      const ms = r.completedAt.getTime() - r.startedAt.getTime();
      if (ms > 0) durationsSec.push(ms / 1000);
    }
  }

  if (durationsSec.length < 3) return null;

  const sorted = [...durationsSec].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);

  // Confidence buckets: 12+ = high, 6-11 = medium, 3-5 = low.
  const confidence: ConfidenceLevel =
    durationsSec.length >= 12 ? "high" : durationsSec.length >= 6 ? "medium" : "low";

  // 80/20 prep/gated split — see the JSDoc above. Stable enough for UI display;
  // Tier 2 (LLM analysis) provides a finer breakdown when history is insufficient.
  return {
    source: "history",
    runCount: durationsSec.length,
    p50Seconds: Math.round(p50),
    p90Seconds: Math.round(p90),
    prepMinSeconds: Math.round(p50 * 0.8),
    prepMaxSeconds: Math.round(p90 * 0.8),
    gatedMinSeconds: Math.round(p50 * 0.2),
    gatedMaxSeconds: Math.round(p90 * 0.2),
    confidence,
    notes: `Based on ${durationsSec.length} completed runs. Prep/gated split estimated 80/20 from total wall-clock duration.`,
    computedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tier 2 — LLM analysis of compiled OAS + SKILL.md
// ---------------------------------------------------------------------------

/**
 * Tier 2 — one deterministic LLM call analyzing the compiled OAS root and the
 * referenced SKILL.md to produce min/max prep + gated estimates with a
 * confidence label.
 *
 * Used as a fallback when there is insufficient history (Tier 1 returned null)
 * and the agent is full-mode (not start-only). Returns null on parse failure,
 * missing required fields, or LLM call rejection — the form must never crash.
 */
export async function estimateFromCompiledOas(args: {
  compiledOas: unknown;
  skillMd: string;
}): Promise<DurationEstimate | null> {
  // Lazy-load to keep this module's startup cost low and to allow vi.mock to
  // intercept before the import resolves.
  type LlmInput = { systemPrompt: string; userPrompt: string };
  type LlmFn = (input: LlmInput) => Promise<{ content: string }>;
  let runDeterministicLlmTask: LlmFn;
  try {
    const mod = await import("@cinatra-ai/llm");
    runDeterministicLlmTask = (mod as unknown as { runDeterministicLlmTask: LlmFn }).runDeterministicLlmTask;
  } catch (err) {
    console.warn("[duration-estimate] llm unavailable", err);
    return null;
  }

  // System prompt defines the required estimate schema and JSON-only response.
  const systemPrompt = `You are a runtime duration estimator for AI agent pipelines.
Estimate total wall-clock duration broken down into:
  - prepMinSeconds / prepMaxSeconds: time before the first side-effect step
  - gatedMinSeconds / gatedMaxSeconds: time for the side-effect step(s) themselves
  - confidence: "low" | "medium" | "high"
  - notes: key assumptions (e.g. "assumes LLM batch API, not sync")
Respond with JSON only — no prose.`;

  // Cap SKILL.md at ~2K tokens to avoid sending arbitrarily large author-controlled
  // content to the LLM and to guard against prompt injection via SKILL.md.
  const SKILL_MD_MAX_LEN = 8_000;
  const safeSkillMd = args.skillMd.slice(0, SKILL_MD_MAX_LEN);
  const skillMdTruncationNote =
    args.skillMd.length > SKILL_MD_MAX_LEN
      ? ` (truncated from ${args.skillMd.length} chars)`
      : "";
  const userPrompt = `Compiled OAS (full composition tree):\n\`\`\`json\n${JSON.stringify(args.compiledOas, null, 2)}\n\`\`\`\n\nReferenced SKILL.md${skillMdTruncationNote}:\n\`\`\`\n${safeSkillMd}\n\`\`\``;

  let raw: string;
  try {
    const result = await runDeterministicLlmTask({ systemPrompt, userPrompt });
    raw = result.content.trim();
  } catch (err) {
    console.warn("[duration-estimate] LLM call failed", err);
    return null;
  }

  // LLMs sometimes wrap JSON in code fences or prose. Extract the first {...} block.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  // Defensive parse — every numeric field must be present and finite.
  const prepMin = finiteNumberOrNull(parsed.prepMinSeconds);
  const prepMax = finiteNumberOrNull(parsed.prepMaxSeconds);
  const gatedMin = finiteNumberOrNull(parsed.gatedMinSeconds);
  const gatedMax = finiteNumberOrNull(parsed.gatedMaxSeconds);
  if (prepMin === null || prepMax === null || gatedMin === null || gatedMax === null) {
    return null;
  }

  return {
    source: "llm-analysis",
    prepMinSeconds: prepMin,
    prepMaxSeconds: prepMax,
    gatedMinSeconds: gatedMin,
    gatedMaxSeconds: gatedMax,
    confidence: normalizeConfidence(parsed.confidence),
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
    computedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Combined entry point
// ---------------------------------------------------------------------------

/**
 * Combined estimator: history (preferred) → LLM (fallback for full-mode) →
 * null (start-only or no data). The first-step form calls this server-side and
 * passes the result into the client component.
 */
export async function estimateRunDuration(args: EstimateRunDurationArgs): Promise<DurationEstimate | null> {
  // Tier 3 — dynamic agents get no estimate. The runtime cannot statically
  // walk steps, so neither tier 1 nor tier 2 is meaningful.
  if (args.compiledOas.triggerMode === "start-only") {
    return null;
  }

  // Tier 1 — try history first. Wins over LLM analysis when statistically meaningful.
  const fromHistory = await estimateFromHistory(args.template.id);
  if (fromHistory) return fromHistory;

  // Tier 2 — LLM analysis. Requires a SKILL.md to analyse; otherwise we cannot
  // produce a meaningful estimate and return null (the form falls back to a
  // generic "estimate unavailable" message).
  if (!args.skillMd) {
    return null;
  }
  return estimateFromCompiledOas({
    compiledOas: args.compiledOas,
    skillMd: args.skillMd,
  });
}
