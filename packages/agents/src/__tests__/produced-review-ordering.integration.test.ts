/**
 * cinatra#3007 — a run whose produced output opens a review does not reach a
 * terminal status before that review is decided.
 *
 * THE DEFECT these proofs are written against. The review gate a run's OUTPUT
 * opened was minted by a recurring drain, seconds AFTER the executor had written
 * the run `completed`. Measured on two real runs: 8.5 s and 5.0 s late. `completed`
 * has no legal edge out, so the decision — taken half an hour later — released
 * nothing, and the placeholder the review card was meant to replace had already
 * flipped to the completion reading.
 *
 * What is asserted here is an ORDERING, on the rows, against a real database:
 *
 *   ORDERING  — the gate's `created_at` precedes the run's terminal timestamp, the
 *               decision's `resolved_at` falls between them, and the run holds the
 *               parked status for that whole window. Asserted against whichever
 *               terminal status the run actually reaches.
 *   OUTCOMES  — the status sequence for each decision: approve, reject, expiry,
 *               a cancel while parked, and a drain that fails to create the gate
 *               (where the run must not report success).
 *   RACE      — deterministic, with the drain DELAYED by the test rather than by a
 *               sleep: execution cannot reach a terminal status while a produced
 *               event that would open a review is still awaiting orchestration.
 *               Re-driving a drained run changes nothing (idempotent).
 *   DECLARED  — the template-declared gate's park is not a produced-review park,
 *               and the release path refuses to touch it.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://user:pass@127.0.0.1:5432/db \
 *     pnpm --filter @cinatra-ai/agents test:integration produced-review-ordering
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import {
  producedEventId,
  type ArtifactProducedEvent,
} from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { runReviewStepReading } from "../run-review-slot-reading";

const TEST_SCHEMA = "cinatra_test_produced_review_3007";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3007";
const USER = "user-3007";

/** An org-write authority is a structural `{ orgId, can }` — the same shape the
 *  host mints for the agent-run dispatcher. Built here so the suite needs no
 *  host session. */
const AUTHORITY = { orgId: ORG, can: () => true };

let hold: typeof import("../run-produced-review-hold");
let orch: typeof import("../lifecycle-review-orchestration-store");
let gateStore: typeof import("../artifact-review-gate-store");
let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let resumeDelivery: typeof import("../artifact-review-resume-delivery");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

/** The run row every transition needs, plus the org row the org-write guard
 *  reads before it will open a write transaction. */
async function seedRun(runId: string, status = "running") {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
       (id, template_id, org_id, status, input_params, run_by)
     VALUES ($1, $2, $3, $4, '{}', $5)
     ON CONFLICT (id) DO NOTHING`,
    [runId, `tpl-${randomUUID()}`, ORG, status, USER],
  );
}

async function readRun(runId: string) {
  const r = await pool(
    `SELECT status, completed_at, error, step_results
       FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = $1`,
    [runId],
  );
  const row = r.rows[0] as
    | {
        status: string;
        completed_at: Date | null;
        error: string | null;
        step_results: string | null;
      }
    | undefined;
  if (!row) return undefined;
  // `agent_runs.step_results` is a JSON string column.
  return {
    ...row,
    stepResults: row.step_results === null ? null : (JSON.parse(row.step_results) as unknown[]),
  };
}

async function readGateRow(gateId: string) {
  const r = await pool(
    `SELECT id, status, disposition, created_at, resolved_at
       FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id = $1`,
    [gateId],
  );
  return r.rows[0] as
    | {
        id: string;
        status: string;
        disposition: string | null;
        created_at: Date;
        resolved_at: Date | null;
      }
    | undefined;
}

/** A run row already sitting in the parked status, carrying whatever
 *  `step_results` payload the proof needs — including one that is deliberately
 *  NOT a withheld terminal write. */
async function seedParkedRun(runId: string, stepResults: unknown): Promise<void> {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
       (id, template_id, org_id, status, input_params, run_by, step_results)
     VALUES ($1, $2, $3, 'pending_approval', '{}', $4, $5)
     ON CONFLICT (id) DO UPDATE SET status = 'pending_approval', step_results = EXCLUDED.step_results`,
    [runId, `tpl-${randomUUID()}`, ORG, USER, JSON.stringify(stepResults)],
  );
}

/** A produced-outbox row written straight to the table, so a proof can pin an
 *  exact linkage shape (settled, unlinked, or pointing at a gate that does not
 *  resolve in this org) without going through the emitter. */
async function seedOutboxRow(
  runId: string,
  over: { status?: string; continuationAddress?: string | null; orgId?: string } = {},
): Promise<void> {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_produced_outbox"
       (event_id, org_id, artifact_id, representation_revision_id, event_kind, emitter,
        producer_run_id, origin_kind, destination_class, continuation_mode,
        continuation_address, status)
     VALUES ($1, $2, $3, $4, 'artifact_produced', 'createSemanticArtifact', $5, 'agent_produced', 'none',
             'async_effects_gated', $6, $7)`,
    [
      `ev-${randomUUID()}`,
      over.orgId ?? ORG,
      `art-${randomUUID()}`,
      `rev-${randomUUID()}`,
      runId,
      over.continuationAddress ?? null,
      over.status ?? "processed",
    ],
  );
}

/** A gate row written straight to the table, so a proof can own its org. */
async function seedGateRow(
  gateId: string,
  over: { orgId?: string; runId?: string; status?: string } = {},
): Promise<void> {
  const status = over.status ?? "resolved";
  const resolved = status !== "pending";
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_gates"
       (id, run_id, org_id, review_task_id, status, pinned_targets,
        disposition, fingerprint, resolved_at)
     VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6, $7, $8)`,
    [
      gateId,
      over.runId ?? `run-${randomUUID()}`,
      over.orgId ?? ORG,
      `lifecycle-review:${randomUUID()}`,
      status,
      // A resolved gate must carry the terminal stamp its own CHECK demands.
      resolved ? "approve" : null,
      resolved ? `fp-${randomUUID()}` : null,
      resolved ? new Date() : null,
    ],
  );
}

/** The withheld terminal write as it actually rides on a parked row. */
function withheldPayload(status: "completed" | "failed" = "completed"): unknown[] {
  return [
    {
      kind: "wayflow_response",
      output: "the draft",
      lifecycle_review_withheld_terminal: { status },
    },
  ];
}

/** Emit a produced event for `runId` and seed the objects row its review context
 *  resolves the artifact TYPE from. */
async function produceFor(
  runId: string,
  type = "document",
  over: Partial<ArtifactProducedEvent> = {},
): Promise<ArtifactProducedEvent> {
  const artifactId = over.artifactId ?? `art-${randomUUID()}`;
  const representationRevisionId = over.representationRevisionId ?? `rev-${randomUUID()}`;
  const ev: ArtifactProducedEvent = {
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
    ...over,
  };
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id)
     VALUES ($1, $2, '{}'::jsonb, $3) ON CONFLICT (id) DO NOTHING`,
    [ev.artifactId, type, ORG],
  );
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

/** The terminal payload the executor would have written outright. */
function terminalPayload(output = "the draft") {
  return [{ kind: "wayflow_response", a2aTaskId: `task-${randomUUID()}`, output }];
}

/** Commit a real terminal decision through the decision core's store port, so the
 *  gate carries a genuine `resolved_at`, disposition and resume intent. */
async function decide(
  runId: string,
  reviewTaskId: string,
  disposition: "approve" | "reject",
  target: { artifactId: string; representationRevisionId: string },
) {
  return gateStore.commitReviewDecision({
    runId,
    reviewTaskId,
    disposition,
    terminal: true,
    fingerprint: `fp-${randomUUID()}`,
    comment: null,
    auditRows: [
      {
        artifactId: target.artifactId,
        representationRevisionId: target.representationRevisionId,
        disposition,
        rendererProvenance: { kind: "first-party", packageName: null, digest: null },
      },
    ],
    dispositionOps: [],
    resumeIntent:
      disposition === "approve"
        ? { kind: "approve", userResponse: "approved" }
        : { kind: "reject", rejectResponse: "rejected" },
    suggestionPlan: null,
    decidedBy: USER,
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";

  await admin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await c.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = qy.text.trim().slice(0, 6).toUpperCase();
      if (
        head !== "CREATE" &&
        head !== "ALTER " &&
        head !== "DROP T" &&
        head !== "DROP S" &&
        head !== "DO $$ "
      ) {
        continue;
      }
      if (qy.text.includes("user_slug_move_trg")) continue;
      try {
        await c.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
      }
    }
    // The org-write guard reads `public."organization"` FOR SHARE before it opens
    // a run-status write transaction, and refuses an org it cannot find.
    await c.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt")
       VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
  });
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  hold = await import("../run-produced-review-hold");
  orch = await import("../lifecycle-review-orchestration-store");
  // The executor's inline drain rides the boot-registered runner slot (it may not
  // import the orchestration store — the route-graph ratchet keeps that store out
  // of the locked dev-perf routes the executor sits in). Wire it here exactly as
  // the system-loops boot phase does, so these proofs exercise the real path.
  (
    globalThis as { __cinatraLifecycleReviewRunner?: Record<string, unknown> }
  ).__cinatraLifecycleReviewRunner = {
    drainProducedProductionForRun: async (input: { orgId: string; runId: string; limit?: number }) => {
      await orch.drainProducedProductionForRun(input);
    },
    withProducedProductionLock: orch.withProducedProductionLock,
  };
  gateStore = await import("../artifact-review-gate-store");
  outboxStore = await import("../lifecycle-produced-outbox-store");
  resumeDelivery = await import("../artifact-review-resume-delivery");
  dbMod = await import("../db");
}, 120_000);

beforeEach(() => {
  if (!HAS_DB) return;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
});

afterAll(async () => {
  if (!HAS_DB) return;
  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  await admin(async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
    await c
      .query(`DELETE FROM public."organization" WHERE id = $1`, [ORG])
      .catch(() => {});
  });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
  delete (globalThis as { __cinatraLifecycleReviewRunner?: unknown })
    .__cinatraLifecycleReviewRunner;
});

describe.skipIf(!HAS_DB)("cinatra#3007 — the review moment precedes the terminal status", () => {
  // -------------------------------------------------------------------------
  // ORDERING (acceptance 2) — proved on the rows, not on a screen.
  // -------------------------------------------------------------------------
  describe("ORDERING", () => {
    it("gate.created_at < decision < run terminal timestamp, parked throughout the window", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);

      const outcome = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
        },
        AUTHORITY,
      );
      expect(outcome).toEqual({ held: true, reason: "gate-undecided" });

      // The gate exists BEFORE the run has any terminal timestamp, and the run is
      // sitting in the status a run waits on a gate in.
      const taskId = autoReviewTaskId(ev.eventId);
      const gate = await gateStore.readReviewGate(runId, taskId);
      expect(gate).not.toBeNull();
      const gateRow = await readGateRow(gate!.id);
      expect(gateRow?.status).toBe("pending");

      const parked = await readRun(runId);
      expect(parked?.status).toBe("pending_approval");
      expect(parked?.completed_at).toBeNull();

      // The decision.
      const commit = await decide(runId, taskId, "approve", ev);
      expect(commit.status).toBe("committed");
      const decided = await readGateRow(gate!.id);
      expect(decided?.status).toBe("resolved");
      expect(decided?.resolved_at).not.toBeNull();

      // Still parked: the terminal status has not been written by the decision
      // itself — nothing but the release writes it.
      expect((await readRun(runId))?.status).toBe("pending_approval");

      const released = await hold.releaseHeldRun(runId, AUTHORITY);
      expect(released).toEqual({ released: true, terminal: "completed" });

      const finished = await readRun(runId);
      expect(finished?.status).toBe("completed");
      expect(finished?.completed_at).not.toBeNull();

      // THE ORDERING, on the timestamps the rows actually carry.
      const created = gateRow!.created_at.getTime();
      const decidedAt = decided!.resolved_at!.getTime();
      const terminalAt = finished!.completed_at!.getTime();
      expect(created).toBeLessThanOrEqual(decidedAt);
      expect(decidedAt).toBeLessThanOrEqual(terminalAt);
      expect(created).toBeLessThan(terminalAt);
    });

    it("holds against the terminal status the run ACTUALLY reaches — a withheld failure too", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);

      // The materialization-honesty verdict was already `failed`; the review still
      // comes first, and the failure is what the decision releases the run to.
      const outcome = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "failed", error: "draft: contentFrom did not resolve" },
        },
        AUTHORITY,
      );
      expect(outcome.held).toBe(true);

      const taskId = autoReviewTaskId(ev.eventId);
      const gate = await gateStore.readReviewGate(runId, taskId);
      const gateRow = await readGateRow(gate!.id);
      await decide(runId, taskId, "approve", ev);
      const released = await hold.releaseHeldRun(runId, AUTHORITY);
      expect(released).toEqual({ released: true, terminal: "failed" });

      const finished = await readRun(runId);
      expect(finished?.status).toBe("failed");
      expect(finished?.error).toContain("contentFrom did not resolve");
      // `failed` stamps `completed_at` as every terminal status does, so the
      // ordering assertion is the same one.
      expect(gateRow!.created_at.getTime()).toBeLessThan(finished!.completed_at!.getTime());
    });

    it("the released payload is the one the executor would have written — the marker is gone", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);
      const payload = terminalPayload("the draft body");

      await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: payload,
          withheld: { status: "completed" },
        },
        AUTHORITY,
      );
      // While parked, the withheld terminal write is on the row (that is what
      // makes the park releasable at all).
      const parked = await readRun(runId);
      expect(hold.readWithheldTerminal(parked?.stepResults)).toEqual({ status: "completed" });

      await decide(runId, autoReviewTaskId(ev.eventId), "approve", ev);
      await hold.releaseHeldRun(runId, AUTHORITY);

      const finished = await readRun(runId);
      expect(finished?.stepResults).toEqual(payload);
      expect(hold.readWithheldTerminal(finished?.stepResults)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // OUTCOMES (acceptance 1) — the status sequence per decision.
  // -------------------------------------------------------------------------
  describe("OUTCOMES", () => {
    async function parkOnReview(): Promise<{
      runId: string;
      ev: ArtifactProducedEvent;
      taskId: string;
      gateId: string;
    }> {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);
      const outcome = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
        },
        AUTHORITY,
      );
      expect(outcome.held).toBe(true);
      expect((await readRun(runId))?.status).toBe("pending_approval");
      const taskId = autoReviewTaskId(ev.eventId);
      const gate = await gateStore.readReviewGate(runId, taskId);
      return { runId, ev, taskId, gateId: gate!.id };
    }

    it("APPROVED: running → pending_approval → completed, and the decision drives the release", async () => {
      const { runId, ev, taskId } = await parkOnReview();
      await decide(runId, taskId, "approve", ev);
      // Driven through the SAME resume-outbox delivery the decision commits an
      // intent for — the production path, not a direct call.
      const summary = await resumeDelivery.sweepArtifactReviewResumeIntents();
      expect(summary.attempted).toBeGreaterThanOrEqual(1);
      const finished = await readRun(runId);
      expect(finished?.status).toBe("completed");
      expect(finished?.error).toBeNull();
    });

    it("REJECTED: running → pending_approval → failed, with the refusal on the run", async () => {
      const { runId, ev, taskId } = await parkOnReview();
      await decide(runId, taskId, "reject", ev);
      await resumeDelivery.sweepArtifactReviewResumeIntents();
      const finished = await readRun(runId);
      expect(finished?.status).toBe("failed");
      expect(String(finished?.error)).toContain("rejected");
      expect(finished?.completed_at).not.toBeNull();
    });

    it("EXPIRED: an optional gate that lapses releases the run, though it mints no resume intent", async () => {
      const { runId, gateId } = await parkOnReview();
      await pool(
        `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates" SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [gateId],
      );
      // The expiry drain resolves the gate with a bare CAS — no intent is written.
      await orch.sweepLifecycleGateMaintenance();
      expect((await readGateRow(gateId))?.status).toBe("resolved");
      const intents = await pool(
        `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox" WHERE gate_id = $1`,
        [gateId],
      );
      expect((intents.rows[0] as { n: number }).n).toBe(0);
      // ...so the release drain is the only thing that can reach this run.
      expect((await readRun(runId))?.status).toBe("pending_approval");
      await resumeDelivery.sweepArtifactReviewResumeIntents();
      expect((await readRun(runId))?.status).toBe("completed");
    });

    it("CANCELLED WHILE PARKED: a stop wins, and the release never resurrects the run", async () => {
      const { runId, ev, taskId } = await parkOnReview();
      await pool(
        `UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status = 'stopped', completed_at = now() WHERE id = $1`,
        [runId],
      );
      await decide(runId, taskId, "approve", ev);
      const released = await hold.releaseHeldRun(runId, AUTHORITY);
      expect(released).toEqual({ released: false, reason: "not-parked" });
      expect((await readRun(runId))?.status).toBe("stopped");
    });

    it("DRAIN FAILURE: the gate is never created, and the run does NOT report success", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);

      const outcome = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
          drain: async () => {
            throw new Error("orchestration unavailable");
          },
        },
        AUTHORITY,
      );
      expect(outcome).toEqual({ held: true, reason: "awaiting-orchestration" });

      const parked = await readRun(runId);
      expect(parked?.status).toBe("pending_approval");
      expect(parked?.completed_at).toBeNull();
      // No gate was created, and the event is still pending for the sweep.
      expect(await gateStore.readReviewGate(runId, autoReviewTaskId(ev.eventId))).toBeNull();
      // The release refuses a run nothing has decided for.
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: false,
        reason: "still-held",
      });

      // The recurring sweep converges it: the gate opens onto the still-parked run.
      await orch.sweepReviewOrchestration();
      const gate = await gateStore.readReviewGate(runId, autoReviewTaskId(ev.eventId));
      expect(gate).not.toBeNull();
      expect((await readRun(runId))?.status).toBe("pending_approval");
    });
  });

  // -------------------------------------------------------------------------
  // RACE (acceptance 3) — deterministic; the test controls the drain.
  // -------------------------------------------------------------------------
  describe("RACE", () => {
    it("a DELAYED drain cannot let the run finish — no sleep, the test holds the drain", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);

      let entered!: () => void;
      const drainEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gateOpen = new Promise<void>((resolve) => {
        release = resolve;
      });

      // The drain is suspended at the exact instant the executor would have
      // written a terminal status. Nothing is waited on but these promises — the
      // window is opened and closed by the test, never by the clock.
      const held = hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
          drain: async () => {
            entered();
            await gateOpen;
          },
        },
        AUTHORITY,
      );

      // Execution is now provably INSIDE the drain, with the event unorchestrated.
      // The run may not be terminal at any point in this window.
      await drainEntered;
      expect((await readRun(runId))?.status).toBe("running");
      release();
      expect(await held).toEqual({ held: true, reason: "awaiting-orchestration" });
      const parked = await readRun(runId);
      expect(parked?.status).toBe("pending_approval");
      expect(parked?.completed_at).toBeNull();

      // The event is still pending, and the run is parked on it — exactly the
      // "awaiting orchestration" hold, not a review that opened.
      const pending = await pool(
        `SELECT status FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id = $1`,
        [ev.eventId],
      );
      expect((pending.rows[0] as { status: string }).status).toBe("pending");
    });

    it("a re-drained run is idempotent: one gate, one park, one release", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);
      const taskId = autoReviewTaskId(ev.eventId);

      const first = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
        },
        AUTHORITY,
      );
      expect(first).toEqual({ held: true, reason: "gate-undecided" });

      // A re-drive (a redelivered job, a re-sweep) re-runs the whole thing. The
      // run is ALREADY parked, so the second hold takes the already-parked branch
      // rather than an illegal second transition.
      const second = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "pending_approval",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
        },
        AUTHORITY,
      );
      expect(second).toEqual({ held: true, reason: "gate-undecided" });
      await orch.sweepReviewOrchestration();

      const gates = await pool(
        `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE review_task_id = $1`,
        [taskId],
      );
      expect((gates.rows[0] as { n: number }).n).toBe(1);
      expect((await readRun(runId))?.status).toBe("pending_approval");

      await decide(runId, taskId, "approve", ev);
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: true,
        terminal: "completed",
      });
      // A second release is a no-op — the run is no longer parked.
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: false,
        reason: "not-parked",
      });
      expect((await readRun(runId))?.status).toBe("completed");
    });

    it("TWO CHAINS racing one parked run keep the FIRST withheld terminal write", async () => {
      // Two recovery chains can re-enter the hold for one run, each carrying its
      // OWN terminal write. Before the park existed, the first terminal CAS won
      // and the second was refused `stale_from_status`. The park must not turn
      // that into last-writer-wins, or an approved run that COMPLETED, with its
      // derivation capture, is released as the later chain's `failed`.
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);
      const taskId = autoReviewTaskId(ev.eventId);

      expect(
        await hold.holdRunForProducedReview(
          {
            runId,
            orgId: ORG,
            fromStatus: "running",
            stepResults: terminalPayload("the completed draft"),
            withheld: { status: "completed" },
          },
          AUTHORITY,
        ),
      ).toEqual({ held: true, reason: "gate-undecided" });
      expect(hold.readWithheldTerminal((await readRun(runId))?.stepResults)).toEqual({
        status: "completed",
      });

      // The SECOND chain arrives on the already-parked run with a DIFFERENT
      // terminal write. It is held, exactly as before -- but it does not land.
      expect(
        await hold.holdRunForProducedReview(
          {
            runId,
            orgId: ORG,
            fromStatus: "pending_approval",
            stepResults: terminalPayload("the later chain's draft"),
            withheld: { status: "failed", error: "the later chain's verdict" },
          },
          AUTHORITY,
        ),
      ).toEqual({ held: true, reason: "gate-undecided" });

      // FIRST WRITER WINS, read off the row.
      expect(hold.readWithheldTerminal((await readRun(runId))?.stepResults)).toEqual({
        status: "completed",
      });
      expect((await readRun(runId))?.status).toBe("pending_approval");

      // ...and the decision performs the FIRST write, not the later one.
      await decide(runId, taskId, "approve", ev);
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: true,
        terminal: "completed",
      });
      const after = await readRun(runId);
      expect(after?.status).toBe("completed");
      expect(after?.error).toBeNull();
      expect(hold.readWithheldTerminal(after?.stepResults)).toBeNull();
    });


    it("a run that produces NOTHING is untouched — no park, no extra read path", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const outcome = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
        },
        AUTHORITY,
      );
      expect(outcome).toEqual({ held: false, reason: "no-produced-output" });
      expect((await readRun(runId))?.status).toBe("running");
    });

    it("a produced artifact whose type opens NO review does not park the run", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      // A user-provided origin is not agent-produced work: the lattice opens no
      // review for it, so the run keeps its immediate terminal write.
      await produceFor(runId, "document", { originKind: "user_provided" });
      const outcome = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
        },
        AUTHORITY,
      );
      expect(outcome).toEqual({ held: false, reason: "no-review" });
      expect((await readRun(runId))?.status).toBe("running");
    });
  });

  // -------------------------------------------------------------------------
  // CONVERGENCE — the interleavings a review round put on the table.
  // -------------------------------------------------------------------------
  describe("CONVERGENCE", () => {
    it("NO GATE AFTER THE PARK: a park that resolves to no review is released, not stranded", async () => {
      // The park happens on `awaiting-orchestration` (the drain failed), and the
      // event later turns out to open NO review at all. Nothing is ever linked, so
      // a release drain keyed on a resolved GATE would never look at this run
      // again. It is keyed on the park instead, and the predicate clears it.
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId, "document", { originKind: "user_provided" });

      const parked = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
          drain: async () => {
            throw new Error("orchestration unavailable");
          },
        },
        AUTHORITY,
      );
      expect(parked).toEqual({ held: true, reason: "awaiting-orchestration" });
      expect((await readRun(runId))?.status).toBe("pending_approval");

      // The sweep settles the event with NO gate.
      await orch.sweepReviewOrchestration();
      const row = await pool(
        `SELECT status, continuation_address FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id = $1`,
        [ev.eventId],
      );
      expect((row.rows[0] as { status: string }).status).toBe("processed");
      expect((row.rows[0] as { continuation_address: string | null }).continuation_address).toBeNull();

      // The candidate set still contains it, and the release completes it.
      const candidates = await hold.listReleasableHeldRuns(200);
      expect(candidates.map((c) => c.runId)).toContain(runId);
      await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 200 });
      expect((await readRun(runId))?.status).toBe("completed");
    });

    it("CONTENDED: another pass owns this production, so the run holds rather than finishing", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      await produceFor(runId);

      // Take the production lock on a second, independent session — the exact
      // lock a concurrent sweep would hold. No sleeps: the lock is the signal.
      const holder = new Client({ connectionString: DB_URL });
      await holder.connect();
      try {
        const key = `lifecycle-review-production::${ORG}::${runId}`;
        const got = await holder.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [key]);
        expect((got.rows[0] as { locked: boolean }).locked).toBe(true);

        const outcome = await hold.holdRunForProducedReview(
          {
            runId,
            orgId: ORG,
            fromStatus: "running",
            stepResults: terminalPayload(),
            withheld: { status: "completed" },
          },
          AUTHORITY,
        );
        expect(outcome).toEqual({ held: true, reason: "orchestration-contended" });
        expect((await readRun(runId))?.status).toBe("pending_approval");
        await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      } finally {
        await holder.end().catch(() => {});
      }

      // The sweep then opens the gate onto the still-parked run, and the decision
      // releases it — the contended pass cost the run nothing but a cycle.
      await orch.sweepReviewOrchestration();
      expect((await readRun(runId))?.status).toBe("pending_approval");
    });

    it("FENCE OFF: the slice is inert, so no run parks waiting for a drain that is not running", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      await produceFor(runId);
      process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "off";
      try {
        const outcome = await hold.holdRunForProducedReview(
          {
            runId,
            orgId: ORG,
            fromStatus: "running",
            stepResults: terminalPayload(),
            withheld: { status: "completed" },
          },
          AUTHORITY,
        );
        expect(outcome).toEqual({ held: false, reason: "review-inactive" });
        expect((await readRun(runId))?.status).toBe("running");
      } finally {
        process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
      }
    });

    it("a park that carried NO step results still clears its marker on release", async () => {
      // The WayFlow failure branch parks with an empty payload, so the marker is
      // the only entry. Stripping must be PERSISTED, not omitted — an omitted key
      // would leave the marker on the terminal row.
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);
      const outcome = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: [],
          withheld: { status: "failed", error: "the flow failed" },
        },
        AUTHORITY,
      );
      expect(outcome.held).toBe(true);
      await decide(runId, autoReviewTaskId(ev.eventId), "approve", ev);
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: true,
        terminal: "failed",
      });
      const finished = await readRun(runId);
      expect(finished?.stepResults).toEqual([]);
      expect(hold.readWithheldTerminal(finished?.stepResults)).toBeNull();
      expect(finished?.error).toBe("the flow failed");
    });

    it("a release for a DIFFERENT org's authority never touches the run", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);
      await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
        },
        AUTHORITY,
      );
      await decide(runId, autoReviewTaskId(ev.eventId), "approve", ev);
      expect(
        await hold.releaseHeldRun(runId, { orgId: "org-someone-else", can: () => true }),
      ).toEqual({ released: false, reason: "not-parked" });
      expect((await readRun(runId))?.status).toBe("pending_approval");
    });
  });

  // -------------------------------------------------------------------------
  // DECLARED (acceptance 4) — the path that already parked is left alone.
  // -------------------------------------------------------------------------
  describe("DECLARED", () => {
    it("a template-declared park carries no withheld terminal write, and the release refuses it", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId, "pending_approval");
      // The declared path's own gate — minted before the park, as it always was.
      await gateStore.emitArtifactReviewGate({
        runId,
        orgId: ORG,
        reviewTaskId: `wayflow-task-${randomUUID()}`,
        targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }],
      });

      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: false,
        reason: "not-produced-review-park",
      });
      expect((await readRun(runId))?.status).toBe("pending_approval");

      // ...and the release drain does not even consider it a candidate.
      const candidates = await hold.listReleasableHeldRuns(100);
      expect(candidates.map((c) => c.runId)).not.toContain(runId);
    });
  });

  // -------------------------------------------------------------------------
  // THE CANDIDATE PREDICATE. The release drain reads a BOUNDED, stably-ordered
  // page of parked runs, so a predicate that admits rows `releaseHeldRun` then
  // refuses does not merely waste a pass — it occupies the same page forever and
  // starves every genuinely releasable park behind it.
  // -------------------------------------------------------------------------
  describe("CANDIDATES", () => {
    it("a run whose OWN OUTPUT contains the marker's name is not a park — and does not starve a real one", async () => {
      const limit = 5;
      // `limit` rows that satisfy every other condition — parked, production
      // behind them, nothing pending, no undecided gate — and whose step_results
      // merely CONTAIN the marker's name inside the run's own nested output. A
      // substring predicate matches all of them; each is then refused by the
      // authoritative read, and their ids sort ahead of the real park.
      const decoys: string[] = [];
      for (let i = 0; i < limit; i += 1) {
        const runId = `aaa-decoy-${i}-${randomUUID()}`;
        decoys.push(runId);
        await seedParkedRun(runId, [
          {
            kind: "wayflow_response",
            output: {
              summary: "the agent reported on the release drain",
              notes: [
                "[produced-review-hold] run=... lifecycle_review_withheld_terminal seen",
                { lifecycle_review_withheld_terminal: "not an object with a status" },
              ],
            },
          },
        ]);
        await seedOutboxRow(runId);
      }
      // ...and ONE real park, sorting last.
      const realRun = `zzz-real-${randomUUID()}`;
      await seedParkedRun(realRun, withheldPayload("completed"));
      await seedOutboxRow(realRun);

      const candidates = await hold.listReleasableHeldRuns(limit);
      const ids = candidates.map((c) => c.runId);

      // The decoys are not parks at all, so the bounded page reaches the one row
      // that is.
      for (const decoy of decoys) expect(ids).not.toContain(decoy);
      expect(ids).toContain(realRun);

      // ...and the pass makes progress: the real park takes its withheld write.
      expect(await hold.releaseHeldRun(realRun, AUTHORITY)).toEqual({
        released: true,
        terminal: "completed",
      });
      // The decoys are untouched — nothing here decided anything about them.
      for (const decoy of decoys) expect((await readRun(decoy))?.status).toBe("pending_approval");
    });

    it("a marker whose status is not a terminal write is not a park either", async () => {
      const runId = `zzz-badstatus-${randomUUID()}`;
      await seedParkedRun(runId, [
        { kind: "wayflow_response", lifecycle_review_withheld_terminal: { status: "running" } },
      ]);
      await seedOutboxRow(runId);

      expect((await hold.listReleasableHeldRuns(200)).map((c) => c.runId)).not.toContain(runId);
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: false,
        reason: "not-produced-review-park",
      });
    });

    it("a park with NO payload of its own preserves the run's recorded step results", async () => {
      // The failure edges (dispatch, human gate, task failure) carry no payload:
      // their immediate transitions omit `stepResults` entirely and so preserve
      // the column. A park WRITES that column, so it must park on top of what the
      // row already holds — otherwise the same run loses a mid-run step record
      // just because it went through the park.
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const recorded = [{ kind: "wayflow_response", output: "the draft so far" }];
      await pool(
        `UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET step_results = $2 WHERE id = $1`,
        [runId, JSON.stringify(recorded)],
      );
      const ev = await produceFor(runId, "document", { originKind: "user_provided" });

      const parked = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: [],
          withheld: { status: "failed", error: "the flow failed" },
          drain: async () => {
            throw new Error("orchestration unavailable");
          },
        },
        AUTHORITY,
      );
      expect(parked).toEqual({ held: true, reason: "awaiting-orchestration" });

      // Parked: the row still carries what it had, plus the marker.
      const held = await readRun(runId);
      expect(held?.status).toBe("pending_approval");
      expect(hold.readWithheldTerminal(held?.stepResults)).toEqual({
        status: "failed",
        error: "the flow failed",
      });
      expect((held?.stepResults as Array<Record<string, unknown>>)[0]?.output).toBe(
        "the draft so far",
      );

      // Released: byte-identical to what the immediate failure edge would leave.
      await orch.sweepReviewOrchestration();
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: true,
        terminal: "failed",
      });
      const done = await readRun(runId);
      expect(done?.status).toBe("failed");
      expect(done?.error).toBe("the flow failed");
      expect(done?.stepResults).toEqual(recorded);
      expect(ev.producerRunId).toBe(runId);
    });

    it("a park with NO production behind it at all is released, not stranded", async () => {
      // The fail-closed park taken on an unreadable probe has exactly this shape:
      // the marker is there, and there may be no produced row anywhere. Requiring
      // production in the predicate would strand it forever.
      const runId = `zzz-noproduction-${randomUUID()}`;
      await seedParkedRun(runId, withheldPayload("failed"));

      expect((await hold.listReleasableHeldRuns(200)).map((c) => c.runId)).toContain(runId);
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: true,
        terminal: "failed",
      });
      expect((await readRun(runId))?.status).toBe("failed");
    });
  });

  // -------------------------------------------------------------------------
  // THE LINKAGE. A produced event records the gate it opened in its own
  // `continuation_address`, and there is deliberately no foreign key behind it.
  // So an address that resolves to nothing is an INCOHERENT state, never
  // evidence that the run opened no review.
  // -------------------------------------------------------------------------
  describe("LINKAGE", () => {
    it("a VANISHED gate holds the run — it is not read as 'no review'", async () => {
      const runId = `run-${randomUUID()}`;
      const missingGateId = `gate-gone-${randomUUID()}`;
      await seedRun(runId);
      await seedOutboxRow(runId, { continuationAddress: missingGateId });

      expect(await hold.resolveProducedReviewHold(ORG, runId)).toEqual({
        held: true,
        reason: "gate-unresolvable",
        gateIds: [missingGateId],
      });

      // ...and a park behind that linkage is not a release candidate.
      await seedParkedRun(runId, withheldPayload("completed"));
      expect((await hold.listReleasableHeldRuns(200)).map((c) => c.runId)).not.toContain(runId);
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: false,
        reason: "still-held",
      });
      expect((await readRun(runId))?.status).toBe("pending_approval");
    });

    it("a CROSS-ORGANIZATION gate holds the run, however decided that foreign row is", async () => {
      const runId = `run-${randomUUID()}`;
      const foreignGateId = `gate-foreign-${randomUUID()}`;
      // The row EXISTS — resolved, even approved — but it belongs to someone
      // else, so it is not this organization's review and cannot decide this
      // run's terminal status.
      await seedGateRow(foreignGateId, { orgId: "org-3007-elsewhere", status: "resolved" });
      await seedRun(runId);
      await seedOutboxRow(runId, { continuationAddress: foreignGateId });

      expect(await hold.resolveProducedReviewHold(ORG, runId)).toEqual({
        held: true,
        reason: "gate-unresolvable",
        gateIds: [foreignGateId],
      });

      await seedParkedRun(runId, withheldPayload("completed"));
      expect((await hold.listReleasableHeldRuns(200)).map((c) => c.runId)).not.toContain(runId);
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: false,
        reason: "still-held",
      });
      expect((await readRun(runId))?.status).toBe("pending_approval");
    });

    it("the SAME-ORG resolved gate still releases — the fail-closed read is not a blanket refusal", async () => {
      const runId = `run-${randomUUID()}`;
      const gateId = `gate-ours-${randomUUID()}`;
      await seedGateRow(gateId, { orgId: ORG, runId, status: "resolved" });
      await seedOutboxRow(runId, { continuationAddress: gateId });
      await seedParkedRun(runId, withheldPayload("completed"));

      expect(await hold.resolveProducedReviewHold(ORG, runId)).toEqual({
        held: false,
        reason: "no-review",
      });
      expect((await hold.listReleasableHeldRuns(200)).map((c) => c.runId)).toContain(runId);
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: true,
        terminal: "completed",
      });
    });
  });

  // -------------------------------------------------------------------------
  // THE SLOT THE RUN SURFACES READ (cinatra#3046).
  //
  // The ordering above is a fact about rows; this is the fact the SCREENS need
  // from the same rows. A run parked here is `pending_approval` and carries no
  // artifact-review interrupt, which is indistinguishable — from the shape of
  // the pause alone — from a run stopped on a question somebody has to answer.
  // Measured on real runs, that is exactly what the surfaces did: they redrew
  // the run's last ANSWERED question, with a live Continue, and drew the review
  // the run was actually waiting on nowhere at all.
  //
  // `readRunReviewSlot` is the one reader every run surface asks, so the park is
  // answered there, from the run's own row, beside the two facts about the gate.
  // These proofs drive it end to end against the real store: park, read, decide,
  // release, read again.
  // -------------------------------------------------------------------------
  describe("SLOT", () => {
    it("park → slot says parked, with the gate it opened; release → slot says decided", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId);
      const ev = await produceFor(runId);

      // Before anything parks, the run owes no review anybody can see.
      const beforePark = await gateStore.readRunReviewSlot(runId);
      expect(beforePark.parkedOnProducedReview).toBe(false);

      const outcome = await hold.holdRunForProducedReview(
        {
          runId,
          orgId: ORG,
          fromStatus: "running",
          stepResults: terminalPayload(),
          withheld: { status: "completed" },
        },
        AUTHORITY,
      );
      expect(outcome).toEqual({ held: true, reason: "gate-undecided" });

      // THE PARKED READING: the run says it is waiting on the review of what it
      // produced, and the slot names the gate that review is.
      const taskId = autoReviewTaskId(ev.eventId);
      const parked = await gateStore.readRunReviewSlot(runId);
      expect(parked).toEqual({
        reviewTaskId: taskId,
        awaiting: false,
        parkedOnProducedReview: true,
      });
      expect(runReviewStepReading(parked)).toBe("review");
      // …while the run itself has not reached any terminal status.
      expect((await readRun(runId))?.status).toBe("pending_approval");
      expect((await readRun(runId))?.completed_at).toBeNull();

      // THE DECISION, taken on the gate the slot named — the same commit the
      // card's own bar makes.
      await decide(runId, taskId, "approve", ev);

      // DECIDED, AND NOT YET RELEASED — a real, observable window, because the
      // decision and the terminal write are two writes. The run is still parked
      // and its OWN gate is already `resolved`; the slot must go on naming it, or
      // the decided card the reader is looking at regresses to a placeholder.
      const decidedButHeld = await gateStore.readRunReviewSlot(runId);
      expect(decidedButHeld).toEqual({
        reviewTaskId: taskId,
        awaiting: false,
        parkedOnProducedReview: true,
      });
      expect(runReviewStepReading(decidedButHeld)).toBe("review");

      // …and then the release this branch built.
      expect(await hold.releaseHeldRun(runId, AUTHORITY)).toEqual({
        released: true,
        terminal: "completed",
      });

      // THE DECIDED READING: the same gate, and the park is gone with the
      // withheld terminal write the release performed.
      const released = await gateStore.readRunReviewSlot(runId);
      expect(released).toEqual({
        reviewTaskId: taskId,
        awaiting: false,
        parkedOnProducedReview: false,
      });
      expect(runReviewStepReading(released)).toBe("review");
      expect((await readRun(runId))?.status).toBe("completed");
    });

    it("a park whose gate is not minted yet reads WORKING — the placeholder's window", async () => {
      // The park's first half: the produced event is still awaiting its
      // orchestration, so there is no gate row to address and the surface draws
      // the placeholder rather than a question or a completion notice.
      const runId = `run-${randomUUID()}`;
      await seedOutboxRow(runId, { status: "pending" });
      await seedParkedRun(runId, withheldPayload("completed"));

      const slot = await gateStore.readRunReviewSlot(runId);
      expect(slot).toEqual({
        reviewTaskId: null,
        awaiting: true,
        parkedOnProducedReview: true,
      });
      expect(runReviewStepReading(slot)).toBe("working");
    });

    it("a park that failed CLOSED still reads as a park, though it has neither gate nor pending row", async () => {
      // `gate-unresolvable`: the linkage is real and names a gate this org has no
      // row for. There is nothing for the outbox or the gate read to report, and
      // the run is still held — so the park's own marker is the only thing that
      // keeps the surface from drawing the answered question again.
      const runId = `run-${randomUUID()}`;
      await seedOutboxRow(runId, { continuationAddress: `gate-gone-${randomUUID()}` });
      await seedParkedRun(runId, withheldPayload("completed"));

      const slot = await gateStore.readRunReviewSlot(runId);
      expect(slot).toEqual({
        reviewTaskId: null,
        awaiting: false,
        parkedOnProducedReview: true,
      });
      expect(runReviewStepReading(slot)).toBe("working");
      expect((await hold.resolveProducedReviewHold(ORG, runId)).held).toBe(true);
    });

    it("a park names the gate its OWN production linked, not a newer unlinked one", async () => {
      // The correlation is the linkage the producing transaction wrote, so a gate
      // that was minted LATER but belongs to nothing this run produced cannot
      // displace the one the run is actually held for.
      const runId = `run-${randomUUID()}`;
      const heldGate = `gate-held-${randomUUID()}`;
      await seedGateRow(heldGate, { runId, status: "pending" });
      await seedOutboxRow(runId, { continuationAddress: heldGate });
      await seedGateRow(`gate-unlinked-${randomUUID()}`, { runId, status: "pending" });
      await seedParkedRun(runId, withheldPayload("completed"));

      const linkedTask = (
        await pool(
          `SELECT review_task_id FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id = $1`,
          [heldGate],
        )
      ).rows[0] as { review_task_id: string };
      const slot = await gateStore.readRunReviewSlot(runId);
      expect(slot).toEqual({
        reviewTaskId: linkedTask.review_task_id,
        awaiting: false,
        parkedOnProducedReview: true,
      });
    });

    it("a run producing AGAIN is not drawn with the review it already answered", async () => {
      // The second-review shape with its REAL history: the first production was
      // processed and is linked to a gate that was decided, and the linkage stays
      // on the row for ever. The run then produces again and parks with that
      // event still pending, so the gate it is being held for does not exist yet.
      // Naming the decided one there draws a review the reader already answered
      // in place of the one that is about to open.
      const runId = `run-${randomUUID()}`;
      const firstGate = `gate-first-${randomUUID()}`;
      await seedGateRow(firstGate, { runId, status: "resolved" });
      await seedOutboxRow(runId, { status: "processed", continuationAddress: firstGate });
      await seedOutboxRow(runId, { status: "pending" });
      await seedParkedRun(runId, withheldPayload("completed"));

      const slot = await gateStore.readRunReviewSlot(runId);
      expect(slot).toEqual({
        reviewTaskId: null,
        awaiting: true,
        parkedOnProducedReview: true,
      });
      expect(runReviewStepReading(slot)).toBe("working");
    });

    it("an UNDECIDED linked gate wins over a newer decided one — it is what holds the run", async () => {
      const runId = `run-${randomUUID()}`;
      const openGate = `gate-open-${randomUUID()}`;
      const laterDecided = `gate-later-${randomUUID()}`;
      await seedGateRow(openGate, { runId, status: "pending" });
      await seedGateRow(laterDecided, { runId, status: "resolved" });
      await seedOutboxRow(runId, { continuationAddress: openGate });
      await seedOutboxRow(runId, { continuationAddress: laterDecided });
      await seedParkedRun(runId, withheldPayload("completed"));

      const openTask = (
        await pool(
          `SELECT review_task_id FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id = $1`,
          [openGate],
        )
      ).rows[0] as { review_task_id: string };
      const slot = await gateStore.readRunReviewSlot(runId);
      expect(slot.reviewTaskId).toBe(openTask.review_task_id);
      expect(slot.parkedOnProducedReview).toBe(true);
    });

    it("a park does NOT name the run's EARLIER decided review — that is not what holds it", async () => {
      // The second-review shape, which is the one a "newest gate wins" read gets
      // wrong. Gate A is decided; the run produced again and is parked; gate B is
      // not minted yet. Naming gate A there draws a review the reader already
      // answered over the one the run is actually being held for — and nothing on
      // the surface could tell them apart. A run that is still held cannot be held
      // by a gate that is resolved, so a resolved gate is not this park's gate.
      const runId = `run-${randomUUID()}`;
      await seedGateRow(`gate-decided-${randomUUID()}`, { runId, status: "resolved" });
      await seedOutboxRow(runId, { status: "pending" });
      await seedParkedRun(runId, withheldPayload("completed"));

      const parked = await gateStore.readRunReviewSlot(runId);
      expect(parked).toEqual({
        reviewTaskId: null,
        awaiting: true,
        parkedOnProducedReview: true,
      });
      expect(runReviewStepReading(parked)).toBe("working");

      // AND IT COMES BACK once the run is no longer held: a decided review is
      // read-only history on a finished run, which is the reading it always had.
      await pool(
        `UPDATE "${q(TEST_SCHEMA)}"."agent_runs"
           SET status = 'completed', step_results = NULL WHERE id = $1`,
        [runId],
      );
      const released = await gateStore.readRunReviewSlot(runId);
      expect(released.parkedOnProducedReview).toBe(false);
      expect(released.reviewTaskId).not.toBeNull();
      expect(runReviewStepReading(released)).toBe("review");
    });

    it("a TEMPLATE-DECLARED park is not one — the question keeps its surface", async () => {
      // The line the reading must not cross. A run parked by a gate its template
      // declared carries no withheld terminal write, so it is not a produced
      // review park however many gates it has on file — and the surface must go
      // on drawing the gate the run is really blocked on.
      const runId = `run-${randomUUID()}`;
      const gateId = `gate-declared-${randomUUID()}`;
      await seedGateRow(gateId, { runId, status: "pending" });
      await seedParkedRun(runId, [
        { kind: "wayflow_response", output: "an interrupt, not a park" },
      ]);

      const slot = await gateStore.readRunReviewSlot(runId);
      expect(slot.parkedOnProducedReview).toBe(false);
      expect(slot.reviewTaskId).not.toBeNull();
    });

    it("a run that never parked reads false, whatever its status", async () => {
      const runId = `run-${randomUUID()}`;
      await seedRun(runId, "running");
      expect((await gateStore.readRunReviewSlot(runId)).parkedOnProducedReview).toBe(false);
      const unknown = `run-${randomUUID()}`;
      expect((await gateStore.readRunReviewSlot(unknown)).parkedOnProducedReview).toBe(false);
    });
  });
});
