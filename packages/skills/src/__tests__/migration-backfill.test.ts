/**
 * Backfill helper: a one-shot Node helper that walks the legacy custom-skill
 * catalog and produces idempotent INSERT statements into custom_skill_assignments.
 *
 * The helper is wired into the migration step for custom skill assignments.
 */
import { describe, it, expect, vi } from "vitest";

import { backfillCustomSkillAssignments } from "@/lib/database";

type CatalogRow = {
  id: string;
  payload: {
    isCustomSkill: boolean;
    ownerUserId: string | null;
    agentId: string | null;
  };
};

const fixture: CatalogRow[] = [
  {
    id: "s1",
    payload: { isCustomSkill: true, ownerUserId: "u1", agentId: "a1" },
  },
  {
    id: "s2",
    payload: { isCustomSkill: false, ownerUserId: "u1", agentId: "a1" },
  },
  {
    id: "s3",
    payload: { isCustomSkill: true, ownerUserId: null, agentId: "a1" },
  },
  {
    id: "s4",
    payload: { isCustomSkill: true, ownerUserId: "u2", agentId: "a2" },
  },
];

describe("backfillCustomSkillAssignments", () => {
  it("emits exactly one INSERT per qualifying (isCustomSkill && ownerUserId && agentId) row", async () => {
    const executeSql = vi.fn(async (..._args: [string, unknown[]]) => undefined);
    const readCatalog = vi.fn(async () => fixture);

    await (backfillCustomSkillAssignments as unknown as (deps: {
      readCatalog: typeof readCatalog;
      executeSql: typeof executeSql;
    }) => Promise<unknown>)({ readCatalog, executeSql });

    const insertCalls = executeSql.mock.calls.filter(([sql]) =>
      /INSERT\s+INTO[^;]*custom_skill_assignments/i.test(String(sql)),
    );
    expect(insertCalls).toHaveLength(2);

    const allArgs = insertCalls.flatMap((c) => (Array.isArray(c[1]) ? c[1] : []));
    expect(allArgs).toEqual(expect.arrayContaining(["s1", "a1", "user", "u1"]));
    expect(allArgs).toEqual(expect.arrayContaining(["s4", "a2", "user", "u2"]));
  });

  it("each INSERT contains ON CONFLICT (skill_id, agent_id) DO NOTHING", async () => {
    const executeSql = vi.fn(async (..._args: [string, unknown[]]) => undefined);
    const readCatalog = vi.fn(async () => fixture);

    await (backfillCustomSkillAssignments as unknown as (deps: {
      readCatalog: typeof readCatalog;
      executeSql: typeof executeSql;
    }) => Promise<unknown>)({ readCatalog, executeSql });

    const insertCalls = executeSql.mock.calls.filter(([sql]) =>
      /INSERT\s+INTO[^;]*custom_skill_assignments/i.test(String(sql)),
    );
    for (const [sql] of insertCalls) {
      expect(String(sql)).toMatch(
        /ON CONFLICT\s*\(\s*skill_id\s*,\s*agent_id\s*\)\s*DO NOTHING/i,
      );
    }
  });

  it("re-running the helper is idempotent at the assertion level (same statements)", async () => {
    const executeSql1 = vi.fn(async (..._args: [string, unknown[]]) => undefined);
    const executeSql2 = vi.fn(async (..._args: [string, unknown[]]) => undefined);
    const readCatalog = vi.fn(async () => fixture);

    await (backfillCustomSkillAssignments as unknown as (deps: {
      readCatalog: typeof readCatalog;
      executeSql: typeof executeSql1;
    }) => Promise<unknown>)({ readCatalog, executeSql: executeSql1 });

    await (backfillCustomSkillAssignments as unknown as (deps: {
      readCatalog: typeof readCatalog;
      executeSql: typeof executeSql2;
    }) => Promise<unknown>)({ readCatalog, executeSql: executeSql2 });

    const sigs1 = executeSql1.mock.calls.map((c) => String(c[0])).sort();
    const sigs2 = executeSql2.mock.calls.map((c) => String(c[0])).sort();
    expect(sigs2).toEqual(sigs1);
  });

  it("accepts a {readCatalog, executeSql} dependency-injection pair", async () => {
    // Just asserts the signature shape: implementation must accept these deps.
    const executeSql = vi.fn(async (..._args: [string, unknown[]]) => undefined);
    const readCatalog = vi.fn(async () => [] as CatalogRow[]);
    await expect(
      (backfillCustomSkillAssignments as unknown as (deps: {
        readCatalog: typeof readCatalog;
        executeSql: typeof executeSql;
      }) => Promise<unknown>)({ readCatalog, executeSql }),
    ).resolves.not.toThrow();
    expect(readCatalog).toHaveBeenCalled();
  });
});
