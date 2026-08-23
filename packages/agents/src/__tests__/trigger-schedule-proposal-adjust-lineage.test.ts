/**
 * ADJUST SUPERSEDES: a proposal and the card that adjusted it are ONE consume
 * identity (cinatra#2859).
 *
 * Design: `specs/app-lifecycle-cards.html` §VI. "Adjust opens the same option
 * rows in place; Confirm settles them."
 *
 * THE DEFECT THIS PINS SHUT. `adjustTriggerSchedule` re-proposed with a FRESH
 * consume identity and wrote nothing, and `trigger_schedule_proposal_consumes`
 * enforces single-use per `consume_key` only — so the adjusted-away token stayed
 * spendable for the rest of its TTL. A stale tab or a replayed turn could
 * Confirm the old card while the reader confirmed the new one, and because the
 * two tokens addressed DIFFERENT rows, BOTH landed: two runs, one of them on the
 * schedule the reader had just corrected away from.
 *
 * The replacement now inherits the original's NONCE, and `proposalConsumeKey`
 * derives the single-use edge from the nonce — so every member of an adjust
 * family is one row under that table's PRIMARY KEY, and "both confirmed" stops
 * being a race the application has to win and becomes a state the database
 * cannot hold.
 *
 * Seam tier: the stores are mocked, the TOKEN IS REAL. What is under test is
 * which consume identity a mint lands on and what the confirm path does about
 * it, and the first of those is decided by real crypto — mocking the token would
 * test the mock.
 *
 * WHAT THE IN-MEMORY MODEL DOES AND DOES NOT EXERCISE.
 *
 * IT DOES exercise, for real: the uniqueness the whole argument rests on — a
 * `Map` keyed by `consume_key` plus a primary key that refuses the second
 * writer — and the ROLLBACK that makes "exactly one run" assertable, since the
 * fake `createAgentRunPendingInput` only commits a run whose companion write
 * survived. The tokens are genuinely minted and genuinely verified, so
 * "the old card and the new one are one identity" is proven by real SHA-256 over
 * a real decrypted nonce, not by a flag.
 *
 * IT DOES NOT exercise: the SQL. The PRIMARY KEY itself, the `23505` the store
 * translates, and ON DELETE CASCADE are Postgres behaviours a `Map` cannot have;
 * `trigger-schedule-proposal.integration.test.ts` covers those against a real
 * database. Nor is the two-tab race raced into existence here — both orderings
 * are DRIVEN, and what is under test is the confirm path's response to each,
 * which is the part that was wrong.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

import {
  PROPOSAL_TTL_SECONDS,
  mintTriggerScheduleProposalToken,
  proposalConsumeKey,
  verifyTriggerScheduleProposalToken,
  type ProposalSchedule,
} from "@/lib/trigger-schedule-proposal-token";

const ORG = "org_2859_adjust_lineage";
const USER = "user_2859_reader";
const OTHER_USER = "user_2859_someone_else";
const OTHER_ORG = "org_2859_elsewhere";
const TEMPLATE = "3f9a1c2b-7d4e-4a1f-9b2c-6e5d4c3b2a19";
const OTHER_TEMPLATE = "aa11bb22-cc33-4d44-8e55-ff6677889900";

/** The proposal as first drawn. */
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

/** What the reader adjusts it to — "make it 8 in the morning". */
const WEEKDAYS_8AM: ProposalSchedule = {
  ...WEEKDAYS_9AM,
  selection: { ...WEEKDAYS_9AM.selection, hour: 8 },
} as ProposalSchedule;

const readAgentTemplateById = vi.fn();
const readProposalConsume = vi.fn();
const readInstallIntent = vi.fn();
const readRunTriggerByRunId = vi.fn();
const assertAgentPackageRunnable = vi.fn();
const createAgentRunPendingInput = vi.fn();
const spendProposalWithinTx = vi.fn();
const claimPendingInstallIntents = vi.fn();

/**
 * The ONE primitive the whole invariant rests on, standing in for
 * `trigger_schedule_proposal_consumes`: a map keyed by `consume_key`, and a
 * PRIMARY KEY that refuses the second writer.
 *
 * Modelled rather than mocked away, because "the adjusted-away card and the
 * replacement can never both be confirmed" is a claim about THIS uniqueness and
 * nothing else. A `vi.fn()` returning a canned verdict would prove the canned
 * verdict.
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
 * The install OUTBOX row, written in the same transaction as the consume row.
 * It is the durable record of WHICH SCHEDULE a family actually settled on,
 * which is what lets the confirm path tell "already spent" from "already spent
 * on the rows you are looking at".
 */
type IntentRow = {
  runId: string;
  triggerType: string;
  scheduledAt: Date | null;
  cronExpression: string | null;
  timezone: string;
};
const intents = new Map<string, IntentRow>();

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

let runSeq = 0;

/** Mint a proposal whose window is still open. */
function mintLive(
  schedule: ProposalSchedule = WEEKDAYS_9AM,
  who: { userId: string; orgId: string; templateId?: string } = {
    userId: USER,
    orgId: ORG,
  },
) {
  const minted = mintTriggerScheduleProposalToken({
    templateId: who.templateId ?? TEMPLATE,
    userId: who.userId,
    orgId: who.orgId,
    schedule,
  });
  expect(minted).not.toBeNull();
  return minted!;
}

/** The consume key a token actually lands on — read back out of the ciphertext. */
function consumeKeyOf(token: string, who = READER): string {
  const proposal = verifyTriggerScheduleProposalToken({
    token,
    expectedUserId: who.userId,
    expectedOrgId: who.orgId,
  });
  expect(proposal).not.toBeNull();
  return proposalConsumeKey(proposal!.nonce);
}

/**
 * `createAgentRunPendingInput` — the run row and its companion writes in ONE
 * transaction. If the companion throws, the run ROLLS BACK: nothing is pushed to
 * `committedRuns`, which is what makes "exactly one run" assertable rather than
 * asserted.
 */
function wireStore() {
  readProposalConsume.mockImplementation(
    async (key: string) => ledger.get(key) ?? null,
  );
  readInstallIntent.mockImplementation(
    async (runId: string) => intents.get(runId) ?? null,
  );
  spendProposalWithinTx.mockImplementation(
    async (
      _tx: unknown,
      input: {
        consumeKey: string;
        runId: string;
        orgId: string;
        templateId: string;
        consumedBy: string;
        install: Omit<IntentRow, "runId">;
      },
    ) => {
      // THE PRIMARY KEY. The second writer never lands.
      if (ledger.has(input.consumeKey)) {
        throw new FakeProposalAlreadyConsumedError(input.consumeKey);
      }
      ledger.set(input.consumeKey, {
        consumeKey: input.consumeKey,
        runId: input.runId,
        orgId: input.orgId,
        templateId: input.templateId,
        consumedBy: input.consumedBy,
        consumedAt: new Date(),
      });
      // The install intent goes in the SAME transaction — it is the record of
      // which schedule this family settled on.
      intents.set(input.runId, { runId: input.runId, ...input.install });
    },
  );
  createAgentRunPendingInput.mockImplementation(
    async (input: {
      orgId: string;
      withinCreateTx?: (
        tx: unknown,
        run: { id: string; orgId: string },
      ) => Promise<void>;
    }) => {
      runSeq += 1;
      const run = { id: `run_${runSeq}`, orgId: input.orgId };
      // The companion write runs INSIDE the transaction; if it raises, the run
      // never commits and nothing of it survives.
      if (input.withinCreateTx) await input.withinCreateTx({}, run);
      committedRuns.push(run.id);
      return run;
    },
  );
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-2859-adjust-lineage";
  service = await import("../trigger-schedule-proposal-service");
});

beforeEach(() => {
  vi.clearAllMocks();
  ledger.clear();
  intents.clear();
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
  wireStore();
});

// ---------------------------------------------------------------------------
// The identity itself
// ---------------------------------------------------------------------------

describe("adjust inherits the adjusted-away proposal's consume identity", () => {
  it("the replacement addresses the SAME consume key, on its own fresh token", async () => {
    const original = mintLive(WEEKDAYS_9AM);

    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });

    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;
    // A genuinely different token — fresh IV, fresh ciphertext, fresh window...
    expect(adjusted.token).not.toBe(original.token);
    expect(adjusted.expiresAt).toBeGreaterThanOrEqual(original.expiresAt);
    // ...that lands on the SAME single-use edge.
    expect(consumeKeyOf(adjusted.token)).toBe(original.consumeKey);
    expect(consumeKeyOf(adjusted.token)).toBe(consumeKeyOf(original.token));
  });

  it("carries the ADJUSTED rows, not the ones it replaced", async () => {
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    const read = verifyTriggerScheduleProposalToken({
      token: adjusted.token,
      expectedUserId: USER,
      expectedOrgId: ORG,
    });
    expect(read?.schedule).toEqual(WEEKDAYS_8AM);
    expect(read?.templateId).toBe(TEMPLATE);
  });

  it("stays ONE identity however many times Adjust is pressed", async () => {
    const original = mintLive(WEEKDAYS_9AM);
    let ref = original.token;

    for (let hour = 8; hour >= 5; hour -= 1) {
      const next = await service.adjustTriggerSchedule({
        priorToken: ref,
        userId: USER,
        orgId: ORG,
        schedule: {
          ...WEEKDAYS_9AM,
          selection: { ...WEEKDAYS_9AM.selection, hour },
        } as ProposalSchedule,
      });
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      ref = next.token;
      expect(consumeKeyOf(ref)).toBe(original.consumeKey);
    }

    // Four presses, four live tokens, ONE run available between all of them.
    const confirmed = await service.confirmTriggerScheduleProposal(READER, ref);
    expect(confirmed.ok).toBe(true);
    const stale = await service.confirmTriggerScheduleProposal(
      READER,
      original.token,
    );
    expect(stale.ok).toBe(false);
    expect(committedRuns).toHaveLength(1);
    expect(ledger.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The defect: two Confirms, two runs
// ---------------------------------------------------------------------------

describe("the adjusted-away card can no longer arm a second run", () => {
  it("reader confirms the fresh ref; the stale tab's Confirm creates NOTHING", async () => {
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    // The reader confirms what they corrected TO.
    const fresh = await service.confirmTriggerScheduleProposal(
      READER,
      adjusted.token,
    );
    expect(fresh).toEqual({
      ok: true,
      runId: "run_1",
      alreadyConfirmed: false,
    });
    // The run really is on the ADJUSTED schedule.
    expect(intents.get("run_1")?.cronExpression).toBe("0 8 * * 1,2,3,4,5");

    // The stale tab presses Confirm on the card the reader adjusted away from.
    const stale = await service.confirmTriggerScheduleProposal(
      READER,
      original.token,
    );

    // It arms nothing, and it is TOLD so in words rather than being handed a
    // false "already confirmed" for rows nothing was armed with.
    expect(stale.ok).toBe(false);
    expect(stale).toEqual({
      ok: false,
      error: service.PROPOSAL_REFUSALS.supersededBySchedule,
    });
    expect(committedRuns).toEqual(["run_1"]);
    expect(ledger.size).toBe(1);
    expect(intents.size).toBe(1);
  });

  it("and in the OTHER ordering — the stale Confirm lands first — there is still exactly one run", async () => {
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    const stale = await service.confirmTriggerScheduleProposal(
      READER,
      original.token,
    );
    expect(stale.ok).toBe(true);

    const fresh = await service.confirmTriggerScheduleProposal(
      READER,
      adjusted.token,
    );
    // Refused, and honestly: the family settled on rows other than the ones
    // this card is showing. Silently answering `alreadyConfirmed: true` would
    // settle the reader's card displaying 8am for a run armed at 9am.
    expect(fresh).toEqual({
      ok: false,
      error: service.PROPOSAL_REFUSALS.supersededBySchedule,
    });
    expect(committedRuns).toHaveLength(1);
    expect(intents.get("run_1")?.cronExpression).toBe("0 9 * * 1,2,3,4,5");
  });

  it("both Confirms racing into the transaction still commit exactly one run", async () => {
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    // Force BOTH fast-path spent-checks to miss each other, so both open a
    // transaction and both attempt the consume INSERT — the tightest interleave.
    readProposalConsume.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const [a, b] = await Promise.all([
      service.confirmTriggerScheduleProposal(READER, original.token),
      service.confirmTriggerScheduleProposal(READER, adjusted.token),
    ]);

    expect(committedRuns).toHaveLength(1);
    expect(ledger.size).toBe(1);
    // Exactly one of them created it; the other created nothing at all.
    const created = [a, b].filter((r) => r.ok && !r.alreadyConfirmed);
    expect(created).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What must keep working
// ---------------------------------------------------------------------------

describe("the paths this must not break", () => {
  it("the ordinary double-press is still idempotent, not 'superseded'", async () => {
    const proposal = mintLive(WEEKDAYS_9AM);

    const first = await service.confirmTriggerScheduleProposal(
      READER,
      proposal.token,
    );
    const second = await service.confirmTriggerScheduleProposal(
      READER,
      proposal.token,
    );

    expect(first).toEqual({ ok: true, runId: "run_1", alreadyConfirmed: false });
    // The SAME rows, so it compares equal and answers with the original run —
    // the refusal is reserved for a genuine disagreement.
    expect(second).toEqual({ ok: true, runId: "run_1", alreadyConfirmed: true });
    expect(committedRuns).toEqual(["run_1"]);
  });

  it("#2837's expired-lineage Confirm still lands EXACTLY ONCE and is never refused", async () => {
    // #2837 re-proposes an EXPIRED card in its own lineage: the replacement
    // inherits the nonce and re-asks the SAME question with the SAME rows. That
    // family must keep landing its one Confirm — this change must neither
    // double-fire it nor block it.
    const original = mintLive(WEEKDAYS_9AM);
    const inLineage = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nonce: verifyTriggerScheduleProposalToken({
          token: original.token,
          expectedUserId: USER,
          expectedOrgId: ORG,
        })!.nonce },
    );
    expect(inLineage).not.toBeNull();
    expect(inLineage!.consumeKey).toBe(original.consumeKey);

    const confirmed = await service.confirmTriggerScheduleProposal(
      READER,
      inLineage!.token,
    );
    expect(confirmed).toEqual({
      ok: true,
      runId: "run_1",
      alreadyConfirmed: false,
    });

    // The other member of the same lineage resolves against that ONE run rather
    // than being refused — same rows, so nothing disagrees.
    const sibling = await service.confirmTriggerScheduleProposal(
      READER,
      original.token,
    );
    expect(sibling).toEqual({
      ok: true,
      runId: "run_1",
      alreadyConfirmed: true,
    });
    expect(committedRuns).toEqual(["run_1"]);
    expect(ledger.size).toBe(1);
  });

  it("#2858's composite needs no change: adjust, then confirm the NEW ref, is one run", async () => {
    // `adjustAndConfirmSchedule` is exactly this sequence over the wire. It
    // confirms only the ref the adjust returned, which is unchanged behaviour —
    // what changed is that the ref it did NOT confirm is no longer separately
    // spendable.
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    const confirmed = await service.confirmTriggerScheduleProposal(
      READER,
      adjusted.token,
    );
    expect(confirmed).toEqual({
      ok: true,
      runId: "run_1",
      alreadyConfirmed: false,
    });
    expect(committedRuns).toEqual(["run_1"]);
    expect(intents.get("run_1")?.cronExpression).toBe("0 8 * * 1,2,3,4,5");
  });

  it("a genuinely NEW proposal for the same agent is a different family and still confirms", async () => {
    // The (viewer, organization, template) triple is NOT the family: a reader
    // may legitimately schedule the same agent twice in one conversation
    // ("every Monday" and "also every Friday"), and keying uniqueness on the
    // triple would refuse the second one.
    const monday = mintLive(WEEKDAYS_9AM);
    const friday = mintLive({
      ...WEEKDAYS_9AM,
      selection: { ...WEEKDAYS_9AM.selection, weekdays: [5], hour: 17 },
    } as ProposalSchedule);
    expect(friday.consumeKey).not.toBe(monday.consumeKey);

    const a = await service.confirmTriggerScheduleProposal(READER, monday.token);
    const b = await service.confirmTriggerScheduleProposal(READER, friday.token);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(committedRuns).toEqual(["run_1", "run_2"]);
  });
});

// ---------------------------------------------------------------------------
// What Adjust refuses
// ---------------------------------------------------------------------------

describe("adjust refuses anything that is not this reader's live proposal", () => {
  it("a ref minted for another user, another org, or forged — and mints nothing", async () => {
    const foreignUser = mintLive(WEEKDAYS_9AM, {
      userId: OTHER_USER,
      orgId: ORG,
    });
    const foreignOrg = mintLive(WEEKDAYS_9AM, {
      userId: USER,
      orgId: OTHER_ORG,
    });

    for (const ref of [foreignUser.token, foreignOrg.token, "not-a-token", ""]) {
      const out = await service.adjustTriggerSchedule({
        priorToken: ref,
        userId: USER,
        orgId: ORG,
        schedule: WEEKDAYS_8AM,
      });
      expect(out).toEqual({ ok: false });
    }
    // The refusal lands before the template store is ever reached.
    expect(readAgentTemplateById).not.toHaveBeenCalled();
  });

  it("an EXPIRED ref — the drawn form adjusts a live card, #2837's path adjusts an expired one", async () => {
    const mintedAt =
      Math.floor(Date.now() / 1000) - PROPOSAL_TTL_SECONDS - 60;
    const expired = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nowSeconds: mintedAt },
    );
    expect(expired).not.toBeNull();

    const out = await service.adjustTriggerSchedule({
      priorToken: expired!.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(out).toEqual({ ok: false });
  });

  it("cannot be re-pointed at an agent the reader was never proposed", async () => {
    // The template comes from the VERIFIED ref, so there is no argument left to
    // steer: adjusting a proposal for TEMPLATE can only ever re-propose TEMPLATE.
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    const read = verifyTriggerScheduleProposalToken({
      token: adjusted.token,
      expectedUserId: USER,
      expectedOrgId: ORG,
    });
    expect(read?.templateId).toBe(TEMPLATE);
    expect(read?.templateId).not.toBe(OTHER_TEMPLATE);
    expect(readAgentTemplateById).toHaveBeenCalledWith(TEMPLATE);
  });
});

// ---------------------------------------------------------------------------
// The card the family left behind — RESOLUTION, not Confirm
// ---------------------------------------------------------------------------
//
// Confirm's `supersededBySchedule` refusal only fires when somebody PRESSES
// Confirm. Reopening a stale tab presses nothing: it resolves the card, and
// resolution is a read. Before this arm existed, that read found the family's
// one consume row, called it settled, and drew `describeProposalSchedule` over
// the READER'S OWN token — so the card the reader had corrected away from
// rendered as "settled" at the very times they corrected away from, next to the
// winner's run id. Sharing the consume identity is what makes that reachable,
// so it is this PR's to close, not a pre-existing one.

/** A one-off in another zone — an adjust that moves the DURABLE fields too. */
const ONCE_NEW_YORK: ProposalSchedule = {
  kind: "scheduled",
  runAt: "2026-09-01T08:00",
  timezone: "America/New_York",
};

describe("a superseded card resolves to the truth, not to its own rows", () => {
  it("the stale member never renders the schedule it was adjusted AWAY from", async () => {
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    // 8am wins Confirm...
    await service.confirmTriggerScheduleProposal(READER, adjusted.token);
    expect(intents.get("run_1")?.cronExpression).toBe("0 8 * * 1,2,3,4,5");

    // ...and the 9am tab is REOPENED. Nothing is pressed.
    const resolved = await service.resolveProposalForReader(
      original.token,
      READER,
    );

    expect(resolved.phase).toBe("settled");
    if (resolved.phase !== "settled") return;
    expect(resolved.superseded).toBe(true);
    expect(resolved.scheduleCopy).toBe(service.SUPERSEDED_SCHEDULE_COPY);
    // THE REGRESSION ITSELF: the adjusted-away line must not be on the card.
    expect(resolved.scheduleCopy).not.toBe(
      service.describeProposalSchedule(WEEKDAYS_9AM),
    );
    expect(resolved.scheduleCopy).not.toContain("9:00");
    // The run it points at is still the family's one run.
    expect(resolved.runId).toBe("run_1");
  });

  it("and symmetrically, when the STALE card is the one that won", async () => {
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    // The stale tab got there first, so the family is armed at 9am.
    await service.confirmTriggerScheduleProposal(READER, original.token);
    expect(intents.get("run_1")?.cronExpression).toBe("0 9 * * 1,2,3,4,5");

    // The reader's OWN, adjusted card is now the one showing rows nothing was
    // armed with — the same lie, pointing the other way.
    const resolved = await service.resolveProposalForReader(
      adjusted.token,
      READER,
    );
    expect(resolved.phase).toBe("settled");
    if (resolved.phase !== "settled") return;
    expect(resolved.superseded).toBe(true);
    expect(resolved.scheduleCopy).toBe(service.SUPERSEDED_SCHEDULE_COPY);
    expect(resolved.scheduleCopy).not.toBe(
      service.describeProposalSchedule(WEEKDAYS_8AM),
    );
    expect(resolved.scheduleCopy).not.toContain("8:00");
  });

  it("surfaces the INSTALLED trigger type and zone, never the stale card's", async () => {
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: ONCE_NEW_YORK,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    await service.confirmTriggerScheduleProposal(READER, adjusted.token);

    const resolved = await service.resolveProposalForReader(
      original.token,
      READER,
    );
    expect(resolved.phase).toBe("settled");
    if (resolved.phase !== "settled") return;
    expect(resolved.superseded).toBe(true);
    // The stale card is a RECURRING Europe/Berlin card. What was installed is a
    // one-off in New York, and those two fields already came from the durable
    // rows rather than from the token — so the card names the real schedule's
    // shape while `scheduleCopy` sends the reader to the run for its times.
    expect(resolved.triggerType).toBe("scheduled");
    expect(resolved.timezone).toBe("America/New_York");
  });

  it("the WINNING member resolves exactly as it did before", async () => {
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    await service.confirmTriggerScheduleProposal(READER, adjusted.token);

    const resolved = await service.resolveProposalForReader(
      adjusted.token,
      READER,
    );
    // Whole-object, so a stray field change on the settled card fails here too.
    //
    // TWO FIELDS JOINED THE SETTLED RESOLUTION (cinatra#2788): `schedule` — the
    // armed SELECTIONS, read back off the installed row so the settled card can
    // draw the same option rows the proposal did — and `canSave`, the reading
    // behind its Save-changes floor. They are asserted here rather than loosened
    // out of the comparison, which is the whole point of a whole-object check:
    // the winning member's rows are the ones it was adjusted TO (08:00), and it
    // cannot be saved yet because the install is still arming.
    expect(resolved).toEqual({
      phase: "settled",
      runId: "run_1",
      agentName: "Weekly digest",
      triggerType: "recurring",
      schedule: {
        kind: "recurring",
        timezone: "Europe/Berlin",
        selection: { ...WEEKDAYS_8AM.selection },
      },
      scheduleCopy: service.describeProposalSchedule(WEEKDAYS_8AM),
      timezone: "Europe/Berlin",
      released: false,
      arming: true,
      canSave: false,
      superseded: false,
    });
  });
});

describe("resolution never manufactures a supersession", () => {
  it("the ordinary double-press settles on its own rows", async () => {
    const proposal = mintLive(WEEKDAYS_9AM);
    await service.confirmTriggerScheduleProposal(READER, proposal.token);
    await service.confirmTriggerScheduleProposal(READER, proposal.token);

    const resolved = await service.resolveProposalForReader(
      proposal.token,
      READER,
    );
    expect(resolved.phase).toBe("settled");
    if (resolved.phase !== "settled") return;
    expect(resolved.superseded).toBe(false);
    expect(resolved.scheduleCopy).toBe(
      service.describeProposalSchedule(WEEKDAYS_9AM),
    );
  });

  it("#2837's equal-schedule lineage draws the SAME card from either member", async () => {
    // The re-proposed expired card re-asks the same question with the same
    // rows, so both members compare EQUAL and neither is superseded.
    const original = mintLive(WEEKDAYS_9AM);
    const inLineage = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      {
        nonce: verifyTriggerScheduleProposalToken({
          token: original.token,
          expectedUserId: USER,
          expectedOrgId: ORG,
        })!.nonce,
      },
    );
    expect(inLineage).not.toBeNull();

    await service.confirmTriggerScheduleProposal(READER, inLineage!.token);

    const fromReplacement = await service.resolveProposalForReader(
      inLineage!.token,
      READER,
    );
    const fromOriginal = await service.resolveProposalForReader(
      original.token,
      READER,
    );
    expect(fromReplacement).toEqual(fromOriginal);
    expect(fromOriginal.phase).toBe("settled");
    if (fromOriginal.phase !== "settled") return;
    expect(fromOriginal.superseded).toBe(false);
    expect(fromOriginal.scheduleCopy).toBe(
      service.describeProposalSchedule(WEEKDAYS_9AM),
    );
  });

  it("a MISSING install intent resolves exactly as it did before this change", async () => {
    // Nothing to compare against is not evidence of disagreement. The card goes
    // back to reading its own rows — the pre-existing behaviour, unchanged.
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;
    await service.confirmTriggerScheduleProposal(READER, adjusted.token);

    intents.clear();

    const resolved = await service.resolveProposalForReader(
      original.token,
      READER,
    );
    expect(resolved.phase).toBe("settled");
    if (resolved.phase !== "settled") return;
    expect(resolved.superseded).toBe(false);
    expect(resolved.scheduleCopy).toBe(
      service.describeProposalSchedule(WEEKDAYS_9AM),
    );
  });

  it("an UNSPENT family is still a live proposal from either member", async () => {
    const original = mintLive(WEEKDAYS_9AM);
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: original.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;

    // No Confirm anywhere, so there is no consume row and nothing to diverge
    // from: both cards still ask their own question.
    for (const token of [original.token, adjusted.token]) {
      const resolved = await service.resolveProposalForReader(token, READER);
      expect(resolved.phase).toBe("proposal");
    }
  });
});
