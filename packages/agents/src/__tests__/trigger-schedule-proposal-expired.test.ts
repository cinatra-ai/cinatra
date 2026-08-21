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
 *
 * WHAT THE IN-MEMORY LINEAGE MODEL DOES AND DOES NOT EXERCISE (the convention
 * this suite keeps: say what a pin proves, and say what it stands in for).
 *
 * IT DOES exercise, for real: the conditional write itself — a live row is
 * never overwritten, an expired or absent one is claimed — and every decision
 * the SERVICE makes off the outcome, which is where both round-5 defects lived.
 * The tokens those decisions are made about are real, so "the adopted token is
 * re-read against the asking reader" is pinned by real crypto refusing a real
 * foreign token, not by a flag.
 *
 * IT DOES NOT exercise: the SQL. `setWhere` against `now()`, the `gt` re-read,
 * the PRIMARY KEY on `consume_key` and the row's ON DELETE CASCADE are Postgres
 * behaviours a `Map` cannot have; the lineage-schema parity test and the
 * integration suite cover those. Nor can this model produce a genuine
 * claim/read interleaving: two statements are one JS turn apart here, so the
 * `vanished` outcome — the row disappearing between them — is DRIVEN by
 * overriding the claim mock for a press rather than raced into existence. That
 * is the honest shape of the pin: the interleaving is stipulated, and what is
 * under test is the service's response to it (re-claim once, then refuse),
 * which is the part that was wrong.
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
const readLineageReproposal = vi.fn();
const claimLineageReproposal = vi.fn();

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

/**
 * The SECOND primitive the lineage argument now rests on, standing in for
 * `trigger_schedule_proposal_lineage`: a map keyed by `consume_key` again, and
 * an upsert that REFUSES to overwrite a row whose replacement is still live.
 *
 * Modelled rather than mocked away for the same reason the consume ledger is —
 * "at most one live replacement per lineage" is a claim about exactly this
 * conditional write, and a `vi.fn()` returning a canned token would prove the
 * canned token. The clock is `Date.now()`, so the suite's fake timers move it
 * the way `now()` moves in the real statement.
 */
type LineageRow = { consumeKey: string; token: string; expiresAt: Date };
const lineage = new Map<string, LineageRow>();

/**
 * The conditional upsert, in the three outcomes the real statement has: a LIVE
 * row is never overwritten (`yielded`, answering with what the lineage is
 * actually holding), a free slot is taken (`claimed`), and the claim can refuse
 * against a live row that is then GONE by the time the loser reads it back
 * (`vanished` — nothing claimed, nothing held).
 *
 * `vanished` cannot arise from this map on its own: one JS turn separates no
 * two statements here, so the suite drives it by overriding the mock for a
 * press. That is honest about what is modelled — the interleaving is real in
 * Postgres and stubbed here — and the branch under test is the SERVICE's
 * response to it, which is what the pin is about.
 *
 * `supersedes` IS THE SECOND DISJUNCT (cinatra#2837, the drawn form's Adjust):
 * a live row may ALSO be overwritten when the token it names is the one the
 * caller is exchanging. Modelled here because the drawn Adjust's whole bound is
 * that this widening is exact — a live row naming any OTHER token still yields.
 */
async function fakeClaimLineage(input: {
  consumeKey: string;
  token: string;
  expiresAt: Date;
  supersedes?: string;
}) {
  const held = lineage.get(input.consumeKey);
  if (
    held &&
    held.expiresAt.getTime() > Date.now() &&
    held.token !== input.supersedes
  ) {
    return { outcome: "yielded" as const, record: held };
  }
  const row: LineageRow = {
    consumeKey: input.consumeKey,
    token: input.token,
    expiresAt: input.expiresAt,
  };
  lineage.set(input.consumeKey, row);
  return { outcome: "claimed" as const, record: row };
}
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
  claimLineageReproposal: (...args: unknown[]) => claimLineageReproposal(...args),
  readLineageReproposal: (...args: unknown[]) => readLineageReproposal(...args),
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
  lineage.clear();
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
  readLineageReproposal.mockImplementation(
    async (key: string) => lineage.get(key) ?? null,
  );
  claimLineageReproposal.mockImplementation(fakeClaimLineage);
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

describe("the lineage holds ONE live replacement — Adjust is idempotent while it lives", () => {
  // WHAT THIS REPLACES. The suite used to pin that re-proposing "stays in the
  // same lineage, however many times the reader presses Adjust" — which was
  // true, and was also the defect: an expired ref reads as authenticated
  // contents FOREVER (§VI's expired card depends on it), so every press minted
  // another fresh-TTL token. The consume edge caps the lineage at one RUN; it
  // caps minting at nothing, and it does not stop the confirmation window being
  // rolled forward indefinitely by a button.
  //
  // The bound is the lineage-latest ratchet, and the shape it has to have is
  // IDEMPOTENT WHILE LIVE: the same token comes back while it is un-expired, a
  // new one only once it is not. Pressing Adjust as often as you like still
  // works — you simply get the card you already have.

  beforeEach(() => {
    wireCreateRun();
  });

  it("returns the SAME token while the replacement it minted is still live", async () => {
    const original = mintExpired();
    const first = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!first.ok) throw new Error("expected a fresh proposal");

    // Press it again, and again. Nothing new is minted: the reader is handed
    // the live card they already have.
    const second = await service.reproposeExpiredScheduleProposal(READER, original.token);
    const third = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!second.ok || !third.ok) throw new Error("expected the live replacement back");
    expect(second.token).toBe(first.token);
    expect(third.token).toBe(first.token);
    // …and the window did not roll: same expiry, not three fresh TTLs.
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(third.expiresAt).toBe(first.expiresAt);
    // One live token for this lineage, whatever the reader does.
    expect(lineage.size).toBe(1);
  });

  it("mints a NEW one only once that replacement has itself expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z"));
    const original = mintExpired();
    const first = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!first.ok) throw new Error("expected a fresh proposal");

    // One second before the replacement's own expiry: still the same token.
    vi.setSystemTime(new Date((first.expiresAt - 1) * 1000));
    const stillLive = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!stillLive.ok) throw new Error("expected the live replacement back");
    expect(stillLive.token).toBe(first.token);

    // Past it: the window has genuinely closed, so a new one may be minted —
    // and it is still the SAME lineage, so still one run at most.
    vi.setSystemTime(new Date((first.expiresAt + 1) * 1000));
    const renewed = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!renewed.ok) throw new Error("expected a fresh proposal");
    expect(renewed.token).not.toBe(first.token);
    expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt);
    expect(consumeKeyOf(renewed.token)).toBe(original.consumeKey);
    // The window rolled by ONE TTL for one real expiry, not by one per press.
    expect(renewed.expiresAt - first.expiresAt).toBe(
      PROPOSAL_TTL_SECONDS + 1,
    );
    expect(lineage.size).toBe(1);
  });

  it("answers a SUPERSEDED replacement's own Adjust with the CURRENT live one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T10:00:00Z"));
    const original = mintExpired();
    const superseded = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!superseded.ok) throw new Error("expected a fresh proposal");

    // That replacement expires; the reader presses Adjust and gets its successor.
    vi.setSystemTime(new Date((superseded.expiresAt + 1) * 1000));
    const current = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!current.ok) throw new Error("expected a fresh proposal");
    expect(current.token).not.toBe(superseded.token);

    // The SUPERSEDED replacement's own ref is still a card in a transcript. It
    // reads exactly as any other expired member of the lineage…
    const resolved = await service.resolveProposalForReader(superseded.token, READER);
    expect(resolved.phase).toBe("expired");

    // …and pressing ITS Adjust joins the lineage where it already is, rather
    // than opening a third branch.
    const fromSuperseded = await service.reproposeExpiredScheduleProposal(
      READER,
      superseded.token,
    );
    if (!fromSuperseded.ok) throw new Error("expected the live replacement back");
    expect(fromSuperseded.token).toBe(current.token);
    expect(consumeKeyOf(fromSuperseded.token)).toBe(original.consumeKey);
    expect(lineage.size).toBe(1);
  });

  it("hands the WINNER's token to both of two racing presses", async () => {
    // Two Adjusts on the same expired ref, interleaved so both read "no live
    // replacement" before either writes. Only one claim can land — the other
    // reads the winner's row and answers with THAT token, so no reader ever
    // holds a token the lineage is not holding open.
    const original = mintExpired();
    const [a, b] = await Promise.all([
      service.reproposeExpiredScheduleProposal(READER, original.token),
      service.reproposeExpiredScheduleProposal(READER, original.token),
    ]);
    if (!a.ok || !b.ok) throw new Error("expected both to have succeeded");
    expect(a.token).toBe(b.token);
    expect(lineage.size).toBe(1);
    expect(lineage.get(original.consumeKey)?.token).toBe(a.token);
  });

  // -------------------------------------------------------------------------
  // THE LOSER PATHS (codex round-5). Winning the claim is the easy half. Both
  // ways of losing hand the reader something that did NOT come from this call's
  // own mint, and each has to re-establish an invariant before it does.
  // -------------------------------------------------------------------------

  it("REFUSES rather than return an adopted token the asking reader cannot read", async () => {
    // The ratchet's stated promise is that a stored token is re-read against
    // the reader asking, exactly as their own ref was. The post-claim loser
    // path did not do it: it returned `held.token` straight out of the row.
    //
    // Modelled by putting a token in the lineage slot that belongs to a
    // DIFFERENT ORG — the one thing `readTriggerScheduleProposalToken` refuses
    // on that a live/expired check cannot see. (Its binding check is what makes
    // the org the discriminator here; a token for another USER in this org is
    // refused by the same branch, and the suite does not need both to pin that
    // the read happens at all.)
    const original = mintExpired();
    const foreign = mintTriggerScheduleProposalToken({
      templateId: TEMPLATE,
      userId: USER,
      orgId: "org_someone_else_entirely",
      schedule: WEEKDAYS_9AM,
    });
    if (!foreign) throw new Error("expected the foreign mint to have succeeded");
    // The lineage is holding it, and holding it LIVE, so the claim will yield.
    lineage.set(original.consumeKey, {
      consumeKey: original.consumeKey,
      token: foreign.token,
      expiresAt: new Date(foreign.expiresAt * 1000),
    });

    const result = await service.reproposeExpiredScheduleProposal(READER, original.token);

    // The refusal, and not the token — the same sentence the initial read gives.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toBe(service.PROPOSAL_REFUSALS.invalid);

    // Belt and braces on the thing that actually matters: the foreign token
    // never appears in an answer, and the lineage still holds exactly it (this
    // reader's discarded mint did not displace a live row).
    expect(lineage.get(original.consumeKey)?.token).toBe(foreign.token);
    expect(lineage.size).toBe(1);
  });

  it("RE-CLAIMS when the row it lost to has vanished, and returns a TRACKED token", async () => {
    // The interleaving: the conditional claim refuses against a live row, and
    // by the time the loser reads that row back it is GONE — expired into
    // overwritability, or deleted by a retention pass. The slot is free, and
    // nothing of this call's is in it.
    //
    // The earlier cut answered with its own unclaimed mint and called that
    // honest. It was not: the lineage would name no token while the reader held
    // a live one, so a later press could mint a SECOND live token beside it.
    const original = mintExpired();
    claimLineageReproposal.mockImplementationOnce(async () => {
      // The row was there when the claim ran, and is not there now.
      lineage.delete(original.consumeKey);
      return { outcome: "vanished" as const };
    });

    const result = await service.reproposeExpiredScheduleProposal(READER, original.token);
    if (!result.ok) throw new Error("expected the retry to have claimed");

    // ONE bounded retry, and it landed.
    expect(claimLineageReproposal).toHaveBeenCalledTimes(2);
    // TRACKED: the lineage row afterwards names EXACTLY the token returned, so
    // "how many live tokens does this lineage have" still answers 1.
    expect(lineage.size).toBe(1);
    expect(lineage.get(original.consumeKey)?.token).toBe(result.token);
    // …and it is still the one lineage, so still one run at most.
    expect(consumeKeyOf(result.token)).toBe(original.consumeKey);
  });

  it("REFUSES rather than hand out an unclaimed mint when the retry also vanishes", async () => {
    // The slot is being churned faster than a claim can land. Looping would be
    // a spin; the give-up branch must refuse, because the only other thing it
    // holds is a token no lineage row names.
    const original = mintExpired();
    claimLineageReproposal.mockImplementation(async () => {
      lineage.delete(original.consumeKey);
      return { outcome: "vanished" as const };
    });

    const result = await service.reproposeExpiredScheduleProposal(READER, original.token);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal, not an untracked mint");
    expect(result.error).toBe(service.PROPOSAL_REFUSALS.invalid);
    // Bounded: two attempts, not a spin.
    expect(claimLineageReproposal).toHaveBeenCalledTimes(2);
    // Nothing was installed, so there is nothing to unwind and no live token
    // loose in the world.
    expect(lineage.size).toBe(0);
    expect(committedRuns).toEqual([]);
  });

  it("refuses a SPENT lineage without touching the ratchet at all", async () => {
    // The consume check runs first and is unchanged: a settled lineage is not
    // re-proposed, and no live slot is opened for one.
    const original = mintExpired();
    ledgerSpend(original.consumeKey, {
      runId: "run_already",
      orgId: ORG,
      templateId: TEMPLATE,
      consumedBy: USER,
    });
    const result = await service.reproposeExpiredScheduleProposal(READER, original.token);
    expect(result.ok).toBe(false);
    expect(claimLineageReproposal).not.toHaveBeenCalled();
    expect(lineage.size).toBe(0);
  });
});

describe("the DRAWN card's Adjust goes through the same ratchet", () => {
  // THE DEFECT THIS PINS SHUT (groganz round, 2026-08-21). `adjustScheduleProposal`
  // — the drawn form's server action — minted BESIDE the lineage row instead of
  // through it. The mint was authentic and inherited the right consume
  // identity, so at most one member of the family could ever become a run; what
  // it did not do was touch the slot that names the replacement the lineage is
  // holding open. So the slot went on naming a token the reader had already
  // adjusted away from, a later Adjust handed that superseded token back, and a
  // live token existed beside the slot that the ratchet had never counted.
  //
  // It also stopped being unreachable in this branch: a `"use server"` export
  // only gets an action id once a client module imports the file, and the
  // expired card's Adjust is the first such import.
  //
  // The rule is now the same on both paths, and differs only where the two acts
  // genuinely differ: the slot may be CLAIMED when free or expired, ROLLED when
  // it names the very ref this reader is exchanging, and otherwise the press is
  // REFUSED. A live adjust never adopts the winner's token, because that token
  // answers a different question than the rows the reader just edited.

  beforeEach(() => {
    wireCreateRun();
  });

  const ADJUSTED: ProposalSchedule = {
    ...WEEKDAYS_9AM,
    selection: { ...WEEKDAYS_9AM.selection, hour: 8 },
  } as ProposalSchedule;

  it("CLAIMS the lineage slot for the replacement it mints", async () => {
    const original = mintLive();
    const adjusted = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: ADJUSTED,
    });
    if (!adjusted.ok) throw new Error("expected a fresh proposal");
    expect(adjusted.token).not.toBe(original.token);
    // One row, and it names what the reader is now holding.
    expect(lineage.size).toBe(1);
    expect(lineage.get(consumeKeyOf(original.token))?.token).toBe(adjusted.token);
    // Same lineage, so still at most one run in the whole family.
    expect(consumeKeyOf(adjusted.token)).toBe(consumeKeyOf(original.token));
  });

  it("ROLLS the slot forward when it names the ref being adjusted", async () => {
    const original = mintLive();
    const first = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: ADJUSTED,
    });
    if (!first.ok) throw new Error("expected a fresh proposal");

    // The reader edits the rows again, off the card they are now looking at.
    // The slot names that card, so it rolls: one live token in, one out.
    const second = await service.adjustLiveScheduleProposal(READER, {
      ref: first.token,
      schedule: WEEKDAYS_9AM,
    });
    if (!second.ok) throw new Error("expected the slot to roll");
    expect(second.token).not.toBe(first.token);
    expect(lineage.size).toBe(1);
    expect(lineage.get(consumeKeyOf(original.token))?.token).toBe(second.token);
  });

  it("REFUSES a stale card whose lineage slot is held by a LIVE successor", async () => {
    const original = mintLive();
    const current = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: ADJUSTED,
    });
    if (!current.ok) throw new Error("expected a fresh proposal");

    // A second tab still shows the ORIGINAL card and presses Adjust on it. The
    // slot is held by the successor, so this press mints nothing at all.
    const stale = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: WEEKDAYS_9AM,
    });
    expect(stale.ok).toBe(false);
    expect((stale as { error: string }).error).toBe(
      service.PROPOSAL_REFUSALS.superseded,
    );
    // The slot is untouched and still names the successor.
    expect(lineage.size).toBe(1);
    expect(lineage.get(consumeKeyOf(original.token))?.token).toBe(current.token);
  });

  it("FAILS CLOSED on a yielded claim — never mints past a refused slot", async () => {
    const original = mintLive();
    // A concurrent press established the slot AFTER this one read it free: the
    // pre-check passes, the claim is the thing that refuses.
    claimLineageReproposal.mockImplementationOnce(async () => ({
      outcome: "yielded" as const,
      record: {
        consumeKey: consumeKeyOf(original.token),
        token: "someone-elses-replacement",
        expiresAt: new Date(Date.now() + 60_000),
      },
    }));
    const result = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: ADJUSTED,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toBe(
      service.PROPOSAL_REFUSALS.superseded,
    );
    // The loser NEVER adopts the winner's token: it answers different rows.
    expect(JSON.stringify(result)).not.toContain("someone-elses-replacement");
    expect(lineage.size).toBe(0);
  });

  it("two racing adjusts leave ONE live token in the slot, and the loser is refused", async () => {
    const original = mintLive();
    const [a, b] = await Promise.all([
      service.adjustLiveScheduleProposal(READER, {
        ref: original.token,
        schedule: ADJUSTED,
      }),
      service.adjustLiveScheduleProposal(READER, {
        ref: original.token,
        schedule: WEEKDAYS_9AM,
      }),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { error: string }).error).toBe(
      service.PROPOSAL_REFUSALS.superseded,
    );
    // ONE row, naming the winner. The loser's mint is discarded unreturned.
    expect(lineage.size).toBe(1);
    expect(lineage.get(consumeKeyOf(original.token))?.token).toBe(
      (winners[0] as { token: string }).token,
    );
  });

  it("RE-CLAIMS once when the slot vanishes, and refuses if it vanishes again", async () => {
    const original = mintLive();
    claimLineageReproposal.mockImplementationOnce(async () => ({
      outcome: "vanished" as const,
    }));
    const recovered = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: ADJUSTED,
    });
    expect(recovered.ok).toBe(true);
    expect(claimLineageReproposal).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    lineage.clear();
    readLineageReproposal.mockImplementation(
      async (key: string) => lineage.get(key) ?? null,
    );
    claimLineageReproposal.mockImplementation(async () => ({
      outcome: "vanished" as const,
    }));
    const refused = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: ADJUSTED,
    });
    expect(refused.ok).toBe(false);
    // No token is handed out that no row names.
    expect(refused).not.toHaveProperty("token");
    expect(claimLineageReproposal).toHaveBeenCalledTimes(2);
  });

  it("refuses an EXPIRED ref — that card re-asks its own question elsewhere", async () => {
    const expired = mintExpired();
    const result = await service.adjustLiveScheduleProposal(READER, {
      ref: expired.token,
      schedule: ADJUSTED,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toBe(
      service.PROPOSAL_REFUSALS.invalid,
    );
    expect(claimLineageReproposal).not.toHaveBeenCalled();
  });

  it("refuses a forged ref and another reader's ref with the ONE sentence", async () => {
    const forged = await service.adjustLiveScheduleProposal(READER, {
      ref: "not-a-token",
      schedule: ADJUSTED,
    });
    expect(forged).toEqual({ ok: false, error: service.PROPOSAL_REFUSALS.invalid });

    const theirs = mintLive();
    const foreign = await service.adjustLiveScheduleProposal(
      { userId: "user_someone_else", orgId: ORG },
      { ref: theirs.token, schedule: ADJUSTED },
    );
    expect(foreign).toEqual({ ok: false, error: service.PROPOSAL_REFUSALS.invalid });
    expect(claimLineageReproposal).not.toHaveBeenCalled();
  });

  it("refuses a SPENT lineage without touching the ratchet at all", async () => {
    const original = mintLive();
    ledgerSpend(consumeKeyOf(original.token), {
      runId: "run_already",
      orgId: ORG,
      templateId: TEMPLATE,
      consumedBy: USER,
    });
    const result = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: ADJUSTED,
    });
    expect(result.ok).toBe(false);
    expect(claimLineageReproposal).not.toHaveBeenCalled();
    expect(lineage.size).toBe(0);
  });

  it("hands the expired path a slot the drawn Adjust actually moved", async () => {
    // The two forms compose. A live adjust rolls the slot; when everything in
    // the lineage has expired, the expired card's Adjust re-proposes off the
    // CURRENT head rather than being handed the card the reader corrected.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T10:00:00Z"));
    const original = mintLive();
    const adjusted = await service.adjustLiveScheduleProposal(READER, {
      ref: original.token,
      schedule: ADJUSTED,
    });
    if (!adjusted.ok) throw new Error("expected a fresh proposal");

    // Everything expires; the reader presses Adjust on the transcript's card.
    vi.setSystemTime(new Date((adjusted.expiresAt + 1) * 1000));
    const renewed = await service.reproposeExpiredScheduleProposal(
      READER,
      original.token,
    );
    if (!renewed.ok) throw new Error("expected a fresh proposal");
    // NOT the superseded token, and still one slot for the lineage.
    expect(renewed.token).not.toBe(adjusted.token);
    expect(lineage.size).toBe(1);
    expect(lineage.get(consumeKeyOf(original.token))?.token).toBe(renewed.token);
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
