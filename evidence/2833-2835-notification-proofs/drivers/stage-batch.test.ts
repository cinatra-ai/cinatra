/**
 * cinatra#2833 — stage the SUBJECT of the BATCH-gate proof on the lane's own dev
 * stack, and nothing else.
 *
 * WHAT THIS WRITES — all of it fixture, none of it the mechanism under proof:
 *   - one `agent_runs` row through the shipped `createAgentRun`, owned by the
 *     REAL signed-up owner and their org, so the notification has a genuine
 *     initiator to address and the capture session can actually open it;
 *   - three `objects` rows, and three `artifact_produced_outbox` rows through the
 *     shipped `emitArtifactProduced`, all naming that ONE run with
 *     `origin_kind = agent_produced` (the origin the core policy fires review
 *     for). This is the same subject shape the package's own
 *     `lifecycle-review-orchestration.integration.test.ts` stages.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it never calls the orchestration sweep,
 * never emits a gate, and never touches the notifier. Three pending
 * agent-produced events on one run is exactly the shape
 * `orchestrateProducedBatch()` claims, and the RUNNING APPLICATION's own
 * 30-second review-orchestration loop is what picks them up. The gate opening,
 * the notifier dispatch and the notification row are therefore produced by the
 * shipped, boot-registered path inside the live process — not by this driver.
 *
 * The `objects` rows are written directly rather than through
 * `createSemanticArtifact` because the artifact-type registry is populated by
 * EXTENSION ACTIVATION at app boot, which a headless driver process does not run;
 * `createSemanticArtifact` correctly refuses a type it cannot see. The rows carry
 * only what review-context resolution reads, which is the same concession the
 * package's own integration tier makes.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { it, expect } from "vitest";

const ORG = process.env.PROOF_ORG_ID!;
const ACTOR = process.env.PROOF_ACTOR_ID!;
const TEMPLATE = process.env.PROOF_TEMPLATE_ID!;
const OUT = process.env.PROOF_OUT!;
const OBJECT_TYPE = process.env.PROOF_OBJECT_TYPE!;
// 0 = create the run only, and let the artifacts come from the app's own
// `createSemanticArtifact` (through the shipped development seed route) so the
// batch's targets carry REAL representations and the gate is decidable.
const EVENT_COUNT = Number(process.env.PROOF_EVENT_COUNT ?? "3");

it("stages one run and three agent-produced events for the batch partition", async () => {
  expect(ORG && ACTOR && TEMPLATE && OUT && OBJECT_TYPE).toBeTruthy();

  const { sessionAuthorityFromResolvedRole } = await import("@/lib/org-write/authority");
  const { createAgentRun } = await import("@cinatra-ai/agents");
  const { producedEventId } = await import("@/lib/lifecycle/lifecycle-produced-event");
  const dbMod = await import("@cinatra-ai/agents/db");
  // Not on the package barrel (the outbox store is an internal seam), so it is
  // reached the same way the package's own integration tests reach it — by path
  // into the shipped module, never by a re-implementation of its insert.
  const outbox = await import("../../../packages/agents/src/lifecycle-produced-outbox-store");
  const { sql } = await import("drizzle-orm");
  const { postgresSchema } = await import("@/lib/postgres-config");
  const objectsTable = sql.raw(`"${postgresSchema.replaceAll('"', '""')}"."objects"`);

  const runId = randomUUID();
  await createAgentRun(
    {
      id: runId,
      templateId: TEMPLATE,
      orgId: ORG,
      runBy: ACTOR,
      inputParams: {},
      title: "Quarterly report pack",
      sourceType: "agent_builder",
    },
    sessionAuthorityFromResolvedRole(ORG, "org_owner"),
  );

  const events: string[] = [];
  for (const title of [
    "Quarterly report pack — summary",
    "Quarterly report pack — figures",
    "Quarterly report pack — appendix",
  ].slice(0, EVENT_COUNT)) {
    const artifactId = randomUUID();
    const representationRevisionId = randomUUID();
    await dbMod.db.execute(sql`
      INSERT INTO ${objectsTable} (id, type, data, org_id, created_by, run_id)
      VALUES (${artifactId}, ${OBJECT_TYPE}, ${JSON.stringify({ title })}::jsonb, ${ORG}, ${ACTOR}, ${runId})
      ON CONFLICT (id) DO NOTHING
    `);
    const ev = {
      eventId: producedEventId(artifactId, representationRevisionId),
      orgId: ORG,
      artifactId,
      representationRevisionId,
      eventKind: "artifact_produced",
      emitter: "createSemanticArtifact",
      producerRunId: runId,
      producerAgentId: null,
      originKind: "agent_produced",
      destinationClass: "none",
      continuationMode: "async_effects_gated",
      continuationAddress: null,
    } as const;
    await outbox.emitArtifactProduced(ev, dbMod.db);
    events.push(ev.eventId);
  }

  const staged = { runId, templateId: TEMPLATE, orgId: ORG, actorId: ACTOR, objectType: OBJECT_TYPE, events };
  writeFileSync(OUT, JSON.stringify(staged, null, 2) + "\n");
  console.log("STAGED", JSON.stringify(staged));
});
