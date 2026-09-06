/**
 * cinatra#2571 (epic #2564 S6b) — REAL-store proofs of suggestion decisions
 * inside the gate CAS, against real DDL and real constraints (a fresh schema
 * built from the canonical `buildCreateStoreSchemaQueries` bootstrap, which is
 * the migration-0092 twin).
 *
 * The claims this slice makes are all claims about a DATABASE under concurrency,
 * so none of them can be shown with a mocked commit port:
 *
 *   S1  ATOMIC — a terminal decision that carries a partition resolves the gate,
 *       writes one ledger row per decided suggestion, and writes ONE application
 *       intent, in a SINGLE transaction. A failure inside that transaction
 *       commits none of it (the gate stays pending, the ledger stays empty).
 *   S2  IDENTITY — two submissions that differ ONLY in which suggestions they
 *       accept are DIFFERENT fingerprints, so the second is a conflict, not an
 *       overwrite. An identical resubmission is idempotent and duplicates no row.
 *   S3  PRE-CAS — a forged / replayed / cross-gate suggestion id is refused
 *       BEFORE the CAS: the gate is still pending afterwards and nothing was
 *       written.
 *   S4  RACE — two concurrent decisions on the same gate: exactly one commits,
 *       exactly one intent exists, and the ledger reflects only the winner.
 *   S5  EXACTLY ONCE — the drain applies each accepted suggestion once; a
 *       crash/retry replay (an expired lease re-claimed) applies nothing twice;
 *       a partial application retries only what is left.
 *   S6  DEAD-LETTER — an intent that exhausts its attempts leaves the claim set
 *       and appears in the ops read.
 *   S7  UNBOUND — with no applier registered the sweep claims nothing, so a
 *       waiting intent cannot churn its way to dead-letter, and it is visible in
 *       the "awaiting" ops read the whole time.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm --filter @cinatra-ai/agents test:integration suggestion-decision-cas
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  submitReviewDecisionCore,
  ARTIFACT_REVIEW_DECISION_API_VERSION,
  type ArtifactReviewDecision,
  type ReviewDisposition,
  type SubmitDecisionPorts,
  type SuggestionDecisionPartition,
} from "@/lib/artifacts/artifact-review-decision";
import {
  buildGateSuggestions,
  type GateSuggestionSnapshotPayload,
} from "@/lib/lifecycle/lifecycle-suggestion-producer";
import type { CoreAnalysisTarget } from "@/lib/lifecycle/lifecycle-core-analysis";

const TEST_SCHEMA = "cinatra_test_suggestion_cas_2571";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2571";

let gateStore: typeof import("../artifact-review-gate-store");
let snapStore: typeof import("../gate-suggestion-snapshot-store");
let decisionStore: typeof import("../suggestion-decision-store");
let delivery: typeof import("../suggestion-application-delivery");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

// ---------------------------------------------------------------------------
// Fixtures: a pending gate, pinned to one target, carrying a real snapshot
// produced by the S6a producer (never a hand-written payload — the ids the
// partition names have to be the ids the producer actually mints).
// ---------------------------------------------------------------------------

interface GateFixture {
  runId: string;
  reviewTaskId: string;
  gateId: string;
  target: CoreAnalysisTarget;
  snapshotId: string;
  suggestionIds: string[];
}

function producedPayload(
  target: CoreAnalysisTarget,
  variant = "a",
): GateSuggestionSnapshotPayload {
  const built = buildGateSuggestions({
    target,
    // Three dirty fields ⇒ three deterministic `replace` suggestions.
    //
    // `variant` changes the DISCLOSED TEXT, which changes the projection digest,
    // which changes the minted ids. That matters for the cross-gate test below: a
    // suggestion id is derived from (lane, projection digest, op, pointer) and NOT
    // from the gate — so two gates shown the SAME text legitimately mint the same
    // ids. That is not a replay hole (membership is checked against the gate's OWN
    // snapshot, and an equal id there names the same suggestion), but it does mean
    // the cross-gate proof has to use genuinely different content.
    projection: {
      includedFields: {
        title: `  a ${variant} title  `,
        summary: `a ${variant} summary   `,
        body: `  ${variant} body text  `,
      },
      excludedFields: [],
    },
    authzDecision: "authorized",
  });
  if (built.suggestions.length < 3) {
    throw new Error(`fixture produced ${built.suggestions.length} suggestions, expected >= 3`);
  }
  return built.payload;
}

async function gateWithSuggestions(variant = "a"): Promise<GateFixture> {
  const target: CoreAnalysisTarget = {
    artifactId: `art-${randomUUID()}`,
    representationRevisionId: `rev-${randomUUID()}`,
  };
  const runId = `run-${randomUUID()}`;
  const reviewTaskId = `wayflow-${randomUUID()}`;
  const emitted = await gateStore.emitArtifactReviewGate({
    runId,
    orgId: ORG,
    reviewTaskId,
    targets: [target],
  });
  const written = await snapStore.writeGateSuggestionSnapshot({
    gateId: emitted.gateId,
    payload: producedPayload(target, variant),
  });
  if (written.status !== "written") throw new Error(`snapshot not written: ${written.status}`);
  const surfaced = await decisionStore.readSurfacedSuggestionsForGate(runId, reviewTaskId);
  if (!surfaced) throw new Error("snapshot not readable");
  return {
    runId,
    reviewTaskId,
    gateId: emitted.gateId,
    target,
    snapshotId: surfaced.snapshotId,
    suggestionIds: surfaced.suggestionIds,
  };
}

function ports(over: Partial<SubmitDecisionPorts> = {}): SubmitDecisionPorts {
  return {
    verifyRunAccess: async () => ({ ok: true }),
    actingActorId: () => "user-decider-2571",
    readGateState: (runId, reviewTaskId) => gateStore.readReviewGateState(runId, reviewTaskId),
    revisionMember: async () => ({ mime: "text/plain" }),
    deriveProvenance: async () => ({
      kind: "build-map" as const,
      packageName: "@cinatra-ai/default-artifact",
      digest: null,
    }),
    readSurfacedSuggestions: (runId, reviewTaskId) =>
      decisionStore.readSurfacedSuggestionsForGate(runId, reviewTaskId),
    commit: (plan) => gateStore.commitReviewDecision(plan),
    ...over,
  };
}

function decisionFor(
  fixture: GateFixture,
  suggestionDecisions: SuggestionDecisionPartition | null,
  disposition: ReviewDisposition = "approve",
): ArtifactReviewDecision {
  return {
    decisionApiVersion: ARTIFACT_REVIEW_DECISION_API_VERSION,
    runId: fixture.runId,
    reviewTaskId: fixture.reviewTaskId,
    disposition,
    comment: null,
    reviewedTargets: [
      {
        artifactId: fixture.target.artifactId,
        representationRevisionId: fixture.target.representationRevisionId,
      },
    ],
    suggestionDecisions,
  };
}

async function ledgerRows(gateId: string) {
  const r = await pool(
    `SELECT suggestion_id, snapshot_id, decision, decided_by, decision_fingerprint, applied_at
       FROM "${q(TEST_SCHEMA)}"."suggestion_decision_ledger" WHERE gate_id = $1 ORDER BY suggestion_id`,
    [gateId],
  );
  return r.rows as {
    suggestion_id: string;
    snapshot_id: string;
    decision: string;
    decided_by: string;
    decision_fingerprint: string;
    applied_at: Date | null;
  }[];
}

async function intentRows(gateId: string) {
  const r = await pool(
    `SELECT gate_id, snapshot_id, accepted_ids, status, attempts, max_attempts, dead_lettered_at
       FROM "${q(TEST_SCHEMA)}"."suggestion_application_outbox" WHERE gate_id = $1`,
    [gateId],
  );
  return r.rows as {
    gate_id: string;
    snapshot_id: string;
    accepted_ids: string[];
    status: string;
    attempts: number;
    max_attempts: number;
    dead_lettered_at: Date | null;
  }[];
}

/**
 * Drop every OTHER pending intent so a drain assertion is about THIS gate.
 *
 * The sweep is deliberately global (it is a queue drain), and the suites above
 * leave undrained intents behind on purpose — they are proving the DECISION half,
 * not the delivery half. Without this the drain summaries would count them.
 */
async function onlyIntentFor(gateId: string) {
  await pool(
    `DELETE FROM "${q(TEST_SCHEMA)}"."suggestion_application_outbox" WHERE gate_id <> $1`,
    [gateId],
  );
}

async function gateRow(gateId: string) {
  const r = await pool(
    `SELECT status, disposition, fingerprint FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id = $1`,
    [gateId],
  );
  return r.rows[0] as { status: string; disposition: string | null; fingerprint: string | null };
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
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  gateStore = await import("../artifact-review-gate-store");
  snapStore = await import("../gate-suggestion-snapshot-store");
  decisionStore = await import("../suggestion-decision-store");
  delivery = await import("../suggestion-application-delivery");
  dbMod = await import("../db");
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  delivery?.clearSuggestionApplier();
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

// ---------------------------------------------------------------------------
// S0 — the bootstrap DDL really is the shape this slice writes against.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S0 — the reshaped ledger + the new outbox exist", () => {
  it("the ledger is keyed per ITEM, not per snapshot", async () => {
    const cols = await pool(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'suggestion_decision_ledger'`,
      [TEST_SCHEMA],
    );
    const names = cols.rows.map((r: { column_name: string }) => r.column_name).sort();
    expect(names).toContain("snapshot_id");
    expect(names).toContain("decision_fingerprint");
    expect(names).toContain("applied_at");

    const idx = await pool(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'suggestion_decision_ledger_uniq'`,
      [TEST_SCHEMA],
    );
    expect(idx.rows).toHaveLength(1);
    // The uniqueness that lets ONE snapshot hold MANY decided suggestions.
    expect(idx.rows[0].indexdef).toContain("snapshot_id");
    expect(idx.rows[0].indexdef).toContain("suggestion_id");
  });

  it("the application outbox exists with the resume-outbox lease shape", async () => {
    const cols = await pool(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'suggestion_application_outbox'`,
      [TEST_SCHEMA],
    );
    const names = cols.rows.map((r: { column_name: string }) => r.column_name);
    for (const col of [
      "gate_id",
      "snapshot_id",
      "accepted_ids",
      "status",
      "attempts",
      "max_attempts",
      "lease_token",
      "lease_expires_at",
      "dead_lettered_at",
      "last_error",
    ]) {
      expect(names).toContain(col);
    }
  });
});

// ---------------------------------------------------------------------------
// S1 — ATOMIC with the gate CAS.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S1 — the partition commits inside the gate CAS", () => {
  it("resolves the gate, writes one ledger row per decided suggestion, and ONE intent", async () => {
    const g = await gateWithSuggestions();
    const [s1, s2, s3] = g.suggestionIds;
    const result = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [s1, s3], dismissed: [s2] }),
      ports(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const gate = await gateRow(g.gateId);
    expect(gate.status).toBe("resolved");
    expect(gate.fingerprint).toBe(result.fingerprint);

    const rows = await ledgerRows(g.gateId);
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((r) => [r.suggestion_id, r]));
    expect(byId.get(s1)!.decision).toBe("applied");
    expect(byId.get(s3)!.decision).toBe("applied");
    expect(byId.get(s2)!.decision).toBe("dismissed");
    // Every row is bound to the SAME decision and the SAME snapshot.
    for (const row of rows) {
      expect(row.snapshot_id).toBe(g.snapshotId);
      expect(row.decision_fingerprint).toBe(result.fingerprint);
      expect(row.decided_by).toBe("user-decider-2571");
      expect(row.applied_at).toBeNull();
    }

    const intents = await intentRows(g.gateId);
    expect(intents).toHaveLength(1);
    expect(intents[0].snapshot_id).toBe(g.snapshotId);
    expect([...intents[0].accepted_ids].sort()).toEqual([s1, s3].sort());
    expect(intents[0].status).toBe("pending");
    expect(intents[0].attempts).toBe(0);
  });

  it("a decision that only DISMISSES writes ledger rows and NO intent", async () => {
    const g = await gateWithSuggestions();
    const r = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [], dismissed: [g.suggestionIds[0]] }),
      ports(),
    );
    expect(r.ok).toBe(true);
    expect(await ledgerRows(g.gateId)).toHaveLength(1);
    expect(await intentRows(g.gateId)).toHaveLength(0);
  });

  it("a decision with NO partition writes neither — the pre-#2571 behaviour is untouched", async () => {
    const g = await gateWithSuggestions();
    const r = await submitReviewDecisionCore(decisionFor(g, null), ports());
    expect(r.ok).toBe(true);
    expect(await ledgerRows(g.gateId)).toHaveLength(0);
    expect(await intentRows(g.gateId)).toHaveLength(0);
  });

  it("ZERO PARTIAL COMMIT — a failure inside the transaction rolls the gate back too", async () => {
    const g = await gateWithSuggestions();
    // A plan whose ledger insert cannot land: an accepted id bound to a snapshot
    // row that does not exist trips the snapshot FK inside the transaction.
    await expect(
      gateStore.commitReviewDecision({
        runId: g.runId,
        reviewTaskId: g.reviewTaskId,
        disposition: "approve",
        terminal: true,
        fingerprint: "fp-rollback-2571",
        comment: null,
        auditRows: [],
        dispositionOps: [],
        resumeIntent: { kind: "approve", userResponse: "{}" },
        suggestionPlan: {
          snapshotId: "gsug_does_not_exist",
          accepted: [g.suggestionIds[0]],
          dismissed: [],
        },
        decidedBy: "user-decider-2571",
      }),
    ).rejects.toBeTruthy();

    const gate = await gateRow(g.gateId);
    expect(gate.status).toBe("pending");
    expect(await ledgerRows(g.gateId)).toHaveLength(0);
    expect(await intentRows(g.gateId)).toHaveLength(0);
  });

  it("the store REFUSES a hand-built plan that would apply on a non-terminal decision", async () => {
    const g = await gateWithSuggestions();
    await expect(
      gateStore.commitReviewDecision({
        runId: g.runId,
        reviewTaskId: g.reviewTaskId,
        disposition: "comment",
        terminal: false,
        fingerprint: "fp-comment-2571",
        comment: "note",
        auditRows: [],
        dispositionOps: [],
        resumeIntent: null,
        suggestionPlan: { snapshotId: g.snapshotId, accepted: [g.suggestionIds[0]], dismissed: [] },
        decidedBy: "user-decider-2571",
      }),
    ).rejects.toThrow(/terminal/i);
    expect((await gateRow(g.gateId)).status).toBe("pending");
    expect(await ledgerRows(g.gateId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S2 — the partition IS the decision's identity.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S2 — conflict + idempotency semantics hold on a real gate", () => {
  it("a DIFFERENT partition on the resolved gate CONFLICTS and changes nothing", async () => {
    const g = await gateWithSuggestions();
    const [s1, s2] = g.suggestionIds;
    const first = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [s1], dismissed: [] }),
      ports(),
    );
    expect(first.ok).toBe(true);

    const second = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [s2], dismissed: [] }),
      ports(),
    );
    expect(second).toEqual({ ok: false, error: { kind: "gate-conflict" } });

    const rows = await ledgerRows(g.gateId);
    expect(rows.map((r) => r.suggestion_id)).toEqual([s1]);
    const intents = await intentRows(g.gateId);
    expect(intents).toHaveLength(1);
    expect(intents[0].accepted_ids).toEqual([s1]);
  });

  it("an IDENTICAL resubmission is idempotent and duplicates no row", async () => {
    const g = await gateWithSuggestions();
    const partition = { accepted: [g.suggestionIds[0]], dismissed: [g.suggestionIds[1]] };
    const first = await submitReviewDecisionCore(decisionFor(g, partition), ports());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    const retry = await submitReviewDecisionCore(decisionFor(g, partition), ports());
    expect(retry).toMatchObject({ ok: true, idempotent: true, fingerprint: first.fingerprint });
    expect(await ledgerRows(g.gateId)).toHaveLength(2);
    expect(await intentRows(g.gateId)).toHaveLength(1);
  });

  it("a re-ordered resubmission is the SAME decision (canonical identity)", async () => {
    const g = await gateWithSuggestions();
    const [s1, s2, s3] = g.suggestionIds;
    const first = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [s1, s3], dismissed: [s2] }),
      ports(),
    );
    if (!first.ok) throw new Error("unreachable");
    const retry = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [s3, s1], dismissed: [s2] }),
      ports(),
    );
    expect(retry).toMatchObject({ ok: true, idempotent: true, fingerprint: first.fingerprint });
  });

  it("the SAME disposition with NO partition is a DIFFERENT decision than one WITH", async () => {
    const g = await gateWithSuggestions();
    const first = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    expect(first.ok).toBe(true);
    const bare = await submitReviewDecisionCore(decisionFor(g, null), ports());
    expect(bare).toEqual({ ok: false, error: { kind: "gate-conflict" } });
  });
});

// ---------------------------------------------------------------------------
// S3 — forged / replayed ids never reach a write.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S3 — unsurfaced ids are refused PRE-CAS", () => {
  it("a forged id leaves the gate PENDING and writes nothing", async () => {
    const g = await gateWithSuggestions();
    const r = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0], "sug_forged"], dismissed: [] }),
      ports(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("suggestion-not-surfaced");

    expect((await gateRow(g.gateId)).status).toBe("pending");
    expect(await ledgerRows(g.gateId)).toHaveLength(0);
    expect(await intentRows(g.gateId)).toHaveLength(0);
  });

  it("an id belonging to ANOTHER gate's snapshot is refused (no cross-gate replay)", async () => {
    const mine = await gateWithSuggestions();
    const theirs = await gateWithSuggestions("elsewhere");
    // The two snapshots are over different targets, so their ids differ.
    expect(theirs.suggestionIds).not.toEqual(mine.suggestionIds);
    const r = await submitReviewDecisionCore(
      decisionFor(mine, { accepted: [theirs.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    expect(r.ok).toBe(false);
    expect((await gateRow(mine.gateId)).status).toBe("pending");
    expect(await ledgerRows(mine.gateId)).toHaveLength(0);
  });

  it("a TAMPERED snapshot row surfaces NOTHING, so its own ids stop being decidable", async () => {
    const g = await gateWithSuggestions();
    // Edit the stored payload underneath the store: the hash no longer verifies,
    // so the verified read drops the row and the partition is refused wholesale.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."gate_suggestion_snapshots"
          SET payload = jsonb_set(payload, '{truncated}', 'true'::jsonb) WHERE gate_id = $1`,
      [g.gateId],
    );
    expect(await decisionStore.readSurfacedSuggestionsForGate(g.runId, g.reviewTaskId)).toBeNull();
    const r = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    expect(r.ok).toBe(false);
    expect((await gateRow(g.gateId)).status).toBe("pending");
    expect(await ledgerRows(g.gateId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S4 — concurrency.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S4 — two concurrent partitions, exactly one decision", () => {
  it("exactly one commits; the ledger and the intent reflect only the winner", async () => {
    const g = await gateWithSuggestions();
    const [s1, s2] = g.suggestionIds;
    const [a, b] = await Promise.all([
      submitReviewDecisionCore(decisionFor(g, { accepted: [s1], dismissed: [] }), ports()),
      submitReviewDecisionCore(decisionFor(g, { accepted: [s2], dismissed: [] }), ports()),
    ]);
    const okCount = [a, b].filter((r) => r.ok).length;
    expect(okCount).toBe(1);

    const gate = await gateRow(g.gateId);
    expect(gate.status).toBe("resolved");
    const rows = await ledgerRows(g.gateId);
    expect(rows).toHaveLength(1);
    const winner = [a, b].find((r) => r.ok);
    if (!winner || !winner.ok) throw new Error("unreachable");
    expect(rows[0].decision_fingerprint).toBe(winner.fingerprint);
    expect(gate.fingerprint).toBe(winner.fingerprint);

    const intents = await intentRows(g.gateId);
    expect(intents).toHaveLength(1);
    expect(intents[0].accepted_ids).toEqual([rows[0].suggestion_id]);
  });

  it("two concurrent IDENTICAL submissions both succeed and write ONE set of rows", async () => {
    const g = await gateWithSuggestions();
    const partition = { accepted: [g.suggestionIds[0]], dismissed: [g.suggestionIds[1]] };
    const [a, b] = await Promise.all([
      submitReviewDecisionCore(decisionFor(g, partition), ports()),
      submitReviewDecisionCore(decisionFor(g, partition), ports()),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(await ledgerRows(g.gateId)).toHaveLength(2);
    expect(await intentRows(g.gateId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// S5 — the drain applies exactly once.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S5 — the application drain", () => {
  it("applies each accepted suggestion ONCE, and a replay applies nothing", async () => {
    const g = await gateWithSuggestions();
    const [s1, s2, s3] = g.suggestionIds;
    const decided = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [s1, s2], dismissed: [s3] }),
      ports(),
    );
    expect(decided.ok).toBe(true);
    await onlyIntentFor(g.gateId);

    const calls: string[][] = [];
    const applier = async (req: { suggestions: { id: string }[] }) => {
      calls.push(req.suggestions.map((s) => s.id));
      return { status: "applied" as const, appliedIds: req.suggestions.map((s) => s.id) };
    };

    const first = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(first.applierBound).toBe(true);
    expect(first.attempted).toBe(1);
    expect(first.completed).toBe(1);
    expect(first.applied).toBe(2);

    const rows = await ledgerRows(g.gateId);
    const stamped = rows.filter((r) => r.applied_at !== null).map((r) => r.suggestion_id).sort();
    expect(stamped).toEqual([s1, s2].sort());
    // A dismissal is NEVER stamped applied.
    expect(rows.find((r) => r.suggestion_id === s3)!.applied_at).toBeNull();

    // The intent is done, so a re-run does not even see it.
    expect((await intentRows(g.gateId))[0].status).toBe("done");
    const second = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(second.attempted).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("a CRASH replay (expired lease re-claimed) applies nothing twice", async () => {
    const g = await gateWithSuggestions();
    const [s1] = g.suggestionIds;
    await submitReviewDecisionCore(decisionFor(g, { accepted: [s1], dismissed: [] }), ports());
    await onlyIntentFor(g.gateId);

    // Pass 1: the applier's effect lands and is stamped, then the worker "crashes"
    // before marking the intent done — simulated by leaving the intent delivering
    // with an EXPIRED lease.
    const seen: string[][] = [];
    const applier = async (req: { suggestions: { id: string }[] }) => {
      seen.push(req.suggestions.map((s) => s.id));
      return { status: "applied" as const, appliedIds: req.suggestions.map((s) => s.id) };
    };
    const claimed = await decisionStore.claimPendingApplicationIntents({ leaseMs: 60_000 });
    expect(claimed).toHaveLength(1);
    await delivery.applySuggestionIntent(claimed[0], applier);
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."suggestion_application_outbox"
          SET status = 'delivering', lease_expires_at = now() - interval '1 hour' WHERE gate_id = $1`,
      [g.gateId],
    );

    // Pass 2: the expired lease is re-claimed. There is nothing left unapplied, so
    // the applier is never called again and the intent simply closes.
    const replay = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(replay.attempted).toBe(1);
    expect(replay.alreadyApplied).toBe(1);
    expect(replay.applied).toBe(0);
    expect(seen).toHaveLength(1);

    const rows = await ledgerRows(g.gateId);
    expect(rows.filter((r) => r.applied_at !== null)).toHaveLength(1);
    expect((await intentRows(g.gateId))[0].status).toBe("done");
  });

  it("a PARTIAL application retries only what is left", async () => {
    const g = await gateWithSuggestions();
    const [s1, s2] = g.suggestionIds;
    await submitReviewDecisionCore(decisionFor(g, { accepted: [s1, s2], dismissed: [] }), ports());
    await onlyIntentFor(g.gateId);

    const offered: string[][] = [];
    let pass = 0;
    const applier = async (req: { suggestions: { id: string }[] }) => {
      offered.push(req.suggestions.map((s) => s.id));
      pass += 1;
      // First pass lands only ONE of the two.
      return pass === 1
        ? { status: "applied" as const, appliedIds: [req.suggestions[0].id] }
        : { status: "applied" as const, appliedIds: req.suggestions.map((s) => s.id) };
    };

    const one = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 1_000 });
    expect(one.applied).toBe(1);
    expect(one.retryable).toBe(1);
    expect((await intentRows(g.gateId))[0].status).toBe("delivering");

    // Expire the lease so the next sweep re-claims it.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."suggestion_application_outbox"
          SET lease_expires_at = now() - interval '1 hour' WHERE gate_id = $1`,
      [g.gateId],
    );
    const two = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(two.applied).toBe(1);
    expect(two.completed).toBe(1);
    // The second pass was offered ONLY the suggestion that had not landed.
    expect(offered[1]).toHaveLength(1);
    expect(offered[1][0]).not.toBe(offered[0][0]);
    expect((await ledgerRows(g.gateId)).filter((r) => r.applied_at !== null)).toHaveLength(2);
  });

  it("an applier can only stamp what it was OFFERED", async () => {
    const g = await gateWithSuggestions();
    const [s1, s2] = g.suggestionIds;
    await submitReviewDecisionCore(decisionFor(g, { accepted: [s1], dismissed: [s2] }), ports());
    await onlyIntentFor(g.gateId);
    // The applier claims it applied the DISMISSED suggestion too.
    const applier = async (req: { suggestions: { id: string }[] }) => ({
      status: "applied" as const,
      appliedIds: [...req.suggestions.map((s) => s.id), s2],
    });
    const r = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(r.applied).toBe(1);
    const rows = await ledgerRows(g.gateId);
    expect(rows.find((row) => row.suggestion_id === s2)!.applied_at).toBeNull();
  });

  it("the per-item stamp is a CAS — two racing stamps produce exactly one winner", async () => {
    const g = await gateWithSuggestions();
    const [s1] = g.suggestionIds;
    await submitReviewDecisionCore(decisionFor(g, { accepted: [s1], dismissed: [] }), ports());
    await onlyIntentFor(g.gateId);
    // The stamp is lease-fenced, so a stamp needs the intent's live lease.
    const [leased] = await decisionStore.claimPendingApplicationIntents({ leaseMs: 60_000 });
    const token = leased.leaseToken!;
    const [a, b] = await Promise.all([
      decisionStore.markSuggestionApplied({
        gateId: g.gateId,
        snapshotId: g.snapshotId,
        suggestionId: s1,
        leaseToken: token,
      }),
      decisionStore.markSuggestionApplied({
        gateId: g.gateId,
        snapshotId: g.snapshotId,
        suggestionId: s1,
        leaseToken: token,
      }),
    ]);
    const claimed = [a, b].filter((r) => r.status === "claimed");
    const already = [a, b].filter((r) => r.status === "already-applied");
    expect(claimed).toHaveLength(1);
    expect(already).toHaveLength(1);
  });

  it("a DISMISSED suggestion can never be stamped applied", async () => {
    const g = await gateWithSuggestions();
    const [s1] = g.suggestionIds;
    await submitReviewDecisionCore(decisionFor(g, { accepted: [], dismissed: [s1] }), ports());
    await onlyIntentFor(g.gateId);
    const r = await decisionStore.markSuggestionApplied({
      gateId: g.gateId,
      snapshotId: g.snapshotId,
      suggestionId: s1,
      leaseToken: "irrelevant — a dismissal is never stampable",
    });
    expect(r.status).toBe("not-accepted");
    expect((await ledgerRows(g.gateId))[0].applied_at).toBeNull();
  });

  it("a live lease is mutually exclusive — a second claim does not see the row", async () => {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    await onlyIntentFor(g.gateId);
    const first = await decisionStore.claimPendingApplicationIntents({ leaseMs: 60_000 });
    expect(first.map((i) => i.gateId)).toContain(g.gateId);
    const second = await decisionStore.claimPendingApplicationIntents({ leaseMs: 60_000 });
    expect(second.map((i) => i.gateId)).not.toContain(g.gateId);
    // ...and a STALE lease token cannot close another worker's pass.
    expect(await decisionStore.markApplicationIntentDone(g.gateId, "not-my-lease")).toBe(false);
  });

  it("a terminal REFUSAL closes the intent without stamping anything", async () => {
    const g = await gateWithSuggestions();
    const [s1] = g.suggestionIds;
    await submitReviewDecisionCore(decisionFor(g, { accepted: [s1], dismissed: [] }), ports());
    await onlyIntentFor(g.gateId);
    const applier = async () => ({ status: "refused" as const, reason: "target is gone" });
    const r = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(r.refused).toBe(1);
    expect(r.applied).toBe(0);
    // DEAD-LETTERED, not done: a refusal leaves accepted suggestions unapplied
    // forever, so it must stay in the ops queue with its reason.
    const row = (await intentRows(g.gateId))[0];
    expect(row.dead_lettered_at).not.toBeNull();
    expect((await ledgerRows(g.gateId))[0].applied_at).toBeNull();
    const ops = await decisionStore.readDeadLetteredApplicationIntents({ orgId: ORG });
    const mine = ops.find((o) => o.gateId === g.gateId);
    expect(mine?.lastError).toContain("target is gone");
  });
});

// ---------------------------------------------------------------------------
// S6 — dead-letter + ops visibility.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S6 — an exhausted intent dead-letters into the ops queue", () => {
  it("leaves the claim set and appears in the ops read", async () => {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    // Exhaust the budget without churning 20 real passes.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."suggestion_application_outbox"
          SET attempts = max_attempts WHERE gate_id = $1`,
      [g.gateId],
    );
    const dead = await decisionStore.deadLetterExhaustedApplicationIntents({
      lastError: "test exhaustion",
    });
    expect(dead).toBeGreaterThanOrEqual(1);

    const row = (await intentRows(g.gateId))[0];
    expect(row.dead_lettered_at).not.toBeNull();

    // Never re-claimed.
    const claimed = await decisionStore.claimPendingApplicationIntents({ leaseMs: 60_000 });
    expect(claimed.map((i) => i.gateId)).not.toContain(g.gateId);

    // Ops sees it, scoped to the owning org.
    const ops = await decisionStore.readDeadLetteredApplicationIntents({ orgId: ORG });
    const mine = ops.find((o) => o.gateId === g.gateId);
    expect(mine).toBeTruthy();
    expect(mine!.acceptedCount).toBe(1);
    expect(mine!.appliedCount).toBe(0);
    expect(mine!.lastError).toBe("test exhaustion");

    // ...and NOT to a different org.
    const other = await decisionStore.readDeadLetteredApplicationIntents({ orgId: `${ORG}-b` });
    expect(other.map((o) => o.gateId)).not.toContain(g.gateId);
  });
});

// ---------------------------------------------------------------------------
// S7 — the unbound-applier posture.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S7 — with NO applier registered", () => {
  it("claims nothing, burns no attempt, and stays visible in the awaiting queue", async () => {
    delivery.clearSuggestionApplier();
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );

    const summary = await delivery.sweepSuggestionApplicationIntents();
    expect(summary.applierBound).toBe(false);
    expect(summary.attempted).toBe(0);

    const row = (await intentRows(g.gateId))[0];
    expect(row.status).toBe("pending");
    // The whole point: an unclaimed row cannot churn its way to dead-letter.
    expect(row.attempts).toBe(0);
    expect(row.dead_lettered_at).toBeNull();

    const waiting = await decisionStore.readAwaitingApplicationIntents({ orgId: ORG });
    const mine = waiting.find((w) => w.gateId === g.gateId);
    expect(mine).toBeTruthy();
    expect(mine!.acceptedCount).toBe(1);
    expect(mine!.appliedCount).toBe(0);
  });

  it("registering an applier makes the SAME waiting intent drain", async () => {
    const g = await gateWithSuggestions();
    const [s1] = g.suggestionIds;
    await submitReviewDecisionCore(decisionFor(g, { accepted: [s1], dismissed: [] }), ports());
    expect((await delivery.sweepSuggestionApplicationIntents()).attempted).toBe(0);

    await onlyIntentFor(g.gateId);
    delivery.registerSuggestionApplier(async (req) => ({
      status: "applied" as const,
      appliedIds: req.suggestions.map((s) => s.id),
    }));
    try {
      expect(delivery.isSuggestionApplierRegistered()).toBe(true);
      const summary = await delivery.sweepSuggestionApplicationIntents({ leaseMs: 60_000 });
      expect(summary.applierBound).toBe(true);
      expect(summary.applied).toBeGreaterThanOrEqual(1);
      const row = (await ledgerRows(g.gateId)).find((r) => r.suggestion_id === s1);
      expect(row!.applied_at).not.toBeNull();
    } finally {
      delivery.clearSuggestionApplier();
    }
  });
});

// ---------------------------------------------------------------------------
// S8 — the Codex round-1 findings, each pinned by the case that would regress.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S8 — round-1 hardening", () => {
  it("a stamp WITHOUT the intent's live lease is refused (no unfenced record)", async () => {
    const g = await gateWithSuggestions();
    const [s1] = g.suggestionIds;
    await submitReviewDecisionCore(decisionFor(g, { accepted: [s1], dismissed: [] }), ports());
    await onlyIntentFor(g.gateId);

    // No lease at all yet.
    const noLease = await decisionStore.markSuggestionApplied({
      gateId: g.gateId,
      snapshotId: g.snapshotId,
      suggestionId: s1,
      leaseToken: "forged-lease",
    });
    expect(noLease.status).toBe("lease-lost");
    expect((await ledgerRows(g.gateId))[0].applied_at).toBeNull();

    // A real lease, then a STALE holder after it is re-claimed.
    const [first] = await decisionStore.claimPendingApplicationIntents({ leaseMs: 60_000 });
    const staleToken = first.leaseToken!;
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."suggestion_application_outbox"
          SET lease_expires_at = now() - interval '1 hour' WHERE gate_id = $1`,
      [g.gateId],
    );
    const [second] = await decisionStore.claimPendingApplicationIntents({ leaseMs: 60_000 });
    expect(second.leaseToken).not.toBe(staleToken);

    const stale = await decisionStore.markSuggestionApplied({
      gateId: g.gateId,
      snapshotId: g.snapshotId,
      suggestionId: s1,
      leaseToken: staleToken,
    });
    expect(stale.status).toBe("lease-lost");
    expect((await ledgerRows(g.gateId))[0].applied_at).toBeNull();

    // The CURRENT owner stamps fine.
    const owner = await decisionStore.markSuggestionApplied({
      gateId: g.gateId,
      snapshotId: g.snapshotId,
      suggestionId: s1,
      leaseToken: second.leaseToken!,
    });
    expect(owner.status).toBe("claimed");
    expect((await ledgerRows(g.gateId))[0].applied_at).not.toBeNull();
  });

  it("an EXHAUSTED intent is never re-claimed — it dead-letters instead of churning", async () => {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    await onlyIntentFor(g.gateId);
    // The state the old claim predicate would have re-leased forever: attempts at
    // the ceiling, status delivering, lease expired.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."suggestion_application_outbox"
          SET attempts = max_attempts, status = 'delivering',
              lease_expires_at = now() - interval '1 hour'
        WHERE gate_id = $1`,
      [g.gateId],
    );
    const claimed = await decisionStore.claimPendingApplicationIntents({ leaseMs: 60_000 });
    expect(claimed.map((i) => i.gateId)).not.toContain(g.gateId);

    // ...and the sweep dead-letters it BEFORE claiming, so one tick ends the churn.
    const applier = async () => ({ status: "retryable" as const, reason: "never called" });
    const summary = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(summary.attempted).toBe(0);
    expect(summary.deadLettered).toBeGreaterThanOrEqual(1);
    const row = (await intentRows(g.gateId))[0];
    expect(row.dead_lettered_at).not.toBeNull();
    expect(row.attempts).toBe(row.max_attempts);
  });

  it("the ledger insert is FAIL-CLOSED — a pre-existing row rolls the decision back", async () => {
    const g = await gateWithSuggestions();
    const [s1] = g.suggestionIds;
    // Plant a row for this (snapshot, suggestion) that no decision wrote.
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."suggestion_decision_ledger"
         (id, suggestion_id, snapshot_id, gate_id, decision, decided_by, decision_fingerprint)
       VALUES ($1, $2, $3, $4, 'dismissed', 'someone-else', 'fp-not-this-decision')`,
      [`sdec_planted_${randomUUID().slice(0, 8)}`, s1, g.snapshotId, g.gateId],
    );
    const r = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [s1], dismissed: [] }),
      ports(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("commit-failed");
    // Nothing partially committed: the gate is still pending and the planted row
    // was not overwritten by a decision that did not win.
    expect((await gateRow(g.gateId)).status).toBe("pending");
    const rows = await ledgerRows(g.gateId);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("dismissed");
    expect(await intentRows(g.gateId)).toHaveLength(0);
  });

  it("the outbox FKs its snapshot — deleting the snapshot cannot strand an intent", async () => {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    expect(await intentRows(g.gateId)).toHaveLength(1);
    await pool(`DELETE FROM "${q(TEST_SCHEMA)}"."gate_suggestion_snapshots" WHERE gate_id = $1`, [
      g.gateId,
    ]);
    expect(await intentRows(g.gateId)).toHaveLength(0);
    expect(await ledgerRows(g.gateId)).toHaveLength(0);
  });

  it("the outbox status vocabulary is CHECK-constrained on a bootstrap-built schema", async () => {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    await expect(
      pool(
        `UPDATE "${q(TEST_SCHEMA)}"."suggestion_application_outbox" SET status = 'applied' WHERE gate_id = $1`,
        [g.gateId],
      ),
    ).rejects.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// S9 — the Codex round-2 findings.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S9 — round-2 hardening: expiry revokes ownership", () => {
  async function leasedIntent() {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    await onlyIntentFor(g.gateId);
    const [leased] = await decisionStore.claimPendingApplicationIntents({ leaseMs: 60_000 });
    return { g, token: leased.leaseToken! };
  }

  /** Expire the lease WITHOUT letting anyone re-claim it — the exact window a
   *  token-only predicate would wave through. */
  async function expireLease(gateId: string) {
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."suggestion_application_outbox"
          SET lease_expires_at = now() - interval '1 second' WHERE gate_id = $1`,
      [gateId],
    );
  }

  it("markApplicationIntentDone refuses an EXPIRED lease, before any re-claim", async () => {
    const { g, token } = await leasedIntent();
    await expireLease(g.gateId);
    expect(await decisionStore.markApplicationIntentDone(g.gateId, token)).toBe(false);
    expect((await intentRows(g.gateId))[0].status).toBe("delivering");
  });

  it("deadLetterApplicationIntent refuses an EXPIRED lease, before any re-claim", async () => {
    const { g, token } = await leasedIntent();
    await expireLease(g.gateId);
    expect(await decisionStore.deadLetterApplicationIntent(g.gateId, token, "stale")).toBe(false);
    expect((await intentRows(g.gateId))[0].dead_lettered_at).toBeNull();
  });

  it("a DEAD-LETTERED intent can no longer be marked done", async () => {
    const { g, token } = await leasedIntent();
    expect(await decisionStore.deadLetterApplicationIntent(g.gateId, token, "terminal")).toBe(true);
    expect(await decisionStore.markApplicationIntentDone(g.gateId, token)).toBe(false);
    expect((await intentRows(g.gateId))[0].dead_lettered_at).not.toBeNull();
  });

  it("an intent that exhausts its budget IN a pass dead-letters on that same tick", async () => {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    await onlyIntentFor(g.gateId);
    // One attempt left; the pass consumes it and the applier cannot deliver.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."suggestion_application_outbox"
          SET attempts = max_attempts - 1 WHERE gate_id = $1`,
      [g.gateId],
    );
    const applier = async () => ({ status: "retryable" as const, reason: "downstream down" });
    const summary = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(summary.attempted).toBe(1);
    // Counted as a DEAD-LETTER, not as an applier refusal.
    expect(summary.deadLettered).toBe(1);
    expect(summary.refused).toBe(0);
    // Dead-lettered under the pass's OWN live lease — not left for a later sweep.
    const row = (await intentRows(g.gateId))[0];
    expect(row.dead_lettered_at).not.toBeNull();
    expect(row.attempts).toBe(row.max_attempts);
    const ops = await decisionStore.readDeadLetteredApplicationIntents({ orgId: ORG });
    expect(ops.find((o) => o.gateId === g.gateId)?.lastError).toContain("attempts exhausted");
  });

  it("a pass with attempts REMAINING is still retryable, not dead-lettered", async () => {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    await onlyIntentFor(g.gateId);
    const applier = async () => ({ status: "retryable" as const, reason: "downstream down" });
    const summary = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(summary.retryable).toBe(1);
    const row = (await intentRows(g.gateId))[0];
    expect(row.dead_lettered_at).toBeNull();
    expect(row.attempts).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("S10 — round-3: EVERY unsuccessful exit honours the budget", () => {
  async function lastAttemptIntent() {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    await onlyIntentFor(g.gateId);
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."suggestion_application_outbox"
          SET attempts = max_attempts - 1 WHERE gate_id = $1`,
      [g.gateId],
    );
    return g;
  }

  it("an unresolvable snapshot on the LAST attempt dead-letters on that tick", async () => {
    const g = await lastAttemptIntent();
    // Tamper the snapshot so the accepted ids resolve to nothing.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."gate_suggestion_snapshots"
          SET payload = jsonb_set(payload, '{truncated}', 'true'::jsonb) WHERE gate_id = $1`,
      [g.gateId],
    );
    const applier = async () => ({ status: "applied" as const, appliedIds: [] });
    const summary = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(summary.deadLettered).toBe(1);
    const row = (await intentRows(g.gateId))[0];
    expect(row.dead_lettered_at).not.toBeNull();
    const ops = await decisionStore.readDeadLetteredApplicationIntents({ orgId: ORG });
    expect(ops.find((o) => o.gateId === g.gateId)?.lastError).toContain("no longer resolves");
  });

  it("an applier that THROWS on the LAST attempt dead-letters on that tick", async () => {
    const g = await lastAttemptIntent();
    const applier = async () => {
      throw new Error("applier exploded");
    };
    const summary = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(summary.failed).toBe(1);
    expect(summary.deadLettered).toBe(1);
    const row = (await intentRows(g.gateId))[0];
    expect(row.dead_lettered_at).not.toBeNull();
    const ops = await decisionStore.readDeadLetteredApplicationIntents({ orgId: ORG });
    expect(ops.find((o) => o.gateId === g.gateId)?.lastError).toContain("threw");
  });

  it("an applier that throws with attempts REMAINING is only left for re-claim", async () => {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    await onlyIntentFor(g.gateId);
    const applier = async () => {
      throw new Error("transient");
    };
    const summary = await delivery.sweepSuggestionApplicationIntents({ applier, leaseMs: 60_000 });
    expect(summary.failed).toBe(1);
    expect(summary.deadLettered).toBe(0);
    expect((await intentRows(g.gateId))[0].dead_lettered_at).toBeNull();
  });
});
