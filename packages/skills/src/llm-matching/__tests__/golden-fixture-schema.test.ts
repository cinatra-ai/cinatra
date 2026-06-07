/**
 * Schema validation for the labelled golden-eval fixture.
 *
 * This is the OFFLINE half of the eval pipeline. It runs in the unit suite
 * on every CI invocation (no `OPENAI_API_KEY` required) and asserts that
 * `__fixtures__/golden-matches.jsonl` is structurally valid:
 *
 *   1. Every line parses as JSON (one object per line).
 *   2. Every row matches the `GoldenMatchRow` Zod schema below -- same shape
 *      as `AgentForMatching` + `SkillForMatching` + a labelled `expected*`
 *      pair documented in `__fixtures__/README.md`.
 *   3. Every `id` is unique (cross-row invariant -- Zod can't catch this).
 *   4. The total row count is exactly 20 (the locked fixture size).
 *
 * The live eval (`golden-eval.live.test.ts`) re-uses this same Zod schema to
 * deserialise rows before calling OpenAI; if the schema invariant breaks here
 * it ALSO breaks the paid live run, so we fail-fast on parse errors before
 * any provider tokens are spent.
 *
 * --- WHY THIS LIVES NEXT TO THE FIXTURE ------------------------------------
 *
 * Per `__fixtures__/README.md` the JSONL format lets reviewers `git diff`
 * individual labels without merge conflicts AND lets a malformed line fail
 * ONE row instead of the whole fixture. This test enforces the second half of
 * that contract: a single-row break is reported as a single-row failure
 * (line N), not as "fixture won't parse".
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GoldenMatchRowSchema,
  type GoldenMatchRow,
} from "./__fixtures__/golden-fixture-schema";

const FIXTURE_PATH = resolve(
  __dirname,
  "__fixtures__",
  "golden-matches.jsonl",
);

function loadRawLines(): { line: string; lineNumber: number }[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const lines = raw.split("\n");
  return lines
    .map((line, idx) => ({ line: line.trim(), lineNumber: idx + 1 }))
    .filter((entry) => entry.line.length > 0);
}

describe("golden-matches.jsonl -- schema validation (offline, runs every CI)", () => {
  it("loads the fixture file from disk", () => {
    const entries = loadRawLines();
    expect(entries.length).toBeGreaterThan(0);
  });

  it("contains exactly 20 rows (locked fixture size)", () => {
    const entries = loadRawLines();
    expect(entries.length).toBe(20);
  });

  it("every line is valid JSON", () => {
    const entries = loadRawLines();
    for (const { line, lineNumber } of entries) {
      try {
        JSON.parse(line);
      } catch (err) {
        throw new Error(
          `golden-matches.jsonl line ${lineNumber} is not valid JSON: ${
            (err as Error).message
          }`,
        );
      }
    }
  });

  it("every row matches the GoldenMatchRow Zod schema", () => {
    const entries = loadRawLines();
    for (const { line, lineNumber } of entries) {
      const parsed = JSON.parse(line);
      const result = GoldenMatchRowSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `golden-matches.jsonl line ${lineNumber} (id=${
            parsed.id ?? "<missing>"
          }) failed schema: ${result.error.message}`,
        );
      }
    }
  });

  it("every row id is unique", () => {
    const entries = loadRawLines();
    const ids = entries.map(({ line }) => JSON.parse(line).id as string);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(entries.length);
  });

  it("rule-short-circuit rows have a non-empty matchWhenRaw", () => {
    // Cross-field invariant Zod cannot enforce: rule-category rows MUST carry
    // a match_when block (otherwise the rule short-circuit is a tautology and
    // the row exercises the wrong path).
    const entries = loadRawLines();
    for (const { line, lineNumber } of entries) {
      const parsed = JSON.parse(line) as GoldenMatchRow;
      if (
        parsed.category === "rule-short-circuit" ||
        parsed.category === "rule-fallthrough-to-llm"
      ) {
        if (!parsed.skill.matchWhenRaw || parsed.skill.matchWhenRaw.trim().length === 0) {
          throw new Error(
            `golden-matches.jsonl line ${lineNumber} (id=${parsed.id}, category=${parsed.category}) requires a non-empty skill.matchWhenRaw`,
          );
        }
      }
    }
  });

  it("rule-short-circuit rows have expectedSource='rule'; everything else has expectedSource='llm'", () => {
    const entries = loadRawLines();
    for (const { line, lineNumber } of entries) {
      const parsed = JSON.parse(line) as GoldenMatchRow;
      const expected = parsed.category === "rule-short-circuit" ? "rule" : "llm";
      if (parsed.expectedSource !== expected) {
        throw new Error(
          `golden-matches.jsonl line ${lineNumber} (id=${parsed.id}, category=${parsed.category}) expected expectedSource='${expected}' but got '${parsed.expectedSource}'`,
        );
      }
    }
  });

  it("category coverage matches the README count table (5 / 5 / 5 / 3 / 2)", () => {
    const entries = loadRawLines();
    const counts: Record<string, number> = {};
    for (const { line } of entries) {
      const parsed = JSON.parse(line) as GoldenMatchRow;
      counts[parsed.category] = (counts[parsed.category] ?? 0) + 1;
    }
    expect(counts).toEqual({
      "obvious-match": 5,
      "obvious-no-match": 5,
      "borderline": 5,
      "rule-short-circuit": 3,
      "rule-fallthrough-to-llm": 2,
    });
  });
});
