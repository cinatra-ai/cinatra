/**
 * cinatra#2864 — a review-gate notification can no longer outlive its gate.
 *
 * THE DEFECT. The auto-gate notification was a best-effort PAIR with no ordering
 * between its halves. `dispatchAutoGateOpen` ran after the gate row committed,
 * awaited, swallowing errors; `dispatchAutoGateResolved` deleted by
 * (runId, reviewTaskId) and treated "matched no row" as success. Nothing
 * serialised them. A resolve-delete that ran while an open-insert was still in
 * flight matched nothing, the insert then committed, and the row outlived its own
 * subject: the bell kept an entry that opened onto "This review is no longer
 * open", forever, because the only event that would have cleared it had already
 * gone by. Four opening paths reach that seam (the single artifact, the batch
 * partition, the repair-successor pin, the verification reopen pin), and three of
 * them are decided by MACHINERY, which does not wait to be told.
 *
 * THE FIX, and what this file proves against a real database. The check moved
 * INTO the write, the way #2835 closed the same shape for the recommendation
 * hold: `buildAutoGateNotificationFence` supplies a `SELECT … FOR UPDATE` of the
 * GATE row matched on (run, task, status='pending'), the host composes it as a CTE
 * of the notification INSERT, and the insert is driven from its rows. So:
 *
 *   - an insert can no longer land for a gate that is not pending, whenever it
 *     arrives;
 *   - `FOR UPDATE` takes the same row lock the terminal decision's CAS takes, and
 *     that CAS commits before its clear runs — so open and resolve serialise on
 *     the gate row and the clear-then-insert interleaving has no window left.
 *
 * REAL DDL, real store, real sessions. The fence is a claim about what two
 * Postgres sessions can and cannot do at once, so the contended cases drive two
 * genuine connections and assert that the second one BLOCKS.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://user:pass@127.0.0.1:5432/db \
 *     pnpm --filter @cinatra-ai/agents test:integration auto-gate-notification-ordering
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { producedEventId, type ArtifactProducedEvent } from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";

import {
  buildAutoGateNotificationFence,
  setRunWaitNotifier,
  dispatchAutoGateOpen,
  dispatchAutoGateResolved,
  type RunWaitNotifier,
} from "../run-wait-notifier";

const TEST_SCHEMA = "cinatra_test_gate_notify_ordering_2864";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2864";
const USER = "user-2864";

let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let repairStore: typeof import("../lifecycle-repair-store");
let dbMod: typeof import("../db");

/**
 * The four review-task-id SHAPES the open seam serves, one per gate-opening path.
 *
 * HONEST SCOPE. Only the first has a dispatching caller on this branch
 * (`orchestrateProducedEvent`); cinatra#2833 (PR #2838, open) adds the other
 * three, each calling `dispatchAutoGateOpen` with the same two ids. The table
 * therefore pins that the seam and its fence are SHAPE-BLIND — which is what lets
 * those three arrive already fenced — not that four production paths run today.
 */
const OPENING_PATHS = [
  { path: "single produced artifact", taskId: () => `auto-review:evt-${randomUUID()}` },
  { path: "batch partition gate", taskId: () => `auto-review:batch:${randomUUID()}` },
  { path: "repair-successor pin", taskId: () => `auto-review:repair:${randomUUID()}:1` },
  { path: "verification reopen pin", taskId: () => `auto-review:verify-reopen:${randomUUID()}` },
] as const;

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
    // `DO $$ …` blocks are how the bootstrap creates its ENUM types; without them
    // the tables that reference those types silently fail to create.
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
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  outboxStore = await import("../lifecycle-produced-outbox-store");
  repairStore = await import("../lifecycle-repair-store");
  dbMod = await import("../db");
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

describe.skipIf(!HAS_DB)("cinatra#2864 — the auto-gate notification is fenced on its gate", () => {
  beforeEach(async () => {
    // The PRODUCTION host writer, not a recording double: the fence lives in it.
    const hostNotifier = await import("@/lib/agent-run-wait-notifications");
    setRunWaitNotifier(hostNotifier.runWaitNotifier satisfies RunWaitNotifier);
  });

  // Never leak the wired notifier into another test file's module singleton.
  afterEach(() => setRunWaitNotifier(null));

  async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => {});
    }
  }

  /** A run the host writer can address a notification to (it reads `run_by`). */
  async function seedRun(runId: string) {
    await withClient((c) =>
      c.query(
        `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
           (id, template_id, org_id, status, input_params, run_by)
         VALUES ($1, $2, $3, 'running', '{}', $4)
         ON CONFLICT (id) DO NOTHING`,
        [runId, `tpl-${randomUUID()}`, ORG, USER],
      ),
    );
  }

  /** Every auto-gate row this (run, task) currently owns. */
  async function notificationRows(runId: string, reviewTaskId: string) {
    return withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT id, user_id, title FROM "${q(TEST_SCHEMA)}"."notifications" WHERE dedupe_key = $1`,
        [`run-awaiting-human:auto:${runId}:${reviewTaskId}`],
      );
      return rows as Array<Record<string, string | null>>;
    });
  }

  async function gateStatus(runId: string, reviewTaskId: string) {
    return withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT status FROM "${q(TEST_SCHEMA)}"."artifact_review_gates"
          WHERE run_id = $1 AND review_task_id = $2`,
        [runId, reviewTaskId],
      );
      return (rows[0] as { status: string } | undefined)?.status;
    });
  }

  /** A seeded run with ONE freshly emitted, still-pending gate on it. */
  async function pendingGate(taskId = `auto-review:evt-${randomUUID()}`) {
    const runId = `run-2864-${randomUUID()}`;
    await seedRun(runId);
    const emitted = await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId: taskId,
      targets: [{ artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` }],
    });
    expect(emitted.idempotent).toBe(false);
    return { runId, reviewTaskId: taskId, gateId: emitted.gateId };
  }

  /** A REAL terminal decision on the gate — the same path a reviewer drives. */
  async function decide(runId: string, reviewTaskId: string) {
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate).not.toBeNull();
    const commit = await gateStore.commitReviewDecision({
      runId,
      reviewTaskId,
      disposition: "approve",
      terminal: true,
      fingerprint: `fp-${randomUUID()}`,
      comment: null,
      decidedBy: `${USER}-reviewer`,
      auditRows: gate!.pinnedTargets.map((t) => ({
        artifactId: t.artifactId,
        representationRevisionId: t.representationRevisionId,
        disposition: "approve" as const,
        rendererProvenance: { kind: "floor" as const, packageName: null, digest: null },
      })),
      dispositionOps: [],
      resumeIntent: null,
      suggestionPlan: null,
    });
    expect(commit.status).toBe("committed");
  }

  // -------------------------------------------------------------------------
  // The ordinary life of the row, so the fence is not proved by writing nothing.
  // -------------------------------------------------------------------------

  it("a PENDING gate still notifies — the fence admits the write it is supposed to", async () => {
    const { runId, reviewTaskId } = await pendingGate();

    await dispatchAutoGateOpen({ runId, reviewTaskId });

    const rows = await notificationRows(runId, reviewTaskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(USER);
  });

  it("open → decide → the clear removes it: the pair still works end to end", async () => {
    const { runId, reviewTaskId } = await pendingGate();
    await dispatchAutoGateOpen({ runId, reviewTaskId });
    expect(await notificationRows(runId, reviewTaskId)).toHaveLength(1);

    // A real terminal decision, which itself dispatches the clear from the
    // gate-store commit. Driving the seam again is the retry-safe no-op.
    await decide(runId, reviewTaskId);
    await dispatchAutoGateResolved({ runId, reviewTaskId });

    expect(await gateStatus(runId, reviewTaskId)).toBe("resolved");
    expect(await notificationRows(runId, reviewTaskId)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // THE RACE, in the order that used to strand a row.
  // -------------------------------------------------------------------------

  it("THE RACE: a resolve-delete that runs BEFORE the open-insert leaves NO surviving row", async () => {
    // The exact sequence the issue names, rendered as an ordering rather than a
    // coin flip: the gate reaches a terminal decision, the clear runs and matches
    // nothing (there is nothing yet to match), and only THEN does the open reach
    // its write. Before the fence, that insert landed on a resolved gate and the
    // row survived its own subject — permanently, because a gate resolves once.
    const { runId, reviewTaskId } = await pendingGate();

    await decide(runId, reviewTaskId);
    // The clear, running against a feed that holds nothing for this key.
    await dispatchAutoGateResolved({ runId, reviewTaskId });
    expect(await notificationRows(runId, reviewTaskId)).toHaveLength(0);

    // The open, arriving late. The guard is re-evaluated against the gate's
    // CURRENT row: `resolved`, so zero rows feed the insert and nothing is
    // written. No code runs between the check and the write, because they are the
    // same statement.
    await dispatchAutoGateOpen({ runId, reviewTaskId });

    expect(await notificationRows(runId, reviewTaskId)).toHaveLength(0);
  });

  it("a gate DECIDED BEFORE THE OPEN EVER RAN never inserts (no clear needed at all)", async () => {
    // The same write refused for the same reason, with no clear anywhere in the
    // story: an auto-approving policy that resolves the gate in the same breath it
    // was opened. The open must simply write nothing.
    const { runId, reviewTaskId } = await pendingGate();
    await decide(runId, reviewTaskId);

    await dispatchAutoGateOpen({ runId, reviewTaskId });

    expect(await notificationRows(runId, reviewTaskId)).toHaveLength(0);
  });

  it("a gate that does not exist at all writes nothing — the GATE TABLE decides, not the caller", async () => {
    // The seam takes two opaque ids and asserts nothing about either. An id that
    // names no gate yields no guard row, so no cast and no mistaken caller can buy
    // a notification for a review that was never opened.
    const runId = `run-2864-${randomUUID()}`;
    await seedRun(runId);

    await dispatchAutoGateOpen({ runId, reviewTaskId: `auto-review:ghost-${randomUUID()}` });

    expect(await notificationRows(runId, "nope")).toHaveLength(0);
    const all = await withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM "${q(TEST_SCHEMA)}"."notifications" WHERE user_id = $1 AND dedupe_key LIKE $2`,
        [USER, `run-awaiting-human:auto:${runId}:%`],
      );
      return rows;
    });
    expect(all).toHaveLength(0);
  });

  it("a REAL gate belonging to ANOTHER run writes nothing for this one", async () => {
    const other = await pendingGate();
    const runId = `run-2864-${randomUUID()}`;
    await seedRun(runId);

    // Same task id, different run: the guard matches on BOTH columns.
    await dispatchAutoGateOpen({ runId, reviewTaskId: other.reviewTaskId });

    expect(await notificationRows(runId, other.reviewTaskId)).toHaveLength(0);
    expect(await notificationRows(other.runId, other.reviewTaskId)).toHaveLength(0);
  });

  /**
   * A gate opened by the REAL production path: a produced event, then the real
   * `sweepReviewOrchestration`, which emits the gate AND dispatches the open
   * through the fenced seam. Returns the ids plus the event, for the terminal
   * transitions that need the base target.
   */
  async function producedGate(over: { destinationClass?: string } = {}) {
    const artifactId = `art-${randomUUID()}`;
    const representationRevisionId = `rev-${randomUUID()}`;
    const runId = `run-2864-${randomUUID()}`;
    await seedRun(runId);
    await withClient((c) =>
      c.query(
        `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id)
         VALUES ($1, 'document', '{}'::jsonb, $2) ON CONFLICT (id) DO NOTHING`,
        [artifactId, ORG],
      ),
    );
    const event: ArtifactProducedEvent = {
      eventId: producedEventId(artifactId, representationRevisionId),
      orgId: ORG,
      artifactId,
      representationRevisionId,
      eventKind: "artifact_produced",
      emitter: "createSemanticArtifact",
      producerRunId: runId,
      producerAgentId: null,
      originKind: "agent_produced",
      destinationClass: (over.destinationClass ?? "none") as ArtifactProducedEvent["destinationClass"],
      continuationMode: "async_effects_gated",
      continuationAddress: null,
    };
    await outboxStore.emitArtifactProduced(event, dbMod.db);
    await orch.sweepReviewOrchestration();
    const reviewTaskId = autoReviewTaskId(event.eventId);
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate).not.toBeNull();
    // The sweep itself dispatched the open through the production seam.
    expect(await notificationRows(runId, reviewTaskId)).toHaveLength(1);
    return { runId, reviewTaskId, gateId: gate!.id, event };
  }

  // -------------------------------------------------------------------------
  // THE OTHER TERMINAL RESOLUTIONS — expiry and changes_requested (Codex
  // convergence rounds 1 and 2). A fence on the OPEN side cannot help either of
  // them: those rows were written truthfully; it is the transition that makes them
  // stale, so the transition must carry the clear.
  // -------------------------------------------------------------------------

  it("EXPIRY clears the row too — a review that merely timed out is still over", async () => {
    // A gate can reach a terminal state with no reviewer anywhere: the maintenance
    // drain auto-resolves an OPTIONAL review whose TTL lapsed, releasing the held
    // effect. That transition never goes through `commitReviewDecision`, so
    // nothing cleared the row the open had truthfully written, and the bell kept
    // an entry for a review that was already over. The fence cannot help here —
    // the row was correct when written; it is the expiry that makes it stale — so
    // the expiry drain dispatches the clear itself.
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
    try {
      const { runId, reviewTaskId } = await producedGate();

      // Force the gate past its TTL and run the real drain.
      await withClient((c) =>
        c.query(
          `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
              SET expires_at = now() - interval '1 hour'
            WHERE run_id = $1 AND review_task_id = $2`,
          [runId, reviewTaskId],
        ),
      );
      const summary = await orch.sweepLifecycleGateMaintenance();
      expect(summary.optionalExpired).toBeGreaterThanOrEqual(1);
      expect(await gateStatus(runId, reviewTaskId)).toBe("resolved");

      // The entry goes with the review it announced.
      expect(await notificationRows(runId, reviewTaskId)).toHaveLength(0);
    } finally {
      delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
    }
  });

  it("CHANGES_REQUESTED clears the row too — asking for changes CLOSES the review", async () => {
    // The third and last transition that takes a gate out of `pending`:
    // `recordChangesRequested` CASes the base gate to `resolved` with the terminal
    // `changes_requested` disposition, closing this review attempt (a repair, and
    // later a successor gate, carry on from there). It never reaches
    // `commitReviewDecision` either, so the reviewer who asked for changes was left
    // with a bell entry pointing at the review they had just closed.
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
    try {
      const { runId, reviewTaskId, gateId, event } = await producedGate({
        destinationClass: "external_publish",
      });

      const recorded = await repairStore.recordChangesRequested({
        runId,
        reviewTaskId,
        orgId: ORG,
        request: {
          gateId,
          decisionId: `dec-${randomUUID()}`,
          idempotencyKey: `idem-${randomUUID()}`,
          baseTarget: {
            artifactId: event.artifactId,
            representationRevisionId: event.representationRevisionId,
          },
          expectedBaseRevisionId: event.representationRevisionId,
          findings: [{ id: "f1", message: "tighten the headline" }],
          continuationMode: "async_effects_gated",
          continuationAddress: null,
        },
        repairCapable: true,
        producerRunId: runId,
        currentBaseRevisionId: event.representationRevisionId,
      });
      expect(recorded.ok).toBe(true);

      const closed = await gateStore.readReviewGate(runId, reviewTaskId);
      expect(closed!.status).toBe("resolved");
      expect(closed!.disposition).toBe("changes_requested");
      expect(await notificationRows(runId, reviewTaskId)).toHaveLength(0);
    } finally {
      delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
    }
  });

  it("a RE-DRIVE of changes_requested clears a row a LOST first dispatch left behind", async () => {
    // The clear used to have exactly one chance: the first call's post-commit
    // dispatch. Lost to a swallowed notifier error or a process that died between
    // the commit and the dispatch, it was never re-attempted — and a retry, which
    // is precisely what a response-lost caller does, returned success past the
    // stale row.
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
    try {
      const { runId, reviewTaskId, gateId, event } = await producedGate({
        destinationClass: "external_publish",
      });
      const request = {
        gateId,
        decisionId: `dec-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        baseTarget: {
          artifactId: event.artifactId,
          representationRevisionId: event.representationRevisionId,
        },
        expectedBaseRevisionId: event.representationRevisionId,
        findings: [{ id: "f1", message: "tighten the headline" }],
        continuationMode: "async_effects_gated" as const,
        continuationAddress: null,
      };
      const first = await repairStore.recordChangesRequested({
        runId,
        reviewTaskId,
        orgId: ORG,
        request,
        repairCapable: true,
        producerRunId: runId,
        currentBaseRevisionId: event.representationRevisionId,
      });
      expect(first.ok).toBe(true);

      // Stand the row back up EXACTLY as a lost clear would leave it: written
      // directly, because the fenced writer would (correctly) refuse it now that
      // the gate is resolved. This is the state the defect leaves behind.
      await withClient((c) =>
        c.query(
          `INSERT INTO "${q(TEST_SCHEMA)}"."notifications"
             (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, dedupe_key, created_at)
           VALUES ($1, $2, 'user', $2, $3, 'warning', 'stranded', '', $4, now())`,
          [randomUUID(), USER, `user:${USER}`, `run-awaiting-human:auto:${runId}:${reviewTaskId}`],
        ),
      );
      expect(await notificationRows(runId, reviewTaskId)).toHaveLength(1);

      // The retry — same idempotency key, the response-lost re-drive.
      const second = await repairStore.recordChangesRequested({
        runId,
        reviewTaskId,
        orgId: ORG,
        request,
        repairCapable: true,
        producerRunId: runId,
        currentBaseRevisionId: event.representationRevisionId,
      });
      expect(second.ok).toBe(true);
      expect(await notificationRows(runId, reviewTaskId)).toHaveLength(0);
    } finally {
      delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
    }
  });

  // -------------------------------------------------------------------------
  // The lock itself — the claim is that two sessions cannot both proceed.
  // -------------------------------------------------------------------------

  it("CONTENDED (decision first): a guard that waits on the terminal CAS then matches NOTHING", async () => {
    // The open's guard arrives while the decision's CAS is still uncommitted,
    // blocks on its row lock, and — under READ COMMITTED — is re-evaluated against
    // the row version the CAS committed. It must find no row, which is what makes
    // "the review is already over" impossible to miss.
    const { runId, reviewTaskId } = await pendingGate();
    const fence = buildAutoGateNotificationFence({ schema: TEST_SCHEMA, runId, reviewTaskId });

    const decider = new Client({ connectionString: DB_URL });
    const open = new Client({ connectionString: DB_URL });
    await decider.connect();
    await open.connect();
    try {
      await decider.query("BEGIN");
      // The terminal CAS, verbatim in shape: pending → resolved.
      const cas = await decider.query(
        `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
            SET status = 'resolved', disposition = 'approve',
                fingerprint = $3, resolved_at = now()
          WHERE run_id = $1 AND review_task_id = $2 AND status = 'pending'`,
        [runId, reviewTaskId, `fp-${randomUUID()}`],
      );
      expect(cas.rowCount).toBe(1);

      let guardSettled = false;
      const guard = open.query(fence.guard, fence.values).then((r) => {
        guardSettled = true;
        return r;
      });
      // Bounded wait: if the lock did NOT hold, the guard would have answered here.
      await new Promise((r) => setTimeout(r, 400));
      expect(guardSettled).toBe(false);

      await decider.query("COMMIT");
      const guarded = await guard;
      // ZERO rows. The insert this guard feeds therefore inserts nothing, with no
      // code in between to get it wrong.
      expect(guarded.rowCount).toBe(0);
    } finally {
      await decider.query("ROLLBACK").catch(() => {});
      await decider.end().catch(() => {});
      await open.end().catch(() => {});
    }
  });

  it("CONTENDED (open first): the open's row lock makes the terminal CAS WAIT for it", async () => {
    // The other side of the same lock, and the reason the clear can never precede
    // the insert: the decision cannot even resolve the gate while the open holds
    // its row, and the clear runs only after that decision commits.
    const { runId, reviewTaskId } = await pendingGate();
    const fence = buildAutoGateNotificationFence({ schema: TEST_SCHEMA, runId, reviewTaskId });

    const open = new Client({ connectionString: DB_URL });
    const decider = new Client({ connectionString: DB_URL });
    await open.connect();
    await decider.connect();
    try {
      await open.query("BEGIN");
      const guarded = await open.query(fence.guard, fence.values);
      expect(guarded.rowCount).toBe(1);

      let casSettled = false;
      const cas = decider
        .query(
          `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
              SET status = 'resolved', disposition = 'approve',
                  fingerprint = $3, resolved_at = now()
            WHERE run_id = $1 AND review_task_id = $2 AND status = 'pending'`,
          [runId, reviewTaskId, `fp-${randomUUID()}`],
        )
        .then((r) => {
          casSettled = true;
          return r;
        });

      await new Promise((r) => setTimeout(r, 400));
      expect(casSettled).toBe(false);

      await open.query("COMMIT");
      const casResult = await cas;
      expect(casSettled).toBe(true);
      // The CAS still finds a `pending` row (the open changed no status), so the
      // decision happens AFTER the write — which is the ordering that lets the
      // clear see the row it must delete.
      expect(casResult.rowCount).toBe(1);
    } finally {
      await open.query("ROLLBACK").catch(() => {});
      await open.end().catch(() => {});
      await decider.end().catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // All four opening paths, through the one seam.
  // -------------------------------------------------------------------------

  describe.each(OPENING_PATHS)("$path", ({ taskId }) => {
    it("notifies while its gate is pending and writes NOTHING once its gate is decided", async () => {
      // Shape-blind on purpose. The review-task-id shape is the only thing that
      // differs between the four openers; the seam, the two ids it carries, and
      // the fence they build are identical, so there is no per-path variant that
      // could drift out of step.
      const live = await pendingGate(taskId());
      await dispatchAutoGateOpen(live);
      expect(await notificationRows(live.runId, live.reviewTaskId)).toHaveLength(1);

      const late = await pendingGate(taskId());
      await decide(late.runId, late.reviewTaskId);
      await dispatchAutoGateResolved(late);
      await dispatchAutoGateOpen(late);
      expect(await notificationRows(late.runId, late.reviewTaskId)).toHaveLength(0);
    });
  });
});
