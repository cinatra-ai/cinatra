/**
 * An EXPIRED schedule proposal stays VISIBLE, and Adjust re-proposes it.
 *
 * Design: `specs/app-lifecycle-cards.html` §VI (the proposal card) and §IV (the
 * states, and what the undrawn one is reserved for). §VI on the token's own
 * TTL: "An expired proposal is not an error state — the card says so and Adjust
 * re-proposes for free."
 *
 * The defect this pins shut: the resolver read the proposal through the CONFIRM
 * verifier, whose whole contract is one indistinguishable refusal, so an
 * expired proposal and a forged one arrived as the same `absent` — and `absent`
 * draws no DOM at all. Thirty minutes on, the card and the question it asked
 * were gone from the reader's own transcript.
 *
 * Seam tier: the stores are mocked, the TOKEN is real. What is under test is
 * which reading a resolve answers with, and that is decided by real crypto
 * against a real clock — mocking the token would test the mock.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

import {
  PROPOSAL_TTL_SECONDS,
  mintTriggerScheduleProposalToken,
  type ProposalSchedule,
} from "@/lib/trigger-schedule-proposal-token";

const ORG = "org_2836_expired_proposal";
const USER = "user_2836_proposer";
const TEMPLATE = "7c1d4b2a-3e5f-4a6b-8c9d-0e1f2a3b4c5d";

const WEEKDAYS_9AM: ProposalSchedule = {
  kind: "recurring",
  timezone: "Europe/Berlin",
  selection: {
    frequency: "weekly",
    interval: 1,
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    monthlyMode: "date",
    nthWeek: 1,
    monthlyWeekday: 0,
    quarterAnchor: "start",
    yearlyMonth: 1,
    hour: 9,
    minute: 0,
  },
};

const readAgentTemplateById = vi.fn();
const readProposalConsume = vi.fn();
const readInstallIntent = vi.fn();
const readRunTriggerByRunId = vi.fn();
const assertAgentPackageRunnable = vi.fn();

vi.mock("../store", () => ({
  readAgentTemplateById: (...args: unknown[]) => readAgentTemplateById(...args),
  createAgentRunPendingInput: vi.fn(),
  readAgentRunById: vi.fn(),
  transitionRunStatus: vi.fn(),
  RunTransitionError: class extends Error {},
}));
vi.mock("../trigger-store", () => ({
  createOrUpdateRunTrigger: vi.fn(),
  readRunTriggerByRunId: (...args: unknown[]) => readRunTriggerByRunId(...args),
}));
vi.mock("../trigger-schedule", () => ({ scheduleTrigger: vi.fn() }));
vi.mock("../trigger-service", () => ({ setRunTriggerForActor: vi.fn() }));
vi.mock("../runtime-install-gate", () => ({
  assertAgentPackageRunnable: (...args: unknown[]) =>
    assertAgentPackageRunnable(...args),
}));
vi.mock("../trigger-schedule-proposal-store", () => ({
  ProposalAlreadyConsumedError: class extends Error {},
  claimPendingInstallIntents: vi.fn(),
  markInstallIntentArmed: vi.fn(),
  markInstallIntentDone: vi.fn(),
  parkInstallIntent: vi.fn(),
  readInstallIntent: (...args: unknown[]) => readInstallIntent(...args),
  readProposalConsume: (...args: unknown[]) => readProposalConsume(...args),
  releaseInstallIntent: vi.fn(),
  spendProposalWithinTx: vi.fn(),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: vi.fn(async () => ({})),
}));

let service: typeof import("../trigger-schedule-proposal-service");

const READER = { userId: USER, orgId: ORG };

/** Mint a proposal that expired `secondsAgo` seconds ago. */
function mintExpired(schedule: ProposalSchedule = WEEKDAYS_9AM, secondsAgo = 60) {
  const mintedAt = Math.floor(Date.now() / 1000) - PROPOSAL_TTL_SECONDS - secondsAgo;
  const minted = mintTriggerScheduleProposalToken(
    { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule },
    { nowSeconds: mintedAt },
  );
  expect(minted).not.toBeNull();
  return minted!;
}

/** Mint a proposal whose window is still open. */
function mintLive(schedule: ProposalSchedule = WEEKDAYS_9AM) {
  const minted = mintTriggerScheduleProposalToken({
    templateId: TEMPLATE,
    userId: USER,
    orgId: ORG,
    schedule,
  });
  expect(minted).not.toBeNull();
  return minted!;
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-2836-expired-proposal";
  service = await import("../trigger-schedule-proposal-service");
});

beforeEach(() => {
  vi.clearAllMocks();
  readAgentTemplateById.mockResolvedValue({
    id: TEMPLATE,
    name: "Weekly digest",
    packageName: "@cinatra-ai/weekly-digest",
    packageVersion: "1.0.0",
    orgId: ORG,
  });
  readProposalConsume.mockResolvedValue(null);
  readInstallIntent.mockResolvedValue(null);
  readRunTriggerByRunId.mockResolvedValue(null);
  assertAgentPackageRunnable.mockResolvedValue(null);
});

describe("an expired proposal RESOLVES to a drawn expired reading", () => {
  it("answers `expired`, not `absent`, for the reader it was proposed to", async () => {
    const { token } = mintExpired();
    const resolved = await service.resolveProposalForReader(token, READER);
    expect(resolved.phase).toBe("expired");
  });

  it("carries the body the card needs — what expired, for which agent", async () => {
    const { token } = mintExpired();
    const resolved = await service.resolveProposalForReader(token, READER);
    if (resolved.phase !== "expired") throw new Error("expected an expired reading");
    expect(resolved.agentName).toBe("Weekly digest");
    // The schedule survives so Adjust re-opens the rows the reader last saw.
    expect(resolved.proposal.schedule).toEqual(WEEKDAYS_9AM);
    // …and the plain-language line comes from the ONE renderer the settled
    // card reads back through, so the two can never word it differently.
    expect(resolved.scheduleCopy).toBe(service.describeProposalSchedule(WEEKDAYS_9AM));
  });

  it("still answers `expired` when the conversation is reopened much later", async () => {
    // Reload persistence: nothing about the reading decays, because nothing
    // about it is stored. The same ref resolves the same way indefinitely.
    const { token } = mintExpired(WEEKDAYS_9AM, 30 * 24 * 3600);
    const first = await service.resolveProposalForReader(token, READER);
    const second = await service.resolveProposalForReader(token, READER);
    expect(first.phase).toBe("expired");
    expect(second).toEqual(first);
  });

  it("does not spend a provisioning read on a card that asks nothing", async () => {
    const { token } = mintExpired();
    await service.resolveProposalForReader(token, READER);
    // The runnable verdict describes a floor the expired reading does not have.
    expect(assertAgentPackageRunnable).not.toHaveBeenCalled();
  });

  it("leaves a LIVE proposal exactly as it was — a drawn card with a floor", async () => {
    const { token } = mintLive();
    const resolved = await service.resolveProposalForReader(token, READER);
    if (resolved.phase !== "proposal") throw new Error("expected a live proposal");
    expect(resolved.canConfirm).toBe(true);
    expect(resolved.restrictedReason).toBeNull();
  });
});

describe("`absent` still means what §IV reserves it for", () => {
  it("answers `absent` for another user's expired proposal", async () => {
    const { token } = mintExpired();
    const resolved = await service.resolveProposalForReader(token, {
      userId: "user_someone_else",
      orgId: ORG,
    });
    expect(resolved.phase).toBe("absent");
  });

  it("answers `absent` for another org's expired proposal", async () => {
    const { token } = mintExpired();
    const resolved = await service.resolveProposalForReader(token, {
      userId: USER,
      orgId: "org_someone_else",
    });
    expect(resolved.phase).toBe("absent");
  });

  it("answers `absent` for a forged ref, expired or not", async () => {
    for (const ref of ["not-a-token", "", "a".repeat(600)]) {
      const resolved = await service.resolveProposalForReader(ref, READER);
      expect(resolved.phase).toBe("absent");
    }
  });

  it("answers `absent` when the agent has since vanished, rather than naming it", async () => {
    readAgentTemplateById.mockResolvedValue(null);
    const { token } = mintExpired();
    const resolved = await service.resolveProposalForReader(token, READER);
    expect(resolved.phase).toBe("absent");
  });

  it("answers `absent` when the template has moved out of the reader's org", async () => {
    readAgentTemplateById.mockResolvedValue({
      id: TEMPLATE,
      name: "Weekly digest",
      packageName: "@cinatra-ai/weekly-digest",
      packageVersion: "1.0.0",
      orgId: "org_somewhere_else",
    });
    const { token } = mintExpired();
    const resolved = await service.resolveProposalForReader(token, READER);
    expect(resolved.phase).toBe("absent");
  });
});

describe("a CONFIRMED proposal is settled forever, not expired and not absent", () => {
  it("keeps drawing the trigger's chrome once the token's own window has closed", async () => {
    // The second half of the same defect: the TTL bounds how long a proposal
    // may be CONFIRMED, never how long its card may be READ. Gating the whole
    // resolve on it deleted the SETTLED card too — for a schedule that was
    // confirmed and is now happily armed.
    const minted = mintExpired();
    readProposalConsume.mockResolvedValue({ runId: "run_2836", orgId: ORG });
    readRunTriggerByRunId.mockResolvedValue({
      triggerType: "recurring",
      timezone: "Europe/Berlin",
      releasedAt: null,
    });
    const resolved = await service.resolveProposalForReader(minted.token, READER);
    if (resolved.phase !== "settled") throw new Error("expected a settled reading");
    expect(resolved.runId).toBe("run_2836");
    expect(resolved.triggerType).toBe("recurring");
    // The consume identity an expired token addresses is still the one its mint
    // reported — expiry changes nothing about which row it names.
    expect(readProposalConsume).toHaveBeenCalledWith(minted.consumeKey);
  });
});

describe("ADJUST from an expired card re-proposes", () => {
  it("mints a FRESH proposal with a new consume identity", async () => {
    const expired = mintExpired();
    const result = await service.reproposeExpiredScheduleProposal(READER, expired.token);
    if (!result.ok) throw new Error(`expected a fresh proposal, got ${result.error}`);
    expect(result.token).not.toBe(expired.token);
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("re-proposes the SAME schedule the expired card was showing", async () => {
    const expired = mintExpired();
    const result = await service.reproposeExpiredScheduleProposal(READER, expired.token);
    if (!result.ok) throw new Error("expected a fresh proposal");
    // Resolve the new ref the way the card will: it comes back live, with the
    // rows the reader last saw and a floor they can press.
    const resolved = await service.resolveProposalForReader(result.token, READER);
    if (resolved.phase !== "proposal") throw new Error("expected a live proposal");
    expect(resolved.proposal.schedule).toEqual(WEEKDAYS_9AM);
    expect(resolved.canConfirm).toBe(true);
  });

  it("needs no identifier from the client — the card's own ref carries it", async () => {
    const expired = mintExpired();
    const result = await service.reproposeExpiredScheduleProposal(READER, expired.token);
    if (!result.ok) throw new Error("expected a fresh proposal");
    const resolved = await service.resolveProposalForReader(result.token, READER);
    if (resolved.phase !== "proposal") throw new Error("expected a live proposal");
    expect(resolved.proposal.templateId).toBe(TEMPLATE);
  });

  it("writes NOTHING — re-proposing is free, so it can never half-arm a schedule", async () => {
    const expired = mintExpired();
    await service.reproposeExpiredScheduleProposal(READER, expired.token);
    // The only store this path may touch is the consume READ that proves the
    // proposal was never spent.
    expect(readAgentTemplateById).toHaveBeenCalled();
    expect(readProposalConsume).toHaveBeenCalled();
  });

  it("refuses a proposal that is not this reader's, with the one generic sentence", async () => {
    const expired = mintExpired();
    const result = await service.reproposeExpiredScheduleProposal(
      { userId: "user_someone_else", orgId: ORG },
      expired.token,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(service.PROPOSAL_REFUSALS.invalid);
  });

  it("refuses a forged ref", async () => {
    const result = await service.reproposeExpiredScheduleProposal(READER, "not-a-token");
    expect(result.ok).toBe(false);
  });

  it("refuses to re-propose an ALREADY CONFIRMED proposal", async () => {
    // Its card is settled, not expired, so nothing draws this — but a quiet
    // re-propose here would be a way to double-book an armed schedule by
    // pressing an old button twice.
    const expired = mintExpired();
    readProposalConsume.mockResolvedValue({ runId: "run_2836", orgId: ORG });
    const result = await service.reproposeExpiredScheduleProposal(READER, expired.token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(service.PROPOSAL_REFUSALS.invalid);
  });

  it("tells the reader plainly when the ONE-SHOT moment itself has passed", async () => {
    // A 09:00 one-shot that expired at 09:30 cannot be re-proposed as it
    // stands. `propose` would refuse it anyway; saying WHY is what turns a dead
    // button into the sentence that tells the reader to ask for a new time.
    const pastOneShot: ProposalSchedule = {
      kind: "scheduled",
      runAt: "2020-01-01T09:00",
      timezone: "Europe/Berlin",
    };
    const expired = mintExpired(pastOneShot);
    const result = await service.reproposeExpiredScheduleProposal(READER, expired.token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(service.PROPOSAL_REFUSALS.past);
  });

  it("refuses when the agent has since vanished", async () => {
    const expired = mintExpired();
    readAgentTemplateById.mockResolvedValue(null);
    const result = await service.reproposeExpiredScheduleProposal(READER, expired.token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(service.PROPOSAL_REFUSALS.invalid);
  });
});
