/**
 * cinatra#1796 (epic #1620 S13) — the generic artifact-review GATE store.
 * REAL-store proof of the persistence half of the #1795/#1807 review surface:
 * the emitting gate PINS immutable targets, and the DECISION core's atomic
 * commit resolves the gate (CAS) transactionally with the audit rows, the
 * reject→tombstone disposition record, and the exactly-once-persisted resume
 * intent (at-least-once delivery).
 *
 * Proves, against real DDL + constraints (fresh schema per file from the
 * CANONICAL `buildCreateStoreSchemaQueries` bootstrap — the migration-0072 twin):
 *   PIN     — emit pins a pending gate with the canonical frozen target set;
 *             re-emit of the SAME set is idempotent, a DIFFERENT set fail-closed;
 *             readGatePinnedTargets / readReviewGateState reflect pending.
 *   DECIDE  — submitReviewDecisionCore drives the REAL commit end-to-end:
 *   CAS       an approve resolves the gate (status→resolved, fingerprint +
 *             disposition stamped) …
 *   AUDIT     … with one audit row per reviewed revision carrying the reviewed
 *             revision + the (host-supplied) renderer provenance (build-map /
 *             runtime+digest / floor) …
 *   RESUME    … and exactly ONE resume outbox intent (kind-discriminated;
 *   -INTENT   approve-envelope asserts approval, reject-envelope does NOT).
 *   REJECT  — records a tombstone disposition per target (applied_at NULL,
 *             never a hard delete).
 *   IDEMPOTENT — a response-lost retry of the SAME decision is idempotent
 *             (no duplicate audit/outbox rows; plan null).
 *   CONFLICT  — a DIFFERENT decision on a resolved gate fails closed
 *             (gate-conflict; the store is unchanged).
 *   COMMENT — a non-terminal comment annotates without resolving the gate.
 *   ROLLBACK  — a mid-transaction persistence failure rolls back the CAS too
 *             (zero partial commit).
 *   DRAIN   — the resume outbox lease is mutually exclusive (a live-leased row is
 *             not re-claimed; a stale lease cannot mark it delivered).
 *   ACCESS  — enforceReviewRunAccess grants the run owner and denies a foreign
 *             actor against a real seeded run.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_DB_INTEGRATION_TESTS=1 \
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm --filter @cinatra-ai/agents test artifact-review-gate-store
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

// The review DECISION + REJECTION cores are PURE (no env / db at module load), so
// they are statically imported — types AND runtime values. Only the env-dependent
// store / db / schema modules (which read SUPABASE_SCHEMA / SUPABASE_DB_URL at
// module load) are dynamic-imported AFTER SUPABASE_SCHEMA is set in beforeAll.
import {
  submitReviewDecisionCore,
  ARTIFACT_REVIEW_DECISION_API_VERSION,
  type SubmitDecisionPorts,
  type ReviewRendererProvenance,
  type ArtifactReviewDecision,
  type ReviewDisposition,
  type ReviewDecisionCommitPlan,
} from "@/lib/artifacts/artifact-review-decision";
import { payloadAssertsApproval } from "@/lib/artifacts/artifact-review-rejection";

const TEST_SCHEMA = "cinatra_test_review_gate_1796";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-1796-review-gate";

let gateStore: typeof import("../artifact-review-gate-store");
let store: typeof import("../store");
let dbMod: typeof import("../db");
let client: Client;

type Target = { artifactId: string; representationRevisionId: string };

function freshGateIds(): { runId: string; reviewTaskId: string } {
  return { runId: `run-${randomUUID()}`, reviewTaskId: `wayflow-${randomUUID()}` };
}

/** A decision-core port harness over the REAL store commit + gate state. The
 *  artifact-side ports (verifyRunAccess / revisionMember / deriveProvenance) are
 *  faked — this suite proves the STORE (CAS + audit + outbox), not the #1807
 *  artifact resolution the core already tests. */
function makeDecidePorts(opts?: {
  members?: Set<string>; // target keys that are live members (default: all)
  provenance?: Record<string,  ReviewRendererProvenance>;
  actingActorId?: string | null;
}):  SubmitDecisionPorts {
  return {
    verifyRunAccess: async () => ({ ok: true }),
    // cinatra#2047 D-2: the DECIDING actor the store now stamps on `resolved_by`.
    // Overridable so a suite can decide as a named actor.
    actingActorId: () => (opts && "actingActorId" in opts ? opts.actingActorId ?? null : "user-decider"),
    readGateState: (runId, reviewTaskId) => gateStore.readReviewGateState(runId, reviewTaskId),
    revisionMember: async (artifactId, revId) => {
      if (opts?.members && !opts.members.has(`${artifactId}::${revId}`)) return null;
      return { mime: "text/plain" };
    },
    deriveProvenance: async (target) =>
      opts?.provenance?.[target.artifactId] ?? {
        kind: "build-map",
        packageName: "@cinatra-ai/default-artifact",
        digest: null,
      },
    commit: (plan) => gateStore.commitReviewDecision(plan),
  };
}

function mkDecision(input: {
  runId: string;
  reviewTaskId: string;
  disposition:  ReviewDisposition;
  targets: Target[];
  comment?: string | null;
}):  ArtifactReviewDecision {
  return {
    decisionApiVersion:  ARTIFACT_REVIEW_DECISION_API_VERSION,
    runId: input.runId,
    reviewTaskId: input.reviewTaskId,
    disposition: input.disposition,
    comment: input.comment ?? null,
    reviewedTargets: input.targets,
  };
}

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

  gateStore = await import("../artifact-review-gate-store");
  store = await import("../store");
  dbMod = await import("../db");
  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.end().catch(() => {});
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#1796 — artifact-review gate store (real store)", () => {
  // -------------------------------------------------------------------------
  // PIN — the emitting gate.
  // -------------------------------------------------------------------------
  it("PIN: emits a pending gate with the canonical frozen target set", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const a1 = `art-${randomUUID()}`;
    const a2 = `art-${randomUUID()}`;
    // Deliberately UNSORTED + duplicated on input — emit canonicalizes + dedupes.
    const emit = await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId,
      targets: [
        { artifactId: a2, representationRevisionId: "rev-2" },
        { artifactId: a1, representationRevisionId: "rev-1" },
        { artifactId: a2, representationRevisionId: "rev-2" },
      ],
    });
    expect(emit.idempotent).toBe(false);
    expect(emit.targets).toHaveLength(2); // deduped

    const pinned = await gateStore.readGatePinnedTargets(runId, reviewTaskId);
    expect(pinned.status).toBe("pending");
    const state = await gateStore.readReviewGateState(runId, reviewTaskId);
    expect(state.status).toBe("pending");
  });

  it("PIN: re-emit of the SAME set is idempotent; a DIFFERENT set fails closed", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets = [{ artifactId: art, representationRevisionId: "rev-1" }];
    const first = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });
    const again = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });
    expect(again.idempotent).toBe(true);
    expect(again.gateId).toBe(first.gateId);

    await expect(
      gateStore.emitArtifactReviewGate({
        runId,
        orgId: ORG,
        reviewTaskId,
        targets: [{ artifactId: art, representationRevisionId: "rev-DIFFERENT" }],
      }),
    ).rejects.toMatchObject({ code: "pin-conflict" });
  });

  it("PIN: a re-emit of the same set for a DIFFERENT org fails closed (never re-tagged)", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const targets = [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-1" }];
    await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });
    await expect(
      gateStore.emitArtifactReviewGate({ runId, orgId: "org-OTHER", reviewTaskId, targets }),
    ).rejects.toMatchObject({ code: "pin-conflict" });
  });

  it("PIN: an unknown gate reads not-found / unavailable (existence not leaked)", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    expect((await gateStore.readGatePinnedTargets(runId, reviewTaskId)).status).toBe("not-found");
    expect((await gateStore.readReviewGateState(runId, reviewTaskId)).status).toBe("unavailable");
  });

  // -------------------------------------------------------------------------
  // DECIDE → CAS → AUDIT → RESUME-INTENT (the full path, real commit).
  // -------------------------------------------------------------------------
  it("APPROVE: resolves the gate (CAS), writes audit rows with provenance, and enqueues ONE approve resume intent", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const aBuild = `art-${randomUUID()}`;
    const aRuntime = `art-${randomUUID()}`;
    const targets: Target[] = [
      { artifactId: aBuild, representationRevisionId: "rev-b" },
      { artifactId: aRuntime, representationRevisionId: "rev-r" },
    ];
    const emit = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    const ports = makeDecidePorts({
      provenance: {
        [aBuild]: { kind: "build-map", packageName: "@cinatra-ai/email-artifacts", digest: null },
        [aRuntime]: { kind: "runtime", packageName: "@cinatra-ai/blog-post-artifact", digest: "sha256:deadbeef" },
      },
    });
    const res = await  submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "approve", targets }),
      ports,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.idempotent).toBe(false);

    // CAS: gate resolved, fingerprint + disposition stamped.
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate?.status).toBe("resolved");
    expect(gate?.disposition).toBe("approve");
    expect(gate?.fingerprint).toBe(res.fingerprint);

    // AUDIT: one row per reviewed revision, revision + provenance captured.
    const audit = await gateStore.readGateAuditRows(emit.gateId);
    expect(audit).toHaveLength(2);
    const buildRow = audit.find((r) => r.artifactId === aBuild)!;
    expect(buildRow.representationRevisionId).toBe("rev-b");
    expect(buildRow.rendererKind).toBe("build-map");
    expect(buildRow.rendererPackage).toBe("@cinatra-ai/email-artifacts");
    expect(buildRow.rendererDigest).toBeNull();
    const runtimeRow = audit.find((r) => r.artifactId === aRuntime)!;
    expect(runtimeRow.rendererKind).toBe("runtime");
    expect(runtimeRow.rendererDigest).toBe("sha256:deadbeef");

    // RESUME-INTENT: exactly one; approve-discriminated; asserts approval.
    const intent = await gateStore.readResumeIntent(emit.gateId);
    expect(intent?.kind).toBe("approve");
    expect(intent?.status).toBe("pending");
    expect(payloadAssertsApproval(JSON.parse(intent!.responseText))).toBe(true);

    // No dispositions on approve.
    expect(await gateStore.readGateDispositions(emit.gateId)).toHaveLength(0);
  });

  it("REJECT: records a tombstone disposition per target (applied_at NULL) + a reject resume intent that never reads as approval", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets: Target[] = [{ artifactId: art, representationRevisionId: "rev-x" }];
    const emit = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    const res = await  submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "reject", targets, comment: "not good" }),
      makeDecidePorts(),
    );
    expect(res.ok).toBe(true);

    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate?.status).toBe("resolved");
    expect(gate?.disposition).toBe("reject");

    const dispositions = await gateStore.readGateDispositions(emit.gateId);
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0].kind).toBe("tombstone");
    expect(dispositions[0].appliedAt).toBeNull(); // never hard-deleted; pending downstream

    const intent = await gateStore.readResumeIntent(emit.gateId);
    expect(intent?.kind).toBe("reject");
    expect(payloadAssertsApproval(JSON.parse(intent!.responseText))).toBe(false);
  });

  it("IDEMPOTENT: a response-lost retry of the SAME decision is idempotent — no duplicate audit / outbox rows", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets: Target[] = [{ artifactId: art, representationRevisionId: "rev-1" }];
    const emit = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });
    const dec = mkDecision({ runId, reviewTaskId, disposition: "approve", targets });

    const first = await  submitReviewDecisionCore(dec, makeDecidePorts());
    const retry = await  submitReviewDecisionCore(dec, makeDecidePorts());
    expect(first.ok && retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.idempotent).toBe(true);
    expect(retry.plan).toBeNull();

    expect(await gateStore.readGateAuditRows(emit.gateId)).toHaveLength(1); // not doubled
    const outbox = await client.query(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" WHERE gate_id = $1`,
      [emit.gateId],
    );
    expect(outbox.rows[0].n).toBe(1); // exactly-once-persisted (one outbox row)
  });

  it("CONFLICT: a DIFFERENT decision on a resolved gate fails closed (gate-conflict), store unchanged", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets: Target[] = [{ artifactId: art, representationRevisionId: "rev-1" }];
    const emit = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });
    await  submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "approve", targets }),
      makeDecidePorts(),
    );
    const conflicting = await  submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "reject", targets }),
      makeDecidePorts(),
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.error.kind).toBe("gate-conflict");

    // Unchanged: still approve, one audit row, no reject disposition.
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate?.disposition).toBe("approve");
    expect(await gateStore.readGateAuditRows(emit.gateId)).toHaveLength(1);
    expect(await gateStore.readGateDispositions(emit.gateId)).toHaveLength(0);
  });

  it("COMMENT: a non-terminal comment annotates WITHOUT resolving the gate; a terminal approve then resolves it", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets: Target[] = [{ artifactId: art, representationRevisionId: "rev-1" }];
    const emit = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    const comment = await  submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "comment", targets, comment: "looks off" }),
      makeDecidePorts(),
    );
    expect(comment.ok).toBe(true);
    expect((await gateStore.readReviewGate(runId, reviewTaskId))?.status).toBe("pending"); // still open
    expect(await gateStore.readResumeIntent(emit.gateId)).toBeNull(); // comment never resumes
    expect(await gateStore.readGateDispositions(emit.gateId)).toHaveLength(0);

    const approve = await  submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "approve", targets }),
      makeDecidePorts(),
    );
    expect(approve.ok).toBe(true);
    expect((await gateStore.readReviewGate(runId, reviewTaskId))?.status).toBe("resolved");
  });

  it("ROLLBACK: a mid-transaction persistence failure rolls back the CAS too (zero partial commit)", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const emit = await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId,
      targets: [{ artifactId: art, representationRevisionId: "rev-1" }],
    });
    // A hand-built plan whose audit row carries an ILLEGAL renderer_kind — the
    // CHECK rejects the audit INSERT, which happens AFTER the gate CAS, so the
    // whole transaction (including the CAS) must roll back.
    const badPlan:  ReviewDecisionCommitPlan = {
      runId,
      reviewTaskId,
      disposition: "approve",
      terminal: true,
      fingerprint: "fp-rollback",
      comment: null,
      decidedBy: "user-decider",
      auditRows: [
        {
          artifactId: art,
          representationRevisionId: "rev-1",
          disposition: "approve",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rendererProvenance: { kind: "bogus" as any, packageName: null, digest: null },
        },
      ],
      dispositionOps: [],
      resumeIntent: { kind: "approve", userResponse: "{}" },
    };
    await expect(gateStore.commitReviewDecision(badPlan)).rejects.toBeTruthy();

    // Zero partial: the gate is STILL pending, no audit row, no outbox row.
    expect((await gateStore.readReviewGate(runId, reviewTaskId))?.status).toBe("pending");
    expect(await gateStore.readGateAuditRows(emit.gateId)).toHaveLength(0);
    expect(await gateStore.readResumeIntent(emit.gateId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // DRAIN — the resume-intent lease (mutually exclusive; at-least-once delivery).
  // -------------------------------------------------------------------------
  it("DRAIN: the resume outbox lease is mutually exclusive; a live-leased row is not re-claimed; a stale lease cannot mark it delivered", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets: Target[] = [{ artifactId: art, representationRevisionId: "rev-1" }];
    const emit = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });
    await  submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "approve", targets }),
      makeDecidePorts(),
    );

    const claimed = await gateStore.claimPendingResumeIntents({ limit: 100, leaseMs: 60_000 });
    const mine = claimed.find((r) => r.gateId === emit.gateId);
    expect(mine).toBeTruthy();
    expect(mine!.status).toBe("delivering");
    expect(mine!.attempts).toBe(1);
    expect(mine!.leaseToken).toBeTruthy();

    // A second claim (lease not expired) does NOT re-lease this gate.
    const second = await gateStore.claimPendingResumeIntents({ limit: 100, leaseMs: 60_000 });
    expect(second.find((r) => r.gateId === emit.gateId)).toBeUndefined();

    // A stale lease token cannot mark it delivered; the live token can.
    expect(await gateStore.markResumeIntentDelivered(emit.gateId, "stale-token")).toBe(false);
    expect(await gateStore.markResumeIntentDelivered(emit.gateId, mine!.leaseToken!)).toBe(true);
    expect((await gateStore.readResumeIntent(emit.gateId))?.status).toBe("done");
  });

  // -------------------------------------------------------------------------
  // ACCESS — enforceReviewRunAccess against a real seeded run.
  // -------------------------------------------------------------------------
  it("ACCESS: enforceReviewRunAccess grants the run owner and denies a foreign actor", async () => {
    const templateId = `tmpl-${randomUUID()}`;
    await store.createAgentTemplate({
      id: templateId,
      name: `review-${randomUUID().slice(0, 8)}`,
      sourceNl: "test",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
      packageName: `@test/${templateId}`,
      orgId: ORG,
    });
    const runId = `run-${randomUUID()}`;
    await store.createAgentRun({ id: runId, templateId, inputParams: {}, orgId: ORG, runBy: "user-owner" });

    const owner = { actorType: "human" as const, userId: "user-owner", source: "route" as const };
    const foreign = { actorType: "human" as const, userId: "user-foreign", source: "route" as const };

    expect(await gateStore.enforceReviewRunAccess(runId, owner, "approveHitl")).toEqual({ ok: true });
    const denied = await gateStore.enforceReviewRunAccess(runId, foreign, "approveHitl");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect([403, 404]).toContain(denied.status);
  });
  // -------------------------------------------------------------------------
  // THE DECIDING ACTOR (cinatra#2047 D-2).
  //
  // A lifecycle review exists so a HUMAN can control what the AGENT produced.
  // What the gate has to carry is therefore the RECORD of who decided —
  // `artifact_review_gates.resolved_by`, a column declared and read since #1796
  // and, until now, never written. Recording is the whole point; the store
  // imposes NO restriction on which member of the run's scope may decide.
  // -------------------------------------------------------------------------

  it("RECORD: a terminal APPROVE stamps the deciding actor on resolved_by", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets = [{ artifactId: art, representationRevisionId: "rev-1" }];
    await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    const res = await submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "approve", targets }),
      makeDecidePorts({ actingActorId: "user-V-reviewer" }),
    );
    expect(res.ok).toBe(true);

    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate?.status).toBe("resolved");
    expect(gate?.disposition).toBe("approve");
    expect(gate?.resolvedBy).toBe("user-V-reviewer");
  });

  it("RECORD: a terminal REJECT stamps the deciding actor too", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets = [{ artifactId: art, representationRevisionId: "rev-1" }];
    await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    const res = await submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "reject", targets, comment: "not yet" }),
      makeDecidePorts({ actingActorId: "user-V-reviewer" }),
    );
    expect(res.ok).toBe(true);
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate?.disposition).toBe("reject");
    expect(gate?.resolvedBy).toBe("user-V-reviewer");
  });

  it("RECORD: an unidentifiable decider (a non-human carrier) resolves the gate with a NULL decider, never a fabricated one", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets = [{ artifactId: art, representationRevisionId: "rev-1" }];
    await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    const res = await submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "approve", targets }),
      makeDecidePorts({ actingActorId: null }),
    );
    expect(res.ok).toBe(true);
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate?.status).toBe("resolved");
    expect(gate?.resolvedBy).toBeNull();
  });

  it("RECORD: a non-terminal COMMENT leaves the gate pending and unresolved-by (only a decision has a decider)", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets = [{ artifactId: art, representationRevisionId: "rev-1" }];
    await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    const res = await submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "comment", targets, comment: "a note" }),
      makeDecidePorts({ actingActorId: "user-V-reviewer" }),
    );
    expect(res.ok).toBe(true);
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate?.status).toBe("pending");
    expect(gate?.resolvedBy).toBeNull();
  });

  it("NO RESTRICTION: a DISTINCT reviewer and the RUN INITIATOR can both approve their gate — only the recorded decider differs", async () => {
    // The product decision for lifecycle review: any member of the scope the run
    // belongs to may decide, WITHOUT limitation, explicitly including the person
    // who started the run. This drives BOTH actors through the real store.
    const INITIATOR = "user-U-who-started-the-run";
    const OTHER = "user-V-someone-else";

    async function approveAs(actor: string) {
      const { runId, reviewTaskId } = freshGateIds();
      const targets = [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-1" }];
      await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });
      const res = await submitReviewDecisionCore(
        mkDecision({ runId, reviewTaskId, disposition: "approve", targets }),
        makeDecidePorts({ actingActorId: actor }),
      );
      return { res, gate: await gateStore.readReviewGate(runId, reviewTaskId) };
    }

    const byOther = await approveAs(OTHER);
    const byInitiator = await approveAs(INITIATOR);

    // PINNED CONTRACT — the exact inverse of the old separation-of-duties repro:
    // the run's own initiator approving their own run's gate SUCCEEDS.
    expect(byInitiator.res.ok).toBe(true);
    expect(byInitiator.gate?.status).toBe("resolved");
    expect(byInitiator.gate?.disposition).toBe("approve");
    expect(byInitiator.gate?.resolvedBy).toBe(INITIATOR);

    // ...and it is indistinguishable from a distinct reviewer's approval except
    // for WHO is recorded. No refusal path exists for either.
    expect(byOther.res.ok).toBe(true);
    expect(byOther.gate?.status).toBe(byInitiator.gate?.status);
    expect(byOther.gate?.disposition).toBe(byInitiator.gate?.disposition);
    expect(byOther.gate?.resolvedBy).toBe(OTHER);
  });

  it("GUARD: a self-INCONSISTENT plan is refused — terminal is derived from the disposition, and audit rows must match it", async () => {
    // Enforcement-independent correctness (cinatra#2047 convergence round): a
    // direct store caller could otherwise land an APPROVE audit row on a gate
    // that stays PENDING, leaving the decision trail disagreeing with the gate.
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets = [{ artifactId: art, representationRevisionId: "rev-1" }];
    await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    const auditRow = {
      artifactId: art,
      representationRevisionId: "rev-1",
      disposition: "approve" as const,
      rendererProvenance: { kind: "floor" as const, packageName: null, digest: null },
    };

    // (a) approve claiming to be NON-terminal — would skip the gate CAS entirely.
    await expect(
      gateStore.commitReviewDecision({
        runId,
        reviewTaskId,
        disposition: "approve",
        terminal: false,
        fingerprint: `fp-${randomUUID()}`,
        comment: null,
        decidedBy: "user-V-reviewer",
        auditRows: [auditRow],
        dispositionOps: [],
        resumeIntent: null,
      }),
    ).rejects.toThrow(/terminal is derived/);

    // (b) a comment plan smuggling an APPROVE audit row alongside it.
    await expect(
      gateStore.commitReviewDecision({
        runId,
        reviewTaskId,
        disposition: "comment",
        terminal: false,
        fingerprint: `fp-${randomUUID()}`,
        comment: "a note",
        decidedBy: "user-V-reviewer",
        auditRows: [auditRow],
        dispositionOps: [],
        resumeIntent: null,
      }),
    ).rejects.toThrow(/disagrees with the plan disposition/);

    // Neither attempt touched the gate.
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate?.status).toBe("pending");
    expect(gate?.resolvedBy).toBeNull();
  });
});
