/**
 * Rationale grounding validator.
 *
 * The LLM matcher returns `{ matched, score, rationale }`. The rationale text
 * is shown to admins and stored in `cinatra.skill_matches.rationale`. Without
 * a grounding check, the model can produce plausible-sounding rationales that
 * don't actually reference the skill content — silent hallucination.
 *
 * Strategy: deterministic token-overlap. Tokenize the rationale, tokenize the
 * skill + agent metadata, compute the intersection ratio. If a rationale
 * claims a match but its content words don't appear in the skill / agent
 * surface, downgrade with a conservative fallback and emit a structured
 * warning.
 *
 * Why only on `matched === true`:
 *   - A `matched=false` rationale legitimately discusses why the skill isn't
 *     useful — it may reference what the agent does without quoting skill
 *     content. Grounding would have a high false-positive rate.
 *   - A `matched=true` rationale should ground the recommendation in concrete
 *     skill / agent specifics. If it can't, the model is fabricating.
 *
 * Why deterministic instead of a second LLM call:
 *   - A second LLM call doubles the cost per evaluation; token overlap is
 *     cheap and catches the gross-fabrication case.
 *   - A sampled consistency check can layer on top, but the baseline
 *     deterministic guard is the first line of defense.
 */

import type { AgentForMatching, SkillForMatching } from "./types";

/** Threshold below which the rationale is considered ungrounded. */
export const RATIONALE_GROUNDING_MIN_OVERLAP = 0.2;

/**
 * Below this many content tokens the rationale is too short to evaluate.
 * 5 chosen empirically: rationales like "inline batch parity" (3 tokens) or
 * "yes match clearly applicable" (4 tokens) are effectively decision labels,
 * not arguments — there's no rhetorical surface to ground or fabricate.
 */
export const RATIONALE_GROUNDING_MIN_TOKEN_COUNT = 5;

/**
 * Minimum length of a content word (chars) to count toward overlap.
 * Note: domain acronyms shorter than this (`API`, `CRM`, `SQL`, `SEO`) are
 * dropped — acceptable precision trade-off; would inflate false positives if we
 * lowered the bar to 3 chars (English fillers like `the`, `and`, `for`).
 */
const MIN_TOKEN_LENGTH = 4;

/** Cap on how much skill content feeds the reference token set (UTF-8 bytes). */
const SKILL_CONTENT_SAMPLE_BYTES = 4096;

/**
 * Platform/generic tokens that don't represent actual skill or agent content.
 * Without this filter, rationales like "This skill is useful for this agent"
 * trivially pass grounding because `skill` and `agent` are themselves in the
 * reference set (via `skillId` / `agent.packageId` segments).
 *
 * Two categories:
 *   - Platform identifiers: `cinatra`, `skill`, `skills`, `agent`, `agents`,
 *     `match`, `matches`, `matching`, `package` — appear in IDs/types but
 *     don't carry semantic content.
 *   - Generic boilerplate verbs/adjectives common in classifier prose:
 *     `useful`, `helpful`, `relevant`, `provides`, `applicable`, `appropriate`,
 *     `enables`, `support`, `supports`, `function`, `feature`, `because`,
 *     `would`, `could`, `should`, `improves`, `workflow`, `quality`, `value`.
 *
 * Without this stopword filter, a rationale like "This skill is useful for
 * this agent because it improves workflow quality" clears the 0.20 overlap
 * gate via platform tokens alone.
 */
const PLATFORM_STOPWORDS = new Set([
  "cinatra",
  "skill",
  "skills",
  "agent",
  "agents",
  "match",
  "matches",
  "matching",
  "package",
  "packages",
  "useful",
  "helpful",
  "relevant",
  "applicable",
  "appropriate",
  "provides",
  "provide",
  "enables",
  "enable",
  "support",
  "supports",
  "function",
  "functions",
  "feature",
  "features",
  "because",
  "would",
  "could",
  "should",
  "improves",
  "improve",
  "workflow",
  "workflows",
  "quality",
  "value",
  "this",
  "that",
  "these",
  "those",
]);

/**
 * Conservative fallback rationale stored when the grounding check fails for
 * a `matched=true` row. The user-facing surface shows this string verbatim;
 * the original LLM rationale is captured in the structured warning log for
 * post-hoc review.
 */
export const UNGROUNDED_RATIONALE_FALLBACK =
  "Matched by classifier; rationale text was suppressed because it did not reference the skill content (see skill-match-ungrounded-rationale log).";

const TOKEN_SPLIT_RE = /[^a-z0-9]+/i;

function tokenizeRaw(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT_RE)
    .filter((tok) => tok.length >= MIN_TOKEN_LENGTH);
}

function dropStopwords(tokens: string[]): string[] {
  return tokens.filter((tok) => !PLATFORM_STOPWORDS.has(tok));
}

function buildReferenceTokenSet(
  agent: AgentForMatching,
  skill: SkillForMatching,
): Set<string> {
  // Byte-aware truncation matches the prompt-builder's truncation behavior.
  // `string.slice(0, N)` cuts at a codepoint, not a byte;
  // `Buffer.subarray(0, N).toString("utf-8")` cuts at a byte, can emit
  // U+FFFD on multibyte mid-codepoint cuts. Either is acceptable here (the
  // reference set is derived; U+FFFD doesn't tokenize anyway) but using bytes
  // keeps behavior aligned with the LLM's input.
  const contentBuffer = Buffer.from(skill.content, "utf-8");
  const skillContentSample =
    contentBuffer.byteLength > SKILL_CONTENT_SAMPLE_BYTES
      ? contentBuffer.subarray(0, SKILL_CONTENT_SAMPLE_BYTES).toString("utf-8")
      : skill.content;

  // EXCLUDE skillId and agent.packageId from the reference set. These are
  // identifiers (e.g. `skill-cold-email`, `@cinatra/email-agent`) that contain
  // platform tokens like `skill`, `cinatra`, `agent` — including them would let
  // "This skill matches this agent" trivially clear the overlap gate. Skill
  // name + content + agent name + description + tags are the actual semantic
  // surface.
  const refText = [
    skill.name,
    skillContentSample,
    agent.name,
    agent.description,
    agent.tags.join(" "),
  ].join(" ");

  return new Set(dropStopwords(tokenizeRaw(refText)));
}

export interface GroundingResult {
  grounded: boolean;
  overlapRatio: number;
  rationaleTokenCount: number;
  sharedTokens: string[];
}

/**
 * Token-overlap grounding check. Returns `grounded=true` when:
 *   - the rationale has fewer than `RATIONALE_GROUNDING_MIN_TOKEN_COUNT`
 *     content tokens (too short to evaluate; defer to score gate), OR
 *   - the intersection ratio between rationale tokens and the skill+agent
 *     reference token set is at least `RATIONALE_GROUNDING_MIN_OVERLAP`.
 *
 * The reference token set is built from skill name + first 4 KB of skill
 * content + agent name + agent description + agent tags.
 */
export function checkRationaleGrounding(
  rationale: string,
  agent: AgentForMatching,
  skill: SkillForMatching,
): GroundingResult {
  // Step 1: short-rationale bypass uses RAW token count (length cutoff only,
  // no stopword filter). A rationale with fewer than 5 raw content words is
  // a decision label, not an argument.
  const rawTokens = tokenizeRaw(rationale);
  const rationaleTokenCount = rawTokens.length;

  if (rationaleTokenCount < RATIONALE_GROUNDING_MIN_TOKEN_COUNT) {
    return {
      grounded: true,
      overlapRatio: 1,
      rationaleTokenCount,
      sharedTokens: rawTokens,
    };
  }

  // Step 2: drop platform stopwords. If everything is stopwords, the
  // rationale carries no content — that's NOT short, it's fabricated platform
  // boilerplate ("This skill is useful for this agent because it improves
  // workflow quality"). Mark ungrounded.
  const filteredTokens = dropStopwords(rawTokens);
  if (filteredTokens.length === 0) {
    return {
      grounded: false,
      overlapRatio: 0,
      rationaleTokenCount,
      sharedTokens: [],
    };
  }

  // Step 3: compute overlap ratio over the filtered set.
  const refSet = buildReferenceTokenSet(agent, skill);
  const seen = new Set<string>();
  const shared: string[] = [];
  for (const tok of filteredTokens) {
    if (seen.has(tok)) continue;
    seen.add(tok);
    if (refSet.has(tok)) shared.push(tok);
  }
  const uniqueRationaleCount = seen.size;
  const overlapRatio = shared.length / uniqueRationaleCount;
  const grounded = overlapRatio >= RATIONALE_GROUNDING_MIN_OVERLAP;

  return {
    grounded,
    overlapRatio,
    rationaleTokenCount,
    sharedTokens: shared,
  };
}
