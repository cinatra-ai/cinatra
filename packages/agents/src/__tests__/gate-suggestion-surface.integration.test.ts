/**
 * cinatra#2572 (epic #2564 S6c) — REAL-store proofs of what the CHIPS are drawn
 * from, against real DDL and real constraints (a fresh schema built from the
 * canonical `buildCreateStoreSchemaQueries` bootstrap).
 *
 * The chip row makes three claims about a database, and none of them survives a
 * mocked store:
 *
 *   C1  THE CHIPS ARE THE PINNED SET. What a reviewer sees is exactly the
 *       hash-verified snapshot the gate froze (S6a) — which is exactly the set
 *       the decision core validates a partition against (S6b). A chip a reviewer
 *       can press is therefore, by construction, an id the CAS will accept.
 *   C2  A PENDING GATE HAS NO RECORDED PARTITION. Marks are local to a screen
 *       until the one terminal decision carries them; the surface reports none.
 *   C3  A DECIDED GATE SHOWS WHAT WAS RECORDED — from the ledger the CAS wrote,
 *       in the REVIEWER's vocabulary (accepted / dismissed), not the drain's.
 *
 * Plus the failure direction that matters: a snapshot row edited underneath the
 * store must vanish from the chip row at the same moment it stops surfacing ids
 * to the decision core. The two must never disagree, or a reviewer could press a
 * chip whose id the CAS refuses.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm --filter @cinatra-ai/agents test:integration gate-suggestion-surface
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  submitReviewDecisionCore,
  ARTIFACT_REVIEW_DECISION_API_VERSION,
  type ArtifactReviewDecision,
  type SubmitDecisionPorts,
  type SuggestionDecisionPartition,
} from "@/lib/artifacts/artifact-review-decision";
import {
  buildGateSuggestions,
  type GateSuggestionSnapshotPayload,
} from "@/lib/lifecycle/lifecycle-suggestion-producer";
import type { CoreAnalysisTarget } from "@/lib/lifecycle/lifecycle-core-analysis";
import {
  lifecycleSuggestionSchema,
  projectLifecycleSuggestions,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_suggestion_surface_2572";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2572";

let gateStore: typeof import("../artifact-review-gate-store");
let snapStore: typeof import("../gate-suggestion-snapshot-store");
let decisionStore: typeof import("../suggestion-decision-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

interface GateFixture {
  runId: string;
  reviewTaskId: string;
  gateId: string;
  target: CoreAnalysisTarget;
  snapshotId: string;
  suggestionIds: string[];
}

/** A real producer payload — never a hand-written one, so the ids the partition
 * names are the ids the producer actually mints. */
function producedPayload(target: CoreAnalysisTarget): GateSuggestionSnapshotPayload {
  const built = buildGateSuggestions({
    target,
    projection: {
      includedFields: {
        title: "  a title  ",
        summary: "a summary   ",
        body: "  body text  ",
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

async function gateWithSuggestions(): Promise<GateFixture> {
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
    payload: producedPayload(target),
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

function ports(): SubmitDecisionPorts {
  return {
    verifyRunAccess: async () => ({ ok: true }),
    actingActorId: () => "user-decider-2572",
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
  };
}

function decisionFor(
  fixture: GateFixture,
  suggestionDecisions: SuggestionDecisionPartition | null,
): ArtifactReviewDecision {
  return {
    decisionApiVersion: ARTIFACT_REVIEW_DECISION_API_VERSION,
    runId: fixture.runId,
    reviewTaskId: fixture.reviewTaskId,
    disposition: "approve",
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
  dbMod = await import("../db");
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

// ---------------------------------------------------------------------------
// C1 — the chips ARE the pinned set the decision core validates against
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("C1 — the chip row is the gate's own pinned snapshot", () => {
  it("surfaces exactly the producer's suggestions, bound to the gate", async () => {
    const g = await gateWithSuggestions();
    const surface = await decisionStore.readGateSuggestionSurface(g.runId, g.reviewTaskId);
    expect(surface).not.toBeNull();
    expect(surface!.gateId).toBe(g.gateId);
    expect(surface!.snapshotId).toBe(g.snapshotId);
    expect(surface!.suggestions.map((s) => s.id).sort()).toEqual([...g.suggestionIds].sort());
  });

  it("the ids a chip can send are EXACTLY the ids the decision core will accept", async () => {
    const g = await gateWithSuggestions();
    const surface = await decisionStore.readGateSuggestionSurface(g.runId, g.reviewTaskId);
    const forDecision = await decisionStore.readSurfacedSuggestionsForGate(
      g.runId,
      g.reviewTaskId,
    );
    expect(surface!.suggestions.map((s) => s.id).sort()).toEqual(
      [...forDecision!.suggestionIds].sort(),
    );
    expect(surface!.snapshotId).toBe(forDecision!.snapshotId);
  });

  it("the projected chips satisfy the wire schema and carry the before/after pair on replace", async () => {
    const g = await gateWithSuggestions();
    const surface = await decisionStore.readGateSuggestionSurface(g.runId, g.reviewTaskId);
    const chips = projectLifecycleSuggestions(surface!.suggestions, surface!.marks);
    expect(chips).toHaveLength(surface!.suggestions.length);
    for (const chip of chips) {
      expect(lifecycleSuggestionSchema.safeParse(chip).success).toBe(true);
    }
    // A replace carries its panel pair: the disclosed current value beside the
    // canonicalized proposal. Non-replace ops draw label + class only.
    const values = surface!.suggestions.map((s) => s.value).filter(Boolean) as string[];
    expect(values.length).toBeGreaterThan(0);
    const replaceChips = chips.filter((c) => c.op === "replace");
    expect(replaceChips.length).toBeGreaterThan(0);
    for (const chip of replaceChips) {
      expect(chip.after).toBeTruthy();
      expect(chip.before).toBeTruthy();
      expect(chip.after).not.toBe(chip.before);
    }
    for (const chip of chips.filter((c) => c.op !== "replace")) {
      expect(chip.before).toBeUndefined();
      expect(chip.after).toBeUndefined();
    }
  });

  it("a gate with no snapshot surfaces nothing (and draws no chips)", async () => {
    const runId = `run-${randomUUID()}`;
    const reviewTaskId = `wayflow-${randomUUID()}`;
    await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId,
      targets: [
        { artifactId: `art-${randomUUID()}`, representationRevisionId: `rev-${randomUUID()}` },
      ],
    });
    expect(await decisionStore.readGateSuggestionSurface(runId, reviewTaskId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C2 / C3 — the marks
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("C2/C3 — a pending gate has no partition; a decided one shows it", () => {
  it("a PENDING gate reports no recorded marks, even when asked for them", async () => {
    const g = await gateWithSuggestions();
    const surface = await decisionStore.readGateSuggestionSurface(g.runId, g.reviewTaskId, {
      withRecordedMarks: true,
    });
    expect(surface!.marks.size).toBe(0);
  });

  it("after the ONE terminal decision, the surface reports the reviewer's own choices", async () => {
    const g = await gateWithSuggestions();
    const [accepted, dismissed] = g.suggestionIds;
    const result = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [accepted], dismissed: [dismissed] }),
      ports(),
    );
    expect(result.ok).toBe(true);

    const surface = await decisionStore.readGateSuggestionSurface(g.runId, g.reviewTaskId, {
      withRecordedMarks: true,
    });
    // The reviewer's vocabulary, not the drain's: the ledger stores `applied`
    // for an accepted item (it is the APPLICATION's word), and the chip says
    // "accepted" because that is what the reviewer decided.
    expect(surface!.marks.get(accepted)).toBe("accepted");
    expect(surface!.marks.get(dismissed)).toBe("dismissed");
    // An item nobody decided carries NO mark — the recorded partition is
    // reported exactly, never completed with an invented default.
    expect(surface!.marks.size).toBe(2);
    const chips = projectLifecycleSuggestions(surface!.suggestions, surface!.marks);
    expect(chips.filter((c) => c.mark === "accepted")).toHaveLength(1);
    expect(chips.filter((c) => c.mark === "dismissed")).toHaveLength(1);
    expect(chips.filter((c) => c.mark === undefined)).toHaveLength(
      surface!.suggestions.length - 2,
    );
  });

  it("marks are NOT read unless asked for (a pending card never touches the ledger)", async () => {
    const g = await gateWithSuggestions();
    await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    const withoutMarks = await decisionStore.readGateSuggestionSurface(g.runId, g.reviewTaskId);
    expect(withoutMarks!.marks.size).toBe(0);
    const withMarks = await decisionStore.readGateSuggestionSurface(g.runId, g.reviewTaskId, {
      withRecordedMarks: true,
    });
    expect(withMarks!.marks.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The failure direction: the chips and the decision core move together
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("a tampered snapshot vanishes from BOTH at once", () => {
  it("an edited payload stops drawing chips and stops surfacing ids, together", async () => {
    const g = await gateWithSuggestions();
    // Edit the immutable row underneath the store — the hash no longer matches.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."gate_suggestion_snapshots"
          SET payload = jsonb_set(payload, '{laneId}', '"forged-lane"') WHERE id = $1`,
      [g.snapshotId],
    );

    // No chips…
    expect(await decisionStore.readGateSuggestionSurface(g.runId, g.reviewTaskId)).toBeNull();
    // …and no surfaced ids, so the decision core refuses the very id the
    // reviewer could have pressed a moment earlier. The two can never disagree,
    // which is what stops a visible chip from becoming a uniform block.
    expect(await decisionStore.readSurfacedSuggestionsForGate(g.runId, g.reviewTaskId)).toBeNull();
    const result = await submitReviewDecisionCore(
      decisionFor(g, { accepted: [g.suggestionIds[0]], dismissed: [] }),
      ports(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("suggestion-not-surfaced");
    // Nothing was written and the gate is untouched.
    const gate = await pool(
      `SELECT status FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id = $1`,
      [g.gateId],
    );
    expect(gate.rows[0].status).toBe("pending");
  });
});
