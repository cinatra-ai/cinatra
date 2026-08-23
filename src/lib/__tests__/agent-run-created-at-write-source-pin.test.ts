/**
 * cinatra#2911 — source pin: the INSERT is the only writer of
 * `agent_runs.created_at`.
 *
 * `created_at` is the only record of when a run was REQUESTED. Its insert
 * default (`packages/agents/src/schema.ts`, `.notNull().defaultNow()`) is the
 * one legitimate writer, and the bootstrap DDL's backfill is the one sanctioned
 * exception — it exists for rows that never had a value, so it must narrow on
 * `created_at IS NULL`. An UNGUARDED rewrite is what collapsed a failed run's
 * creation time onto its own end time, and the loss was irreversible.
 *
 * This lockstep scan (same static-scan style as the status-write source pin in
 * packages/agents) asserts that no second writer exists:
 *   - no `.update(agentRuns)` set-chain assigns `createdAt`;
 *   - every raw-SQL `SET created_at` against `agent_runs` — bootstrap DDL,
 *     schema leaves, migrations — carries the `created_at IS NULL` guard.
 *
 * Behavioural proof against a real Postgres lives in
 * `agent-run-created-at-immutable.integration.test.ts`; this one fails the
 * moment a new writer is introduced, whether or not anyone runs that tier.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["src", "packages", "migrations"].map((d) =>
  join(REPO_ROOT, d),
);

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(tsx?|mjs)$/.test(name) && !/\.test\.(tsx?|mjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

const FILES = SCAN_ROOTS.flatMap((r) => walk(r));

/** Strip comments so prose describing the killed pattern can never trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Files whose `.update(agentRuns)` set-chain (everything up to the terminating
 * `.where(`) assigns `createdAt`.
 */
function filesWithInlineCreatedAtSet(sources: Array<[string, string]>): string[] {
  const hits: string[] = [];
  for (const [rel, raw] of sources) {
    const src = stripComments(raw);
    const UPDATE = /\.update\(\s*agentRuns\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = UPDATE.exec(src)) !== null) {
      const start = m.index + m[0].length;
      const whereIdx = src.indexOf(".where(", start);
      const end = whereIdx === -1 ? Math.min(src.length, start + 600) : Math.min(whereIdx, start + 600);
      const slice = src.slice(start, end);
      if (slice.includes(".set(") && /\bcreatedAt\b\s*[:,]/.test(slice)) hits.push(rel);
    }
  }
  return [...new Set(hits)];
}

/**
 * Raw-SQL statements that assign `agent_runs.created_at`. Returned WITH their
 * text so the guard can be asserted rather than the count.
 */
function rawCreatedAtWrites(sources: Array<[string, string]>): Array<[string, string]> {
  const hits: Array<[string, string]> = [];
  for (const [rel, raw] of sources) {
    const src = stripComments(raw);
    for (const line of src.split("\n")) {
      if (!/\bSET\s+created_at\b/i.test(line)) continue;
      if (!/\bagent_runs\b/.test(line) && !/\bagent_runs\b/.test(src)) continue;
      hits.push([rel, line.trim()]);
    }
  }
  return hits;
}

const SOURCES: Array<[string, string]> = FILES.map((f) => [
  f.slice(REPO_ROOT.length + 1),
  readFileSync(f, "utf-8"),
]);

describe("agent_runs.created_at write-source pin (cinatra#2911)", () => {
  it("no drizzle update path assigns createdAt on agentRuns", () => {
    expect(
      filesWithInlineCreatedAtSet(SOURCES),
      "created_at is written ONCE, by the insert default. Route nothing else at it (cinatra#2911).",
    ).toEqual([]);
  });

  it("every raw-SQL created_at write is the guarded backfill", () => {
    const writes = rawCreatedAtWrites(SOURCES);
    // Non-vacuous: the bootstrap leaf and its migration twin are both found.
    expect(writes.length).toBeGreaterThanOrEqual(2);
    const unguarded = writes.filter(([, sql]) => !/created_at IS NULL/i.test(sql));
    expect(
      unguarded,
      "an unguarded created_at rewrite overwrites a value the row already had — narrow it on `created_at IS NULL` (cinatra#2911).",
    ).toEqual([]);
  });

  it("is non-vacuous: a reintroduced writer of either shape IS detected", () => {
    const drizzleOffender = `db.update(agentRuns).set({ createdAt: new Date() }).where(eq(agentRuns.id, id));`;
    expect(filesWithInlineCreatedAtSet([["synthetic.ts", drizzleOffender]])).toEqual([
      "synthetic.ts",
    ]);
    const sqlOffender = `UPDATE "s"."agent_runs" SET created_at = COALESCE(started_at, completed_at, created_at)`;
    const found = rawCreatedAtWrites([["synthetic.sql.ts", sqlOffender]]);
    expect(found).toHaveLength(1);
    expect(/created_at IS NULL/i.test(found[0]![1])).toBe(false);
  });
});
