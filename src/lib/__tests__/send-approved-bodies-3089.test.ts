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
 *   S1 the approved form mails the approved revision's text and subject, even
 *      when the bundle's body text differs
 *   R1 a draft with an address and no approved body refuses the whole send
 *   R2 an approved revision that cannot be read refuses the whole send
 *   R3 an approved revision that is not the artifact's current revision (a body
 *      filed again after the approval) refuses the whole send
 *   R4 a revision of another organization or type refuses the whole send
 *   R5 the list names one body twice
 *   R6 the list names a body that maps to no draft
 *   R7 two bodies for one contact
 *   R8 a body that carries another contact than its entry
 *   U1 the reference-only form is unchanged: the bundle body is mailed and no
 *      approved body is read
 *   F1 the fan-out binds each mailed message to its approved revision and
 *      files no new body (nor one for a draft without an address)
 *   Z1 the tool's schema keeps the list, bounded at 50 entries, closed to other
 *      keys
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
// `recipientId`; c3 has no address and is never mailed.
const bundleDrafts = [
  { recipientId: "c1", recipientName: "One", recipientEmail: "one@example.com", subject: "Bundle subject one", body: "Bundle body one" },
  { recipientId: "c2", recipientName: "Two", recipientEmail: "two@example.com", subject: "Bundle subject two", body: "Bundle body two" },
  { recipientId: "c3", recipientName: "Three", recipientEmail: "", subject: "Bundle subject three", body: "Bundle body three" },
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
        data: { subject: "Approved subject one", contactId: "c1" },
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

const approved = [
  { artifactId: "art-1", representationRevisionId: "rev-1", contactId: "c1" },
  { artifactId: "art-2", representationRevisionId: "rev-2", contactId: "c2" },
];

function makeFixture(opts?: { store?: Map<string, StoredBody>; drafts?: unknown[] }) {
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
      data: { confirmedRecipients },
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
  const deps: TriggerEmailSendDeps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: sendEmail as unknown as TriggerEmailSendDeps["sendEmail"],
    getObjectByRef: async (ref) => envelopes[ref] ?? null,
    emitEmailFanout,
    readDecidedBody,
    messageSendLedger: sendLedger.ledger,
  };
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
    } as never) as unknown as Promise<{ status: string; sentCount: number; errorMessage?: string }>;
  return { store, sent, sendEmail, readDecidedBody, writeBody, bindBody, emitEmailFanout, start };
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
  it("S1 the approved form mails the approved revision's text and subject, even when the bundle's body text differs", async () => {
    const fx = makeFixture();
    const result = await fx.start({ approvedBodies: approved });
    expect(result.status).toBe("completed");
    expect(result.sentCount).toBe(2);
    // red-first-expect: to deeply equal [ ObjectContaining{…}, …(1) ]
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], subject: "Approved subject one", textBody: "Approved body one" }),
      // art-2 carries no subject of its own: the draft's subject stands.
      expect.objectContaining({ to: ["two@example.com"], subject: "Bundle subject two", textBody: "Approved body two" }),
    ]);
    expect(fx.sent.some((m) => m.textBody.startsWith("Bundle body"))).toBe(false);
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
      { approvedBodies: [...approved, { artifactId: "art-9", representationRevisionId: "rev-2", contactId: "c9" }] },
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

  it("U1 the reference-only form is unchanged: the bundle body is mailed and no approved body is read", async () => {
    const fx = makeFixture();
    const result = await fx.start({});
    expect(result.status).toBe("completed");
    expect(fx.sent).toEqual([
      expect.objectContaining({ to: ["one@example.com"], subject: "Bundle subject one", textBody: "Bundle body one" }),
      expect.objectContaining({ to: ["two@example.com"], subject: "Bundle subject two", textBody: "Bundle body two" }),
    ]);
    expect(fx.readDecidedBody).not.toHaveBeenCalled();
    expect(fx.bindBody).not.toHaveBeenCalled();
    // The fan-out still files one body per draft of the bundle, as before.
    expect(fx.writeBody).toHaveBeenCalledTimes(3);
  });

  it("F1 the fan-out binds each mailed message to its approved revision and files no new body", async () => {
    const fx = makeFixture();
    await fx.start({ approvedBodies: approved });
    // red-first-expect: expected "vi.fn()" to not be called at all, but actually been called 3 times
    expect(fx.writeBody).not.toHaveBeenCalled();
    expect(fx.bindBody.mock.calls.map(([b]) => b)).toEqual([
      {
        runId: "run-1",
        outputId: emailBodyExternalId("run-1", "idx-0"),
        markdown: "Approved body one",
        artifactId: "art-1",
        representationRevisionId: "rev-1",
      },
      {
        runId: "run-1",
        outputId: emailBodyExternalId("run-1", "idx-1"),
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
    const many = Array.from({ length: 51 }, (_, i) => ({ artifactId: `a${i}`, representationRevisionId: `r${i}`, contactId: `c${i}` }));
    expect(serviceAndCampaignIdSchema.safeParse({ ...base, approvedBodies: many }).success).toBe(false);
    expect(serviceAndCampaignIdSchema.safeParse({ ...base, approvedBodies: many.slice(0, 50) }).success).toBe(true);
    expect(serviceAndCampaignIdSchema.safeParse({ ...base, approvedBodies: [{ ...approved[0], text: "x" }] }).success).toBe(false);
    expect(serviceAndCampaignIdSchema.safeParse({ ...base, approvedBodies: [{ artifactId: "a", representationRevisionId: "r" }] }).success).toBe(false);
  });
});
