/**
 * cinatra#2904 capture lane — produce, on the LANE STACK, the real review gates
 * the review page is then photographed on.
 *
 * ONE walk, three STEPs, all of them SHIPPED WRITERS. Nothing here decides a
 * gate: every decision in this round is a press of the card's own control in a
 * real browser (`capture.mjs`), because the state under test is what the review
 * page's own server loader answers for a gate that a person decided.
 *
 *   PRODUCE  `materializeBlogPostBodyArtifact` writes a real artifact under a
 *            real run, which puts a row in `artifact_produced_outbox`.
 *   GATE     `sweepReviewOrchestration` — the shipped sweep — mints the
 *            `artifact_review_gates` row and its review task.
 *   READBACK the lane's own rows, read straight out of the database, so the
 *            claims in the README are answered by the store rather than by the
 *            pictures.
 *
 * The mocks are the ones every lane walk in this tree uses, for the same two
 * reasons: a headless process cannot load the sqlite-era facade, and the MCP
 * instruction module pulls a graph this process has no business booting.
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
const STEP = process.env.WALK_STEP ?? "PRODUCE";
const STATE_FILE = process.env.WALK_STATE_FILE!;
const SLOT = process.env.WALK_SLOT ?? "a";

const say = (s: string, d: unknown) => console.log(`WALK ${s} ${JSON.stringify(d)}`);
const loadState = (): Record<string, string> => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (p: Record<string, string>) =>
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...p }, null, 2));

const SEEDED_BODY = [
  "# Connector rollout note",
  "",
  "## Summary",
  "The connector ships this week.",
  "It replaces the manual export step.",
  "",
  "## Rollout",
  "Enable it per organization, then remove the old export job.",
  "",
].join("\n");

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

  if (STEP === "PRODUCE") {
    const runId = randomUUID();
    const [tpl] = await sql(
      `select id, package_name from "${schema}".agent_templates where package_name=$1 limit 1`,
      [process.env.WALK_TEMPLATE_PKG],
    );
    await sql(
      `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by, human_present)
       values ($1,$2,'running','{}','agent_builder',$3,$4,true) on conflict (id) do nothing`,
      [runId, tpl!.id, ORG, USER],
    );
    const { materializeBlogPostBodyArtifact } = await import("@/lib/blog-post-artifact-materializer");
    const produced = await materializeBlogPostBodyArtifact({
      content: SEEDED_BODY,
      title: process.env.WALK_ARTIFACT_TITLE ?? "Connector rollout note",
      createdByRunId: runId,
    });
    saveState({
      [`runId_${SLOT}`]: runId,
      [`templateId_${SLOT}`]: String(tpl!.id),
      [`templatePkg_${SLOT}`]: String(tpl!.package_name),
      [`artifactId_${SLOT}`]: produced.artifactId,
      [`revisionId_${SLOT}`]: produced.representationRevisionId,
    });
    say("PRODUCE", { slot: SLOT, runId, ...produced });
  }

  if (STEP === "GATE") {
    const st = loadState();
    const orch = await import("@cinatra-ai/agents/lifecycle-review-orchestration");
    const summary = await orch.sweepReviewOrchestration();
    const gates = await sql(
      `select id, run_id, review_task_id, status from "${schema}".artifact_review_gates where run_id=$1`,
      [st[`runId_${SLOT}`]],
    );
    if (gates[0])
      saveState({
        [`reviewTaskId_${SLOT}`]: String(gates[0].review_task_id),
        [`gateId_${SLOT}`]: String(gates[0].id),
      });
    say("GATE", { slot: SLOT, summary, gates });
  }

  if (STEP === "READBACK") {
    const st = loadState();
    say("READBACK", {
      state: st,
      gates: await sql(
        `select g.id, g.run_id, g.review_task_id, g.status, g.disposition, g.resolved_by,
                u.name as resolved_by_name
           from "${schema}".artifact_review_gates g
           left join public."user" u on u.id = g.resolved_by
          order by g.created_at desc limit 10`,
      ),
    });
  }
}

it("walk", async () => {
  await main();
}, 900_000);
