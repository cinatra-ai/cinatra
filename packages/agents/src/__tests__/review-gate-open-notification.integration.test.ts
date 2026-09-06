/**
 * cinatra#2833 — EVERY fresh review-gate opening notifies, against the real store.
 *
 * The #2066 C2 notifier was wired to exactly ONE of the paths that open a review:
 * `orchestrateProducedEvent`, the single-produced-artifact sweep. The other three
 * opened gates in silence — the run was reviewable (its review page, the run
 * page's step rail, the lifecycle review tools all found it) while the bell
 * stayed empty:
 *
 *   BATCH        — `orchestrateProducedBatch` emits one gate per ≤50-target
 *                  partition and called neither the notifier nor the suggestion
 *                  producer.
 *   REPAIR PIN   — the successor gate `submitRepairResponse` pins is emitted
 *                  DIRECTLY (enlisted in the finalize transaction), outside the
 *                  sweep entirely.
 *   VERIFY PIN   — the bounded gate a failed verification reopens, likewise
 *                  direct.
 *
 * These are REAL-store proofs (fresh schema per file from the canonical
 * `buildCreateStoreSchemaQueries` bootstrap): a real produced-event outbox, real
 * partitioning, a real repair round-trip, a real verification verdict — with a
 * RECORDING notifier wired into the `packages/agents` seam, so what is asserted
 * is the seam actually being driven, once per fresh gate, with the (runId,
 * reviewTaskId) key the row is written and cleared under. The HOST half (which
 * row that key mints, to whom, and its clear) is pinned in
 * src/lib/__tests__/agent-run-wait-notifications.test.ts.
 *
 * What each case pins, per the issue's acceptance 1 + 2:
 *   - one notification per emitted gate (never per target — a 50-target partition
 *     is ONE review with ONE decision);
 *   - a re-sweep / re-drive of the same gate does NOT re-notify (the
 *     `!idempotent` posture the single path already had);
 *   - the key the open dispatches under is the gate's OWN (run, task), so the
 *     resolve-time clear finds the row it wrote — proven by driving a real
 *     terminal decision through `commitReviewDecision`;
 *   - the repair-successor notification fires only AFTER its enclosing
 *     transaction commits, never for a rolled-back finalize.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://user:pass@127.0.0.1:5432/db \
 *     pnpm --filter @cinatra-ai/agents test:integration review-gate-open-notification
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  producedEventId,
  type ArtifactProducedEvent,
} from "@/lib/lifecycle/lifecycle-produced-event";
import {
  autoReviewTaskId,
  batchPartitionReviewTaskId,
  isVerificationReopenTaskId,
  repairSuccessorReviewTaskId,
} from "@/lib/lifecycle/lifecycle-orchestration";
import { sealBatch, partitionBatchTargets, MAX_BATCH_PARTITION } from "@/lib/lifecycle/lifecycle-batch";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import type { ChangesRequestedRequest } from "@/lib/lifecycle/lifecycle-repair";

import { setRunWaitNotifier, type RunWaitNotifier } from "../run-wait-notifier";

/**
 * A one-shot hook that runs INSIDE the repair finalize transaction, immediately
 * after the successor gate is emitted and before the finalize CAS — the only
 * window from which the CAS can be made to miss deterministically (see the
 * ROLLBACK case below). Unarmed by default: `emitArtifactReviewGate` is otherwise
 * the real one, for this file and for every store that calls it.
 */
const hooks = vi.hoisted(() => ({ afterGateEmit: null as null | (() => Promise<void>) }));

vi.mock("../artifact-review-gate-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../artifact-review-gate-store")>();
  return {
    ...actual,
    emitArtifactReviewGate: async (
      ...args: Parameters<typeof actual.emitArtifactReviewGate>
    ): ReturnType<typeof actual.emitArtifactReviewGate> => {
      const emitted = await actual.emitArtifactReviewGate(...args);
      const hook = hooks.afterGateEmit;
      hooks.afterGateEmit = null; // one-shot
      if (hook) await hook();
      return emitted;
    },
  };
});

const TEST_SCHEMA = "cinatra_test_gate_notify_2833";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2833-gate-notify";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let repairStore: typeof import("../lifecycle-repair-store");
let verifStore: typeof import("../lifecycle-verification-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

// ---------------------------------------------------------------------------
// The recording notifier — the seam's observable side.
// ---------------------------------------------------------------------------

type GateKey = { runId: string; reviewTaskId: string };
const opened: GateKey[] = [];
const resolved: GateKey[] = [];

/** Every open dispatched for one run, in order. */
function openedFor(runId: string): GateKey[] {
  return opened.filter((o) => o.runId === runId);
}

async function insertObject(id: string, type: string, orgId = ORG) {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, $2, '{}'::jsonb, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, type, orgId],
  );
}

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
    producerAgentId: null,
    originKind: "agent_produced",
    destinationClass: "none",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
}

async function produce(
  type: string,
  over: Partial<ArtifactProducedEvent> = {},
): Promise<ArtifactProducedEvent> {
  const ev = mkEvent(over);
  await insertObject(ev.artifactId, type, ev.orgId);
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

function mkChangesRequested(
  ev: ArtifactProducedEvent,
  gateId: string,
  over: Partial<ChangesRequestedRequest> = {},
): ChangesRequestedRequest {
  return {
    gateId,
    decisionId: `dec-${randomUUID()}`,
    idempotencyKey: `idem-${randomUUID()}`,
    baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
    expectedBaseRevisionId: ev.representationRevisionId,
    findings: [
      { id: "f1", message: "tighten the headline" },
      { id: "f2", message: "add a CTA" },
    ],
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
}

/** A field projector for the verification verdict: base vs repaired field maps. */
function projector(
  baseRev: string,
  baseFields: Record<string, string>,
  repairedRev: string,
  repairedFields: Record<string, string>,
) {
  return async (target: { representationRevisionId: string }) => {
    if (target.representationRevisionId === baseRev) return baseFields;
    if (target.representationRevisionId === repairedRev) return repairedFields;
    return {};
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";

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

  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  repairStore = await import("../lifecycle-repair-store");
  verifStore = await import("../lifecycle-verification-store");
  dbMod = await import("../db");
}, 90_000);

beforeEach(() => {
  if (!HAS_DB) return;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  opened.length = 0;
  resolved.length = 0;
  setRunWaitNotifier({
    onEnterHumanWait: () => {},
    onLeaveHumanWait: () => {},
    onAutoGateOpen: (input) => {
      opened.push({ ...input });
    },
    onAutoGateResolved: (input) => {
      resolved.push({ ...input });
    },
  } satisfies RunWaitNotifier);
});

afterEach(() => {
  // Never leak the wired notifier into another test file's module singleton.
  setRunWaitNotifier(null);
});

afterAll(async () => {
  if (!HAS_DB) return;
  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#2833 — every fresh review-gate opening notifies (real store)", () => {
  it("BATCH: each fresh partition gate notifies EXACTLY once — one per gate, not per target; a re-sweep never re-notifies", async () => {
    // 60 durable artifacts from ONE producing run → the batch path, partitioned
    // into ⌈60/50⌉ = 2 gates. Before this change the whole production was silent.
    const runId = `run-batch-${randomUUID()}`;
    const N = 60;
    const events: ArtifactProducedEvent[] = [];
    for (let i = 0; i < N; i++) {
      events.push(
        await produce("document", {
          producerRunId: runId,
          destinationClass: "external_publish",
          originKind: "agent_produced",
        }),
      );
    }

    const summary = await orch.sweepReviewOrchestration({ limit: 200 });
    expect(summary.batchesCoalesced).toBe(1);

    // The partition task ids, recomputed from the SAME pure seal + partition the
    // store uses, are exactly the keys the notifier was driven with.
    const sealed = sealBatch({
      kind: "explicit",
      targets: events.map((e) => ({
        artifactId: e.artifactId,
        representationRevisionId: e.representationRevisionId,
      })),
    });
    if (!sealed.ok) throw new Error("seal failed");
    const partitions = partitionBatchTargets(sealed.targets);
    expect(partitions.length).toBe(Math.ceil(N / MAX_BATCH_PARTITION)); // 2
    const expectedTaskIds = new Set(partitions.map((p) => batchPartitionReviewTaskId(p)));

    // ONE notification per emitted GATE — 2, not 60. This is the assertion the
    // issue's "one gate can hold up to 50 targets" clause is about.
    const mine = openedFor(runId);
    expect(mine.length).toBe(partitions.length);
    expect(summary.gatesCreated).toBe(partitions.length);
    expect(new Set(mine.map((o) => o.reviewTaskId))).toEqual(expectedTaskIds);

    // The key each open dispatched under IS the gate's own (run, task) — so the
    // resolve-time clear, which is keyed the same way, can find the row.
    const gateRows = await pool(
      `SELECT id, review_task_id FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id = $1`,
      [runId],
    );
    const gates = gateRows.rows as Array<{ id: string; review_task_id: string }>;
    expect(new Set(gates.map((g) => g.review_task_id))).toEqual(
      new Set(mine.map((o) => o.reviewTaskId)),
    );

    // IDEMPOTENCY: re-emit every member + re-sweep → the same frozen partitions
    // re-emit idempotently, so NOT ONE further notification is dispatched.
    const before = opened.length;
    for (const e of events) await outboxStore.emitArtifactProduced(e, dbMod.db);
    const replay = await orch.sweepReviewOrchestration({ limit: 200 });
    expect(replay.gatesCreated).toBe(0);
    expect(opened.length).toBe(before);
  });

  it("BATCH: resolving a partition gate clears the row it opened — same (run, task) key, through a real terminal decision", async () => {
    const runId = `run-batch-resolve-${randomUUID()}`;
    const events: ArtifactProducedEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(
        await produce("document", {
          producerRunId: runId,
          destinationClass: "external_publish",
          originKind: "agent_produced",
        }),
      );
    }
    await orch.sweepReviewOrchestration({ limit: 50 });

    const mine = openedFor(runId);
    expect(mine.length).toBe(1); // 3 targets ⇒ ONE partition ⇒ ONE gate ⇒ ONE row
    const openKey = mine[0];

    // A REAL terminal decision on that gate (not a raw UPDATE), so the
    // resolve-side dispatch actually runs.
    const gate = await gateStore.readReviewGate(runId, openKey.reviewTaskId);
    expect(gate).not.toBeNull();
    const commit = await gateStore.commitReviewDecision({
      runId,
      reviewTaskId: openKey.reviewTaskId,
      disposition: "approve",
      terminal: true,
      fingerprint: `fp-${randomUUID()}`,
      comment: null,
      decidedBy: "user-2833-reviewer",
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

    // The clear names EXACTLY the key the open wrote under.
    expect(resolved).toContainEqual({
      runId: openKey.runId,
      reviewTaskId: openKey.reviewTaskId,
    });
  });

  it("REPAIR PIN: the successor gate notifies once, AFTER the finalize transaction commits; a re-drive does not re-notify", async () => {
    const ev = await produce("document", { destinationClass: "external_publish" });
    await orch.sweepReviewOrchestration();
    const runId = ev.producerRunId!;
    const baseTaskId = autoReviewTaskId(ev.eventId);
    const baseGate = await gateStore.readReviewGate(runId, baseTaskId);
    expect(baseGate).not.toBeNull();

    // The single-artifact path already notified for the BASE gate. Reset so what
    // this case asserts is unambiguously the successor pin.
    opened.length = 0;

    const req = mkChangesRequested(ev, baseGate!.id);
    const cr = await repairStore.recordChangesRequested({
      runId,
      reviewTaskId: baseTaskId,
      orgId: ORG,
      request: req,
      repairCapable: true,
      producerRunId: ev.producerRunId,
      currentBaseRevisionId: ev.representationRevisionId,
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const successorRev = `rev-repaired-${randomUUID()}`;
    const rr = await repairStore.submitRepairResponse({
      repairId: cr.repairId,
      currentBaseRevisionId: ev.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: req.gateId,
        baseTarget: req.baseTarget,
        successorTarget: { artifactId: ev.artifactId, representationRevisionId: successorRev },
        findingOutcomes: [
          { findingId: "f1", applied: true },
          { findingId: "f2", applied: true },
        ],
        changeSummary: "retitled + added CTA",
        producerProvenance: { runId: ev.producerRunId, agentId: null },
      },
    });
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;

    const successorTaskId = repairSuccessorReviewTaskId(cr.repairId, cr.attempt);
    expect(rr.successorTaskId).toBe(successorTaskId);

    // Notified exactly once, for the SUCCESSOR gate's own key.
    const successorOpens = opened.filter((o) => o.reviewTaskId === successorTaskId);
    expect(successorOpens).toEqual([{ runId, reviewTaskId: successorTaskId }]);

    // POST-COMMIT: the gate the notification points at is durably PENDING (it was
    // emitted enlisted in the finalize tx, so a notification for a rolled-back
    // finalize would name a gate that does not exist).
    const successorGate = await gateStore.readReviewGate(runId, successorTaskId);
    expect(successorGate).not.toBeNull();
    expect(successorGate!.status).toBe("pending");
    expect(successorGate!.id).toBe(rr.successorGateId);

    // A re-drive of the SAME response re-emits the same deterministic successor
    // gate idempotently and finalizes nothing — so it must not re-notify.
    const before = opened.length;
    await repairStore.submitRepairResponse({
      repairId: cr.repairId,
      currentBaseRevisionId: ev.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: req.gateId,
        baseTarget: req.baseTarget,
        successorTarget: { artifactId: ev.artifactId, representationRevisionId: successorRev },
        findingOutcomes: [
          { findingId: "f1", applied: true },
          { findingId: "f2", applied: true },
        ],
        changeSummary: "retitled + added CTA",
        producerProvenance: { runId: ev.producerRunId, agentId: null },
      },
    });
    expect(opened.length).toBe(before);
  });

  it("REPAIR PIN — ROLLBACK: a finalize that rolls back AFTER emitting the gate notifies NOBODY", async () => {
    // The negative half of the case above, and the one that makes "post-commit"
    // mean anything (Codex convergence round 2, finding 3a). The successor gate is
    // emitted ENLISTED in the finalize transaction, so a non-finalized outcome
    // discards it on a sentinel throw. If the dispatch sat inside that
    // transaction — or simply ran unconditionally after it — a human would be told
    // to review a gate that does not exist and never did, with nothing to clear
    // the row because no gate will ever be decided.
    const ev = await produce("document", { destinationClass: "external_publish" });
    await orch.sweepReviewOrchestration();
    const runId = ev.producerRunId!;
    const baseTaskId = autoReviewTaskId(ev.eventId);
    const baseGate = await gateStore.readReviewGate(runId, baseTaskId);
    expect(baseGate).not.toBeNull();

    const req = mkChangesRequested(ev, baseGate!.id);
    const cr = await repairStore.recordChangesRequested({
      runId,
      reviewTaskId: baseTaskId,
      orgId: ORG,
      request: req,
      repairCapable: true,
      producerRunId: ev.producerRunId,
      currentBaseRevisionId: ev.representationRevisionId,
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    // Only the successor pin is under test — the base gate already notified.
    opened.length = 0;

    // FORCE THE ROLLBACK, deterministically. `submitRepairResponse` reads the
    // repair BEFORE its transaction and CAS-guards the finalize on the status it
    // read; the gate emit happens first, inside the transaction. Moving the status
    // on a SEPARATE connection in exactly that window (no row lock is held on
    // lifecycle_repair yet, so this cannot deadlock) is the documented
    // "requested→dispatched transition" race: the CAS matches 0 rows and the
    // freshly-emitted successor gate is rolled back with it.
    hooks.afterGateEmit = async () => {
      await pool(
        `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status = 'dispatched' WHERE id = $1`,
        [cr.repairId],
      );
    };

    const rr = await repairStore.submitRepairResponse({
      repairId: cr.repairId,
      currentBaseRevisionId: ev.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: req.gateId,
        baseTarget: req.baseTarget,
        successorTarget: {
          artifactId: ev.artifactId,
          representationRevisionId: `rev-rolledback-${randomUUID()}`,
        },
        findingOutcomes: [
          { findingId: "f1", applied: true },
          { findingId: "f2", applied: true },
        ],
        changeSummary: "this finalize never lands",
        producerProvenance: { runId: ev.producerRunId, agentId: null },
      },
    });

    // The hook fired (it is one-shot and self-clearing) and the finalize did NOT
    // land: the response is refused as a concurrent finalize.
    expect(hooks.afterGateEmit).toBeNull();
    expect(rr.ok).toBe(false);
    if (rr.ok) return;
    expect(rr.code).toBe("concurrent-finalize");

    // The rollback really discarded the emitted gate — nothing to notify ABOUT.
    const successorTaskId = repairSuccessorReviewTaskId(cr.repairId, cr.attempt);
    expect(await gateStore.readReviewGate(runId, successorTaskId)).toBeNull();
    const gateRows = await pool(
      `SELECT id FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id = $1 AND review_task_id = $2`,
      [runId, successorTaskId],
    );
    expect(gateRows.rows).toHaveLength(0);

    // THE ASSERTION: zero notifications. Not "none for the successor" — zero, for
    // this run and for any other, across the whole rolled-back call.
    expect(opened).toEqual([]);
    // And the repair is left retriable rather than silently half-finalized.
    const repairRow = await pool(
      `SELECT status, successor_gate_id FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id = $1`,
      [cr.repairId],
    );
    expect(repairRow.rows[0]).toMatchObject({ status: "dispatched", successor_gate_id: null });
  });

  it("VERIFY PIN: a failed verification's reopened gate notifies once; the idempotent re-drive does not re-notify", async () => {
    const runId = `run-verify-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const baseRev = `rev-base-${randomUUID()}`;
    const ev = await produce("document", {
      artifactId,
      representationRevisionId: baseRev,
      producerRunId: runId,
      destinationClass: "external_publish",
    });
    await orch.sweepReviewOrchestration();
    const gate = await gateStore.readReviewGate(runId, autoReviewTaskId(ev.eventId));
    expect(gate).not.toBeNull();

    // Only the reopen pin is under test here.
    opened.length = 0;

    const repairedRev = `rev-rep-${randomUUID()}`;
    const call = () =>
      verifStore.recordVerificationForExternalChange({
        gateId: gate!.id,
        orgId: ORG,
        runId,
        reviewedTarget: { artifactId, representationRevisionId: baseRev },
        repairedTarget: { artifactId, representationRevisionId: repairedRev },
        acceptedFindings: [
          { id: "f1", path: "subject" },
          { id: "f2", path: "body" },
        ],
        // `body` unchanged ⇒ f2 unmet ⇒ a bounded reopen.
        projectFields: projector(
          baseRev,
          { subject: "Hi", body: "old" },
          repairedRev,
          { subject: "Hello", body: "old" },
        ),
      });

    const res = await call();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.outcome).toBe("unmet");
    expect(res.reopenedGateId).not.toBeNull();

    // ONE notification, keyed on the reopened gate's own (run, task).
    expect(opened.length).toBe(1);
    expect(opened[0].runId).toBe(runId);
    expect(isVerificationReopenTaskId(opened[0].reviewTaskId)).toBe(true);
    const reopened = await gateStore.readReviewGate(runId, opened[0].reviewTaskId);
    expect(reopened?.id).toBe(res.reopenedGateId);

    // The idempotent re-drive (which `submitRepairResponse`'s replay branch
    // performs) re-emits the identical gate — and must stay silent.
    const again = await call();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.reopenedGateId).toBe(res.reopenedGateId);
    expect(opened.length).toBe(1);
  });
});
