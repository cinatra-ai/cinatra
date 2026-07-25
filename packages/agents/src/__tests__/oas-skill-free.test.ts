import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * HARD INVARIANT regression test.
 *
 * Agent methodology lives in the catalog
 * (`@cinatra-ai/skills` upsertSkill / `skills_installed_resolve_for_agent`),
 * never in `oas.json`. Inline reviewer `system` bodies belong
 * out of `extensions/cinatra-ai/{security,code,planner}-reviewer-agent/cinatra/oas.json`
 * into per-agent catalog skills. This test gates the invariant so any future
 * regression that puts methodology back into an OAS (or smuggles a `skillIds`
 * field into one) fails CI.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const EXT_DIR = path.join(REPO_ROOT, "extensions/cinatra-ai");
const SYSTEM_USER_THRESHOLD = 400; // chars — thin dispatchers fit; methodology bodies do not.

/**
 * Scope of the length-check (system/user ≤ THRESHOLD): the 4 agents whose
 * methodology was lifted out of OAS into per-agent catalog
 * skills. Existing non-creation agents carry legitimate domain prose in OAS
 * (e.g. email-recipient-selection ~2.8k, web-scrape ~700) that is NOT
 * catalog-managed methodology; migrating those is out of scope for this
 * invariant. Future extensions of the catalog-skill pattern to additional
 * agents MUST add them to this set (anti-regression).
 *
 * The `no-skillIds anywhere` check below applies to EVERY OAS — no scoping —
 * because the no-skills-in-OAS rule is universal.
 */
const CREATION_AGENTS_WITH_THIN_OAS = new Set([
  "security-reviewer-agent",
  "code-reviewer-agent",
  "planner-agent",
  "author-agent",
]);

/**
 * Deterministic exclusions from the broad no-skillIds scan:
 *   - `lint-policy-agent` — deterministic scanner; no LLM dispatch.
 *   - `auditor-agent` — meta-agent that AUDITS skills; `skillIds` is its
 *     legitimate data payload (input/output field name, DataFlowEdge thread),
 *     NOT methodology-prose embedding. The catalog ownership rule is
 *     preserved: this agent
 *     receives skill ids AS DATA from the catalog; it does not embed
 *     methodology into OAS.
 */
const SKIP_NO_SKILL_IDS_SCAN = new Set([
  "lint-policy-agent",
  "auditor-agent",
]);

type OasEntry = { dir: string; oasPath: string; oas: Record<string, unknown> };

function walkOasFiles(skip: Set<string>): OasEntry[] {
  const out: OasEntry[] = [];
  if (!existsSync(EXT_DIR)) return out;
  for (const entry of readdirSync(EXT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || skip.has(entry.name)) continue;
    const oasPath = path.join(EXT_DIR, entry.name, "cinatra", "oas.json");
    if (!existsSync(oasPath)) continue;
    let oas: Record<string, unknown>;
    try {
      oas = JSON.parse(readFileSync(oasPath, "utf8"));
    } catch {
      continue;
    }
    out.push({ dir: entry.name, oasPath, oas });
  }
  return out;
}

describe("OAS skill-free invariant", () => {
  // BROAD no-skillIds scan — applies to every OAS except the deterministic
  // exclusion. Skills are resolved only via the catalog/skills layer
  // (nothing in oas.json), enforced universally.
  const broadOasFiles = walkOasFiles(SKIP_NO_SKILL_IDS_SCAN);

  it("BROAD no-skillIds scan: walks non-zero OAS files (sanity)", () => {
    expect(broadOasFiles.length).toBeGreaterThan(0);
  });

  it("BROAD no-skillIds scan: SKIP-list anti-creep — at most 3 exclusions", () => {
    expect(SKIP_NO_SKILL_IDS_SCAN.size).toBeLessThanOrEqual(3);
  });

  for (const { dir, oas } of broadOasFiles) {
    it(`${dir}: no skillIds / skill_ids field anywhere in OAS`, () => {
      const json = JSON.stringify(oas);
      expect(json.includes('"skillIds"')).toBe(false);
      expect(json.includes('"skill_ids"')).toBe(false);
    });
  }

  // SCOPED length check — applies only to the 4 creation agents migrated to
  // per-agent catalog skills. Future extensions of the pattern
  // MUST add agents to CREATION_AGENTS_WITH_THIN_OAS.
  const creationOasFiles = broadOasFiles.filter((e) =>
    CREATION_AGENTS_WITH_THIN_OAS.has(e.dir),
  );

  it("SCOPED thin-OAS scan: all 4 creation agents are present", () => {
    expect(creationOasFiles.length).toBe(CREATION_AGENTS_WITH_THIN_OAS.size);
  });

  it("SCOPED thin-OAS scan: whitelist anti-creep — at most 8 creation agents", () => {
    expect(CREATION_AGENTS_WITH_THIN_OAS.size).toBeLessThanOrEqual(8);
  });

  for (const { dir, oas } of creationOasFiles) {
    it(`${dir}: no methodology-shaped string field anywhere in OAS exceeds ${SYSTEM_USER_THRESHOLD} chars (thin dispatchers only; methodology in catalog skill)`, () => {
      // Walk the entire OAS tree
      // (depth-limited) and flag any string-valued field whose KEY signals
      // methodology embedding (`system` / `user` / `prompt_template` /
      // `instructions` — case-insensitive), regardless of node type. Still
      // skipped: top-level `description` (legitimate human-readable summary
      // per spec), and any string that's a Jinja-only template (no semantic
      // body beyond `{{ ... }}` placeholders).
      const METHODOLOGY_KEYS = new Set([
        "system",
        "user",
        "prompt_template",
        "prompttemplate",
        "instructions",
      ]);
      const MAX_DEPTH = 12;
      const offenders: Array<{ path: string; len: number; head: string }> = [];

      const isJinjaOnly = (s: string): boolean => {
        // A string is "Jinja-only" when its non-template content is just the
        // surrounding scaffolding (whitespace, label markers, newlines). A
        // thin user template like `packageSlug: {{ packageSlug }}\n...` has
        // <400 chars by length alone, so this is only a safety net for very
        // long pure-template strings.
        return s.replace(/\{\{[\s\S]*?\}\}/g, "").trim().length === 0;
      };

      function walk(node: unknown, p: string, depth: number): void {
        if (depth > MAX_DEPTH) return;
        if (node == null) return;
        if (Array.isArray(node)) {
          node.forEach((v, i) => walk(v, `${p}[${i}]`, depth + 1));
          return;
        }
        if (typeof node !== "object") return;
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          const childPath = p ? `${p}.${k}` : k;
          if (typeof v === "string") {
            const keyLower = k.toLowerCase();
            if (
              METHODOLOGY_KEYS.has(keyLower) &&
              v.length > SYSTEM_USER_THRESHOLD &&
              !isJinjaOnly(v)
            ) {
              offenders.push({
                path: childPath,
                len: v.length,
                head: v.slice(0, 80),
              });
            }
          } else {
            walk(v, childPath, depth + 1);
          }
        }
      }
      walk(oas, "", 0);
      // Diagnose offenders inline for fast debugging on regression.
      if (offenders.length > 0) {
        const summary = offenders
          .map((o) => `  ${o.path} (${o.len} chars): "${o.head}…"`)
          .join("\n");
        throw new Error(
          `OAS skill-free invariant: ${dir} has methodology-shaped string > ${SYSTEM_USER_THRESHOLD} chars:\n${summary}`,
        );
      }
      expect(offenders).toHaveLength(0);
    });
  }
});
