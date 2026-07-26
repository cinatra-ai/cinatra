/**
 * Run-detail aggregate (cinatra#2066, C0, AC-1).
 *
 * Asserts the enforced-door contract of `readRunDetailAggregate`:
 *  - a DENIED actor gets `{ ok: false, status }` and NO run data is read (the
 *    access door short-circuits before any reader fires);
 *  - an ALLOWED actor gets the assembled aggregate — gates, skill selections and
 *    parked continuations — with per-gate advisory/verification/suggestion rows
 *    grouped by gate id.
 *
 * The store/gate readers are mocked so the test pins the ORCHESTRATION (enforce →
 * assemble), not the DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockEnforce = vi.fn();
const mockReadRun = vi.fn();
const mockReadMessages = vi.fn();
const mockListGates = vi.fn();
const mockAdvisory = vi.fn();
const mockVerification = vi.fn();
const mockSuggestions = vi.fn();
const mockParks = vi.fn();
const mockSkillRevs = vi.fn();

vi.mock("../artifact-review-gate-store", () => ({
  enforceReviewRunAccess: (...a: unknown[]) => mockEnforce(...a),
  listReviewGatesForRun: (...a: unknown[]) => mockListGates(...a),
  readAdvisoryCommentsForGates: (...a: unknown[]) => mockAdvisory(...a),
  readVerificationRecordsForGates: (...a: unknown[]) => mockVerification(...a),
  readSuggestionSnapshotsForGates: (...a: unknown[]) => mockSuggestions(...a),
}));
vi.mock("../store", () => ({
  readAgentRunById: (...a: unknown[]) => mockReadRun(...a),
  readAgentRunMessages: (...a: unknown[]) => mockReadMessages(...a),
}));
vi.mock("../lifecycle-continuation-park-store", () => ({
  readContinuationParksForRun: (...a: unknown[]) => mockParks(...a),
}));
vi.mock("@/lib/run-selected-skill-revisions", () => ({
  readRunSelectedSkillRevisions: (...a: unknown[]) => mockSkillRevs(...a),
}));

import { readRunDetailAggregate } from "../run-detail-aggregate";

const actor = { actorType: "human", source: "ui", userId: "u1" } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readRunDetailAggregate access enforcement (AC-1)", () => {
  it("DENIED actor: returns {ok:false,status} and reads NO run data", async () => {
    mockEnforce.mockResolvedValue({ ok: false, status: 404 });

    const out = await readRunDetailAggregate({ runId: "r1", actor });

    expect(out).toEqual({ ok: false, status: 404 });
    // The access door short-circuited — not a single data reader fired.
    expect(mockReadRun).not.toHaveBeenCalled();
    expect(mockListGates).not.toHaveBeenCalled();
    expect(mockParks).not.toHaveBeenCalled();
    expect(mockSkillRevs).not.toHaveBeenCalled();
  });

  it("ALLOWED actor: assembles gates + skills + parks with per-gate rows grouped", async () => {
    mockEnforce.mockResolvedValue({ ok: true });
    mockReadRun.mockResolvedValue({ id: "r1", orgId: "o1", status: "completed" });
    mockReadMessages.mockResolvedValue([{ id: "m1", sequence: 0, role: "assistant", messageType: "final" }]);
    mockListGates.mockResolvedValue([
      { id: "g1", runId: "r1", reviewTaskId: "t1", status: "resolved", disposition: "approved" },
      { id: "g2", runId: "r1", reviewTaskId: "t2", status: "pending", disposition: null },
    ]);
    mockAdvisory.mockResolvedValue([{ id: "a1", gateId: "g1", body: "note", authorId: "svc", authorKind: "service" }]);
    mockVerification.mockResolvedValue([{ id: "v1", gateId: "g2", outcome: "verified" }]);
    mockSuggestions.mockResolvedValue([]);
    mockParks.mockResolvedValue([{ id: "p1", runId: "r1", status: "parked" }]);
    mockSkillRevs.mockReturnValue([{ id: "s1", runId: "r1", skillId: "sk1", skillRevisionId: "rev1" }]);

    const out = await readRunDetailAggregate({ runId: "r1", actor });

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    const agg = out.aggregate;
    expect(agg.gates.map((g) => g.reviewTaskId)).toEqual(["t1", "t2"]);
    expect(agg.selectedSkillRevisions).toHaveLength(1);
    expect(agg.parkedContinuations).toHaveLength(1);
    // per-gate grouping
    expect(agg.advisoryCommentsByGate.g1).toHaveLength(1);
    expect(agg.verificationRecordsByGate.g2).toHaveLength(1);
    expect(agg.suggestionSnapshotsByGate).toEqual({});
    // the batch readers were fanned out over BOTH gate ids
    expect(mockAdvisory).toHaveBeenCalledWith(["g1", "g2"]);
  });

  it("ALLOWED but run vanished mid-read: returns {ok:false,status:404}", async () => {
    mockEnforce.mockResolvedValue({ ok: true });
    mockReadRun.mockResolvedValue(null);

    const out = await readRunDetailAggregate({ runId: "r1", actor });
    expect(out).toEqual({ ok: false, status: 404 });
  });
});
