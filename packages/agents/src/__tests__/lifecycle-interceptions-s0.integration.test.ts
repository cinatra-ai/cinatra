/**
 * cinatra#2038 (epic #2037 S0) — REAL-store proofs of the lifecycle-interceptions
 * foundation persistence, against real DDL + constraints (fresh schema per file
 * from the CANONICAL `buildCreateStoreSchemaQueries` bootstrap — the migration
 * core__0079 twin):
 *
 *   POLICY   — upsert an org bound; resolve exact + wildcard + silent; delete.
 *   OUTBOX   — same-transaction atomicity (a rolled-back caller tx leaves NO event
 *              row; a committed one persists it); idempotency under replay (a
 *              re-emit of the deterministic id is a no-op); the sweeper detects a
 *              SUPPRESSED emit.
 *   PARK     — evaluate-then-park: a policy-SKIP proceeds with NO park row; a
 *              policy-FIRE parks; the sweeper RELEASES a decision-resolved park;
 *              the sweeper TTL-fail-closes an expired park into policy_unresolved
 *              (ops-surfaced); a forced-strand of a live park FAILS.
 *   DEAD-LTR — a resume intent that exhausts its max attempts is DEAD-LETTERED,
 *              excluded from the claim set, and surfaced in ops visibility.
 *   ADVISORY — the decision-free advisory seam attaches idempotently + lists.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm --filter @cinatra-ai/agents test:integration lifecycle-interceptions
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { eq, sql } from "drizzle-orm";

// Pure cores are statically imported (no env/db at load). Env-dependent store/db/
// schema modules are dynamic-imported AFTER SUPABASE_SCHEMA is set in beforeAll.
import { evaluatePolicy } from "@/lib/lifecycle/lifecycle-policy";
import { evaluateThenPark } from "@/lib/lifecycle/lifecycle-continuation";
import { producedEventId, type ArtifactProducedEvent } from "@/lib/lifecycle/lifecycle-produced-event";

const TEST_SCHEMA = "cinatra_test_lifecycle_2038";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2038-lifecycle";

let policyStore: typeof import("../lifecycle-policy-store");
let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let parkStore: typeof import("../lifecycle-continuation-park-store");
let advisoryStore: typeof import("../lifecycle-advisory-store");
let gateStore: typeof import("../artifact-review-gate-store");
let dbMod: typeof import("../db");
let schemaMod: typeof import("../schema");

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  policyStore = await import("../lifecycle-policy-store");
  outboxStore = await import("../lifecycle-produced-outbox-store");
  parkStore = await import("../lifecycle-continuation-park-store");
  advisoryStore = await import("../lifecycle-advisory-store");
  gateStore = await import("../artifact-review-gate-store");
  dbMod = await import("../db");
  schemaMod = await import("../schema");
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

function mkEvent(over: Partial<ArtifactProducedEvent> = {}): ArtifactProducedEvent {
  const artifactId = over.artifactId ?? `art-${randomUUID()}`;
  const representationRevisionId = over.representationRevisionId ?? `rev-${randomUUID()}`;
  return {
    eventId: producedEventId(artifactId, representationRevisionId),
    orgId: ORG,
    artifactId,
    representationRevisionId,
    eventKind: "artifact_produced",
    emitter: "createSemanticArtifact",
    producerRunId: `run-${randomUUID()}`,
    producerAgentId: "agent-x",
    originKind: "agent_produced",
    destinationClass: "none",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
}

describe.skipIf(!HAS_DB)("cinatra#2038 — lifecycle-interceptions S0 (real store)", () => {
  // -------------------------------------------------------------------------
  // POLICY store.
  // -------------------------------------------------------------------------
  it("POLICY: upsert → resolve (exact + wildcard + silent) → delete", async () => {
    // silent when no rule.
    const silent = await policyStore.resolveOrgPolicyRule(ORG, {
      checkpoint: "review", artifactType: "document", destinationClass: "none", originKind: "agent_produced",
    });
    expect(silent.bound).toBe("silent");

    // exact 'required'.
    await policyStore.upsertLifecyclePolicyRule({
      orgId: ORG, checkpoint: "review", artifactType: "document", destinationClass: "none", originKind: "agent_produced", bound: "required",
    });
    const exact = await policyStore.resolveOrgPolicyRule(ORG, {
      checkpoint: "review", artifactType: "document", destinationClass: "none", originKind: "agent_produced",
    });
    expect(exact.bound).toBe("required");

    // wildcard artifact-type for a DIFFERENT type resolves the '*' rule.
    await policyStore.upsertLifecyclePolicyRule({
      orgId: ORG, checkpoint: "review", artifactType: policyStore.POLICY_ARTIFACT_TYPE_WILDCARD, destinationClass: "none", originKind: "agent_produced", bound: "forbidden",
    });
    const wildcard = await policyStore.resolveOrgPolicyRule(ORG, {
      checkpoint: "review", artifactType: "spreadsheet", destinationClass: "none", originKind: "agent_produced",
    });
    expect(wildcard.bound).toBe("forbidden");
    // exact still beats wildcard for 'document'.
    const stillExact = await policyStore.resolveOrgPolicyRule(ORG, {
      checkpoint: "review", artifactType: "document", destinationClass: "none", originKind: "agent_produced",
    });
    expect(stillExact.bound).toBe("required");

    // the resolved rule drives the pure evaluator end-to-end.
    const decision = evaluatePolicy({
      checkpoint: "review", artifactType: "document", destinationClass: "none", originKind: "agent_produced",
      humanPresent: true, orgRule: stillExact,
    });
    expect(decision.outcome).toBe("required");

    // delete the EXACT rule → 'document' now falls back to the '*' wildcard
    // ('forbidden'), proving specificity + the fallback are both live.
    await policyStore.deleteLifecyclePolicyRule({
      orgId: ORG, checkpoint: "review", artifactType: "document", destinationClass: "none", originKind: "agent_produced",
    });
    const fellBack = await policyStore.resolveOrgPolicyRule(ORG, {
      checkpoint: "review", artifactType: "document", destinationClass: "none", originKind: "agent_produced",
    });
    expect(fellBack.bound).toBe("forbidden");
    // delete the wildcard too → fully silent.
    await policyStore.deleteLifecyclePolicyRule({
      orgId: ORG, checkpoint: "review", artifactType: policyStore.POLICY_ARTIFACT_TYPE_WILDCARD, destinationClass: "none", originKind: "agent_produced",
    });
    const afterDelete = await policyStore.resolveOrgPolicyRule(ORG, {
      checkpoint: "review", artifactType: "document", destinationClass: "none", originKind: "agent_produced",
    });
    expect(afterDelete.bound).toBe("silent");
  });

  // -------------------------------------------------------------------------
  // OUTBOX — same-transaction atomicity.
  // -------------------------------------------------------------------------
  it("OUTBOX: an emit rolls back with the caller's transaction (zero partial write)", async () => {
    const event = mkEvent();
    // Emit inside a tx that THROWS — the event must roll back with it.
    await expect(
      dbMod.db.transaction(async (tx) => {
        await outboxStore.emitArtifactProduced(event, tx);
        throw new Error("caller aborts");
      }),
    ).rejects.toThrow("caller aborts");
    const absent = await outboxStore.readProducedEvent(event.eventId);
    expect(absent).toBeNull();

    // A committing tx persists it.
    await dbMod.db.transaction(async (tx) => {
      await outboxStore.emitArtifactProduced(event, tx);
    });
    const present = await outboxStore.readProducedEvent(event.eventId);
    expect(present).not.toBeNull();
    expect(present?.emitter).toBe("createSemanticArtifact");
  });

  it("OUTBOX: a re-emit of the deterministic id is idempotent (no duplicate)", async () => {
    const event = mkEvent();
    const first = await outboxStore.emitArtifactProduced(event, dbMod.db);
    expect(first.inserted).toBe(true);
    const second = await outboxStore.emitArtifactProduced(event, dbMod.db);
    expect(second.inserted).toBe(false);
    expect(second.eventId).toBe(first.eventId);
  });

  it("OUTBOX: the sweeper detects a SUPPRESSED emit", async () => {
    const emitted = mkEvent();
    const suppressed = mkEvent();
    await outboxStore.emitArtifactProduced(emitted, dbMod.db);
    // suppressed is NOT emitted — the sweeper must report it missing.
    const missed = await outboxStore.findMissedProducedEmits([
      { artifactId: emitted.artifactId, representationRevisionId: emitted.representationRevisionId },
      { artifactId: suppressed.artifactId, representationRevisionId: suppressed.representationRevisionId },
    ]);
    expect(missed).toHaveLength(1);
    expect(missed[0].artifactId).toBe(suppressed.artifactId);
  });

  // -------------------------------------------------------------------------
  // PARK — checkpointed continuation.
  // -------------------------------------------------------------------------
  it("PARK: a policy-SKIP proceeds with NO park row", async () => {
    const runId = `run-${randomUUID()}`;
    const eventId = producedEventId(`art-${randomUUID()}`, "rev-1");
    const decision = evaluatePolicy({
      checkpoint: "review", artifactType: "doc", destinationClass: "none", originKind: "intermediate",
      humanPresent: true, orgRule: { bound: "silent" },
    });
    expect(decision.fired).toBe(false); // intermediate review default = skip
    const out = evaluateThenPark(decision, { checkpoint: "review", destinationClass: "none" });
    const res = await parkStore.maybeParkCheckpoint(out, { runId, eventId });
    expect(res.parked).toBe(false);
  });

  it("PARK: a policy-FIRE parks; the sweeper releases a decision-resolved park", async () => {
    const runId = `run-${randomUUID()}`;
    const eventId = producedEventId(`art-${randomUUID()}`, "rev-1");
    const decision = evaluatePolicy({
      checkpoint: "review", artifactType: "doc", destinationClass: "none", originKind: "agent_produced",
      humanPresent: true, orgRule: { bound: "silent" },
    });
    const out = evaluateThenPark(decision, { checkpoint: "review", destinationClass: "none" });
    const res = await parkStore.maybeParkCheckpoint(out, { runId, eventId, ttlMs: 60_000 });
    expect(res.parked).toBe(true);
    if (!res.parked) throw new Error("expected park");
    const sweep = await parkStore.sweepParks({ resolvedSkipParkIds: [res.parkId] });
    expect(sweep.released).toBe(1);
    const park = await parkStore.readPark(res.parkId);
    expect(park?.status).toBe("released");
  });

  it("PARK: the sweeper TTL-fail-closes an expired park into policy_unresolved (ops-surfaced)", async () => {
    const runId = `run-${randomUUID()}`;
    const eventId = producedEventId(`art-${randomUUID()}`, "rev-1");
    // An unevaluable external-effect verification → parks WITH a reevaluation
    // intent; a 1ms TTL means it is already due on the next sweep.
    const decision = evaluatePolicy({
      checkpoint: "verification", artifactType: "doc", destinationClass: "pipeline_handoff", originKind: "agent_produced",
      humanPresent: true, orgRule: { bound: "silent" },
    });
    expect(decision.outcome).toBe("policy_unresolved");
    const out = evaluateThenPark(decision, { checkpoint: "verification", destinationClass: "pipeline_handoff" });
    const res = await parkStore.maybeParkCheckpoint(out, { runId, eventId, ttlMs: 1 });
    expect(res.parked).toBe(true);
    if (!res.parked) throw new Error("expected park");
    // Give the 1ms TTL a moment to pass, then sweep.
    await new Promise((r) => setTimeout(r, 20));
    const sweep = await parkStore.sweepParks({});
    expect(sweep.blocked).toBeGreaterThanOrEqual(1);
    const park = await parkStore.readPark(res.parkId);
    expect(park?.status).toBe("policy_unresolved");
    const ops = await parkStore.readPolicyUnresolvedParks();
    expect(ops.some((p) => p.id === res.parkId)).toBe(true);
  });

  it("PARK: the TTL sweep honors `limit` and reports the ACTUAL transitioned count", async () => {
    const eventId = producedEventId(`art-${randomUUID()}`, "rev-1");
    const decision = evaluatePolicy({
      checkpoint: "verification", artifactType: "doc", destinationClass: "pipeline_handoff", originKind: "agent_produced",
      humanPresent: true, orgRule: { bound: "silent" },
    });
    const out = evaluateThenPark(decision, { checkpoint: "verification", destinationClass: "pipeline_handoff" });
    // Two distinct due parks (different runs) sharing the eventId.
    const r1 = await parkStore.maybeParkCheckpoint(out, { runId: `run-${randomUUID()}`, eventId, ttlMs: 1 });
    const r2 = await parkStore.maybeParkCheckpoint(out, { runId: `run-${randomUUID()}`, eventId, ttlMs: 1 });
    expect(r1.parked && r2.parked).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const first = await parkStore.sweepParks({ limit: 1 });
    expect(first.blocked).toBe(1); // limit honored, accurate count
    const second = await parkStore.sweepParks({ limit: 1 });
    expect(second.blocked).toBe(1);
  });

  it("PARK: a forced-strand of a LIVE park fails; a terminal park is strippable", async () => {
    const runId = `run-${randomUUID()}`;
    const eventId = producedEventId(`art-${randomUUID()}`, "rev-1");
    const decision = evaluatePolicy({
      checkpoint: "review", artifactType: "doc", destinationClass: "none", originKind: "agent_produced",
      humanPresent: true, orgRule: { bound: "required" },
    });
    const out = evaluateThenPark(decision, { checkpoint: "review", destinationClass: "none" });
    const res = await parkStore.maybeParkCheckpoint(out, { runId, eventId, ttlMs: 60_000 });
    if (!res.parked) throw new Error("expected park");
    await expect(parkStore.strandPark(res.parkId)).rejects.toThrow(/live park cannot be stranded/);
    // Resolve it, then it is strippable.
    await parkStore.sweepParks({ releasedParkIds: [res.parkId] });
    await parkStore.strandPark(res.parkId);
    expect(await parkStore.readPark(res.parkId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // DEAD-LETTER — resume outbox max-attempts.
  // -------------------------------------------------------------------------
  it("DEAD-LETTER: a resume intent that exhausts its attempts is dead-lettered, un-claimable, ops-surfaced", async () => {
    // A resume intent FKs a gate — emit a real gate, then seed the outbox row
    // directly with a max_attempts of 1 (the smallest ceiling).
    const runId = `run-${randomUUID()}`;
    const reviewTaskId = `wayflow-${randomUUID()}`;
    const gate = await gateStore.emitArtifactReviewGate({
      runId, orgId: ORG, reviewTaskId,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-1" }],
    });
    await dbMod.db.insert(schemaMod.artifactReviewResumeOutbox).values({
      gateId: gate.gateId, runId, reviewTaskId,
      kind: "approve", responseText: "approved", status: "pending",
      attempts: 0, maxAttempts: 1,
    });
    // One claim increments attempts to 1 (== max) and leases the row. The
    // exhausted row is only dead-lettered once that in-flight lease EXPIRES — a
    // live-leased attempt is left to finish.
    const claimed = await gateStore.claimPendingResumeIntents({ leaseMs: 60_000 });
    expect(claimed.some((c) => c.gateId === gate.gateId)).toBe(true);
    // A live-leased exhausted row is NOT yet dead-letterable.
    const tooEarly = await gateStore.deadLetterExhaustedResumeIntents({ lastError: "test exhaustion" });
    expect(tooEarly).toBe(0);
    // Force the lease to expire (a crashed/gave-up worker) — deterministic, no wait.
    await dbMod.db
      .update(schemaMod.artifactReviewResumeOutbox)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(schemaMod.artifactReviewResumeOutbox.gateId, gate.gateId));
    // Now the exhausted, lease-expired intent dead-letters.
    const deadCount = await gateStore.deadLetterExhaustedResumeIntents({ lastError: "test exhaustion" });
    expect(deadCount).toBeGreaterThanOrEqual(1);
    // It is surfaced in ops visibility.
    const dead = await gateStore.readDeadLetteredResumeIntents();
    expect(dead.some((d) => d.gateId === gate.gateId)).toBe(true);
    // And it is NEVER re-claimed (even after its lease expires).
    await new Promise((r) => setTimeout(r, 20));
    const reclaim = await gateStore.claimPendingResumeIntents({ leaseMs: 1000 });
    expect(reclaim.some((c) => c.gateId === gate.gateId)).toBe(false);
  });

  it("DEAD-LETTER: an exhausted `delivering` row with NO lease (NULL) is dead-lettered, not left stuck", async () => {
    // A `delivering` strand whose lease is NULL has no in-flight worker (nothing
    // holds it) yet the lease-expiry test `lease <= now` is NULL, not true — so
    // without the isNull branch it is neither re-claimable NOR dead-letterable
    // (stuck forever). The safety net must catch it.
    const runId = `run-${randomUUID()}`;
    const reviewTaskId = `wayflow-${randomUUID()}`;
    const gate = await gateStore.emitArtifactReviewGate({
      runId, orgId: ORG, reviewTaskId,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-1" }],
    });
    await dbMod.db.insert(schemaMod.artifactReviewResumeOutbox).values({
      gateId: gate.gateId, runId, reviewTaskId,
      kind: "approve", responseText: "approved",
      status: "delivering", leaseToken: null, leaseExpiresAt: null,
      attempts: 1, maxAttempts: 1,
    });
    const deadCount = await gateStore.deadLetterExhaustedResumeIntents({ lastError: "unleased strand" });
    expect(deadCount).toBeGreaterThanOrEqual(1);
    const dead = await gateStore.readDeadLetteredResumeIntents();
    expect(dead.some((d) => d.gateId === gate.gateId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // ADVISORY — the decision-free seam.
  // -------------------------------------------------------------------------
  it("ADVISORY: attach is idempotent per (gate, key) and list returns the comment", async () => {
    const runId = `run-${randomUUID()}`;
    const reviewTaskId = `wayflow-${randomUUID()}`;
    const gate = await gateStore.emitArtifactReviewGate({
      runId, orgId: ORG, reviewTaskId,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-1" }],
    });
    const req = {
      gateId: gate.gateId,
      author: { id: "advisor-1", kind: "agent" as const },
      body: "the second paragraph reads awkwardly",
      idempotencyKey: "advice-1",
      runCausation: runId,
    };
    const first = await advisoryStore.attachAdvisoryComment(req);
    expect(first.created).toBe(true);
    const again = await advisoryStore.attachAdvisoryComment(req);
    expect(again.created).toBe(false);
    expect(again.comment.id).toBe(first.comment.id);
    const list = await advisoryStore.listAdvisoryComments(gate.gateId);
    expect(list).toHaveLength(1);
    expect(list[0].authorId).toBe("advisor-1");
  });
});
