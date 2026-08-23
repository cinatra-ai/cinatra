/**
 * cinatra#2945 re-shoot lane — produce, on the LANE STACK, the two real states
 * the six re-shot cells are photographed on.
 *
 * ONE walk, several STEPs, every one of them a SHIPPED WRITER. Nothing here
 * decides a review, nothing writes a gate row, and nothing writes the
 * verification record: the writers do, and this file drives them in the order
 * the product drives them.
 *
 *   PRODUCE   `materializeBlogPostBodyArtifact` writes a real artifact under a
 *             real run, which puts a row in `artifact_produced_outbox`.
 *   GATE      `sweepReviewOrchestration` — the shipped sweep — mints the
 *             `artifact_review_gates` row and its review task.
 *   SUGGEST   `runSuggestionProducerLane` derives §VIII's before/after pairs
 *             from the artifact's OWN bytes and freezes them through
 *             `writeGateSuggestionSnapshot`. This is what makes a review open
 *             WITH suggestions, which is what the B cells photograph.
 *   CHANGES   `recordChangesRequested` — the reviewer's terminal decision that
 *             resolves the gate and OPENS the repair.
 *   REPAIR    a second real artifact write, then `submitRepairResponse`, whose
 *             own trigger writes `artifact_verification_records` AND runs the
 *             AUDIT lane (`runCoreAnalysisLane`) that attaches the advisory the
 *             G cells photograph. This walk never writes either row.
 *   READBACK  the lane's own rows, straight out of the database.
 *
 * THE PROJECTOR handed to the suggestion lane is the type-aware drop-in the lane
 * itself documents ("a type-aware projector that flattens a document's real
 * content is a drop-in that changes nothing else"), used exactly as
 * evidence/2852-before-after and evidence/2865-section-i-hierarchy use it: the
 * SHIPPED default projector can disclose nothing a rule can fire on, so it
 * produces no suggestion at all on a current schema. The DEFAULT_PROJECTOR
 * control step measures that rather than asserting it.
 *
 * THE REPAIR SUBJECT IS AUTHORIZED LIVE, before the terminal decision is
 * recorded, through the same `enforceReviewRunAccess` the read path runs — a
 * `changes_requested` is recorded as somebody's decision, and `reauthorized` on
 * the repair response is a measured verdict here, never a literal.
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

/**
 * The BODY the reviewed artifact carries. Deliberately NON-CANONICAL in two
 * different ways so the shipped producer has two real defects to find and the
 * card has chips to draw: section one carries per-line trailing whitespace, and
 * section two is wrapped in surrounding whitespace. Nothing else about it is
 * unusual — it is ordinary prose a writer would produce.
 */
const SEEDED_BODY = [
  "# Launch note",
  "",
  "## Summary   ",
  "The connector ships this week.   ",
  "It replaces the manual export step.",
  "",
  "## Rollout",
  "   Enable it per organization, then remove the old export job.   ",
  "",
].join("\n");

/** The REPAIRED body — what a producer answering the review's findings writes. */
const REPAIRED_BODY = [
  "# Launch note",
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
      title: process.env.WALK_ARTIFACT_TITLE ?? "Launch note",
      createdByRunId: runId,
    });
    saveState({
      [`runId_${SLOT}`]: runId,
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

  if (STEP === "SUGGEST") {
    const st = loadState();
    const artifactId = st[`artifactId_${SLOT}`];
    const revisionId = st[`revisionId_${SLOT}`];
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
      gateId: st[`gateId_${SLOT}`],
      target: { artifactId, representationRevisionId: revisionId },
      project,
    });
    const snap = await sql(
      `select id, gate_id, jsonb_array_length(payload->'suggestions') as n from "${schema}".gate_suggestion_snapshots where gate_id=$1`,
      [st[`gateId_${SLOT}`]],
    );
    say("SUGGEST", { slot: SLOT, outcome, snapshots: snap });
  }

  if (STEP === "DEFAULT_PROJECTOR_CONTROL") {
    const st = loadState();
    const { defaultSuggestionProjector } = await import(
      "../../../packages/agents/src/lifecycle-suggestion-producer-lane"
    );
    const { buildGateSuggestions } = await import("@/lib/lifecycle/lifecycle-suggestion-producer");
    const target = {
      artifactId: st[`artifactId_${SLOT}`],
      representationRevisionId: st[`revisionId_${SLOT}`],
    };
    const projected = await defaultSuggestionProjector(ORG)(target);
    const built = buildGateSuggestions({
      target,
      projection: projected.projection,
      authzDecision: projected.authzDecision,
    });
    say("DEFAULT_PROJECTOR_CONTROL", {
      includedFields: projected.projection.includedFields,
      authzDecision: projected.authzDecision,
      suggestionCount: built.suggestions.length,
    });
  }

  if (STEP === "REF") {
    const st = loadState();
    const { encodeLifecycleGateRef } = await import("@/lib/lifecycle/lifecycle-card-ref");
    const ref = encodeLifecycleGateRef({
      runId: st[`runId_${SLOT}`],
      reviewTaskId: st[`reviewTaskId_${SLOT}`],
    });
    if (!ref) throw new Error(`REF: the codec returned null for slot ${SLOT}`);
    saveState({ [`ref_${SLOT}`]: ref });
    say("REF", { slot: SLOT, refLength: ref.length });
  }

  // ---------------------------------------------------------------------------
  // THE AUDIT SLOT. The reviewer asks for changes, a producer answers, and the
  // repair response's own trigger writes the verification record and runs the
  // AUDIT lane that attaches the advisory. Every call is the shipped one.
  // ---------------------------------------------------------------------------
  if (STEP === "REPAIR") {
    const st = loadState();
    const runId = st[`runId_${SLOT}`];
    const gateId = st[`gateId_${SLOT}`];
    const reviewTaskId = st[`reviewTaskId_${SLOT}`];
    const baseTarget = {
      artifactId: st[`artifactId_${SLOT}`],
      representationRevisionId: st[`revisionId_${SLOT}`],
    };

    // THE READER'S LIVE STANDING, measured before the terminal decision is
    // recorded — the same two checks the read path runs when the card is drawn.
    const { readAgentRunById } = await import("@cinatra-ai/agents/store");
    const { enforceReviewRunAccess } = await import(
      "@cinatra-ai/agents/artifact-review-gate-store"
    );
    const { resolveActorGrantsForUserInOrg } = await import("@/lib/auth-session");
    const { buildWidgetLifecycleRoleHints } = await import(
      "@/lib/lifecycle/widget-lifecycle-frame-actor"
    );
    const run = await readAgentRunById(runId);
    if (!run || run.orgId !== ORG) throw new Error("REPAIR: the run is not this org's");
    const grants = await resolveActorGrantsForUserInOrg(USER, ORG);
    const actor = { actorType: "human" as const, source: "route" as const, userId: USER, orgId: ORG };
    const roleHints = buildWidgetLifecycleRoleHints({
      orgId: ORG,
      orgRole: grants.orgRole!,
      teamIds: grants.teamIds,
      teamRoles: grants.teamRoles,
      projectGrants: grants.projectGrants,
    });
    const [read, decide] = await Promise.all([
      enforceReviewRunAccess(runId, actor, "read", roleHints),
      enforceReviewRunAccess(runId, actor, "approveHitl", roleHints),
    ]);
    if (!read.ok || !decide.ok) {
      throw new Error(
        `REPAIR: refused — this reader may not read (${read.ok}) or decide (${decide.ok}) on the run`,
      );
    }

    const { recordChangesRequested, submitRepairResponse } = await import(
      "@cinatra-ai/agents/lifecycle-repair-store"
    );

    // THE REVIEWER'S FINDING — a label on a field of the reviewed revision.
    const findings = [
      {
        id: "f1",
        message: "the body carries stray whitespace; write it in its canonical form",
        path: "representation.form",
      },
    ];

    const requested = await recordChangesRequested({
      runId,
      reviewTaskId,
      orgId: ORG,
      request: {
        gateId,
        decisionId: `reshoot-decision-${randomUUID()}`,
        idempotencyKey: `reshoot-idem-${randomUUID()}`,
        baseTarget,
        expectedBaseRevisionId: baseTarget.representationRevisionId,
        findings,
        continuationMode: "async_effects_gated",
        continuationAddress: null,
      },
      repairCapable: true,
      producerRunId: runId,
      currentBaseRevisionId: baseTarget.representationRevisionId,
      decidedBy: USER,
    });
    if (!requested.ok) {
      throw new Error(`REPAIR: recordChangesRequested refused (${requested.code}): ${requested.error}`);
    }

    // THE REPAIRED REVISION — a second real artifact write, so the verification
    // has two genuinely different revisions to project and diff.
    const { materializeBlogPostBodyArtifact } = await import("@/lib/blog-post-artifact-materializer");
    const successor = await materializeBlogPostBodyArtifact({
      content: REPAIRED_BODY,
      title: process.env.WALK_ARTIFACT_TITLE ?? "Launch note",
      createdByRunId: runId,
    });

    const responded = await submitRepairResponse({
      repairId: requested.repairId,
      currentBaseRevisionId: baseTarget.representationRevisionId,
      reauthorized: read.ok,
      response: {
        gateId,
        baseTarget,
        successorTarget: {
          artifactId: successor.artifactId,
          representationRevisionId: successor.representationRevisionId,
        },
        findingOutcomes: findings.map((f) => ({ findingId: f.id, applied: true })),
        changeSummary: "the body is written in its canonical form",
        producerProvenance: { runId, agentId: null },
      },
    });
    if (!responded.ok) {
      throw new Error(`REPAIR: submitRepairResponse refused (${responded.code}): ${responded.error}`);
    }

    // READ BACK through the shipped read port. The verification trigger is
    // best-effort by design, so "the pipeline returned ok" is NOT evidence the
    // record exists — only this read is.
    const { readVerificationRecordForGate } = await import(
      "@cinatra-ai/agents/lifecycle-verification-store"
    );
    const record = await readVerificationRecordForGate(responded.successorGateId);
    const advisories = await sql(
      `select id, author_id, author_kind, left(body, 240) as body_head
         from "${schema}".gate_advisory_comments where gate_id=$1`,
      [responded.successorGateId],
    );
    saveState({
      [`successorGateId_${SLOT}`]: responded.successorGateId,
      [`successorTaskId_${SLOT}`]: responded.successorTaskId,
      [`successorArtifactId_${SLOT}`]: successor.artifactId,
      [`successorRevisionId_${SLOT}`]: successor.representationRevisionId,
    });
    say("REPAIR", {
      slot: SLOT,
      repairId: requested.repairId,
      successorGateId: responded.successorGateId,
      successorTaskId: responded.successorTaskId,
      verificationRecordPresent: record !== null,
      verificationOutcome: record?.outcome ?? null,
      advisories,
    });
  }

  if (STEP === "READBACK") {
    const st = loadState();
    say("READBACK", {
      state: st,
      gates: await sql(
        `select id, run_id, review_task_id, status, disposition from "${schema}".artifact_review_gates order by created_at`,
      ),
      verifications: await sql(
        `select id, gate_id, outcome from "${schema}".artifact_verification_records`,
      ),
      advisories: await sql(
        `select id, gate_id, author_id, author_kind from "${schema}".gate_advisory_comments`,
      ),
    });
  }
}

it("walk", async () => {
  await main();
});
