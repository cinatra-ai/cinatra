/**
 * cinatra#3089 — what the approved send mails is fixed at send time, per
 * message, and every value it mails with comes from the released decision, the
 * decided revision or the server's context of the call.
 *
 * Driven through `createTriggerEmailSendHandlers` and
 * `createTriggerEmailSendUseCases` with the shipped fan-out over a stand-in
 * binder, a stand-in claim ledger and a stand-in decided-revision read.
 *
 * Cases:
 *   S1 a body that is no longer decided at its send time (its revision was
 *      superseded, reopened, sent back or repaired after the check) is not
 *      mailed: its claim is given back, the other messages are mailed, and the
 *      answer names the message as refused
 *   S2 a send-time read that answers another text than the one checked refuses
 *      that message
 *   S3 each message's send-time read comes after its claim is won and right
 *      before its hand-over, and the mail carries the text read then
 *   S4 the sender mailed from is the one the released card SHOWED on its From
 *      row: a call that names another sender, a sender the decision did not
 *      surface, or a surfaced sender no row of the card showed is refused before
 *      any mail; with no sender shown the connected default mailbox sends
 *   S6 the claim of each message is verified under the revision's lock: a
 *      verification that refuses (the revision is no longer current and
 *      decided when the claim commits) mails nothing for that message
 *   S5 the contact the mail is recorded for is the released entry's, never the
 *      bundle's
 */
import { describe, expect, it, vi } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { createTriggerEmailSendHandlers } from "@cinatra-ai/trigger-email-send";

vi.mock("../artifacts/current-decided-revision-read", () => ({ readCurrentDecidedRevision: vi.fn() }));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: () => ({ typesList: vi.fn() }) }));
vi.mock("../artifacts/run-artifact-materializer", () => ({
  bindFanoutMessageRevision: vi.fn(),
  materializeFanoutMessageRevision: vi.fn(),
}));

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
const withDecisionId = <T extends object | null | undefined>(decision: T): T =>
  decision ? ({ id: "d-1", ...decision } as T) : decision;


const actor: PrimitiveActorContext = { actorType: "human", source: "route", userId: "user-1", sessionId: "s-1", orgId: "org-1" };
const BUNDLE_REF = "11111111-1111-4111-8111-111111111111";
const RECIPIENTS_REF = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_ID = "33333333-3333-4333-8333-333333333333";

const drafts = [1, 2, 3].map((n) => ({
  recipientId: `c${n}`,
  recipientEmail: `p${n}@example.com`,
  subject: `Subject ${n}`,
  body: `Approved art-${n}`,
}));
const recipients = [1, 2, 3].map((n) => ({ contactId: `c${n}`, email: `p${n}@example.com` }));
const approved = [1, 2, 3].map((n) => ({
  artifactId: `art-${n}`,
  representationRevisionId: `rev-${n}`,
  contactId: `c${n}`,
  recipientEmail: `p${n}@example.com`,
  subject: `Subject ${n}`,
}));

type Mail = { to: string[]; subject: string; textBody: string; fromEmail?: string };
type MailOptions = { correlation?: { contactId?: string } };

function fixture(opts?: {
  /** The answer of the n-th read of a body (1 = the check, 2 = its send time). */
  read?: (artifactId: string, n: number) => DecidedBodyRead | undefined;
  /** Values the released decision surfaced besides the list and the campaign. */
  surfaced?: Record<string, unknown>;
  /** Declare the card's From row for `senderEmail`. */
  fromRow?: boolean;
  /** The answer of the check under the revision's lock (null: still decided). */
  underLock?: (artifactId: string) => string | null;
}) {
  const verified: string[] = [];
  const log: string[] = [];
  const sent: Array<{ message: Mail; options: MailOptions }> = [];
  const rows = new Map<string, { id: string; phase: "claimed" | "finalized" }>();
  let next = 0;
  const ledger: MessageSendLedger = {
    async claim(key, _actor, verifyUnderLock) {
      log.push(`claim ${key.artifactId}`);
      const row = rows.get(key.bindingOutputId);
      if (row) return { kind: row.phase === "finalized" ? "done" : "in_doubt" };
      // The shipped ledger runs the verification inside the claim's transaction,
      // under the revision's lock; this stand-in runs it in the same place.
      const refusal = verifyUnderLock ? await verifyUnderLock(async () => ({ rows: [] })) : null;
      if (refusal) return { kind: "refused", reason: refusal };
      next += 1;
      rows.set(key.bindingOutputId, { id: `send-${next}`, phase: "claimed" });
      return { kind: "won", ledgerId: `send-${next}` };
    },
    async markDone(id) {
      for (const row of rows.values()) if (row.id === id) row.phase = "finalized";
      return true;
    },
    async release(id, key) {
      log.push(`release ${key.artifactId}`);
      for (const [k, row] of rows) if (row.id === id && row.phase === "claimed") rows.delete(k);
    },
  };
  const reads = new Map<string, number>();
  const readDecidedBody = async (ref: { artifactId: string }): Promise<DecidedBodyRead> => {
    const n = (reads.get(ref.artifactId) ?? 0) + 1;
    reads.set(ref.artifactId, n);
    log.push(`read ${ref.artifactId}`);
    return opts?.read?.(ref.artifactId, n) ?? { ok: true, text: `Approved ${ref.artifactId}`, data: { campaignId: CAMPAIGN_ID } };
  };
  const bound = new Map<string, { artifactId: string; representationRevisionId: string }>();
  const fanout = (args: EmailFanoutArgs) =>
    materializeEmailFanout(args, {
      bindBody: async (b: { outputId: string; artifactId: string; representationRevisionId: string }) => {
        const own = bound.get(b.outputId);
        if (own) return { ok: true as const, ...own, deduped: true };
        bound.set(b.outputId, { artifactId: b.artifactId, representationRevisionId: b.representationRevisionId });
        return { ok: true as const, artifactId: b.artifactId, representationRevisionId: b.representationRevisionId, deduped: false };
      },
      writeBody: vi.fn(),
      registeredTypes: new Set([EMAIL_BODY_TYPE_ID]),
    } as Parameters<typeof materializeEmailFanout>[1]);
  const envelopes: Record<string, { id: string; type: string; data: unknown }> = {
    [BUNDLE_REF]: { id: BUNDLE_REF, type: "@cinatra-ai/campaigns:email-draft-bundle", data: { cinatraAgentRunId: "run-1", drafts } },
    [RECIPIENTS_REF]: { id: RECIPIENTS_REF, type: "@cinatra-ai/campaigns:recipients", data: { confirmedRecipients: recipients } },
  };
  const deps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: async (message: Mail, options: MailOptions) => {
      log.push(`mail ${message.to[0]}`);
      sent.push({ message, options });
      return { providerId: "p", providerMessageId: `m-${sent.length}`, sentAt: "2026-11-25T00:00:00Z" };
    },
    getObjectByRef: async (ref: string) => envelopes[ref] ?? null,
    emitEmailFanout: fanout,
    readDecidedBody,
    messageSendLedger: ledger,
    readRevisionStateUnderLock: async (_query: unknown, ref: { artifactId: string; representationRevisionId: string; runId: string }) => {
      verified.push(`${ref.artifactId}@${ref.representationRevisionId} in ${ref.runId}`);
      return opts?.underLock?.(ref.artifactId) ?? null;
    },
    readCallingRun: async () => ({ runId: "run-1", stepId: "send", claim: { runId: "run-1", decisionId: "d-1" } }),
    readClaimedPublishDecision: async (runId: string, decisionId: string) =>
      decisionId === "d-1" ? withDecisionId(await (deps as { readPublishDecision: (r: string, s: string) => Promise<object | null> }).readPublishDecision(runId, "send")) : null,
    readPublishDecision: async () => ({
      id: "d-1",
      status: "released",
      decidedBy: "user-2",
      surfacedValues: {
        campaignId: CAMPAIGN_ID,
        recipients: approved.map((e) => ({ name: "A person", email: e.recipientEmail, company: "A company", subject: e.subject })),
        emailBodies: approved,
        ...(opts?.surfaced ?? {}),
      },
      declaredRows: [
        ...(opts?.fromRow ? [{ label: "From", input: "senderEmail" }] : []),
        {
          kind: "list",
          label: "Recipients",
          input: "recipients",
          columns: [
            { label: "Name", field: "name" },
            { label: "Email", field: "email" },
            { label: "Company", field: "company" },
            { label: "Subject", field: "subject" },
          ],
        },
        { kind: "artifacts", label: "Emails", input: "emailBodies" },
      ],
    }),
  } as unknown as TriggerEmailSendDeps;
  const handlers = createTriggerEmailSendHandlers(createTriggerEmailSendUseCases(deps));
  const start = (request: Record<string, unknown> = {}) =>
    handlers["email_outreach_send_initial_start"]({
      input: { campaignId: CAMPAIGN_ID, approvedDraftBundleRef: BUNDLE_REF, confirmedRecipientsRef: RECIPIENTS_REF, ...request },
      actor,
    } as never) as unknown as Promise<{ status: string; sentCount: number; errorMessage?: string }>;
  return { log, sent, rows, start, verified };
}

const to = (sent: Array<{ message: Mail }>) => sent.map((s) => s.message.to[0]);

describe("cinatra#3089 — the approved send fixes each message at its send time", () => {
  it("S1 a body no longer decided at its send time is not mailed; its claim is given back", async () => {
    const f = fixture({
      read: (id, n) =>
        id === "art-2" && n === 2
          ? { ok: false, error: "revision rev-2 of artifact art-2 still waits on an open decision" }
          : undefined,
    });
    const result = await f.start();
    expect(to(f.sent)).toEqual(["p1@example.com", "p3@example.com"]);
    expect(result.status).toBe("failed");
    expect(result.sentCount).toBe(2);
    expect(result.errorMessage).toContain("its body was refused at its send time (body_decision_open)");
    expect(result.errorMessage).toContain("draft 2");
    expect(f.log).toContain("release art-2");
    expect([...f.rows.values()].map((r) => r.phase)).toEqual(["finalized", "finalized"]);
  });

  it("S2 a send-time read that answers another text than the one checked refuses that message", async () => {
    const f = fixture({
      read: (id, n) => (id === "art-1" && n === 2 ? { ok: true, text: "Another text", data: { campaignId: CAMPAIGN_ID } } : undefined),
    });
    const result = await f.start();
    expect(to(f.sent)).toEqual(["p2@example.com", "p3@example.com"]);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("draft 1");
    expect(f.sent.map((s) => s.message.textBody)).not.toContain("Another text");
  });

  it("S3 each message is read again after its claim and right before its hand-over", async () => {
    const f = fixture();
    const result = await f.start();
    expect(result).toMatchObject({ status: "completed", sentCount: 3 });
    const mailPhase = f.log.slice(f.log.indexOf("claim art-1"));
    expect(mailPhase).toEqual([
      "claim art-1", "read art-1", "mail p1@example.com",
      "claim art-2", "read art-2", "mail p2@example.com",
      "claim art-3", "read art-3", "mail p3@example.com",
    ]);
    expect(f.sent.map((s) => s.message.textBody)).toEqual(["Approved art-1", "Approved art-2", "Approved art-3"]);
  });

  it("S4 the sender is the one the card showed; another, an unreleased or an unshown sender is refused", async () => {
    const released = fixture({ surfaced: { senderEmail: "sender@example.com" }, fromRow: true });
    await released.start();
    expect(released.sent.map((s) => s.message.fromEmail)).toEqual(["sender@example.com", "sender@example.com", "sender@example.com"]);
    const same = fixture({ surfaced: { senderEmail: "sender@example.com" }, fromRow: true });
    await same.start({ senderEmail: "sender@example.com" });
    expect(to(same.sent)).toHaveLength(3);
    const refusedWith = (re: RegExp) => ({ status: "failed", errorMessage: expect.stringMatching(re) });
    const other = fixture({ surfaced: { senderEmail: "sender@example.com" }, fromRow: true });
    expect(await other.start({ senderEmail: "other@example.com" })).toMatchObject(refusedWith(/refused before any email went out: the call names another sender/));
    expect(other.sent).toEqual([]);
    const unreleased = fixture({ fromRow: true });
    expect(await unreleased.start({ senderEmail: "other@example.com" })).toMatchObject(refusedWith(/refused before any email went out: the call names a sender/));
    expect(unreleased.sent).toEqual([]);
    // Surfaced, but no row of the card showed it: never mailed from.
    const unshown = fixture({ surfaced: { senderEmail: "sender@example.com" } });
    expect(await unshown.start()).toMatchObject(refusedWith(/refused before any email went out: the sender of the released publish card could not be read \(sender_refused\)$/));
    expect(unshown.sent).toEqual([]);
    // No sender shown: the connected default mailbox sends, from no named sender.
    const none = fixture({ fromRow: true });
    await none.start();
    expect(none.sent.map((s) => s.message.fromEmail)).toEqual([undefined, undefined, undefined]);
  });

  it("S6 a claim whose check under the revision's lock refuses mails nothing for that message", async () => {
    const f = fixture({ underLock: (id) => (id === "art-2" ? "revision rev-2 of artifact art-2 is not its current revision" : null) });
    const result = await f.start();
    expect(f.verified).toEqual(["art-1@rev-1 in run-1", "art-2@rev-2 in run-1", "art-3@rev-3 in run-1"]);
    expect(to(f.sent)).toEqual(["p1@example.com", "p3@example.com"]);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("draft 2");
    expect(result.errorMessage).toContain("its body was refused when its mail was claimed (body_superseded)");
  });

  it("S7 a body reader's returned text (a store error) reaches neither the answer nor any log line, at the check, at the send time or under the lock", async () => {
    const RAW = "revision rev-2 of artifact art-2 could not be read: connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432/app (owner p9@example.com)";
    const logged: string[] = [];
    const spies = (["warn", "error", "log", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" "))),
    );
    try {
      const atCheck = await fixture({ read: (id, n) => (id === "art-2" && n === 1 ? { ok: false, error: RAW } : undefined) }).start();
      expect(atCheck.errorMessage).toContain("approved body 2 was refused (body_read_failed)");
      const atSend = await fixture({ read: (id, n) => (id === "art-2" && n === 2 ? { ok: false, error: RAW } : undefined) }).start();
      expect(atSend.errorMessage).toContain("its body was refused at its send time (body_read_failed)");
      const underLock = await fixture({ underLock: (id) => (id === "art-2" ? RAW : null) }).start();
      expect(underLock.errorMessage).toContain("its body was refused when its mail was claimed (body_read_failed)");
      for (const text of [atCheck.errorMessage, atSend.errorMessage, underLock.errorMessage, ...logged]) {
        expect(text).not.toContain("postgres://");
        expect(text).not.toContain("hunter2");
        expect(text).not.toContain("p9@example.com");
        expect(text).not.toContain("ECONNREFUSED");
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("S5 the contact the mail is recorded for is the released entry's", async () => {
    // The bundle's drafts join their entries by `recipientId` and carry no
    // contact of their own: the record names the released entry's contact.
    const f = fixture();
    await f.start();
    expect(f.sent.map((s) => s.options.correlation?.contactId)).toEqual(["c1", "c2", "c3"]);
  });
});
