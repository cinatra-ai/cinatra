/**
 * ONCE IT HAS FIRED, THE CARD IS A READING (cinatra#3044, the eighth set's
 * first defect).
 *
 * The ratified drawing fixes five readings of the ONE schedule card, and the
 * fifth is the one this file is the executable reading of. §VI's table, in the
 * drawing's own words:
 *
 *   "One card, five readings, and never a second card. The card is drawn once
 *    and stays where it is; what changes across its life is the floor beneath
 *    the rows and whether the rows still take a change."
 *
 *   "Fired, one-off — the schedule was spent | read-only | none at all"
 *
 * and, on the fired one-off's own example, "A one-time schedule is spent once it
 * fires, so the rows below are the record of it and cannot be changed."
 *
 * WHAT WAS MEASURED INSTEAD. A run started from a conversation reaches its
 * schedule moment, the reader confirms the card's own DEFAULT row — **Run right
 * after setup** — and the run fires. From that instant the card was WITHDRAWN
 * from the conversation: `resolveProposalForRun` answered `absent` for an
 * `immediate` row on a run no proposal token created, so the slot fell back to
 * the bare working placeholder and the reading the drawing requires was gone.
 *
 * WHY THE REFUSAL WAS RIGHT WHEN IT WAS WRITTEN, AND IS NOT NOW. It reads
 * "**Run right after setup** names no moment to open a schedule step onto" —
 * true while the only road to an `immediate` row was a dispatch that never
 * parked at a schedule step. cinatra#3044 opened the second road: the run parks
 * at its schedule moment and the card IS where that row is chosen. So the
 * refusal keeps its whole force for the run that never had a schedule step, and
 * loses it for the run whose step the reader answered.
 *
 * WHAT TELLS THE TWO APART, and it is not a guess: the run-scoped schedule
 * reference the moment was opened with. It is minted by the server, sealed
 * (AES-256-GCM under a key label of its own) and carried in the turn's durable
 * content, and the executor stamps it where — and only where — the run's own
 * schedule step opened in a conversation. A reference minted anywhere else
 * carries no stamp and the refusal stands untouched.
 *
 * Harness mirrors `schedule-over-3004.test.ts`: the service runs for real and
 * only its collaborators are stubbed, so no database is needed.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/schedule-fired-one-off-stays-a-reading-3053.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-3053-fired";
const OWNER_ID = "user-3053-owner";
const ORG_ID = "org-3053";
const TEMPLATE_ID = "tmpl-3053";

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null as unknown),
  createAgentRunPendingInput: vi.fn(),
  transitionRunStatus: vi.fn(async (): Promise<void> => {}),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
const triggerStore = vi.hoisted(() => ({
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  readRunTriggerByRunId: vi.fn<
    (runId?: string) => Promise<Record<string, unknown> | null>
  >(async () => null),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
  stopRunTriggerInDb: vi.fn(async () => undefined),
}));
const proposalStore = vi.hoisted(() => ({
  ProposalAlreadyConsumedError: class extends Error {},
  claimPendingInstallIntents: vi.fn(async () => []),
  markInstallIntentArmed: vi.fn(),
  markInstallIntentDone: vi.fn(),
  parkInstallIntent: vi.fn(),
  readInstallIntent: vi.fn(async () => null as unknown),
  readProposalConsume: vi.fn(async () => null as unknown),
  readProposalConsumeByRunId: vi.fn(async () => null as unknown),
  releaseInstallIntent: vi.fn(),
  spendProposalWithinTx: vi.fn(),
}));

vi.mock("../store", () => store);
vi.mock("../trigger-store", () => triggerStore);
vi.mock("../trigger-schedule-proposal-store", () => proposalStore);
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../runtime-install-gate", () => ({
  assertAgentPackageRunnable: vi.fn(async () => null),
}));

import { resolveProposalForRun } from "../trigger-schedule-proposal-service";

const READER = { userId: OWNER_ID, orgId: ORG_ID };

/** The run as it stands once its own schedule step let it go. */
const RUN = {
  id: RUN_ID,
  runBy: OWNER_ID,
  templateId: TEMPLATE_ID,
  orgId: ORG_ID,
  status: "completed",
  lifecycleMoment: null,
};

/**
 * **Run right after setup**, answered on the card and spent. `releasedAt` is the
 * fire: the release job stamps it, and the resolver reads `firedOnce` straight
 * off that stamp for every non-recurring kind.
 */
const FIRED_RIGHT_AFTER_SETUP = {
  runId: RUN_ID,
  triggerType: "immediate",
  scheduledAt: null,
  cronExpression: null,
  timezone: "UTC",
  enabled: true,
  releasedAt: new Date("2026-08-31T14:15:38.799Z"),
  lastFiredAt: null,
  stoppedAt: null,
  jobSchedulerId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  store.readAgentRunById.mockResolvedValue(RUN);
  store.readAgentTemplateById.mockResolvedValue({
    id: TEMPLATE_ID,
    name: "Q3 cohort sweep",
    packageName: "q3-cohort-sweep",
    orgId: ORG_ID,
  });
  triggerStore.readRunTriggerByRunId.mockResolvedValue(FIRED_RIGHT_AFTER_SETUP);
});

describe("a one-off answered on the run's own schedule step, once it has fired", () => {
  it("the card is a reading — the rows go read-only and the card carries no floor at all", async () => {
    const resolution = await resolveProposalForRun(RUN_ID, READER, undefined, {
      fromScheduleStep: true,
    });

    expect(resolution.phase).toBe("settled");
    if (resolution.phase !== "settled") return;
    expect(resolution.triggerType).toBe("immediate");
    // THE SCHEDULE WAS SPENT — the drawing's fifth reading, read off the fire
    // stamp rather than off a clock.
    expect(resolution.released).toBe(true);
    expect(resolution.firedOnce).toBe(true);
    // NONE AT ALL: the two readings the card's `frozen` is built from. No save,
    // and no Cancel schedule — that control is the recurring schedule's alone.
    expect(resolution.canSave).toBe(false);
    expect(resolution.stopped).toBe(false);
  });

  it("draws the same reading before the fire, with the rows still taking a change", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...FIRED_RIGHT_AFTER_SETUP,
      releasedAt: null,
    });

    const resolution = await resolveProposalForRun(RUN_ID, READER, undefined, {
      fromScheduleStep: true,
    });

    expect(resolution.phase).toBe("settled");
    if (resolution.phase !== "settled") return;
    expect(resolution.firedOnce).toBe(false);
    expect(resolution.canSave).toBe(true);
  });

  it("still refuses every reader the run's own access control refuses", async () => {
    await expect(
      resolveProposalForRun(RUN_ID, { userId: "somebody-else", orgId: ORG_ID }, undefined, {
        fromScheduleStep: true,
      }),
    ).resolves.toEqual({ phase: "absent" });
    await expect(
      resolveProposalForRun(RUN_ID, { userId: OWNER_ID, orgId: "org-other" }, undefined, {
        fromScheduleStep: true,
      }),
    ).resolves.toEqual({ phase: "absent" });
  });
});

describe("the refusal the schedule step does NOT widen", () => {
  it("stays absent for an immediate row on a run that never had a schedule step", async () => {
    await expect(resolveProposalForRun(RUN_ID, READER)).resolves.toEqual({
      phase: "absent",
    });
  });

  it("stays absent for a run with no trigger row and no schedule moment to wait at", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(null);

    await expect(
      resolveProposalForRun(RUN_ID, READER, undefined, { fromScheduleStep: true }),
    ).resolves.toEqual({ phase: "absent" });
  });
});
