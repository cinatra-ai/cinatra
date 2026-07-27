import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * HARD INVARIANT regression test.
 *
 * SURVIVING invariant (universal): an OAS never carries a `skillIds` /
 * `skill_ids` field. Skills are resolved by the skills layer, never named in
 * `oas.json`.
 *
 * REVERSED invariant (cinatra#2090, epic #2086 S3): this file used to also
 * require the four creation agents to keep a THIN OAS, because their
 * methodology had been lifted into per-agent catalog skills that shipped
 * INSIDE the agent extension. The separation rule reverses that direction by
 * ratified decision: a non-skill extension must not ship a skill bundle at
 * all, and an agent's own self-instruction is configuration, not a shareable
 * skill — so it belongs in the agent's OAS prompt. The scoped check below is
 * inverted accordingly: those four agents must now carry their methodology
 * INLINE, so a regression that pushes it back into a bundled SKILL.md fails
 * here (and, independently, at the skill-packaging gate's
 * SKILL.md-in-a-non-skill-package ban).
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const EXT_DIR = path.join(REPO_ROOT, "extensions/cinatra-ai");
const SYSTEM_USER_THRESHOLD = 400; // chars — a thin dispatcher fits; a methodology body does not.

/**
 * The 4 creation agents whose methodology cinatra#2090 folded OUT of a bundled
 * skill and INTO their own OAS prompt configuration. Each must carry a
 * methodology-sized `system` body; a thin OAS here means the methodology went
 * back into a bundle (the exact regression S3 removed).
 *
 * The `no-skillIds anywhere` check applies to EVERY OAS — no scoping —
 * because that rule is universal.
 */
const CREATION_AGENTS_WITH_INLINE_METHODOLOGY = new Set([
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

  // SCOPED inline-methodology check (cinatra#2090) — applies only to the 4
  // creation agents whose bundled methodology skill was folded into their OAS.
  const creationOasFiles = broadOasFiles.filter((e) =>
    CREATION_AGENTS_WITH_INLINE_METHODOLOGY.has(e.dir),
  );

  it("SCOPED inline-methodology scan: all 4 creation agents are present", () => {
    expect(creationOasFiles.length).toBe(CREATION_AGENTS_WITH_INLINE_METHODOLOGY.size);
  });

  it("SCOPED inline-methodology scan: whitelist anti-creep — at most 8 creation agents", () => {
    expect(CREATION_AGENTS_WITH_INLINE_METHODOLOGY.size).toBeLessThanOrEqual(8);
  });

  for (const { dir, oas } of creationOasFiles) {
    it(`${dir}: carries its methodology INLINE in OAS (> ${SYSTEM_USER_THRESHOLD} chars) — not in a bundled skill`, () => {
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
      if (offenders.length === 0) {
        throw new Error(
          `OAS inline-methodology invariant: ${dir} has NO methodology-shaped string > ` +
            `${SYSTEM_USER_THRESHOLD} chars. Since cinatra#2090 an agent's own ` +
            `self-instruction lives in its OAS prompt, not in a bundled SKILL.md — a thin ` +
            `OAS here means the methodology moved back into a skill bundle.`,
        );
      }
      expect(offenders.length).toBeGreaterThan(0);
    });
  }
});
