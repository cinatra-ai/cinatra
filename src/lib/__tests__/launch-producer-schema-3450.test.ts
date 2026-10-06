// THE LAUNCH PRODUCER'S THREE STATEMENTS (cinatra#3450, epic #3248).
//
// The issue's expectation: "every run started through a product road —
// including a child run started from a parked run's step — writes its trigger
// record, so the run's page and the record name what started it". The mechanism
// it named cannot be the fix (the ABSENCE of an `agent_run_triggers` row is the
// shipped signal for "no schedule chosen yet", read by the setup-to-trigger
// hand-off, the finished-run notice and the trigger gate), so what the run
// records is WHAT STARTED IT, on the run itself, and the trigger record keeps
// meaning "a schedule was chosen".
//
// A bootstrap half alone is not an upgrade: an already-running instance never
// re-runs the bootstrap DDL, so the fresh install and every deployed instance
// would disagree about the column. There are therefore THREE copies of the
// statement — the bootstrap half, the drizzle declaration and the migration —
// and this suite is what keeps them from drifting. They are literals rather
// than one shared builder for the same reason the `launch_scope_anchor` twin
// gives: a new leaf module would enter four LOCKED route graphs (every route
// reaches the store's DDL owner) whose module counts may only ever shrink; the
// suite carries the guarantee the builder would have.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const MANIFEST_DIR = "migrations/manifest.d";
const MIGRATION = "migrations/core/core__0107_run-launch-producer.mjs";
const FRAGMENT = "migrations/manifest.d/core__0107_run-launch-producer.json";

describe("the fresh-install halves", () => {
  it("adds the column to agent_runs, additively and idempotently", () => {
    expect(read("src/lib/drizzle-store.ts")).toContain(
      `."agent_runs" ADD COLUMN IF NOT EXISTS launch_producer text`,
    );
  });

  it("declares the drizzle column on agent_runs", () => {
    expect(read("packages/agents/src/schema.ts")).toContain(
      `launchProducer: text("launch_producer")`,
    );
  });

  it("surfaces the column onto the run record, AS STORED", () => {
    expect(read("packages/agents/src/agent-run-serde.ts")).toContain(
      "launchProducer: row.launchProducer ?? null,",
    );
  });
});

describe("the operator-upgrade half", () => {
  // Read INSIDE each arm rather than at describe scope: a missing module is
  // then the reading of the arm that needed it, and not a collection failure
  // that says nothing about which guarantee is unmet.
  const sql = () => read(MIGRATION);

  it("carries the SAME statement the bootstrap half carries", () => {
    expect(sql()).toContain(
      "ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS launch_producer text",
    );
  });

  it("is additive — it invents no origin for a run that never recorded one", () => {
    // There is deliberately no backfill: inferring what started a run nobody
    // recorded would be recording a start nobody made. That is also why
    // nothing here is ever set NOT NULL.
    expect(sql()).not.toMatch(/\bUPDATE\s+agent_runs\b/);
    expect(sql()).not.toMatch(/SET NOT NULL/);
  });

  it("narrows back on the way down", () => {
    expect(sql()).toContain("DROP COLUMN IF EXISTS launch_producer");
  });

  it("writes no trigger record — the absence of one still means 'no schedule chosen yet'", () => {
    // The mechanism the issue named, refused HERE as well as in the product
    // code: a row written at launch would skip the schedule step for everyone.
    // The module NAMES that table in its reasoning, which is the point of the
    // reasoning; what it must not do is touch it, so the read is over statements
    // and not over prose.
    expect(sql()).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE)\s+"?agent_run_triggers"?/i,
    );
  });

  it("is declared in the manifest over the one table it touches", () => {
    const fragment = JSON.parse(read(FRAGMENT)) as {
      seq: string;
      file: string;
      destructive: boolean;
      tables: string[];
    };
    expect(fragment.file).toBe(`core/${basename(MIGRATION)}`);
    expect(basename(MIGRATION)).toContain(`core__${fragment.seq}_`);
    expect(fragment.destructive).toBe(false);
    expect([...fragment.tables].sort()).toEqual(["agent_runs"]);
  });

  it("claims a sequence number NO shipped migration already holds", () => {
    // A sequence number is claimed at MERGE, not at authoring: a migration that
    // reaches the default branch first takes the number, and a second module
    // re-using it fails the runner's duplicate-seq preflight at boot — the
    // ledger never dedupes. NOT-ALREADY-TAKEN, never HIGHEST (cinatra#3029):
    // the ledger is append-only by construction, so a highest-number read would
    // fail for whichever migration merged next. A gap is allowed, and this
    // module sits above one on purpose — the number below it is claimed by an
    // open change that would collide at merge.
    const fragments = readdirSync(join(ROOT, MANIFEST_DIR))
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({
        name,
        seq: (JSON.parse(read(join(MANIFEST_DIR, name))) as { seq: string }).seq,
      }));
    const fragment = JSON.parse(read(FRAGMENT)) as { seq: string };
    const others = fragments.filter((entry) => entry.name !== basename(FRAGMENT));
    expect(others.map((entry) => entry.seq)).not.toContain(fragment.seq);

    // NO number in the ledger is claimed twice, by anyone.
    const claimants = new Map<string, string[]>();
    for (const entry of fragments) {
      claimants.set(entry.seq, [...(claimants.get(entry.seq) ?? []), entry.name]);
    }
    expect([...claimants].filter(([, names]) => names.length > 1)).toEqual([]);

    // And a renumber renames BOTH halves of a pair: every fragment's file name
    // states the number the fragment claims, so half a renumber — the JSON
    // moved and the module left behind, or the reverse — cannot pass for a
    // whole one.
    for (const entry of fragments) {
      expect(entry.name).toContain(`core__${entry.seq}_`);
    }
  });
});

describe("the run-creation primitives stamp it, once, and never again", () => {
  const store = read("packages/agents/src/store.ts");

  it("writes the producer on BOTH creation paths, beside the launch anchor", () => {
    const stamps = store.match(/launchProducer: input\.launchProducer \?\? null,/g);
    expect(stamps?.length).toBe(2);
  });

  it("takes the producer as an INPUT — the launch fence decides it, not the store", () => {
    expect(store).toContain("launchProducer?: string | null;");
  });

  it("never UPDATES it — what started a run cannot be rewritten after the fact", () => {
    // Written ONCE at creation from the key the fence received, never inferred
    // from another column, never backfilled and never updated. Every mention in
    // the module is therefore either a type declaration or one of the two
    // creation stamps; the run-update helpers use explicit column whitelists
    // and this column is on none of them.
    const mentions = store.match(/launchProducer\??:[^\n]*/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) {
      expect(
        mention.startsWith("launchProducer: string | null;") ||
          mention.startsWith("launchProducer?: string | null;") ||
          mention.startsWith("launchProducer: input.launchProducer ?? null,"),
      ).toBe(true);
    }
    // EXHAUSTIVE, because the reading above is over DECLARATIONS and an update
    // declares nothing: a shorthand `.set({ launchProducer })` on an update
    // helper, or a new entry on a column whitelist, carries no colon after the
    // name and would slip straight past it. Strike the two forms this column is
    // allowed to appear in as CODE, and every mention left must be prose.
    const residue = store
      .replaceAll("launchProducer?: string | null;", "")
      .replaceAll("launchProducer: input.launchProducer ?? null,", "");
    for (const line of residue.split("\n")) {
      const named = line.indexOf("launchProducer");
      if (named === -1) continue;
      const comment = line.indexOf("//");
      expect(comment >= 0 && comment < named).toBe(true);
    }
    // The store names the drizzle field and never the raw column, so no
    // hand-written SQL can reach it either.
    expect(store).not.toContain("launch_producer");
  });
});
