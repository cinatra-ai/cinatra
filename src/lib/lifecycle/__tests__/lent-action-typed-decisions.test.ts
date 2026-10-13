// A TYPED DECISION IS THE PERSON'S DECISION (cinatra#2853) — acceptance items
// 1, 2 and 4, at the HANDLER.
//
// Plan (B) §4: "Using the action is pressing the button. Same identity, same
// permissions, same recorded decision, same one-time effect."
//
// Plan (B) §4: "the assistant's model … cannot decide, confirm, resume or arm
// anything" except through this one grant — "signed, single-use, naming the
// person, the message, the card and the one control it allows".
//
// So every case below proves ONE of two things: that the typed road reaches the
// SAME server-side entry the card's own button reaches, with the person's own
// credential; or that a control the person's own message never named cannot be
// pressed, whatever the model calls with.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-typed-decisions";

const frame: { store: Record<string, unknown> | undefined } = { store: undefined };

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => frame.store },
}));
vi.mock("@cinatra-ai/agents/review-task-actions", () => ({
  approveReviewTaskInternal: vi.fn(),
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions",
  () => ({ submitReviewDecisionAction: vi.fn() }),
);
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readLatestDurableHitlGateArtifact: vi.fn(),
  readAgentRunById: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/db", () => ({ agentBuilderPool: { query: vi.fn() } }));

import { encodeLifecycleGateRef } from "../lifecycle-card-ref";
import { mintLentActionGrant } from "../lent-action-grant";
import {
  LENT_ACTION_CARD_UNAVAILABLE,
  LENT_ACTION_NO_AUTHORITY,
  handleLentAction,
} from "../lent-action-mcp";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const REF = encodeLifecycleGateRef({ runId: "run_1", reviewTaskId: "gate_1" })!;

const OWN_CREDENTIAL = {
  actor: { actorType: "human", source: "agent", userId: PERSON.userId, orgId: PERSON.orgId },
  orgId: PERSON.orgId,
  roleHints: { actorOrganizationId: PERSON.orgId, orgRole: "member", platformRole: "member" },
} as unknown as ReviewActorContext;

const REVIEW = {
  kind: "review" as const,
  runId: "run_1",
  reviewTaskId: "gate_1",
  pinnedTargets: [{ artifactId: "art_1", representationRevisionId: "rev_1" }],
};
const HOLD = {
  kind: "recommendation_hold" as const,
  runId: "run_h",
  holdRef: "hold_ref_1",
  agentPackageName: "pkg",
  offered: [
    { skillId: "sk_research", name: "Research" },
    { skillId: "sk_style", name: "House style" },
  ],
};
const PROPOSAL = {
  kind: "schedule_proposal" as const,
  ref: "prop_ref_1",
  runId: null,
  summary: "every weekday at 09:00",
  expired: false,
};

/** What the person actually typed, as the mint stored it with the grant. */
let personWords: string;
let spent: Set<string>;
let submitReviewDecision: ReturnType<typeof vi.fn>;
let confirmHold: ReturnType<typeof vi.fn>;
let skipHold: ReturnType<typeof vi.fn>;
let writeSelection: ReturnType<typeof vi.fn>;
let dispatchRunStart: ReturnType<typeof vi.fn>;
let decideSchedule: ReturnType<typeof vi.fn>;

function deps(bound: unknown, over: Record<string, unknown> = {}) {
  return {
    resolve: vi.fn(async () => bound),
    resolveActor: vi.fn(async () => OWN_CREDENTIAL),
    consume: vi.fn(async ({ jti }: { jti: string }) => {
      if (spent.has(jti)) return { outcome: "refused" as const };
      spent.add(jti);
      return { outcome: "consumed" as const, messageText: personWords };
    }),
    submitReviewDecision,
    confirmHold,
    skipHold,
    writeSelection,
    dispatchRunStart,
    decideSchedule,
    ...over,
  } as never;
}

function grantFor(over: { controls?: string[] } = {}) {
  // The ANCHOR is the menu's first entry, exactly as the send mints it.
  const controls = over.controls ?? ["comment"];
  const minted = mintLentActionGrant({
    ...PERSON,
    messageId: "msg_1",
    cardRef: REF,
    control: controls[0],
    controls,
  } as never);
  if (!minted) throw new Error("mint failed");
  return minted.grant;
}

function setFrame(grant: string | undefined) {
  frame.store = {
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    ...(grant ? { lentActionGrant: grant } : {}),
  };
}

beforeEach(() => {
  spent = new Set();
  personWords = "approve it";
  submitReviewDecision = vi.fn(async () => ({ kind: "decided", disposition: "approve" }));
  confirmHold = vi.fn(async () => ({ ok: true, dispatched: true }));
  skipHold = vi.fn(async () => ({ ok: true, dispatched: true }));
  writeSelection = vi.fn(async () => ({ ok: true }));
  dispatchRunStart = vi.fn(async () => ({ ok: true }));
  decideSchedule = vi.fn(async () => ({ kind: "confirmed", runId: "run_s", alreadyConfirmed: false }));
});

// -------------------------------------------------------------------------
// Acceptance item 1 — typed approve / reject / comment on the review card.
// -------------------------------------------------------------------------

describe("the review card's three buttons, typed", () => {
  it("a typed approve presses the SAME decision action the Approve button presses", async () => {
    setFrame(grantFor({ controls: ["comment", "approve"] }));
    const out = await handleLentAction({ ref: REF, control: "approve" }, deps(REVIEW));
    expect(submitReviewDecision).toHaveBeenCalledTimes(1);
    expect(submitReviewDecision.mock.calls[0]![0]).toBe("run_1");
    expect(submitReviewDecision.mock.calls[0]![1]).toBe("gate_1");
    expect(submitReviewDecision.mock.calls[0]![2]).toBe("approve");
    // The person's OWN words ride the decision as its reason; the model
    // supplies no text at all.
    expect(submitReviewDecision.mock.calls[0]![3]).toBe("approve it");
    // The person's OWN credential, never the delegated chat token.
    expect(submitReviewDecision.mock.calls[0]![4]).toBe(OWN_CREDENTIAL);
    expect(out.structuredContent).toMatchObject({ ok: true });
  });

  it("spends the ledger row on the grant's ANCHOR, whichever button of the menu runs", async () => {
    // The row records one control. Spending it on the PRESSED control would make
    // every menu of more than one control unspendable; the pressed control is
    // authorized by the signed menu one gate earlier.
    setFrame(grantFor({ controls: ["comment", "approve"] }));
    const d = deps(REVIEW) as unknown as { consume: ReturnType<typeof vi.fn> };
    await handleLentAction({ ref: REF, control: "approve" }, d as never);
    expect(d.consume.mock.calls[0]![0]).toMatchObject({ control: "comment" });
  });

  it("a typed reject presses the same action with the reject disposition", async () => {
    personWords = "reject it, the numbers are wrong";
    setFrame(grantFor({ controls: ["comment", "reject"] }));
    await handleLentAction({ ref: REF, control: "reject" }, deps(REVIEW));
    expect(submitReviewDecision.mock.calls[0]![2]).toBe("reject");
  });

  it("relays the card's own refusal rather than writing one of its own", async () => {
    submitReviewDecision = vi.fn(async () => ({ kind: "not-permitted", message: "no" }));
    setFrame(grantFor({ controls: ["comment", "approve"] }));
    const out = await handleLentAction({ ref: REF, control: "approve" }, deps(REVIEW));
    expect(out.structuredContent).toMatchObject({ ok: false, outcome: { kind: "not-permitted" } });
  });
});

// -------------------------------------------------------------------------
// Acceptance item 4 — the assistant cannot press what the person did not name.
// -------------------------------------------------------------------------

describe("a control the person's own message never named is not pressable", () => {
  it("refuses an approve on a grant whose menu holds only comment", async () => {
    personWords = "the second paragraph overstates the result";
    setFrame(grantFor({ controls: ["comment"] }));
    const out = await handleLentAction({ ref: REF, control: "approve" }, deps(REVIEW));
    expect(out.structuredContent).toMatchObject({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("refuses a confirm on a skills card when the turn holds no grant at all", async () => {
    setFrame(undefined);
    const out = await handleLentAction({ ref: REF, control: "confirm" }, deps(HOLD));
    expect(out.structuredContent).toMatchObject({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(confirmHold).not.toHaveBeenCalled();
  });

  it("still fires at most once per message", async () => {
    setFrame(grantFor({ controls: ["comment", "approve"] }));
    const d = deps(REVIEW);
    await handleLentAction({ ref: REF, control: "approve" }, d);
    const second = await handleLentAction({ ref: REF, control: "approve" }, d);
    expect(submitReviewDecision).toHaveBeenCalledTimes(1);
    expect(second.structuredContent).toMatchObject({ message: LENT_ACTION_NO_AUTHORITY });
  });
});

// -------------------------------------------------------------------------
// Acceptance item 2 — the skills card and the schedule card.
// -------------------------------------------------------------------------

describe("the skills card, typed", () => {
  it("a typed keep/drop + confirm reaches the SAME hold core the Confirm button reaches", async () => {
    personWords = "drop the research skill and confirm";
    setFrame(grantFor({ controls: ["confirm"] }));
    const out = await handleLentAction(
      { ref: REF, control: "confirm", keep: ["sk_style"] },
      deps(HOLD),
    );
    expect(confirmHold).toHaveBeenCalledTimes(1);
    const call = confirmHold.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.runId).toBe("run_h");
    expect(call.confirmedSkillIds).toEqual(["sk_style"]);
    expect(call.holdRef).toBe("hold_ref_1");
    expect((call.who as { actor: unknown }).actor).toBe(OWN_CREDENTIAL.actor);
    expect(out.structuredContent).toMatchObject({ ok: true });
  });

  it("REFUSES a kept id the card never offered — never a silent drop", async () => {
    // convergence round 1, finding 3. Filtering it away quietly turned "keep the
    // SEO skill" into "keep nothing" and confirmed THAT, which is a decision
    // nobody made.
    personWords = "keep only the seo skill and confirm";
    setFrame(grantFor({ controls: ["confirm"] }));
    const out = await handleLentAction(
      { ref: REF, control: "confirm", keep: ["sk_seo"] },
      deps(HOLD),
    );
    expect(out.structuredContent).toMatchObject({ message: LENT_ACTION_CARD_UNAVAILABLE });
    expect(confirmHold).not.toHaveBeenCalled();
  });

  it("REFUSES an EMPTY kept set — that is the card's Skip, not its Confirm", async () => {
    // convergence round 2, finding 3. Omitting `keep` is "keep everything", the
    // press of Confirm with no chip touched. An empty ARRAY is a value the model
    // supplied that settles the hold keeping nothing, which is a different
    // button and a decision the person's word "confirm" never carried.
    personWords = "confirm";
    setFrame(grantFor({ controls: ["confirm"] }));
    const out = await handleLentAction({ ref: REF, control: "confirm", keep: [] }, deps(HOLD));
    expect(out.structuredContent).toMatchObject({ message: LENT_ACTION_CARD_UNAVAILABLE });
    expect(confirmHold).not.toHaveBeenCalled();
  });

  it("a plain typed confirm keeps everything the card offered", async () => {
    personWords = "confirm";
    setFrame(grantFor({ controls: ["confirm"] }));
    await handleLentAction({ ref: REF, control: "confirm" }, deps(HOLD));
    const call = confirmHold.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.confirmedSkillIds).toEqual(["sk_research", "sk_style"]);
  });

  it("a typed skip reaches the SAME skip core the Skip button reaches", async () => {
    personWords = "skip the skills";
    setFrame(grantFor({ controls: ["skip"] }));
    await handleLentAction({ ref: REF, control: "skip" }, deps(HOLD));
    expect(skipHold).toHaveBeenCalledTimes(1);
    expect((skipHold.mock.calls[0]![0] as { runId: string }).runId).toBe("run_h");
    expect(confirmHold).not.toHaveBeenCalled();
  });
});

describe("the schedule card, typed", () => {
  it("a typed adjust re-proposes through the card's OWN adjust op and arms nothing", async () => {
    personWords = "make it 8 in the morning on weekdays";
    decideSchedule = vi.fn(async () => ({ kind: "reproposed", ref: "prop_ref_2", expiresAt: 1 }));
    setFrame(grantFor({ controls: ["adjust"] }));
    const out = await handleLentAction(
      { ref: REF, control: "adjust", schedule: { mode: "recurring", time: "08:00" } },
      deps(PROPOSAL),
    );
    expect(decideSchedule).toHaveBeenCalledTimes(1);
    const call = decideSchedule.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.op).toBe("adjust");
    expect(call.ref).toBe("prop_ref_1");
    expect(call.schedule).toEqual({ mode: "recurring", time: "08:00" });
    expect(call.userId).toBe(PERSON.userId);
    expect(out.structuredContent).toMatchObject({ ok: true, outcome: { kind: "reproposed" } });
  });

  it("REFUSES a confirm that carries a schedule — one spend is one control", async () => {
    // convergence round 1, finding 2. An adjust mints a NEW card ref, so a
    // confirm carrying an adjustment would arm rows the person never saw,
    // against a ref that was never fingerprinted into the grant.
    personWords = "make it 8 in the morning on weekdays and confirm";
    setFrame(grantFor({ controls: ["adjust", "confirm"] }));
    const out = await handleLentAction(
      { ref: REF, control: "confirm", schedule: { mode: "recurring", time: "08:00" } },
      deps(PROPOSAL),
    );
    expect(out.structuredContent).toMatchObject({ message: LENT_ACTION_CARD_UNAVAILABLE });
    expect(decideSchedule).not.toHaveBeenCalled();
  });

  it("REFUSES an adjust with nothing to place", async () => {
    personWords = "change the schedule";
    setFrame(grantFor({ controls: ["adjust"] }));
    const out = await handleLentAction({ ref: REF, control: "adjust" }, deps(PROPOSAL));
    expect(out.structuredContent).toMatchObject({ message: LENT_ACTION_CARD_UNAVAILABLE });
    expect(decideSchedule).not.toHaveBeenCalled();
  });

  it("a plain typed confirm confirms the card as it stands", async () => {
    personWords = "confirm it";
    setFrame(grantFor({ controls: ["adjust", "confirm"] }));
    await handleLentAction({ ref: REF, control: "confirm" }, deps(PROPOSAL));
    expect(decideSchedule).toHaveBeenCalledTimes(1);
    expect((decideSchedule.mock.calls[0]![0] as { op: string }).op).toBe("confirm");
  });

  it("a card that resolved absent is refused even with a live grant", async () => {
    setFrame(grantFor({ controls: ["adjust", "confirm"] }));
    const out = await handleLentAction(
      { ref: REF, control: "confirm" },
      deps({ kind: "absent" }),
    );
    expect(out.structuredContent).toMatchObject({ message: LENT_ACTION_CARD_UNAVAILABLE });
    expect(decideSchedule).not.toHaveBeenCalled();
  });
});
