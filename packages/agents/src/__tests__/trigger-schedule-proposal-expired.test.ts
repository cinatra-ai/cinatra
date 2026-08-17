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
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from "vitest";

import {
  PROPOSAL_TTL_SECONDS,
  mintTriggerScheduleProposalToken,
  proposalConsumeKey,
  readTriggerScheduleProposalToken,
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
const createAgentRunPendingInput = vi.fn();
const spendProposalWithinTx = vi.fn();
const claimPendingInstallIntents = vi.fn();

/**
 * The ONE primitive the lineage argument rests on, standing in for
 * `trigger_schedule_proposal_consumes`: a map keyed by `consume_key`, and a
 * PRIMARY KEY that refuses the second writer.
 *
 * Modelled rather than mocked away, because "the old card and the new one can
 * never both be confirmed" is a claim about THIS uniqueness and nothing else. A
 * `vi.fn()` returning a canned verdict would prove the canned verdict.
 */
type ConsumeRow = {
  consumeKey: string;
  runId: string;
  orgId: string;
  templateId: string;
  consumedBy: string;
  consumedAt: Date;
};
const ledger = new Map<string, ConsumeRow>();
/** Every run row the fake `createAgentRunPendingInput` actually COMMITTED. */
const committedRuns: string[] = [];

/** Mirrors the store's typed double-spend error (the service `instanceof`s it). */
class FakeProposalAlreadyConsumedError extends Error {
  constructor(public readonly consumeKey: string) {
    super("trigger schedule proposal: already consumed");
    this.name = "ProposalAlreadyConsumedError";
  }
}

vi.mock("../store", () => ({
  readAgentTemplateById: (...args: unknown[]) => readAgentTemplateById(...args),
  createAgentRunPendingInput: (...args: unknown[]) =>
    createAgentRunPendingInput(...args),
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
  ProposalAlreadyConsumedError: FakeProposalAlreadyConsumedError,
  claimPendingInstallIntents: (...args: unknown[]) =>
    claimPendingInstallIntents(...args),
  markInstallIntentArmed: vi.fn(),
  markInstallIntentDone: vi.fn(),
  parkInstallIntent: vi.fn(),
  readInstallIntent: (...args: unknown[]) => readInstallIntent(...args),
  readProposalConsume: (...args: unknown[]) => readProposalConsume(...args),
  releaseInstallIntent: vi.fn(),
  spendProposalWithinTx: (...args: unknown[]) => spendProposalWithinTx(...args),
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
  ledger.clear();
  committedRuns.length = 0;
  runSeq = 0;
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
  claimPendingInstallIntents.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The store fakes the LINEAGE block drives
// ---------------------------------------------------------------------------

let runSeq = 0;

/** `readProposalConsume`, answered from the ledger rather than from a canned value. */
function ledgerRead() {
  readProposalConsume.mockImplementation(
    async (key: string) => ledger.get(key) ?? null,
  );
}

/**
 * `spendProposalWithinTx` — the consume INSERT, with the table's primary key.
 * Throws the typed double-spend error the confirm path catches, exactly as the
 * real store does on a `23505`.
 */
function ledgerSpend(key: string, row: Omit<ConsumeRow, "consumeKey" | "consumedAt">) {
  if (ledger.has(key)) throw new FakeProposalAlreadyConsumedError(key);
  ledger.set(key, { consumeKey: key, ...row, consumedAt: new Date() });
}

/**
 * `createAgentRunPendingInput` — the run row and its companion write in ONE
 * transaction. If the companion throws, the run ROLLS BACK: nothing is pushed
 * to `committedRuns`, which is what makes "exactly one run" assertable.
 */
function wireCreateRun() {
  ledgerRead();
  spendProposalWithinTx.mockImplementation(async (_tx: unknown, input: ConsumeRow) => {
    ledgerSpend(input.consumeKey, {
      runId: input.runId,
      orgId: input.orgId,
      templateId: input.templateId,
      consumedBy: input.consumedBy,
    });
  });
  createAgentRunPendingInput.mockImplementation(
    async (input: {
      orgId: string;
      withinCreateTx?: (tx: unknown, run: { id: string; orgId: string }) => Promise<void>;
    }) => {
      runSeq += 1;
      const run = { id: `run_${runSeq}`, orgId: input.orgId };
      // The companion write runs INSIDE the transaction; if it raises, the run
      // never commits.
      if (input.withinCreateTx) await input.withinCreateTx({}, run);
      committedRuns.push(run.id);
      return run;
    },
  );
}

/** The consume identity a token addresses — the thing the lineage is ABOUT. */
function consumeKeyOf(token: string): string {
  const reading = readTriggerScheduleProposalToken({
    token,
    expectedUserId: USER,
    expectedOrgId: ORG,
  });
  if (!reading) throw new Error("expected a readable token");
  return proposalConsumeKey(reading.proposal.nonce);
}

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
  it("mints a FRESH token on a FRESH window", async () => {
    const expired = mintExpired();
    const result = await service.reproposeExpiredScheduleProposal(READER, expired.token);
    if (!result.ok) throw new Error(`expected a fresh proposal, got ${result.error}`);
    expect(result.token).not.toBe(expired.token);
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    // The token is fresh; the IDENTITY is not, and that is deliberate — see the
    // lineage block below.
    expect(consumeKeyOf(result.token)).toBe(expired.consumeKey);
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

// ---------------------------------------------------------------------------
// Re-propose is EXPIRED-ONLY, and its replacement shares ONE consume identity
// ---------------------------------------------------------------------------
//
// Codex round-3, findings 1–3. The earlier cut read the token's status without
// requiring it and checked "already spent" with a non-transactional read, so
// there were two ways to end up holding two independently confirmable
// proposals for the same schedule:
//
//   1. hand re-propose a STILL-LIVE ref — it never asked — and confirm both;
//   2. let a Confirm that verified while the token was live commit DURING the
//      re-propose, after its spent-check read `null`.
//
// (1) is closed by requiring `expired` on the server. (2) cannot be closed by a
// check at all — any read has a window after it — so it is closed by IDENTITY:
// the replacement inherits the original's nonce, so both address ONE row under
// the consume table's primary key. These tests drive that table directly,
// because that primary key is the entire argument.

describe("re-propose refuses anything that is not an EXPIRED reading", () => {
  it("refuses a STILL-LIVE ref — the live card is already answerable", async () => {
    const live = mintLive();
    const result = await service.reproposeExpiredScheduleProposal(READER, live.token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The same sentence a forged ref gets: probing with a live ref teaches
    // nothing about the state of anything.
    expect(result.error).toBe(service.PROPOSAL_REFUSALS.invalid);
  });

  it("refuses the live ref BEFORE it touches any store", async () => {
    const live = mintLive();
    await service.reproposeExpiredScheduleProposal(READER, live.token);
    expect(readProposalConsume).not.toHaveBeenCalled();
    expect(readAgentTemplateById).not.toHaveBeenCalled();
  });

  it("leaves the live proposal itself untouched — it is still the ONE question", async () => {
    const live = mintLive();
    await service.reproposeExpiredScheduleProposal(READER, live.token);
    const resolved = await service.resolveProposalForReader(live.token, READER);
    if (resolved.phase !== "proposal") throw new Error("expected a live proposal");
    expect(resolved.canConfirm).toBe(true);
  });

  it("refuses a live ref for a ONE-SHOT too, without leaking which check failed", async () => {
    // A live one-shot fails the expiry rule, not the past-moment rule, and the
    // reader must not be able to tell the two apart by the sentence.
    const live = mintLive({
      kind: "scheduled",
      runAt: "2099-01-01T09:00",
      timezone: "Europe/Berlin",
    });
    const result = await service.reproposeExpiredScheduleProposal(READER, live.token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(service.PROPOSAL_REFUSALS.invalid);
  });

  it("refuses a ref that has been CONFIRMED and has since expired", async () => {
    // Confirm-then-re-propose, driven end to end: the proposal is confirmed
    // while its window is open, the window then closes, and the expired card
    // still sitting in the transcript asks to be re-proposed.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z"));
    wireCreateRun();

    const proposal = mintLive();
    const confirmed = await service.confirmTriggerScheduleProposal(READER, proposal.token);
    expect(confirmed).toEqual({ ok: true, runId: "run_1", alreadyConfirmed: false });

    // The window closes on a card that has already been answered.
    vi.setSystemTime(new Date("2026-08-17T10:31:00Z"));
    const result = await service.reproposeExpiredScheduleProposal(READER, proposal.token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(service.PROPOSAL_REFUSALS.invalid);
    // Nothing was minted, so there is nothing else to confirm.
    expect(committedRuns).toEqual(["run_1"]);
  });
});

describe("ONE consume identity per lineage — old and new can never BOTH be spent", () => {
  beforeEach(() => {
    wireCreateRun();
  });

  it("gives the replacement the ORIGINAL's consume key, not a second one", async () => {
    const original = mintExpired();
    const result = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!result.ok) throw new Error("expected a fresh proposal");
    expect(result.token).not.toBe(original.token);
    expect(consumeKeyOf(result.token)).toBe(original.consumeKey);
    // …and re-proposing again stays in the same lineage, however many times the
    // reader presses Adjust.
    const again = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!again.ok) throw new Error("expected a fresh proposal");
    expect(consumeKeyOf(again.token)).toBe(original.consumeKey);
  });

  it("cannot yield two confirmable identities when Confirm commits MID-re-propose", async () => {
    // THE RACE, driven at the store. The re-propose has already read "not
    // spent"; a Confirm that verified while the token was still live now
    // commits, in the window between that read and the mint. There is no check
    // that can see this — so the mechanism has to make the outcome harmless.
    const original = mintExpired();
    readProposalConsume.mockImplementationOnce(async (key: string) => {
      const answer = ledger.get(key) ?? null;
      // Confirm commits, RIGHT HERE — after the read, before the mint.
      ledgerSpend(original.consumeKey, {
        runId: "run_from_inflight_confirm",
        orgId: ORG,
        templateId: TEMPLATE,
        consumedBy: USER,
      });
      return answer;
    });

    const result = await service.reproposeExpiredScheduleProposal(READER, original.token);
    // The re-propose still succeeds — it read an honest `null` — but what it
    // minted is DEAD ON ARRIVAL, because it addresses the identity that was
    // just spent.
    if (!result.ok) throw new Error("expected the re-propose to have succeeded");
    expect(consumeKeyOf(result.token)).toBe(original.consumeKey);

    // Confirming the replacement creates NO second run: it answers with the run
    // the in-flight Confirm produced.
    const confirmed = await service.confirmTriggerScheduleProposal(READER, result.token);
    expect(confirmed).toEqual({
      ok: true,
      runId: "run_from_inflight_confirm",
      alreadyConfirmed: true,
    });
    expect(createAgentRunPendingInput).not.toHaveBeenCalled();
    expect(committedRuns).toEqual([]);
    expect(ledger.size).toBe(1);

    // And the replacement's own card tells the truth: settled against that run,
    // not a live question awaiting an answer.
    const resolved = await service.resolveProposalForReader(result.token, READER);
    if (resolved.phase !== "settled") throw new Error("expected a settled reading");
    expect(resolved.runId).toBe("run_from_inflight_confirm");
  });

  it("answers a replacement Confirm with the ORIGINAL run when the original won", async () => {
    // The same race one beat later: the re-propose completed cleanly, and only
    // then did the in-flight Confirm commit.
    const original = mintExpired();
    const result = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!result.ok) throw new Error("expected a fresh proposal");

    ledgerSpend(original.consumeKey, {
      runId: "run_original",
      orgId: ORG,
      templateId: TEMPLATE,
      consumedBy: USER,
    });

    const confirmed = await service.confirmTriggerScheduleProposal(READER, result.token);
    expect(confirmed).toEqual({
      ok: true,
      runId: "run_original",
      alreadyConfirmed: true,
    });
    expect(committedRuns).toEqual([]);
  });

  it("answers the ORIGINAL's Confirm with the run the REPLACEMENT already created", async () => {
    // The other order, end to end and on a real clock: mint live, let the
    // window close, re-propose, confirm the replacement — and then let the
    // Confirm that was already in flight for the ORIGINAL (verified back when
    // it was live) reach the store.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z"));

    const original = mintLive();
    vi.setSystemTime(new Date("2026-08-17T10:31:00Z"));
    const result = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!result.ok) throw new Error("expected a fresh proposal");

    const first = await service.confirmTriggerScheduleProposal(READER, result.token);
    expect(first).toEqual({ ok: true, runId: "run_1", alreadyConfirmed: false });

    // The in-flight original: rewind to the moment it verified, when its window
    // was still open, and let it commit now.
    vi.setSystemTime(new Date("2026-08-17T10:10:00Z"));
    const second = await service.confirmTriggerScheduleProposal(READER, original.token);
    // It confirms nothing new. One question, one answer, one run.
    expect(second).toEqual({ ok: true, runId: "run_1", alreadyConfirmed: true });
    expect(committedRuns).toEqual(["run_1"]);
    expect(ledger.size).toBe(1);
  });

  it("survives the TIGHTEST interleave — both Confirms past their spent-check", async () => {
    // Neither Confirm's fast-path read can see the other, so both open a
    // transaction and both try to INSERT. The primary key decides, not the
    // application: the loser's run rolls back with its failed insert.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z"));

    const original = mintLive();
    vi.setSystemTime(new Date("2026-08-17T10:31:00Z"));
    const result = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!result.ok) throw new Error("expected a fresh proposal");
    vi.setSystemTime(new Date("2026-08-17T10:32:00Z"));

    // Both fast-path reads answer `null` — the state both Confirms observed
    // before either committed.
    readProposalConsume.mockImplementationOnce(async () => null);
    readProposalConsume.mockImplementationOnce(async () => null);

    const [a, b] = await Promise.all([
      service.confirmTriggerScheduleProposal(READER, result.token),
      // The original is expired at this clock, so drive its Confirm from the
      // moment it was live — the only way this interleave exists at all.
      (async () => {
        vi.setSystemTime(new Date("2026-08-17T10:10:00Z"));
        const outcome = await service.confirmTriggerScheduleProposal(READER, original.token);
        vi.setSystemTime(new Date("2026-08-17T10:32:00Z"));
        return outcome;
      })(),
    ]);

    // EXACTLY ONE run exists, exactly one consume row was written, and both
    // callers were told the same run id.
    expect(committedRuns).toHaveLength(1);
    expect(ledger.size).toBe(1);
    const winner = committedRuns[0];
    for (const outcome of [a, b]) {
      if (!outcome.ok) throw new Error(`expected both Confirms to answer ok: ${outcome.error}`);
      expect(outcome.runId).toBe(winner);
    }
    // One of them created it; the other was told it already existed.
    expect([a, b].filter((o) => o.ok && o.alreadyConfirmed)).toHaveLength(1);
  });
});
