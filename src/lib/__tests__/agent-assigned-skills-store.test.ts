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
  const query = async (text: string, values?: readonly unknown[]) => {
    calls.push({ text, values: values ? [...values] : [] });
    if (text.includes("pg_advisory_xact_lock")) return [{ pg_advisory_xact_lock: "" }];
    if (text.includes("count(*)")) return [{ n: answers.count ?? 0 }];
    if (text.startsWith("INSERT")) return answers.inserted ?? [];
    if (text.startsWith("DELETE")) return answers.inserted ?? [];
    // The two SELECTs (pre-insert existing / post-conflict winner) are the same
    // statement; the first answers `existing`, a later one answers `winner`.
    const selectsSoFar = calls.filter((c) => c.text.trim().startsWith("SELECT agent_package_name")).length;
    if (selectsSoFar === 1) return answers.existing ?? [];
    return answers.winner ?? answers.existing ?? [];
  };
  return { query, calls };
}

const row = (patch: Record<string, unknown> = {}) => ({
  agent_package_name: "@cinatra-ai/web-scrape-agent",
  skill_id: "@x/y:z",
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
    expect(calls[0]!.text).toContain("pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))");
    expect(calls[0]!.values).toEqual(["agent_assigned_skills", "@cinatra-ai/web-scrape-agent"]);
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
    expect(insert.values).toEqual(["@a/b", "@x/y:z", "admin_1"]);
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
      "ON CONFLICT (agent_package_name, skill_id) DO NOTHING",
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
    const query = async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values: values ? [...values] : [] });
      return [row({ position: 1 }), row({ skill_id: "@x/y:w", position: 2 })];
    };
    const out = await readAssignedSkillsForAgentPackage("@cinatra-ai/web-scrape-agent", { query });
    expect(out.map((r) => r.position)).toEqual([1, 2]);
    expect(calls[0]!.text).toContain('ORDER BY "position" ASC');
    expect(calls[0]!.values).toEqual(["@cinatra-ai/web-scrape-agent"]);
    for (const forbidden of ["owner_type", "owner_id", "organization_id", "created_by = "]) {
      expect(calls[0]!.text).not.toContain(forbidden);
    }
  });

  it("normalizes the row shape (numeric position, ISO timestamp)", async () => {
    const query = async () => [row({ position: "7", created_at: new Date("2026-08-03T10:00:00.000Z") })];
    const [out] = await readAssignedSkillsForAgentPackage("@a/b", { query });
    expect(out).toEqual({
      agentPackageName: "@cinatra-ai/web-scrape-agent",
      skillId: "@x/y:z",
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
    const query = async () => [{ skill_id: "@x/y:z" }];
    await expect(
      deleteAssignedSkill({ agentPackageName: "@a/b", skillId: "@x/y:z" }, { query }),
    ).resolves.toEqual({ deleted: true });
  });

  it("is idempotent: deleting what is gone reports deleted:false, never throws", async () => {
    const query = async () => [];
    await expect(
      deleteAssignedSkill({ agentPackageName: "@a/b", skillId: "@x/y:z" }, { query }),
    ).resolves.toEqual({ deleted: false });
  });

  it("scopes the DELETE to the (agent, skill) pair — never a whole-agent wipe", async () => {
    const calls: Call[] = [];
    const query = async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values: values ? [...values] : [] });
      return [{ skill_id: "@x/y:z" }];
    };
    await deleteAssignedSkill({ agentPackageName: "@a/b", skillId: "@x/y:z" }, { query });
    expect(calls[0]!.text).toContain("WHERE agent_package_name = $1 AND skill_id = $2");
    expect(calls[0]!.values).toEqual(["@a/b", "@x/y:z"]);
  });
});

describe("schema handling", () => {
  it("uses the injected schema, quoted", async () => {
    const calls: Call[] = [];
    const query = async (text: string) => {
      calls.push({ text, values: [] });
      return [];
    };
    await readAssignedSkillsForAgentPackage("@a/b", { query, schema: 'we"ird' });
    expect(calls[0]!.text).toContain('"we""ird"."agent_assigned_skills"');
  });
});
