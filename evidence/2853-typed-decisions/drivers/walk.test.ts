/**
 * cinatra#2853 capture lane — produce FOUR real review gates, one per typed
 * decision the round photographs.
 *
 * Nothing here writes a lifecycle row by hand. The chain is the shipped one:
 *
 *   materializeBlogPostBodyArtifact  (writes the object + its body bytes)
 *     -> createSemanticArtifact       (inside the materializer)
 *     -> the artifact_produced_outbox row
 *     -> sweepReviewOrchestration()   (the app's own drain)
 *     -> the artifact_review_gates row
 *
 * and the ref each card carries is minted by the shipped codec
 * (`encodeLifecycleGateRef`) against THAT gate. Nothing about a decision is
 * seeded: every gate here is created PENDING, and the only thing that ever
 * resolves one is a message typed into the composer during the capture.
 *
 * ONE SLOT IS DELIBERATELY RESTRICTED. The run for slot `c` is created with an
 * AgentAuthPolicy of runData=["org"] / runExecute=["admin"], which is the
 * ordinary Permissions-tab shape and not a special case: a second org member
 * may READ that run and therefore see the card, and may not act on it, because
 * `policyAllows` maps BOTH approveHitl and respondToHitl to
 * runExecuteVisibility. That is why the restricted reader in D3 gets the
 * `canDecide:false, canComment:false` line rather than the `canComment:true`
 * one - see the round README, which measures rather than assumes it.
 *
 * The mocks are the ones evidence/2047-flip and evidence/2852-before-after use,
 * for the same reason: a headless process cannot load the sqlite-era facade or
 * the MCP instruction module.
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

/**
 * The body the artifact is seeded with. Ordinary prose with ordinary headings —
 * chosen so the island's rendered target is recognizable on screen at a glance
 * and cannot be confused with the empty island every refusal draws.
 */
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
  const slot = process.env.WALK_SLOT ?? "a";

  if (STEP === "PRODUCE") {
    const runId = randomUUID();
    const [tpl] = await sql(
      `select id, package_name from "${schema}".agent_templates where package_name=$1 limit 1`,
      [process.env.WALK_TEMPLATE_PKG],
    );
    // The run row is the authorization anchor the gate hangs on. `auth_policy`
    // is a COLUMN OF THIS SAME INSERT rather than a later hand-edit: it is the
    // run's configuration, exactly what the Permissions tab persists, and a
    // slot that needs a restricted reader needs it from the start.
    const policy = process.env.WALK_RUN_POLICY ?? null;
    await sql(
      `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by, human_present, auth_policy)
       values ($1,$2,'running','{}','agent_builder',$3,$4,true,$5) on conflict (id) do nothing`,
      [runId, tpl.id, ORG, USER, policy],
    );
    const { materializeBlogPostBodyArtifact } = await import("@/lib/blog-post-artifact-materializer");
    const produced = await materializeBlogPostBodyArtifact({
      content: SEEDED_BODY,
      title: process.env.WALK_ARTIFACT_TITLE ?? "Connector rollout note",
      createdByRunId: runId,
    });
    saveState({
      [`runId_${slot}`]: runId,
      [`artifactId_${slot}`]: produced.artifactId,
      [`revisionId_${slot}`]: produced.representationRevisionId,
    });
    say("PRODUCE", { slot, runId, ...produced });
  }

  if (STEP === "GATE") {
    const st = loadState();
    const orch = await import("@cinatra-ai/agents/lifecycle-review-orchestration");
    const summary = await orch.sweepReviewOrchestration();
    const gates = await sql(
      `select id, run_id, review_task_id, status from "${schema}".artifact_review_gates where run_id=$1`,
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
    const st = loadState();
    const { encodeLifecycleGateRef } = await import("@/lib/lifecycle/lifecycle-card-ref");
    const runId = st[`runId_${slot}`];
    const reviewTaskId = st[`reviewTaskId_${slot}`];
    if (!runId || !reviewTaskId) throw new Error(`REF: missing recorded state for slot ${slot}`);
    const ref = encodeLifecycleGateRef({ runId, reviewTaskId });
    if (!ref) throw new Error(`REF: the codec returned null for slot ${slot}`);
    saveState({ [`ref_${slot}`]: ref });
    // The ref is a SEALED addressing handle. Its LENGTH is reported; the value
    // is never printed into a log that lands in the repository.
    say("REF", { slot, refLength: ref.length });
  }
}

it("walk", async () => {
  await main();
});
