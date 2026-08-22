/**
 * cinatra#2855 capture lane — produce a REAL review gate through the shipped
 * writers on the running lane stack, so the settled card has something to name.
 *
 * Shape adapted from evidence/2047-flip/drivers/walk.test.ts (same mocks, same
 * reasons): the sqlite-era `@/lib/database` facade is partially mocked so a
 * headless process can load the store graph, and the MCP instruction constants
 * are stubbed because that module reads a packaged skill body at import time.
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

  const slot = process.env.WALK_SLOT ?? "a";

  if (STEP === "PRODUCE") {
    // A UUID run id, so the run-detail URL class the capture-record contract
    // recognizes (`/agents/<vendor>/<pkg>/<uuid>`) is reachable at all.
    const runId = randomUUID();
    const [tpl] = await sql(
      `select id, package_name from "${schema}".agent_templates where package_name=$1 limit 1`,
      [process.env.WALK_TEMPLATE_PKG],
    );
    await sql(
      `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by, human_present)
       values ($1,$2,'running','{}','agent_builder',$3,$4,true) on conflict (id) do nothing`,
      [runId, tpl.id, ORG, USER],
    );
    const { materializeBlogPostBodyArtifact } = await import("@/lib/blog-post-artifact-materializer");
    const produced = await materializeBlogPostBodyArtifact({
      content: process.env.WALK_ARTIFACT_BODY ?? "# Capture lane\n\nProduced through the shipped materializer.\n",
      title: process.env.WALK_ARTIFACT_TITLE ?? "Capture lane body",
      createdByRunId: runId,
    });
    const outbox = await sql(
      `select event_id, emitter, origin_kind, destination_class, continuation_mode, status
         from "${schema}".artifact_produced_outbox where artifact_id=$1`,
      [produced.artifactId],
    );
    saveState({
      [`runId_${slot}`]: runId,
      [`templatePkg_${slot}`]: String(tpl.package_name),
      [`artifactId_${slot}`]: produced.artifactId,
      [`revisionId_${slot}`]: produced.representationRevisionId,
    });
    say("PRODUCE", { slot, runId, templatePkg: tpl.package_name, ...produced, outbox });
  }

  if (STEP === "GATE") {
    const st = loadState();
    const orch = await import("@cinatra-ai/agents/lifecycle-review-orchestration");
    const summary = await orch.sweepReviewOrchestration();
    const gates = await sql(
      `select id, run_id, review_task_id, status, disposition, resolved_by from "${schema}".artifact_review_gates where run_id=$1`,
      [st[`runId_${slot}`]],
    );
    if (gates[0])
      saveState({
        [`reviewTaskId_${slot}`]: String(gates[0].review_task_id),
        [`gateId_${slot}`]: String(gates[0].id),
      });
    say("GATE", { slot, summary, gates });
  }

  if (STEP === "REF") {
    // The SHIPPED ref codec — the same one the emission path mints with.
    const st = loadState();
    const { encodeLifecycleGateRef } = await import("@/lib/lifecycle/lifecycle-card-ref");
    const runId = st[`runId_${slot}`];
    const reviewTaskId = st[`reviewTaskId_${slot}`];
    if (!runId || !reviewTaskId) throw new Error(`REF: missing recorded state for slot ${slot}`);
    const ref = encodeLifecycleGateRef({ runId, reviewTaskId });
    if (!ref) throw new Error(`REF: the codec returned null for slot ${slot}`);
    saveState({ [`ref_${slot}`]: ref });
    say("REF", { slot, refLength: ref.length });
  }

  if (STEP === "EXPIRE") {
    // Backdate the AUTO gate's expiry and run the SHIPPED gate-maintenance
    // sweep, so an OPTIONAL review LAPSES through the shipped auto-resolve
    // (disposition 'approve', NO resolved_by) rather than a human decision.
    // The only thing moved is the clock.
    const st = loadState();
    const before = await sql(
      `select id, status, disposition, resolved_by, expires_at from "${schema}".artifact_review_gates where id=$1`,
      [st[`gateId_${slot}`]],
    );
    await sql(
      `update "${schema}".artifact_review_gates set expires_at = now() - interval '1 hour' where id=$1`,
      [st[`gateId_${slot}`]],
    );
    const orch = await import("@cinatra-ai/agents/lifecycle-review-orchestration");
    const summary = await orch.sweepLifecycleGateMaintenance();
    const after = await sql(
      `select id, status, disposition, resolved_by, fingerprint from "${schema}".artifact_review_gates where id=$1`,
      [st[`gateId_${slot}`]],
    );
    say("EXPIRE", { slot, before, summary, after });
  }

  if (STEP === "READBACK") {
    const st = loadState();
    const gates = await sql(
      `select id, review_task_id, status, disposition, resolved_by, fingerprint from "${schema}".artifact_review_gates where run_id=$1`,
      [st[`runId_${slot}`]],
    );
    const audit = await sql(
      `select gate_id, disposition, actor_id from "${schema}".artifact_review_audit where gate_id=$1`,
      [st[`gateId_${slot}`]],
    );
    say("READBACK", { slot, gates, audit });
  }
}

it("walk", async () => {
  await main();
});
