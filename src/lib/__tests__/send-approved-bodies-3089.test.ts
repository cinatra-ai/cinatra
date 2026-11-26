/**
 * cinatra#3089 — what a publishing step's campaign send may mail: the checks of
 * the one publish decision its call claimed, before any mail.
 *
 * The approved list is read from the publish decision a person released for
 * the calling step (here a stubbed decision: `releasedList` in a case is the
 * list that decision surfaced; the request carries no list). Every gap refuses
 * the whole send before any mail, with a named code. A call that passes every
 * check is refused too (`approved_send_unavailable`): the per-message mail of
 * the released revisions follows in the next change, and until then a governed
 * call never falls back to mailing the bundle. Without a released list the send
 * reads the bundle exactly as before, unless a run filed bodies for review.
 *
 * NO RUN REACHES THIS SEND YET: the MCP boundary refuses every call of
 * `email_outreach_send_initial_start` made on a run's frame (the outward-effect
 * set in src/lib/authz/mcp-boundary.ts). These tests drive the use case
 * directly, through `createTriggerEmailSendHandlers` and
 * `createTriggerEmailSendUseCases` with injected seams.
 *
 * Cases:
 *   U1 the reference-only form is unchanged for a run without bodies filed for
 *      review
 *   U2 a run with bodies filed for review refuses a send with no released list
 *   U3 a run whose filings cannot be looked up refuses that send too
 *   U4 a call that carries no run, on a bundle a reviewed run wrote, is refused
 *   G1-G5 the decision that governs the call is read through the one resolution
 *      the publishing call guard claims under; a call signed for a decision is
 *      served by that one only; a publishing step with no decision is refused,
 *      never sent in the reference-only form
 *   L1 a released decision with no list of approved bodies is refused
 *   L2 a list surfaced as JSON text is refused: the card draws no bodies from it
 *   B6 the campaign and the sender must be exactly as frozen and shown; a
 *      missing campaign is refused
 *   C1-C7 the send reads the decision its call claimed, by id: each claim
 *      refusal code, and the normal case reaches the final refusal
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real resolution of the decision that governs a call (the send's default
// reader, readGoverningPublishDecision), over stubbed reads: the run and its
// template, the graph the run is bound to execute, and the decision rows by
// step. The released-list readers of the decision store stay real.
const governing = vi.hoisted(() => ({
  readAgentRunById: vi.fn(async (): Promise<unknown> => ({ id: "run-1", templateId: "tmpl-1" })),
  readAgentTemplateById: vi.fn(async (): Promise<unknown> => ({ id: "tmpl-1", publishingSteps: ["publish"] })),
  readDecisionForRunNode: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  readLatestDecisionForRun: vi.fn(async (): Promise<unknown> => null),
  readRunBoundGraph: vi.fn(async (): Promise<string | null> => null),
  // By id, in the current attempt: here the publishing node's decision when it carries that id.
  readDecisionOfRun: vi.fn(async (runId: unknown, decisionId: unknown): Promise<unknown> => {
    const decision = (await governing.readDecisionForRunNode(runId, "publish")) as { id?: string } | null;
    return decision?.id === decisionId ? decision : null;
  }),
}));
vi.mock("../../../packages/agents/src/db", () => ({ db: {} }));
vi.mock("../../../packages/agents/src/store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readAgentRunById: governing.readAgentRunById,
  readAgentTemplateById: governing.readAgentTemplateById,
}));
vi.mock("../../../packages/agents/src/publish-decision-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readDecisionForRunNode: governing.readDecisionForRunNode,
  readLatestDecisionForRun: governing.readLatestDecisionForRun,
  readRunBoundGraph: governing.readRunBoundGraph,
  readDecisionOfRun: governing.readDecisionOfRun,
}));
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { createTriggerEmailSendHandlers } from "@cinatra-ai/trigger-email-send";
import {
  createTriggerEmailSendUseCases,
  EMAIL_BODY_TYPE_ID,
  materializeEmailFanout,
  type EmailFanoutArgs,
  type CallingRun,
  type StepPublishDecision,
  type TriggerEmailSendDeps,
} from "../trigger-email-send-use-cases";

const UNAVAILABLE = "(approved_send_unavailable)";

// The claim the passthrough route took for the call: the decision the call was signed for, else the step's decision,
// `d-1`; each stubbed decision carries that id unless it names its own.
const withClaim = <T extends { runId: string; publishDecisionId?: string; claim?: unknown } | null>(run: T): T =>
  run && !run.claim ? { ...run, claim: { runId: run.runId, decisionId: run.publishDecisionId ?? "d-1" } } : run;
const withDecisionId = <T extends object | null | undefined>(decision: T): T =>
  decision ? ({ id: "d-1", ...decision } as T) : decision;

/** The publish decision a person released for the calling step, surfacing the
 *  list a case names: the campaign, the card's Recipients list row and its
 *  Emails row, drawn from the frozen values. */
function releasedCardFor(named: unknown, campaignId: unknown = CAMPAIGN_ID) {
  const list = (named === undefined ? [] : typeof named === "string" ? JSON.parse(named) : named) as Array<{
    recipientEmail: string;
    subject: string;
  }>;
  return {
    status: "released" as const,
    decidedBy: "user-2",
    surfacedValues: {
      ...(campaignId === undefined ? {} : { campaignId }),
      recipients: list.map((e) => ({ email: e.recipientEmail, subject: e.subject })),
      ...(named === undefined ? {} : { emailBodies: named }),
    },
    declaredRows: [
      { kind: "list", input: "recipients", columns: [{ field: "email" }, { field: "subject" }] },
      { kind: "artifacts", input: "emailBodies" },
    ],
  } as unknown as StepPublishDecision & { declaredRows: unknown[] };
}

const actor: PrimitiveActorContext = {
  actorType: "human",
  source: "route",
  userId: "user-1",
  sessionId: "sess-1",
  orgId: "org-1",
};

const BUNDLE_REF = "11111111-1111-4111-8111-111111111111";
const RECIPIENTS_REF = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_ID = "33333333-3333-4333-8333-333333333333";

const bundleDrafts = [
  { recipientId: "c1", recipientName: "One", recipientEmail: "one@example.com", subject: "Bundle subject one", body: "Approved body one\n\n" },
  { recipientId: "c2", recipientName: "Two", recipientEmail: "two@example.com", subject: "Bundle subject two", body: "Approved body two\n\n" },
  { recipientId: "c3", recipientName: "Three", recipientEmail: "", subject: "Bundle subject three", body: "Approved body three\n\n" },
];
const confirmedRecipients = [
  { contactId: "c1", email: "one@example.com" },
  { contactId: "c2", email: "two@example.com" },
  { contactId: "c3" },
];

const approved = [
  { artifactId: "art-1", representationRevisionId: "rev-1", contactId: "c1", recipientEmail: "one@example.com", subject: "Bundle subject one" },
  { artifactId: "art-2", representationRevisionId: "rev-2", contactId: "c2", recipientEmail: "two@example.com", subject: "Bundle subject two" },
];

function makeFixture(opts?: {
  /** What the ledger answers for "the run has bodies filed for review". */
  reviewedBodies?: boolean | Error;
  /** The run, verified step and signed decision of the call; null: the call carries no run. */
  callingRun?: CallingRun | null;
  /** The decision read; null leaves the send's own default reader. */
  readPublishDecision?: TriggerEmailSendDeps["readPublishDecision"] | null;
  /** The claimed-decision read, when a case replaces it. */
  readClaimedPublishDecision?: TriggerEmailSendDeps["readClaimedPublishDecision"];
  /** The run of the call is read by the send's own reader, from the request frame the case runs it in (`inFrame`);
   *  `decisions` is then the run's decisions of the current attempt, newest last. */
  decisions?: { current: StepPublishDecision[]; earlier?: StepPublishDecision[] };
}) {
  const sent: Array<{ to: string[]; subject: string; textBody: string }> = [];
  const sendEmail = vi.fn(async (message: { to: string[]; subject: string; textBody: string }) => {
    sent.push(message);
    return { providerId: "p", providerMessageId: `m-${sent.length}`, sentAt: "2026-11-24T00:00:00Z" };
  });
  const envelopes: Record<string, { id: string; type: string; data: unknown }> = {
    [BUNDLE_REF]: {
      id: BUNDLE_REF,
      type: "@cinatra-ai/campaigns:email-draft-bundle",
      data: { cinatraAgentRunId: "run-1", drafts: bundleDrafts },
    },
    [RECIPIENTS_REF]: {
      id: RECIPIENTS_REF,
      type: "@cinatra-ai/campaigns:recipients",
      data: { confirmedRecipients },
    },
  };
  const writeBody = vi.fn(async (w: { outputId: string }) => ({
    ok: true as const,
    artifactId: `new-${w.outputId}`,
    representationRevisionId: `new-rev-${w.outputId}`,
    deduped: false,
  }));
  const bindBody = vi.fn(async (b: { artifactId: string; representationRevisionId: string }) => ({
    ok: true as const,
    artifactId: b.artifactId,
    representationRevisionId: b.representationRevisionId,
    deduped: false,
  }));
  const emitEmailFanout = vi.fn((args: EmailFanoutArgs) =>
    materializeEmailFanout(args, {
      writeBody,
      bindBody,
      registeredTypes: new Set([EMAIL_BODY_TYPE_ID]),
    } as Parameters<typeof materializeEmailFanout>[1]),
  );
  // A case that names no list calls from a step no publish decision governs.
  const readPublishDecision = vi.fn(async (_runId: string, _stepId: string): Promise<StepPublishDecision | null> =>
    named === undefined ? null : releasedCardFor(named));
  const readRunReviewedBodies = vi.fn(async (_runId: string) => {
    const answer = opts?.reviewedBodies ?? false;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  let lastGoverning: StepPublishDecision | null = null;
  const deps: TriggerEmailSendDeps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: sendEmail as unknown as TriggerEmailSendDeps["sendEmail"],
    getObjectByRef: async (ref) => envelopes[ref] ?? null,
    emitEmailFanout,
    readRunReviewedBodies,
    // The runs the host recorded as writers of each object: here the run the object's data names.
    readObjectRuns: async (id: string) => {
      const d = (envelopes[id]?.data ?? {}) as Record<string, unknown>;
      return typeof d.cinatraAgentRunId === "string" ? [d.cinatraAgentRunId] : [];
    },
    ...(opts?.decisions
      ? {
          readPublishDecision: async () => opts.decisions!.current.at(-1) ?? null,
          readClaimedPublishDecision: async (runId: string, decisionId: string) =>
            runId === "run-1" ? (opts.decisions!.current.find((d) => d.id === decisionId) ?? null) : null,
        }
      : {
          readCallingRun: async () =>
            opts?.callingRun === null ? null : withClaim(opts?.callingRun ?? { runId: "run-1", stepId: "send" }),
        }),
    ...(opts?.decisions || opts?.readPublishDecision === null
      ? {}
      : {
          readPublishDecision: async (runId: string, stepId: string) =>
            (lastGoverning = withDecisionId(await (opts?.readPublishDecision ?? readPublishDecision)(runId, stepId))),
          // The stub store holds one decision: the one the governing read answered.
          readClaimedPublishDecision:
            opts?.readClaimedPublishDecision ??
            (async (_runId: string, decisionId: string) => (lastGoverning?.id === decisionId ? lastGoverning : null)),
        }),
  } as unknown as TriggerEmailSendDeps;
  let named: unknown;
  const handlers = createTriggerEmailSendHandlers(createTriggerEmailSendUseCases(deps));
  // `releasedList` is what the stubbed decision surfaced; every other key goes to the tool as the request.
  const start = (input: Record<string, unknown>) => {
    const { releasedList, ...request } = input;
    named = releasedList;
    return handlers["email_outreach_send_initial_start"]({
      input: {
        campaignId: CAMPAIGN_ID,
        approvedDraftBundleRef: BUNDLE_REF,
        confirmedRecipientsRef: RECIPIENTS_REF,
        ...request,
      },
      actor,
    } as never) as unknown as Promise<{ status: string; sentCount: number; errorMessage?: string }>;
  };
  return { sent, sendEmail, readRunReviewedBodies, readPublishDecision, writeBody, bindBody, emitEmailFanout, start, deps };
}

/** Refused before any mail and before any body write or binding. */
async function expectRefused(fx: ReturnType<typeof makeFixture>, input: Record<string, unknown>, reason: string) {
  const result = await fx.start(input);
  expect(result.status).toBe("failed");
  expect(result.sentCount).toBe(0);
  expect(result.errorMessage).toContain(reason);
  expect(fx.sendEmail).not.toHaveBeenCalled();
  expect(fx.emitEmailFanout).not.toHaveBeenCalled();
  expect(fx.writeBody).not.toHaveBeenCalled();
  expect(fx.bindBody).not.toHaveBeenCalled();
  return result;
}

describe("cinatra#3089 — a send with no released list never mails reviewed bodies' bundle", () => {
  it("U1 the reference-only form is unchanged for a run without bodies filed for review", async () => {
    const fx = makeFixture();
    const result = await fx.start({});
    expect(result.status).toBe("completed");
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], subject: "Bundle subject one", textBody: "Approved body one\n\n" }),
      expect.objectContaining({ to: ["two@example.com"], subject: "Bundle subject two", textBody: "Approved body two\n\n" }),
    ]);
    expect(fx.bindBody).not.toHaveBeenCalled();
    // The fan-out still files one body per draft of the bundle, as before.
    expect(fx.writeBody).toHaveBeenCalledTimes(3);
  });

  it("U2 a run with bodies filed for review refuses a send that names none of them, before any mail", async () => {
    const fx = makeFixture({ reviewedBodies: true });
    await expectRefused(
      fx,
      {},
      "REVIEWED_ARTIFACTS_REQUIRED: The send was refused before any email went out: run run-1 filed artifacts for review, and the calling step holds no list a person released",
    );
    expect(fx.readRunReviewedBodies).toHaveBeenCalledWith("run-1", expect.objectContaining({ orgId: "org-1" }));
  });

  it("U3 a run whose filed bodies cannot be looked up refuses a send that names none of them", async () => {
    await expectRefused(
      makeFixture({ reviewedBodies: new Error("the ledger is unavailable") }),
      {},
      "whether run run-1 filed artifacts for review could not be read: the ledger is unavailable",
    );
  });

  it("U4 a call that carries no run, on a bundle a run with reviewed bodies wrote, is refused", async () => {
    const fx = makeFixture({ callingRun: null, reviewedBodies: true });
    await expectRefused(fx, {}, "run run-1 filed artifacts for review");
    expect(fx.readPublishDecision).not.toHaveBeenCalled();
  });
});

// The run's bound graph: `draft`, then `publish`, a publishing FlowNode whose
// subflow holds `compose` and `send`; the decision is stored under `publish`.
const NESTED_GRAPH = {
  component_type: "Flow",
  id: "root",
  nodes: [{ $component_ref: "draft" }, { $component_ref: "publish" }],
  $referenced_components: {
    draft: { component_type: "ApiNode", id: "draft" },
    publish: { component_type: "FlowNode", id: "publish", metadata: { cinatra: { publishes: true } }, subflow: { $component_ref: "publish_body" } },
    publish_body: {
      component_type: "Flow",
      id: "publish_body",
      nodes: [{ $component_ref: "compose" }, { $component_ref: "send" }],
      $referenced_components: { compose: { component_type: "ApiNode", id: "compose" }, send: { component_type: "ApiNode", id: "send" } },
    },
  },
};
// A publishing component declared under the key `publish` with its own id
// `send`: the decision is stored under the key, the runtime signs the id.
const ALIASED_GRAPH = {
  component_type: "Flow",
  id: "root",
  nodes: [{ $component_ref: "draft" }, { $component_ref: "publish" }],
  $referenced_components: {
    draft: { component_type: "ApiNode", id: "draft" },
    publish: { component_type: "ApiNode", id: "send", metadata: { cinatra: { publishes: true } } },
  },
};

describe("cinatra#3089 — the send reads the decision that governs its call, as the publishing call guard does", () => {
  beforeEach(() => {
    governing.readAgentRunById.mockReset().mockResolvedValue({ id: "run-1", templateId: "tmpl-1" });
    governing.readAgentTemplateById.mockReset().mockResolvedValue({ id: "tmpl-1", publishingSteps: ["publish"] });
    governing.readDecisionForRunNode.mockReset().mockResolvedValue(null);
    governing.readLatestDecisionForRun.mockReset().mockResolvedValue(null);
    governing.readRunBoundGraph.mockReset().mockResolvedValue(null);
  });

  it("G1 the send asks for the decision of its call's verified step, and of that step only", async () => {
    const fx = makeFixture();
    await expectRefused(fx, { releasedList: approved }, UNAVAILABLE);
    expect(fx.readPublishDecision).toHaveBeenCalledTimes(1);
    expect(fx.readPublishDecision).toHaveBeenCalledWith("run-1", "send");
    const other = makeFixture({ callingRun: { runId: "run-1", stepId: "deliver" } });
    await other.start({ releasedList: approved });
    expect(other.readPublishDecision).toHaveBeenCalledWith("run-1", "deliver");
  });

  for (const [name, graph] of [["nested in a released publishing FlowNode", NESTED_GRAPH], ["signed with the publishing component's own id", ALIASED_GRAPH]] as const) {
    it(`G2 a send step ${name} reads the decision stored under the publishing node`, async () => {
      governing.readRunBoundGraph.mockResolvedValue(JSON.stringify(graph));
      governing.readDecisionForRunNode.mockImplementation(async (_runId: unknown, nodeId: unknown) =>
        nodeId === "publish" ? { id: "d-publish", ...releasedCardFor(approved) } : null);
      const fx = makeFixture({
        readPublishDecision: null,
        reviewedBodies: true,
        callingRun: { runId: "run-1", stepId: "send", claim: { runId: "run-1", decisionId: "d-publish" } },
      });
      // Every check passed on the node's decision: the final refusal, not REVIEWED_ARTIFACTS_REQUIRED.
      await expectRefused(fx, {}, UNAVAILABLE);
      expect(governing.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "publish");
      expect(governing.readDecisionForRunNode).not.toHaveBeenCalledWith("run-1", "send");
    });
  }

  it("G3 a send step whose governing publishing node cannot be told is refused before any mail", async () => {
    // `send` lies inside two publishing nodes.
    governing.readRunBoundGraph.mockResolvedValue(JSON.stringify({
      ...NESTED_GRAPH,
      $referenced_components: {
        ...NESTED_GRAPH.$referenced_components,
        again: { component_type: "FlowNode", id: "again", metadata: { cinatra: { publishes: true } }, subflow: { $component_ref: "publish_body" } },
      },
    }));
    governing.readDecisionForRunNode.mockResolvedValue({ id: "d-publish", ...releasedCardFor(approved) });
    await expectRefused(makeFixture({ readPublishDecision: null }), {}, "which publishing step governs the call cannot be told");
  });

  it("G5 a send step inside a publishing node that holds no decision is refused, never sent in the reference-only form", async () => {
    governing.readRunBoundGraph.mockResolvedValue(JSON.stringify(NESTED_GRAPH));
    await expectRefused(makeFixture({ readPublishDecision: null }), {}, "the publishing step that governs the call holds no decision");
    // The same for a step the template lists itself, with no graph to read.
    governing.readRunBoundGraph.mockResolvedValue(null);
    governing.readAgentTemplateById.mockResolvedValue({ id: "tmpl-1", publishingSteps: ["send"] });
    await expectRefused(makeFixture({ readPublishDecision: null }), {}, "the publishing step that governs the call holds no decision");
    // A step no publishing node governs keeps the reference-only form.
    governing.readRunBoundGraph.mockResolvedValue(JSON.stringify(NESTED_GRAPH));
    const unrelated = makeFixture({ readPublishDecision: null, callingRun: { runId: "run-1", stepId: "draft" } });
    expect((await unrelated.start({})).status).toBe("completed");
  });

  it("G4 a call signed for a publish decision is served only by that decision", async () => {
    const signed = { runId: "run-1", stepId: "send", publishDecisionId: "d-signed" };
    const card = (id: string | undefined) => async () => ({ ...(id ? { id } : {}), ...releasedCardFor(approved) });
    await expectRefused(
      makeFixture({ callingRun: signed, readPublishDecision: card("d-newer") }),
      {},
      "the call was signed for another publish decision than the one that governs step send of run run-1",
    );
    await expectRefused(makeFixture({ callingRun: signed, readPublishDecision: card(undefined) }), {}, "signed for another publish decision");
    await expectRefused(makeFixture({ callingRun: signed, readPublishDecision: async () => null }), {}, "signed for another publish decision");
    await expectRefused(makeFixture({ callingRun: signed, readPublishDecision: card("d-signed") }), {}, UNAVAILABLE);
  });
});

describe("cinatra#3089 — the released decision's list, campaign and sender", () => {
  it("L1 a released decision that holds no list of approved bodies is refused, never sent as the bundle", async () => {
    await expectRefused(
      makeFixture({ readPublishDecision: async () => releasedCardFor(undefined) }),
      {},
      "REVIEWED_ARTIFACTS_REQUIRED: The send was refused before any email went out: the publish decision that governs step send of run run-1 holds no list of approved bodies",
    );
  });

  it("L2 a list surfaced as JSON text is refused: the card draws no bodies from it", async () => {
    const result = await expectRefused(
      makeFixture(),
      { releasedList: JSON.stringify(approved) },
      "no artifacts row of the released publish decision draws the bodies of the released list",
    );
    expect(result.errorMessage).not.toContain("one@example.com");
  });

  it("B6 the campaign and the sender are compared exactly as the decision froze and the card showed them", async () => {
    const withSender = (sender: unknown) => (async () => {
      const card = releasedCardFor(approved);
      return {
        ...card,
        surfacedValues: { ...card.surfacedValues, senderEmail: sender },
        declaredRows: [...card.declaredRows, { label: "From", input: "senderEmail" }],
      };
    }) as TriggerEmailSendDeps["readPublishDecision"];
    await expectRefused(makeFixture({ readPublishDecision: withSender(" team@example.com ") }), {}, "the sender the released publish card showed carries white space around it");
    await expectRefused(makeFixture({ readPublishDecision: withSender("team@example.com") }), { senderEmail: "TEAM@example.com" }, "the call names another sender than the released publish card showed");
    await expectRefused(makeFixture(), { releasedList: approved, senderEmail: "team@example.com" }, "the call names a sender the released publish card did not show");
    await expectRefused(makeFixture({ readPublishDecision: withSender("team@example.com") }), { senderEmail: "team@example.com" }, UNAVAILABLE);
    await expectRefused(makeFixture({ readPublishDecision: async () => releasedCardFor(approved, ` ${CAMPAIGN_ID} `) }), {}, "the released publish decision carries its campaign with white space around it");
    await expectRefused(makeFixture({ readPublishDecision: async () => releasedCardFor(approved, null) }), {}, "the released publish decision carries no campaign");
    await expectRefused(makeFixture(), { releasedList: approved, campaignId: "44444444-4444-4444-8444-444444444444" }, "the call names another campaign than the released publish decision carries");
  });
});

// THE SEND USES EXACTLY ONE DECISION, the one the call's road claimed. Each case runs the send inside the request frame
// as the passthrough route sets it (`runId` with `verifiedStepId`, `publishCallClaim` and, with a signed visit,
// `verifiedPublishDecisionId`): the send's own reader takes the run and the claim from there.
describe("cinatra#3089 — the send reads the decision its call claimed, by id", () => {
  const decisionA = { id: "d-A", ...releasedCardFor(approved) } as StepPublishDecision;
  const decisionB = { id: "d-B", ...releasedCardFor(approved) } as StepPublishDecision;
  const inFrame = async <T,>(frame: Record<string, unknown>, run: () => Promise<T>): Promise<T> => {
    const { mcpRequestContextStorage } = await import("@cinatra-ai/mcp-server/request-context");
    return mcpRequestContextStorage.run({ runId: "run-1", verifiedStepId: "send", ...frame } as never, run);
  };
  const claimOf = (decisionId: string, runId = "run-1") => ({ publishCallClaim: { runId, decisionId } });
  const refusedInFrame = async (fx: ReturnType<typeof makeFixture>, frame: Record<string, unknown>, reason: string) => {
    const result = await inFrame(frame, () => fx.start({}));
    expect(result.status).toBe("failed");
    expect(result.sentCount).toBe(0);
    expect(result.errorMessage).toContain(reason);
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(fx.emitEmailFanout).not.toHaveBeenCalled();
  };

  it("C1 the claimed decision, still the step's, passes every claim check and reaches the final refusal", async () => {
    await refusedInFrame(makeFixture({ decisions: { current: [decisionA] } }), claimOf("d-A"), UNAVAILABLE);
  });

  it("C2 a call that claimed A, after B was released for the step in the same attempt, is refused: never B's list", async () => {
    await refusedInFrame(makeFixture({ decisions: { current: [decisionA, decisionB] } }), claimOf("d-A"), "(decision_claim_superseded)");
  });

  it("C3 a call that claimed A, after a reset left A in an earlier attempt and B was released, is refused", async () => {
    await refusedInFrame(makeFixture({ decisions: { current: [decisionB], earlier: [decisionA] } }), claimOf("d-A"), "(decision_claim_not_current)");
  });

  it("C4 a signed decision that is not the claimed one is refused", async () => {
    await refusedInFrame(
      makeFixture({ decisions: { current: [decisionA, decisionB] } }),
      { ...claimOf("d-A"), verifiedPublishDecisionId: "d-B" },
      "(decision_claim_conflict)",
    );
  });

  it("C5 a governed call with no claim, or with a claim of another run, is refused", async () => {
    await refusedInFrame(makeFixture({ decisions: { current: [decisionA] } }), {}, "(decision_not_claimed)");
    await refusedInFrame(makeFixture({ decisions: { current: [decisionA] } }), claimOf("d-A", "run-2"), "(decision_claim_other_run)");
  });

  it("C6 a claimed decision that is not released is refused", async () => {
    const parked = { ...decisionA, status: "parked", decidedBy: null } as unknown as StepPublishDecision;
    await refusedInFrame(makeFixture({ decisions: { current: [parked] } }), claimOf("d-A"), "not released by a person");
  });

  it("C7 a claimed decision that cannot be read is refused, and the reader's text is not passed on", async () => {
    const fx = makeFixture({
      readPublishDecision: async () => releasedCardFor(approved),
      readClaimedPublishDecision: async () => {
        throw new Error("connection reset by secret-host");
      },
    });
    const result = await expectRefused(fx, {}, "(decision_claim_unreadable)");
    expect(result.errorMessage).not.toContain("secret-host");
  });
});
