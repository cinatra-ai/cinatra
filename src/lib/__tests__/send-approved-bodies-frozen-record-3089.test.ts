/**
 * cinatra#3089 — at send time the campaign bundle is a pointer, never the
 * record of what a person approved.
 *
 * The bundle schemas let an agent change a bundle after the approval, so the
 * send takes nothing a person approved from it:
 *   - the address and the subject of each message are those of the publish
 *     decision a person released for the calling step (its frozen values, and
 *     a list row of the card that showed them); the bundle's own values only
 *     refuse the send when they differ;
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
 *   A1 after the approval, an address changed in the bundle and the same new
 *      address named in the approved bodies: refused, nothing claimed or mailed
 *   A2 the same for a subject
 *   A3 the released decision's values are mailed, the address as the card
 *      showed it
 *   A4 no released decision, an unreadable one, or a call without a verified
 *      step: refused before anything is bound
 *   A5 a list the decision showed, but no list row of its card showing each
 *      address and subject: refused
 *   B1 an empty `cinatraAgentRunId` beside a valid `cinatra_agent_run_id`, no
 *      approved bodies, the run has bodies filed for review: refused
 *   B2 the same with no run on the call: every run either bundle names is
 *      looked up, and the send is refused
 *   B3 a bundle that names another run changes nothing: the approved form
 *      binds and claims under the run of the call
 *   B4 approved bodies on a call that carries no run: refused
 *   K1 two drafts sharing one draft id, each with its own approved body: both
 *      are mailed once
 *   K2 one approved body named twice: refused before anything is claimed
 *   K3 a draft id changed after a send: nobody is mailed again
 *   G1 each bind carries the campaign of the call and the contact of the
 *      approved list (recorded on the body for the campaign views), never a
 *      bundle field; a second send binds the same and mails nobody
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

function memorySendLedger() {
  const rows = new Map<string, { id: string; phase: "claimed" | "finalized" }>();
  let next = 0;
  const ledger: MessageSendLedger = {
    async claim(m) {
      const row = rows.get(m.outputId);
      if (row) return { kind: row.phase === "finalized" ? "sent" : "in_doubt" };
      next += 1;
      rows.set(m.outputId, { id: `send-${next}`, phase: "claimed" });
      return { kind: "won", ledgerId: `send-${next}` };
    },
    async markSent(id) {
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

/** The publish decision a person released: the card's Recipients list row and
 *  its Emails row, drawn from the frozen values. */
function releasedCard(entries: Entry[]) {
  return {
    surfacedValues: {
      recipients: entries.map((e) => ({ name: e.contactId, email: e.recipientEmail, subject: e.subject })),
      emailBodies: entries,
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
  reviewedRuns?: string[];
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
      data: {},
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
  const reviewedRuns = new Set(opts?.reviewedRuns ?? []);
  const readRunReviewedBodies = vi.fn(async (runId: string) => reviewedRuns.has(runId));
  const callingRun = opts?.callingRun === undefined ? { runId: "run-1", stepId: "send" } : opts.callingRun;
  const readReleasedPublishDecision = vi.fn(async () =>
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
    readRunReviewedBodies,
    readCallingRun: async () => callingRun,
    readReleasedPublishDecision,
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
  return { sent, sendEmail, bindBody, writeBody, sendLedger, readRunReviewedBodies, readReleasedPublishDecision, start };
}

async function expectNothingDone(fx: ReturnType<typeof makeFixture>) {
  expect(fx.sendEmail).not.toHaveBeenCalled();
  expect(fx.bindBody).not.toHaveBeenCalled();
  expect(fx.writeBody).not.toHaveBeenCalled();
  expect(fx.sendLedger.rows.size).toBe(0);
}

describe("cinatra#3089 — what a person approved comes from the released publish decision", () => {
  it("A1 an address changed in the bundle after the approval, named again in the approved bodies, is refused", async () => {
    const changed = approved.map((e, i) => (i === 0 ? { ...e, recipientEmail: "other@example.com" } : e));
    const fx = makeFixture({
      drafts: draftsFor(changed),
      recipients: changed.map((e) => ({ contactId: e.contactId, email: e.recipientEmail })),
      decision: releasedCard(approved),
    });
    const result = await fx.start({ approvedBodies: changed });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("the approved bodies are not the list the released publish decision showed");
    await expectNothingDone(fx);
  });

  it("A2 a subject changed in the bundle after the approval, named again in the approved bodies, is refused", async () => {
    const changed = approved.map((e, i) => (i === 1 ? { ...e, subject: "Another subject" } : e));
    const fx = makeFixture({ drafts: draftsFor(changed), decision: releasedCard(approved) });
    const result = await fx.start({ approvedBodies: changed });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("the approved bodies are not the list the released publish decision showed");
    await expectNothingDone(fx);
  });

  it("A3 each message goes to the address and with the subject the released card showed", async () => {
    const shown = approved.map((e, i) => (i === 0 ? { ...e, recipientEmail: " One@Example.com " } : e));
    const fx = makeFixture({ decision: releasedCard(shown) });
    const result = await fx.start({ approvedBodies: shown });
    expect(result.status).toBe("completed");
    expect(fx.readReleasedPublishDecision).toHaveBeenCalledWith("run-1", "send");
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["One@Example.com"], subject: "Subject one", textBody: "Body of art-1" }),
      expect.objectContaining({ to: ["two@example.com"], subject: "Subject two", textBody: "Body of art-2" }),
    ]);
  });

  it.each([
    ["no released decision", { decision: null }, "no person released the publish decision of step send of run run-1"],
    ["a call without a verified step", { callingRun: { runId: "run-1" } }, "the call carries no verified step of run run-1"],
  ])("A4 %s refuses the send before anything is bound", async (_name, opts, reason) => {
    const fx = makeFixture(opts as Parameters<typeof makeFixture>[0]);
    const result = await fx.start({ approvedBodies: approved });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain(reason);
    await expectNothingDone(fx);
  });

  it("A4b a decision that cannot be read refuses the send before anything is bound", async () => {
    const fx = makeFixture();
    fx.readReleasedPublishDecision.mockRejectedValueOnce(new Error("the decision store is unavailable"));
    const result = await fx.start({ approvedBodies: approved });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain(
      "the publish decision of step send of run run-1 could not be read: the decision store is unavailable",
    );
    await expectNothingDone(fx);
  });

  it("A5 a decision whose card shows no list row with each address and subject refuses the send", async () => {
    const card = releasedCard(approved);
    // The Recipients row shows another subject for the second message than its entry carries.
    (card.surfacedValues.recipients[1] as { subject: string }).subject = "Shown subject";
    const fx = makeFixture({ decision: card });
    const result = await fx.start({ approvedBodies: approved });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("no list row of the released publish decision shows each message's address and subject");
    await expectNothingDone(fx);
  });
});

describe("cinatra#3089 — the run is the run of the call, never a bundle field", () => {
  it("B1 an empty cinatraAgentRunId beside a valid cinatra_agent_run_id does not hide the run's filed bodies", async () => {
    const fx = makeFixture({
      bundleData: { cinatraAgentRunId: "", cinatra_agent_run_id: "run-1" },
      reviewedRuns: ["run-1"],
    });
    const result = await fx.start({});
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("REVIEWED_BODIES_REQUIRED");
    await expectNothingDone(fx);
  });

  it("B2 a call without a run looks up every run either bundle names", async () => {
    const fx = makeFixture({
      callingRun: null,
      bundleData: { cinatraAgentRunId: "", cinatra_agent_run_id: "run-1" },
      reviewedRuns: ["run-1"],
    });
    const result = await fx.start({});
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("run run-1 has email bodies filed for review");
    await expectNothingDone(fx);
  });

  it("B3 a bundle that names another run changes nothing: the messages are bound and claimed under the run of the call", async () => {
    const fx = makeFixture({ bundleData: { cinatraAgentRunId: "run-other" } });
    const result = await fx.start({ approvedBodies: approved });
    expect(result.status).toBe("completed");
    // red-first-expect: expected "vi.fn()" to be called with arguments
    expect(fx.bindBody).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
    expect(fx.bindBody).not.toHaveBeenCalledWith(expect.objectContaining({ runId: "run-other" }));
    expect([...fx.sendLedger.rows.keys()]).toEqual(["email-body:run-1:art-1", "email-body:run-1:art-2"]);
  });

  it("B4 approved bodies on a call that carries no run are refused, whatever run the bundle names", async () => {
    const fx = makeFixture({ callingRun: null });
    const result = await fx.start({ approvedBodies: approved });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("the call carries no run");
    await expectNothingDone(fx);
  });
});

describe("cinatra#3089 — one message is one approved body artifact of the run", () => {
  it("K1 two drafts sharing one draft id, each with its own approved body, are both mailed once", async () => {
    const fx = makeFixture({ drafts: draftsFor(approved, ["d-1", "d-1"]) });
    const result = await fx.start({ approvedBodies: approved });
    expect(result.status).toBe("completed");
    // red-first-expect: expected undefined to be +0
    expect(result.alreadySentCount).toBe(0);
    expect(result.sentCount).toBe(2);
    expect(fx.sent.map((m) => m.to[0])).toEqual(["one@example.com", "two@example.com"]);
  });

  it("K2 one approved body named twice is refused before anything is claimed", async () => {
    const fx = makeFixture();
    const result = await fx.start({ approvedBodies: [approved[0], { ...approved[0], contactId: "c2" }] });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("approved body 2 names artifact art-1 a second time");
    await expectNothingDone(fx);
  });

  it("G1 each bind carries the campaign of the call and the contact of the approved list, never a bundle field; a second send binds the same and mails nobody", async () => {
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; subject: string; textBody: string }> = [];
    const fx = makeFixture({
      sendLedger,
      sent,
      bundleData: { cinatraAgentRunId: "run-other", campaignId: "camp-other" },
    });
    expect((await fx.start({ approvedBodies: approved })).status).toBe("completed");
    // red-first-expect: expected [] to deeply equal [ { runId: 'run-1', …(5) }, …(1) ]
    expect(fx.bindBody.mock.calls.map(([b]) => b)).toEqual(
      approved.map((e) => ({
        runId: "run-1",
        outputId: `email-body:run-1:${e.artifactId}`,
        markdown: `Body of ${e.artifactId}`,
        artifactId: e.artifactId,
        representationRevisionId: e.representationRevisionId,
        correlation: { campaignId: CAMPAIGN_ID, contactId: e.contactId },
      })),
    );
    const again = makeFixture({ sendLedger, sent });
    const result = await again.start({ approvedBodies: approved });
    expect(result).toMatchObject({ status: "completed", sentCount: 0, alreadySentCount: 2 });
    expect(again.bindBody.mock.calls.map(([b]) => b)).toEqual(fx.bindBody.mock.calls.map(([b]) => b));
    expect(sent).toHaveLength(2);
  });

  it("K3 a draft id changed after a send mails nobody again", async () => {
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; subject: string; textBody: string }> = [];
    const first = await makeFixture({ sendLedger, sent }).start({ approvedBodies: approved });
    expect(first.status).toBe("completed");
    const again = makeFixture({ sendLedger, sent, drafts: draftsFor(approved, ["d-1-renamed", "d-2"]) });
    const result = await again.start({ approvedBodies: approved });
    // red-first-expect: expected 2 to be +0
    expect(result.sentCount).toBe(0);
    expect(result.alreadySentCount).toBe(2);
    expect(sent.map((m) => m.to[0])).toEqual(["one@example.com", "two@example.com"]);
  });
});
