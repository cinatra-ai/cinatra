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
 *   RETIRED — a reject is refused by the decision core (cinatra#3080) before any
 *             port is touched, so no effect of any kind reaches the store …
 *   STORE     … while the store still commits a LEGACY reject plan (the rejects
 *   (legacy)  taken before the retirement still have to drain): a tombstone
 *             disposition per target (applied_at NULL, never a hard delete).
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
import { runAllCleanups } from "./__fixtures__/integration-fixture-helpers";

// The review DECISION + REJECTION cores are PURE (no env / db at module load), so
// they are statically imported — types AND runtime values. Only the env-dependent
// store / db / schema modules (which read SUPABASE_SCHEMA / SUPABASE_DB_URL at
// module load) are dynamic-imported AFTER SUPABASE_SCHEMA is set in beforeAll.
import {
  submitReviewDecisionCore,
  reviewDecisionFingerprint,
  ARTIFACT_REVIEW_DECISION_API_VERSION,
  type SubmitDecisionPorts,
  type ReviewRendererProvenance,
  type ArtifactReviewDecision,
  type ReviewDisposition,
  type ReviewDecisionCommitPlan,
} from "@/lib/artifacts/artifact-review-decision";
import {
  normalizeReviewTargets,
  reviewTargetKey,
} from "@/lib/artifacts/artifact-review-target";
import {
  payloadAssertsApproval,
  buildReviewResumeText,
} from "@/lib/artifacts/artifact-review-rejection";
import { REVIEW_REJECT_RETIRED_REASON } from "@/lib/artifacts/review-surface-model";

const TEST_SCHEMA = "cinatra_test_review_gate_1796";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-1796-review-gate";
// cinatra#2485 C — the run-scope gate re-resolves a run's `run_by` LIVE against
// better-auth (`resolveOrgRoleForUser`), so a synthetic run owner with no
// membership row is refused as cross-org. The ACCESS test's run carries a human
// owner, so that human is seeded as a REAL member of ORG (the pattern
// `lifecycle-repair-dispatch.integration.test.ts` documents: "the dispatch-time
// principal gate needs a live-resolvable org role"). `public."user"` /
// `public."member"` are better-auth tables and live UNQUALIFIED in `public` —
// NOT in this suite's TEST_SCHEMA. The FOREIGN actor is deliberately left
// unseeded: it must stay a stranger to the run for the denial half to mean
// anything.
const RUN_OWNER = "user-owner-1796";

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
    // cinatra#2571 — this suite decides gates that surface no suggestions.
    readSurfacedSuggestions: async () => null,
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

/** A hand-built LEGACY reject commit plan (cinatra#3080). The decision core no
 *  longer produces one — the word is retired there — but the STORE still has to
 *  commit and drain the rejects taken BEFORE the retirement (their tombstone
 *  dispositions and their reject resume envelope), so the store half of that
 *  contract is proved by driving `commitReviewDecision` directly, the same way
 *  the ROLLBACK and GUARD cases below drive it. */
function legacyRejectPlan(input: {
  runId: string;
  reviewTaskId: string;
  targets: Target[];
  comment: string | null;
  decidedBy: string | null;
}): ReviewDecisionCommitPlan {
  // The plan must be one the RETIRED core could actually have produced, or the
  // store half is proved against a fiction: the targets are normalized and put
  // in the core's canonical key order before ANY effect is derived from them,
  // and the fingerprint is the real SHA-256 decision identity, not a literal.
  const normalized = normalizeReviewTargets(input.targets);
  if (!normalized.ok) throw new Error(`legacy reject fixture targets: ${normalized.error}`);
  const targets = [...normalized.targets].sort((a, b) => {
    const ka = reviewTargetKey(a);
    const kb = reviewTargetKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const resumeText = buildReviewResumeText({
    disposition: "reject",
    reviewTaskId: input.reviewTaskId,
    comment: input.comment,
    targets,
  });
  if (resumeText.kind !== "reject") throw new Error("expected a reject resume text");
  return {
    runId: input.runId,
    reviewTaskId: input.reviewTaskId,
    disposition: "reject",
    terminal: true,
    fingerprint: reviewDecisionFingerprint({
      runId: input.runId,
      reviewTaskId: input.reviewTaskId,
      disposition: "reject",
      comment: input.comment,
      reviewedTargets: targets,
    }),
    comment: input.comment,
    decidedBy: input.decidedBy,
    auditRows: targets.map((t) => ({
      artifactId: t.artifactId,
      representationRevisionId: t.representationRevisionId,
      disposition: "reject" as const,
      rendererProvenance: {
        kind: "build-map" as const,
        packageName: "@cinatra-ai/default-artifact",
        digest: null,
      },
    })),
    dispositionOps: targets.map((t) => ({
      artifactId: t.artifactId,
      representationRevisionId: t.representationRevisionId,
      kind: "tombstone" as const,
    })),
    resumeIntent: { kind: "reject", rejectResponse: resumeText.rejectResponse },
    suggestionPlan: null,
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
  // cinatra#1939 wave 2 / #1940 P3: createAgentRun (used by the ACCESS test
  // below) runs under guardOrgMutation, which reads the org's lifecycle from
  // public."organization" — seed the ACTIVE row this suite's guarded write needs.
  await client.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  // The run-scope gate's LIVE membership probe (see RUN_OWNER above). Skipping
  // the user_slug_move_trg DDL above is safe for this seed: that trigger is
  // AFTER UPDATE OF username, so a plain INSERT never needs it.
  await client.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $1, $2, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [RUN_OWNER, `${RUN_OWNER}@1796.test`],
  );
  await client.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-1796-${RUN_OWNER}`, ORG, RUN_OWNER],
  );
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  // These row deletes must NOT be suppressed: a swallowed failure leaves this
  // suite's shared Better Auth fixture rows behind (they live in `public`, NOT
  // in the TEST_SCHEMA dropped below), and the NEXT run inherits them — the
  // run-scope gate then resolves a membership this suite believed it had
  // cleaned up, so an isolation break reads as a pass.
  //
  // The failure is CAPTURED rather than thrown here so the infrastructure
  // teardown underneath it (connections, pool, schema drop) still runs — an
  // early throw would trade a leaked row for a leaked connection. Rethrown last.
  let cleanupError: unknown;
  try {
    await runAllCleanups([
      () => client?.query(`DELETE FROM public."member" WHERE "userId" = $1`, [RUN_OWNER]),
      () => client?.query(`DELETE FROM public."user" WHERE id = $1`, [RUN_OWNER]),
      () => client?.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]),
    ]);
  } catch (err) {
    cleanupError = err;
  }
  await client?.end().catch(() => {});
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
  if (cleanupError) throw cleanupError;
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

  // REJECT IS RETIRED (cinatra#3080), so the one old REJECT case is now TWO:
  // the core REFUSES the word before any port is touched, and the store keeps
  // committing the legacy reject plans taken before the retirement. Splitting
  // them keeps both halves proved against the real store — the refusal would
  // otherwise silently delete the tombstone/resume-envelope coverage.
  it("RETIRED: a reject is refused by the decision core, and NOTHING reaches the store", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets: Target[] = [{ artifactId: art, representationRevisionId: "rev-x" }];
    const emit = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    const res = await  submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "reject", targets, comment: "not good" }),
      makeDecidePorts(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("invalid-decision");
    if (res.error.kind !== "invalid-decision") return;
    // The platform's ONE sentence, quoted from where the floor defines it.
    expect(res.error.message).toBe(REVIEW_REJECT_RETIRED_REASON);

    // Zero effect: the gate is untouched and no row of any kind was written.
    expect((await gateStore.readReviewGate(runId, reviewTaskId))?.status).toBe("pending");
    expect(await gateStore.readGateAuditRows(emit.gateId)).toHaveLength(0);
    expect(await gateStore.readGateDispositions(emit.gateId)).toHaveLength(0);
    expect(await gateStore.readResumeIntent(emit.gateId)).toBeNull();
  });

  it("STORE (legacy reject): records a tombstone disposition per target (applied_at NULL) + a reject resume intent that never reads as approval", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets: Target[] = [{ artifactId: art, representationRevisionId: "rev-x" }];
    const emit = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    await gateStore.commitReviewDecision(
      legacyRejectPlan({ runId, reviewTaskId, targets, comment: "not good", decidedBy: "user-decider" }),
    );

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
    // A DIFFERENT decision on the resolved gate. The fingerprint is what the CAS
    // compares, and it covers the comment as well as the disposition and the
    // targets — so with reject retired (cinatra#3080) leaving approve as the only
    // terminal word, the difference is carried by the comment. The case under
    // proof is unchanged: a second, NON-matching decision fails closed.
    const conflicting = await  submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "approve", targets, comment: "on reflection, no" }),
      makeDecidePorts(),
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.error.kind).toBe("gate-conflict");

    // Unchanged: still the FIRST approve, one audit row, no disposition rows.
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

  // cinatra#2931 (epic #2926 W4) — the FORM RUNG's provenance is a real,
  // committable value. The card now includes the host's own renderer for a
  // declared text form, and records a target it rendered that way as
  // `first-party` rather than as a floor. `renderer_kind` carries a CHECK: until
  // W4 widened it, this exact commit raised on the audit INSERT and — because
  // the audit write happens after the CAS inside ONE transaction — rolled the
  // whole decision back, so a markdown draft the reviewer had read in full could
  // not be approved, rejected or commented on. This asserts the row COMMITS and
  // reads back as first-party, against the real bootstrap DDL.
  it("APPROVE: a form-rendered target commits its FIRST-PARTY provenance (never a floor)", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    const aForm = `art-${randomUUID()}`;
    const targets: Target[] = [{ artifactId: aForm, representationRevisionId: "rev-md" }];
    const emit = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    const ports = makeDecidePorts({
      provenance: {
        // Exactly what `provenanceFromResolvedMount` returns for a form mount:
        // no package name (the host rendered it) and no digest.
        [aForm]: { kind: "first-party", packageName: null, digest: null },
      },
    });
    const res = await submitReviewDecisionCore(
      mkDecision({ runId, reviewTaskId, disposition: "approve", targets }),
      ports,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The gate actually resolved — the whole point: no rollback.
    expect((await gateStore.readReviewGate(runId, reviewTaskId))?.status).toBe("resolved");

    const audit = await gateStore.readGateAuditRows(emit.gateId);
    expect(audit).toHaveLength(1);
    expect(audit[0].rendererKind).toBe("first-party");
    expect(audit[0].rendererPackage).toBeNull();
    expect(audit[0].rendererDigest).toBeNull();
    expect(audit[0].representationRevisionId).toBe("rev-md");
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
      suggestionPlan: null,
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
    await store.createAgentRun(
      { id: runId, templateId, inputParams: {}, orgId: ORG, runBy: RUN_OWNER },
      { orgId: ORG, can: () => true },
    );

    const owner = { actorType: "human" as const, userId: RUN_OWNER, source: "route" as const };
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

  it("RECORD: a terminal legacy REJECT stamps the deciding actor too", async () => {
    // Driven at the store, because the core refuses the word (cinatra#3080). The
    // recording contract is what is under proof and it is the store's: whatever
    // terminal plan resolves a gate stamps its decider.
    const { runId, reviewTaskId } = freshGateIds();
    const art = `art-${randomUUID()}`;
    const targets: Target[] = [{ artifactId: art, representationRevisionId: "rev-1" }];
    await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });

    await gateStore.commitReviewDecision(
      legacyRejectPlan({ runId, reviewTaskId, targets, comment: "not yet", decidedBy: "user-V-reviewer" }),
    );
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate?.status).toBe("resolved");
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
        suggestionPlan: null,
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
        suggestionPlan: null,
      }),
    ).rejects.toThrow(/disagrees with the plan disposition/);

    // Neither attempt touched the gate.
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate?.status).toBe("pending");
    expect(gate?.resolvedBy).toBeNull();
  });

  // -------------------------------------------------------------------------
  // SLOT — what the run card draws where the review screen goes (cinatra#2997).
  //
  // The run card is a placeholder for the review screen while the agent works
  // and becomes that screen when the work opens one, so it asks the run's own
  // rows: which gate is this run's, and might one still be opened for what it
  // produced. Read here against the REAL DDL, because both answers are index
  // shapes as much as they are values.
  // -------------------------------------------------------------------------
  it("SLOT: a run with no gate and nothing produced has no review, now or later", async () => {
    const { runId } = freshGateIds();
    await expect(gateStore.readRunReviewSlot(runId)).resolves.toEqual({
      reviewTaskId: null,
      awaiting: false,
    });
  });

  it("SLOT: an unanswered produced output says a review may still open", async () => {
    const { runId } = freshGateIds();
    // `emitter` and `origin_kind` are CLOSED SETS on this table (the DDL's own
    // checks); the produced-artifact path this slot read is about is the first
    // member of each.
    await client!.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_produced_outbox"
         (event_id, org_id, artifact_id, representation_revision_id, emitter,
          producer_run_id, origin_kind, destination_class, continuation_mode, status)
       VALUES ($1, $2, $3, $4, 'createSemanticArtifact', $5, 'agent_produced', 'none', 'async_effects_gated', 'pending')`,
      [`ev-${randomUUID()}`, ORG, `art-${randomUUID()}`, `rev-${randomUUID()}`, runId],
    );

    await expect(gateStore.readRunReviewSlot(runId)).resolves.toEqual({
      reviewTaskId: null,
      awaiting: true,
    });
  });

  it("SLOT: the run's own gate is the answer, and it survives being decided", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-1" }],
    });

    await expect(gateStore.readRunReviewSlot(runId)).resolves.toEqual({
      reviewTaskId,
      awaiting: false,
    });

    // A RESOLVED gate is still the answer. The reader who decided in place must
    // keep seeing what they decided — the card's own settled state draws it —
    // so the slot does not drop the gate the moment it stops being pending.
    await client!.query(
      // A RESOLVED gate must carry its terminal disposition, fingerprint and
      // resolution time — the DDL's own `..._resolved_chk`. This is a slot read
      // being exercised against a gate that has been decided, so the row is put
      // in the shape the CAS leaves it in.
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
          SET status = 'resolved', disposition = 'approve',
              fingerprint = 'fp-slot-test', resolved_at = now(), resolved_by = 'user-slot-test'
        WHERE run_id = $1 AND review_task_id = $2`,
      [runId, reviewTaskId],
    );
    await expect(gateStore.readRunReviewSlot(runId)).resolves.toEqual({
      reviewTaskId,
      awaiting: false,
    });
  });

  // A RUN CAN OWE A SECOND REVIEW. The first gate is decided, the run produces
  // again, and the new outbox row is pending — so the slot must say BOTH: here is
  // the gate you can still see, AND another review question is open. A reader
  // that stopped at the first gate would sit on the settled card while the next
  // review opened behind it.
  it("SLOT: a decided gate and a NEW unanswered output are reported together", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-1" }],
    });
    await client!.query(
      // A RESOLVED gate must carry its terminal disposition, fingerprint and
      // resolution time — the DDL's own `..._resolved_chk`. This is a slot read
      // being exercised against a gate that has been decided, so the row is put
      // in the shape the CAS leaves it in.
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
          SET status = 'resolved', disposition = 'approve',
              fingerprint = 'fp-slot-test', resolved_at = now(), resolved_by = 'user-slot-test'
        WHERE run_id = $1 AND review_task_id = $2`,
      [runId, reviewTaskId],
    );
    // `emitter` and `origin_kind` are CLOSED SETS on this table (the DDL's own
    // checks); the produced-artifact path this slot read is about is the first
    // member of each.
    await client!.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_produced_outbox"
         (event_id, org_id, artifact_id, representation_revision_id, emitter,
          producer_run_id, origin_kind, destination_class, continuation_mode, status)
       VALUES ($1, $2, $3, $4, 'createSemanticArtifact', $5, 'agent_produced', 'none', 'async_effects_gated', 'pending')`,
      [`ev-${randomUUID()}`, ORG, `art-${randomUUID()}`, `rev-${randomUUID()}`, runId],
    );

    await expect(gateStore.readRunReviewSlot(runId)).resolves.toEqual({
      reviewTaskId,
      awaiting: true,
    });
  });

  it("SLOT: the NEWEST gate is the run's answer when it has more than one", async () => {
    const { runId, reviewTaskId } = freshGateIds();
    await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-1" }],
    });
    // Age the first one so "newest" is decidable without depending on clock
    // resolution between two inserts.
    await client!.query(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
          SET created_at = now() - interval '1 hour'
        WHERE run_id = $1 AND review_task_id = $2`,
      [runId, reviewTaskId],
    );
    const second = `${reviewTaskId}-second`;
    await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId: second,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-2" }],
    });

    await expect(gateStore.readRunReviewSlot(runId)).resolves.toEqual({
      reviewTaskId: second,
      awaiting: false,
    });
  });

  it("SLOT: another run's gate is never this run's answer", async () => {
    const mine = freshGateIds();
    const theirs = freshGateIds();
    await gateStore.emitArtifactReviewGate({
      runId: theirs.runId,
      orgId: ORG,
      reviewTaskId: theirs.reviewTaskId,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: "rev-1" }],
    });

    await expect(gateStore.readRunReviewSlot(mine.runId)).resolves.toEqual({
      reviewTaskId: null,
      awaiting: false,
    });
  });
});
