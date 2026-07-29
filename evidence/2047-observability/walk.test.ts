/**
 * cinatra#2047 D-4/D-5/D-7 — LIVE proof walk (store-side half).
 *
 * Drives the SHIPPED production entry points against the live dev stack, with
 * both lifecycle fences ON, so the two surfaces this lane adds have real state
 * to render:
 *
 *   D-5 — a run whose review is SKIPPED by an org `forbidden` bound (the exact
 *         Z5_ORG_FORBIDDEN case the acceptance report found invisible), plus a
 *         second production on the SAME run whose review FIRES, so the run
 *         timeline shows a fired gate and a skipped decision side by side.
 *   D-4 — a resume intent driven to exhaustion and dead-lettered, so the ops
 *         surface has a stuck review release to list.
 *   D-7 — a checkpointed park TTL-fail-closed into policy_unresolved, so the ops
 *         surface has a blocked effect to list AND the effect layer reports it.
 *
 * Emits one JSON line per step prefixed `LANE2047`. Adapted from the #2047
 * acceptance walk harness (evidence/2047-acceptance).
 */
import { randomUUID } from "node:crypto";
import { it } from "vitest";

const ORG = process.env.WALK_ORG_ID!;
const USER = process.env.WALK_USER_ID!;
const TEMPLATE = process.env.WALK_TEMPLATE_ID!;
const CONN = process.env.SUPABASE_DB_URL!;

function say(step: string, data: unknown) {
  console.log(`LANE2047 ${step} ${JSON.stringify(data)}`);
}

async function main() {
  const { runPostgresQueriesSync } = await import("@/lib/postgres-sync");
  const { postgresSchema } = await import("@/lib/postgres-config");
  const schema = postgresSchema.replaceAll('"', '""');

  const { registerArtifactExtensions } = await import(
    "@cinatra-ai/objects/register-artifact-extensions"
  );
  registerArtifactExtensions(process.cwd() + "/extensions");

  const { createSemanticArtifact } = await import("@/lib/artifacts/artifact-creation");
  const orch = await import("@cinatra-ai/agents/lifecycle-review-orchestration");
  const gates = await import("@cinatra-ai/agents/artifact-review-gate-store");
  const policyStore = await import("../../packages/agents/src/lifecycle-policy-store");
  const parkStore = await import("../../packages/agents/src/lifecycle-continuation-park-store");

  const OBJECT_TYPE = process.env.WALK_OBJECT_TYPE ?? "@cinatra-ai/text-artifact:artifact";
  const TEXT_TYPE = OBJECT_TYPE;

  async function sql(text: string, values: unknown[] = []) {
    const r = await runPostgresQueriesSync({ connectionString: CONN, queries: [{ text, values }] });
    return (r?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
  }

  async function newRun(label: string): Promise<string> {
    const id = `run-2047-${label}-${randomUUID().slice(0, 8)}`;
    await sql(
      `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by)
       values ($1,$2,'running','{}','agent_builder',$3,$4)`,
      [id, TEMPLATE, ORG, USER],
    );
    return id;
  }

  async function produce(runId: string, body: string, title: string, objectType = OBJECT_TYPE) {
    async function* stream() {
      yield new TextEncoder().encode(body);
    }
    return createSemanticArtifact({
      orgId: ORG,
      objectType,
      createdBy: USER,
      ownerLevel: "organization",
      ownerId: ORG,
      visibility: "organization",
      title,
      declaredMime: "text/markdown",
      originKind: "agent_produced",
      createdByRunId: runId,
      stream: stream(),
    } as never);
  }

  // ------------------------------------------------------------------ D-5
  // ONE run carrying BOTH a fired and a skipped review decision.
  const runId = await newRun("D5");

  // (1) default lattice → the review FIRES (a gate opens).
  const fired = await produce(
    runId,
    "# fired production\n\nreview fires by core default.\n",
    "lane2047-fired",
    "@cinatra-ai/blog-post-artifact:post",
  );
  await orch.sweepReviewOrchestration({ limit: 50 });

  // (2) org `forbidden` bound → the review is SKIPPED (no gate, no park; the
  //     outbox row reaches processed with a NULL continuation address).
  await policyStore.upsertLifecyclePolicyRule({
    orgId: ORG,
    checkpoint: "review",
    // EXACT type bound — scoped to the skipped production's type only, so the
    // fired decision above keeps its own (unchanged) core-default reason.
    artifactType: TEXT_TYPE,
    originKind: "agent_produced",
    destinationClass: "none",
    bound: "forbidden",
  } as never);
  const skipped = await produce(runId, "# forbidden-bound production\n", "lane2047-org-forbidden");
  await orch.sweepReviewOrchestration({ limit: 50 });
  // The bound STAYS in place: the run surface must show the org-forbidden reason
  // as it stands, not a "policy has changed" staleness notice. (The staleness
  // path has its own integration case.)

  const decisions = await policyStore.readLifecycleDecisionsForRun(runId);
  say("D5_RUN", { runId, firedArtifact: fired.artifactId, skippedArtifact: skipped.artifactId });
  say("D5_DECISIONS", decisions);
  say("D5_OUTBOX", await sql(
    `select artifact_id, status, continuation_address from "${schema}".artifact_produced_outbox
      where producer_run_id = $1 order by created_at`,
    [runId],
  ));

  // ------------------------------------------------------------------ D-4
  // A resolved gate whose resume delivery exhausts its attempts → dead-lettered.
  const dlRunId = await newRun("D4");
  const dlTaskId = `wayflow-${randomUUID()}`;
  const dlGate = await gates.emitArtifactReviewGate({
    runId: dlRunId,
    orgId: ORG,
    reviewTaskId: dlTaskId,
    targets: [{ artifactId: fired.artifactId, representationRevisionId: fired.representationRevisionId }],
  });
  await sql(
    `insert into "${schema}".artifact_review_resume_outbox
       (gate_id, run_id, review_task_id, kind, response_text, status, attempts, max_attempts, lease_token, lease_expires_at)
     values ($1,$2,$3,'approve','approved','delivering',3,3,null,null)`,
    [dlGate.gateId, dlRunId, dlTaskId],
  );
  const deadCount = await gates.deadLetterExhaustedResumeIntents({
    lastError: "resume delivery attempts exhausted (lane #2047 live proof)",
  });
  say("D4_DEAD_LETTERED", {
    dlRunId,
    gateId: dlGate.gateId,
    transitioned: deadCount,
    opsVisibleForOrg: await gates.readDeadLetteredResumeIntents({ orgId: ORG }),
  });

  // ------------------------------------------------------------------ D-7
  // A CHECKPOINTED external-effect production, parked, then TTL-fail-closed.
  const parkRunId = await newRun("D7");
  const parked = await produce(parkRunId, "# checkpointed external production\n", "lane2047-policy-unresolved");
  await sql(
    `update "${schema}".artifact_produced_outbox
        set destination_class='external_publish', continuation_mode='checkpointed'
      where artifact_id = $1`,
    [parked.artifactId],
  );
  await orch.sweepReviewOrchestration({ limit: 50 });
  await sql(
    `update "${schema}".lifecycle_continuation_park
        set ttl_expires_at = now() - interval '1 minute'
      where run_id = $1`,
    [parkRunId],
  );
  // Driven through the PRODUCTION maintenance drain, not the park store's sweeper
  // directly — the drain is the only production caller of the TTL fail-close.
  const swept = await orch.sweepLifecycleGateMaintenance({ limit: 50 });
  say("D7_PARK_SWEPT", { parkRunId, artifactId: parked.artifactId, swept });
  say("D7_EFFECT_DISPOSITION", await orch.resolveArtifactEffectDisposition({
    artifactId: parked.artifactId,
    representationRevisionId: parked.representationRevisionId,
  }));
  say("D7_EFFECT_HELD", await orch.isArtifactEffectHeld({
    artifactId: parked.artifactId,
    representationRevisionId: parked.representationRevisionId,
  }));
  say("D7_OPS_BLOCKED_EFFECTS", await parkStore.readPolicyUnresolvedParks({ orgId: ORG, limit: 50 }));

  say("DONE", { d5RunId: runId, d4RunId: dlRunId, d7RunId: parkRunId });
}

it("cinatra#2047 D-4/D-5/D-7 live proof walk", async () => {
  await main();
});
