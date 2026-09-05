// The launch anchor's THREE STATEMENTS (cinatra#2809, per-scope surfaces S3).
//
// The issue's sentence: "The immutable `launch_scope_anchor` lives on
// `agent_runs` and `assistant_threads`, stamped from the exact launch route by
// SCOPED launches; composed/recurring descendants inherit the parent's anchor;
// headless/A2A/global writers explicitly persist NO anchor; no inference from
// other columns, no backfill."
//
// A bootstrap half alone is not an upgrade: an already-running instance never
// re-runs the bootstrap DDL, so the fresh install and every deployed instance
// would disagree about the column. There are therefore THREE copies of the
// statement — the two bootstrap halves and the migration — and this suite is
// what keeps them from drifting. They are literals rather than one shared
// builder because a new leaf module would enter four LOCKED route graphs
// (every route reaches the store's DDL owner) whose module counts may only ever
// shrink; the suite carries the guarantee the builder would have.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const MIGRATION = "migrations/core/core__0101_launch-scope-anchor.mjs";
const FRAGMENT = "migrations/manifest.d/core__0101_launch-scope-anchor.json";

describe("the two bootstrap halves", () => {
  it("adds the column to agent_runs, additively and idempotently", () => {
    expect(read("src/lib/drizzle-store.ts")).toContain(
      `."agent_runs" ADD COLUMN IF NOT EXISTS launch_scope_anchor jsonb`,
    );
  });

  it("adds the twin to assistant_threads", () => {
    expect(read("src/lib/assistant-thread-schema.ts")).toContain(
      `."assistant_threads" ADD COLUMN IF NOT EXISTS launch_scope_anchor jsonb`,
    );
  });

  it("declares the drizzle column on agent_runs", () => {
    expect(read("packages/agents/src/schema.ts")).toContain(
      `launchScopeAnchor: jsonb("launch_scope_anchor")`,
    );
  });

  it("surfaces the column onto the run record, AS STORED", () => {
    expect(read("packages/agents/src/agent-run-serde.ts")).toContain(
      "launchScopeAnchor: row.launchScopeAnchor ?? null,",
    );
  });
});

describe("the operator-upgrade half", () => {
  const sql = read(MIGRATION);

  it("carries the SAME two statements the bootstrap halves carry", () => {
    expect(sql).toContain("ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS launch_scope_anchor jsonb");
    expect(sql).toContain(
      "ALTER TABLE assistant_threads ADD COLUMN IF NOT EXISTS launch_scope_anchor jsonb",
    );
  });

  it("is additive — it invents no home for a row that never recorded one", () => {
    expect(sql).not.toMatch(/\bUPDATE\s+agent_runs\b/);
    expect(sql).not.toMatch(/\bUPDATE\s+assistant_threads\b/);
    expect(sql).not.toMatch(/SET NOT NULL/);
  });

  it("narrows back on the way down", () => {
    expect(sql).toContain("DROP COLUMN IF EXISTS launch_scope_anchor");
  });

  it("is declared in the manifest at seq 0101, over the two tables it touches", () => {
    const fragment = JSON.parse(read(FRAGMENT)) as {
      seq: string;
      file: string;
      destructive: boolean;
      tables: string[];
    };
    expect(fragment.seq).toBe("0101");
    expect(fragment.file).toBe("core/core__0101_launch-scope-anchor.mjs");
    expect(fragment.destructive).toBe(false);
    expect([...fragment.tables].sort()).toEqual(["agent_runs", "assistant_threads"]);
  });
});

describe("the run-creation primitives stamp it", () => {
  const store = read("packages/agents/src/store.ts");

  it("writes the anchor on BOTH creation paths, beside the scope snapshot", () => {
    const stamps = store.match(/launchScopeAnchor: input\.launchScopeAnchor \?\? null,/g);
    expect(stamps?.length).toBe(2);
  });

  it("takes the anchor as an INPUT — the launch route decides it, not the store", () => {
    expect(store).toContain("launchScopeAnchor?: unknown;");
  });

  it("never DERIVES it — no column of the create input is consulted for a home", () => {
    // The store neither mints nor decodes: it persists what the launching
    // route decided, and every stamp reads that one field and nothing else.
    expect(store).not.toContain("buildLaunchScopeAnchor(");
    expect(store).not.toContain("parseLaunchScopeAnchor(");
    for (const stamp of store.match(/launchScopeAnchor: [^,]+,/g) ?? []) {
      expect(stamp).toBe("launchScopeAnchor: input.launchScopeAnchor ?? null,");
    }
  });

  it("keeps the immutability guard with the rule, not in a comment", () => {
    expect(read("src/lib/launch-scope-anchor.ts")).toContain(
      "assertLaunchScopeAnchorNotMutated",
    );
  });
});

describe("the launch fence threads it", () => {
  const coordinator = read("packages/agents/src/lifecycle-coordinator.ts");

  it("carries the anchor on the ONE launch input every producer goes through", () => {
    expect(coordinator).toContain("launchScopeAnchor?: unknown;");
    const passes = coordinator.match(/launchScopeAnchor: input\.launchScopeAnchor \?\? null,/g);
    expect(passes?.length).toBe(2);
  });
});

describe("the instance surface decides the canonical home", () => {
  const screens = read("packages/agents/src/instance-screens.tsx");

  it("decides it AFTER the access door and BEFORE any instance content", () => {
    const door = screens.indexOf("run = await readAgentRunById(instanceId, setupActor, setupRoles);");
    const redirectAt = screens.indexOf("if (home) redirect(home);");
    expect(door).toBeGreaterThan(0);
    expect(redirectAt).toBeGreaterThan(door);
  });

  it("routes the post-create redirect through the path helper, never a hand-written route", () => {
    expect(screens).toContain("buildAgentInstancePath(agentId, encodeURIComponent(result.runId)");
    expect(screens).not.toContain("redirect(`/agents/${agentId}/${encodeURIComponent(result.runId)}`)");
  });

  it("asks the anchor module for the home, and the path pair for the verdict", () => {
    expect(screens).toContain("canonicalRunPath({");
    expect(screens).toContain("homeRedirectFor(");
  });
});
