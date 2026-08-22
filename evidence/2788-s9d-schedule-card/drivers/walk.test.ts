/**
 * cinatra#2788 (S9d) — the seeding walk for the schedule-proposal captures,
 * run against THIS lane's own dev stack.
 *
 * It drives the SHIPPED proposal path and nothing else:
 *   PROPOSE  — `proposeTriggerSchedule`, the exact leaf the model-facing
 *              producer tool reaches, mints each proposal token. Nothing is
 *              written to the database by a proposal, which is the property
 *              §VI rests on ("nothing exists until the reader confirms").
 *   READBACK — after the browser has pressed Confirm, read the rows the
 *              confirm transaction wrote (the consume row and the install
 *              outbox intent) so the evidence names the run the card produced
 *              rather than a run this file created.
 *
 * NOTHING HERE CONFIRMS ANYTHING. Every Confirm, Adjust and Cancel in this
 * lane is a press in the browser, on the shipped card, through the shipped
 * endpoint. This file only mints the question and reads the answer back.
 *
 * Mock shape adapted from evidence/2893-zero-chip-settled/drivers/walk.test.ts.
 */
import * as fs from "node:fs";
import { it, vi } from "vitest";

// The shipped schedule shape, so the two fixtures below are checked against the
// type the producer actually mints rather than widened to `number`.
import type { ProposalSchedule } from "@/lib/trigger-schedule-proposal-token";

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
const STEP = process.env.WALK_STEP ?? "PROPOSE";
const STATE_FILE = process.env.WALK_STATE_FILE!;

const say = (s: string, d: unknown) => console.log(`WALK2788 ${s} ${JSON.stringify(d)}`);
const loadState = (): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (p: Record<string, unknown>) =>
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...p }, null, 2));

/** The plan's own example schedule: "run this every weekday at 9". */
const WEEKDAYS_AT_NINE: ProposalSchedule = {
  kind: "recurring",
  timezone: "Europe/Berlin",
  selection: {
    frequency: "weekly",
    interval: 1,
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    monthlyMode: "date",
    nthWeek: 1,
    monthlyWeekday: 1,
    quarterAnchor: "start",
    yearlyMonth: 1,
    hour: 9,
    minute: 0,
  },
};

/** "Run right after setup" — the row the run page's own card is reached by. */
const IMMEDIATE: ProposalSchedule = { kind: "immediate" };

async function main() {
  const { runPostgresQueriesSync } = await import("@/lib/postgres-sync");
  const { postgresSchema } = await import("@/lib/postgres-config");
  const schema = postgresSchema.replaceAll('"', '""');
  const sql = async (text: string, values: unknown[] = []) => {
    const r = await runPostgresQueriesSync({ connectionString: CONN, queries: [{ text, values }] });
    return (r?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
  };

  if (STEP === "TEMPLATES") {
    say("TEMPLATES", await sql(`select id, package_name, org_id, status from "${schema}".agent_templates order by package_name`));
  }

  if (STEP === "PROPOSE") {
    const { proposeTriggerSchedule } = await import(
      "../../../packages/agents/src/trigger-schedule-propose"
    );
    const templateId = process.env.WALK_TEMPLATE_ID!;
    const wanted = (process.env.WALK_PROPOSALS ?? "light,dark,immediate").split(",");
    const tokens: Record<string, string> = {};
    for (const slot of wanted) {
      const schedule = slot === "immediate" ? IMMEDIATE : WEEKDAYS_AT_NINE;
      const minted = await proposeTriggerSchedule({
        templateId,
        userId: USER,
        orgId: ORG,
        schedule,
      });
      if (!minted.ok) throw new Error(`propose refused for slot ${slot}`);
      tokens[slot] = minted.token;
      say("PROPOSE", { slot, kind: schedule.kind, expiresInMs: minted.expiresAt - Date.now() });
    }
    // Nothing was written: prove it rather than assert it.
    say("PROPOSE wrote nothing", {
      consumes: (await sql(`select count(*)::int as n from "${schema}".trigger_schedule_proposal_consumes`))[0],
      outbox: (await sql(`select count(*)::int as n from "${schema}".trigger_schedule_install_outbox`))[0],
      runs: (await sql(`select count(*)::int as n from "${schema}".agent_runs`))[0],
    });
    saveState({ tokens, templateId });
  }

  if (STEP === "READBACK") {
    say("READBACK", {
      consumes: await sql(
        `select consume_key, run_id, org_id, template_id, consumed_by from "${schema}".trigger_schedule_proposal_consumes order by consumed_at`,
      ),
      outbox: await sql(
        `select run_id, trigger_type, cron_expression, timezone, status from "${schema}".trigger_schedule_install_outbox order by run_id`,
      ),
      triggers: await sql(
        `select run_id, trigger_type, cron_expression, timezone, enabled, released_at from "${schema}".agent_run_triggers order by run_id`,
      ),
      runs: await sql(`select id, status, template_id from "${schema}".agent_runs order by created_at`),
    });
  }
}

it("walk", async () => {
  await main();
}, 600_000);
