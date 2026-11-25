/**
 * cinatra#3089 — the campaign send mails exactly the email bodies a person
 * approved.
 *
 * The approved list is read from the publish decision a person released for
 * the calling step (here a stubbed decision: `releasedList` in a case is the
 * list that decision surfaced; the request carries no list): each entry an
 * `email:body` artifact revision plus the contact of the draft it is the body
 * of. Given, the send mails, for each draft with an address, the text of ITS
 * approved revision (never the bundle's body), refuses the whole send before
 * any mail on every gap, and the fan-out binds each message to the approved
 * revision instead of filing a new body. Without a released list the send
 * reads the bundle exactly as before, unless the run filed bodies for review.
 *
 * NO RUN REACHES THIS SEND YET. The MCP boundary refuses every call of
 * `email_outreach_send_initial_start` made on a run's frame (the outward-effect
 * set in src/lib/authz/mcp-boundary.ts, on main since cinatra#3757), so on main
 * a run sends no initial email at all, and this change closes no road that
 * works there. The road a run will take is the declared publishing step's call
 * on the passthrough route (pull request #4788, merged after this one), which
 * runs this use case in the run's frame with the verified run, step and
 * decision. These tests make the send exact and safe for that road; they drive
 * the use case directly.
 *
 * The send is driven through `createTriggerEmailSendHandlers` and
 * `createTriggerEmailSendUseCases` with injected seams: the objects reads, the
 * transport, the approved-body reader (a fake artifact store that answers only
 * an artifact's current revision) and a fan-out built from the real
 * `materializeEmailFanout`.
 *
 * Cases:
 *   S1 the approved form mails the approved revision's text and the subject the
 *      card showed; the bundle's draft holds the same text, here with trailing
 *      white space the revision does not carry
 *   R1 a draft with an address and no approved body refuses the whole send
 *   R2 an approved revision that cannot be read refuses the whole send
 *   R3 an approved revision that is not the artifact's current revision (a body
 *      filed again after the approval) refuses the whole send
 *   R4 a revision of another organization or type refuses the whole send
 *   R5 the list names one body twice
 *   R6 the list names a body that maps to no draft
 *   R7 two bodies for one contact
 *   R8 a body that carries another contact than its entry
 *   U1 the reference-only form is unchanged for a run without bodies filed for
 *      review: the bundle body is mailed and no approved body is read
 *   U2 a run whose drafting step filed bodies for review refuses a send that
 *      names no approved body, before any mail and any body write
 *   U3 a run whose filed bodies cannot be looked up refuses that send too
 *   P1 two approved bodies that name no contact, swapped between the drafts
 *      (each entry with the other draft's contact, address and subject): the
 *      whole send is refused, nothing is bound, claimed or mailed
 *   P2 the same two bodies, not swapped, are sent
 *   P3 two swapped bodies with the same text are sent: each recipient receives
 *      exactly the text its own draft holds and the card showed
 *   P4 a draft whose body was changed in the bundle after its body was filed
 *      refuses the whole send
 *   F1 the fan-out binds each mailed message to its approved revision and
 *      files no new body (nor one for a draft without an address)
 *   Z1 a request carrying `approvedBodies` cannot change what is mailed: the
 *      tool's schema drops the key, and the send reads only the decision
 *   C1-C9 each message is mailed only to the address and with the subject the
 *      publish card showed: a change in the bundle, the recipients list or the
 *      draft's subject refuses the whole send before any claim and names no
 *      address; the mailed subject is the entry's, byte for byte, whatever a
 *      body artifact's own `subject` field holds; equal values are sent, an
 *      address in another letter case is refused;
 *      a list surfaced as JSON text is refused before any claim: the card
 *      draws no bodies from it
 *   G1-G5 the send reads the decision that governs its call through the one
 *      resolution the publishing call guard claims under (a step nested in a
 *      publishing node, or signed with the node's own id, reads the node's
 *      decision), a call signed for a decision is served by that one only, and
 *      a publishing step that holds no decision is refused, never sent in the
 *      reference-only form
 *   B1-B6 what is sent is byte for byte what the card showed: a candidate
 *      subject or address that differs from the shown one in spaces, a
 *      non-breaking space, letter case or Unicode normalisation is refused;
 *      an equal one is sent exactly as shown; an id, address, sender or
 *      campaign carried with white space around it is refused, never trimmed
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real resolution of the decision that governs a call (the send's default
// reader, readGoverningPublishDecision, which the publishing call guard also
// claims under), over stubbed reads: the run and its template, the graph the
// run is bound to execute, and the decision rows by step. The released-list
// readers of the decision store stay real.
const governing = vi.hoisted(() => ({
  readAgentRunById: vi.fn(async (): Promise<unknown> => ({ id: "run-1", templateId: "tmpl-1" })),
  readAgentTemplateById: vi.fn(async (): Promise<unknown> => ({ id: "tmpl-1", publishingSteps: ["publish"] })),
  readDecisionForRunNode: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  readLatestDecisionForRun: vi.fn(async (): Promise<unknown> => null),
  readRunBoundGraph: vi.fn(async (): Promise<string | null> => null),
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
}));
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { createTriggerEmailSendHandlers } from "@cinatra-ai/trigger-email-send";
import { serviceAndCampaignIdSchema } from "../../../packages/trigger-email-send/src/mcp/schemas";
import {
  createTriggerEmailSendUseCases,
  emailBodyExternalId,
  EMAIL_BODY_TYPE_ID,
  materializeEmailFanout,
  type DecidedBodyRead,
  type EmailFanoutArgs,
  type CallingRun,
  type MessageSendLedger,
  type StepPublishDecision,
  type TriggerEmailSendDeps,
} from "../trigger-email-send-use-cases";

/** A stand-in for the message send records with the claim's semantics: the
 *  first claim of a message wins (checked and set with no await between, so
 *  concurrent calls cannot both win), a sent message reads "sent", and a
 *  claimed one that was never marked reads "in_doubt". */
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

/** The publish decision a person released for the calling step, surfacing the
 *  list a case names (cinatra#3089): the campaign, the card's Recipients list
 *  row and its Emails row, drawn from the frozen values. Called with no list,
 *  it is a released decision that surfaced none (the fixture's reader answers
 *  no decision at all for a case that names no list). */
function releasedCardFor(named: unknown, campaignId: unknown = CAMPAIGN_ID, shownList?: unknown) {
  // The Recipients row draws the released list itself, or the records a case
  // names as `shownList` (what the card showed, when it differs).
  const list = (shownList ?? (named === undefined ? [] : typeof named === "string" ? JSON.parse(named) : named)) as Array<{
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

// The bundle as the drafting step saves it: each draft names its contact as
// `recipientId`; c3 has no address and is never mailed. Each draft holds the
// text its body was filed from, here with trailing blank lines the filed
// revision does not carry (trailing white space is not compared).
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

type StoredBody = {
  orgId: string;
  type: string;
  latest: string;
  revisions: Record<string, string>;
  data: Record<string, unknown>;
};

/** The approved bodies as the artifact store holds them: one current revision
 *  each. */
function makeStore(): Map<string, StoredBody> {
  return new Map<string, StoredBody>([
    [
      "art-1",
      {
        orgId: "org-1",
        type: EMAIL_BODY_TYPE_ID,
        latest: "rev-1",
        revisions: { "rev-1": "Approved body one" },
        data: { subject: "Bundle subject one", contactId: "c1", campaignId: CAMPAIGN_ID },
      },
    ],
    [
      "art-2",
      {
        orgId: "org-1",
        type: EMAIL_BODY_TYPE_ID,
        latest: "rev-2",
        revisions: { "rev-2": "Approved body two" },
        data: { campaignId: CAMPAIGN_ID },
      },
    ],
  ]);
}

// Each entry carries what the publish card showed for its message: the
// address and the subject of its draft, which is the subject the send mails.
// art-1 also carries a subject of its own, equal to its draft's; art-2 has none.
const approved = [
  { artifactId: "art-1", representationRevisionId: "rev-1", contactId: "c1", recipientEmail: "one@example.com", subject: "Bundle subject one" },
  { artifactId: "art-2", representationRevisionId: "rev-2", contactId: "c2", recipientEmail: "two@example.com", subject: "Bundle subject two" },
];

function makeFixture(opts?: {
  store?: Map<string, StoredBody>;
  drafts?: unknown[];
  recipients?: unknown[];
  /** What the ledger answers for "the run has bodies filed for review". */
  reviewedBodies?: boolean | Error;
  /** The run, verified step and signed decision of the call. */
  callingRun?: CallingRun;
  /** The decision read; null leaves the send's own default reader. */
  readPublishDecision?: TriggerEmailSendDeps["readPublishDecision"] | null;
}) {
  const store = opts?.store ?? makeStore();
  const sendLedger = memorySendLedger();
  const sent: Array<{ to: string[]; subject: string; textBody: string }> = [];
  const sendEmail = vi.fn(async (message: { to: string[]; subject: string; textBody: string }) => {
    sent.push(message);
    return { providerId: "p", providerMessageId: `m-${sent.length}`, sentAt: "2026-11-24T00:00:00Z" };
  });
  const envelopes: Record<string, { id: string; type: string; data: unknown }> = {
    [BUNDLE_REF]: {
      id: BUNDLE_REF,
      type: "@cinatra-ai/campaigns:email-draft-bundle",
      data: { cinatraAgentRunId: "run-1", drafts: opts?.drafts ?? bundleDrafts },
    },
    [RECIPIENTS_REF]: {
      id: RECIPIENTS_REF,
      type: "@cinatra-ai/campaigns:recipients",
      data: { confirmedRecipients: opts?.recipients ?? confirmedRecipients },
    },
  };
  // The approved-body reader: only the artifact's current revision of the body
  // type in the actor's organization is read; anything else is refused.
  const readDecidedBody = vi.fn(
    async (
      ref: { artifactId: string; representationRevisionId: string },
      a: PrimitiveActorContext,
    ): Promise<DecidedBodyRead> => {
      const row = store.get(ref.artifactId);
      if (!row || row.orgId !== a.orgId) {
        return { ok: false, error: `artifact ${ref.artifactId} is not a live artifact of organization ${a.orgId}` };
      }
      if (row.type !== EMAIL_BODY_TYPE_ID) {
        return { ok: false, error: `artifact ${ref.artifactId} is of type "${row.type}"` };
      }
      if (row.latest !== ref.representationRevisionId) {
        return { ok: false, error: `revision ${ref.representationRevisionId} is not its current revision` };
      }
      const text = row.revisions[ref.representationRevisionId];
      if (text === undefined) return { ok: false, error: "the revision could not be read" };
      return { ok: true, text, data: row.data };
    },
  );
  const writeBody = vi.fn(async (w: { outputId: string }) => ({
    ok: true as const,
    artifactId: `new-${w.outputId}`,
    representationRevisionId: `new-rev-${w.outputId}`,
    deduped: false,
  }));
  const bindBody = vi.fn(
    async (b: { artifactId: string; representationRevisionId: string; markdown: string }) => ({
      ok: true as const,
      artifactId: b.artifactId,
      representationRevisionId: b.representationRevisionId,
      deduped: false,
    }),
  );
  const emitEmailFanout = vi.fn((args: EmailFanoutArgs) =>
    materializeEmailFanout(args, {
      writeBody,
      bindBody,
      registeredTypes: new Set([EMAIL_BODY_TYPE_ID]),
    } as Parameters<typeof materializeEmailFanout>[1]),
  );
  // The decision the send asks for: a case reads which step it asked for.
  // A case that names no list calls from a step no publish decision governs.
  const readPublishDecision = vi.fn(async (_runId: string, _stepId: string): Promise<StepPublishDecision | null> =>
    named === undefined ? null : releasedCardFor(named, CAMPAIGN_ID, shown));
  const readRunReviewedBodies = vi.fn(async (_runId: string) => {
    const answer = opts?.reviewedBodies ?? false;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const deps: TriggerEmailSendDeps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: sendEmail as unknown as TriggerEmailSendDeps["sendEmail"],
    getObjectByRef: async (ref) => envelopes[ref] ?? null,
    emitEmailFanout,
    readDecidedBody,
    messageSendLedger: sendLedger.ledger,
    readRunReviewedBodies,
    // The runs the host recorded as writers of each object: here the run the
    // object's data names, as a host records the run that saved it.
    readObjectRuns: async (id: string) => {
      const d = (envelopes[id]?.data ?? {}) as Record<string, unknown>;
      return typeof d.cinatraAgentRunId === "string" ? [d.cinatraAgentRunId] : [];
    },
    readCallingRun: async () => opts?.callingRun ?? { runId: "run-1", stepId: "send" },
    ...(opts?.readPublishDecision === null ? {} : { readPublishDecision: opts?.readPublishDecision ?? readPublishDecision }),
  } as unknown as TriggerEmailSendDeps;
  let named: unknown;
  let shown: unknown;
  const handlers = createTriggerEmailSendHandlers(createTriggerEmailSendUseCases(deps));
  // `releasedList` is what the stubbed decision surfaced; every other key goes
  // to the tool as the request.
  const start = (input: Record<string, unknown>) => {
    const { releasedList, shownList, ...request } = input;
    named = releasedList;
    shown = shownList;
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
  return {
    store,
    sent,
    sendEmail,
    readDecidedBody,
    readRunReviewedBodies,
    readPublishDecision,
    writeBody,
    bindBody,
    emitEmailFanout,
    sendLedger,
    start,
    deps,
  };
}

async function expectRefused(
  fx: ReturnType<typeof makeFixture>,
  input: Record<string, unknown>,
  reason: string,
) {
  const result = await fx.start(input);
  expect(result.status).toBe("failed");
  expect(result.sentCount).toBe(0);
  expect(result.errorMessage).toContain(reason);
  expect(fx.sendEmail).not.toHaveBeenCalled();
  expect(fx.writeBody).not.toHaveBeenCalled();
  expect(fx.bindBody).not.toHaveBeenCalled();
}

describe("cinatra#3089 — the send mails the approved body revisions", () => {
  it("S1 the approved form mails the approved revision's text and the card's subject", async () => {
    const fx = makeFixture();
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("completed");
    expect(result.sentCount).toBe(2);
    // red-first-expect: to deeply equal [ ObjectContaining{…}, …(1) ]
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], subject: "Bundle subject one", textBody: "Approved body one" }),
      expect.objectContaining({ to: ["two@example.com"], subject: "Bundle subject two", textBody: "Approved body two" }),
    ]);
    // The revision's text, not the draft's (which ends in blank lines).
    expect(fx.sent.some((m) => m.textBody.endsWith("\n"))).toBe(false);
  });

  it("R1 a draft with an address and no approved body refuses the whole send", async () => {
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(makeFixture(), { releasedList: [approved[0]] }, "draft 2 of the bundle has an address but no approved body");
  });

  it("R2 an approved revision that cannot be read refuses the whole send", async () => {
    const store = makeStore();
    store.get("art-2")!.revisions = {};
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(makeFixture({ store }), { releasedList: approved }, "approved body 2: the revision could not be read");
  });

  it("R3 an approved revision that is not the artifact's current revision refuses the whole send", async () => {
    const store = makeStore();
    // The body was filed again after the approval: rev-1b supersedes rev-1.
    store.get("art-1")!.revisions["rev-1b"] = "Regenerated body one";
    store.get("art-1")!.latest = "rev-1b";
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(makeFixture({ store }), { releasedList: approved }, "approved body 1: revision rev-1 is not its current revision");
  });

  it("R4 a revision of another organization or of another type refuses the whole send", async () => {
    const other = makeStore();
    other.get("art-1")!.orgId = "org-2";
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(makeFixture({ store: other }), { releasedList: approved }, "is not a live artifact of organization org-1");
    const typed = makeStore();
    typed.get("art-2")!.type = "@cinatra-ai/blog:post";
    await expectRefused(makeFixture({ store: typed }), { releasedList: approved }, 'artifact art-2 is of type "@cinatra-ai/blog:post"');
  });

  it("R5 the list names one body twice", async () => {
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(
      makeFixture(),
      { releasedList: [approved[0], approved[1], { ...approved[0], contactId: "c3" }] },
      "approved body 3 names artifact art-1 a second time",
    );
  });

  it("R6 the list names a body that maps to no draft", async () => {
    const store = makeStore();
    store.set("art-9", { ...store.get("art-2")!, data: { campaignId: CAMPAIGN_ID } });
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(
      makeFixture({ store }),
      {
        releasedList: [
          ...approved,
          { artifactId: "art-9", representationRevisionId: "rev-2", contactId: "c9", recipientEmail: "nine@example.com", subject: "S" },
        ],
      },
      "approved body 3 is for contact c9, which no draft of the bundle names",
    );
  });

  it("R7 two bodies for one contact refuse the whole send", async () => {
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(
      makeFixture(),
      { releasedList: [approved[0], { ...approved[1], contactId: "c1" }] },
      "approved bodies 1 and 2 are both for contact c1",
    );
  });

  it("R8 a body that carries another contact than its entry refuses the whole send", async () => {
    const store = makeStore();
    store.get("art-2")!.data = { contactId: "c1", campaignId: CAMPAIGN_ID };
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(makeFixture({ store }), { releasedList: approved }, "approved body 2 is the body of contact c1, not of contact c2");
  });

  it("U1 the reference-only form is unchanged for a run without bodies filed for review", async () => {
    const fx = makeFixture();
    const result = await fx.start({});
    expect(result.status).toBe("completed");
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], subject: "Bundle subject one", textBody: "Approved body one\n\n" }),
      expect.objectContaining({ to: ["two@example.com"], subject: "Bundle subject two", textBody: "Approved body two\n\n" }),
    ]);
    expect(fx.readDecidedBody).not.toHaveBeenCalled();
    expect(fx.bindBody).not.toHaveBeenCalled();
    // The fan-out still files one body per draft of the bundle, as before.
    expect(fx.writeBody).toHaveBeenCalledTimes(3);
  });

  it("U2 a run with bodies filed for review refuses a send that names none of them, before any mail", async () => {
    const fx = makeFixture({ reviewedBodies: true });
    const result = await fx.start({});
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.sentCount).toBe(0);
    expect(result.errorMessage).toContain(
      "REVIEWED_ARTIFACTS_REQUIRED: The send was refused before any email went out: run run-1 filed artifacts for review, and the calling step holds no list a person released",
    );
    expect(fx.readRunReviewedBodies).toHaveBeenCalledWith("run-1", expect.objectContaining({ orgId: "org-1" }));
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(fx.writeBody).not.toHaveBeenCalled();
    expect(fx.emitEmailFanout).not.toHaveBeenCalled();
  });

  it("U3 a run whose filed bodies cannot be looked up refuses a send that names none of them", async () => {
    const fx = makeFixture({ reviewedBodies: new Error("the ledger is unavailable") });
    const result = await fx.start({});
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain(
      "whether run run-1 filed artifacts for review could not be read: the ledger is unavailable",
    );
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(fx.emitEmailFanout).not.toHaveBeenCalled();
  });

  it("P1 two approved bodies without a contact of their own, swapped between the drafts, refuse the whole send", async () => {
    const store = makeStore();
    store.get("art-1")!.data = { campaignId: CAMPAIGN_ID };
    // Each entry carries the other draft's contact, address and subject.
    const swapped = [
      { ...approved[0]!, contactId: "c2", recipientEmail: "two@example.com", subject: "Bundle subject two" },
      { ...approved[1]!, contactId: "c1", recipientEmail: "one@example.com", subject: "Bundle subject one" },
    ];
    const fx = makeFixture({ store });
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(fx, { releasedList: swapped }, "approved body 1 is not the body of draft 2 of the bundle (contact c2)");
    expect(fx.sendLedger.rows.size).toBe(0);
  });

  it("P2 the same two bodies without a contact of their own, not swapped, are sent", async () => {
    const store = makeStore();
    store.get("art-1")!.data = { campaignId: CAMPAIGN_ID };
    const fx = makeFixture({ store });
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("completed");
    // red-first-expect: to deeply equal [ 'Approved body one', …(1) ]
    expect(fx.sent.map((m) => m.textBody)).toEqual(["Approved body one", "Approved body two"]);
  });

  it("P3 two swapped bodies with the same text are sent: each recipient receives the text its own draft holds", async () => {
    const store = makeStore();
    store.get("art-1")!.data = { campaignId: CAMPAIGN_ID };
    store.get("art-1")!.revisions["rev-1"] = "The same body";
    store.get("art-2")!.revisions["rev-2"] = "The same body";
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c3" ? d : { ...d, body: "The same body\n" }));
    const swapped = [
      { ...approved[0]!, contactId: "c2", recipientEmail: "two@example.com", subject: "Bundle subject two" },
      { ...approved[1]!, contactId: "c1", recipientEmail: "one@example.com", subject: "Bundle subject one" },
    ];
    const fx = makeFixture({ store, drafts });
    const result = await fx.start({ releasedList: swapped });
    expect(result.status).toBe("completed");
    // red-first-expect: to deeply equal [ ObjectContaining{…}, …(1) ]
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], subject: "Bundle subject one", textBody: "The same body" }),
      expect.objectContaining({ to: ["two@example.com"], subject: "Bundle subject two", textBody: "The same body" }),
    ]);
    // Draft 1's message is bound to art-2, whose text is draft 1's own text.
    expect(fx.bindBody.mock.calls.map(([b]) => b.artifactId)).toEqual(["art-2", "art-1"]);
  });

  it("P4 a draft whose body was changed in the bundle after its body was filed refuses the whole send", async () => {
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c2" ? { ...d, body: "Approved body two, changed later" } : d));
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(
      makeFixture({ drafts }),
      { releasedList: approved },
      "approved body 2 is not the body of draft 2 of the bundle (contact c2)",
    );
  });

  it("F1 the fan-out binds each mailed message to its approved revision and files no new body", async () => {
    const fx = makeFixture();
    await fx.start({ releasedList: approved });
    // red-first-expect: expected "vi.fn()" to not be called at all, but actually been called 3 times
    expect(fx.writeBody).not.toHaveBeenCalled();
    expect(fx.bindBody.mock.calls.map(([b]) => b)).toEqual([
      {
        runId: "run-1",
        outputId: emailBodyExternalId("run-1", "art-1"),
        markdown: "Approved body one",
        artifactId: "art-1",
        representationRevisionId: "rev-1",
      },
      {
        runId: "run-1",
        outputId: emailBodyExternalId("run-1", "art-2"),
        markdown: "Approved body two",
        artifactId: "art-2",
        representationRevisionId: "rev-2",
      },
    ]);
    const emitted = await fx.emitEmailFanout.mock.results[0]!.value;
    expect(emitted.bodies.map((b: { objectId: string }) => b.objectId)).toEqual(["art-1", "art-2"]);
  });

  it("F1b a binding the ledger refuses fails the send before any mail", async () => {
    const fx = makeFixture();
    fx.bindBody.mockResolvedValueOnce({ ok: false, error: "already bound to another revision" } as never);
    const result = await fx.start({ releasedList: approved });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("already bound to another revision");
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("Z1 a request carrying approvedBodies cannot change what is mailed", async () => {
    // The tool's schema drops the key, so the handler never hands it on.
    const parsed = serviceAndCampaignIdSchema.parse({ campaignId: CAMPAIGN_ID, approvedBodies: approved });
    expect(parsed).not.toHaveProperty("approvedBodies");
    // The released decision surfaced the true list; the request names another
    // body for c2 (and the use case is also handed the key directly).
    const fx = makeFixture();
    const forged = [approved[0], { ...approved[1]!, artifactId: "art-9", representationRevisionId: "rev-9", recipientEmail: "x@example.org" }];
    const result = await fx.start({ releasedList: approved, approvedBodies: forged });
    expect(result.status).toBe("completed");
    // red-first-expect: to deeply equal [ ObjectContaining{…}, …(1) ]
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], textBody: "Approved body one" }),
      expect.objectContaining({ to: ["two@example.com"], textBody: "Approved body two" }),
    ]);
    // Each body is read at the check and again at its send time; art-9 never.
    expect(fx.readDecidedBody.mock.calls.map(([ref]) => ref.artifactId)).toEqual(["art-1", "art-2", "art-1", "art-2"]);
    const direct = makeFixture();
    const uc = createTriggerEmailSendUseCases(direct.deps);
    const answer = await uc.startInitialSend(
      { serviceId: "s", campaignId: CAMPAIGN_ID, approvedDraftBundleRef: BUNDLE_REF, confirmedRecipientsRef: RECIPIENTS_REF, approvedBodies: forged } as never,
      actor,
    );
    // No released list here: the reference-only form mails the bundle.
    expect(answer.status).toBe("completed");
    expect(direct.readDecidedBody).not.toHaveBeenCalled();
    expect(direct.sent.map((m) => m.to)).toEqual([["one@example.com"], ["two@example.com"]]);
  });
});

const ADDRESS_CHANGED = "the recipient's address changed after the card was shown";
const SUBJECT_CHANGED = "the subject changed after the card was shown";

/** A refusal of the card's address or subject: nothing is claimed, bound or
 *  mailed, and no address appears in the answer. */
async function expectCardRefused(
  fx: ReturnType<typeof makeFixture>,
  input: Record<string, unknown>,
  reason: string,
  addresses: string[] = [],
) {
  await expectRefused(fx, input, reason);
  const result = await fx.start(input);
  expect(fx.sendLedger.rows.size).toBe(0);
  for (const address of addresses) {
    expect(result.errorMessage?.toLowerCase()).not.toContain(address.toLowerCase());
  }
}

describe("cinatra#3089 — each message is sent to the address and with the subject the card showed", () => {
  it("C1 an address changed in the bundle after the card was shown refuses the whole send and names no address", async () => {
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c2" ? { ...d, recipientEmail: "new-two@example.org" } : d));
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(
      makeFixture({ drafts }),
      { releasedList: approved },
      `draft 2 of the bundle (contact c2): ${ADDRESS_CHANGED}`,
      ["two@example.com", "new-two@example.org"],
    );
  });

  it("C2 an address changed in the recipients list after the card was shown refuses the whole send and names no address", async () => {
    // Draft 2 has no address of its own: the send resolves it from the
    // confirmed recipient with the draft's contact.
    const drafts = bundleDrafts.map((d) =>
      d.recipientId === "c2" ? { contactId: "c2", recipientEmail: "", subject: d.subject, body: d.body } : d,
    );
    const recipients = confirmedRecipients.map((r) => (r.contactId === "c2" ? { ...r, email: "moved@example.org" } : r));
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(
      makeFixture({ drafts, recipients }),
      { releasedList: approved },
      `draft 2 of the bundle (contact c2): ${ADDRESS_CHANGED}`,
      ["two@example.com", "moved@example.org"],
    );
  });

  it("C3 a subject changed on the draft after the card refuses the whole send, even when the body artifact still carries the old one", async () => {
    // art-1 carries its own subject, equal to the draft's subject on the card.
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c1" ? { ...d, subject: "Changed subject one" } : d));
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(makeFixture({ drafts }), { releasedList: approved }, `draft 1 of the bundle (contact c1): ${SUBJECT_CHANGED}`);
  });

  it("C3b a subject changed on a draft without a subject of its own on the body artifact refuses the whole send", async () => {
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c2" ? { ...d, subject: "Changed subject two" } : d));
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(makeFixture({ drafts }), { releasedList: approved }, `draft 2 of the bundle (contact c2): ${SUBJECT_CHANGED}`);
  });

  it("C4 a body artifact's own subject that differs from the card's subject neither blocks the send nor is mailed: nobody was shown it", async () => {
    const store = makeStore();
    store.get("art-1")!.data = { ...store.get("art-1")!.data, subject: "Subject of the artifact alone" };
    const fx = makeFixture({ store });
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("completed");
    expect(result.sentCount).toBe(2);
    // red-first-expect: to deeply equal [ ObjectContaining{…}, …(1) ]
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], subject: "Bundle subject one", textBody: "Approved body one" }),
      expect.objectContaining({ to: ["two@example.com"], subject: "Bundle subject two", textBody: "Approved body two" }),
    ]);
  });

  it("C4b a body artifact whose own subject equals its draft's is sent with it", async () => {
    const fx = makeFixture();
    expect(fx.store.get("art-1")!.data.subject).toBe("Bundle subject one");
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("completed");
    expect(fx.sent[0]?.subject).toBe("Bundle subject one");
  });

  it("C5 the subject is compared exactly with the draft's: a different letter case refuses the send", async () => {
    // The body artifact's own subject equals the entry's, so only the draft's
    // subject can refuse it.
    const store = makeStore();
    store.get("art-1")!.data = { ...store.get("art-1")!.data, subject: "bundle subject one" };
    const entries = [{ ...approved[0]!, subject: "bundle subject one" }, approved[1]];
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(makeFixture({ store }), { releasedList: entries }, `draft 1 of the bundle (contact c1): ${SUBJECT_CHANGED}`);
  });

  it("C5b the mailed subject is the entry's subject byte for byte, not trimmed", async () => {
    const padded = "  Padded  subject ";
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c1" ? { ...d, subject: padded } : d));
    const store = makeStore();
    store.get("art-1")!.data = { ...store.get("art-1")!.data, subject: padded.trim() };
    const fx = makeFixture({ drafts, store });
    const result = await fx.start({ releasedList: [{ ...approved[0]!, subject: padded }, approved[1]] });
    expect(result.status).toBe("completed");
    expect(fx.sent[0]?.subject).toBe(padded);
    // red-first-expect: to be 'Approved body one'
    expect(fx.sent[0]?.textBody).toBe("Approved body one");
  });

  it("C6 equal values are sent as before, the address compared byte for byte", async () => {
    const fx = makeFixture();
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("completed");
    expect(result.sentCount).toBe(2);
    // The mail goes to the address the released card showed, as it showed
    // it; the bundle's equal address is only checked against it (an address
    // shown with white space around it is refused, see B5).
    // red-first-expect: to deeply equal [ ObjectContaining{…}, …(1) ]
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], subject: "Bundle subject one", textBody: "Approved body one" }),
      expect.objectContaining({ to: ["two@example.com"], subject: "Bundle subject two", textBody: "Approved body two" }),
    ]);
    // Another letter case is another address than the bundle's: refused.
    await expectCardRefused(
      makeFixture(),
      { releasedList: [approved[0], { ...approved[1]!, recipientEmail: "Two@EXAMPLE.com" }] },
      `draft 2 of the bundle (contact c2): ${ADDRESS_CHANGED}`,
      ["two@example.com"],
    );
  });

  it("C7 an equal address resolved from the recipients list is sent as before", async () => {
    const drafts = bundleDrafts.map((d) =>
      d.recipientId === "c2" ? { contactId: "c2", recipientEmail: "", subject: d.subject, body: d.body } : d,
    );
    const fx = makeFixture({ drafts });
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("completed");
    expect(fx.sent.map((m) => m.to)).toEqual([["one@example.com"], ["two@example.com"]]);
    // red-first-expect: to deeply equal [ 'Approved body one', …(1) ]
    expect(fx.sent.map((m) => m.textBody)).toEqual(["Approved body one", "Approved body two"]);
  });

  it("C8 an entry for a draft without an address refuses the whole send", async () => {
    const store = makeStore();
    store.set("art-3", { ...store.get("art-2")!, latest: "rev-3", revisions: { "rev-3": "Approved body three" } });
    const entries = [
      ...approved,
      { artifactId: "art-3", representationRevisionId: "rev-3", contactId: "c3", recipientEmail: "three@example.com", subject: "Bundle subject three" },
    ];
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(
      makeFixture({ store }),
      { releasedList: entries },
      "approved body 3 is for draft 3 of the bundle (contact c3), which has no address",
      ["three@example.com"],
    );
  });

  it("C9 a list surfaced as JSON text is refused before any claim: the card draws no bodies from it", async () => {
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(
      makeFixture(),
      { releasedList: JSON.stringify(approved) },
      "no artifacts row of the released publish decision draws the bodies of the released list",
      ["one@example.com", "two@example.com"],
    );
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
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("completed");
    expect(fx.readPublishDecision).toHaveBeenCalledTimes(1);
    expect(fx.readPublishDecision).toHaveBeenCalledWith("run-1", "send");
    // Another verified step asks for its own.
    const other = makeFixture({ callingRun: { runId: "run-1", stepId: "deliver" } });
    await other.start({ releasedList: approved });
    expect(other.readPublishDecision).toHaveBeenCalledWith("run-1", "deliver");
  });

  for (const [name, graph] of [["nested in a released publishing FlowNode", NESTED_GRAPH], ["signed with the publishing component's own id", ALIASED_GRAPH]] as const) {
    it(`G2 a send step ${name} reads the decision stored under the publishing node, and sends the approved bodies`, async () => {
      governing.readRunBoundGraph.mockResolvedValue(JSON.stringify(graph));
      governing.readDecisionForRunNode.mockImplementation(async (_runId: unknown, nodeId: unknown) =>
        nodeId === "publish" ? { id: "d-publish", ...releasedCardFor(approved) } : null);
      const fx = makeFixture({ readPublishDecision: null, reviewedBodies: true });
      const result = await fx.start({});
      expect(result.status).toBe("completed");
      expect(governing.readDecisionForRunNode).toHaveBeenCalledWith("run-1", "publish");
      expect(governing.readDecisionForRunNode).not.toHaveBeenCalledWith("run-1", "send");
      expect(fx.sent.map((m) => m.textBody)).toEqual(["Approved body one", "Approved body two"]);
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
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(makeFixture({ readPublishDecision: null }), {}, "which publishing step governs the call cannot be told");
  });

  it("G5 a send step inside a publishing node that holds no decision is refused, never sent in the reference-only form", async () => {
    governing.readRunBoundGraph.mockResolvedValue(JSON.stringify(NESTED_GRAPH));
    // No decision row at all, on a run that filed no bodies for review.
    // red-first-expect: expected 'completed' to be 'failed'
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
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(
      makeFixture({ callingRun: signed, readPublishDecision: card("d-newer") }),
      {},
      "the call was signed for another publish decision than the one that governs step send of run run-1",
    );
    await expectRefused(makeFixture({ callingRun: signed, readPublishDecision: card(undefined) }), {}, "signed for another publish decision");
    await expectRefused(makeFixture({ callingRun: signed, readPublishDecision: async () => null }), {}, "signed for another publish decision");
    const served = makeFixture({ callingRun: signed, readPublishDecision: card("d-signed") });
    expect((await served.start({})).status).toBe("completed");
    expect(served.sent.map((m) => m.textBody)).toEqual(["Approved body one", "Approved body two"]);
  });
});

// What the card showed is what is compared and what is sent: a released value
// is never trimmed, folded or normalised on the way to the mail.
describe("cinatra#3089 — what is sent is byte for byte what the card showed", () => {
  const SHOWN_DIFFERS = "no list row of the released publish decision shows each record of the released list";
  const variants: Array<[string, string]> = [
    ["leading and trailing spaces", " Bundle subject one "],
    ["an inner double space", "Bundle  subject one"],
    ["a non-breaking space", "Bundle subject one"],
  ];
  for (const [name, candidate] of variants) {
    it(`B1 a subject with ${name} beside the shown subject is refused`, async () => {
      const drafts = bundleDrafts.map((d) => (d.recipientId === "c1" ? { ...d, subject: candidate } : d));
      // red-first-expect: expected 'completed' to be 'failed'
      await expectCardRefused(
        makeFixture({ drafts }),
        { releasedList: [{ ...approved[0]!, subject: candidate }, approved[1]], shownList: approved },
        SHOWN_DIFFERS,
      );
    });
  }

  it("B2 the same visible subject in another Unicode normalisation form than the shown one is refused", async () => {
    const shownNfc = "Résumé of the quarter";
    const candidateNfd = shownNfc.normalize("NFD");
    expect(candidateNfd).not.toBe(shownNfc);
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c1" ? { ...d, subject: candidateNfd } : d));
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(
      makeFixture({ drafts }),
      { releasedList: [{ ...approved[0]!, subject: candidateNfd }, approved[1]], shownList: [{ ...approved[0]!, subject: shownNfc }, approved[1]] },
      SHOWN_DIFFERS,
    );
  });

  it("B3 a subject shown with spaces, a non-breaking space or a decomposed accent is sent exactly as shown", async () => {
    for (const subject of [" Padded  subject ", "Bundle subject one", "Résumé".normalize("NFD")]) {
      const drafts = bundleDrafts.map((d) => (d.recipientId === "c1" ? { ...d, subject } : d));
      const store = makeStore();
      store.get("art-1")!.data = { ...store.get("art-1")!.data, subject };
      const fx = makeFixture({ drafts, store });
      const result = await fx.start({ releasedList: [{ ...approved[0]!, subject }, approved[1]] });
      expect(result.status).toBe("completed");
      expect(fx.sent[0]?.subject).toBe(subject);
    }
  });

  it("B4 an address shown in another form than the candidate's is refused", async () => {
    for (const recipientEmail of [" one@example.com ", "one@example.com ", "One@example.com"]) {
      // red-first-expect: expected 'completed' to be 'failed'
      await expectCardRefused(
        makeFixture(),
        { releasedList: [{ ...approved[0]!, recipientEmail }, approved[1]], shownList: approved },
        SHOWN_DIFFERS,
        ["one@example.com"],
      );
    }
  });

  it("B5 an address or contact the card carried with white space around it is refused, never trimmed and sent", async () => {
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(
      makeFixture(),
      { releasedList: [{ ...approved[0]!, recipientEmail: "  one@example.com " }, approved[1]] },
      "approved body 1 carries its recipientEmail with white space around it",
      ["one@example.com"],
    );
    await expectCardRefused(
      makeFixture(),
      { releasedList: [{ ...approved[0]!, contactId: " c1" }, approved[1]] },
      "approved body 1 carries its contactId with white space around it",
    );
  });

  it("B6 the campaign and the sender are compared and used exactly as the decision froze and the card showed them", async () => {
    const withSender = (sender: unknown) => async () => {
      const card = releasedCardFor(approved);
      return {
        ...card,
        surfacedValues: { ...card.surfacedValues, senderEmail: sender },
        declaredRows: [...card.declaredRows, { label: "From", input: "senderEmail" }],
      };
    };
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(
      makeFixture({ readPublishDecision: withSender(" team@example.com ") as TriggerEmailSendDeps["readPublishDecision"] }),
      {},
      "the sender the released publish card showed carries white space around it",
    );
    // The call's sender must be the shown sender byte for byte.
    await expectRefused(
      makeFixture({ readPublishDecision: withSender("team@example.com") as TriggerEmailSendDeps["readPublishDecision"] }),
      { senderEmail: "TEAM@example.com" },
      "the call names another sender than the released publish card showed",
    );
    const fx = makeFixture({ readPublishDecision: withSender("team@example.com") as TriggerEmailSendDeps["readPublishDecision"] });
    expect((await fx.start({ senderEmail: "team@example.com" })).status).toBe("completed");
    expect(fx.sendEmail.mock.calls.map((c) => (c[0] as { fromEmail?: string }).fromEmail)).toEqual(["team@example.com", "team@example.com"]);
    // A campaign frozen with white space around it is refused, not trimmed.
    await expectRefused(
      makeFixture({ readPublishDecision: async () => releasedCardFor(approved, ` ${CAMPAIGN_ID} `) }),
      {},
      "the released publish decision carries its campaign with white space around it",
    );
  });
});
