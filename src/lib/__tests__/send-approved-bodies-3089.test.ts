/**
 * cinatra#3089 — the campaign send mails exactly the email bodies a person
 * approved.
 *
 * `email_outreach_send_initial_start` takes an optional `approvedBodies` list:
 * each entry an `email:body` artifact revision plus the contact of the draft it
 * is the body of. Given, the send mails, for each draft with an address, the
 * text of ITS approved revision (never the bundle's body), refuses the whole
 * send before any mail on every gap, and the fan-out binds each message to the
 * approved revision instead of filing a new body. Without the list the send
 * reads the bundle exactly as before.
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
 *   Z1 the tool's schema keeps the list, bounded at 50 entries, closed to other
 *      keys
 *   Z2 every entry carries the address and the subject the card showed
 *   C1-C9 each message is mailed only to the address and with the subject the
 *      publish card showed: a change in the bundle, the recipients list or the
 *      draft's subject refuses the whole send before any claim and names no
 *      address; the mailed subject is the entry's, byte for byte, whatever a
 *      body artifact's own `subject` field holds; equal values (the address in
 *      any letter case, with spaces) are sent; the JSON text form behaves the
 *      same
 */
import { describe, expect, it, vi } from "vitest";
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
  type MessageSendLedger,
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

/** The publish decision a person released for exactly the list a case names
 *  (cinatra#3089): the card's Recipients list row and its Emails row, drawn
 *  from the frozen values. These cases are about what the send does with an
 *  approved list, so the card shows the list the case names. */
function releasedCardFor(named: unknown) {
  const list = (typeof named === "string" ? JSON.parse(named) : named) as Array<{ recipientEmail: string; subject: string }>;
  return {
    surfacedValues: {
      recipients: list.map((e) => ({ email: e.recipientEmail, subject: e.subject })),
      emailBodies: named,
    },
    declaredRows: [
      { kind: "list", input: "recipients", columns: [{ field: "email" }, { field: "subject" }] },
      { kind: "artifacts", input: "emailBodies" },
    ],
  };
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
        data: { subject: "Bundle subject one", contactId: "c1" },
      },
    ],
    [
      "art-2",
      {
        orgId: "org-1",
        type: EMAIL_BODY_TYPE_ID,
        latest: "rev-2",
        revisions: { "rev-2": "Approved body two" },
        data: {},
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
    readCallingRun: async () => ({ runId: "run-1", stepId: "send" }),
    readReleasedPublishDecision: async () => releasedCardFor(named),
  } as TriggerEmailSendDeps;
  let named: unknown;
  const handlers = createTriggerEmailSendHandlers(createTriggerEmailSendUseCases(deps));
  const start = (input: Record<string, unknown>) =>
    ((named = input.approvedBodies), handlers["email_outreach_send_initial_start"])({
      input: {
        campaignId: CAMPAIGN_ID,
        approvedDraftBundleRef: BUNDLE_REF,
        confirmedRecipientsRef: RECIPIENTS_REF,
        ...input,
      },
      actor,
    } as never) as unknown as Promise<{ status: string; sentCount: number; errorMessage?: string }>;
  return {
    store,
    sent,
    sendEmail,
    readDecidedBody,
    readRunReviewedBodies,
    writeBody,
    bindBody,
    emitEmailFanout,
    sendLedger,
    start,
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
    const result = await fx.start({ approvedBodies: approved });
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
    await expectRefused(makeFixture(), { approvedBodies: [approved[0]] }, "draft 2 of the bundle has an address but no approved body");
  });

  it("R2 an approved revision that cannot be read refuses the whole send", async () => {
    const store = makeStore();
    store.get("art-2")!.revisions = {};
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(makeFixture({ store }), { approvedBodies: approved }, "approved body 2: the revision could not be read");
  });

  it("R3 an approved revision that is not the artifact's current revision refuses the whole send", async () => {
    const store = makeStore();
    // The body was filed again after the approval: rev-1b supersedes rev-1.
    store.get("art-1")!.revisions["rev-1b"] = "Regenerated body one";
    store.get("art-1")!.latest = "rev-1b";
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(makeFixture({ store }), { approvedBodies: approved }, "approved body 1: revision rev-1 is not its current revision");
  });

  it("R4 a revision of another organization or of another type refuses the whole send", async () => {
    const other = makeStore();
    other.get("art-1")!.orgId = "org-2";
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(makeFixture({ store: other }), { approvedBodies: approved }, "is not a live artifact of organization org-1");
    const typed = makeStore();
    typed.get("art-2")!.type = "@cinatra-ai/blog:post";
    await expectRefused(makeFixture({ store: typed }), { approvedBodies: approved }, 'artifact art-2 is of type "@cinatra-ai/blog:post"');
  });

  it("R5 the list names one body twice", async () => {
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(
      makeFixture(),
      { approvedBodies: [approved[0], approved[1], { ...approved[0], contactId: "c3" }] },
      "approved body 3 names artifact art-1 a second time",
    );
  });

  it("R6 the list names a body that maps to no draft", async () => {
    const store = makeStore();
    store.set("art-9", { ...store.get("art-2")!, data: {} });
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(
      makeFixture({ store }),
      {
        approvedBodies: [
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
      { approvedBodies: [approved[0], { ...approved[1], contactId: "c1" }] },
      "approved bodies 1 and 2 are both for contact c1",
    );
  });

  it("R8 a body that carries another contact than its entry refuses the whole send", async () => {
    const store = makeStore();
    store.get("art-2")!.data = { contactId: "c1" };
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(makeFixture({ store }), { approvedBodies: approved }, "approved body 2 is the body of contact c1, not of contact c2");
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
      "REVIEWED_BODIES_REQUIRED: The send was refused before any email went out: run run-1 has email bodies filed for review, so the send must name the approved bodies (approvedBodies)",
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
      "whether run run-1 has email bodies filed for review could not be read: the ledger is unavailable",
    );
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(fx.emitEmailFanout).not.toHaveBeenCalled();
  });

  it("P1 two approved bodies without a contact of their own, swapped between the drafts, refuse the whole send", async () => {
    const store = makeStore();
    store.get("art-1")!.data = {};
    // Each entry carries the other draft's contact, address and subject.
    const swapped = [
      { ...approved[0]!, contactId: "c2", recipientEmail: "two@example.com", subject: "Bundle subject two" },
      { ...approved[1]!, contactId: "c1", recipientEmail: "one@example.com", subject: "Bundle subject one" },
    ];
    const fx = makeFixture({ store });
    // red-first-expect: expected 'completed' to be 'failed'
    await expectRefused(fx, { approvedBodies: swapped }, "approved body 1 is not the body of draft 2 of the bundle (contact c2)");
    expect(fx.sendLedger.rows.size).toBe(0);
  });

  it("P2 the same two bodies without a contact of their own, not swapped, are sent", async () => {
    const store = makeStore();
    store.get("art-1")!.data = {};
    const fx = makeFixture({ store });
    const result = await fx.start({ approvedBodies: approved });
    expect(result.status).toBe("completed");
    // red-first-expect: to deeply equal [ 'Approved body one', …(1) ]
    expect(fx.sent.map((m) => m.textBody)).toEqual(["Approved body one", "Approved body two"]);
  });

  it("P3 two swapped bodies with the same text are sent: each recipient receives the text its own draft holds", async () => {
    const store = makeStore();
    store.get("art-1")!.data = {};
    store.get("art-1")!.revisions["rev-1"] = "The same body";
    store.get("art-2")!.revisions["rev-2"] = "The same body";
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c3" ? d : { ...d, body: "The same body\n" }));
    const swapped = [
      { ...approved[0]!, contactId: "c2", recipientEmail: "two@example.com", subject: "Bundle subject two" },
      { ...approved[1]!, contactId: "c1", recipientEmail: "one@example.com", subject: "Bundle subject one" },
    ];
    const fx = makeFixture({ store, drafts });
    const result = await fx.start({ approvedBodies: swapped });
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
      { approvedBodies: approved },
      "approved body 2 is not the body of draft 2 of the bundle (contact c2)",
    );
  });

  it("F1 the fan-out binds each mailed message to its approved revision and files no new body", async () => {
    const fx = makeFixture();
    await fx.start({ approvedBodies: approved });
    // red-first-expect: expected "vi.fn()" to not be called at all, but actually been called 3 times
    expect(fx.writeBody).not.toHaveBeenCalled();
    expect(fx.bindBody.mock.calls.map(([b]) => b)).toEqual([
      {
        runId: "run-1",
        outputId: emailBodyExternalId("run-1", "art-1"),
        markdown: "Approved body one",
        artifactId: "art-1",
        representationRevisionId: "rev-1",
        correlation: { campaignId: CAMPAIGN_ID, contactId: "c1" },
      },
      {
        runId: "run-1",
        outputId: emailBodyExternalId("run-1", "art-2"),
        markdown: "Approved body two",
        artifactId: "art-2",
        representationRevisionId: "rev-2",
        correlation: { campaignId: CAMPAIGN_ID, contactId: "c2" },
      },
    ]);
    const emitted = await fx.emitEmailFanout.mock.results[0]!.value;
    expect(emitted.bodies.map((b: { objectId: string }) => b.objectId)).toEqual(["art-1", "art-2"]);
  });

  it("F1b a binding the ledger refuses fails the send before any mail", async () => {
    const fx = makeFixture();
    fx.bindBody.mockResolvedValueOnce({ ok: false, error: "already bound to another revision" } as never);
    const result = await fx.start({ approvedBodies: approved });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("already bound to another revision");
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("Z1 the tool's schema keeps the list, bounded at 50 entries and closed to other keys", () => {
    const base = { campaignId: CAMPAIGN_ID };
    const parsed = serviceAndCampaignIdSchema.parse({ ...base, approvedBodies: approved });
    // red-first-expect: expected undefined to deeply equal
    expect((parsed as { approvedBodies?: unknown }).approvedBodies).toEqual(approved);
    const many = Array.from({ length: 51 }, (_, i) => ({
      artifactId: `a${i}`,
      representationRevisionId: `r${i}`,
      contactId: `c${i}`,
      recipientEmail: `p${i}@example.com`,
      subject: `S${i}`,
    }));
    expect(serviceAndCampaignIdSchema.safeParse({ ...base, approvedBodies: many }).success).toBe(false);
    expect(serviceAndCampaignIdSchema.safeParse({ ...base, approvedBodies: many.slice(0, 50) }).success).toBe(true);
    expect(serviceAndCampaignIdSchema.safeParse({ ...base, approvedBodies: [{ ...approved[0], text: "x" }] }).success).toBe(false);
    expect(serviceAndCampaignIdSchema.safeParse({ ...base, approvedBodies: [{ artifactId: "a", representationRevisionId: "r" }] }).success).toBe(false);
  });

  it("Z2 every entry must carry the address and the subject the card showed", () => {
    const base = { campaignId: CAMPAIGN_ID };
    const { recipientEmail: _email, ...noEmail } = approved[0]!;
    const { subject: _subject, ...noSubject } = approved[0]!;
    for (const list of [[noEmail], [noSubject], [approved[0], noEmail], [{ ...approved[0], recipientEmail: 7 }]]) {
      // red-first-expect: expected true to be false
      expect(serviceAndCampaignIdSchema.safeParse({ ...base, approvedBodies: list }).success, JSON.stringify(list)).toBe(false);
    }
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
      { approvedBodies: approved },
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
      { approvedBodies: approved },
      `draft 2 of the bundle (contact c2): ${ADDRESS_CHANGED}`,
      ["two@example.com", "moved@example.org"],
    );
  });

  it("C3 a subject changed on the draft after the card refuses the whole send, even when the body artifact still carries the old one", async () => {
    // art-1 carries its own subject, equal to the draft's subject on the card.
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c1" ? { ...d, subject: "Changed subject one" } : d));
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(makeFixture({ drafts }), { approvedBodies: approved }, `draft 1 of the bundle (contact c1): ${SUBJECT_CHANGED}`);
  });

  it("C3b a subject changed on a draft without a subject of its own on the body artifact refuses the whole send", async () => {
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c2" ? { ...d, subject: "Changed subject two" } : d));
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(makeFixture({ drafts }), { approvedBodies: approved }, `draft 2 of the bundle (contact c2): ${SUBJECT_CHANGED}`);
  });

  it("C4 a body artifact's own subject that differs from the card's subject neither blocks the send nor is mailed: nobody was shown it", async () => {
    const store = makeStore();
    store.get("art-1")!.data = { ...store.get("art-1")!.data, subject: "Subject of the artifact alone" };
    const fx = makeFixture({ store });
    const result = await fx.start({ approvedBodies: approved });
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
    const result = await fx.start({ approvedBodies: approved });
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
    await expectCardRefused(makeFixture({ store }), { approvedBodies: entries }, `draft 1 of the bundle (contact c1): ${SUBJECT_CHANGED}`);
  });

  it("C5b the mailed subject is the entry's subject byte for byte, not trimmed", async () => {
    const padded = "  Padded  subject ";
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c1" ? { ...d, subject: padded } : d));
    const store = makeStore();
    store.get("art-1")!.data = { ...store.get("art-1")!.data, subject: padded.trim() };
    const fx = makeFixture({ drafts, store });
    const result = await fx.start({ approvedBodies: [{ ...approved[0]!, subject: padded }, approved[1]] });
    expect(result.status).toBe("completed");
    expect(fx.sent[0]?.subject).toBe(padded);
    // red-first-expect: to be 'Approved body one'
    expect(fx.sent[0]?.textBody).toBe("Approved body one");
  });

  it("C6 equal values are sent as before, the address compared trimmed and in any letter case", async () => {
    const entries = [{ ...approved[0]!, recipientEmail: "  ONE@Example.COM " }, { ...approved[1]!, recipientEmail: "Two@EXAMPLE.com" }];
    const fx = makeFixture();
    const result = await fx.start({ approvedBodies: entries });
    expect(result.status).toBe("completed");
    expect(result.sentCount).toBe(2);
    // The mail goes to the address the released card showed (trimmed), the
    // bundle's equal address only checked against it.
    // red-first-expect: to deeply equal [ ObjectContaining{…}, …(1) ]
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["ONE@Example.COM"], subject: "Bundle subject one", textBody: "Approved body one" }),
      expect.objectContaining({ to: ["Two@EXAMPLE.com"], subject: "Bundle subject two", textBody: "Approved body two" }),
    ]);
  });

  it("C7 an equal address resolved from the recipients list is sent as before", async () => {
    const drafts = bundleDrafts.map((d) =>
      d.recipientId === "c2" ? { contactId: "c2", recipientEmail: "", subject: d.subject, body: d.body } : d,
    );
    const fx = makeFixture({ drafts });
    const result = await fx.start({ approvedBodies: approved });
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
      { approvedBodies: entries },
      "approved body 3 is for draft 3 of the bundle (contact c3), which has no address",
      ["three@example.com"],
    );
  });

  it("C9 the JSON text form with the address and the subject is sent and refused as the array form is", async () => {
    expect((await makeFixture().start({ approvedBodies: JSON.stringify(approved) })).status).toBe("completed");
    const drafts = bundleDrafts.map((d) => (d.recipientId === "c2" ? { ...d, recipientEmail: "new-two@example.org" } : d));
    // red-first-expect: expected 'completed' to be 'failed'
    await expectCardRefused(
      makeFixture({ drafts }),
      { approvedBodies: JSON.stringify(approved) },
      `draft 2 of the bundle (contact c2): ${ADDRESS_CHANGED}`,
      ["two@example.com", "new-two@example.org"],
    );
  });
});
