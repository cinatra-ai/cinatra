/**
 * Request-aware skill RECOMMENDATION scorer (cinatra#2041, epic #2037 S3, Point R).
 *
 * The authoritative per-run recommendation SCORING core. Today's automatic
 * matcher scores skill×AGENT usefulness (`skill_matches`) from the agent's
 * name/description/tags — never the current prompt, run intent, or requested
 * artifact type (`packages/skills/src/llm-matching/types.ts`). This module is
 * the sibling that re-scores a candidate set against the RUN'S ACTUAL INTENT so
 * the recommendation reflects what THIS run is about to do, not the agent in the
 * abstract.
 *
 * DETERMINISTIC by construction (AC-1): a fixed candidate set + fixed weights
 * yields a byte-identical ranking, and every ranked row CITES the run-intent
 * features its score was computed on (`scoredFeatures`). No LLM call, no clock,
 * no randomness — the same inputs always produce the same output, so the scorer
 * is exhaustively unit-testable and the MCP "what skills fit this task"
 * primitive (AC-5) returns the SAME scores as the run-start interception (a
 * single implementation, never a parallel one).
 *
 * --- Leaf-safety contract ---------------------------------------------------
 *
 * THIS MODULE MUST REMAIN IMPORT-FREE (same rule as
 * `@cinatra-ai/skills/llm-matching/types`). It is reachable via the dedicated
 * leaf sub-path `@cinatra-ai/skills/recommendation` so client components and the
 * host bridge can obtain the pure scorer WITHOUT pulling the side-effectful main
 * `@cinatra-ai/skills` barrel (which transitively re-exports `server-only`
 * modules). Do NOT add `import "server-only"` here and do NOT import any sibling
 * that transitively pulls a server-only module. Only pure type/const additions.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Inputs.
// ---------------------------------------------------------------------------

/**
 * The RUN INTENT the recommendation is scored against — what this run is about
 * to do. Every field is optional so a bare run (no declared types, no target)
 * still scores on whatever intent it carries (down to the agent-centric base
 * score alone).
 */
export interface RunIntent {
  /** The prompt / task input the run will act on (free text). */
  promptText?: string;
  /** Artifact types the run declares it will produce (manifest `producedTypes`
   * / task-declared). Exact-token hits earn a produced-type bonus. */
  declaredProducedTypes?: string[];
  /** The target artifact kind when known (e.g. `wordpress:post`, `document`). */
  targetArtifactKind?: string;
}

/**
 * A single candidate skill to score. `skillRevisionId` is the EXACT pinned
 * immutable revision the recommendation references — recommendations reference
 * pinned revisions, never names/files (S3 deliverable). `baseMatchScore` is the
 * agent-centric matcher signal (`skill_matches.score`, 0..1) or null.
 */
export interface RecommendationCandidate {
  skillId: string;
  skillRevisionId: string;
  name: string;
  description: string;
  /** Optional short cue text (e.g. the SKILL.md `match_when` block or the first
   * lines of content) used only to widen the token surface the intent is
   * matched against. */
  cueText?: string;
  level?: string;
  /** Agent-centric base match score from `skill_matches` (0..1) or null. */
  baseMatchScore?: number | null;
  /** Whether the agent-centric matcher marked this pair a match. */
  baseMatched?: boolean;
}

/** Tunable weights. Fixed defaults keep the ranking deterministic + stable
 * across releases; a caller may override for experiments (the value is echoed
 * into `scoredFeatures` contributions so the citation stays honest). */
export interface ScorerWeights {
  /** Weight applied to the agent-centric base match score. */
  base: number;
  /** Per-token weight for a run-intent token that hits the candidate. */
  intentToken: number;
  /** Cap on the total intent-token contribution (so a long prompt cannot swamp
   * the base signal). */
  intentTokenCap: number;
  /** Bonus when a declared produced-type token hits the candidate. */
  producedType: number;
  /** Bonus when a target-artifact-kind token hits the candidate. */
  artifactKind: number;
  /** A candidate is `recommended` when its final score is at least this. */
  recommendThreshold: number;
}

export const DEFAULT_SCORER_WEIGHTS: ScorerWeights = {
  base: 0.5,
  intentToken: 0.08,
  intentTokenCap: 0.35,
  producedType: 0.2,
  artifactKind: 0.15,
  recommendThreshold: 0.3,
};

/** The scorer version — bumped when the scoring math changes so a stored
 * recommendation can be attributed to the exact algorithm that produced it. */
export const REQUEST_AWARE_SCORER_VERSION = "s3-request-aware-v1";

// ---------------------------------------------------------------------------
// Outputs.
// ---------------------------------------------------------------------------

/** One feature that contributed to a candidate's score — the AC-1 CITATION. A
 * `base_match` feature cites the agent-centric signal; the other three cite the
 * RUN-INTENT features the request-aware layer scored on. */
export interface ScoredFeature {
  kind: "base_match" | "intent_token" | "produced_type" | "artifact_kind";
  /** The concrete thing matched — the token, produced-type, or artifact-kind. */
  detail: string;
  /** The contribution this feature added to the score (rounded to 4dp). */
  contribution: number;
}

/** A ranked recommendation: the pinned revision, the deterministic score, its
 * 1-based rank, whether it clears the recommend threshold, and the run-intent
 * features it was scored on. */
export interface RankedRecommendation {
  skillId: string;
  skillRevisionId: string;
  name: string;
  /** Deterministic final score in [0,1], rounded to 4dp. */
  score: number;
  /** 1-based rank (1 = best); ties broken by `skillId` ascending. */
  rank: number;
  /** True when `score >= weights.recommendThreshold`. */
  recommended: boolean;
  /** The features the score was computed on (base + run-intent). Sorted:
   * highest contribution first, then by kind, then by detail. */
  scoredFeatures: ScoredFeature[];
}

// ---------------------------------------------------------------------------
// Tokenization (deterministic, leaf-safe).
// ---------------------------------------------------------------------------

/** Minimal English stopword set — dropped so common words don't create spurious
 * intent hits. Deliberately small + fixed (determinism over recall). */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you",
  "our", "are", "was", "were", "will", "would", "should", "could", "can", "may",
  "have", "has", "had", "not", "but", "all", "any", "out", "use", "using",
  "used", "get", "got", "run", "make", "made", "new", "one", "two", "via",
  "per", "how", "what", "when", "which", "who", "why", "about", "over", "under",
]);

/** Lowercase, split on non-alphanumeric, drop stopwords + tokens shorter than 3
 * chars. Returns a SORTED, de-duplicated token list so downstream iteration is
 * order-stable regardless of input word order. */
export function tokenizeIntent(text: string | undefined | null): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen].sort();
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Build the set of tokens a candidate exposes (name + description + cue). */
function candidateTokenSet(candidate: RecommendationCandidate): Set<string> {
  const tokens = new Set<string>();
  for (const t of tokenizeIntent(candidate.name)) tokens.add(t);
  for (const t of tokenizeIntent(candidate.description)) tokens.add(t);
  if (candidate.cueText) for (const t of tokenizeIntent(candidate.cueText)) tokens.add(t);
  return tokens;
}

// ---------------------------------------------------------------------------
// The scorer.
// ---------------------------------------------------------------------------

export interface ScoreRecommendationsInput {
  intent: RunIntent;
  candidates: RecommendationCandidate[];
  weights?: Partial<ScorerWeights>;
}

/**
 * Score + rank a candidate set against a run's intent. Total, deterministic,
 * side-effect-free.
 *
 * Score = clamp(
 *   base.weight * (baseMatchScore ?? 0)
 *   + min(intentTokenCap, intentToken.weight * |intent∩candidate|)
 *   + producedType.weight * (any declared produced-type token hits)
 *   + artifactKind.weight * (any target-artifact-kind token hits),
 *   0, 1).
 *
 * Ordering: score descending, ties broken by `skillId` ascending (stable +
 * reproducible). Ranks are dense 1-based over the sorted order.
 */
export function scoreSkillRecommendations(
  input: ScoreRecommendationsInput,
): RankedRecommendation[] {
  const weights: ScorerWeights = { ...DEFAULT_SCORER_WEIGHTS, ...(input.weights ?? {}) };

  const intentTokens = tokenizeIntent(input.intent.promptText);
  const producedTypeTokens = (input.intent.declaredProducedTypes ?? [])
    .flatMap((t) => tokenizeIntent(t))
    .sort();
  const artifactKindTokens = tokenizeIntent(input.intent.targetArtifactKind);

  const scored = input.candidates.map((candidate) => {
    const candidateTokens = candidateTokenSet(candidate);
    const features: ScoredFeature[] = [];

    // Base agent-centric signal.
    const baseScore = typeof candidate.baseMatchScore === "number" ? candidate.baseMatchScore : 0;
    if (baseScore > 0) {
      const contribution = round4(weights.base * baseScore);
      if (contribution > 0) {
        features.push({ kind: "base_match", detail: `score=${round4(baseScore)}`, contribution });
      }
    }

    // Run-intent token overlap (capped). Distribute the (possibly capped) total
    // across the hit tokens so the cited per-token contributions sum EXACTLY to
    // the applied total — done in 4dp integer units so rounding never inflates
    // the sum past the cap. The remainder lands on the first (sorted) tokens, so
    // the citation is deterministic.
    const hitTokens = intentTokens.filter((t) => candidateTokens.has(t));
    if (hitTokens.length > 0) {
      const appliedIntent = round4(
        Math.min(weights.intentTokenCap, weights.intentToken * hitTokens.length),
      );
      const totalUnits = Math.round(appliedIntent * 1e4);
      const n = hitTokens.length;
      const baseUnits = Math.floor(totalUnits / n);
      const remainder = totalUnits - baseUnits * n;
      hitTokens.forEach((t, i) => {
        const units = baseUnits + (i < remainder ? 1 : 0);
        if (units > 0) {
          features.push({ kind: "intent_token", detail: t, contribution: units / 1e4 });
        }
      });
    }

    // Declared produced-type hits.
    const producedHits = producedTypeTokens.filter((t) => candidateTokens.has(t));
    if (producedHits.length > 0) {
      // A produced-type match is a single categorical bonus, not per-token.
      features.push({
        kind: "produced_type",
        detail: producedHits.join(","),
        contribution: round4(weights.producedType),
      });
    }

    // Target-artifact-kind hits.
    const artifactHits = artifactKindTokens.filter((t) => candidateTokens.has(t));
    if (artifactHits.length > 0) {
      features.push({
        kind: "artifact_kind",
        detail: artifactHits.join(","),
        contribution: round4(weights.artifactKind),
      });
    }

    const rawScore = features.reduce((acc, f) => acc + f.contribution, 0);
    const score = round4(Math.max(0, Math.min(1, rawScore)));

    // Sort features: contribution desc, then kind, then detail — deterministic.
    features.sort(
      (a, b) =>
        b.contribution - a.contribution ||
        a.kind.localeCompare(b.kind) ||
        a.detail.localeCompare(b.detail),
    );

    return {
      skillId: candidate.skillId,
      skillRevisionId: candidate.skillRevisionId,
      name: candidate.name,
      score,
      recommended: score >= weights.recommendThreshold,
      scoredFeatures: features,
    };
  });

  // Rank: score desc, tie-break skillId asc by CODE-UNIT order (locale-
  // independent — `localeCompare` would let the runtime locale reorder ties on
  // non-ASCII ids, breaking AC-1 determinism across hosts).
  scored.sort((a, b) =>
    b.score - a.score || (a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0),
  );

  return scored.map((row, i) => ({ ...row, rank: i + 1 }));
}
