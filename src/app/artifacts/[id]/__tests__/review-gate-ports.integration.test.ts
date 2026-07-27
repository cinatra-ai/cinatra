/**
 * Real-store integration for the artifact-review PORTS BINDER + surface loader
 * (cinatra#1795 S12 item 4) — `src/app/artifacts/[id]/review-gate-ports.ts`
 * against a real Postgres gate store + a real seeded agent run. Proves the WIRING
 * #1796 left for this slice: the surface loader composes run access → pending
 * gate → prepared (never-blank) targets; the decision binder threads run access +
 * the live gate CAS + submit-time re-validation into the #1807 core; and the
 * result maps to the surface's visible outcomes FAIL-CLOSED (a conflict / settled
 * gate is a block, a denial is not-permitted).
 *
 * SCOPE (honest): the happy-path terminal COMMIT (CAS + audit + reject tombstone +
 * resume outbox) is proven end-to-end against the real store by the store
 * integration suite (packages/agents/.../artifact-review-gate-store.integration.
 * test.ts, 12/12) — `submitReviewDecision` delegates to that same
 * `commitReviewDecision`. A successful terminal decision through the FULL binder
 * additionally needs a live DB representation member (resolveArtifactVersionForServe),
 * whose seeding is the objects-store's, not this binder's. COVERED HERE against the
 * real store: SURFACE not-authorized (foreign) + blocked (resolved gate); SUBMIT
 * run-access denied (foreign) + fail-closed CONFLICT on a resolved gate. The
 * per-target FLOOR + revision-not-member outcomes need the objects read pool (not
 * wired in this lane DB) and are proven by the #1807 core unit tests + the live
 * Playwright proof.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_DB_INTEGRATION_TESTS=1 \
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm test src/app/artifacts/[id]/__tests__/review-gate-ports.integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  ARTIFACT_REVIEW_DECISION_API_VERSION,
  reviewDecisionFingerprint,
  type ArtifactReviewDecision,
  type ReviewDecisionCommitPlan,
} from "@/lib/artifacts/artifact-review-decision";

const TEST_SCHEMA = "cinatra_test_review_ports_1795";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-1795-review-ports";

let ports: typeof import("../review-gate-ports");
let gateStore: typeof import("@cinatra-ai/agents/artifact-review-gate-store");
let dbMod: { agentBuilderPool?: { end: () => Promise<void> } };
let client: Client;

type Target = { artifactId: string; representationRevisionId: string };

const OWNER_ID = "user-owner-1795";
const actorCtxFor = (userId: string): {
  actor: PrimitiveActorContext;
  orgId: string;
} => ({
  actor: { actorType: "human", userId, source: "route" } as PrimitiveActorContext,
  orgId: ORG,
});

/**
 * Seed a real `agent_runs` row DIRECTLY (raw SQL), deliberately NOT via the store
 * `createAgentRun` helper: that helper fires a best-effort objects shadow-write
 * (`shadowUpsertObject`) whose floating async rejection to an unconfigured mirror
 * host would flake the suite. The run carries no auth policy, so run access falls
 * back to the DEFAULT owner-only policy — the owner (`run_by`) is granted, a
 * foreign actor denied. This is exactly what enforceReviewRunAccess resolves.
 */
async function seedRun(): Promise<string> {
  const runId = `run-${randomUUID()}`;
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, run_by, status, input_params)
     VALUES ($1, $2, $3, $4, 'queued', '{}')`,
    [runId, `tmpl-${randomUUID()}`, ORG, OWNER_ID],
  );
  return runId;
}

async function emitGate(runId: string, targets: Target[]): Promise<string> {
  const reviewTaskId = `wayflow-${randomUUID()}`;
  await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId, targets });
  return reviewTaskId;
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

  ports = await import("../review-gate-ports");
  gateStore = await import("@cinatra-ai/agents/artifact-review-gate-store");
  dbMod = (await import("@cinatra-ai/agents/artifact-review-gate-store")) as unknown as {
    agentBuilderPool?: { end: () => Promise<void> };
  };
  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.end().catch(() => {});
  await dbMod?.agentBuilderPool?.end?.().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#1795 — review-gate-ports binder (real store)", () => {
  // -------------------------------------------------------------------------
  // ACCESS + SURFACE LOADER
  // -------------------------------------------------------------------------
  // NOTE (honest coverage): the ready-with-FLOOR and revision-not-member per-target
  // outcomes require the objects-store read pool, which this lane DB does not wire
  // (it resolves to an unconfigured mirror host). Those artifact-side outcomes are
  // proven by the #1807 PURE core unit tests (prepareReviewTargetsCore floor matrix;
  // submitReviewDecisionCore revision-not-member) and exercised in the live
  // Playwright proof. This suite proves the review-gate-ports COMPOSITION deltas —
  // run access, live gate state, and fail-closed conflict/denial — against the real
  // gate store + a real seeded run.

  it("SURFACE: a foreign actor gets not-authorized (never the targets)", async () => {
    const runId = await seedRun();
    const reviewTaskId = await emitGate(runId, [
      { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` },
    ]);
    const surface = await ports.loadReviewGateSurface({
      runId,
      reviewTaskId,
      actorCtx: actorCtxFor("user-foreign"),
    });
    expect(surface.kind).toBe("not-authorized");
  });

  it("SURFACE: a resolved gate is blocked (no-longer-pending), existence never leaked", async () => {
    const runId = await seedRun();
    const target: Target = { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` };
    const reviewTaskId = await emitGate(runId, [target]);
    // Resolve the gate directly via the store commit (an approve), so the surface
    // sees a terminal gate.
    await gateStore.commitReviewDecision(resolvePlan(runId, reviewTaskId, [target]));

    const surface = await ports.loadReviewGateSurface({
      runId,
      reviewTaskId,
      actorCtx: actorCtxFor(OWNER_ID),
    });
    expect(surface).toEqual({ kind: "blocked", reason: "no-longer-pending" });
  });

  // -------------------------------------------------------------------------
  // SUBMIT — fail-closed + denied + conflict through the binder.
  // -------------------------------------------------------------------------
  it("ACCESS: enforceReviewDecisionAccess grants the run owner and denies a foreign actor (the action's pre-read gate)", async () => {
    const runId = await seedRun();
    // approveHitl (terminal) + respondToHitl (comment) both resolve against the
    // real run: the owner is granted, a foreign actor denied — the uniform denial
    // that closes the pending-gate existence oracle in the decision action.
    for (const op of ["approveHitl", "respondToHitl"] as const) {
      const owner = await ports.enforceReviewDecisionAccess({ runId, op, actorCtx: actorCtxFor(OWNER_ID) });
      expect(owner.ok).toBe(true);
      const foreign = await ports.enforceReviewDecisionAccess({ runId, op, actorCtx: actorCtxFor("user-foreign") });
      expect(foreign.ok).toBe(false);
    }
  });

  it("SUBMIT: a foreign actor is run-access denied (never a commit)", async () => {
    const runId = await seedRun();
    const target: Target = { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` };
    const reviewTaskId = await emitGate(runId, [target]);
    const outcome = await ports.submitReviewDecision({
      decision: decision(runId, reviewTaskId, "approve", [target]),
      actorCtx: actorCtxFor("user-foreign"),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("run-access-denied");
  });

  it("SUBMIT: a response-lost retry of the SAME decision on a resolved gate is idempotent success (not a false block)", async () => {
    const runId = await seedRun();
    const target: Target = { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` };
    const reviewTaskId = await emitGate(runId, [target]);
    // Resolve the gate with an APPROVE whose fingerprint matches what the binder
    // will recompute for the identical decision — the "first submit" whose
    // response was lost.
    const fingerprint = reviewDecisionFingerprint({
      runId,
      reviewTaskId,
      disposition: "approve",
      comment: null,
      reviewedTargets: [target],
    });
    await gateStore.commitReviewDecision(resolvePlan(runId, reviewTaskId, [target], fingerprint));

    // The retry: the binder reads the FROZEN pinned set (gate is resolved) and
    // reconstructs the identical decision → the core's fingerprint comparison →
    // idempotent success, NOT a false "blocked".
    const outcome = await ports.submitReviewDecision({
      decision: decision(runId, reviewTaskId, "approve", [target]),
      actorCtx: actorCtxFor(OWNER_ID),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.idempotent).toBe(true);
    expect(outcome.plan).toBeNull(); // nothing re-committed
  });

  it("SUBMIT: a decision on an already-resolved gate fails closed as gate-conflict/not-pending", async () => {
    const runId = await seedRun();
    const target: Target = { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` };
    const reviewTaskId = await emitGate(runId, [target]);
    // Resolve it first with an approve (store commit).
    await gateStore.commitReviewDecision(resolvePlan(runId, reviewTaskId, [target]));

    // A DIFFERENT decision (reject) now → the gate is resolved; fail closed.
    const outcome = await ports.submitReviewDecision({
      decision: decision(runId, reviewTaskId, "reject", [target]),
      actorCtx: actorCtxFor(OWNER_ID),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // readGateState returns resolved(+different fingerprint) → gate-conflict.
    expect(["gate-conflict", "gate-not-pending"]).toContain(outcome.error.kind);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function decision(
  runId: string,
  reviewTaskId: string,
  disposition: ArtifactReviewDecision["disposition"],
  targets: Target[],
): ArtifactReviewDecision {
  return {
    decisionApiVersion: ARTIFACT_REVIEW_DECISION_API_VERSION,
    runId,
    reviewTaskId,
    disposition,
    comment: null,
    reviewedTargets: targets,
  };
}

/** A minimal terminal APPROVE commit plan to move a gate to resolved directly via
 * the store (bypassing the artifact-side re-validation the binder would do — this
 * is a state-setup for the conflict/blocked assertions, not a binder path). */
function resolvePlan(
  runId: string,
  reviewTaskId: string,
  targets: Target[],
  fingerprintOverride?: string,
): ReviewDecisionCommitPlan {
  const fingerprint = fingerprintOverride ?? `setup-${randomUUID()}`;
  return {
    runId,
    reviewTaskId,
    disposition: "approve",
    terminal: true,
    fingerprint,
    comment: null,
    // cinatra#2047 D-2 — the decider of record this commit now stamps.
    decidedBy: "user-setup-decider",
    auditRows: targets.map((t) => ({
      artifactId: t.artifactId,
      representationRevisionId: t.representationRevisionId,
      disposition: "approve",
      rendererProvenance: { kind: "floor", packageName: null, digest: null },
    })),
    dispositionOps: [],
    resumeIntent: { kind: "approve", userResponse: "{}" },
  };
}
