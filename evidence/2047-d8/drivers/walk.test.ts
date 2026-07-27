/**
 * cinatra#2047 D-8 + OBS-1 lane — LIVE walk on this lane's own dev stack.
 * Drives the SHIPPED producer wrapper (materializeBlogPostBodyArtifact) on an
 * org that HOLDS the blog-post pack's claim — the exact call the re-acceptance
 * had to substitute because it threw (D-8) — then the shipped sweeper, then
 * reads the store back. The DECISION half runs through the REAL UI.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { it, vi } from "vitest";

vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  const real = await vi.importActual<typeof import("@/lib/postgres-schema-init")>("@/lib/postgres-schema-init");
  return {
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_k: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: real.ensurePostgresSchema,
  };
});

const ORG = process.env.WALK_ORG_ID!;
const USER = process.env.WALK_USER_ID!;
const TEMPLATE = process.env.WALK_TEMPLATE_ID!;
const CONN = process.env.SUPABASE_DB_URL!;
const STEP = process.env.WALK_STEP ?? "A";
const STATE_FILE = process.env.WALK_STATE_FILE!;

const say = (s: string, d: unknown) => console.log(`WALKD8 ${s} ${JSON.stringify(d)}`);
const loadState = (): Record<string, string> => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } };
const saveState = (p: Record<string, string>) => fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...p }, null, 2));

async function main() {
  const { runPostgresQueriesSync } = await import("@/lib/postgres-sync");
  const { postgresSchema } = await import("@/lib/postgres-config");
  const schema = postgresSchema.replaceAll('"', '""');
  const { registerArtifactExtensions } = await import("@cinatra-ai/objects/register-artifact-extensions");
  registerArtifactExtensions(process.cwd() + "/extensions");

  const sql = async (text: string, values: unknown[] = []) => {
    const r = await runPostgresQueriesSync({ connectionString: CONN, queries: [{ text, values }] });
    return (r?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
  };

  if (STEP === "CLAIM") {
    // Activate the blog-post pack's manifest claim for THIS org through the
    // SHIPPED install-anchor function (what a real marketplace install calls).
    const { activateArtifactExtensionClaims } = await import("@/lib/objects/artifact-claim-lifecycle");
    const before = await sql(
      `select id, object_type_id, extension_package, status from "${schema}".artifact_type_claims where scope=$1`,
      [`org:${ORG}`],
    );
    let activated: unknown = before.length > 0 ? "already-active" : null;
    if (before.length === 0) {
      activated = activateArtifactExtensionClaims(
        {
          scope: `org:${ORG}`,
          extensionPackage: "@cinatra-ai/blog-post-artifact",
          extensionVersion: "0.1.0",
          actor: USER,
        } as never,
        [
          {
            type: "@cinatra-ai/blog-post-artifact:post",
            claim: "dedicated",
            dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" },
          },
        ] as never,
      );
    }
    const after = await sql(
      `select id, object_type_id, extension_package, status, generation from "${schema}".artifact_type_claims where scope=$1`,
      [`org:${ORG}`],
    );
    say("CLAIM", { activated, claims: after });
  }

  if (STEP === "PRODUCE") {
    // THE SHIPPED WRAPPER — the call D-8 made impossible on a claim-holding org.
    const runId = `run-d8-${randomUUID().slice(0, 8)}`;
    await sql(
      `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by, human_present)
       values ($1,$2,'running','{}','agent_builder',$3,$4,true) on conflict (id) do nothing`,
      [runId, TEMPLATE, ORG, USER],
    );
    const { materializeBlogPostBodyArtifact } = await import("@/lib/blog-post-artifact-materializer");
    const produced = await materializeBlogPostBodyArtifact({
      content: "# Lane 2047 D-8\n\nThe shipped materializer ran on a claim-holding org.\n",
      title: "Lane 2047 D-8 blog body",
      createdByRunId: runId,
    });
    const assertions = await sql(
      `select extension, assertion_basis, eligibility, asserted_by from "${schema}".semantic_assertion
        where org_id=$1 and artifact_id=$2 and eligibility<>'archived'`,
      [ORG, produced.artifactId],
    );
    const { resolveArtifactVersionForServe } = await import("@/lib/artifacts/artifact-read");
    const serve = resolveArtifactVersionForServe({
      orgId: ORG,
      artifactId: produced.artifactId,
      representationRevisionId: produced.representationRevisionId,
      liveOnly: true,
    });
    saveState({ runId, artifactId: produced.artifactId, revisionId: produced.representationRevisionId });
    say("PRODUCE", { runId, ...produced, assertions, serve });
  }

  if (STEP === "GATE") {
    const st = loadState();
    const orch = await import("@cinatra-ai/agents/lifecycle-review-orchestration");
    const summary = await orch.sweepReviewOrchestration();
    const gates = await sql(
      `select id, run_id, review_task_id, status, disposition from "${schema}".artifact_review_gates where run_id=$1`,
      [st.runId],
    );
    const events = await sql(
      `select event_id, emitter, origin_kind, destination_class, status from "${schema}".artifact_produced_outbox where artifact_id=$1`,
      [st.artifactId],
    );
    if (gates[0]) saveState({ reviewTaskId: String(gates[0].review_task_id), gateId: String(gates[0].id) });
    say("GATE", { summary, gates, events });
  }

  if (STEP === "READBACK") {
    const st = loadState();
    const gates = await sql(
      `select id, review_task_id, status, disposition, resolved_by from "${schema}".artifact_review_gates where run_id=$1`,
      [st.runId],
    );
    const repairs = await sql(
      `select id, gate_id, route, status, attempt from "${schema}".lifecycle_repair where gate_id=$1`,
      [st.gateId],
    );
    say("READBACK", { gates, repairs });
  }
}

it(`lane 2047-d8 walk — step ${process.env.WALK_STEP ?? "A"}`, async () => {
  await main();
}, 600_000);
