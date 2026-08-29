/**
 * THE EXPIRED CARD RESOLVES, AND ITS CONFIRM LANDS (cinatra#2836).
 *
 * Plan: `PLAN: Agents Lifecycle (A)` §7.2 step 2 — "an expired card **stays
 * visible**, still editable, with **Confirm** to set the schedule again";
 * §7.4 as-designed step 5 — "**End state: expired, and you can set the schedule
 * again from the same card.**" Design `app-lifecycle-cards.html` §IV keeps the
 * undrawn answer for a reader who may not see the subject at all.
 *
 * TWO HALVES, AND THEY ARE DIFFERENT CLAIMS.
 *
 *   THE READING — `resolveProposalForReader` stops collapsing a reader's OWN
 *   expired token into `absent`. Before this, the card and the question it asked
 *   were deleted out of the transcript thirty minutes after it was drawn.
 *
 *   THE PRESS — the expired token is unspendable, so the Confirm on that card
 *   cannot be a bare confirm. It re-proposes from the expired one's selections
 *   and confirms the replacement. `reproposeExpiredSchedule` is that first step,
 *   and the live card's `adjustTriggerSchedule` is deliberately NOT widened to
 *   do it: two named paths, each refusing exactly what it should.
 *
 * AND THE LINEAGE RULE IS UNTOUCHED (cinatra#2859). The replacement inherits the
 * expired proposal's nonce, so the family stays ONE row in the consume table and
 * at most one member can ever become a run. Nothing here can double-arm: the
 * member being replaced was already unspendable.
 *
 * Seam tier: the stores are mocked, the TOKEN IS REAL — the same tier, and the
 * same in-memory consume ledger, `trigger-schedule-proposal-adjust-lineage.test.ts`
 * uses, because which consume identity a mint lands on is decided by real SHA-256
 * over a real decrypted nonce.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

import {
  PROPOSAL_TTL_SECONDS,
  mintTriggerScheduleProposalToken,
  proposalConsumeKey,
  verifyTriggerScheduleProposalTokenDetailed,
  type ProposalSchedule,
} from "@/lib/trigger-schedule-proposal-token";

const ORG = "org_2836_expired";
const USER = "user_2836_reader";
const OTHER_USER = "user_2836_someone_else";
const OTHER_ORG = "org_2836_elsewhere";
const TEMPLATE = "6d2f8a3c-1b4e-4f7a-8c9d-2e5f1a7b3c48";

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

/** What the reader corrects it to before pressing Confirm on the expired card. */
const WEEKDAYS_8AM: ProposalSchedule = {
  ...WEEKDAYS_9AM,
  selection: { ...WEEKDAYS_9AM.selection, hour: 8 },
};

const readAgentTemplateById = vi.fn();
const readProposalConsume = vi.fn();
const readInstallIntent = vi.fn();
const readRunTriggerByRunId = vi.fn();
const assertAgentPackageRunnable = vi.fn();
const createAgentRunPendingInput = vi.fn();
const spendProposalWithinTx = vi.fn();
const claimPendingInstallIntents = vi.fn();

type ConsumeRow = {
  consumeKey: string;
  runId: string;
  orgId: string;
  templateId: string;
  consumedBy: string;
  consumedAt: Date;
};
const ledger = new Map<string, ConsumeRow>();

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

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A proposal whose thirty minutes ran out with nobody pressing anything. */
function mintExpired(
  schedule: ProposalSchedule = WEEKDAYS_9AM,
  who: { userId: string; orgId: string } = { userId: USER, orgId: ORG },
) {
  const minted = mintTriggerScheduleProposalToken(
    { templateId: TEMPLATE, userId: who.userId, orgId: who.orgId, schedule },
    { nowSeconds: nowSeconds() - PROPOSAL_TTL_SECONDS - 60 },
  );
  expect(minted).not.toBeNull();
  return minted!;
}

function mintLive(
  schedule: ProposalSchedule = WEEKDAYS_9AM,
  who: { userId: string; orgId: string } = { userId: USER, orgId: ORG },
) {
  const minted = mintTriggerScheduleProposalToken({
    templateId: TEMPLATE,
    userId: who.userId,
    orgId: who.orgId,
    schedule,
  });
  expect(minted).not.toBeNull();
  return minted!;
}

/** The consume key a token lands on — read back out of the real ciphertext. */
function consumeKeyOf(token: string, who = READER): string {
  const verified = verifyTriggerScheduleProposalTokenDetailed({
    token,
    expectedUserId: who.userId,
    expectedOrgId: who.orgId,
  });
  expect(verified.outcome).not.toBe("refused");
  if (verified.outcome === "refused") throw new Error("unreachable");
  return proposalConsumeKey(verified.proposal.nonce);
}

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
      intents.set(input.runId, { runId: input.runId, ...input.install });
    },
  );
  createAgentRunPendingInput.mockImplementation(
    async (input: {
      orgId: string;
      withinCreateTx?: (tx: unknown, run: { id: string; orgId: string }) => Promise<void>;
    }) => {
      runSeq += 1;
      const run = { id: `run_${runSeq}`, orgId: input.orgId };
      if (input.withinCreateTx) await input.withinCreateTx({}, run);
      committedRuns.push(run.id);
      return run;
    },
  );
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-2836-expired-repropose";
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
// THE READING
// ---------------------------------------------------------------------------

describe("a reader's OWN expired proposal resolves to the expired phase", () => {
  it("resolves `expired` with the schedule read back — not `absent`", async () => {
    const expired = mintExpired();

    const resolved = await service.resolveProposalForReader(expired.token, READER);

    expect(resolved.phase).toBe("expired");
    if (resolved.phase !== "expired") return;
    // The rows the reader last saw, so the card re-opens on their own schedule.
    expect(resolved.proposal.schedule).toEqual(WEEKDAYS_9AM);
    expect(resolved.agentName).toBe("Weekly digest");
    // The floor is still read against the reader, exactly as the live card's is.
    expect(resolved.canConfirm).toBe(true);
    expect(resolved.restrictedReason).toBeNull();
  });

  it("a LIVE proposal still resolves `proposal` — the window is the only difference", async () => {
    const resolved = await service.resolveProposalForReader(mintLive().token, READER);
    expect(resolved.phase).toBe("proposal");
  });

  it("carries the reader's own restriction, not a silent absence, when the agent cannot run", async () => {
    assertAgentPackageRunnable.mockResolvedValue({ error: "needs a connection" });

    const resolved = await service.resolveProposalForReader(mintExpired().token, READER);

    expect(resolved.phase).toBe("expired");
    if (resolved.phase !== "expired") return;
    expect(resolved.canConfirm).toBe(false);
    expect(resolved.restrictedReason).toBe(service.PROPOSAL_REFUSALS.notRunnable);
  });

  it("an expired token whose family already SETTLED is the settled card, not the expired one", async () => {
    // The consume lookup answers before the expiry reading is taken: the run
    // exists and the reader should see it, which is a different card entirely.
    const expired = mintExpired();
    ledger.set(consumeKeyOf(expired.token), {
      consumeKey: consumeKeyOf(expired.token),
      runId: "run_settled",
      orgId: ORG,
      templateId: TEMPLATE,
      consumedBy: USER,
      consumedAt: new Date(),
    });
    intents.set("run_settled", {
      runId: "run_settled",
      triggerType: "recurring",
      scheduledAt: null,
      cronExpression: "0 9 * * 1,2,3,4,5",
      timezone: "Europe/Berlin",
    });

    const resolved = await service.resolveProposalForReader(expired.token, READER);

    expect(resolved.phase).toBe("settled");
    if (resolved.phase !== "settled") return;
    expect(resolved.runId).toBe("run_settled");
  });

  it("an expired token for a VANISHED template is still `absent`, exactly as a live one is", async () => {
    readAgentTemplateById.mockResolvedValue(null);
    expect(
      (await service.resolveProposalForReader(mintExpired().token, READER)).phase,
    ).toBe("absent");
  });
});

describe("an expired proposal that is NOT this reader's stays absent", () => {
  it("expired-foreign and forged are the SAME answer — the resolver reveals nothing", async () => {
    const forged = (() => {
      const raw = Buffer.from(mintLive().token, "base64url");
      raw[raw.length - 1] ^= 0xff;
      return raw.toString("base64url");
    })();

    const answers = await Promise.all(
      [
        mintExpired(WEEKDAYS_9AM, { userId: OTHER_USER, orgId: ORG }).token,
        mintExpired(WEEKDAYS_9AM, { userId: USER, orgId: OTHER_ORG }).token,
        mintLive(WEEKDAYS_9AM, { userId: OTHER_USER, orgId: ORG }).token,
        forged,
        "not-a-token",
        "",
      ].map((ref) => service.resolveProposalForReader(ref, READER)),
    );

    for (const answer of answers) expect(answer).toEqual({ phase: "absent" });
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    // The refusal lands before the template store is ever reached, so not even
    // a read pattern separates the cases.
    expect(readAgentTemplateById).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE PRESS
// ---------------------------------------------------------------------------

describe("Confirm on the expired card re-proposes, then lands", () => {
  it("re-proposes from an expired token — a FRESH token in the SAME lineage", async () => {
    const expired = mintExpired();

    const reproposed = await service.reproposeExpiredSchedule({
      priorToken: expired.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_9AM,
    });

    expect(reproposed.ok).toBe(true);
    if (!reproposed.ok) return;
    // Fresh: its own ciphertext and its own window.
    expect(reproposed.token).not.toBe(expired.token);
    expect(reproposed.expiresAt).toBeGreaterThan(nowSeconds());
    // SAME LINEAGE (cinatra#2859): one row in the consume table, so the family
    // can still only ever produce one run.
    expect(consumeKeyOf(reproposed.token)).toBe(expired.consumeKey);
  });

  it("carries the CORRECTED rows when the reader edited the expired card first", async () => {
    const expired = mintExpired(WEEKDAYS_9AM);

    const reproposed = await service.reproposeExpiredSchedule({
      priorToken: expired.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });

    expect(reproposed.ok).toBe(true);
    if (!reproposed.ok) return;
    const verified = verifyTriggerScheduleProposalTokenDetailed({
      token: reproposed.token,
      expectedUserId: USER,
      expectedOrgId: ORG,
    });
    expect(verified.outcome).toBe("valid");
    if (verified.outcome === "refused") return;
    expect(verified.proposal.schedule).toEqual(WEEKDAYS_8AM);
    // And it can only ever name the template it inherited.
    expect(verified.proposal.templateId).toBe(TEMPLATE);
  });

  it("the full press — re-propose then confirm — creates the run EXACTLY ONCE", async () => {
    const expired = mintExpired();

    const reproposed = await service.reproposeExpiredSchedule({
      priorToken: expired.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_9AM,
    });
    expect(reproposed.ok).toBe(true);
    if (!reproposed.ok) return;

    const confirmed = await service.confirmTriggerScheduleProposal(
      READER,
      reproposed.token,
    );

    expect(confirmed).toEqual({ ok: true, runId: "run_1", alreadyConfirmed: false });
    expect(committedRuns).toEqual(["run_1"]);
    expect(ledger.size).toBe(1);
  });

  it("REPLAY: a second Confirm of the same stated schedule answers 'already confirmed'", async () => {
    // Plan's rule, and the lineage's: the re-proposed expired card compares
    // EQUAL to what was installed, so the retry is the ordinary idempotent
    // answer and never the 'superseded' refusal.
    const expired = mintExpired();
    const reproposed = await service.reproposeExpiredSchedule({
      priorToken: expired.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_9AM,
    });
    expect(reproposed.ok).toBe(true);
    if (!reproposed.ok) return;

    const first = await service.confirmTriggerScheduleProposal(READER, reproposed.token);
    const second = await service.confirmTriggerScheduleProposal(READER, reproposed.token);

    expect(first).toEqual({ ok: true, runId: "run_1", alreadyConfirmed: false });
    expect(second).toEqual({ ok: true, runId: "run_1", alreadyConfirmed: true });
    expect(committedRuns).toEqual(["run_1"]);
  });

  it("and the EXPIRED sibling's own Confirm is still refused — it was never spendable", async () => {
    const expired = mintExpired();
    const reproposed = await service.reproposeExpiredSchedule({
      priorToken: expired.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_9AM,
    });
    expect(reproposed.ok).toBe(true);
    if (!reproposed.ok) return;
    await service.confirmTriggerScheduleProposal(READER, reproposed.token);

    // Confirm keeps the COLLAPSING verify, so an expired token has nothing left
    // to spend regardless of what its lineage did.
    const sibling = await service.confirmTriggerScheduleProposal(READER, expired.token);
    expect(sibling).toEqual({ ok: false, error: service.PROPOSAL_REFUSALS.invalid });
    expect(committedRuns).toEqual(["run_1"]);
  });
});

describe("the expired re-propose refuses anything not owned by the reader", () => {
  it("a foreign, an expired-foreign and a forged ref all refuse — and mint nothing", async () => {
    const forged = (() => {
      const raw = Buffer.from(mintLive().token, "base64url");
      raw[raw.length - 1] ^= 0xff;
      return raw.toString("base64url");
    })();

    for (const ref of [
      mintExpired(WEEKDAYS_9AM, { userId: OTHER_USER, orgId: ORG }).token,
      mintExpired(WEEKDAYS_9AM, { userId: USER, orgId: OTHER_ORG }).token,
      mintLive(WEEKDAYS_9AM, { userId: OTHER_USER, orgId: ORG }).token,
      forged,
      "not-a-token",
      "",
    ]) {
      expect(
        await service.reproposeExpiredSchedule({
          priorToken: ref,
          userId: USER,
          orgId: ORG,
          schedule: WEEKDAYS_8AM,
        }),
      ).toEqual({ ok: false, reason: "ref_refused" });
    }
    // The refusal lands before the template store is ever reached.
    expect(readAgentTemplateById).not.toHaveBeenCalled();
  });

  it("cannot be re-pointed at an agent the reader was never proposed", async () => {
    // The template comes from the VERIFIED prior, so there is no argument left
    // to steer with.
    const expired = mintExpired();
    const reproposed = await service.reproposeExpiredSchedule({
      priorToken: expired.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(reproposed.ok).toBe(true);
    if (!reproposed.ok) return;
    const verified = verifyTriggerScheduleProposalTokenDetailed({
      token: reproposed.token,
      expectedUserId: USER,
      expectedOrgId: ORG,
    });
    if (verified.outcome === "refused") throw new Error("unreachable");
    expect(verified.proposal.templateId).toBe(TEMPLATE);
  });
});

describe("the LIVE card's Adjust is deliberately NOT widened", () => {
  it("still refuses an expired prior — #2836's path is the one that accepts it", async () => {
    // Two named paths. Widening `adjustTriggerSchedule` would have made every
    // one of its callers start accepting a closed window by inheritance.
    const expired = mintExpired();
    expect(
      await service.adjustTriggerSchedule({
        priorToken: expired.token,
        userId: USER,
        orgId: ORG,
        schedule: WEEKDAYS_8AM,
      }),
    ).toEqual({ ok: false, reason: "ref_refused" });
  });

  it("and still adjusts a LIVE prior, in its lineage, exactly as before", async () => {
    const live = mintLive();
    const adjusted = await service.adjustTriggerSchedule({
      priorToken: live.token,
      userId: USER,
      orgId: ORG,
      schedule: WEEKDAYS_8AM,
    });
    expect(adjusted.ok).toBe(true);
    if (!adjusted.ok) return;
    expect(consumeKeyOf(adjusted.token)).toBe(live.consumeKey);
  });
});
