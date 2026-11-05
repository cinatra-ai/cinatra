/**
 * cinatra#4245 (D1), unit tier: the coordinator's two pieces of the drain stop.
 *
 *   U1 advanceAgentRun hands the release's `pauseEndMark` to the status seam
 *      (rule 5), so the drain's stop is conditioned on the ended pause.
 *   U2 a release without one hands no meta, as before (guard, green at base).
 *   U3 the STRICT clear (spec-rev1 MF6) throws when its write fails, while the
 *      best-effort clear still swallows the same failure (its callers keep their
 *      contract).
 *   U4 the strict clear throws when its read fails.
 *   U5 the strict clear removes only the moment it read, the compare and clear
 *      it shares with the best-effort clear.
 *
 * Red at df923329 (the base, change B's head): the release drops `pauseEndMark`
 * and `clearRunLifecycleMomentOrThrow` does not exist.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-4245-d1-coordinator";
const ORG_ID = "org-4245-d1";

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

type Row = { id: string; orgId: string; status: string; lifecycleMoment: string | null };
let row: Row;

const store = vi.hoisted(() => ({
  RunTransitionError: null as unknown,
  readAgentRunById: vi.fn(),
  transitionRunStatus: vi.fn(),
  recordRunLifecycleMoment: vi.fn(),
  createAgentRunPendingInput: vi.fn(),
  createAgentRun: vi.fn(),
}));
store.RunTransitionError = StubRunTransitionError;

vi.mock("../store", () => store);
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: vi.fn(async () => undefined),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
  readRecommendationParkForRun: vi.fn(async () => null),
}));

import * as coordinator from "../lifecycle-coordinator";

const AUTHORITY = { kind: "system" } as never;
const DISPATCH = { kind: "caller_dispatches", why: "test" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  row = { id: RUN_ID, orgId: ORG_ID, status: "pending_approval", lifecycleMoment: "review" };
  store.readAgentRunById.mockImplementation(async (id: string) => (id === row.id ? { ...row } : null));
  store.transitionRunStatus.mockImplementation(async (id: string, from: string, to: string) => {
    if (id !== row.id || row.status !== from) throw new StubRunTransitionError("stale_from_status");
    row.status = to;
  });
  store.recordRunLifecycleMoment.mockImplementation(
    async (input: { runId: string; moment: string | null; onlyWhileMoment?: string | null }) => {
      if (input.runId !== row.id) return;
      if (input.onlyWhileMoment !== undefined && row.lifecycleMoment !== input.onlyWhileMoment) return;
      row.lifecycleMoment = input.moment;
    },
  );
});

describe("the drain's stop carries the ended pause to the status seam", () => {
  it("U1: a release with pauseEndMark hands it to transitionRunStatus", async () => {
    await coordinator.advanceAgentRun({
      run: { id: RUN_ID, orgId: ORG_ID, status: "pending_approval" },
      release: {
        reason: "changes_requested",
        from: "pending_approval",
        to: "stopped",
        pauseEndMark: { generation: 7 },
        dispatch: DISPATCH,
        onLostRace: "throw",
      } as never,
      authority: AUTHORITY,
    });
    expect(store.transitionRunStatus).toHaveBeenCalledTimes(1);
    expect(store.transitionRunStatus).toHaveBeenCalledWith(
      RUN_ID,
      "pending_approval",
      "stopped",
      { pauseEndMark: { generation: 7 } },
      AUTHORITY,
    );
    expect(row.status).toBe("stopped");
  });

  it("U2: a release without one hands no meta (guard, green at base)", async () => {
    await coordinator.advanceAgentRun({
      run: { id: RUN_ID, orgId: ORG_ID, status: "pending_approval" },
      release: { reason: "approval_resumed", from: "pending_approval", to: "stopped", dispatch: DISPATCH, onLostRace: "throw" },
      authority: AUTHORITY,
    });
    expect(store.transitionRunStatus).toHaveBeenCalledWith(RUN_ID, "pending_approval", "stopped", undefined, AUTHORITY);
  });
});

describe("the strict clear of the moment (spec-rev1 MF6)", () => {
  const strict = () =>
    (coordinator as unknown as { clearRunLifecycleMomentOrThrow: (id: string, a: unknown) => Promise<void> })
      .clearRunLifecycleMomentOrThrow(RUN_ID, AUTHORITY);

  it("U3: a failed write throws; the best-effort clear still swallows it", async () => {
    store.recordRunLifecycleMoment.mockRejectedValueOnce(new Error("db blip on the clear"));
    await expect(strict()).rejects.toThrow("db blip on the clear");
    expect(row.lifecycleMoment).toBe("review");
    store.recordRunLifecycleMoment.mockRejectedValueOnce(new Error("db blip on the clear"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(coordinator.clearRunLifecycleMoment(RUN_ID, AUTHORITY)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(row.lifecycleMoment).toBe("review");
  });

  it("U4: a failed read throws", async () => {
    store.readAgentRunById.mockRejectedValueOnce(new Error("db blip on the read"));
    await expect(strict()).rejects.toThrow("db blip on the read");
    expect(store.recordRunLifecycleMoment).not.toHaveBeenCalled();
  });

  it("U5: it clears the moment it read, and nothing when there is none", async () => {
    await strict();
    expect(row.lifecycleMoment).toBeNull();
    expect(store.recordRunLifecycleMoment).toHaveBeenCalledWith(
      { runId: RUN_ID, orgId: ORG_ID, moment: null, onlyWhileMoment: "review" },
      AUTHORITY,
    );
    store.recordRunLifecycleMoment.mockClear();
    await strict();
    expect(store.recordRunLifecycleMoment).not.toHaveBeenCalled();
  });
});
