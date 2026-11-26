/**
 * cinatra#3089 — at send time the campaign bundle is a pointer, never the
 * record of what a person approved.
 *
 * The bundle schemas let an agent change a bundle after the approval, so the
 * send takes nothing a person approved from it, nor from the request:
 *   - the approved list, the address and the subject of each message, and the
 *     campaign are those of the publish decision a person released for the
 *     calling step (its frozen values, and a list row of the card that showed
 *     them); the bundle's own values only refuse the send when they differ;
 *   - each approved body must be filed for that campaign;
 *   - the run is the run of the call, from the server's own context of the
 *     call, never a run id written in a bundle;
 *   - one message is one approved body artifact of the run: a draft id or a
 *     list position never decides whether it was already mailed.
 *
 * The send is driven through `createTriggerEmailSendHandlers` and
 * `createTriggerEmailSendUseCases` with injected seams, the fan-out built from
 * the real `materializeEmailFanout`.
 *
 * Cases:
 *   A1 after the approval, an address changed in the bundle: refused, nothing
 *      claimed or mailed
 *   A2 the same for a subject
 *   A3 the released decision's values are mailed, the address and the
 *      subject byte for byte as the card showed them
 *   A4 a claimed decision that is not released: refused
 *   A4b a decision that cannot be read: refused before anything is bound, the
 *      reader's text not passed on
 *   A4c no claim, no decision, no list or no verified step: the old road, the
 *      bundle mailed as before (nothing bound, no send record)
 *   A5 a list the decision surfaced, but no list row of its card showing each
 *      address and subject: refused
 *   A6 two surfaced lists of approved bodies: refused
 *   A7 a released decision that carries no campaign, or another campaign than
 *      the call names: refused
 *   A8 an approved body filed for another campaign, or for none: refused
 *   B3 a bundle that names another run changes nothing: the approved form
 *      binds and claims under the run of the call
 *   B4 a call that carries no run reads no publish decision and is sent as before
 *   K1 two drafts sharing one draft id, each with its own approved body: both
 *      are mailed once
 *   K2 one approved body named twice: refused before anything is claimed
 *   K3 a draft id changed after a send: nobody is mailed again
 *   G1 each bind names the run, the message and the approved revision only (the
 *      send writes no object); a second send binds the same and mails nobody
 */
import { describe, expect, it, vi } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { createTriggerEmailSendHandlers } from "@cinatra-ai/trigger-email-send";
import {
  createTriggerEmailSendUseCases,
  EMAIL_BODY_TYPE_ID,
  materializeEmailFanout,
  type DecidedBodyRead,
  type EmailFanoutArgs,
  type MessageSendLedger,
  type TriggerEmailSendDeps,
} from "../trigger-email-send-use-cases";

// The claim the passthrough route took for the call (cinatra#3089): the decision the call was signed for, else the
// step's decision, `d-1`; each stubbed decision carries that id unless it names its own.
const withClaim = <T extends { runId: string; publishDecisionId?: string; claim?: unknown } | null>(run: T): T =>
  run && !run.claim ? { ...run, claim: { runId: run.runId, decisionId: run.publishDecisionId ?? "d-1" } } : run;
const withDecisionId = <T extends object | null | undefined>(decision: T): T =>
  decision ? ({ id: "d-1", ...decision } as T) : decision;


function memorySendLedger() {
  const rows = new Map<string, { id: string; phase: "claimed" | "finalized" }>();
  let next = 0;
  const ledger: MessageSendLedger = {
    async claim(m) {
      const row = rows.get(m.bindingOutputId);
      if (row) return { kind: row.phase === "finalized" ? "done" : "in_doubt" };
      next += 1;
      rows.set(m.bindingOutputId, { id: `send-${next}`, phase: "claimed" });
      return { kind: "won", ledgerId: `send-${next}` };
    },
    async markDone(id) {
      for (const row of rows.values()) {
        if (row.id === id && row.phase === "claimed") {
          row.phase = "finalized";
          return true;
        }
      }
      return false;
    },
    async release(id) {
      for (const [key, row] of rows) if (row.id === id && row.phase === "claimed") rows.delete(key);
    },
  };
  return { rows, ledger };
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

type Entry = {
  artifactId: string;
  representationRevisionId: string;
  contactId: string;
  recipientEmail: string;
  subject: string;
};

const approved: Entry[] = [
  { artifactId: "art-1", representationRevisionId: "rev-1", contactId: "c1", recipientEmail: "one@example.com", subject: "Subject one" },
  { artifactId: "art-2", representationRevisionId: "rev-2", contactId: "c2", recipientEmail: "two@example.com", subject: "Subject two" },
];

function draftsFor(entries: Entry[], ids: string[] = ["d-1", "d-2"]) {
  return entries.map((e, i) => ({
    id: ids[i],
    recipientId: e.contactId,
    recipientEmail: e.recipientEmail,
    subject: e.subject,
    body: `Body of ${e.artifactId}`,
  }));
}

/** The publish decision a person released for the calling step: the campaign,
 *  the card's Recipients list row and its Emails row, drawn from the frozen
 *  values. */
function releasedCard(entries: Entry[], extra: Record<string, unknown> = {}) {
  return {
    status: "released",
    decidedBy: "user-2",
    surfacedValues: {
      campaignId: CAMPAIGN_ID,
      recipients: entries.map((e) => ({ name: e.contactId, email: e.recipientEmail, subject: e.subject })),
      emailBodies: entries,
      ...extra,
    },
    declaredRows: [
      {
        kind: "list",
        label: "Recipients",
        input: "recipients",
        columns: [
          { label: "Name", field: "name" },
          { label: "Email", field: "email" },
          { label: "Subject", field: "subject" },
        ],
      },
      { kind: "artifacts", label: "Emails", input: "emailBodies" },
    ],
  };
}

function makeFixture(opts?: {
  bundleData?: Record<string, unknown>;
  drafts?: unknown[];
  recipients?: unknown[];
  callingRun?: { runId: string; stepId?: string } | null;
  decision?: unknown;
  /** false: the call carries no publish claim (the packs pinned today). */
  claim?: false;
  sendLedger?: ReturnType<typeof memorySendLedger>;
  sent?: Array<{ to: string[]; subject: string; textBody: string }>;
}) {
  const sendLedger = opts?.sendLedger ?? memorySendLedger();
  const sent = opts?.sent ?? [];
  const sendEmail = vi.fn(async (message: { to: string[]; subject: string; textBody: string }) => {
    sent.push(message);
    return { providerId: "p", providerMessageId: `m-${sent.length}`, sentAt: "2026-11-25T00:00:00Z" };
  });
  const drafts = opts?.drafts ?? draftsFor(approved);
  const envelopes: Record<string, { id: string; type: string; data: unknown }> = {
    [BUNDLE_REF]: {
      id: BUNDLE_REF,
      type: "@cinatra-ai/campaigns:email-draft-bundle",
      data: { ...(opts?.bundleData ?? { cinatraAgentRunId: "run-1" }), drafts },
    },
    [RECIPIENTS_REF]: {
      id: RECIPIENTS_REF,
      type: "@cinatra-ai/campaigns:recipients",
      data: {
        confirmedRecipients:
          opts?.recipients ?? approved.map((e) => ({ contactId: e.contactId, email: e.recipientEmail })),
      },
    },
  };
  const readDecidedBody = vi.fn(
    async (ref: { artifactId: string }): Promise<DecidedBodyRead> => ({
      ok: true,
      text: `Body of ${ref.artifactId}`,
      data: { campaignId: CAMPAIGN_ID },
    }),
  );
  const bindBody = vi.fn(
    async (b: { runId: string; outputId: string; artifactId: string; representationRevisionId: string }) => ({
      ok: true as const,
      artifactId: b.artifactId,
      representationRevisionId: b.representationRevisionId,
      deduped: false,
    }),
  );
  const writeBody = vi.fn(async (w: { outputId: string }) => ({
    ok: true as const,
    artifactId: `new-${w.outputId}`,
    representationRevisionId: `new-rev-${w.outputId}`,
    deduped: false,
  }));
  const emitEmailFanout = vi.fn((args: EmailFanoutArgs) =>
    materializeEmailFanout(args, {
      bindBody,
      writeBody,
      registeredTypes: new Set([EMAIL_BODY_TYPE_ID]),
    } as Parameters<typeof materializeEmailFanout>[1]),
  );
  const callingRun = opts?.callingRun === undefined ? { runId: "run-1", stepId: "send" } : opts.callingRun;
  const readPublishDecision = vi.fn(async () =>
    opts?.decision === undefined ? releasedCard(approved) : opts.decision,
  );
  const deps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: sendEmail as unknown as TriggerEmailSendDeps["sendEmail"],
    getObjectByRef: async (ref: string) => envelopes[ref] ?? null,
    emitEmailFanout,
    readDecidedBody,
    messageSendLedger: sendLedger.ledger,
    readCallingRun: async () => (opts?.claim === false ? callingRun : withClaim(callingRun)),
    readPublishDecision: async (runId: string, stepId: string) =>
      withDecisionId(await (readPublishDecision as (r: string, s: string) => Promise<object | null>)(runId, stepId)),
    readClaimedPublishDecision: async (_runId: string, decisionId: string) => {
      const decision = withDecisionId((await readPublishDecision()) as { id?: string } | null);
      return decision?.id === decisionId ? decision : null;
    },
  } as unknown as TriggerEmailSendDeps;
  const handlers = createTriggerEmailSendHandlers(createTriggerEmailSendUseCases(deps));
  const start = (input: Record<string, unknown>) =>
    handlers["email_outreach_send_initial_start"]({
      input: {
        campaignId: CAMPAIGN_ID,
        approvedDraftBundleRef: BUNDLE_REF,
        confirmedRecipientsRef: RECIPIENTS_REF,
        ...input,
      },
      actor,
    } as never) as unknown as Promise<{
      status: string;
      sentCount: number;
      errorMessage?: string;
      alreadySentCount?: number;
    }>;
  return {
    sent,
    sendEmail,
    bindBody,
    writeBody,
    sendLedger,
    readPublishDecision,
    readDecidedBody,
    start,
  };
}

async function expectNothingDone(fx: ReturnType<typeof makeFixture>) {
  expect(fx.sendEmail).not.toHaveBeenCalled();
  expect(fx.bindBody).not.toHaveBeenCalled();
  expect(fx.writeBody).not.toHaveBeenCalled();
  expect(fx.sendLedger.rows.size).toBe(0);
}

async function expectRefused(fx: ReturnType<typeof makeFixture>, reason: string) {
  const result = await fx.start({});
  expect(result.status).toBe("failed");
  expect(result.errorMessage).toContain(reason);
  await expectNothingDone(fx);
}

/** A released decision of the calling step that surfaced no list. */
const noListCard = { status: "released", decidedBy: "user-2", surfacedValues: { campaignId: CAMPAIGN_ID }, declaredRows: [] };

describe("cinatra#3089 — what a person approved comes from the released publish decision", () => {
  it("A1 an address changed in the bundle after the approval is refused", async () => {
    const changed = approved.map((e, i) => (i === 0 ? { ...e, recipientEmail: "other@example.com" } : e));
    const fx = makeFixture({
      drafts: draftsFor(changed),
      recipients: changed.map((e) => ({ contactId: e.contactId, email: e.recipientEmail })),
    });
    await expectRefused(fx, "draft 1 of the bundle: the recipient's address changed after the card was shown");
  });

  it("A2 a subject changed in the bundle after the approval is refused", async () => {
    const changed = approved.map((e, i) => (i === 1 ? { ...e, subject: "Another subject" } : e));
    await expectRefused(
      makeFixture({ drafts: draftsFor(changed) }),
      "draft 2 of the bundle: the subject changed after the card was shown",
    );
  });

  it("A3 each message goes to the address and with the subject the released card showed", async () => {
    // The address and the subject are sent as the card showed them, byte for byte (one shown with white space around
    // it is refused, never trimmed: send-approved-bodies-3089 B5).
    const fx = makeFixture({ decision: releasedCard(approved) });
    const result = await fx.start({});
    expect(result.status).toBe("completed");
    expect(fx.readPublishDecision).toHaveBeenCalledWith("run-1", "send");
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], subject: "Subject one", textBody: "Body of art-1" }),
      expect.objectContaining({ to: ["two@example.com"], subject: "Subject two", textBody: "Body of art-2" }),
    ]);
  });

  it.each([
    ["a parked decision", { decision: { ...releasedCard(approved), status: "parked" } }, "the released list of the publish decision was refused (decision_not_released)"],
    ["a decision no person decided", { decision: { ...releasedCard(approved), decidedBy: null } }, "(decision_not_released)"],
  ])("A4 %s refuses the send before anything is bound", async (_name, opts, reason) => {
    await expectRefused(makeFixture(opts as Parameters<typeof makeFixture>[0]), reason);
  });

  it("A4b a decision that cannot be read refuses the send before anything is bound", async () => {
    const fx = makeFixture();
    fx.readPublishDecision.mockRejectedValueOnce(new Error("the decision store is unavailable"));
    const result = await fx.start({});
    expect(result).toMatchObject({ status: "failed", sentCount: 0 });
    // The reader's text is never passed on (finding 3 of the third review): a fixed code.
    expect(result.errorMessage).toContain("the publish decision of the calling step could not be read (decision_unreadable)");
    expect(result.errorMessage).not.toContain("unavailable");
    await expectNothingDone(fx);
  });

  // A CLAIMED CALL never falls back to the old road (cinatra#3089): a claim with no decision governing the step, or a
  // claim no verified step made, is refused with a fixed code before anything is bound or mailed.
  it.each([
    ["a claim, no decision governing the step", { decision: null }, "(decision_missing)"],
    ["a claim, but no verified step", { callingRun: { runId: "run-1" } }, "(claim_without_step)"],
  ])("A4d %s: refused, never the old road", async (_name, opts, code) => {
    await expectRefused(makeFixture(opts as Parameters<typeof makeFixture>[0]), code);
  });

  // THE OLD ROAD (cinatra#3089): a send without a claim, or under a card that declared no list, is sent as before: the
  // bundle's drafts are mailed, the fan-out files one body per draft, nothing is bound and no send record is kept.
  it.each([
    ["no claim (the packs pinned today), a released decision with no list", { claim: false, decision: noListCard }],
    ["no claim, a released decision WITH a list", { claim: false }],
    ["a claim, a released decision with no list", { decision: noListCard }],
  ])("A4c %s: the old road, the bundle mailed as before", async (_name, opts) => {
    const fx = makeFixture(opts as Parameters<typeof makeFixture>[0]);
    const result = await fx.start({});
    expect(result).toMatchObject({ status: "completed", sentCount: 2 });
    expect(result.alreadySentCount).toBeUndefined();
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], subject: "Subject one", textBody: "Body of art-1" }),
      expect.objectContaining({ to: ["two@example.com"], subject: "Subject two", textBody: "Body of art-2" }),
    ]);
    expect(fx.writeBody).toHaveBeenCalledTimes(2);
    expect(fx.bindBody).not.toHaveBeenCalled();
    expect(fx.readDecidedBody).not.toHaveBeenCalled();
    expect(fx.sendLedger.rows.size).toBe(0);
    if ((opts as { claim?: false }).claim === false) expect(fx.readPublishDecision).not.toHaveBeenCalled();
  });

  it("A5 a decision whose card shows no list row with each address and subject refuses the send", async () => {
    const card = releasedCard(approved);
    // The Recipients row shows another subject for the second message than its entry carries.
    (card.surfacedValues.recipients[1] as { subject: string }).subject = "Shown subject";
    await expectRefused(
      makeFixture({ decision: card }),
      "the released list of the publish decision was refused (released_list_not_shown)",
    );
  });

  it("A6 two surfaced lists of approved bodies refuse the send", async () => {
    const card = releasedCard(approved, { otherBodies: JSON.stringify(approved) });
    await expectRefused(makeFixture({ decision: card }), "the released list of the publish decision was refused (released_list_ambiguous)");
  });

  it.each([
    ["carries no campaign", { campaignId: undefined }, "the released publish decision carries no campaign (campaign_missing)"],
    ["carries an empty campaign", { campaignId: "  " }, "the released publish decision carries no campaign"],
    ["carries another campaign", { campaignId: "44444444-4444-4444-8444-444444444444" }, "the call names another campaign than the released publish decision carries"],
  ])("A7 a released decision that %s refuses the send", async (_name, extra, reason) => {
    const card = releasedCard(approved, extra);
    if (extra.campaignId === undefined) delete (card.surfacedValues as Record<string, unknown>).campaignId;
    await expectRefused(makeFixture({ decision: card }), reason);
  });

  it.each([
    ["another campaign", { campaignId: "44444444-4444-4444-8444-444444444444" }],
    ["no campaign", {}],
  ])("A8 an approved body filed for %s refuses the send", async (_name, data) => {
    const fx = makeFixture();
    fx.readDecidedBody.mockImplementation(async (ref: { artifactId: string }) => ({
      ok: true,
      text: `Body of ${ref.artifactId}`,
      data: ref.artifactId === "art-2" ? data : { campaignId: CAMPAIGN_ID },
    }));
    await expectRefused(fx, `approved body 2 is not filed for the released campaign`);
  });
});

describe("cinatra#3089 — the run is the run of the call, never a bundle field", () => {
  it("B3 a bundle that names another run changes nothing: the messages are bound and claimed under the run of the call", async () => {
    const fx = makeFixture({ bundleData: { cinatraAgentRunId: "run-other" } });
    const result = await fx.start({});
    expect(result.status).toBe("completed");
    expect(fx.bindBody).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
    expect(fx.bindBody).not.toHaveBeenCalledWith(expect.objectContaining({ runId: "run-other" }));
    expect([...fx.sendLedger.rows.keys()]).toEqual(["email-body:run-1:art-1", "email-body:run-1:art-2"]);
  });

  it("B4 a call that carries no run reads no publish decision and is sent as before", async () => {
    const fx = makeFixture({ callingRun: null });
    const result = await fx.start({});
    expect(result).toMatchObject({ status: "completed", sentCount: 2 });
    expect(fx.readPublishDecision).not.toHaveBeenCalled();
    expect(fx.readDecidedBody).not.toHaveBeenCalled();
    expect(fx.bindBody).not.toHaveBeenCalled();
    expect(fx.sendLedger.rows.size).toBe(0);
  });
});

describe("cinatra#3089 — one message is one approved body artifact of the run", () => {
  it("K1 two drafts sharing one draft id, each with its own approved body, are both mailed once", async () => {
    const fx = makeFixture({ drafts: draftsFor(approved, ["d-1", "d-1"]) });
    const result = await fx.start({});
    expect(result.status).toBe("completed");
    expect(result.alreadySentCount).toBe(0);
    expect(result.sentCount).toBe(2);
    expect(fx.sent.map((m) => m.to[0])).toEqual(["one@example.com", "two@example.com"]);
  });

  it("K2 one approved body named twice is refused before anything is claimed", async () => {
    const twice = [approved[0]!, { ...approved[0]!, contactId: "c2", recipientEmail: "two@example.com", subject: "Subject two" }];
    await expectRefused(makeFixture({ decision: releasedCard(twice) }), "approved body 2 names an artifact a second time");
  });

  it("G1 each bind names the run, the message and the approved revision only; a second send binds the same and mails nobody", async () => {
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; subject: string; textBody: string }> = [];
    const fx = makeFixture({
      sendLedger,
      sent,
      bundleData: { cinatraAgentRunId: "run-other", campaignId: "camp-other" },
    });
    expect((await fx.start({})).status).toBe("completed");
    expect(fx.bindBody.mock.calls.map(([b]) => b)).toEqual(
      approved.map((e) => ({
        runId: "run-1",
        outputId: `email-body:run-1:${e.artifactId}`,
        markdown: `Body of ${e.artifactId}`,
        artifactId: e.artifactId,
        representationRevisionId: e.representationRevisionId,
      })),
    );
    const again = makeFixture({ sendLedger, sent });
    const result = await again.start({});
    expect(result).toMatchObject({ status: "completed", sentCount: 0, alreadySentCount: 2 });
    expect(again.bindBody.mock.calls.map(([b]) => b)).toEqual(fx.bindBody.mock.calls.map(([b]) => b));
    expect(sent).toHaveLength(2);
  });

  it("K3 a draft id changed after a send mails nobody again", async () => {
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; subject: string; textBody: string }> = [];
    const first = await makeFixture({ sendLedger, sent }).start({});
    expect(first.status).toBe("completed");
    const again = makeFixture({ sendLedger, sent, drafts: draftsFor(approved, ["d-1-renamed", "d-2"]) });
    const result = await again.start({});
    expect(result.sentCount).toBe(0);
    expect(result.alreadySentCount).toBe(2);
    expect(sent.map((m) => m.to[0])).toEqual(["one@example.com", "two@example.com"]);
  });
});
