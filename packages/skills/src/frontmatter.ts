/**
 * Shared, YAML-aware SKILL.md frontmatter reader.
 *
 * Two near-duplicate `match_when:` scanners used to live in
 * `packages/skills/src/matching.ts` (`parseFrontmatterMatchWhen`) and
 * `packages/skills/src/llm-matching/adapters.ts` (`extractMatchWhenRaw`). Both
 * hand-scanned the frontmatter line-by-line, which (a) duplicated brittle logic
 * and (b) could not read a `match_when:` declaration nested under `metadata:`.
 *
 * This module centralizes a single proper YAML parse of the frontmatter block
 * and a dual-read resolver for the `match_when:` value.
 *
 * ── DUAL-READ (Skills cluster Wave-0) ──────────────────────────────────────
 * The upstream Anthropic SKILL.md validator (`quick_validate.py`) only permits
 * these TOP-LEVEL frontmatter keys: name, description, license, allowed-tools,
 * metadata. A bare top-level `match_when:` key trips it, so Cinatra skills move
 * the declaration UNDER `metadata:`:
 *
 *     metadata:
 *       match_when:
 *         - agent_id: "@cinatra-ai/email-outreach-agent"
 *
 * `readMatchWhen` therefore reads `metadata.match_when` PREFERRED and FALLS BACK
 * to the legacy top-level `match_when:` — so already-migrated skills and
 * not-yet-migrated skills both keep working. A later wave removes the legacy
 * fallback.
 */

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

/**
 * Parse the YAML frontmatter block (between the first two `---` fences) of a
 * SKILL.md body into an object. Returns `undefined` when there is no
 * frontmatter, when the frontmatter is not a mapping, or when YAML parsing
 * fails (a malformed frontmatter must never throw out of the matcher; callers
 * treat "no frontmatter" as "no declared rules").
 *
 * Named `parseSkillFrontmatterYaml` (not `parseFrontmatter`) to avoid colliding
 * with the legacy attribute-bag `parseFrontmatter` already exported from
 * `./skills-registry` — this one returns the raw YAML-parsed mapping.
 */
export function parseSkillFrontmatterYaml(content: string): Record<string, unknown> | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = yamlParse(match[1]);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve the `match_when` value from a SKILL.md body, preferring
 * `metadata.match_when` and falling back to the legacy top-level `match_when`.
 *
 * Returns the already-parsed YAML value (a string such as `"always"`, an array
 * of strings/objects, or `undefined` when neither location declares it). The
 * `metadata` location wins when both are present.
 */
export function readMatchWhen(content: string): unknown {
  const fm = parseSkillFrontmatterYaml(content);
  if (!fm) return undefined;
  const metadata = fm.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const nested = (metadata as Record<string, unknown>).match_when;
    if (nested !== undefined) return nested;
  }
  return fm.match_when;
}

/**
 * Serialize the resolved `match_when` value back to the YAML text the
 * downstream `match-when-parser.ts` expects (it re-parses the raw block with
 * `yamlParse`). Returns `undefined` when no `match_when` is declared in either
 * location.
 *
 * This preserves the existing `extractMatchWhenRaw` contract — a raw YAML string
 * fed to `parseMatchWhen` — while adding `metadata.match_when` preference. We
 * round-trip through the parsed value (rather than slicing raw lines) so a
 * nested `metadata.match_when` block is re-emitted as a top-level document the
 * downstream parser reads identically to a legacy top-level block.
 */
export function readMatchWhenRaw(content: string): string | undefined {
  const value = readMatchWhen(content);
  // `undefined` (no key) and `null` (`match_when:` with an empty value) both mean
  // "nothing declared" — return undefined so the downstream parser treats it as
  // absent (route to LLM) rather than serializing a literal `null`.
  if (value === undefined || value === null) return undefined;
  // A bare string (`always`) is returned as-is so the downstream parser sees the
  // same scalar the legacy raw-slice produced.
  if (typeof value === "string") return value;
  // Arrays / objects are re-serialized to YAML. `parseMatchWhen` runs the result
  // back through `yamlParse`, so the exact formatting does not matter — only that
  // it round-trips to the same structure.
  return yamlStringify(value);
}
