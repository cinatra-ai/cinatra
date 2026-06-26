import { readMatchWhen } from "./frontmatter";
import type { PersistedSkill } from "./skills-store";

export type MatchContext = {
  agentId?: string;
  agentTags?: string[];
  orgDomain?: string;
};

type MatchWhenRule =
  | { type: "agent_has_tag"; value: string }
  | { type: "agent_id"; value: string }
  | { type: "always" };

function parseMatchWhenRules(frontmatterMatchWhen: unknown): MatchWhenRule[] {
  if (!frontmatterMatchWhen) return [];

  const raw = frontmatterMatchWhen;

  // Support a single string (`match_when: always`) or an array of strings/objects
  // (the YAML block-sequence form). A bare mapping value (`match_when: { agent_id:
  // foo }`) is intentionally NOT treated as a rule list — it yields no rules and
  // falls through to the permissive match-all default (Pitfall 5). This preserves
  // the historical behavior of the previous hand-rolled scanner, which only ever
  // produced a string or an array.
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? [raw]
      : [];

  const rules: MatchWhenRule[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (entry === "always") {
        rules.push({ type: "always" });
      }
    } else if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      if (typeof obj.agent_has_tag === "string") {
        rules.push({ type: "agent_has_tag", value: obj.agent_has_tag });
      } else if (typeof obj.agent_id === "string") {
        rules.push({ type: "agent_id", value: obj.agent_id });
      }
    }
  }

  return rules;
}

/**
 * Resolve the `match_when` declaration from a SKILL.md body, preferring
 * `metadata.match_when` and falling back to the legacy top-level `match_when`
 * (Skills cluster Wave-0 dual-read).
 *
 * Delegates to the shared, YAML-aware reader in `./frontmatter`. The shared
 * reader returns an already-parsed value (a `"always"` scalar or an array of
 * strings/objects); `parseMatchWhenRules` consumes that shape directly. Because
 * `yaml.parse` already unquotes scalars, the previous hand-rolled quote-stripping
 * is no longer needed — `agent_id: "@cinatra-ai/email-outreach-agent"` resolves
 * to the unquoted string at runtime.
 */
function parseFrontmatterMatchWhen(content: string): unknown {
  return readMatchWhen(content);
}

/**
 * Evaluate whether `skill` should be attached to the agent described by
 * `context`, by parsing its `match_when:` frontmatter and combining the
 * resulting rules.
 *
 * **Rule combination — OR semantics.** Multiple rules combine with
 * a logical OR via `rules.some(...)`. A skill author cannot satisfy two
 * distinct `agent_id` values simultaneously: writing
 *
 * ```yaml
 * match_when:
 *   - agent_id: "@cinatra-ai/email-outreach-agent"
 *   - agent_id: "@cinatra-ai/email-delivery-agent"
 * ```
 *
 * is intuitively "either of these agents", and AND would render the entry
 * unreachable for any context. Tag-based rules combine the same way: any
 * matching rule is sufficient, and an `always` entry short-circuits to
 * true. Authors who need conjunction should encode it via tags (one tag
 * means "satisfies all required signals") rather than multiple
 * frontmatter rules. See `matching.test.ts` for the regression coverage.
 *
 * **Empty rules → match-all (Pitfall 5).** When `parseMatchWhenRules`
 * returns an empty array — either because there is no `match_when:` key,
 * or because every entry was malformed/unrecognized — the skill matches
 * every agent. This is a deliberate permissive default for backward
 * compatibility; see `matching.test.ts` "Pitfall 5 malformed frontmatter
 * is permissive".
 */
export function evaluateSkillMatchRules(skill: PersistedSkill, context: MatchContext): boolean {
  const rawMatchWhen = parseFrontmatterMatchWhen(skill.content);
  const rules = parseMatchWhenRules(rawMatchWhen);

  // No rules defined → always match (see Pitfall 5 in JSDoc above).
  if (rules.length === 0) return true;

  // OR semantics: any matching rule is sufficient. See JSDoc above
  // for the rationale on choosing `rules.some` over `rules.every`.
  return rules.some((rule) => {
    switch (rule.type) {
      case "always":
        return true;
      case "agent_id":
        return context.agentId === rule.value;
      case "agent_has_tag":
        return context.agentTags?.includes(rule.value) ?? false;
      default:
        return false;
    }
  });
}

/**
 * Strict variant of {@link evaluateSkillMatchRules} for operator-installed
 * (custom) skills keyed by `skill.isCustom === true`.
 *
 * Same body and rule-evaluation semantics as the lenient evaluator —
 * `always` short-circuits to true, multiple rules combine with OR,
 * `agent_id` / `agent_has_tag` resolve against `context` — except when
 * `parseMatchWhenRules` returns an empty array.
 *
 * Where {@link evaluateSkillMatchRules} treats "no rules" as a permissive
 * match-all (Pitfall 5, retained for backward compatibility with in-house
 * `personal` / `team` / `organization` / `workspace` / `project` levels),
 * this strict variant returns `false` instead. Rationale: an operator-
 * installed skill author who shipped a SKILL.md without a `match_when:`
 * block almost certainly forgot to declare scope rather than intentionally
 * opting into every agent. Treating that as "match nothing" is the safer
 * default for installed content authored outside the workspace.
 *
 * Use this only for `skill.isCustom === true` (operator-installed via the
 * GitHub upload flow or scanned in without an explicit plugin.json level).
 * Other levels should either bypass matching entirely (system → globally
 * injected) or be resolved via the assignments table — not
 * through this evaluator at all.
 */
export function evaluateSkillMatchRulesStrict(
  skill: PersistedSkill,
  context: MatchContext,
): boolean {
  const rawMatchWhen = parseFrontmatterMatchWhen(skill.content);
  const rules = parseMatchWhenRules(rawMatchWhen);

  // Strict mode: empty rules means "scope not declared", not "match all".
  if (rules.length === 0) return false;

  return rules.some((rule) => {
    switch (rule.type) {
      case "always":
        return true;
      case "agent_id":
        return context.agentId === rule.value;
      case "agent_has_tag":
        return context.agentTags?.includes(rule.value) ?? false;
      default:
        return false;
    }
  });
}

/**
 * Build a {@link MatchContext} for an agent from its own `level: "agent"`
 * SKILL.md files.
 *
 * This helper reads the richest signal already on disk: the agent's
 * SKILL.md frontmatter.
 *
 * Behavior:
 * - For each agent SKILL.md, parse `tags:` and `keywords:` from the YAML
 *   frontmatter (both inline `[a, b]` and block `\n  - a\n  - b` forms).
 * - Always inject `skill.slug` and `skill.agentId` (when present) so
 *   `match_when: agent_id: ...` rules continue to resolve.
 * - Fallback: if a SKILL.md has no frontmatter at all, tokenize its first
 *   500 characters and add lowercase tokens of length >= 4 — this is the
 *   "scan content if frontmatter is missing" fallback.
 *
 * Note: the existing `parseFrontmatterMatchWhen` is single-purpose for
 * the `match_when:` key, so we inline a minimal frontmatter scanner here
 * for `tags:` / `keywords:` rather than introducing a new shared YAML
 * utility.
 */
export function buildAgentMatchContext(
  agentId: string,
  agentSkills: PersistedSkill[],
): MatchContext {
  const tags = new Set<string>();

  for (const skill of agentSkills) {
    // Frontmatter pass: pull declared tags/keywords from SKILL.md frontmatter.
    const fmMatch = skill.content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fmMatch) {
      const fm = fmMatch[1];
      // tags: [a, b]  OR  tags:\n  - a\n  - b
      const inlineTags = fm.match(/^tags:\s*\[([^\]]*)\]/m);
      if (inlineTags) {
        for (const raw of inlineTags[1].split(",")) {
          const t = raw.trim().replace(/^["']|["']$/g, "");
          if (t) tags.add(t);
        }
      } else {
        const blockTagsIdx = fm.split("\n").findIndex((l) => l.trim() === "tags:");
        if (blockTagsIdx >= 0) {
          const lines = fm.split("\n").slice(blockTagsIdx + 1);
          for (const line of lines) {
            const item = line.match(/^\s+-\s+(.+)$/);
            if (!item) break;
            const t = item[1].trim().replace(/^["']|["']$/g, "");
            if (t) tags.add(t);
          }
        }
      }
      // Same parsing for `keywords:` (some SKILL.md files use that key instead).
      const inlineKw = fm.match(/^keywords:\s*\[([^\]]*)\]/m);
      if (inlineKw) {
        for (const raw of inlineKw[1].split(",")) {
          const t = raw.trim().replace(/^["']|["']$/g, "");
          if (t) tags.add(t);
        }
      } else {
        const blockKwIdx = fm.split("\n").findIndex((l) => l.trim() === "keywords:");
        if (blockKwIdx >= 0) {
          const lines = fm.split("\n").slice(blockKwIdx + 1);
          for (const line of lines) {
            const item = line.match(/^\s+-\s+(.+)$/);
            if (!item) break;
            const t = item[1].trim().replace(/^["']|["']$/g, "");
            if (t) tags.add(t);
          }
        }
      }
      // Always treat the slug/agentId itself as a tag so `agent_id` rules still resolve.
      if (skill.slug) tags.add(skill.slug);
      if (skill.agentId) tags.add(skill.agentId);
    } else if (skill.content.trim().length > 0) {
      // Fallback (per spec): if a level: "agent" SKILL.md has no frontmatter,
      // read its content and extract first-line keywords (heading + first paragraph).
      // We tokenize the first 500 chars on whitespace, lowercase, and add tokens of length >= 4.
      const head = skill.content.slice(0, 500).toLowerCase();
      for (const tok of head.split(/[^a-z0-9-]+/)) {
        if (tok.length >= 4) tags.add(tok);
      }
    }
  }

  return {
    agentId,
    agentTags: Array.from(tags),
  };
}
