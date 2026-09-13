// THE LENT ACTION, END TO END THROUGH ITS SIX GATES (cinatra#2932,
// lifecycle-b W5a) — acceptance items 1, 2, 3 and 4.
//
//   1. "The lent action works only with the grant minted for that message and
//      card."
//   2. "A grant is consumed by its first use."
//   3. "A replayed or foreign grant, or one presented with another control, is
//      refused."
//   4. "The action fires at most once per message and records the same actor,
//      permissions and audit entry as pressing the button, with an audit-actor
//      fixture per host."
//
// The REAL handler runs. What is substituted is the world under it — the
// resolver's rows, the ledger, the standing lookup and the card's own decision
// path — so what these cases prove is the ORDER of the gates and WHICH actor the
// card's path is handed, which is the whole of items 1–4.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lent-action-mcp";

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
  LENT_ACTION_PRIMITIVE,
  handleLentAction,
} from "../lent-action-mcp";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const RUN = "run_1";
const GATE = "gate_1";
const REF = encodeLifecycleGateRef({ runId: RUN, reviewTaskId: GATE })!;
const OTHER_REF = encodeLifecycleGateRef({ runId: "run_2", reviewTaskId: "gate_2" })!;

/** The person's OWN credential, as the bound-turn actor resolves it — team and
 *  project axes present, which is exactly what the delegated chat token lacks. */
const OWN_CREDENTIAL = {
  actor: { actorType: "human", source: "agent", userId: PERSON.userId, orgId: PERSON.orgId },
  orgId: PERSON.orgId,
  roleHints: {
    actorOrganizationId: PERSON.orgId,
    orgRole: "member",
    platformRole: "member",
    teamIds: ["team_a"],
    projectGrants: [{ projectId: "prj_1", effectiveRole: "write", accessSource: "user" }],
  },
} as unknown as ReviewActorContext;

const REVIEW_BINDING = {
  kind: "review" as const,
  runId: RUN,
  reviewTaskId: GATE,
  pinnedTargets: [{ artifactId: "art_1", representationRevisionId: "rev_1" }],
};

/** What the person actually typed, as the mint stored it with the grant. */
const PERSON_WORDS = "tighten the opening paragraph";

let spent: Set<string>;
let submitReviewDecision: ReturnType<typeof vi.fn>;
let approveScreen: ReturnType<typeof vi.fn>;

function deps(over: Record<string, unknown> = {}) {
  return {
    resolve: vi.fn(async () => REVIEW_BINDING),
    resolveActor: vi.fn(async () => OWN_CREDENTIAL),
    consume: vi.fn(async ({ jti }: { jti: string }) => {
      if (spent.has(jti)) return { outcome: "refused" as const };
      spent.add(jti);
      // The row carries the PERSON'S words; the handler must place THESE and
      // never anything the model supplied (convergence round 1, finding 2).
      return { outcome: "consumed" as const, messageText: PERSON_WORDS };
    }),
    submitReviewDecision,
    approveScreen,
    ...over,
  } as never;
}

function grantFor(over: Record<string, unknown> = {}) {
  const minted = mintLentActionGrant({
    ...PERSON,
    messageId: "msg_1",
    cardRef: REF,
    control: "comment",
    ...over,
  } as never);
  if (!minted) throw new Error("mint failed");
  return minted.grant;
}

function setFrame(grant: string | undefined, over: Record<string, unknown> = {}) {
  frame.store = {
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    delegatedActor: { delegation: "chat", userId: PERSON.userId, orgId: PERSON.orgId, platformRole: "member" },
    ...(grant ? { lentActionGrant: grant } : {}),
    ...over,
  };
}

function said(result: { structuredContent: Record<string, unknown> }) {
  return result.structuredContent;
}

beforeEach(() => {
  spent = new Set();
  submitReviewDecision = vi.fn(async () => ({ kind: "annotated" }));
  approveScreen = vi.fn(async () => undefined);
  frame.store = undefined;
});

describe("the name declares the class it belongs to", () => {
  it("carries the `decide` token, so the policy backstop denies it by construction", () => {
    expect(LENT_ACTION_PRIMITIVE.split("_")).toContain("decide");
  });
});

describe("GATE 1 — a visible tool is not permission", () => {
  it("refuses with NO grant on the frame — item 1", async () => {
    setFrame(undefined);
    const d = deps();
    const out = await handleLentAction({ ref: REF, control: "comment" }, d);
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("refuses with NO frame at all", async () => {
    frame.store = undefined;
    const out = await handleLentAction({ ref: REF, control: "comment" }, deps());
    expect(said(out).ok).toBe(false);
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });
});

describe("GATE 2/3 — the grant must be ours, and must be THIS call's", () => {
  it("refuses a forged grant", async () => {
    setFrame("not-a-grant");
    await handleLentAction({ ref: REF, control: "comment" }, deps());
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("refuses a grant minted for ANOTHER CARD — item 3", async () => {
    setFrame(grantFor({ cardRef: OTHER_REF }));
    const out = await handleLentAction({ ref: REF, control: "comment" }, deps());
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("refuses a grant presented with ANOTHER CONTROL — item 3", async () => {
    setFrame(grantFor({ control: "comment" }));
    const out = await handleLentAction({ ref: REF, control: "approve" }, deps());
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("refuses a FOREIGN grant — one minted for somebody else — item 3", async () => {
    setFrame(grantFor({ userId: "usr_2" }));
    const out = await handleLentAction({ ref: REF, control: "comment" }, deps());
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("every refusal is the SAME sentence — no oracle", async () => {
    const cases = [
      undefined,
      "not-a-grant",
      grantFor({ cardRef: OTHER_REF }),
      grantFor({ userId: "usr_2" }),
    ];
    const messages = new Set<string>();
    for (const g of cases) {
      setFrame(g);
      const out = await handleLentAction({ ref: REF, control: "comment" }, deps());
      messages.add(String(said(out).message));
    }
    expect([...messages]).toEqual([LENT_ACTION_NO_AUTHORITY]);
  });
});

describe("GATE 4 — the person's OWN credential, never the delegated chat token", () => {
  it("hands the card's path the live-resolved actor with its team and project axes", async () => {
    setFrame(grantFor());
    const d = deps();
    await handleLentAction({ ref: REF, control: "comment" }, d);
    expect(submitReviewDecision).toHaveBeenCalledTimes(1);
    const passedActor = submitReviewDecision.mock.calls[0][4];
    expect(passedActor).toBe(OWN_CREDENTIAL);
    expect(passedActor.roleHints.teamIds).toEqual(["team_a"]);
    expect(passedActor.roleHints.projectGrants).toHaveLength(1);
  });

  it("refuses when the person has no live standing in the org", async () => {
    setFrame(grantFor());
    const out = await handleLentAction(
      { ref: REF, control: "comment" },
      deps({ resolveActor: vi.fn(async () => null) }),
    );
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_CARD_UNAVAILABLE });
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });
});

describe("GATE 5 — a card that offers no decision lends none", () => {
  it("refuses when the bound reference resolves to nothing", async () => {
    setFrame(grantFor());
    const out = await handleLentAction(
      { ref: REF, control: "comment" },
      deps({ resolve: vi.fn(async () => ({ kind: "absent" })) }),
    );
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_CARD_UNAVAILABLE });
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("refuses a control the card does not offer, even with a valid grant", async () => {
    // A HITL screen lends Submit and nothing else; a grant naming Continue is
    // well-formed and still buys nothing here.
    setFrame(grantFor({ control: "continue" }));
    const out = await handleLentAction(
      { ref: REF, control: "continue" },
      deps({
        resolve: vi.fn(async () => ({
          kind: "hitl_screen",
          runId: RUN,
          screenRef: GATE,
          xRenderer: "setup-field",
          form: { schema: {}, values: {} },
        })),
      }),
    );
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_CARD_UNAVAILABLE });
    expect(approveScreen).not.toHaveBeenCalled();
  });
});

describe("GATE 6 — consumed by its first use, and at most once per message", () => {
  it("the second attempt in the SAME message is refused — items 2 and 4", async () => {
    const grant = grantFor();
    setFrame(grant);
    const d = deps();
    const first = await handleLentAction({ ref: REF, control: "comment" }, d);
    const second = await handleLentAction({ ref: REF, control: "comment" }, d);
    expect(said(first).ok).toBe(true);
    expect(said(second)).toEqual({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(submitReviewDecision).toHaveBeenCalledTimes(1);
  });

  it("the spend NAMES the card and the control the call asked for", async () => {
    // Defence in depth beneath the signature check (convergence round 1): the ledger
    // row itself refuses a grant spent for anything other than what it names.
    setFrame(grantFor());
    const d = deps();
    await handleLentAction({ ref: REF, control: "comment" }, d);
    const consumeMock = (d as unknown as { consume: { mock: { calls: unknown[][] } } }).consume;
    expect(consumeMock.mock.calls[0][0]).toMatchObject({
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      control: "comment",
    });
    expect(
      (consumeMock.mock.calls[0][0] as { cardRefFingerprint: string }).cardRefFingerprint,
    ).toEqual(expect.any(String));
  });

  it("the grant is spent BEFORE the effect — a failing effect does not refund it", async () => {
    setFrame(grantFor());
    const d = deps({
      submitReviewDecision: vi.fn(async () => {
        throw new Error("decision core exploded");
      }),
    });
    await expect(
      handleLentAction({ ref: REF, control: "comment" }, d),
    ).rejects.toThrow();
    expect(spent.size).toBe(1);
  });

  it("a ledger that refuses the spend does NOT press the button", async () => {
    setFrame(grantFor());
    const out = await handleLentAction(
      { ref: REF, control: "comment" },
      deps({ consume: vi.fn(async () => ({ outcome: "refused" })) }),
    );
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });
});

describe("using the action IS pressing the button", () => {
  it("the review card's three buttons run the card's OWN decision path", async () => {
    // cinatra#3080 — the three are Comment, Regenerate and Continue, and the
    // control the grant names IS the floor action the one decision entry
    // receives: the grant vocabulary and the floor are the same three words.
    for (const control of ["comment", "regenerate", "continue"] as const) {
      submitReviewDecision = vi.fn(async () => ({ kind: "annotated" }));
      spent = new Set();
      setFrame(grantFor({ control, messageId: `msg-${control}` }));
      await handleLentAction({ ref: REF, control }, deps());
      expect(submitReviewDecision).toHaveBeenCalledWith(
        RUN,
        GATE,
        control,
        PERSON_WORDS,
        OWN_CREDENTIAL,
        null,
      );
    }
  });

  it("the typed words land VERBATIM — and they come from the ROW, not the model", async () => {
    // convergence round 1, finding 2. The tool takes no text argument at all, so a
    // model that wanted to author the comment has no channel for it; what lands
    // is what the mint captured from the person's own message.
    setFrame(grantFor());
    await handleLentAction({ ref: REF, control: "comment" }, deps());
    expect(submitReviewDecision.mock.calls[0][3]).toBe(PERSON_WORDS);
  });

  it("the tool REFUSES an argument that tries to carry text — the schema is strict", async () => {
    setFrame(grantFor());
    const out = await handleLentAction(
      { ref: REF, control: "comment", text: "words the model made up" } as never,
      deps(),
    );
    expect(said(out)).toEqual({ ok: false, message: LENT_ACTION_NO_AUTHORITY });
    expect(submitReviewDecision).not.toHaveBeenCalled();
  });

  it("a grant whose row carried no text lands NOTHING, never an invention", async () => {
    setFrame(grantFor());
    await handleLentAction(
      { ref: REF, control: "comment" },
      deps({
        consume: vi.fn(async () => ({ outcome: "consumed", messageText: null })),
      }),
    );
    expect(submitReviewDecision.mock.calls[0][3]).toBeNull();
  });

  it("the platform's OWN outcome is relayed, and nothing is added to it", async () => {
    submitReviewDecision = vi.fn(async () => ({
      kind: "blocked",
      reason: "gate-moved",
    }));
    setFrame(grantFor());
    const out = await handleLentAction({ ref: REF, control: "comment" }, deps());
    expect(said(out).outcome).toEqual({ kind: "blocked", reason: "gate-moved" });
  });

  it("the HITL screen's Continue runs the gate's OWN actor-checked resume entry", async () => {
    setFrame(grantFor({ control: "submit" }));
    const out = await handleLentAction(
      { ref: REF, control: "submit" },
      deps({
        resolve: vi.fn(async () => ({
          kind: "hitl_screen",
          runId: RUN,
          screenRef: GATE,
          xRenderer: "setup-field",
          form: { schema: {}, values: { url: "x" }, fieldName: "url" },
        })),
      }),
    );
    expect(said(out).ok).toBe(true);
    expect(approveScreen).toHaveBeenCalledWith(
      GATE,
      PERSON.userId,
      undefined,
      "url",
      null,
      OWN_CREDENTIAL.actor,
      OWN_CREDENTIAL.roleHints,
    );
  });
});

describe("the audit actor is the PERSON, on every host", () => {
  // "records the same actor, permissions and audit entry as pressing the button,
  // with an audit-actor fixture per host" (item 4). The audit row is written by
  // the decision core, from the actor context it is handed — so the fixture that
  // settles the claim is WHICH actor reaches it, per host.
  for (const host of [
    {
      name: "the chat page (cookie session behind a chat OBO frame)",
      frame: { delegation: "chat", userId: PERSON.userId, orgId: PERSON.orgId, platformRole: "member" },
    },
    {
      name: "a third-party application (the widget's own credential)",
      frame: {
        delegation: "public_site_widget",
        userId: PERSON.userId,
        orgId: PERSON.orgId,
        instanceId: "inst_1",
        kind: "wordpress",
        jti: "j",
        platformRole: "member",
        lifecycleRead: true,
      },
    },
  ]) {
    it(`${host.name}: the card's path is handed the person's own credential`, async () => {
      setFrame(grantFor({ messageId: `msg-${host.frame.delegation}` }), {
        delegatedActor: host.frame,
      });
      const d = deps();
      await handleLentAction({ ref: REF, control: "comment" }, d);
      expect(submitReviewDecision).toHaveBeenCalledTimes(1);
      const passed = submitReviewDecision.mock.calls[0][4];
      expect(passed.actor.userId).toBe(PERSON.userId);
      expect(passed.orgId).toBe(PERSON.orgId);
      // The delegated actor is the TRANSPORT and never reaches the decision.
      expect(passed).not.toHaveProperty("delegation");
    });
  }
});
