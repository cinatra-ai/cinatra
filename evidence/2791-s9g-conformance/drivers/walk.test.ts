/**
 * cinatra#2791 (S9g) capture lane — produce, on the LANE STACK, the real
 * lifecycle rows every conformance cell is photographed from.
 *
 * ONE walk, several STEPs, all of them SHIPPED WRITERS:
 *
 *   PRODUCE  `materializeBlogPostBodyArtifact` writes a real artifact under a
 *            real run, which puts a row in `artifact_produced_outbox`.
 *   GATE     `sweepReviewOrchestration` — the shipped sweep — mints the
 *            `artifact_review_gates` row and its review task.
 *   SUGGEST  `runSuggestionProducerLane` derives §VIII's before/after pairs from
 *            the artifact's OWN bytes through the shipped readers and freezes
 *            them with `writeGateSuggestionSnapshot`.
 *   REF      `encodeLifecycleGateRef` mints the opaque handle every card is
 *            addressed by. Nothing here assembles a ref from ids by hand.
 *   HOLD     `maybeHoldRunForRecommendation` parks a run on §V's chip row, and
 *            the shipped per-chip writers settle the second one.
 *
 * The projector handed to the suggestion lane is the TYPE-AWARE drop-in the lane
 * documents (the shipped default can disclose nothing a rule can fire on), used
 * exactly as evidence/2865-section-i-hierarchy/drivers/walk.test.ts uses it.
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

/** Non-canonical in two ways, so the producer has two real defects to find. */
const SEEDED_BODY = [
  "# Connector rollout note",
  "",
  "## Summary   ",
  "The connector ships this week.   ",
  "It replaces the manual export step.",
  "",
  "## Rollout",
  "   Enable it per organization, then remove the old export job.   ",
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

  if (STEP === "SUGGEST") {
    const st = loadState();
    const artifactId = st[`artifactId_${SLOT}`]!;
    const revisionId = st[`revisionId_${SLOT}`]!;
    const { runSuggestionProducerLane } = await import(
      "../../../packages/agents/src/lifecycle-suggestion-producer-lane"
    );
    const { readBlogPostBodyArtifactBytes } = await import(
      "@/lib/blog-post-artifact-materializer"
    );
    const project = async () => {
      const [row] = await sql(`select data from "${schema}".objects where id=$1`, [artifactId]);
      const data = (row?.data ?? {}) as Record<string, unknown>;
      const bytes = await readBlogPostBodyArtifactBytes({
        artifactId,
        representationRevisionId: revisionId,
      });
      const includedFields: Record<string, string> = {};
      if (typeof data.title === "string") includedFields["artifact.title"] = data.title;
      const body = bytes?.body ?? "";
      const parts = body.split(/\n(?=## )/g).filter((p) => p.trim() !== "");
      parts.forEach((part, i) => {
        includedFields[`artifact.sections.${i}.text`] = part;
      });
      return {
        projection: {
          includedFields,
          excludedFields: [
            "artifact.mime",
            "artifact.objectType",
            "artifact.sourceUrl",
            "representation.resource",
          ].sort(),
        },
        authzDecision: "authorized" as const,
      };
    };
    const outcome = await runSuggestionProducerLane({
      gateId: st[`gateId_${SLOT}`]!,
      target: { artifactId, representationRevisionId: revisionId },
      project,
    });
    const snap = await sql(
      `select id, gate_id, jsonb_array_length(payload->'suggestions') as n from "${schema}".gate_suggestion_snapshots where gate_id=$1`,
      [st[`gateId_${SLOT}`]],
    );
    say("SUGGEST", { slot: SLOT, outcome, snapshots: snap });
  }

  if (STEP === "REF") {
    const st = loadState();
    const { encodeLifecycleGateRef } = await import("@/lib/lifecycle/lifecycle-card-ref");
    const runId = st[`runId_${SLOT}`];
    const reviewTaskId = st[`reviewTaskId_${SLOT}`];
    if (!runId || !reviewTaskId) throw new Error(`REF: missing recorded state for slot ${SLOT}`);
    const ref = encodeLifecycleGateRef({ runId, reviewTaskId });
    if (!ref) throw new Error(`REF: the codec returned null for slot ${SLOT}`);
    saveState({ [`ref_${SLOT}`]: ref });
    say("REF", { slot: SLOT, refLength: ref.length, reviewTaskId, runId });
  }

  if (STEP === "VERIFY") {
    // §VII's reading comes from a REAL repair round-trip. `seedRepairVerification`
    // is the app's OWN in-process fixture (src/lib/test-support/lifecycle-seed-drivers):
    // createSemanticArtifact -> emitArtifactReviewGate -> recordChangesRequested ->
    // createSemanticArtifact -> submitRepairResponse, and the last call's own
    // trigger mints the `artifact_verification_records` row the card reads. This
    // walk never writes that row; it drives the pipeline that does.
    const runId = process.env.WALK_VERIFY_RUN_ID!;
    const { seedRepairVerification } = await import("@/lib/test-support/lifecycle-seed-drivers");
    const out = await seedRepairVerification({ orgId: ORG, actorId: USER, runId });
    saveState({
      [`verifyRunId_${SLOT}`]: runId,
      [`verifyRef_${SLOT}`]: out.ref,
      [`verifyGateId_${SLOT}`]: out.successorGateId,
      [`verifyTaskId_${SLOT}`]: out.successorTaskId,
    });
    say("VERIFY", { slot: SLOT, ...out });
  }

  if (STEP === "SEED_RUN_FOR_HOLD") {
    const TEMPLATE_PKG = process.env.WALK_TEMPLATE_PKG!;
    const [tpl] = await sql(
      `select id, package_name, lifecycle_config from "${schema}".agent_templates where package_name=$1 limit 1`,
      [TEMPLATE_PKG],
    );
    const id = randomUUID();
    await sql(
      `insert into "${schema}".agent_runs (id, template_id, status, input_params, source_type, org_id, run_by, human_present)
       values ($1,$2,'pending_input',$3,'agent_builder',$4,$5,true) on conflict (id) do nothing`,
      [id, tpl!.id, JSON.stringify({ prompt: process.env.WALK_PROMPT ?? "Draft the launch note." }), ORG, USER],
    );
    saveState({ [`holdRunId_${SLOT}`]: id, [`holdTemplateId_${SLOT}`]: String(tpl!.id) });
    say("SEED_RUN_FOR_HOLD", { slot: SLOT, runId: id, template: TEMPLATE_PKG });
  }

  if (STEP === "ASSIGN") {
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
      } as never);
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

  if (STEP === "HOLD") {
    const st = loadState();
    const { maybeHoldRunForRecommendation, readRecommendationParkForRun } = await import(
      "../../../packages/agents/src/recommendation-hold"
    );
    const [tplRow] = await sql(
      `select package_name, lifecycle_config from "${schema}".agent_templates where id=$1`,
      [st[`holdTemplateId_${SLOT}`]],
    );
    const runId = st[`holdRunId_${SLOT}`]!;
    const [runRow] = await sql(
      `select id, org_id, run_by, source_type, human_present, input_params from "${schema}".agent_runs where id=$1`,
      [runId],
    );
    const hold = await maybeHoldRunForRecommendation({
      run: {
        id: String(runRow!.id),
        orgId: String(runRow!.org_id),
        runBy: (runRow!.run_by as string | null) ?? null,
        sourceType: (runRow!.source_type as string | null) ?? null,
        humanPresent: runRow!.human_present as boolean | null,
        inputParams: runRow!.input_params as never,
      },
      template: {
        packageName: String(tplRow!.package_name),
        lifecycleConfig: (tplRow!.lifecycle_config as string | null) ?? null,
      },
    });
    const park = await readRecommendationParkForRun(runId);
    say("HOLD", {
      slot: SLOT,
      runId,
      packageName: String(tplRow!.package_name),
      hold,
      park: park ? { id: park.id, status: park.status, checkpoint: park.checkpoint } : null,
    });
  }

  if (STEP === "PROBE_RECS") {
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
          intent: { promptText: process.env.WALK_PROMPT ?? "Draft the launch note." },
        } as never)) as Array<{ recommended?: boolean }>;
        out.push({
          pkg,
          id: String(row.id),
          total: recs.length,
          recommended: recs.filter((r) => r.recommended !== false).length,
        });
      } catch {
        out.push({ pkg, id: String(row.id), total: -1, recommended: -1 });
      }
    }
    out.sort((a, b) => b.recommended - a.recommended || b.total - a.total);
    say("PROBE_RECS", {
      chipRowActive: act.isRecommendationChipRowHoldActive(),
      top: out.slice(0, 8),
    });
  }

  if (STEP === "READBACK") {
    const st = loadState();
    say("READBACK", {
      state: st,
      gates: await sql(
        `select id, run_id, review_task_id, status from "${schema}".artifact_review_gates order by created_at desc limit 10`,
      ),
      verifications: await sql(
        `select id, gate_id, outcome from "${schema}".artifact_verification_records order by created_at desc limit 10`,
      ),
      parks: await sql(
        `select run_id, checkpoint, status from "${schema}".lifecycle_continuation_park order by created_at desc limit 10`,
      ),
    });
  }
}

it("walk", async () => {
  await main();
}, 900_000);
