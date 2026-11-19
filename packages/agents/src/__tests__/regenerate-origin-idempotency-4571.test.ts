import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#3080, pre-review 1 of #4571, finding 3: the TYPED road and the lent
// REGENERATE must not share one idempotency namespace.
//
// The conversation's comment ("fix the crop") files a typed change request; it
// may escalate to a person, and then no successor is coming. A later lent
// Regenerate with the same words and no prompt derived the SAME key, so the
// canonical operation reconciled it against the typed row and answered
// idempotent success for a Regenerate nobody carried out. The key now carries
// the origin (a Regenerate key never equals a typed key), the typed key is
// byte-identical to the one stored rows carry, and a Regenerate meets the
// gate-state guard before it can reconcile against a row it did not write.
//
// The composer and the canonical operation are real; the database is a queue of
// read results (each `db.select()` chain ending in `.limit()` takes the next
// one), `db.transaction` is a spy, and the declaration read is the real one.

const ports = vi.hoisted(() => ({
  reads: [] as unknown[][],
  transaction: vi.fn(async () => {
    throw new Error("the transaction was opened");
  }),
  write: vi.fn(() => {
    throw new Error("a write was attempted");
  }),
  readReviewGate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../db", () => ({
  db: {
    select: () => {
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => {
          const result = ports.reads.shift();
          if (!result) throw new Error("Unexpected database read");
          return result;
        },
        then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
          Promise.resolve([] as unknown[]).then(resolve, reject),
      };
      return query;
    },
    transaction: ports.transaction,
    insert: ports.write,
    update: ports.write,
  },
}));
vi.mock("../artifact-review-gate-store", () => ({
  readReviewGate: ports.readReviewGate,
  emitArtifactReviewGate: vi.fn(),
  ArtifactReviewGateError: class extends Error {},
}));
vi.mock("../lifecycle-produced-outbox-store", () => ({
  readProducedEvent: vi.fn(async () => null),
}));
vi.mock("../run-wait-notifier", () => ({
  dispatchAutoGateOpen: vi.fn(async () => {}),
  dispatchAutoGateResolved: vi.fn(async () => {}),
}));

const RUN = "run-4571-f3";
const GATE_ID = "gate-4571-f3";
const TASK = "lifecycle-review:4571-f3";
const BASE = { artifactId: "art-4571-f3", representationRevisionId: "rev-4571-f3" };
const WORDS = "fix the crop";

/** The key the typed road has always derived for a note with no prompt, and the
 *  key every stored typed row carries. */
const LEGACY_TYPED_KEY = `pw:${createHash("sha256").update(`${GATE_ID}\u0000${WORDS}`).digest("hex")}`;

/** The repair row a TYPED conversation comment wrote on this gate: it escalated
 *  (no automatic repair), so no successor gate will ever be produced. */
function typedRow(status: "requested" | "escalated" = "escalated") {
  return {
    id: "repair-typed-4571",
    gateId: GATE_ID,
    idempotencyKey: LEGACY_TYPED_KEY,
    baseArtifactId: BASE.artifactId,
    baseRepresentationRevisionId: BASE.representationRevisionId,
    expectedBaseRevisionId: BASE.representationRevisionId,
    findings: [{ id: "prompt-window", message: WORDS }],
    route: status === "escalated" ? "human_escalation" : "producer_repair",
    continuationMode: "async_effects_gated",
    attempt: 1,
    status,
  };
}

beforeEach(() => {
  ports.transaction.mockClear();
  ports.write.mockClear();
  ports.readReviewGate.mockReset();
  // The composer reads the gate itself; the typed comment already resolved it.
  ports.readReviewGate.mockResolvedValue({
    id: GATE_ID,
    runId: RUN,
    orgId: "org-4571-f3",
    reviewTaskId: TASK,
    status: "resolved",
    pinnedTargets: [BASE],
  });
  ports.reads = [];
});

async function press(origin: "typed" | "regenerate") {
  const { recordReviewSurfaceChangesRequested } = await import(
    "../lifecycle-review-changes-requested-store"
  );
  return recordReviewSurfaceChangesRequested({
    runId: RUN,
    reviewTaskId: TASK,
    baseTarget: BASE,
    currentBaseRevisionId: BASE.representationRevisionId,
    feedback: WORDS,
    decidedBy: "user-4571-f3",
    origin,
  });
}

describe("cinatra#4571 pre-1 finding 3: typed and Regenerate origins do not collide", () => {
  it("a lent Regenerate with the typed comment's words is NOT reconciled as idempotent success against the escalated typed repair", async () => {
    // Reads in order: the producing run (none, so not repair-capable by
    // manifest), the artifact's object type (none, so not core-repairable),
    // the existing repair on the gate (the typed row), the gate's own state.
    ports.reads = [[], [], [typedRow("escalated")], [{ status: "resolved" }]];

    const result = await press("regenerate");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The first decision (the typed comment) stands: the answer is BLOCKED.
    expect(result.code).toBe("gate-not-pending");
    expect(ports.transaction).not.toHaveBeenCalled();
    expect(ports.write).not.toHaveBeenCalled();
  });

  it("the same holds when the typed repair is still in flight (requested): Regenerate does not adopt it", async () => {
    ports.reads = [[], [], [typedRow("requested")], [{ status: "resolved" }]];
    const result = await press("regenerate");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("gate-not-pending");
  });

  it("a typed retry still reconciles against its own stored row: the typed key is unchanged", async () => {
    ports.reads = [[], [], [typedRow("escalated")]];
    const result = await press("typed");
    expect(result).toEqual({
      ok: true,
      repairId: "repair-typed-4571",
      route: { kind: "human_escalation", reason: "escalated" },
      attempt: 1,
      status: "escalated",
      idempotent: true,
    });
    expect(ports.reads).toEqual([]);
  });
});
