/**
 * THE STEP-BY-STEP PREVIEW STILL OPENS ON THE RUN THAT EXISTS
 * (cinatra#2928 review, blocker 2).
 *
 * WHAT WENT WRONG. Moving the preview onto the coordinator's launch changed its
 * FAILURE POSTURE while its comment went on describing the old one. A dispatch
 * failure used to be logged and the panel still opened on the created run; the
 * rewritten path returned `{ ok: false }` and discarded the run id — so the run
 * created for the person was left with nothing pointing at it, on the one
 * surface that could have shown it to them.
 *
 * WHAT IS TRUE NOW. The posture the comment always described: logged, and the
 * panel opens. The run is in BETTER shape than before this slice, because the
 * coordinator's ladder has already returned it to `pending_input` — decidable
 * and retryable — instead of leaving it `queued` with no job behind it.
 *
 * The launch NAMES the run it created on the error it rethrows, which is what
 * makes this recoverable without the caller re-implementing creation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const USER = "user-2928";
const ORG = "org-2928";
const RUN_ID = "run-2928-preview";

const { StubRunTransitionError } = vi.hoisted(() => ({
  StubRunTransitionError: class RunTransitionError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.name = "RunTransitionError";
      this.code = code;
    }
  },
}));

const readAgentRunById = vi.fn();
const transitionRunStatus = vi.fn();
const createAgentRunPendingInput = vi.fn();
const enqueueAgentRun = vi.fn();
const requireAuthSession = vi.fn();
const verifySessionAuthority = vi.fn();
const recordRunLifecycleMoment = vi.fn();

vi.mock("../store", () => ({
  RunTransitionError: StubRunTransitionError,
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentTemplateBySlug: vi.fn(async () => ({
    id: "tmpl-2928",
    name: "Preview Agent",
    packageName: "@cinatra/preview-agent",
    lifecycleConfig: null,
  })),
  readAgentTemplateById: vi.fn(async () => null),
  transitionRunStatus: (...a: unknown[]) => transitionRunStatus(...a),
  clearAgentRunFailureMetadata: vi.fn(async () => undefined),
  createAgentRunPendingInput: (...a: unknown[]) => createAgentRunPendingInput(...a),
  createAgentRun: vi.fn(),
  recordRunLifecycleMoment: (...a: unknown[]) => recordRunLifecycleMoment(...a),
  slugifyAgentTemplateName: (n: string) => n,
  readAllHitlPromptsForRun: vi.fn(async () => []),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: (...a: unknown[]) => requireAuthSession(...a),
  getActorContext: vi.fn(async () => undefined),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: (...a: unknown[]) => verifySessionAuthority(...a),
}));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../auth-policy", () => ({ resolveTemplateVisibilityActor: vi.fn(async () => null) }));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
  readRecommendationParkForRun: vi.fn(async () => null),
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));
vi.mock("../trigger-store", () => ({
  readRunTriggerByRunId: vi.fn(async () => null),
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
vi.mock("../trigger-schedule", () => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: null })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
vi.mock("../trigger-gate", () => ({ markTriggerReleased: vi.fn(async () => undefined) }));
vi.mock("@/lib/pm-integration-providers", () => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-run-readiness", () => ({
  assertAgentRunReadyByPackage: vi.fn(async () => null),
}));
vi.mock("@/lib/org-archive/dispatch-precheck", () => ({
  readOrgArchivedAtForDispatch: vi.fn(async () => false),
}));
vi.mock("../agent-run-serde", () => ({
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
}));

// The publish decision record of one run, in memory, newest last, as the store answers it: the hold goes through the
// REAL publish-decision-actions, and every read answers the rows of the run's current reset generation only. The reset's
// compare-and-set is the stubbed transitionRunStatus below, which keeps the real one's contract (run-transition.ts;
// proved in transition-run-status.test.ts and on Postgres in publish-decision-store.integration.test.ts): it lands only
// while the run is failed at the generation the reset names, raises it by 1 and closes that generation's open decisions,
// all or nothing. `endFailedAttemptDecisions` and `closeParkedDecisionsOfFailedRun` are the store's former closes (a
// status check only), kept so this suite also runs over the code before the generation and fails there on assertions.
const record = vi.hoisted(() => ({
  runStatus: "failed",
  generation: 0,
  archived: false,
  rows: [] as Array<{ id: string; status: string; gen: number; superseded?: true }>,
  closedBy: [] as string[],
  closer: "",
}));
const current = () => record.rows.filter((r) => r.gen === record.generation && !r.superseded);
const parkedRows = () => current().filter((r) => r.status === "parked");
const asRow = (r: { id: string; status: string; gen: number; superseded?: true }) => ({
  id: r.id, status: r.status, runGeneration: r.gen, current: r.gen === record.generation && !r.superseded,
  supersededAt: r.superseded ? new Date("2026-11-01T00:00:00Z") : null,
});
const endFailedAttemptDecisions = vi.fn(async (_runId: string) => {
  if (record.runStatus !== "failed") return 0;
  const ended = current();
  for (const r of ended) {
    r.superseded = true;
    if (r.status === "parked") { r.status = "run_ended"; record.closedBy.push(`${record.closer}:${r.id}`); }
  }
  return ended.length;
});
const closeParkedDecisionsOfFailedRun = vi.fn(async (_runId: string) => {
  if (record.runStatus !== "failed") return 0;
  const open = parkedRows();
  for (const r of open) { r.status = "run_ended"; record.closedBy.push(`${record.closer}:${r.id}`); }
  return open.length;
});
vi.mock("../publish-decision-store", () => ({
  endFailedAttemptDecisions: (runId: string) => endFailedAttemptDecisions(runId),
  closeParkedDecisionsOfFailedRun: (runId: string) => closeParkedDecisionsOfFailedRun(runId),
  readOpenDecisionForRun: vi.fn(async () => {
    const open = parkedRows();
    return open.length ? asRow(open[open.length - 1]!) : null;
  }),
  readLatestDecisionForRun: vi.fn(async (_runId: string, opts?: { orEarlierAttempt?: boolean }) => {
    const pick = current().at(-1) ?? (opts?.orEarlierAttempt ? record.rows.at(-1) : undefined);
    return pick ? asRow(pick) : null;
  }),
  decide: vi.fn(async (id: string, change: { to: string }) => {
    const row = record.rows.find((r) => r.id === id);
    if (!row || row.status !== "parked") return { outcome: "lost", currentStatus: row?.status ?? null };
    row.status = change.to;
    record.closedBy.push(`${record.closer}:${id}`);
    return { outcome: "won", decision: { ...row } };
  }),
}));

import { resetAgentRun, startDevChildPreviewRun } from "../run-actions";
import { assertNoOpenPublishDecision } from "../publish-decision-actions";

const createdRun = {
  id: RUN_ID,
  templateId: "tmpl-2928",
  orgId: ORG,
  runBy: USER,
  status: "pending_input",
  inputParams: {},
  lifecycleMoment: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthSession.mockResolvedValue({
    user: { id: USER, role: "admin" },
    session: { activeOrganizationId: ORG },
  });
  verifySessionAuthority.mockResolvedValue({ kind: "session" });
  recordRunLifecycleMoment.mockResolvedValue(undefined);
  createAgentRunPendingInput.mockResolvedValue({ ...createdRun });
  readAgentRunById.mockResolvedValue({ ...createdRun });
  transitionRunStatus.mockResolvedValue(undefined);
  enqueueAgentRun.mockResolvedValue(undefined);
});

describe("startDevChildPreviewRun and a failed dispatch", () => {
  it("opens the panel ON THE RUN THAT EXISTS when the enqueue fails", async () => {
    enqueueAgentRun.mockRejectedValueOnce(new Error("redis unavailable"));

    const result = await startDevChildPreviewRun("@cinatra/preview-agent");

    // THE DOCUMENTED POSTURE. The panel opens, and it opens on the run this
    // call created — the person's only route back to it.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("the preview refused to open");
    expect(result.runId).toBe(RUN_ID);
    expect(result.templateId).toBe("tmpl-2928");
    expect(result.heldForRecommendation).toBe(false);
    // …and the run is decidable again, not stranded in `queued` with no job.
    expect(transitionRunStatus).toHaveBeenCalledWith(
      RUN_ID,
      "queued",
      "pending_input",
      undefined,
      expect.anything(),
    );
  });

  it("opens the panel even when the launch's own compensation lost its race", async () => {
    // The other rung: the dispatch failed AND the ladder could not put the run
    // back, because another writer had already moved it. The launch rethrows
    // from a different site — and the run it created still exists, so the panel
    // still has somewhere to open.
    enqueueAgentRun.mockRejectedValueOnce(new Error("redis unavailable"));
    transitionRunStatus.mockImplementation(
      async (_id: string, from: string) => {
        if (from === "queued") throw new StubRunTransitionError("stale_from_status");
        return undefined;
      },
    );

    const result = await startDevChildPreviewRun("@cinatra/preview-agent");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("the preview refused to open");
    expect(result.runId).toBe(RUN_ID);
  });

  it("still refuses when the failure landed BEFORE there was a run", async () => {
    // Nothing to open a panel on, so the caller gets the error — the same
    // answer every earlier failure in this function already gives.
    createAgentRunPendingInput.mockRejectedValueOnce(new Error("run.execute refused"));

    const result = await startDevChildPreviewRun("@cinatra/preview-agent");

    expect(result.ok).toBe(false);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("the ordinary preview is unchanged", async () => {
    const result = await startDevChildPreviewRun("@cinatra/preview-agent");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("the preview refused to open");
    expect(result.runId).toBe(RUN_ID);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
  });
});

// Review findings on cinatra#4150 (rounds 18 to 20): a retry's reset (failed -> pending_input) ends the failed attempt
// at the reset generation it read, in ONE guarded transaction: the compare-and-set lands only while the run is still
// failed at that generation and raises it, and the attempt's open decisions close run_ended with it. A reset that lost
// (a concurrent reset, or a newer failure with a newer generation) or that the org-write kernel refused writes nothing.
describe("resetAgentRun ends the failed attempt at the generation it read, and only that", () => {
  const failedRun = { ...createdRun, status: "failed" };
  beforeEach(() => {
    record.runStatus = "failed";
    record.generation = 0;
    record.archived = false;
    record.rows = [];
    record.closedBy = [];
    record.closer = "";
    readAgentRunById.mockImplementation(async () => ({ ...failedRun, status: record.runStatus, resetGeneration: record.generation }));
    transitionRunStatus.mockImplementation(async (_id: string, from: string, to: string, meta?: { resetGeneration?: number }) => {
      // The org-write kernel refuses an archived org before the transaction writes anything.
      if (record.archived) throw Object.assign(new Error("org archived"), { name: "OrgWriteRefusedError" });
      // A reset that names no generation is the road before it (a status compare only, nothing else written), so this
      // suite also runs over that code and fails there on its assertions; the real move refuses it
      // (transition-run-status.test.ts).
      const reset = from === "failed" && to === "pending_input" && meta?.resetGeneration !== undefined;
      if (record.runStatus !== from || (reset && meta?.resetGeneration !== record.generation)) {
        throw new StubRunTransitionError("stale_from_status");
      }
      if (reset) {
        for (const r of record.rows) {
          if (r.status === "parked" && r.gen <= record.generation) { r.status = "run_ended"; record.closedBy.push(`${record.closer}:${r.id}`); }
        }
        record.generation += 1;
      }
      record.runStatus = to;
    });
  });

  it("a single reset of a failed run closes its stale parked decision and moves the run to pending_input", async () => {
    record.rows = [{ id: "d-failed", status: "parked", gen: 0 }];
    await expect(resetAgentRun({ runId: RUN_ID })).resolves.toEqual({ ok: true });
    expect(transitionRunStatus).toHaveBeenCalledWith(RUN_ID, "failed", "pending_input", { resetGeneration: 0 }, expect.anything());
    expect(record.rows.map(({ id, status }) => ({ id, status }))).toEqual([{ id: "d-failed", status: "run_ended" }]);
    expect(record.runStatus).toBe("pending_input");
    expect(record.generation).toBe(1);
  });

  // Round 19, finding 1: the retry reached an ordinary HITL gate before any publish gate, and its approval ran the hold
  // check, which refused every status but released: the retry was wedged.
  it.each(["parked", "run_ended", "declined", "expired"])(
    "after the reset, the failed attempt's %s decision never holds the retry's ordinary gate; the retry's own closed decision does",
    async (status) => {
      record.rows = [{ id: "d-failed", status, gen: 0 }];
      await expect(resetAgentRun({ runId: RUN_ID })).resolves.toEqual({ ok: true });
      // The retry runs and waits at an ordinary gate: its approval's hold check lets it go on.
      record.runStatus = "pending_approval";
      await expect(assertNoOpenPublishDecision(RUN_ID)).resolves.toBe(true);
      // The retry then meets a publish gate and that stop ends (run_ended by a lost move): it holds, as before.
      record.rows.push({ id: "d-next", status: "run_ended", gen: record.generation });
      await expect(assertNoOpenPublishDecision(RUN_ID)).rejects.toMatchObject({ code: "publish_decision_required" });
    },
  );

  /** Holds reset B after it read the run (and its generation), until the test lets it go on. */
  function holdSecondReset() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    verifySessionAuthority
      .mockImplementationOnce(async () => ({ kind: "session" }))
      .mockImplementationOnce(async () => { await gate; record.closer = "B"; return { kind: "session" }; });
    return release;
  }

  it("of two concurrent resets, the one that loses the claim closes nothing", async () => {
    record.rows = [{ id: "d-failed", status: "parked", gen: 0 }];
    const release = holdSecondReset();
    record.closer = "A";
    const a = resetAgentRun({ runId: RUN_ID });
    const b = resetAgentRun({ runId: RUN_ID });
    await expect(a).resolves.toEqual({ ok: true });
    release();
    await expect(b).resolves.toEqual({ ok: false, error: "run is not in failed state" });
    expect(record.closedBy).toEqual(["A:d-failed"]);
    expect(record.runStatus).toBe("pending_input");
    expect(record.generation).toBe(1);
  });

  // Round 20, finding 2: the ABA. Reset A wins; the retry parks at a publish gate and then FAILS again, so the run is
  // failed once more when the delayed reset B goes on. B read the run before A's commit: its generation is gone.
  it.each(["pending_approval", "failed"])(
    "a delayed losing reset never touches the next attempt's decision, also when that attempt is %s",
    async (nextStatus) => {
      record.rows = [{ id: "d-failed", status: "parked", gen: 0 }];
      const release = holdSecondReset();
      record.closer = "A";
      const a = resetAgentRun({ runId: RUN_ID });
      const b = resetAgentRun({ runId: RUN_ID });
      await expect(a).resolves.toEqual({ ok: true });
      // The run is retriggered; its next attempt parks at its publish gate, and then reaches nextStatus.
      record.rows.push({ id: "d-next", status: "parked", gen: record.generation });
      record.runStatus = nextStatus;
      release();
      await expect(b).resolves.toEqual({ ok: false, error: "run is not in failed state" });
      expect(record.rows.map(({ id, status, gen }) => ({ id, status, gen }))).toEqual([
        { id: "d-failed", status: "run_ended", gen: 0 },
        { id: "d-next", status: "parked", gen: 1 },
      ]);
      expect(record.closedBy).toEqual(["A:d-failed"]);
      expect(record.runStatus).toBe(nextStatus);
      expect(record.generation).toBe(1);
      // The next attempt's open decision still holds its resume.
      await expect(assertNoOpenPublishDecision(RUN_ID)).rejects.toMatchObject({ code: "publish_decision_required" });
    },
  );

  // Round 20, finding 1: a reset the org-write kernel refuses (an archived org) writes nothing, decisions included.
  it("a reset refused by the org-write kernel fails, and no decision and no run state changes", async () => {
    record.archived = true;
    record.rows = [{ id: "d-failed", status: "parked", gen: 0 }, { id: "d-old", status: "declined", gen: 0 }];
    await expect(resetAgentRun({ runId: RUN_ID })).rejects.toThrow("org archived");
    expect(record.rows).toEqual([{ id: "d-failed", status: "parked", gen: 0 }, { id: "d-old", status: "declined", gen: 0 }]);
    expect(record.closedBy).toEqual([]);
    expect(record.runStatus).toBe("failed");
    expect(record.generation).toBe(0);
  });

  it("a run that is not failed is refused, and nothing is closed", async () => {
    record.runStatus = "running";
    record.rows = [{ id: "d-live", status: "parked", gen: 0 }];
    await expect(resetAgentRun({ runId: RUN_ID })).resolves.toEqual({ ok: false, error: "run is not in failed state" });
    expect(record.rows).toEqual([{ id: "d-live", status: "parked", gen: 0 }]);
    expect(transitionRunStatus).not.toHaveBeenCalled();
  });
});
