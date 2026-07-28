/**
 * cinatra#2047 ACTIVATION FLIP — LIVE walk on this lane's own dev stack with
 * NEITHER activation switch set in the environment.
 *
 * Every step below runs against a process whose `.env.local` deliberately omits
 * `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION` and
 * `CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW`, so anything that happens here is
 * the flip's DEFAULT posture, not an operator opt-in.
 *
 * Shape adapted from evidence/2047-d8/drivers/walk.test.ts (the D-8 walk this
 * flip builds on).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { it, vi } from "vitest";

// PARTIAL mock of the sqlite-era `@/lib/database` facade: keep every real export
// (the host connector-service registration reads several of them) and override
// only the three seams a headless walk must not touch.
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

// The recommendation-hold graph reaches `@/lib/agents-store`, which transitively
// pulls the MCP discovery module; that module reads a packaged skill body at
// import time, which a headless vitest process cannot resolve. The walk never
// exercises MCP, so stub the instruction constants (nothing lifecycle-related).
vi.mock("@/lib/mcp-instructions", () => ({
  CINATRA_MCP_INSTRUCTIONS: "",
  CINATRA_MCP_EXPERIMENTAL: {},
}));

const ORG = process.env.WALK_ORG_ID!;
const USER = process.env.WALK_USER_ID!;
const TEMPLATE = process.env.WALK_TEMPLATE_ID!;
/** The recommendation rung runs against its OWN template (defaults to the review
 *  template) — see the walk transcript for why. */
const REC_TEMPLATE = process.env.WALK_REC_TEMPLATE_ID || process.env.WALK_TEMPLATE_ID!;
const CONN = process.env.SUPABASE_DB_URL!;
const STEP = process.env.WALK_STEP ?? "A";
const STATE_FILE = process.env.WALK_STATE_FILE!;

const say = (s: string, d: unknown) => console.log(`WALKFLIP ${s} ${JSON.stringify(d)}`);
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

  // -----------------------------------------------------------------------
  // ENV — the load-bearing precondition for every rung below.
  // -----------------------------------------------------------------------
  if (STEP === "ENV") {
    const act = await import("@/lib/lifecycle/lifecycle-activation");
    say("ENV", {
      reviewOrchestrationEnvRaw: process.env[act.LIFECYCLE_REVIEW_ORCHESTRATION_ENV] ?? null,
      chipRowEnvRaw: process.env[act.LIFECYCLE_RECOMMENDATION_CHIP_ROW_ENV] ?? null,
      isLifecycleReviewOrchestrationActive: act.isLifecycleReviewOrchestrationActive(),
      isRecommendationChipRowHoldActive: act.isRecommendationChipRowHoldActive(),
      optOutValue: act.LIFECYCLE_ACTIVATION_OPT_OUT_VALUE,
    });
  }

  if (STEP === "CLAIM") {
    const { activateArtifactExtensionClaims } = await import(
      "@/lib/objects/artifact-claim-lifecycle"
    );
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

  // -----------------------------------------------------------------------
  // RUNG 1 — REVIEW. Produce through the shipped producer inside a real run.
  // NO env is set, so the emitter's produced-event INSERT must appear anyway.
  // -----------------------------------------------------------------------
  if (STEP === "PRODUCE") {
    const runId = `run-flip-${randomUUID().slice(0, 8)}`;
    await sql(
      `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by, human_present)
       values ($1,$2,'running','{}','agent_builder',$3,$4,true) on conflict (id) do nothing`,
      [runId, TEMPLATE, ORG, USER],
    );
    const { materializeBlogPostBodyArtifact } = await import("@/lib/blog-post-artifact-materializer");
    const produced = await materializeBlogPostBodyArtifact({
      content:
        "# Lane 2047 activation flip\n\nProduced with NO activation env set — the default is ON.\n",
      title: "Lane 2047 flip blog body",
      createdByRunId: runId,
    });
    const outbox = await sql(
      `select event_id, emitter, origin_kind, destination_class, continuation_mode, status
         from "${schema}".artifact_produced_outbox where artifact_id=$1`,
      [produced.artifactId],
    );
    const which = process.env.WALK_SLOT ?? "a";
    saveState({
      [`runId_${which}`]: runId,
      [`artifactId_${which}`]: produced.artifactId,
      [`revisionId_${which}`]: produced.representationRevisionId,
    });
    say("PRODUCE", { slot: which, runId, ...produced, outbox });
  }

  if (STEP === "GATE") {
    const which = process.env.WALK_SLOT ?? "a";
    const st = loadState();
    const orch = await import("@cinatra-ai/agents/lifecycle-review-orchestration");
    const summary = await orch.sweepReviewOrchestration();
    const gates = await sql(
      `select id, run_id, review_task_id, status, disposition from "${schema}".artifact_review_gates where run_id=$1`,
      [st[`runId_${which}`]],
    );
    const events = await sql(
      `select event_id, emitter, origin_kind, destination_class, status from "${schema}".artifact_produced_outbox where artifact_id=$1`,
      [st[`artifactId_${which}`]],
    );
    if (gates[0])
      saveState({
        [`reviewTaskId_${which}`]: String(gates[0].review_task_id),
        [`gateId_${which}`]: String(gates[0].id),
      });
    say("GATE", { slot: which, summary, gates, events });
  }

  if (STEP === "READBACK") {
    const which = process.env.WALK_SLOT ?? "a";
    const st = loadState();
    const gates = await sql(
      `select id, review_task_id, status, disposition, resolved_by from "${schema}".artifact_review_gates where run_id=$1`,
      [st[`runId_${which}`]],
    );
    const repairs = await sql(
      `select id, gate_id, route, status, attempt from "${schema}".lifecycle_repair where gate_id=$1`,
      [st[`gateId_${which}`]],
    );
    say("READBACK", { slot: which, gates, repairs });
  }

  // -----------------------------------------------------------------------
  // RUNG 2 — RECOMMENDATION, BOTH PATHS. The row-6 proof.
  // -----------------------------------------------------------------------
  if (STEP === "REC_SEED") {
    // Two pending_input runs on the same template: one HUMAN-PRESENT, one
    // HEADLESS. Nothing else differs — the fork is `human_present` alone.
    const humanRunId = `run-flip-human-${randomUUID().slice(0, 8)}`;
    const headlessRunId = `run-flip-headless-${randomUUID().slice(0, 8)}`;
    for (const [id, present] of [
      [humanRunId, true],
      [headlessRunId, false],
    ] as const) {
      await sql(
        `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by, human_present)
         values ($1,$2,'pending_input',$3,'agent_builder',$4,$5,$6) on conflict (id) do nothing`,
        [id, REC_TEMPLATE, JSON.stringify({ prompt: "Draft a short launch blog post about the flip." }), ORG, USER, present],
      );
    }
    saveState({ humanRunId, headlessRunId });
    const rows = await sql(
      `select id, status, human_present from "${schema}".agent_runs where id = any($1)`,
      [[humanRunId, headlessRunId]],
    );
    say("REC_SEED", { rows });
  }

  if (STEP === "REC_DIAG") {
    const { getAssignedSkillIdsForAgent } = await import("@/lib/agents-store");
    const { getRunRecommendations } = await import(
      "../../../packages/agents/src/recommendation-interception"
    );
    const [tplRow] = await sql(
      `select package_name from "${schema}".agent_templates where id=$1`,
      [REC_TEMPLATE],
    );
    const pkg = String(tplRow.package_name);
    const assigned = await getAssignedSkillIdsForAgent(pkg);
    const recsRestricted = await getRunRecommendations({
      agentId: pkg,
      intent: { promptText: "Draft a short launch blog post about the flip." },
      restrictToSkillIds: assigned,
    } as never);
    const recsUnrestricted = await getRunRecommendations({
      agentId: pkg,
      intent: { promptText: "Draft a short launch blog post about the flip." },
    } as never);
    say("REC_DIAG", { pkg, assigned, recsRestricted, recsUnrestricted });
  }

  if (STEP === "REC_HOLD") {
    const st = loadState();
    const { maybeHoldRunForRecommendation, readRecommendationParkForRun } = await import(
      "../../../packages/agents/src/recommendation-hold"
    );
    // Read the run + template rows over raw SQL rather than through the agents
    // store barrel: the barrel pulls the MCP discovery graph, which a headless
    // walk process cannot boot. The hold seam only needs these four fields.
    const [tplRow] = await sql(
      `select package_name, lifecycle_config from "${schema}".agent_templates where id=$1`,
      [REC_TEMPLATE],
    );

    const out: Record<string, unknown> = {};
    for (const [label, runId] of [
      ["humanPresent", st.humanRunId],
      ["headless", st.headlessRunId],
    ] as const) {
      const [runRow] = await sql(
        `select id, org_id, run_by, source_type, human_present, input_params from "${schema}".agent_runs where id=$1`,
        [runId],
      );
      const hold = await maybeHoldRunForRecommendation({
        run: {
          id: String(runRow.id),
          orgId: String(runRow.org_id),
          // cinatra#2148: the hold resolves its candidate set through the RUN's
          // own actor, so the projection carries the run's owner + source.
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
      out[label] = {
        runId,
        hold,
        park: park ? { id: park.id, status: park.status, checkpoint: park.checkpoint } : null,
      };
    }
    const parkRows = await sql(
      `select run_id, checkpoint, status from "${schema}".lifecycle_continuation_park where run_id = any($1)`,
      [[st.humanRunId, st.headlessRunId]],
    );
    say("REC_HOLD", { ...out, parkRows });
  }

  if (STEP === "REC_READBACK") {
    const st = loadState();
    const parks = await sql(
      `select run_id, checkpoint, status from "${schema}".lifecycle_continuation_park where run_id = any($1)`,
      [[st.humanRunId, st.headlessRunId]],
    );
    const selected = await sql(
      `select run_id, skill_id, selection_source from "${schema}".run_selected_skill_revisions where run_id = any($1) order by run_id, skill_id`,
      [[st.humanRunId, st.headlessRunId]],
    );
    const runs = await sql(
      `select id, status, human_present from "${schema}".agent_runs where id = any($1)`,
      [[st.humanRunId, st.headlessRunId]],
    );
    say("REC_READBACK", { parks, selected, runs });
  }

  if (STEP === "REC_HEADLESS_APPLY") {
    // The headless engine path: the run never parks, and the auto-apply seam is
    // the only recommendation motion it takes.
    const st = loadState();
    const { autoApplyHeadlessRecommendation } = await import(
      "../../../packages/agents/src/recommendation-interception"
    );
    const [tplRow] = await sql(
      `select package_name from "${schema}".agent_templates where id=$1`,
      [REC_TEMPLATE],
    );
    const { getAssignedSkillIdsForAgent } = await import("@/lib/agents-store");
    const pkg = String(tplRow.package_name);
    const applied = await autoApplyHeadlessRecommendation({
      runId: st.headlessRunId,
      orgId: ORG,
      agentId: pkg,
      intent: { promptText: "web research agent: research the cinatra lifecycle activation flip" },
      restrictToSkillIds: await getAssignedSkillIdsForAgent(pkg),
    });
    const parks = await sql(
      `select run_id, checkpoint, status from "${schema}".lifecycle_continuation_park where run_id=$1`,
      [st.headlessRunId],
    );
    say("REC_HEADLESS_APPLY", { applied, parks });
  }

  if (STEP === "REC_REQUIRED_BOUND") {
    // The other half of the row-6 headless proof: with an org `required` bound on
    // the recommendation checkpoint the HEADLESS run AUTO-APPLIES (still never
    // parks), while the human-present run still PARKS. One org rule, two paths.
    const st = loadState();
    const { upsertLifecyclePolicyRule } = await import("@cinatra-ai/agents/lifecycle-policy-store");
    const rule = await upsertLifecyclePolicyRule({
      orgId: ORG,
      checkpoint: "recommendation",
      artifactType: "*",
      destinationClass: "none",
      originKind: "agent_produced",
      bound: "required",
    } as never);

    const { autoApplyHeadlessRecommendation } = await import(
      "../../../packages/agents/src/recommendation-interception"
    );
    const [tplRow] = await sql(
      `select package_name from "${schema}".agent_templates where id=$1`,
      [REC_TEMPLATE],
    );
    const { getAssignedSkillIdsForAgent } = await import("@/lib/agents-store");
    const pkg = String(tplRow.package_name);
    const applied = await autoApplyHeadlessRecommendation({
      runId: st.headlessRunId,
      orgId: ORG,
      agentId: pkg,
      intent: { promptText: "web research agent: research the cinatra lifecycle activation flip" },
      restrictToSkillIds: await getAssignedSkillIdsForAgent(pkg),
    });
    const parks = await sql(
      `select run_id, checkpoint, status from "${schema}".lifecycle_continuation_park where run_id=$1`,
      [st.headlessRunId],
    );
    const selected = await sql(
      `select run_id, skill_id, selection_source from "${schema}".run_selected_skill_revisions where run_id=$1`,
      [st.headlessRunId],
    );
    say("REC_REQUIRED_BOUND", { rule, applied, parks, selected });
  }

  // -----------------------------------------------------------------------
  // RUNG 3 — OPS surfaces read real state.
  // -----------------------------------------------------------------------
  if (STEP === "OPS") {
    const gates = await sql(
      `select status, count(*)::int as n from "${schema}".artifact_review_gates group by 1 order by 1`,
    );
    const events = await sql(
      `select status, count(*)::int as n from "${schema}".artifact_produced_outbox group by 1 order by 1`,
    );
    const parks = await sql(
      `select checkpoint, status, count(*)::int as n from "${schema}".lifecycle_continuation_park group by 1,2 order by 1,2`,
    );
    const repairs = await sql(
      `select status, count(*)::int as n from "${schema}".lifecycle_repair group by 1 order by 1`,
    );
    say("OPS", { gates, events, parks, repairs });
  }
}

it(`lane 2047-flip walk — step ${process.env.WALK_STEP ?? "A"}`, async () => {
  await main();
}, 600_000);
