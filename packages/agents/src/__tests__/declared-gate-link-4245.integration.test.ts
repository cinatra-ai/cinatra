/**
 * cinatra#4245 change C: the real-store proof that the produced-event sweep and a
 * template-declared review gate agree on ONE gate for a produced event, whatever
 * order they run in. The sweep decides a still-unlinked event only while it holds
 * that event's row FOR UPDATE, and it emits the automatic gate in that transaction.
 *
 * The windows are forced by barriers, not sleeps: one holds the sweep right after
 * its declared-gate lookup returned, the other holds it inside its locked
 * transaction right before the emit.
 *
 * With X4245_PAUSE_CLAIM_REALDB=1 a missing database fails. Without it the file
 * self-skips unless a real SUPABASE_DB_URL is given, as the other DB tier files do.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { producedEventId, type ArtifactProducedEvent } from "@/lib/lifecycle/lifecycle-produced-event";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { autoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const lookup = vi.hoisted(() => ({
  holdAtCall: 0,
  calls: 0,
  reached: null as null | (() => void),
  release: null as null | Promise<void>,
}));
// The event-row lock read, held for one event at its n-th lock: "before" holds
// before the row is locked and read, "after" holds with the row locked, inside the
// caller's transaction.
const lockCtl = vi.hoisted(() => ({
  eventId: null as null | string,
  atCall: 0,
  calls: 0,
  when: "after" as "before" | "after",
  reached: null as null | (() => void),
  release: null as null | Promise<void>,
}));
vi.mock("../lifecycle-declared-review-gate", async (orig) => {
  const actual = (await orig()) as typeof import("../lifecycle-declared-review-gate");
  return {
    ...actual,
    findDeclaredGateForPair: async (...args: Parameters<typeof actual.findDeclaredGateForPair>) => {
      const found = await actual.findDeclaredGateForPair(...args);
      lookup.calls += 1;
      if (lookup.calls === lookup.holdAtCall) {
        lookup.reached?.();
        await lookup.release;
      }
      return found;
    },
    lockProducedEventLink: async (...args: Parameters<typeof actual.lockProducedEventLink>) => {
      const hold = args[1] === lockCtl.eventId && (lockCtl.calls += 1) === lockCtl.atCall;
      if (hold && lockCtl.when === "before") {
        lockCtl.reached?.();
        await lockCtl.release;
      }
      const state = await actual.lockProducedEventLink(...args);
      if (hold && lockCtl.when === "after") {
        lockCtl.reached?.();
        await lockCtl.release;
      }
      return state;
    },
  };
});

const emitCtl = vi.hoisted(() => ({
  armed: false,
  fail: false,
  reached: null as null | (() => void),
  release: null as null | Promise<void>,
}));
vi.mock("../artifact-review-gate-store", async (orig) => {
  const actual = (await orig()) as typeof import("../artifact-review-gate-store");
  return {
    ...actual,
    emitArtifactReviewGate: async (...args: Parameters<typeof actual.emitArtifactReviewGate>) => {
      const underLock = args[1] !== undefined;
      if (underLock && emitCtl.fail) {
        emitCtl.fail = false;
        throw new Error("injected emit failure under the event lock");
      }
      if (underLock && emitCtl.armed) {
        emitCtl.armed = false;
        emitCtl.reached?.();
        await emitCtl.release;
      }
      return actual.emitArtifactReviewGate(...args);
    },
  };
});

// One mark of one event throws (once): the reuse's mark runs inside its locked
// transaction, so the throw must roll back the park and the link written before it.
const markCtl = vi.hoisted(() => ({ failFor: null as null | string }));
vi.mock("../lifecycle-produced-outbox-store", async (orig) => {
  const actual = (await orig()) as typeof import("../lifecycle-produced-outbox-store");
  return {
    ...actual,
    markProducedEventProcessed: async (...args: Parameters<typeof actual.markProducedEventProcessed>) => {
      if (markCtl.failFor !== null && args[0] === markCtl.failFor) {
        markCtl.failFor = null;
        throw new Error("injected mark failure");
      }
      return actual.markProducedEventProcessed(...args);
    },
  };
});

const TEST_SCHEMA = `cinatra_test_declared_gate_link_4245_${process.pid}`;
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
if (process.env.X4245_PAUSE_CLAIM_REALDB === "1" && !HAS_DB) {
  throw new Error("X4245_PAUSE_CLAIM_REALDB=1 needs a real database; refusing to skip");
}
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-4245-link";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let link: typeof import("../lifecycle-declared-review-gate");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

function mkEvent(over: Partial<ArtifactProducedEvent> = {}): ArtifactProducedEvent {
  const artifactId = `art-${randomUUID()}`;
  const representationRevisionId = `rev-${randomUUID()}`;
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

async function produce(over: Partial<ArtifactProducedEvent> = {}): Promise<ArtifactProducedEvent> {
  const ev = mkEvent(over);
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, 'document', '{}'::jsonb, $2) ON CONFLICT (id) DO NOTHING`,
    [ev.artifactId, ev.orgId],
  );
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

function pair(ev: ArtifactProducedEvent) {
  return { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId };
}

async function declareGate(ev: ArtifactProducedEvent, reviewTaskId = `wayflow-${randomUUID()}`): Promise<string> {
  const { gateId } = await gateStore.emitArtifactReviewGate({
    runId: ev.producerRunId!,
    orgId: ev.orgId,
    reviewTaskId,
    targets: [pair(ev)],
  });
  return gateId;
}

async function readEvent(eventId: string) {
  const r = await pool(
    `SELECT status, continuation_address FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id = $1`,
    [eventId],
  );
  return r.rows[0] as { status: string; continuation_address: string | null } | undefined;
}

async function gatesOfRun(runId: string) {
  const r = await pool(
    `SELECT id, review_task_id FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id = $1`,
    [runId],
  );
  return r.rows as Array<{ id: string; review_task_id: string }>;
}

async function setLink(eventId: string, gateId: string) {
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET continuation_address = $2 WHERE event_id = $1`,
    [eventId, gateId],
  );
}

async function deleteEvent(eventId: string) {
  await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id = $1`, [eventId]);
}

/** Hold the sweep after its n-th declared-gate lookup returned. */
function holdLookup(atCall = 1) {
  let reached!: () => void;
  const atBarrier = new Promise<void>((r) => { reached = r; });
  let release!: () => void;
  lookup.release = new Promise<void>((r) => { release = r; });
  lookup.reached = reached;
  lookup.calls = 0;
  lookup.holdAtCall = atCall;
  return { atBarrier, release };
}

/** Hold the sweep inside its locked transaction, right before the emit. */
function holdEmit() {
  let reached!: () => void;
  const atBarrier = new Promise<void>((r) => { reached = r; });
  let release!: () => void;
  emitCtl.release = new Promise<void>((r) => { release = r; });
  emitCtl.reached = reached;
  emitCtl.armed = true;
  return { atBarrier, release };
}

/** Hold the event-row lock read of one event at its n-th call, before or after the read. */
function holdLock(eventId: string, atCall: number, when: "before" | "after") {
  let reached!: () => void;
  const atBarrier = new Promise<void>((r) => { reached = r; });
  let release!: () => void;
  lockCtl.release = new Promise<void>((r) => { release = r; });
  lockCtl.reached = reached;
  lockCtl.eventId = eventId;
  lockCtl.calls = 0;
  lockCtl.atCall = atCall;
  lockCtl.when = when;
  return { atBarrier, release };
}

/** A second decider on its own connection: it locks the event's row, links it to
 * `gateId` only where no link is set yet, and commits. */
async function secondDecider(eventId: string, gateId: string) {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    const read = await c.query(
      `SELECT status, continuation_address FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id = $1 FOR UPDATE`,
      [eventId],
    );
    const wrote = await c.query(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET continuation_address = $2 WHERE event_id = $1 AND continuation_address IS NULL`,
      [eventId, gateId],
    );
    await c.query("COMMIT");
    return { before: read.rows[0] as { status: string; continuation_address: string | null } | undefined, linked: wrote.rowCount === 1 };
  } finally {
    await c.end();
  }
}

async function deleteGate(gateId: string) {
  await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id = $1`, [gateId]);
}

/** A writer other than the sweep finished the event: processed, on `gateId`. */
async function finishElsewhere(eventId: string, gateId: string) {
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET status = 'processed', continuation_address = $2 WHERE event_id = $1`,
    [eventId, gateId],
  );
}

/** The continuation parks of one event. */
async function parksOf(ev: ArtifactProducedEvent) {
  const r = await pool(
    `SELECT status, policy_decision_id FROM "${q(TEST_SCHEMA)}"."lifecycle_continuation_park" WHERE run_id = $1 AND event_id = $2`,
    [ev.producerRunId, ev.eventId],
  );
  return r.rows as Array<{ status: string; policy_decision_id: string | null }>;
}

/** Every event an earlier case left pending is processed, so a sweep's counts are this case's. */
async function settleStragglers() {
  await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET status = 'processed' WHERE org_id = $1 AND status = 'pending'`, [ORG]);
}

/** Resolves once Postgres shows a backend waiting on a row lock of THIS schema's outbox:
 * the statement names the table schema-qualified (drizzle and `secondDecider` both do),
 * so a backend of another schema's outbox does not count. */
async function untilSomeoneWaitsOnTheEventLock() {
  const table = `"${q(TEST_SCHEMA)}"."artifact_produced_outbox"`;
  for (let i = 0; i < 400; i += 1) {
    const r = await pool(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND strpos(query, $1) > 0 AND query ILIKE '%for update%'`,
      [table],
    );
    if ((r.rows[0] as { n: number }).n > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("no backend waited on the event's row lock");
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
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  link = await import("../lifecycle-declared-review-gate");
  dbMod = await import("../db");
}, 90_000);

beforeEach(() => {
  lookup.holdAtCall = 0;
  lookup.calls = 0;
  lookup.reached = null;
  lookup.release = null;
  emitCtl.armed = false;
  emitCtl.fail = false;
  emitCtl.reached = null;
  emitCtl.release = null;
  lockCtl.eventId = null;
  lockCtl.atCall = 0;
  lockCtl.calls = 0;
  lockCtl.reached = null;
  lockCtl.release = null;
  markCtl.failFor = null;
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

describe.skipIf(!HAS_DB)("cinatra#4245 the produced event's link (real database)", () => {
  it("a declared gate that opens while the sweep is held after its lookup gets no automatic twin", async () => {
    const ev = await produce();
    const held = holdLookup();
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    const declared = await declareGate(ev);
    held.release();
    await sweep;
    expect(await gatesOfRun(ev.producerRunId!)).toEqual([expect.objectContaining({ id: declared })]);
    expect(await readEvent(ev.eventId)).toEqual({ status: "processed", continuation_address: declared });
  });

  it("an event linked while the sweep is held stays on that gate; the sweep emits nothing", async () => {
    const ev = await produce();
    const elsewhere = await declareGate(mkEvent());
    const held = holdLookup();
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    await setLink(ev.eventId, elsewhere);
    held.release();
    await sweep;
    expect(await gatesOfRun(ev.producerRunId!)).toEqual([]);
    expect(await readEvent(ev.eventId)).toEqual({ status: "processed", continuation_address: elsewhere });
  });

  it("the reuse keeps a link that moved on to a successor gate after the lookup", async () => {
    const ev = await produce();
    await declareGate(ev);
    const successor = await declareGate(mkEvent());
    const held = holdLookup();
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    await setLink(ev.eventId, successor);
    held.release();
    await sweep;
    expect(await readEvent(ev.eventId)).toEqual({ status: "processed", continuation_address: successor });
  });

  it.each([
    { label: "no declared gate", declared: false },
    { label: "a declared gate", declared: true },
  ])("an event whose row is gone after the lookup found $label gets no gate and no failure", async ({ declared }) => {
    const ev = await produce();
    const gate = declared ? await declareGate(ev) : null;
    const held = holdLookup();
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    await deleteEvent(ev.eventId);
    held.release();
    const summary = await sweep;
    expect(summary.failed).toBe(0);
    expect((await gatesOfRun(ev.producerRunId!)).map((g) => g.id)).toEqual(gate ? [gate] : []);
    expect(await readEvent(ev.eventId)).toBeUndefined();
  });

  it("orchestrateProducedEvent answers already-processed, not gate-reused, for an event whose row is gone", async () => {
    const ev = await produce();
    await declareGate(ev);
    await deleteEvent(ev.eventId);
    const row = { ...ev, status: "pending" } as unknown as Parameters<typeof orch.orchestrateProducedEvent>[0];
    expect(await orch.orchestrateProducedEvent(row)).toBe("already-processed");
  });

  it("the lock serializes: a second decider waits for the sweep's emit and then reads the automatic gate's pin", async () => {
    const ev = await produce();
    const held = holdEmit();
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    const second = dbMod.db.transaction((tx) => link.lockProducedEventLink(tx, ev.eventId));
    try {
      await untilSomeoneWaitsOnTheEventLock();
    } finally {
      held.release();
    }
    await sweep;
    const state = await second;
    // The sweep committed its gate first, so the second decider never reads a free event.
    expect(state.kind === "settled" || (state.kind === "unlinked" && state.otherGatePinsRevision)).toBe(true);
    expect(await gatesOfRun(ev.producerRunId!)).toEqual([expect.objectContaining({ review_task_id: autoReviewTaskId(ev.eventId) })]);
  });

  it("an emit error under the lock rolls the transaction back: no gate, no link, and the next sweep emits", async () => {
    const ev = await produce();
    emitCtl.fail = true;
    await orch.sweepReviewOrchestration().catch(() => null);
    expect(await gatesOfRun(ev.producerRunId!)).toEqual([]);
    expect(await readEvent(ev.eventId)).toEqual({ status: "pending", continuation_address: null });
    await orch.sweepReviewOrchestration();
    const gates = await gatesOfRun(ev.producerRunId!);
    expect(gates).toHaveLength(1);
    expect((await readEvent(ev.eventId))?.continuation_address).toBe(gates[0].id);
  });

  it("a production of two: the member a declared gate took while the sweep was held is linked there; the other gets its own gate", async () => {
    const runId = `run-${randomUUID()}`;
    const a = await produce({ producerRunId: runId });
    const b = await produce({ producerRunId: runId });
    const held = holdLookup(2);
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    const declared = await declareGate(a);
    held.release();
    await sweep;
    await orch.sweepReviewOrchestration();
    const gates = await gatesOfRun(runId);
    expect(gates).toHaveLength(2);
    expect((await readEvent(a.eventId))?.continuation_address).toBe(declared);
    const auto = gates.find((g) => g.id !== declared)!;
    expect(auto.review_task_id).toBe(autoReviewTaskId(b.eventId));
    expect((await readEvent(b.eventId))?.continuation_address).toBe(auto.id);
  });

  it("a production of two: a member whose row is gone gets no gate, and the other does", async () => {
    const runId = `run-${randomUUID()}`;
    const a = await produce({ producerRunId: runId });
    const b = await produce({ producerRunId: runId });
    const held = holdLookup(2);
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    await deleteEvent(a.eventId);
    held.release();
    await sweep;
    await orch.sweepReviewOrchestration();
    const gates = await gatesOfRun(runId);
    expect(gates.map((g) => g.review_task_id)).toEqual([autoReviewTaskId(b.eventId)]);
    expect((await readEvent(b.eventId))?.status).toBe("processed");
  });

  it("the lock's states read directly", async () => {
    const read = (eventId: string) => dbMod.db.transaction((tx) => link.lockProducedEventLink(tx, eventId));
    expect(await read(`missing-${randomUUID()}`)).toEqual({ kind: "absent" });

    const free = await produce();
    expect(await read(free.eventId)).toEqual({ kind: "unlinked", declaredGateId: null, otherGatePinsRevision: false });

    const oldest = await declareGate(free, `wayflow-first-${randomUUID()}`);
    await declareGate(free, `wayflow-second-${randomUUID()}`);
    expect(await read(free.eventId)).toEqual({ kind: "unlinked", declaredGateId: oldest, otherGatePinsRevision: false });

    const pinned = await produce();
    await gateStore.emitArtifactReviewGate({
      runId: pinned.producerRunId!,
      orgId: pinned.orgId,
      reviewTaskId: `lifecycle-review:${randomUUID()}`,
      targets: [pair(pinned)],
    });
    expect(await read(pinned.eventId)).toEqual({ kind: "unlinked", declaredGateId: null, otherGatePinsRevision: true });

    const linked = await produce();
    await setLink(linked.eventId, oldest);
    expect(await read(linked.eventId)).toEqual({ kind: "settled", status: "pending", continuationAddress: oldest });

    await outboxStore.markProducedEventProcessed(linked.eventId);
    expect(await read(linked.eventId)).toEqual({ kind: "settled", status: "processed", continuationAddress: oldest });

    // Not swept into a later case's gate counts: every event left free here is linked now.
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET status = 'processed' WHERE org_id = $1 AND status = 'pending'`, [ORG]);
  });

  it("findDeclaredGateForPair matches only the same organization and the exact revision", async () => {
    const ev = await produce();
    const gate = await declareGate(ev);
    expect(await link.findDeclaredGateForPair(ev)).toBe(gate);
    expect(await link.findDeclaredGateForPair({ ...ev, orgId: "org-other" })).toBeNull();
    expect(await link.findDeclaredGateForPair({ ...ev, representationRevisionId: "rev-other" })).toBeNull();
    expect(await link.findDeclaredGateForPair({ ...ev, producerRunId: null })).toBeNull();
  });

  it("the reuse writes its link and mark under the event lock: a second decider waits, then finds the event linked and processed", async () => {
    await settleStragglers();
    const ev = await produce();
    const declared = await declareGate(ev);
    const other = await declareGate(mkEvent());
    const held = holdLock(ev.eventId, 1, "after");
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    const second = secondDecider(ev.eventId, other);
    try {
      await untilSomeoneWaitsOnTheEventLock();
    } finally {
      held.release();
    }
    await sweep;
    expect(await second).toEqual({ before: { status: "processed", continuation_address: declared }, linked: false });
    expect(await readEvent(ev.eventId)).toEqual({ status: "processed", continuation_address: declared });
  });

  it("a declared gate gone by the lock gets no link: the event stays pending, and the next sweep opens the automatic gate", async () => {
    await settleStragglers();
    const ev = await produce();
    const declared = await declareGate(ev);
    const held = holdLookup();
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    await deleteGate(declared);
    held.release();
    await sweep;
    expect(await readEvent(ev.eventId)).toEqual({ status: "pending", continuation_address: null });
    await orch.sweepReviewOrchestration();
    const gates = await gatesOfRun(ev.producerRunId!);
    expect(gates.map((g) => g.review_task_id)).toEqual([autoReviewTaskId(ev.eventId)]);
    expect(await readEvent(ev.eventId)).toEqual({ status: "processed", continuation_address: gates[0].id });
  });

  it("a production of two: a member linked elsewhere while the sweep was held is finished on that link, with no gate of its own", async () => {
    await settleStragglers();
    const runId = `run-${randomUUID()}`;
    const a = await produce({ producerRunId: runId });
    const b = await produce({ producerRunId: runId });
    const elsewhere = await declareGate(mkEvent());
    const held = holdLookup(2);
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    await setLink(a.eventId, elsewhere);
    held.release();
    await sweep;
    expect(await readEvent(a.eventId)).toEqual({ status: "processed", continuation_address: elsewhere });
    const gates = await gatesOfRun(runId);
    expect(gates.map((g) => g.review_task_id)).toEqual([autoReviewTaskId(b.eventId)]);
    expect(await readEvent(b.eventId)).toEqual({ status: "processed", continuation_address: gates[0].id });
  });

  it.each([
    { road: "lookup", answer: "settled" },
    { road: "lookup", answer: "absent" },
    { road: "lock", answer: "settled" },
    { road: "lock", answer: "absent" },
    { road: "lookup", answer: "unpinned" },
    { road: "lock", answer: "unpinned" },
  ] as const)("a production of two: a reuse found by the $road that answers $answer counts as noGate, and the other member gets its gate", async ({ road, answer }) => {
    await settleStragglers();
    const runId = `run-${randomUUID()}`;
    const a = await produce({ producerRunId: runId });
    const b = await produce({ producerRunId: runId });
    const elsewhere = await declareGate(mkEvent());
    let declaredA: string | null = null;
    if (road === "lookup") declaredA = await declareGate(a);
    // The reuse's own lock read: the first lock of a on the lookup road; on the
    // lock road the first is the emit's (it finds the declared gate), the second the reuse's.
    const lockHeld = holdLock(a.eventId, road === "lookup" ? 1 : 2, "before");
    const lookupHeld = road === "lock" ? holdLookup(2) : null;
    const sweep = orch.sweepReviewOrchestration();
    if (lookupHeld) {
      await lookupHeld.atBarrier;
      declaredA = await declareGate(a);
      lookupHeld.release();
    }
    await lockHeld.atBarrier;
    if (answer === "settled") await setLink(a.eventId, elsewhere);
    else if (answer === "absent") await deleteEvent(a.eventId);
    else await deleteGate(declaredA!);
    lockHeld.release();
    const summary = await sweep;
    expect({ noGate: summary.noGate, gatesCreated: summary.gatesCreated, failed: summary.failed }).toEqual({ noGate: 1, gatesCreated: 1, failed: 0 });
    // `unpinned`: no declared gate pins a's revision by the reuse's lock, so a gets no
    // link and stays pending for the next sweep.
    const aAfter = { settled: { status: "processed", continuation_address: elsewhere }, absent: undefined, unpinned: { status: "pending", continuation_address: null } }[answer];
    expect(await readEvent(a.eventId)).toEqual(aAfter);
    const tasks = (await gatesOfRun(runId)).map((g) => g.review_task_id);
    expect(tasks).toContain(autoReviewTaskId(b.eventId));
    expect(tasks).not.toContain(autoReviewTaskId(a.eventId));
  });

  it("a checkpointed reuse parks in the lock's transaction: a mark that throws there rolls the park and the link back", async () => {
    await settleStragglers();
    const ev = await produce({ continuationMode: "checkpointed" });
    const declared = await declareGate(ev);
    markCtl.failFor = ev.eventId;
    const summary = await orch.sweepReviewOrchestration();
    expect(summary.failed).toBe(1);
    expect(await readEvent(ev.eventId)).toEqual({ status: "pending", continuation_address: null });
    expect(await parksOf(ev)).toEqual([]);
    // The next sweep writes all three.
    await orch.sweepReviewOrchestration();
    expect(await readEvent(ev.eventId)).toEqual({ status: "processed", continuation_address: declared });
    expect(await parksOf(ev)).toEqual([{ status: "parked", policy_decision_id: declared }]);
  });

  it("an event processed elsewhere while the sweep is held after its lookup keeps its link and gets no park and no gate", async () => {
    await settleStragglers();
    const ev = await produce({ continuationMode: "checkpointed" });
    const declared = await declareGate(ev);
    const elsewhere = await declareGate(mkEvent());
    const held = holdLookup();
    const sweep = orch.sweepReviewOrchestration();
    await held.atBarrier;
    await finishElsewhere(ev.eventId, elsewhere);
    held.release();
    const summary = await sweep;
    expect(summary.failed).toBe(0);
    expect(await readEvent(ev.eventId)).toEqual({ status: "processed", continuation_address: elsewhere });
    expect(await parksOf(ev)).toEqual([]);
    expect((await gatesOfRun(ev.producerRunId!)).map((g) => g.id)).toEqual([declared]);
  });

  it("the batch lock takes the event rows in event-id order: two overlapping batches given in opposite orders both finish", async () => {
    await settleStragglers();
    const x = await produce();
    const y = await produce();
    const [lo, hi] = [x.eventId, y.eventId].sort();
    type LockRow = Parameters<typeof orch.__testOnly.emitUnderEventLocks>[0][number];
    const rowOf = (eventId: string) => ({ eventId }) as unknown as LockRow;
    const held = holdLock(lo, 1, "after");
    const first = orch.__testOnly.emitUnderEventLocks([rowOf(lo), rowOf(hi)], async () => "first");
    await held.atBarrier;
    const second = orch.__testOnly.emitUnderEventLocks([rowOf(hi), rowOf(lo)], async () => "second");
    try {
      await untilSomeoneWaitsOnTheEventLock();
    } finally {
      held.release();
    }
    const results = await Promise.allSettled([first, second]);
    expect(results).toEqual([
      { status: "fulfilled", value: { kind: "emitted", emitted: "first" } },
      { status: "fulfilled", value: { kind: "emitted", emitted: "second" } },
    ]);
    await settleStragglers();
  });
});
