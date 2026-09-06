/**
 * THE LIVE REVIEW-FLOOR WALK MUST NAME TABLES THIS PRODUCT ACTUALLY HAS
 * (cinatra#3080, acceptance item 9 — "every mutation is proved on the real
 * surface", fix leg 9).
 *
 * `tests/e2e/review-floor/review-floor.spec.ts` is the ONE live proof of the
 * decision floor on the real surfaces: the review page, the run page's review
 * step and the review card in the chat thread. Every one of its tests opens
 * with `openGate()`, and `openGate()` opens with `anyReadableTarget()` — a
 * direct SQL read for an artifact revision to pin. If that read names a table
 * the schema does not declare, Postgres answers `42P01 undefined_table`, the
 * helper throws, and EVERY test in the suite fails inside the harness before it
 * has drawn a single surface. The suite would then report a harness error where
 * the round expected a floor reading, which is exactly the shape of proof this
 * epic refuses: a suite that cannot run proves nothing, and the failure does not
 * name the floor at all.
 *
 * So the spec's own table names are reconciled here, in the node tier, against
 * the product's canonical DDL — no database, no browser, no stack. The canonical
 * inventory is read from the two places that declare it: `buildCreateStoreSchemaQueries`
 * in `src/lib/drizzle-store.ts` (the CREATE TABLE text) and the drizzle table
 * declarations in `packages/agents/src/schema.ts`. Reading the inventory rather
 * than restating it is deliberate: a table renamed in the schema moves this
 * assertion with it instead of leaving a second, staler list to drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");

function read(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

/** Every table the core store's DDL creates, by name. */
function coreStoreTables(): Set<string> {
  const src = read("src/lib/drizzle-store.ts");
  const names = new Set<string>();
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS "\$\{[^}]*\}"\."([a-z_0-9]+)"/g)) {
    names.add(m[1]);
  }
  return names;
}

/** Every table the agents schema declares, by name. */
function agentsSchemaTables(): Set<string> {
  const src = read("packages/agents/src/schema.ts");
  const names = new Set<string>();
  for (const m of src.matchAll(/cinatraSchema\.table\(\s*"([a-z_0-9]+)"/g)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Every table the CONVERSATION store declares (`src/lib/assistant-thread-schema.ts`).
 *
 * Read as a third inventory rather than folded into the two above, because that
 * is where these tables really are: the thread and its turns are created by the
 * conversation schema's own bootstrap list, not by the core store's DDL. The
 * walk seeds a conversation to reach the chat surface, so its names have to be
 * reconcilable against something.
 */
function conversationStoreTables(): Set<string> {
  const src = read("src/lib/assistant-thread-schema.ts");
  const names = new Set<string>();
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS "\$\{[^}]*\}"\."([a-z_0-9]+)"/g)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * The tables the live walk reads, as it writes them (`${SCHEMA}.<table>`) — in
 * the spec AND in the fixture it seeds through.
 *
 * BOTH FILES, because the walk's SQL lives in both and a 42P01 from either one
 * ends the suite the same way: `openGate()` calls into the fixture before a
 * surface is drawn, so a table named wrongly there is as fatal as one named
 * wrongly in the spec, and no browser reading ever happens.
 */
function tablesTheLiveWalkReads(): string[] {
  const names = new Set<string>();
  for (const file of [
    "tests/e2e/review-floor/review-floor.spec.ts",
    "tests/e2e/agents-run/review-gate-fixture.ts",
  ]) {
    for (const m of read(file).matchAll(/\$\{SCHEMA\}\.([a-z_0-9]+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

describe("cinatra#3080 — the live review-floor walk's SQL names real tables", () => {
  it("declares an inventory to reconcile against", () => {
    // A guard on the readers themselves: an inventory that came back empty would
    // make every assertion below vacuously true.
    expect(coreStoreTables().size).toBeGreaterThan(50);
    expect(agentsSchemaTables().size).toBeGreaterThan(20);
    expect(conversationStoreTables().size).toBeGreaterThan(2);
    expect(tablesTheLiveWalkReads().length).toBeGreaterThan(3);
  });

  it("every table the walk queries is declared by the product's own schema", () => {
    const declared = new Set([
      ...coreStoreTables(),
      ...agentsSchemaTables(),
      ...conversationStoreTables(),
    ]);
    const undeclared = tablesTheLiveWalkReads().filter((t) => !declared.has(t));
    expect(
      undeclared,
      "the live walk reads tables this instance does not have — every test in it " +
        "would fail in the harness (42P01) instead of reading the floor",
    ).toEqual([]);
  });

  it("the run page it opens is a route this app actually has", () => {
    const spec = read("tests/e2e/review-floor/review-floor.spec.ts");
    // `/agents/runs/<runId>` is not a route: `src/app/agents` carries the index
    // page, the `[vendor]/[packageName]/[instanceId]` instance route, `reviews`
    // and `executions`. A walk that opens it is served the 404 page, and the
    // missing card then reads as a missing floor.
    // Scoped to the navigation, not the prose: the spec's own comment names the
    // dead route on purpose, so the next reader knows what this replaced.
    expect(spec).not.toMatch(/goto\(`\/agents\/runs\//);
    expect(spec).toMatch(/return `\/agents\/\$\{vendor\}\/\$\{slug\}\/\$\{runId\}`;/);
  });

  it("the pinned target is discovered through the artifact's own representation row", () => {
    const spec = read("tests/e2e/review-floor/review-floor.spec.ts");
    // The representation table keys on `artifact_id` — the artifact's id — not on
    // an `object_id`. Naming the column the other way is the same failure as
    // naming the table the other way: an undefined column, before any surface.
    expect(spec).toMatch(/\$\{SCHEMA\}\.representation r ON r\.artifact_id = o\.id/);
    // Scoped to the SQL, not to the prose: the spec's own comment names the
    // wrong table on purpose, so the next reader knows what this replaced.
    expect(spec).not.toMatch(/\$\{SCHEMA\}\.object_representations/);
  });
});
