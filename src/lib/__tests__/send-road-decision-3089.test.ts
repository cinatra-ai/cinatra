/**
 * cinatra#3089, piece A: the road of an initial send, decided from the call's publish claim and from what the claimed
 * decision's card declared, before anything is fetched or mailed.
 *
 *   R1 no claim on the call: the old road, as before (the decision readers are never called)
 *   R2 a claim whose released decision's card declared no list: the old road, as before
 *   R3 a claim with a released list of the exact form: refused with `approved_send_unavailable`, nothing mailed
 *   C  each refusal of a claimed call answers its fixed code, and nothing is fetched, projected or mailed
 *   S  a raw reader text (thrown or returned) reaches neither the answer, nor the stored status, nor any console call
 *   G  a code outside the closed set answers `claimed_send_refused`
 *   K  the road of each real context shape (the default reader of the call's run, not an injected run): the model
 *      bridge's frame (a verified decision id, no claim), the passthrough frame (a claim), and a frame with neither
 *   U  a governed call whose decision recorded no declaration is refused `released_list_undetermined`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

const { listOverride } = vi.hoisted(() => ({ listOverride: { code: undefined as string | undefined } }));

vi.mock("../../../packages/agents/src/db", () => ({ db: {} }));
vi.mock("../../../packages/agents/src/publish-decision-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../packages/agents/src/publish-decision-store")>();
  return {
    ...real,
    releasedDecisionList: (input: Parameters<typeof real.releasedDecisionList>[0]) =>
      listOverride.code === undefined
        ? real.releasedDecisionList(input)
        : { ok: false, code: listOverride.code, error: listOverride.code },
  };
});

import { createTriggerEmailSendUseCases, type TriggerEmailSendDeps } from "../trigger-email-send-use-cases";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server/request-context";

/** A secret-looking text a reader or a store could carry. */
const SECRET = "sk_live_SECRET4242 postgres://admin:hunter2@db.internal/cinatra";
const LEAKS = /SECRET4242|hunter2|db\.internal/;

const actor: PrimitiveActorContext = { actorType: "human", source: "route", userId: "user-1", sessionId: "sess-1", orgId: "org-1" };
const input = { campaignId: "camp-1", approvedDraftBundleRef: "draft-ref", confirmedRecipientsRef: "recip-ref", senderEmail: "s@cinatra.ai" };

const approved = [1, 2].map((n) => ({
  artifactId: `art-${n}`,
  representationRevisionId: `rev-${n}`,
  contactId: `c${n}`,
  recipientEmail: `p${n}@example.com`,
  subject: `Subject ${n}`,
}));
const LIST_ROW = { kind: "list", label: "Recipients", input: "recipients", columns: [{ label: "Email", field: "email" }, { label: "Subject", field: "subject" }] };
const ARTIFACTS_ROW = { kind: "artifacts", label: "Emails", input: "emailBodies" };

/** Decision `d-1`: its card declared `declaredRows` and surfaced `emailBodies`. */
function card(over: Record<string, unknown> = {}, emailBodies: unknown = approved, declaredRows: unknown[] = [LIST_ROW, ARTIFACTS_ROW]) {
  return {
    id: "d-1",
    status: "released",
    decidedBy: "user-2",
    surfacedValues: { campaignId: "camp-1", recipients: approved.map((e) => ({ email: e.recipientEmail, subject: e.subject })), emailBodies },
    declaredRows,
    ...over,
  };
}
const NO_LIST_CARD = card({ surfacedValues: { campaignId: "camp-1" } }, undefined, [{ label: "From", input: "senderEmail" }]);

function fixture(over: Partial<TriggerEmailSendDeps> & { decision?: unknown } = {}) {
  const { decision = card(), ...deps } = over;
  const sendEmail = vi.fn(async () => ({ providerId: "p", providerMessageId: "m", sentAt: "2026-11-26T00:00:00Z" }));
  const getObjectByRef = vi.fn(async (ref: string) =>
    ref === "draft-ref"
      ? { id: ref, type: "b", data: { cinatraAgentRunId: "run-1", drafts: [1, 2].map((n) => ({ contactId: `c${n}`, subject: `S${n}`, body: `B${n}` })) } }
      : ref === "recip-ref"
        ? { id: ref, type: "r", data: { confirmedRecipients: [1, 2].map((n) => ({ contactId: `c${n}`, email: `p${n}@example.com` })) } }
        : null,
  );
  const emitEmailFanout = vi.fn(async () => ({ bodies: [], skipped: { bodies: false } }));
  const readCallingRun = vi.fn(async () => ({ runId: "run-1", stepId: "send", claim: { runId: "run-1", decisionId: "d-1" } }));
  const readPublishDecision = vi.fn(async () => decision as never);
  const readClaimedPublishDecision = vi.fn(async () => decision as never);
  const full = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail,
    getObjectByRef,
    emitEmailFanout,
    readCallingRun,
    readPublishDecision,
    readClaimedPublishDecision,
    ...deps,
  } as unknown as TriggerEmailSendDeps;
  const uc = createTriggerEmailSendUseCases(full);
  return {
    sendEmail,
    getObjectByRef,
    emitEmailFanout,
    readCallingRun,
    readPublishDecision,
    readClaimedPublishDecision,
    start: () => uc.startInitialSend(input as never, actor) as unknown as Promise<Record<string, unknown>>,
    status: () => uc.getInitialSendStatus({ campaignId: "camp-1" } as never, actor) as unknown as Promise<Record<string, unknown>>,
  };
}

let consoleCalls: unknown[][] = [];
beforeEach(() => {
  listOverride.code = undefined;
  consoleCalls = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
  }
});
afterEach(() => vi.restoreAllMocks());

describe("the road of an initial send (cinatra#3089)", () => {
  it("R1 a call with no claim takes the old road and reads no decision", async () => {
    for (const calling of [null, { runId: "run-1", stepId: "send" }]) {
      const readCallingRun = vi.fn(async () => calling);
      const f = fixture({ readCallingRun });
      expect(await f.start()).toMatchObject({ status: "completed", sentCount: 2 });
      expect(f.sendEmail).toHaveBeenCalledTimes(2);
      // The run of the call is read on every send (on main it is never read).
      expect(readCallingRun).toHaveBeenCalledTimes(1);
      expect(f.readPublishDecision).not.toHaveBeenCalled();
      expect(f.readClaimedPublishDecision).not.toHaveBeenCalled();
    }
  });

  it("R2 a claimed call whose released decision's card declared no list takes the old road", async () => {
    const f = fixture({ decision: NO_LIST_CARD });
    expect(await f.start()).toMatchObject({ status: "completed", sentCount: 2 });
    expect(f.readClaimedPublishDecision).toHaveBeenCalledWith("run-1", "d-1");
    expect(f.sendEmail.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { to: ["p1@example.com"], subject: "S1", textBody: "B1", fromEmail: "s@cinatra.ai" },
      { to: ["p2@example.com"], subject: "S2", textBody: "B2", fromEmail: "s@cinatra.ai" },
    ]);
  });

  it("R3 a claimed call with a released list of the exact form is refused: the released-list send is not available yet", async () => {
    const f = fixture();
    const answer = await f.start();
    expect(answer).toMatchObject({ status: "failed", sentCount: 0, errorMessage: "approved_send_unavailable" });
    expect(f.sendEmail).not.toHaveBeenCalled();
    expect(f.getObjectByRef).not.toHaveBeenCalled();
    expect(f.emitEmailFanout).not.toHaveBeenCalled();
    expect((await f.status()).errorMessage).toBe("approved_send_unavailable");
  });

  const claimOf = (over: Record<string, unknown>) => vi.fn(async () => ({ runId: "run-1", stepId: "send", claim: { runId: "run-1", decisionId: "d-1" }, ...over }));
  const cases: Array<[string, Partial<TriggerEmailSendDeps> & { decision?: unknown }]> = [
    ["calling_run_unreadable", { readCallingRun: vi.fn(async () => { throw new Error(SECRET); }) }],
    ["claim_without_step", { readCallingRun: claimOf({ stepId: undefined }) }],
    ["decision_claim_other_run", { readCallingRun: claimOf({ claim: { runId: "run-2", decisionId: "d-1" } }) }],
    ["decision_claim_conflict", { readCallingRun: claimOf({ publishDecisionId: "d-9" }) }],
    ["decision_unreadable", { readPublishDecision: vi.fn(async () => { throw new Error(SECRET); }) }],
    ["decision_missing", { readPublishDecision: vi.fn(async () => null) }],
    ["decision_signed_other", { readCallingRun: claimOf({ publishDecisionId: "d-1" }), readPublishDecision: vi.fn(async () => card({ id: "d-0" }) as never) }],
    ["decision_claim_unreadable", { readClaimedPublishDecision: vi.fn(async () => { throw new Error(SECRET); }) }],
    ["decision_claim_not_current", { readClaimedPublishDecision: vi.fn(async () => null) }],
    ["decision_claim_superseded", { readPublishDecision: vi.fn(async () => card({ id: "d-2" }) as never) }],
    ["decision_not_released", { decision: card({ status: "parked", decidedBy: SECRET }) }],
    ["released_list_malformed", { decision: card({}, approved.map((e) => ({ ...e, note: SECRET }))) }],
    ["released_list_ambiguous", { decision: card({ surfacedValues: { ...card().surfacedValues, other: approved } }) }],
    ["released_list_not_shown", { decision: card({ surfacedValues: { ...card().surfacedValues, recipients: [{ email: SECRET }] } }) }],
    ["released_list_bodies_not_drawn", { decision: card({}, approved, [LIST_ROW]) }],
  ];
  for (const [code, over] of cases) {
    it(`C ${code}: refused with the fixed code, nothing fetched or mailed, no raw text anywhere`, async () => {
      const f = fixture(over);
      const answer = await f.start();
      expect(answer).toMatchObject({ status: "failed", sentCount: 0, errorMessage: code });
      expect(f.sendEmail).not.toHaveBeenCalled();
      expect(f.getObjectByRef).not.toHaveBeenCalled();
      expect(f.emitEmailFanout).not.toHaveBeenCalled();
      expect(JSON.stringify(answer)).not.toMatch(LEAKS);
      expect(JSON.stringify(await f.status())).not.toMatch(LEAKS);
      expect(JSON.stringify(consoleCalls)).not.toMatch(LEAKS);
    });
  }

  it("S a reader's own returned refusal text never reaches the answer", async () => {
    const f = fixture({ decision: card({ status: "parked" }) });
    const answer = await f.start();
    expect(answer.errorMessage).toBe("decision_not_released");
    expect(String(answer.errorMessage)).not.toContain("is not released by a person");
  });

  it("G a code outside the closed set answers claimed_send_refused", async () => {
    listOverride.code = SECRET;
    const f = fixture();
    const answer = await f.start();
    expect(answer).toMatchObject({ status: "failed", sentCount: 0, errorMessage: "claimed_send_refused" });
    expect(JSON.stringify(answer)).not.toMatch(LEAKS);
    expect(f.sendEmail).not.toHaveBeenCalled();
  });

  /** The frame the MCP transport builds for a model-bridge call (index.tsx requestStore): the on-behalf-of token's run,
   *  its signed step and its signed publish decision; no publish claim (only the passthrough route writes one). */
  const bridgeFrame = (over: Record<string, unknown> = {}) => ({
    userId: "user-1",
    orgId: "org-1",
    runId: "run-1",
    verifiedStepId: "send",
    verifiedExecutedSource: { stepId: "send" },
    verifiedPublishDecisionId: "d-1",
    delegatedActor: {
      delegation: "agent_run", userId: "user-1", orgId: "org-1", runId: "run-1", platformRole: "member",
      verifiedStepId: "send", verifiedExecutedSource: { stepId: "send" }, verifiedPublishDecisionId: "d-1",
    },
    ...over,
  });
  /** The frame the passthrough route runs a call in: its verified run and step, and the claim it took. */
  const passthroughFrame = { userId: "user-1", orgId: "org-1", runId: "run-1", verifiedRunScopeId: "run-1", verifiedStepId: "send", publishCallClaim: { runId: "run-1", decisionId: "d-1" } };
  /** In the frame `frame`, with the DEFAULT reader of the call's run (the server's context, never an injected run). */
  const inFrame = (frame: unknown, over: Partial<TriggerEmailSendDeps> & { decision?: unknown } = {}) => {
    const f = fixture({ readCallingRun: undefined, ...over });
    return { ...f, start: () => mcpRequestContextStorage.run(frame as never, () => f.start()) };
  };

  it("K1 a model-bridge call with a verified decision and a released list of the exact form is refused approved_send_unavailable", async () => {
    const f = inFrame(bridgeFrame());
    expect(await f.start()).toMatchObject({ status: "failed", sentCount: 0, errorMessage: "approved_send_unavailable" });
    expect(f.readPublishDecision).toHaveBeenCalledWith("run-1", "send");
    expect(f.readClaimedPublishDecision).toHaveBeenCalledWith("run-1", "d-1");
    expect(f.sendEmail).not.toHaveBeenCalled();
    expect(f.getObjectByRef).not.toHaveBeenCalled();
  });

  it("K2 a model-bridge call whose decision's card declared no list takes the old road", async () => {
    const f = inFrame(bridgeFrame(), { decision: NO_LIST_CARD });
    expect(await f.start()).toMatchObject({ status: "completed", sentCount: 2 });
    expect(f.readClaimedPublishDecision).toHaveBeenCalledWith("run-1", "d-1");
  });

  it("K3 a model-bridge call whose verified decision is of another step or another run is refused", async () => {
    // The step's governing decision is another one: the signed decision is not the one of this step.
    const otherStep = inFrame(bridgeFrame(), { readPublishDecision: vi.fn(async () => card({ id: "d-0" }) as never) });
    expect(await otherStep.start()).toMatchObject({ status: "failed", errorMessage: "decision_signed_other" });
    // The run holds no decision of that id (another run's decision, or an ended attempt's).
    const otherRun = inFrame(bridgeFrame(), { readClaimedPublishDecision: vi.fn(async () => null) });
    expect(await otherRun.start()).toMatchObject({ status: "failed", errorMessage: "decision_claim_not_current" });
    for (const g of [otherStep, otherRun]) expect(g.sendEmail).not.toHaveBeenCalled();
  });

  it("K4 a governed call with no verified step is refused", async () => {
    const f = fixture({ readCallingRun: vi.fn(async () => ({ runId: "run-1", publishDecisionId: "d-1" })) });
    expect(await f.start()).toMatchObject({ status: "failed", sentCount: 0, errorMessage: "claim_without_step" });
    expect(f.readPublishDecision).not.toHaveBeenCalled();
    expect(f.sendEmail).not.toHaveBeenCalled();
  });

  it("K5 a passthrough call with a claim is routed from the frame", async () => {
    const f = inFrame(passthroughFrame);
    expect(await f.start()).toMatchObject({ status: "failed", sentCount: 0, errorMessage: "approved_send_unavailable" });
    expect(f.readClaimedPublishDecision).toHaveBeenCalledWith("run-1", "d-1");
    const old = inFrame(passthroughFrame, { decision: NO_LIST_CARD });
    expect(await old.start()).toMatchObject({ status: "completed", sentCount: 2 });
  });

  it("K6 a call in a frame with neither a claim nor a verified decision takes the old road and reads no decision", async () => {
    const frames = [
      undefined,
      { userId: "user-1", orgId: "org-1" },
      bridgeFrame({ verifiedPublishDecisionId: undefined, delegatedActor: { ...bridgeFrame().delegatedActor, verifiedPublishDecisionId: undefined } }),
      { ...passthroughFrame, publishCallClaim: undefined },
    ];
    for (const frame of frames) {
      const f = frame === undefined ? fixture({ readCallingRun: undefined }) : inFrame(frame);
      expect(await f.start()).toMatchObject({ status: "completed", sentCount: 2 });
      expect(f.readPublishDecision).not.toHaveBeenCalled();
      expect(f.readClaimedPublishDecision).not.toHaveBeenCalled();
    }
  });

  it("U a governed call whose decision recorded no declaration is refused released_list_undetermined, on both roads", async () => {
    const unrecorded = [card({ declaredRows: null }), { ...NO_LIST_CARD, declaredRows: null }];
    for (const decision of unrecorded) {
      for (const frame of [bridgeFrame(), passthroughFrame]) {
        const f = inFrame(frame, { decision });
        expect(await f.start()).toMatchObject({ status: "failed", sentCount: 0, errorMessage: "released_list_undetermined" });
        expect(f.sendEmail).not.toHaveBeenCalled();
        expect(f.getObjectByRef).not.toHaveBeenCalled();
      }
    }
    // A recorded empty declaration is no list: the old road.
    const empty = inFrame(bridgeFrame(), { decision: { ...NO_LIST_CARD, declaredRows: [] } });
    expect(await empty.start()).toMatchObject({ status: "completed", sentCount: 2 });
  });
});
