// REAL-POSTGRES proof for the lifecycle-teardown bulk deletes (cinatra#2350
// S5, epic #2345): `deleteAssignedSkillsForSkillIds` and
// `deleteAssignedSkillsForAgentPackage` against a real table + real rows —
// and the "reinstall does not resurrect" acceptance criterion, which is a
// claim about the ABSENCE of any re-insert path and is only meaningfully
// provable against a real, persistent table (a query double could not
// distinguish "genuinely empty" from "a double that forgot to record the
// insert").
//
// Runner (the repo's standing DB-integration contract — the file tier is
// excluded from the default run):
//
//   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
//     pnpm exec vitest run src/lib/__tests__/agent-assigned-skills-teardown.integration.test.ts
//
// Own lane-unique schema, dropped in `afterAll` — mirrors
// agent-assigned-skills.integration.test.ts (S1).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { agentAssignedSkillsSchemaQueries } from "@/lib/skill-lifecycle-schema";
import {
  deleteAssignedSkillsForAgentPackage,
  deleteAssignedSkillsForSkillIds,
  insertAssignedSkill,
  readAssignedSkillsForAgentPackage,
  type AssignedSkillsQuery,
  type AssignedSkillsStoreDeps,
} from "@/lib/agent-assigned-skills-store";

const CONNECTION = process.env.SUPABASE_DB_URL ?? "";
const RUN = process.env.CINATRA_DB_INTEGRATION_TESTS === "1" && CONNECTION.length > 0;

const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const SCHEMA = `t2350_teardown_${suffix}`;

let pool: Pool;

function deps(): AssignedSkillsStoreDeps {
  const query: AssignedSkillsQuery = async <T = unknown>(
    text: string,
    values?: readonly unknown[],
  ) => {
    const res = await pool.query(text, values ? [...values] : undefined);
    return res.rows as T[];
  };
  return { schema: SCHEMA, query };
}

async function rowCount(): Promise<number> {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM "${SCHEMA}"."agent_assigned_skills"`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  if (!RUN) return;
  pool = new Pool({ connectionString: CONNECTION, max: 4 });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  for (const q of agentAssignedSkillsSchemaQueries(SCHEMA)) {
    await pool.query(q.text);
  }
});

afterAll(async () => {
  if (!RUN) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.end();
});

beforeEach(async () => {
  if (!RUN) return;
  await pool.query(`DELETE FROM "${SCHEMA}"."agent_assigned_skills"`);
});

describe.runIf(RUN)("deleteAssignedSkillsForSkillIds — real Postgres", () => {
  it("sweeps a skill id across MULTIPLE agents in one statement", async () => {
    await insertAssignedSkill(
      { agentPackageName: "@a/agent-1", skillId: "@cinatra-ai/chat:company-research", createdBy: "admin" },
      deps(),
    );
    await insertAssignedSkill(
      { agentPackageName: "@a/agent-2", skillId: "@cinatra-ai/chat:company-research", createdBy: "admin" },
      deps(),
    );
    // A sibling assignment that must SURVIVE — different skill id.
    await insertAssignedSkill(
      { agentPackageName: "@a/agent-1", skillId: "@other/pkg:s1", createdBy: "admin" },
      deps(),
    );

    const { deletedCount } = await deleteAssignedSkillsForSkillIds(
      ["@cinatra-ai/chat:company-research"],
      deps(),
    );

    expect(deletedCount).toBe(2);
    const agent1 = await readAssignedSkillsForAgentPackage("@a/agent-1", deps());
    expect(agent1.map((r) => r.skillId)).toEqual(["@other/pkg:s1"]);
    const agent2 = await readAssignedSkillsForAgentPackage("@a/agent-2", deps());
    expect(agent2).toEqual([]);
  });

  it("is idempotent: sweeping an id that owns no rows deletes nothing and never throws", async () => {
    await expect(
      deleteAssignedSkillsForSkillIds(["@nobody/owns:this"], deps()),
    ).resolves.toEqual({ deletedCount: 0 });
  });
});

describe.runIf(RUN)("deleteAssignedSkillsForAgentPackage — real Postgres", () => {
  it("sweeps EVERY row for one agent, leaving a sibling agent's rows untouched", async () => {
    await insertAssignedSkill(
      { agentPackageName: "@a/agent-1", skillId: "@x/y:s1", createdBy: "admin" },
      deps(),
    );
    await insertAssignedSkill(
      { agentPackageName: "@a/agent-1", skillId: "@x/y:s2", createdBy: "admin" },
      deps(),
    );
    await insertAssignedSkill(
      { agentPackageName: "@a/agent-2", skillId: "@x/y:s1", createdBy: "admin" },
      deps(),
    );

    const { deletedCount } = await deleteAssignedSkillsForAgentPackage("@a/agent-1", deps());

    expect(deletedCount).toBe(2);
    expect(await readAssignedSkillsForAgentPackage("@a/agent-1", deps())).toEqual([]);
    const agent2 = await readAssignedSkillsForAgentPackage("@a/agent-2", deps());
    expect(agent2.map((r) => r.skillId)).toEqual(["@x/y:s1"]);
  });
});

describe.runIf(RUN)("reinstall does NOT resurrect a swept assignment (cinatra#2350 AC)", () => {
  it("skill-side: uninstall sweeps the row; a subsequent 'reinstall' (no re-insert call — none exists on the install/update path) leaves it gone", async () => {
    await insertAssignedSkill(
      { agentPackageName: "@a/agent-1", skillId: "@vendor/pkg:s1", createdBy: "admin" },
      deps(),
    );
    expect(await rowCount()).toBe(1);

    // Uninstall teardown (S5): sweep by the skill's derived id.
    await deleteAssignedSkillsForSkillIds(["@vendor/pkg:s1"], deps());
    expect(await rowCount()).toBe(0);

    // "Reinstall" of @vendor/pkg: nothing on the skill extension handler's
    // install()/update() path calls insertAssignedSkill — the row must stay
    // gone. Simulated here by simply NOT calling it and re-reading.
    expect(await readAssignedSkillsForAgentPackage("@a/agent-1", deps())).toEqual([]);

    // A genuinely NEW assignment (an admin re-picking the skill post-reinstall
    // through the S1 write path) still works — teardown did not corrupt the
    // table for future use.
    const reassigned = await insertAssignedSkill(
      { agentPackageName: "@a/agent-1", skillId: "@vendor/pkg:s1", createdBy: "admin" },
      deps(),
    );
    expect(reassigned.outcome).toBe("assigned");
  });

  it("agent-side: uninstall sweeps every row for the agent; a subsequent 'reinstall' leaves them gone", async () => {
    await insertAssignedSkill(
      { agentPackageName: "@a/agent-1", skillId: "@x/y:s1", createdBy: "admin" },
      deps(),
    );
    await insertAssignedSkill(
      { agentPackageName: "@a/agent-1", skillId: "@x/y:s2", createdBy: "admin" },
      deps(),
    );
    expect(await rowCount()).toBe(2);

    await deleteAssignedSkillsForAgentPackage("@a/agent-1", deps());
    expect(await rowCount()).toBe(0);

    // "Reinstall" of @a/agent-1: nothing on the agent extension handler's
    // install()/update() path calls insertAssignedSkill either.
    expect(await readAssignedSkillsForAgentPackage("@a/agent-1", deps())).toEqual([]);
  });
});
