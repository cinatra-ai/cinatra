/**
 * THE MOMENT WRITES DO NOT LAND ON A RUN THEY DO NOT OWN
 * (cinatra#2928 review, findings 3, 4 and 5).
 *
 * The triple is ONE SLOT: a run states one moment, and the card reference beside
 * it is the only server-checked route back to the screen that moment mounts. So
 * a write that lands on a run somebody else has moved does not merely add a
 * wrong record — it takes a live card off a person who is waiting to answer it,
 * and nothing puts it back.
 *
 * Three guards, measured on a simulated row so each test states an outcome about
 * the RUN rather than about a mock call:
 *
 *   3. THE SCHEDULE MOMENT is pinned to the park it describes, exactly as the
 *      HITL moment is. Unpinned, a stop that won the CAS in the window left a
 *      STOPPED run saying it was waiting at a live schedule card, and no release
 *      path ever touches a stopped run to clear it.
 *   4. A HEADLESS PRE-DISPATCH LAUNCH THAT DISPATCHES NOW IS REFUSED, before
 *      anything is created. The pre-dispatch creator makes a `pending_input`
 *      row and the only transition off it is in the human-present branch, so
 *      that combination would report — and enqueue — a `queued` run whose row
 *      said otherwise.
 *   5. THE TWO W2b SEAM ENTRIES DO NOT OVERWRITE A LIVE PARK. Both report a
 *      READING about work; neither is evidence that a park somebody has to
 *      answer is over.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-2928-guards";
const ORG_ID = "org-2928";

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

type Row = {
  id: string;
  orgId: string;
  status: string;
  lifecycleMoment: string | null;
  lifecycleCardKind: string | null;
  lifecycleCardRef: string | null;
};

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

const enqueue = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(async () => undefined),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));

vi.mock("../store", () => store);
vi.mock("@/lib/agent-run-enqueue", () => enqueue);
vi.mock("@/lib/org-write/run-creation-authority", () => ({
  resolveRunCreationAuthority: vi.fn(async () => ({ kind: "system" })),
}));
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
  readRecommendationParkForRun: vi.fn(async () => null),
}));

import {
  launchAgentRun,
  onArtifactProduced,
  onReviewedWorkChanged,
  stateRunScheduleMoment,
} from "../lifecycle-coordinator";

const AUTHORITY = { kind: "system" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  row = {
    id: RUN_ID,
    orgId: ORG_ID,
    status: "pending_trigger",
    lifecycleMoment: null,
    lifecycleCardKind: null,
    lifecycleCardRef: null,
  };
  store.readAgentRunById.mockImplementation(async (id: string) =>
    id === row.id ? { ...row } : null,
  );
  store.transitionRunStatus.mockImplementation(
    async (id: string, from: string, to: string) => {
      if (id !== row.id || row.status !== from) {
        throw new StubRunTransitionError("stale_from_status");
      }
      row.status = to;
    },
  );
  store.recordRunLifecycleMoment.mockImplementation(
    async (input: {
      runId: string;
      moment: string | null;
      cardKind?: string | null;
      cardRef?: string | null;
      onlyWhileStatus?: string;
      onlyWhileMoment?: string | null;
    }) => {
      if (input.runId !== row.id) return;
      if (input.onlyWhileStatus !== undefined && row.status !== input.onlyWhileStatus) return;
      if (input.onlyWhileMoment !== undefined && row.lifecycleMoment !== input.onlyWhileMoment) {
        return;
      }
      row.lifecycleMoment = input.moment;
      row.lifecycleCardKind = input.cardKind ?? null;
      row.lifecycleCardRef = input.cardRef ?? null;
    },
  );
});

describe("the schedule moment is pinned to the park it describes", () => {
  it("lands on a run still waiting at the trigger choice", async () => {
    await stateRunScheduleMoment({
      run: { id: RUN_ID, orgId: ORG_ID },
      cardRef: "trigger-2928",
      authority: AUTHORITY,
    });
    expect(row.lifecycleMoment).toBe("schedule");
    expect(row.lifecycleCardRef).toBe("trigger-2928");
  });

  it("lands on an ARMED run — the choice is made, the instant is still ahead", async () => {
    // The schedule park is two statuses. A schedule submitted in the window
    // between the trigger re-read and this record moves the run to `armed`, and
    // it goes on waiting at its schedule there; the release job is what ends it.
    // A pin to `pending_trigger` alone would drop the write and leave an armed
    // run with no card.
    row.status = "armed";

    await stateRunScheduleMoment({
      run: { id: RUN_ID, orgId: ORG_ID },
      cardRef: "trigger-2928",
      authority: AUTHORITY,
    });

    expect(row.lifecycleMoment).toBe("schedule");
    expect(row.lifecycleCardRef).toBe("trigger-2928");
  });

  it("states nothing on a run that has reached a terminal state", async () => {
    row.status = "completed";
    await stateRunScheduleMoment({
      run: { id: RUN_ID, orgId: ORG_ID },
      cardRef: "trigger-2928",
      authority: AUTHORITY,
    });
    expect(row.lifecycleMoment).toBeNull();
  });

  it("does NOT leave a stopped run saying it waits at a live schedule card", async () => {
    // The stop won the CAS in the window between the park and this record.
    // Nothing clears a stopped run afterwards, so the guard has to be here.
    row.status = "stopped";

    await stateRunScheduleMoment({
      run: { id: RUN_ID, orgId: ORG_ID },
      cardRef: "trigger-2928",
      authority: AUTHORITY,
    });

    expect(row.lifecycleMoment).toBeNull();
    expect(row.lifecycleCardRef).toBeNull();
  });
});

describe("a headless launch cannot create pre-dispatch and dispatch at once", () => {
  it("refuses, and creates nothing", async () => {
    // The creator ANSWERS here, so a tree that does not refuse gets all the way
    // through to a `pending_input` row it then reports as `queued` — the failure
    // this refusal exists to make unreachable.
    store.createAgentRunPendingInput.mockResolvedValue({
      id: RUN_ID,
      orgId: ORG_ID,
      status: "pending_input",
    });

    await expect(
      launchAgentRun({
        producer: "test_headless_pre_dispatch",
        frame: null,
        create: {
          kind: "pre_dispatch",
          input: { templateId: "tmpl-2928", runBy: "user-2928", inputParams: {}, orgId: ORG_ID },
        },
        dispatch: { kind: "enqueue", options: { jobId: RUN_ID } },
        authority: AUTHORITY,
      } as never),
    ).rejects.toThrow(/pre-dispatch/i);

    // NOTHING WAS CREATED, so there is no row left claiming a status no writer
    // ever gave it.
    expect(store.createAgentRunPendingInput).not.toHaveBeenCalled();
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("the same combination is fine when a person is present", async () => {
    store.createAgentRunPendingInput.mockResolvedValueOnce({
      id: RUN_ID,
      orgId: ORG_ID,
      status: "pending_input",
    });
    row.status = "pending_input";

    const answer = await launchAgentRun({
      producer: "test_interactive_pre_dispatch",
      frame: { userId: "user-2928" },
      interactive: true,
      create: {
        kind: "pre_dispatch",
        input: { templateId: "tmpl-2928", runBy: "user-2928", inputParams: {}, orgId: ORG_ID },
      },
      dispatch: { kind: "enqueue", options: { jobId: RUN_ID } },
      authority: AUTHORITY,
    } as never);

    expect(answer.status).toBe("queued");
    expect(row.status).toBe("queued");
    expect(enqueue.enqueueAgentRun).toHaveBeenCalledTimes(1);
  });
});

describe("the W2b seam entries never overwrite a live park", () => {
  it("an audit landing on a run parked at its HITL gate keeps that gate's card", async () => {
    row.status = "pending_approval";
    row.lifecycleMoment = "hitl";
    row.lifecycleCardKind = "agent_hitl_screen";
    row.lifecycleCardRef = "gate-7";

    const answer = await onReviewedWorkChanged({
      run: { id: RUN_ID, orgId: ORG_ID, status: "pending_approval" },
      auditRef: "verification-3",
      authority: AUTHORITY,
    });

    expect(row.lifecycleMoment).toBe("hitl");
    expect(row.lifecycleCardRef).toBe("gate-7");
    // …and the entry answers with what the run REALLY states, not with what it
    // wanted to write.
    expect(answer.moment).toBe("hitl");
    // The audit does not park, so the status is untouched either way.
    expect(answer.status).toBe("pending_approval");
    expect(row.status).toBe("pending_approval");
  });

  it("an artifact review opening does not displace a live HITL park", async () => {
    row.status = "pending_approval";
    row.lifecycleMoment = "hitl";
    row.lifecycleCardKind = "agent_hitl_screen";
    row.lifecycleCardRef = "gate-7";

    const answer = await onArtifactProduced({
      run: { id: RUN_ID, orgId: ORG_ID, status: "pending_approval" },
      reviewOpened: true,
      reviewRef: "review-9",
      authority: AUTHORITY,
    });

    expect(row.lifecycleMoment).toBe("hitl");
    expect(row.lifecycleCardRef).toBe("gate-7");
    expect(answer.moment).toBe("hitl");
  });

  it("both still record on a run that is waiting at nothing", async () => {
    row.status = "running";

    const audited = await onReviewedWorkChanged({
      run: { id: RUN_ID, orgId: ORG_ID, status: "running" },
      auditRef: "verification-3",
      authority: AUTHORITY,
    });
    expect(row.lifecycleMoment).toBe("audit");
    expect(row.lifecycleCardRef).toBe("verification-3");
    expect(audited.moment).toBe("audit");
    // The audit is a reading: it records and the run goes on.
    expect(row.status).toBe("running");

    // An audit REPLACES an older audit — the guard is about parks, not about
    // refusing every second reading.
    await onReviewedWorkChanged({
      run: { id: RUN_ID, orgId: ORG_ID, status: "running" },
      auditRef: "verification-4",
      authority: AUTHORITY,
    });
    expect(row.lifecycleCardRef).toBe("verification-4");

    row.lifecycleMoment = null;
    row.lifecycleCardKind = null;
    row.lifecycleCardRef = null;
    const produced = await onArtifactProduced({
      run: { id: RUN_ID, orgId: ORG_ID, status: "running" },
      reviewOpened: true,
      reviewRef: "review-9",
      authority: AUTHORITY,
    });
    expect(row.lifecycleMoment).toBe("review");
    expect(row.lifecycleCardRef).toBe("review-9");
    expect(produced.moment).toBe("review");
  });

  it("answers with what the ROW states when a park lands inside the write window", async () => {
    // The write is guarded, best-effort and reports no affected-row count, so
    // "did it land" cannot be known from the entry. A park arriving between the
    // guard read and the write refuses it silently — and the entry must not then
    // report the moment it hoped to write.
    row.status = "running";
    let firstRead = true;
    const passThrough = store.readAgentRunById.getMockImplementation()!;
    store.readAgentRunById.mockImplementation(async (id: string) => {
      const snapshot = await passThrough(id);
      if (firstRead) {
        firstRead = false;
        // …and the park lands the instant after this call read the row.
        row.status = "pending_approval";
        row.lifecycleMoment = "hitl";
        row.lifecycleCardKind = "agent_hitl_screen";
        row.lifecycleCardRef = "gate-late";
      }
      return snapshot;
    });

    const answer = await onReviewedWorkChanged({
      run: { id: RUN_ID, orgId: ORG_ID, status: "running" },
      auditRef: "verification-late",
      authority: AUTHORITY,
    });

    // The compare-and-set refused, the park kept its card…
    expect(row.lifecycleMoment).toBe("hitl");
    expect(row.lifecycleCardRef).toBe("gate-late");
    // …and the answer says so rather than claiming the audit.
    expect(answer.moment).toBe("hitl");
  });

  it("an artifact write that opened no review still records nothing", async () => {
    row.status = "running";
    const answer = await onArtifactProduced({
      run: { id: RUN_ID, orgId: ORG_ID, status: "running" },
      reviewOpened: false,
      authority: AUTHORITY,
    });
    expect(row.lifecycleMoment).toBeNull();
    expect(answer.moment).toBeNull();
    expect(store.recordRunLifecycleMoment).not.toHaveBeenCalled();
  });
});
