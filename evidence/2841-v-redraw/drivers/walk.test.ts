/**
 * cinatra#2841 §V REDRAW — LIVE seeding walk on this lane's own dev stack.
 *
 * It drives the SHIPPED recommendation-hold path and nothing else:
 *   PROBE  — ask the shipped scorer which template offers >= 3 candidates.
 *   SEED   — write two pending_input runs (human-present) for that template.
 *   HOLD   — park each through `maybeHoldRunForRecommendation`, the one seam
 *            the run trigger uses, and read the park back.
 *
 * Mock shape adapted from evidence/2047-flip/drivers/walk.test.ts.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { it, vi } from "vitest";

vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const cfg = await import("@/lib/postgres-config");
  const real = await vi.importActual<typeof import("@/lib/postgres-schema-init")>(
    "@/lib/postgres-schema-init",
  );
  return {
    ...actual,
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_k: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: real.ensurePostgresSchema,
  };
});

vi.mock("@/lib/mcp-instructions", () => ({
  CINATRA_MCP_INSTRUCTIONS: "",
  CINATRA_MCP_EXPERIMENTAL: {},
}));

const ORG = process.env.WALK_ORG_ID!;
const USER = process.env.WALK_USER_ID!;
const CONN = process.env.SUPABASE_DB_URL!;
const STEP = process.env.WALK_STEP ?? "PROBE";
const STATE_FILE = process.env.WALK_STATE_FILE!;
const PROMPT = process.env.WALK_PROMPT ?? "Draft a short launch blog post and publish it.";

const say = (s: string, d: unknown) => console.log(`WALK2841 ${s} ${JSON.stringify(d)}`);
const loadState = (): Record<string, string> => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (p: Record<string, string>) =>
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...p }, null, 2));

async function main() {
  const { runPostgresQueriesSync } = await import("@/lib/postgres-sync");
  const { postgresSchema } = await import("@/lib/postgres-config");
  const schema = postgresSchema.replaceAll('"', '""');
  const { registerArtifactExtensions } = await import(
    "@cinatra-ai/objects/register-artifact-extensions"
  );
  registerArtifactExtensions(process.cwd() + "/extensions");

  const sql = async (text: string, values: unknown[] = []) => {
    const r = await runPostgresQueriesSync({ connectionString: CONN, queries: [{ text, values }] });
    return (r?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
  };

  if (STEP === "PROBE") {
    const act = await import("@/lib/lifecycle/lifecycle-activation");
    const { getRunRecommendations } = await import(
      "../../../packages/agents/src/recommendation-interception"
    );
    const rows = await sql(
      `select id, package_name from "${schema}".agent_templates order by package_name`,
    );
    const out: Array<{ pkg: string; id: string; total: number; recommended: number }> = [];
    for (const row of rows) {
      const pkg = String(row.package_name);
      try {
        const recs = (await getRunRecommendations({
          agentId: pkg,
          intent: { promptText: PROMPT },
        } as never)) as Array<{ recommended?: boolean }>;
        out.push({
          pkg,
          id: String(row.id),
          total: recs.length,
          recommended: recs.filter((r) => r.recommended !== false).length,
        });
      } catch (e) {
        out.push({ pkg, id: String(row.id), total: -1, recommended: -1 });
      }
    }
    out.sort((a, b) => b.recommended - a.recommended || b.total - a.total);
    say("PROBE", {
      chipRowActive: act.isRecommendationChipRowHoldActive(),
      top: out.slice(0, 8),
    });
  }

  if (STEP === "ASSIGN") {
    // The SHIPPED assignment writer the agent-settings surface uses. Four
    // organization-owned assignments, so the run actor AND the viewer both
    // resolve the same candidate set and the row draws >= 3 chips.
    const { upsertCustomSkillAssignment } = await import("@/lib/database");
    const agentId = process.env.WALK_AGENT_ID!;
    const skillIds = (process.env.WALK_SKILL_IDS ?? "").split(",").filter(Boolean);
    for (const skillId of skillIds) {
      upsertCustomSkillAssignment({
        skillId,
        agentId,
        ownerType: "organization" as never,
        ownerId: ORG,
        createdBy: USER,
      });
    }
    const { getAssignedSkillIdsForAgent } = await import("@/lib/agents-store");
    say("ASSIGN", {
      agentId,
      wrote: skillIds,
      resolved: await getAssignedSkillIdsForAgent(agentId, {
        principalId: USER,
        teamIds: [],
        projectIds: [],
        organizationId: ORG,
      } as never),
    });
  }

  if (STEP === "SEED") {
    const TEMPLATE = process.env.WALK_TEMPLATE_ID!;
    const ids: Record<string, string> = {};
    for (const slot of (process.env.WALK_SLOTS ?? "primary,readonly").split(",")) {
      const id = randomUUID();
      await sql(
        `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by, human_present)
         values ($1,$2,'pending_input',$3,'agent_builder',$4,$5,true) on conflict (id) do nothing`,
        [id, TEMPLATE, JSON.stringify({ prompt: PROMPT }), ORG, USER],
      );
      ids[`${slot}RunId`] = id;
    }
    saveState({ ...ids, templateId: TEMPLATE });
    say("SEED", {
      rows: await sql(
        `select id, status, human_present from "${schema}".agent_runs where id = any($1)`,
        [Object.values(ids)],
      ),
    });
  }

  if (STEP === "HOLD") {
    const st = loadState();
    const { maybeHoldRunForRecommendation, readRecommendationParkForRun } = await import(
      "../../../packages/agents/src/recommendation-hold"
    );
    const [tplRow] = await sql(
      `select package_name, lifecycle_config from "${schema}".agent_templates where id=$1`,
      [st.templateId],
    );
    const out: Record<string, unknown> = {};
    for (const key of (process.env.WALK_SLOTS ?? "primary,readonly").split(",").map((s) => `${s}RunId`)) {
      const runId = st[key];
      const [runRow] = await sql(
        `select id, org_id, run_by, source_type, human_present, input_params from "${schema}".agent_runs where id=$1`,
        [runId],
      );
      const hold = await maybeHoldRunForRecommendation({
        run: {
          id: String(runRow.id),
          orgId: String(runRow.org_id),
          runBy: (runRow.run_by as string | null) ?? null,
          sourceType: (runRow.source_type as string | null) ?? null,
          humanPresent: runRow.human_present as boolean | null,
          inputParams: runRow.input_params as never,
        },
        template: {
          packageName: String(tplRow.package_name),
          lifecycleConfig: (tplRow.lifecycle_config as string | null) ?? null,
        },
      });
      const park = await readRecommendationParkForRun(runId);
      out[key] = {
        runId,
        hold,
        park: park ? { id: park.id, status: park.status, checkpoint: park.checkpoint } : null,
      };
    }
    say("HOLD", { packageName: String(tplRow.package_name), ...out });
  }

  if (STEP === "READBACK") {
    const st = loadState();
    say("READBACK", {
      parks: await sql(
        `select run_id, checkpoint, status from "${schema}".lifecycle_continuation_park where run_id = any($1)`,
        [[st.primaryRunId, st.readonlyRunId]],
      ),
      runs: await sql(`select id, status from "${schema}".agent_runs where id = any($1)`, [
        [st.primaryRunId, st.readonlyRunId],
      ]),
      selected: await sql(
        `select run_id, skill_id, selection_source from "${schema}".run_selected_skill_revisions where run_id = any($1)`,
        [[st.primaryRunId, st.readonlyRunId]],
      ),
      rejected: await sql(
        `select run_id, skill_id, source from "${schema}".run_rejected_recommendations where run_id = any($1)`,
        [[st.primaryRunId, st.readonlyRunId]],
      ),
    });
  }
}

it("walk", async () => {
  await main();
}, 600_000);
