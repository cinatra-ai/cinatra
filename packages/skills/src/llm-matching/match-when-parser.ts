/**
 * Parses the `match_when:` block from a SKILL.md frontmatter.
 *
 * When YAML parse fails, log a single structured warning via console.warn and
 * return `{kind: "malformed", raw, error}`. The caller (evaluate-pair.ts) must
 * forward the raw text into the LLM prompt as the {{matchWhenHint}} substitution.
 * There is no match-all fallback: the LLM must see the malformed text so it can
 * still make a best-effort decision.
 */

import { parse as yamlParse } from "yaml";

export type MatchWhenClause =
  | { always: true }
  | { agent_id: string }
  | { agent_has_tag: string }
  | Record<string, unknown>;

export type ParsedMatchWhen =
  | { kind: "absent" }
  | { kind: "ok"; clauses: MatchWhenClause[]; raw: string }
  | { kind: "malformed"; raw: string; error: string };

export function parseMatchWhen(
  raw: string | undefined | null,
  skillId: string,
): ParsedMatchWhen {
  if (raw === undefined || raw === null || raw.trim().length === 0) {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = yamlParse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Single structured warning event for malformed match_when input.
    console.warn(
      JSON.stringify({
        event: "skill_match_when_malformed",
        skillId,
        raw,
        error: message,
      }),
    );
    return { kind: "malformed", raw, error: message };
  }
  if (parsed === null || parsed === undefined) {
    return { kind: "ok", clauses: [], raw };
  }
  if (Array.isArray(parsed)) {
    // YAML parses bare strings ("always") as strings, not objects. Normalize
    // those to the canonical `{always: true}` clause shape so rule-short-circuit
    // doesn't have to special-case strings.
    const clauses: MatchWhenClause[] = parsed.map((entry) => {
      if (typeof entry === "string" && entry.trim() === "always") {
        return { always: true } as MatchWhenClause;
      }
      return entry as MatchWhenClause;
    });
    return { kind: "ok", clauses, raw };
  }
  // Single object form: `match_when: agent_id: foo` (no leading dash).
  if (typeof parsed === "string" && parsed.trim() === "always") {
    return { kind: "ok", clauses: [{ always: true }], raw };
  }
  return { kind: "ok", clauses: [parsed as MatchWhenClause], raw };
}
