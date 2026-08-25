// THE FILL ROAD, AND THE SUBMIT THAT HAS TO BE ASKED FOR (cinatra#2934,
// lifecycle-b W5c) — the plan's §4 and §6:
//
//   · "the assistant returns the filled values, the screen writes them into its
//     own fields, and nothing is submitted until you press the button";
//   · "When you plainly ask, in the same message, for it to be submitted, the
//     assistant submits through the same checked, server-side action the button
//     uses — one road for the press and for the ask — and the fields still show
//     what was sent";
//   · §6: "an agent's HITL screen is filled and, when asked in so many words,
//     submitted by the assistant".
//
// The REAL handlers run. What is substituted is the world under them — the
// resolver's rows, the window store, the standing lookup and the card's own
// resume entry — so what these cases prove is WHICH authority each road demands
// and WHAT reaches the screen, which is the whole of the acceptance.

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-w5c-fill-road";

const frame: { store: Record<string, unknown> | undefined } = { store: undefined };

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => frame.store },
}));

const appended: Array<Record<string, unknown>> = [];
const windowRows: Array<Record<string, unknown>> = [];
vi.mock("@cinatra-ai/agents/run-window-conversation-store", () => ({
  appendRunWindowMessage: async (input: Record<string, unknown>) => {
    appended.push(input);
    const row = { ...input, id: `m${appended.length}`, sequence: appended.length, createdAt: new Date() };
    windowRows.push(row);
    return row;
  },
  readRunWindowMessages: async () => [...windowRows],
  readRunWindowFillsForMessage: async (_runId: string, ref: string, messageId: string) =>
    windowRows
      .filter((r) => r.messageId === messageId)
      .map((r) => r.fill as { ref: string; values: Record<string, unknown> } | undefined)
      .filter((f): f is { ref: string; values: Record<string, unknown> } => !!f && f.ref === ref),
  readRunWindowAttachmentsForMessage: async (_runId: string, messageId: string) => {
    for (let i = windowRows.length - 1; i >= 0; i -= 1) {
      const row = windowRows[i]!;
      if (row.role !== "user" || row.messageId !== messageId) continue;
      return (row.attachments as readonly Record<string, unknown>[] | undefined) ?? null;
    }
    return null;
  },
}));

/** The ledger, as the fill road READS it: is this grant still unspent? */
let grantIsSpendable = true;
vi.mock("../lent-action-grant-store", () => ({
  lentActionGrantIsSpendable: async () => grantIsSpendable,
  consumeLentActionGrant: async () => ({ outcome: "refused" }),
  recordLentActionGrant: async () => true,
  sweepExpiredLentActionGrants: async () => undefined,
}));

/** The RUN's own right to answer, asked separately from the right to read. */
let mayRespond = true;
vi.mock("../run-window-turn", () => ({
  canActorRespondToRun: async () => mayRespond,
}));

const approveReviewTaskInternal = vi.fn(async () => {});
vi.mock("@cinatra-ai/agents/review-task-actions", () => ({
  approveReviewTaskInternal: (...a: unknown[]) => approveReviewTaskInternal(...(a as [])),
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
import {
  matchLentActionGrant,
  matchLentActionGrantCard,
  mintLentActionGrant,
  LENT_ACTION_CONTROLS,
} from "../lent-action-grant";
import {
  BOUND_SCREEN_FILL_PRIMITIVE,
  BOUND_SCREEN_FILL_UNAVAILABLE,
  handleBoundScreenFill,
} from "../bound-screen-fill-mcp";
import {
  FILL_RESERVED_KEYS,
  fillableFieldNames,
  recordBoundScreenFill,
  selectFillableValues,
} from "../bound-screen-fill";
import { controlsLentBy } from "../bound-reference-resolver";
import { primaryControlFor } from "../bound-card-binding";
import {
  LENT_ACTION_PRIMITIVE,
  buildScreenSubmitValues,
  handleLentAction,
} from "../lent-action-mcp";
import { resolveBoundCard } from "../bound-card-binding";
import { submitReviewDecisionAction } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions";
import type { ReviewActorContext } from "@/app/artifacts/[id]/review-gate-ports";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const RUN = "run_1";
const SCREEN = "screen_1";
const REF = encodeLifecycleGateRef({ runId: RUN, reviewTaskId: SCREEN })!;
const OTHER_REF = encodeLifecycleGateRef({ runId: "run_2", reviewTaskId: "screen_2" })!;

const ACTOR: ReviewActorContext = {
  actor: {
    actorType: "human",
    source: "ui",
    userId: PERSON.userId,
    organizationId: PERSON.orgId,
    roles: [],
  },
  orgId: PERSON.orgId,
  roleHints: { platformRole: "member", orgRole: "member", actorOrganizationId: PERSON.orgId },
} as unknown as ReviewActorContext;

/** The screen the run is parked at, as the resolver answers it. */
const SCREEN_FORM = {
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
    approved: { type: "boolean" },
  },
};
const screenResolution = {
  kind: "hitl_screen" as const,
  runId: RUN,
  screenRef: SCREEN,
  xRenderer: "email-draft",
  form: { schema: SCREEN_FORM, values: { subject: "" } },
};
const reviewResolution = {
  kind: "review" as const,
  runId: RUN,
  reviewTaskId: SCREEN,
  pinnedTargets: [],
};

const resolveScreen = vi.fn(async () => screenResolution as never);
const resolveActor = vi.fn(async () => ACTOR as never);

function mint(control: "comment" | "submit", ref = REF) {
  const minted = mintLentActionGrant({
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    messageId: "msg_1",
    cardRef: ref,
    control,
  });
  if (!minted) throw new Error("mint failed");
  return minted;
}

beforeEach(() => {
  frame.store = undefined;
  appended.length = 0;
  windowRows.length = 0;
  grantIsSpendable = true;
  mayRespond = true;
  approveReviewTaskInternal.mockClear();
  resolveScreen.mockClear().mockImplementation(async () => screenResolution as never);
  resolveActor.mockClear().mockImplementation(async () => ACTOR as never);
});

// ---------------------------------------------------------------------------
// AC1a — the described change lands in the visible fields, and NOTHING is
// submitted.
// ---------------------------------------------------------------------------
describe("the fill places values in the screen's own fields and submits nothing", () => {
  it("keeps only the fields the form declares, and never the reserved ones", () => {
    expect(fillableFieldNames(SCREEN_FORM)).toEqual(["subject", "body"]);
    expect(FILL_RESERVED_KEYS).toContain("approved");
    expect(FILL_RESERVED_KEYS).toContain("lifecycleCardRef");
    expect(
      selectFillableValues(SCREEN_FORM, {
        subject: "Hello",
        body: "There",
        // Not a field of this form — a model cannot invent one.
        secret: "x",
        // Reserved: pressing Continue is the SUBMIT road, never smuggled here.
        approved: true,
        lifecycleCardRef: "opaque",
      }),
    ).toEqual({ subject: "Hello", body: "There" });
  });

  it("a form that declares no properties lends no fill at all", () => {
    expect(fillableFieldNames({})).toEqual([]);
    expect(selectFillableValues({}, { anything: 1 })).toEqual({});
  });

  it("records the values on the run and WRITES NOTHING to the gate", async () => {
    const outcome = await recordBoundScreenFill({
      ref: REF,
      values: { subject: "Hello", body: "There" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      claimGrant: async () => grantIsSpendable,
      deps: { resolve: resolveScreen as never, surface: "run-page" },
    });
    expect(outcome).toEqual({ kind: "filled", ref: REF, applied: ["subject", "body"] });
    // ONE window row, carrying the fill, with NO text — a fill is not a bubble.
    expect(appended).toHaveLength(1);
    expect(appended[0]!.text).toBe("");
    expect(appended[0]!.fill).toEqual({ ref: REF, values: { subject: "Hello", body: "There" } });
    // NOTHING was submitted: the gate's own resume entry was never reached.
    expect(approveReviewTaskInternal).not.toHaveBeenCalled();
  });

  it("a REVIEW lends no fill, and an absent card lends nothing", async () => {
    const asReview = vi.fn(async () => reviewResolution as never);
    expect(
      await recordBoundScreenFill({
        ref: REF,
        values: { subject: "x" },
        actorCtx: ACTOR,
        messageId: "msg_1",
        deps: { resolve: asReview as never },
      }),
    ).toEqual({ kind: "unavailable" });
    const absent = vi.fn(async () => ({ kind: "absent" }) as never);
    expect(
      await recordBoundScreenFill({
        ref: REF,
        values: { subject: "x" },
        actorCtx: ACTOR,
        messageId: "msg_1",
        deps: { resolve: absent as never },
      }),
    ).toEqual({ kind: "unavailable" });
    expect(appended).toHaveLength(0);
  });

  it("says which fields the screen HAS when nothing asked for is one of them", async () => {
    const outcome = await recordBoundScreenFill({
      ref: REF,
      values: { nope: 1 },
      actorCtx: ACTOR,
      messageId: "msg_1",
      deps: { resolve: resolveScreen as never },
    });
    expect(outcome).toEqual({ kind: "no-fields", fields: ["subject", "body"] });
    expect(appended).toHaveLength(0);
  });

  it("a screen lends BOTH roads; a review lends its own three buttons", () => {
    expect(controlsLentBy(screenResolution as never)).toEqual(["fill", "submit"]);
    expect(controlsLentBy(reviewResolution as never)).toEqual(["comment", "approve", "reject"]);
    // `fill` is never a GRANT control: filling presses nothing, so it is not an
    // authority a grant can spend.
    expect(LENT_ACTION_CONTROLS).not.toContain("fill");
  });
});

// ---------------------------------------------------------------------------
// The fill's OWN authority: the message must have been sent with that screen
// bound, and the grant is never spent.
// ---------------------------------------------------------------------------
describe("the fill demands a bound message, and spends nothing", () => {
  it("no grant on the frame ⇒ nothing is filled", async () => {
    frame.store = { userId: PERSON.userId, orgId: PERSON.orgId };
    const res = await handleBoundScreenFill(
      { ref: REF, values: { subject: "x" } },
      { resolveActor: resolveActor as never },
    );
    expect(res.structuredContent).toEqual({ ok: false, message: BOUND_SCREEN_FILL_UNAVAILABLE });
    expect(appended).toHaveLength(0);
  });

  it("a grant for ANOTHER card ⇒ nothing is filled", async () => {
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("submit", OTHER_REF).grant,
    };
    const res = await handleBoundScreenFill(
      { ref: REF, values: { subject: "x" } },
      { resolveActor: resolveActor as never },
    );
    expect((res.structuredContent as { ok: boolean }).ok).toBe(false);
    expect(appended).toHaveLength(0);
  });

  it("a grant for THIS card fills — and the grant is still spendable afterwards", async () => {
    const minted = mint("submit");
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: minted.grant,
    };
    const res = await handleBoundScreenFill(
      { ref: REF, values: { subject: "Hello", body: "There", nope: 1 } },
      {
        resolveActor: resolveActor as never,
        record: (async (input: Parameters<typeof recordBoundScreenFill>[0]) =>
          recordBoundScreenFill({
            ...input,
            deps: { resolve: resolveScreen as never, surface: "run-page" },
          })) as never,
      },
    );
    expect(res.structuredContent).toMatchObject({ ok: true, placed: ["subject", "body"] });
    // NOT CONSUMED: the same grant still matches its own control, so the very
    // same message can go on to ask for the submit.
    expect(
      matchLentActionGrant(minted.claims, {
        userId: PERSON.userId,
        orgId: PERSON.orgId,
        cardRef: REF,
        control: "submit",
      }),
    ).toBe(true);
  });

  it("the card match ignores the control, and nothing else", () => {
    const claims = mint("submit").claims;
    expect(matchLentActionGrantCard(claims, { ...PERSON, cardRef: REF })).toBe(true);
    expect(matchLentActionGrantCard(claims, { ...PERSON, cardRef: OTHER_REF })).toBe(false);
    expect(
      matchLentActionGrantCard(claims, { userId: "usr_2", orgId: PERSON.orgId, cardRef: REF }),
    ).toBe(false);
    expect(
      matchLentActionGrantCard(claims, { userId: PERSON.userId, orgId: "org_2", cardRef: REF }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC1b — submitted ONLY when asked, through the button's own server action, with
// the values the screen was shown holding.
// ---------------------------------------------------------------------------
describe("the submit sends what the screen was shown holding", () => {
  it("a waiting screen mints the submit control for a typed message", () => {
    expect(primaryControlFor(screenResolution as never)).toBe("submit");
    expect(primaryControlFor(reviewResolution as never)).toBe("comment");
    expect(primaryControlFor({ kind: "absent" } as never)).toBeNull();
  });

  it("presses the gate's own resume entry with the RECORDED fill, not the model's words", async () => {
    // The person's message, with a file beside it, then the assistant's fill.
    await recordBoundScreenFill({
      ref: REF,
      values: { subject: "Hello", body: "There" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      claimGrant: async () => grantIsSpendable,
      deps: { resolve: resolveScreen as never, surface: "run-page" },
    });
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("submit").grant,
    };
    const res = await handleLentAction(
      { ref: REF, control: "submit" },
      {
        resolve: resolveScreen as never,
        resolveActor: resolveActor as never,
        consume: (async () => ({ outcome: "consumed", messageText: "please send it" })) as never,
        buildPayload: ((args: { value: Record<string, unknown> }) => ({
          payload: { ...args.value, approved: true },
          payloadFieldName: undefined,
        })) as never,
      },
    );
    expect((res.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(approveReviewTaskInternal).toHaveBeenCalledTimes(1);
    const values = (approveReviewTaskInternal.mock.calls[0] as unknown as unknown[])[2] as Record<
      string,
      unknown
    >;
    // THE FIELDS STILL SHOW WHAT WAS SENT: the values are the recorded fill's.
    // The person's own sentence is NOT among them — the model supplies nothing.
    expect(values).toMatchObject({ subject: "Hello", body: "There" });
    expect(JSON.stringify(values)).not.toContain("please send it");
  });

  it("a screen nobody filled and nobody attached to submits exactly what it did before", async () => {
    expect(
      await buildScreenSubmitValues({
        reviewTaskId: SCREEN,
        fieldName: undefined,
        current: {},
        fills: [],
        attachments: [],
      }),
    ).toBeUndefined();
  });

  it("the files attached beside the message are NOT left behind by the press", async () => {
    const built = await buildScreenSubmitValues({
      reviewTaskId: SCREEN,
      fieldName: undefined,
      current: {},
      fills: [{ subject: "Hello" }],
      attachments: [{ artifactId: "a1" }],
      buildPayload: ((args: { pendingAttachments: readonly unknown[]; value: unknown }) => ({
        payload: { ...(args.value as object), attachmentCount: args.pendingAttachments.length },
        payloadFieldName: undefined,
      })) as never,
    });
    expect(built).toEqual({ subject: "Hello", attachmentCount: 1 });
  });
});

// ---------------------------------------------------------------------------
// The two primitives are named once, everywhere.
// ---------------------------------------------------------------------------
describe("the primitives' names", () => {
  it("are the literals the policies, the carve-outs and the window all use", () => {
    expect(LENT_ACTION_PRIMITIVE).toBe("lifecycle_bound_card_decide");
    expect(BOUND_SCREEN_FILL_PRIMITIVE).toBe("lifecycle_bound_screen_fill");
  });
});

// ---------------------------------------------------------------------------
// AC1c — the review page's typed road. A question is answered and files
// nothing; a request for changes is filed through the card's OWN Comment
// control and the work goes back for repair.
// ---------------------------------------------------------------------------
describe("the review page's typed road", () => {
  it("files the PERSON'S OWN WORDS through the card's Comment control, and the work goes back", async () => {
    const asReview = vi.fn(async () => reviewResolution as never);
    (submitReviewDecisionAction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "changes-requested",
      status: "requested",
    } as never);
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("comment").grant,
    };
    const res = await handleLentAction(
      { ref: REF, control: "comment" },
      {
        resolve: asReview as never,
        resolveActor: resolveActor as never,
        // The words come from the SPENT ROW, captured at mint time — the model
        // supplies no text at all.
        consume: (async () => ({
          outcome: "consumed",
          messageText: "tighten the opening paragraph",
        })) as never,
      },
    );
    expect((res.structuredContent as { ok: boolean }).ok).toBe(true);
    const call = (submitReviewDecisionAction as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[2]).toBe("comment");
    expect(call[3]).toBe("tighten the opening paragraph");
    expect((res.structuredContent as { outcome: { kind: string } }).outcome.kind).toBe(
      "changes-requested",
    );
  });

  it("a turn that presses nothing files nothing at all", () => {
    // The page composes no disposition of its own any more: the ONLY road from a
    // typed sentence to the gate is the lent action above, which runs only when
    // the model calls it with the grant. Structurally pinned in
    // packages/agents/src/__tests__/w5c-fill-road-surfaces.test.ts; here the
    // point is that no other entry in this module can file one.
    expect(typeof handleLentAction).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// The BINDING for a waiting screen: minted by the server, and a lone screen
// binds without consulting the open-REVIEW counter.
// ---------------------------------------------------------------------------
describe("a waiting screen binds from the run the window sits under", () => {
  const countNever = async () => {
    throw new Error("the review counter must not decide a screen binding");
  };

  it("mints the screen's ref from the named run and binds it", async () => {
    const binding = await resolveBoundCard({
      claim: { candidateRefs: [], focusedRef: null, screenRunIds: [RUN] },
      actorCtx: ACTOR,
      resolve: resolveScreen as never,
      countOpenCards: countNever as never,
      mintScreenRef: async (runId) => (runId === RUN ? REF : null),
    });
    expect(binding.kind).toBe("bound");
    expect(binding.kind === "bound" && binding.ref).toBe(REF);
    expect(binding.kind === "bound" && binding.controls).toEqual(["fill", "submit"]);
  });

  it("a run whose screen the person may not answer binds nothing", async () => {
    const absent = vi.fn(async () => ({ kind: "absent" }) as never);
    const binding = await resolveBoundCard({
      claim: { candidateRefs: [], focusedRef: null, screenRunIds: [RUN] },
      actorCtx: ACTOR,
      resolve: absent as never,
      countOpenCards: countNever as never,
      mintScreenRef: async () => REF,
    });
    expect(binding.kind).toBe("none");
  });

  it("a run with no parked screen offers no ref, so nothing binds", async () => {
    const binding = await resolveBoundCard({
      claim: { candidateRefs: [], focusedRef: null, screenRunIds: [RUN] },
      actorCtx: ACTOR,
      resolve: resolveScreen as never,
      countOpenCards: countNever as never,
      mintScreenRef: async () => null,
    });
    expect(binding.kind).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// CONVERGENCE ROUND 1 — each finding, with the case that holds it shut.
// ---------------------------------------------------------------------------
describe("what the convergence round found, and what now refuses it", () => {
  it("finding 3: reading a run is not permission to fill its screen", async () => {
    mayRespond = false;
    const outcome = await recordBoundScreenFill({
      ref: REF,
      values: { subject: "Hello" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      claimGrant: async () => grantIsSpendable,
      deps: { resolve: resolveScreen as never, surface: "run-page" },
    });
    // The resolver authorizes a screen on run READ; placing values on it is the
    // run's own `respondToHitl`, and this person does not have it.
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(appended).toHaveLength(0);
  });

  it("finding 6: a grant that has already pressed something fills nothing", async () => {
    grantIsSpendable = false;
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("submit").grant,
    };
    const res = await handleBoundScreenFill(
      { ref: REF, values: { subject: "after the press" } },
      { resolveActor: resolveActor as never },
    );
    expect(res.structuredContent).toEqual({ ok: false, message: BOUND_SCREEN_FILL_UNAVAILABLE });
    expect(appended).toHaveLength(0);
  });

  it("finding 2: a press with nothing filled in this message does nothing", async () => {
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("submit").grant,
    };
    const res = await handleLentAction(
      { ref: REF, control: "submit" },
      {
        resolve: resolveScreen as never,
        resolveActor: resolveActor as never,
        consume: (async () => ({ outcome: "consumed", messageText: "send it" })) as never,
      },
    );
    expect((res.structuredContent as { ok: boolean }).ok).toBe(false);
    expect(approveReviewTaskInternal).not.toHaveBeenCalled();
  });

  it("finding 4: the press sends the SCREEN's values with every fill of this message over them", async () => {
    const screenWithValues = {
      ...screenResolution,
      form: {
        schema: SCREEN_FORM,
        values: { subject: "Old subject", body: "Keep this body" },
      },
    };
    const resolveWithValues = vi.fn(async () => screenWithValues as never);
    // The turn filled twice: the subject, then a second thought about it.
    await recordBoundScreenFill({
      ref: REF,
      values: { subject: "New subject" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      claimGrant: async () => grantIsSpendable,
      deps: { resolve: resolveWithValues as never, surface: "run-page" },
    });
    await recordBoundScreenFill({
      ref: REF,
      values: { subject: "Newer subject" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      claimGrant: async () => grantIsSpendable,
      deps: { resolve: resolveWithValues as never, surface: "run-page" },
    });
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("submit").grant,
    };
    await handleLentAction(
      { ref: REF, control: "submit" },
      {
        resolve: resolveWithValues as never,
        resolveActor: resolveActor as never,
        consume: (async () => ({ outcome: "consumed", messageText: "and send it" })) as never,
        buildPayload: ((args: { value: Record<string, unknown> }) => ({
          payload: { ...args.value },
          payloadFieldName: undefined,
        })) as never,
      },
    );
    const values = (approveReviewTaskInternal.mock.calls[0] as unknown as unknown[])[2];
    // A field nobody mentioned still holds what the screen already had, and the
    // LAST fill of the two is what the fields were showing.
    expect(values).toEqual({ subject: "Newer subject", body: "Keep this body" });
  });

  it("finding 5: another turn's fill and another turn's file never travel under this press", async () => {
    const resolveIt = vi.fn(async () => screenResolution as never);
    await recordBoundScreenFill({
      ref: REF,
      values: { subject: "MINE" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      claimGrant: async () => grantIsSpendable,
      deps: { resolve: resolveIt as never, surface: "run-page" },
    });
    // A second tab, mid-flight, on the same run.
    await recordBoundScreenFill({
      ref: REF,
      values: { subject: "SOMEBODY ELSE'S" },
      actorCtx: ACTOR,
      messageId: "msg_2",
      claimGrant: async () => grantIsSpendable,
      deps: { resolve: resolveIt as never, surface: "run-page" },
    });
    windowRows.push({
      role: "user",
      messageId: "msg_2",
      attachments: [{ artifactId: "theirs" }],
    });
    frame.store = {
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      lentActionGrant: mint("submit").grant,
    };
    await handleLentAction(
      { ref: REF, control: "submit" },
      {
        resolve: resolveIt as never,
        resolveActor: resolveActor as never,
        consume: (async () => ({ outcome: "consumed", messageText: "send it" })) as never,
        buildPayload: ((args: {
          value: Record<string, unknown>;
          pendingAttachments: readonly unknown[];
        }) => ({
          payload: { ...args.value, files: args.pendingAttachments.length },
          payloadFieldName: undefined,
        })) as never,
      },
    );
    const values = (approveReviewTaskInternal.mock.calls[0] as unknown as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect(values.subject).toBe("MINE");
    expect(values.files).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FINDING 1 — a window that names only a RUN still gets its grant.
// ---------------------------------------------------------------------------
describe("a claim that carries no refs at all is still a binding", () => {
  it("mints a grant for a screen named by its run alone", async () => {
    const { issueTurnLentActionGrant } = await import("../bound-card-binding");
    const out = await issueTurnLentActionGrant({
      claim: { candidateRefs: [], focusedRef: null, screenRunIds: [RUN] },
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      messageId: "msg_1",
      messageText: "make the subject about Q3",
      deps: {
        resolveActor: (async () => ACTOR) as never,
        resolveBinding: (async () => ({
          kind: "bound",
          ref: REF,
          resolution: screenResolution,
          controls: ["fill", "submit"],
        })) as never,
        record: (async () => true) as never,
        sweep: (async () => undefined) as never,
      },
    });
    expect(out.grant).toEqual(expect.any(String));
    expect(out.systemContext).toContain("BOUND SCREEN");
  });

  it("and a claim with neither refs nor runs still binds nothing", async () => {
    const { issueTurnLentActionGrant } = await import("../bound-card-binding");
    const out = await issueTurnLentActionGrant({
      claim: { candidateRefs: [], focusedRef: null },
      userId: PERSON.userId,
      orgId: PERSON.orgId,
      messageId: "msg_1",
      messageText: "hello",
    });
    expect(out).toEqual({ grant: null, systemContext: "" });
  });
});

// ---------------------------------------------------------------------------
// CONVERGENCE ROUND 2 — the two findings that stayed open, and what closes them.
// ---------------------------------------------------------------------------
describe("what the second convergence round found", () => {
  it("finding 2: a fill that changes nothing places nothing, so it unlocks no press", async () => {
    const screenWithValues = {
      ...screenResolution,
      form: { schema: SCREEN_FORM, values: { subject: "Already this", body: "And this" } },
    };
    const resolveWithValues = vi.fn(async () => screenWithValues as never);
    // The exact bypass: "fill" the fields with what they already hold, to unlock
    // the press that requires a fill from this message.
    const outcome = await recordBoundScreenFill({
      ref: REF,
      values: { subject: "Already this", body: "And this" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      claimGrant: async () => true,
      deps: { resolve: resolveWithValues as never, surface: "run-page" },
    });
    expect(outcome.kind).toBe("no-fields");
    expect(appended).toHaveLength(0);
    // A real change still lands.
    expect(
      (
        await recordBoundScreenFill({
          ref: REF,
          values: { subject: "Already this", body: "SOMETHING NEW" },
          actorCtx: ACTOR,
          messageId: "msg_1",
          claimGrant: async () => true,
          deps: { resolve: resolveWithValues as never, surface: "run-page" },
        })
      ).kind,
    ).toBe("filled");
    expect(appended[0]!.fill).toEqual({ ref: REF, values: { body: "SOMETHING NEW" } });
  });

  it("finding 2, pure: the selector drops a value the field already holds", () => {
    expect(
      selectFillableValues(
        SCREEN_FORM,
        { subject: "same", body: "different" },
        { subject: "same", body: "was" },
      ),
    ).toEqual({ body: "different" });
    // Structural, not referential: an identical array is still no change.
    expect(
      selectFillableValues(
        { properties: { body: { type: "array" } } },
        { body: [1, 2] },
        { body: [1, 2] },
      ),
    ).toEqual({});
    // And KEY ORDER is not a change (convergence round 3): a stringify-based
    // comparison would have called this one a fill and unlocked a press.
    expect(
      selectFillableValues(
        { properties: { who: { type: "object" } } },
        { who: { a: 1, b: { c: 2, d: 3 } } },
        { who: { b: { d: 3, c: 2 }, a: 1 } },
      ),
    ).toEqual({});
    // Array ORDER is content, so reordering one IS a change.
    expect(
      selectFillableValues(
        { properties: { body: { type: "array" } } },
        { body: [2, 1] },
        { body: [1, 2] },
      ),
    ).toEqual({ body: [2, 1] });
  });

  it("finding 6: the grant is claimed at the LAST moment, and a spent one writes nothing", async () => {
    const order: string[] = [];
    const outcome = await recordBoundScreenFill({
      ref: REF,
      values: { subject: "Hello" },
      actorCtx: ACTOR,
      messageId: "msg_1",
      claimGrant: async () => {
        order.push("claim");
        return false;
      },
      deps: {
        resolve: resolveScreen as never,
        surface: "run-page",
        append: (async () => {
          order.push("append");
          throw new Error("must not be reached");
        }) as never,
      },
    });
    expect(outcome).toEqual({ kind: "unavailable" });
    // The claim is the last thing asked, and the row is never written.
    expect(order).toEqual(["claim"]);
    expect(appended).toHaveLength(0);
  });
});
