// `agent_assigned_skills` store primitives (cinatra#2346 S1, epic #2345).
//
// Drives the REAL SQL through an injected query double, so the ORDER of the
// statements — advisory lock BEFORE the count, count BEFORE the insert — is
// asserted rather than assumed. The behavioral proof against a real Postgres
// (including the concurrent-insert race at the cap boundary) lives in
// `integration/agent-assigned-skills.integration.test.ts`.
import { describe, expect, it, vi } from "vitest";

import {
  AGENT_ASSIGNED_SKILLS_CAP,
  deleteAssignedSkill,
  insertAssignedSkill,
  readAssignedSkillsForAgentPackage,
  type AssignedSkillsQuery,
} from "@/lib/agent-assigned-skills-store";

type Call = { text: string; values: unknown[] };

/** A query double that answers by matching the statement it is given. */
function makeQuery(answers: {
  existing?: unknown[];
  count?: number;
  inserted?: unknown[];
  winner?: unknown[];
}) {
  const calls: Call[] = [];
  const query: AssignedSkillsQuery = async (text, values) => {
    calls.push({ text, values: values ? [...values] : [] });
    if (text.includes("pg_advisory_xact_lock")) return [{ pg_advisory_xact_lock: "" }] as never;
    if (text.includes("count(*)")) return [{ n: answers.count ?? 0 }] as never;
    if (text.startsWith("INSERT")) return (answers.inserted ?? []) as never;
    if (text.startsWith("DELETE")) return (answers.inserted ?? []) as never;
    // The two SELECTs (pre-insert existing / post-conflict winner) are the same
    // statement; the first answers `existing`, a later one answers `winner`.
    const selectsSoFar = calls.filter((c) => c.text.trim().startsWith("SELECT agent_package_name")).length;
    if (selectsSoFar === 1) return (answers.existing ?? []) as never;
    return (answers.winner ?? answers.existing ?? []) as never;
  };
  return { query, calls };
}

const row = (patch: Record<string, unknown> = {}) => ({
  agent_package_name: "@cinatra-ai/web-scrape-agent",
  skill_id: "@x/y:z",
  // The scope tuple (cinatra#2813 S1). A caller with no scope of its own writes
  // the WORKSPACE tier, which is exactly what package-global assignment meant.
  scope_kind: "workspace",
  scope_id: "__workspace__",
  source: "manual",
  origin_run_id: null,
  position: 1,
  created_by: "admin_1",
  created_at: new Date("2026-08-03T10:00:00.000Z"),
  ...patch,
});

describe("insertAssignedSkill — lock ordering", () => {
  it("takes the per-agent ADVISORY LOCK before it counts or inserts", async () => {
    const { query, calls } = makeQuery({ count: 0, inserted: [row()] });
    await insertAssignedSkill(
      { agentPackageName: "@cinatra-ai/web-scrape-agent", skillId: "@x/y:z", createdBy: "admin_1" },
      { query },
    );
    const kinds = calls.map((c) =>
      c.text.includes("pg_advisory_xact_lock")
        ? "lock"
        : c.text.includes("count(*)")
          ? "count"
          : c.text.trim().startsWith("INSERT")
            ? "insert"
            : "select",
    );
    expect(kinds[0]).toBe("lock");
    expect(kinds.indexOf("count")).toBeGreaterThan(0);
    expect(kinds.indexOf("insert")).toBeGreaterThan(kinds.indexOf("count"));
  });

  it("namespaces the advisory-lock key so it cannot collide with another subsystem", async () => {
    const { query, calls } = makeQuery({ count: 0, inserted: [row()] });
    await insertAssignedSkill(
      { agentPackageName: "@cinatra-ai/web-scrape-agent", skillId: "@x/y:z", createdBy: "admin_1" },
      { query },
    );
    // ONE composed key, built by the shared scope module, so the skills store
    // and the context store cannot drift on what "one scope" means.
    expect(calls[0]!.text).toContain("pg_advisory_xact_lock(hashtextextended($1, 0))");
    const key = String(calls[0]!.values[0]);
    expect(key).toContain("agent_assigned_skills");
    expect(key).toContain("@cinatra-ai/web-scrape-agent");
    expect(key).toContain("workspace");
  });

  it("runs everything inside ONE transaction (the xact lock is transaction-scoped)", async () => {
    const seen: string[] = [];
    const { query } = makeQuery({ count: 0, inserted: [row()] });
    const transaction = vi.fn(async (fn: (q: typeof query) => Promise<unknown>) => {
      seen.push("begin");
      const out = await fn(query);
      seen.push("commit");
      return out;
    });
    await insertAssignedSkill(
      { agentPackageName: "@a/b", skillId: "@x/y:z", createdBy: "admin_1" },
      { query, transaction: transaction as never },
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["begin", "commit"]);
  });
});

describe("insertAssignedSkill — the cap", () => {
  it(`REFUSES at the cap of ${AGENT_ASSIGNED_SKILLS_CAP} without issuing an INSERT`, async () => {
    const { query, calls } = makeQuery({ count: AGENT_ASSIGNED_SKILLS_CAP });
    const out = await insertAssignedSkill(
      { agentPackageName: "@a/b", skillId: "@x/y:z", createdBy: "admin_1" },
      { query },
    );
    expect(out).toEqual({ outcome: "cap_exceeded", count: AGENT_ASSIGNED_SKILLS_CAP });
    expect(calls.some((c) => c.text.trim().startsWith("INSERT"))).toBe(false);
  });

  it("REFUSES above the cap too (a pre-existing over-cap state cannot grow)", async () => {
    const { query } = makeQuery({ count: AGENT_ASSIGNED_SKILLS_CAP + 2 });
    await expect(
      insertAssignedSkill(
        { agentPackageName: "@a/b", skillId: "@x/y:z", createdBy: "admin_1" },
        { query },
      ),
    ).resolves.toMatchObject({ outcome: "cap_exceeded" });
  });

  it("admits the last slot below the cap", async () => {
    const { query } = makeQuery({
      count: AGENT_ASSIGNED_SKILLS_CAP - 1,
      inserted: [row({ position: AGENT_ASSIGNED_SKILLS_CAP })],
    });
    const out = await insertAssignedSkill(
      { agentPackageName: "@a/b", skillId: "@x/y:z", createdBy: "admin_1" },
      { query },
    );
    expect(out).toMatchObject({ outcome: "assigned" });
    expect(out.outcome === "assigned" && out.row.position).toBe(AGENT_ASSIGNED_SKILLS_CAP);
  });

  it("an ALREADY-ASSIGNED pair short-circuits BEFORE the cap check (no slot consumed)", async () => {
    const { query, calls } = makeQuery({ existing: [row({ position: 2 })], count: 99 });
    const out = await insertAssignedSkill(
      { agentPackageName: "@cinatra-ai/web-scrape-agent", skillId: "@x/y:z", createdBy: "admin_1" },
      { query },
    );
    expect(out).toMatchObject({ outcome: "already_assigned" });
    expect(out.outcome === "already_assigned" && out.row.position).toBe(2);
    expect(calls.some((c) => c.text.includes("count(*)"))).toBe(false);
    expect(calls.some((c) => c.text.trim().startsWith("INSERT"))).toBe(false);
  });
});

describe("insertAssignedSkill — position + arbiter", () => {
  it("computes the next position IN SQL, in the same statement as the insert", async () => {
    const { query, calls } = makeQuery({ count: 1, inserted: [row({ position: 2 })] });
    await insertAssignedSkill(
      { agentPackageName: "@a/b", skillId: "@x/y:z", createdBy: "admin_1" },
      { query },
    );
    const insert = calls.find((c) => c.text.trim().startsWith("INSERT"))!;
    expect(insert.text).toContain('COALESCE(MAX("position"), 0) + 1');
    // Never a client-computed position: the value cannot drift between the read
    // and the write.
    expect(insert.values).toEqual([
      "@a/b",
      "@x/y:z",
      "workspace",
      "__workspace__",
      "manual",
      null,
      "admin_1",
    ]);
  });

  it("uses the PK as the conflict arbiter and re-selects the winner on DO NOTHING", async () => {
    const { query, calls } = makeQuery({
      count: 0,
      inserted: [],
      winner: [row({ position: 3, created_by: "someone_else" })],
    });
    const out = await insertAssignedSkill(
      { agentPackageName: "@a/b", skillId: "@x/y:z", createdBy: "admin_1" },
      { query },
    );
    expect(calls.find((c) => c.text.trim().startsWith("INSERT"))!.text).toContain(
      // The arbiter is the FULL tuple key: two scopes assigning the same skill
      // to the same agent are two rows, not a conflict.
      "ON CONFLICT (agent_package_name, skill_id, scope_kind, scope_id) DO NOTHING",
    );
    expect(out).toMatchObject({ outcome: "already_assigned" });
    expect(out.outcome === "already_assigned" && out.row.createdBy).toBe("someone_else");
  });

  it("THROWS rather than lying when neither the insert nor a winner produced a row", async () => {
    const { query } = makeQuery({ count: 0, inserted: [], winner: [] });
    await expect(
      insertAssignedSkill(
        { agentPackageName: "@a/b", skillId: "@x/y:z", createdBy: "admin_1" },
        { query },
      ),
    ).rejects.toThrow(/no row and no existing row under the advisory lock/);
  });
});

describe("readAssignedSkillsForAgentPackage", () => {
  it("orders by position and is ACTOR-INDEPENDENT (no owner predicate in the SQL)", async () => {
    const calls: Call[] = [];
    const query: AssignedSkillsQuery = async (text, values) => {
      calls.push({ text, values: values ? [...values] : [] });
      return [row({ position: 1 }), row({ skill_id: "@x/y:w", position: 2 })] as never;
    };
    const out = await readAssignedSkillsForAgentPackage("@cinatra-ai/web-scrape-agent", { query });
    expect(out.map((r) => r.position)).toEqual([1, 2]);
    // The package-wide read spans every scope, so the order must be total
    // across scopes as well as within one.
    expect(calls[0]!.text).toContain('ORDER BY scope_kind ASC, scope_id ASC, "position" ASC');
    expect(calls[0]!.values).toEqual(["@cinatra-ai/web-scrape-agent"]);
    for (const forbidden of ["owner_type", "owner_id", "organization_id", "created_by = "]) {
      expect(calls[0]!.text).not.toContain(forbidden);
    }
  });

  it("normalizes the row shape (numeric position, ISO timestamp)", async () => {
    const query: AssignedSkillsQuery = async () =>
      [row({ position: "7", created_at: new Date("2026-08-03T10:00:00.000Z") })] as never;
    const [out] = await readAssignedSkillsForAgentPackage("@a/b", { query });
    expect(out).toEqual({
      agentPackageName: "@cinatra-ai/web-scrape-agent",
      skillId: "@x/y:z",
      scopeKind: "workspace",
      scopeId: "__workspace__",
      source: "manual",
      originRunId: null,
      position: 7,
      createdBy: "admin_1",
      createdAt: "2026-08-03T10:00:00.000Z",
    });
  });

  it("short-circuits an empty agent package without a query", async () => {
    const query = vi.fn();
    await expect(readAssignedSkillsForAgentPackage("", { query: query as never })).resolves.toEqual(
      [],
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe("deleteAssignedSkill", () => {
  it("reports deleted:true when a row went away", async () => {
    const query: AssignedSkillsQuery = async () => [{ skill_id: "@x/y:z" }] as never;
    await expect(
      deleteAssignedSkill({ agentPackageName: "@a/b", skillId: "@x/y:z" }, { query }),
    ).resolves.toEqual({ deleted: true });
  });

  it("is idempotent: deleting what is gone reports deleted:false, never throws", async () => {
    const query: AssignedSkillsQuery = async () => [];
    await expect(
      deleteAssignedSkill({ agentPackageName: "@a/b", skillId: "@x/y:z" }, { query }),
    ).resolves.toEqual({ deleted: false });
  });

  it("scopes the DELETE to the (agent, skill) pair — never a whole-agent wipe", async () => {
    const calls: Call[] = [];
    const query: AssignedSkillsQuery = async (text, values) => {
      calls.push({ text, values: values ? [...values] : [] });
      return [{ skill_id: "@x/y:z" }] as never;
    };
    await deleteAssignedSkill({ agentPackageName: "@a/b", skillId: "@x/y:z" }, { query });
    // The remove identity carries the FULL tuple: removing a project's
    // assignment must not take the organization's with it.
    expect(calls[0]!.text).toContain("WHERE agent_package_name = $1 AND skill_id = $2");
    expect(calls[0]!.text).toContain("scope_kind = $3 AND scope_id = $4");
    expect(calls[0]!.values).toEqual(["@a/b", "@x/y:z", "workspace", "__workspace__"]);
  });
});

describe("schema handling", () => {
  it("uses the injected schema, quoted", async () => {
    const calls: Call[] = [];
    const query: AssignedSkillsQuery = async (text) => {
      calls.push({ text, values: [] });
      return [];
    };
    await readAssignedSkillsForAgentPackage("@a/b", { query, schema: 'we"ird' });
    expect(calls[0]!.text).toContain('"we""ird"."agent_assigned_skills"');
  });
});

// ---------------------------------------------------------------------------
// LIFECYCLE TEARDOWN primitives (cinatra#2350 S5).
// ---------------------------------------------------------------------------

import {
  deleteAssignedSkillsForAgentPackage,
  deleteAssignedSkillsForSkillIds,
} from "@/lib/agent-assigned-skills-store";

describe("deleteAssignedSkillsForSkillIds — the SKILL-side sweep", () => {
  it("deletes by the exact id SET across every agent, and reports the removed pairs", async () => {
    const calls: Call[] = [];
    const query: AssignedSkillsQuery = async (text, values) => {
      calls.push({ text, values: values ? [...values] : [] });
      return [
        { agent_package_name: "@cinatra-ai/web-scrape-agent", skill_id: "@x/y:a" },
        { agent_package_name: "@cinatra-ai/blog-pipeline-agent", skill_id: "@x/y:b" },
      ] as never;
    };
    const out = await deleteAssignedSkillsForSkillIds(["@x/y:a", "@x/y:b"], { query });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("DELETE FROM");
    // ANY over a text[] — one statement, not one per id, so the sweep is atomic
    // with respect to a concurrent reader.
    expect(calls[0]!.text).toContain("skill_id = ANY($1::text[])");
    expect(calls[0]!.text).toContain("RETURNING agent_package_name, skill_id");
    expect(calls[0]!.values).toEqual([["@x/y:a", "@x/y:b"]]);
    expect(out.removed).toEqual([
      { agentPackageName: "@cinatra-ai/web-scrape-agent", skillId: "@x/y:a" },
      { agentPackageName: "@cinatra-ai/blog-pipeline-agent", skillId: "@x/y:b" },
    ]);
  });

  it("DEDUPES and drops empty ids before issuing the statement", async () => {
    const calls: Call[] = [];
    const query: AssignedSkillsQuery = async (text, values) => {
      calls.push({ text, values: values ? [...values] : [] });
      return [] as never;
    };
    await deleteAssignedSkillsForSkillIds(["@x/y:a", "@x/y:a", "", "@x/y:b"], { query });
    expect(calls[0]!.values).toEqual([["@x/y:a", "@x/y:b"]]);
  });

  it("issues NO statement for an empty id list", async () => {
    const query = vi.fn(async () => [] as never);
    const out = await deleteAssignedSkillsForSkillIds([], { query });
    expect(query).not.toHaveBeenCalled();
    expect(out).toEqual({ removed: [] });
  });

  it("is idempotent — a second sweep removes nothing and says so", async () => {
    let first = true;
    const query: AssignedSkillsQuery = async () => {
      if (first) {
        first = false;
        return [{ agent_package_name: "@a/b", skill_id: "@x/y:a" }] as never;
      }
      return [] as never;
    };
    expect((await deleteAssignedSkillsForSkillIds(["@x/y:a"], { query })).removed).toHaveLength(1);
    expect((await deleteAssignedSkillsForSkillIds(["@x/y:a"], { query })).removed).toEqual([]);
  });
});

describe("deleteAssignedSkillsForAgentPackage — the AGENT-side sweep", () => {
  it("deletes every row for the agent package and reports the removed pairs", async () => {
    const calls: Call[] = [];
    const query: AssignedSkillsQuery = async (text, values) => {
      calls.push({ text, values: values ? [...values] : [] });
      return [{ skill_id: "@x/y:a" }, { skill_id: "@x/y:b" }] as never;
    };
    const out = await deleteAssignedSkillsForAgentPackage("@cinatra-ai/web-scrape-agent", { query });

    expect(calls[0]!.text).toContain("WHERE agent_package_name = $1 RETURNING skill_id");
    expect(calls[0]!.values).toEqual(["@cinatra-ai/web-scrape-agent"]);
    expect(out.removed).toEqual([
      { agentPackageName: "@cinatra-ai/web-scrape-agent", skillId: "@x/y:a" },
      { agentPackageName: "@cinatra-ai/web-scrape-agent", skillId: "@x/y:b" },
    ]);
  });

  it("issues NO statement for an empty package name", async () => {
    const query = vi.fn(async () => [] as never);
    expect(await deleteAssignedSkillsForAgentPackage("", { query })).toEqual({ removed: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it("uses the injected schema, quoted", async () => {
    const calls: Call[] = [];
    const query: AssignedSkillsQuery = async (text) => {
      calls.push({ text, values: [] });
      return [] as never;
    };
    await deleteAssignedSkillsForAgentPackage("@a/b", { query, schema: 'we"ird' });
    expect(calls[0]!.text).toContain('"we""ird"."agent_assigned_skills"');
  });
});
