// FILL AND SEND, IN ONE MESSAGE, HONOURED ON THE FIRST ATTEMPT (cinatra#2934,
// lifecycle-b W5c — after the graded picture leg).
//
// THE SHAPE THIS REPRODUCES. The picture leg recorded submit-asking turns that
// came back `This message is not allowed to operate that control. Nothing was
// done.` while the FILL of the same message applied. That combination is itself
// a measurement: the fill's own gates prove the grant was on the frame, verified
// and matched the card and the person; and the runs' rows show no spend, so the
// grant was not consumed either. What was left is the one thing the CALL still
// supplied for itself — the control it named.
//
// THE REPAIR. Which control a message may press is the SERVER'S answer, decided
// at send time from the card's kind and sealed into the grant. The model never
// had a say in it, and an argument whose only correct value the server already
// holds can add no safety — only refusals. So the argument is OPTIONAL: a call
// with the ref alone presses the control this message was granted.
//
// WHAT DOES NOT MOVE, and is asserted here so it cannot: naming a DIFFERENT
// control is still refused; a `fill` grant still presses nothing; and the
// refusal sentence is byte-identical for every one of them, so a genuinely
// unauthorised caller learns exactly as little as before.
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lent-action-fill-and-send";

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
const RUN = "run_1";
const GATE = "gate_1";
const REF = encodeLifecycleGateRef({ runId: RUN, reviewTaskId: GATE })!;

const OWN_CREDENTIAL = {
  actor: { actorType: "human", source: "agent", userId: PERSON.userId, orgId: PERSON.orgId },
  orgId: PERSON.orgId,
  roleHints: { actorOrganizationId: PERSON.orgId, orgRole: "member", platformRole: "member" },
} as unknown as ReviewActorContext;

/** The waiting screen the person is looking at, with its one field. */
const SCREEN_BINDING = {
  kind: "hitl_screen" as const,
  runId: RUN,
  reviewTaskId: GATE,
  screenRef: GATE,
  form: { fieldName: "idea", values: { idea: { title: "" } } },
};

/** The scheduler form, whose button is the person's — it lends only a fill. */
const SCHEDULE_BINDING = {
  kind: "schedule_form" as const,
  runId: RUN,
  reviewTaskId: GATE,
  screenRef: GATE,
  form: { fieldName: "schedule", values: {} },
};

let spent: Set<string>;
let approveScreen: ReturnType<typeof vi.fn>;

/** THE SAME MESSAGE'S OWN FILL — the thing that DID apply on the refused turns. */
const THIS_MESSAGE_FILLED = [
  { ref: REF, values: { idea: { title: "Why cadence beats bursts for blog reach" } } },
];

function deps(over: Record<string, unknown> = {}) {
  return {
    resolve: vi.fn(async () => SCREEN_BINDING),
    resolveActor: vi.fn(async () => OWN_CREDENTIAL),
    consume: vi.fn(async ({ jti }: { jti: string }) => {
      if (spent.has(jti)) return { outcome: "refused" as const };
      spent.add(jti);
      return { outcome: "consumed" as const, messageText: "and send it" };
    }),
    readFills: vi.fn(async () => THIS_MESSAGE_FILLED),
    readAttachments: vi.fn(async () => []),
    buildPayload: vi.fn((input: { values: Record<string, unknown> }) => ({ payload: input.values })),
    approveScreen,
    ...over,
  } as never;
}

function grantFor(over: Record<string, unknown> = {}) {
  const minted = mintLentActionGrant({
    ...PERSON,
    messageId: "msg_1",
    cardRef: REF,
    control: "submit",
    ...over,
  } as never);
  if (!minted) throw new Error("mint failed");
  return minted.grant;
}

function setFrame(grant: string) {
  frame.store = {
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    delegatedActor: {
      delegation: "chat",
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      platformRole: "member",
    },
    lentActionGrant: grant,
  };
}

const said = (r: { structuredContent: Record<string, unknown> }) => r.structuredContent;

beforeEach(() => {
  spent = new Set();
  approveScreen = vi.fn(async () => undefined);
  frame.store = undefined;
});

describe("the message that fills and asks to be sent is honoured on the first attempt", () => {
  it("presses the control THIS MESSAGE was granted when the call names none", async () => {
    setFrame(grantFor());
    const out = await handleLentAction({ ref: REF }, deps());
    expect(said(out).ok).toBe(true);
    expect(said(out)).toMatchObject({ outcome: { kind: "submitted" } });
    expect(approveScreen).toHaveBeenCalledTimes(1);
  });

  it("is the SAME press as naming the granted control explicitly", async () => {
    setFrame(grantFor());
    const named = await handleLentAction({ ref: REF, control: "submit" }, deps());
    expect(said(named)).toEqual(said(await (async () => {
      spent = new Set();
      approveScreen = vi.fn(async () => undefined);
      setFrame(grantFor());
      return handleLentAction({ ref: REF }, deps());
    })()));
  });

  it("still fires AT MOST ONCE — the second call of one grant is refused", async () => {
    setFrame(grantFor());
    const d = deps();
    expect(said(await handleLentAction({ ref: REF }, d)).ok).toBe(true);
    expect(said(await handleLentAction({ ref: REF }, d))).toEqual({
      ok: false,
      message: LENT_ACTION_NO_AUTHORITY,
    });
    expect(approveScreen).toHaveBeenCalledTimes(1);
  });
});

describe("nothing an unauthorised caller could learn has moved", () => {
  it("a call naming ANOTHER control is refused, with the same sentence", async () => {
    setFrame(grantFor());
    const out = await handleLentAction({ ref: REF, control: "approve" }, deps());
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(approveScreen).not.toHaveBeenCalled();
  });

  it("a FILL grant presses nothing, named or not", async () => {
    for (const call of [{ ref: REF }, { ref: REF, control: "submit" as const }]) {
      spent = new Set();
      approveScreen = vi.fn(async () => undefined);
      setFrame(grantFor({ control: "fill" }));
      const out = await handleLentAction(call, deps({ resolve: vi.fn(async () => SCHEDULE_BINDING) }));
      expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
      expect(approveScreen).not.toHaveBeenCalled();
    }
  });

  it("a press with NOTHING filled in this message is still refused", async () => {
    setFrame(grantFor());
    const out = await handleLentAction(
      { ref: REF },
      deps({ readFills: vi.fn(async () => []) }),
    );
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_CARD_UNAVAILABLE });
    expect(approveScreen).not.toHaveBeenCalled();
  });

  it("an unknown argument is still refused — the input stays strict", async () => {
    setFrame(grantFor());
    const out = await handleLentAction(
      { ref: REF, text: "the model's own words" },
      deps(),
    );
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(approveScreen).not.toHaveBeenCalled();
  });
});
