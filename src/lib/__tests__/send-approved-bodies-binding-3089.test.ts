/**
 * cinatra#3089 — the approved send reads each body as the acting actor, and
 * binds every message to its approved revision before the first mail.
 *
 * The send is driven through `createTriggerEmailSendHandlers` and
 * `createTriggerEmailSendUseCases`. Where a case needs the production seam (the
 * default body reader, the default fan-out with its type discovery), the module
 * that seam loads is mocked and the seam itself runs.
 *
 * Cases:
 *   A1 the default reader reads each body as the acting actor; a body that
 *      actor may not read refuses the send, nothing is mailed, and the answer
 *      does not tell that the artifact exists
 *   A2 a body the acting actor may read is mailed as before
 *   T1 a failed type discovery refuses the approved send before any mail
 *   T2 a failed type discovery leaves the reference-only send as it was: the
 *      bundle is mailed and no body is filed
 *   N1 bundles without a run id refuse the approved send before any mail
 *   B1 a binding refused at the second of three messages: nothing is mailed and
 *      the third is never bound
 *   B2 a fan-out that leaves a message unbound refuses the send before any mail
 *   B3 a mail failed at message 2 of 3, then a retry: deliveries per recipient
 *      across both calls are 1, 0, 1 (message 2 stays in doubt)
 *   I1 the same approved call twice mails every recipient once
 *   I2 two concurrent approved calls mail each message at most once
 *   I3 a claim without a hand-over is not mailed by the retry and is in doubt
 *   I4 a mail stopped before any provider was reached is given back and mailed
 *      by the retry
 *   R1 the reference-only form is unchanged
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { createTriggerEmailSendHandlers } from "@cinatra-ai/trigger-email-send";

const { readRevisionMock, typesListMock, bindRevisionMock, writeRevisionMock } = vi.hoisted(() => ({
  readRevisionMock: vi.fn(),
  typesListMock: vi.fn(),
  bindRevisionMock: vi.fn(),
  writeRevisionMock: vi.fn(),
}));

vi.mock("../artifacts/current-decided-revision-read", () => ({
  readCurrentDecidedRevision: readRevisionMock,
}));
vi.mock("@cinatra-ai/objects", () => ({
  createDeterministicObjectsClient: () => ({ typesList: typesListMock }),
}));
vi.mock("../artifacts/run-artifact-materializer", () => ({
  bindFanoutMessageRevision: bindRevisionMock,
  materializeFanoutMessageRevision: writeRevisionMock,
}));

import {
  createTriggerEmailSendUseCases,
  EMAIL_BODY_TYPE_ID,
  MailNotHandedOverError,
  materializeEmailFanout,
  type DecidedBodyRead,
  type EmailFanoutArgs,
  type EmailFanoutResult,
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

const drafts = [1, 2, 3].map((n) => ({
  recipientId: `c${n}`,
  recipientEmail: `p${n}@example.com`,
  subject: `Bundle subject ${n}`,
  body: `Bundle body ${n}`,
}));
const recipients = [1, 2, 3].map((n) => ({ contactId: `c${n}`, email: `p${n}@example.com` }));
const approved = [1, 2, 3].map((n) => ({
  artifactId: `art-${n}`,
  representationRevisionId: `rev-${n}`,
  contactId: `c${n}`,
}));
const UNSEEN = "artifact art-2 is not an artifact this organisation can see";

type Ledger = Map<string, { artifactId: string; representationRevisionId: string }>;

function makeFixture(opts?: {
  runId?: string | null;
  /** "production" leaves the seam out, so the shipped default runs. */
  readDecidedBody?: "production";
  emitEmailFanout?: TriggerEmailSendDeps["emitEmailFanout"] | "production";
  ledger?: Ledger;
  failMailAt?: number;
  /** The message send records; shared between calls of one case. */
  sendLedger?: ReturnType<typeof memorySendLedger>;
  /** Shared between calls of one case, so deliveries add up. */
  sent?: Array<{ to: string[]; textBody: string }>;
  /** Let each mail wait a turn, so two calls interleave. */
  slowMail?: boolean;
}) {
  const sendLedger = opts?.sendLedger ?? memorySendLedger();
  const sent: Array<{ to: string[]; textBody: string }> = opts?.sent ?? [];
  let attempts = 0;
  const sendEmail = vi.fn(async (message: { to: string[]; textBody: string }) => {
    attempts += 1;
    if (opts?.slowMail) await new Promise((resolve) => setTimeout(resolve, 5));
    if (opts?.failMailAt === attempts) throw new Error("the mail transport failed");
    sent.push(message);
    return { providerId: "p", providerMessageId: `m-${attempts}`, sentAt: "2026-11-25T00:00:00Z" };
  });
  const runId = opts?.runId === undefined ? "run-1" : opts.runId;
  const envelopes: Record<string, { id: string; type: string; data: unknown }> = {
    [BUNDLE_REF]: {
      id: BUNDLE_REF,
      type: "@cinatra-ai/campaigns:email-draft-bundle",
      data: { ...(runId ? { cinatraAgentRunId: runId } : {}), drafts },
    },
    [RECIPIENTS_REF]: { id: RECIPIENTS_REF, type: "@cinatra-ai/campaigns:recipients", data: { confirmedRecipients: recipients } },
  };
  // A ledger that answers a message's own row on a retry, as the shipped
  // binder does (find the row, else record it and read it back).
  const ledger: Ledger = opts?.ledger ?? new Map();
  const bindBody = vi.fn(
    async (b: { outputId: string; artifactId: string; representationRevisionId: string }) => {
      const own = ledger.get(b.outputId);
      if (own) return { ok: true as const, ...own, deduped: true };
      ledger.set(b.outputId, { artifactId: b.artifactId, representationRevisionId: b.representationRevisionId });
      return { ok: true as const, artifactId: b.artifactId, representationRevisionId: b.representationRevisionId, deduped: false };
    },
  );
  const writeBody = vi.fn();
  const realFanout = (args: EmailFanoutArgs) =>
    materializeEmailFanout(args, {
      bindBody,
      writeBody,
      registeredTypes: new Set([EMAIL_BODY_TYPE_ID]),
    } as Parameters<typeof materializeEmailFanout>[1]);
  const emitEmailFanout =
    opts?.emitEmailFanout === "production" ? undefined : (opts?.emitEmailFanout ?? realFanout);
  const readDecidedBody =
    opts?.readDecidedBody === "production"
      ? undefined
      : async (ref: { artifactId: string }): Promise<DecidedBodyRead> => ({
          ok: true,
          text: `Approved ${ref.artifactId}`,
          data: {},
        });
  const deps: TriggerEmailSendDeps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: sendEmail as unknown as TriggerEmailSendDeps["sendEmail"],
    getObjectByRef: async (ref) => envelopes[ref] ?? null,
    ...(emitEmailFanout ? { emitEmailFanout } : {}),
    ...(readDecidedBody ? { readDecidedBody } : {}),
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
    } as never) as unknown as Promise<{
      status: string;
      sentCount: number;
      errorMessage?: string;
      alreadySentCount?: number;
      inDoubtCount?: number;
    }>;
  return { sent, sendEmail, bindBody, writeBody, ledger, sendLedger, start };
}

beforeEach(() => {
  vi.clearAllMocks();
  typesListMock.mockResolvedValue({ types: [{ type: EMAIL_BODY_TYPE_ID }] });
  readRevisionMock.mockImplementation(async (input: { artifactId: string; actor?: { principalId?: string } }) =>
    input.actor?.principalId === "user-1"
      ? { ok: true, artifactId: input.artifactId, representationRevisionId: "x", text: `Approved ${input.artifactId}`, data: {} }
      : { ok: false, error: `artifact ${input.artifactId} is not an artifact this organisation can see` },
  );
});

describe("cinatra#3089 — the approved send reads as the actor and binds before it mails", () => {
  it("A1 a body the acting actor may not read refuses the send, mails nothing and does not tell that it exists", async () => {
    // The production reader runs: it is handed the acting actor and the run.
    readRevisionMock.mockImplementation(async (input: { artifactId: string; actor?: { principalId?: string } }) =>
      input.artifactId === "art-2" || input.actor?.principalId !== "user-1"
        ? { ok: false, error: `artifact ${input.artifactId} is not an artifact this organisation can see` }
        : { ok: true, artifactId: input.artifactId, representationRevisionId: "x", text: "t", data: {} },
    );
    const fx = makeFixture({ readDecidedBody: "production" });
    const result = await fx.start({ approvedBodies: approved });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain(`approved body 2: ${UNSEEN}`);
    expect(result.errorMessage).not.toMatch(/type|revision rev-2/);
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(fx.bindBody).not.toHaveBeenCalled();
    expect(readRevisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        runId: "run-1",
        artifactId: "art-1",
        representationRevisionId: "rev-1",
        objectTypeId: EMAIL_BODY_TYPE_ID,
        actor: expect.objectContaining({ principalId: "user-1", organizationId: "org-1" }),
      }),
    );
  });

  it("A2 a body the acting actor may read is mailed as before", async () => {
    const fx = makeFixture({ readDecidedBody: "production" });
    const result = await fx.start({ approvedBodies: approved });
    expect(result.status).toBe("completed");
    // red-first-expect: expected [ 'Bundle body 1', …(2) ] to deeply equal [ 'Approved art-1', …(2) ]
    expect(fx.sent.map((m) => m.textBody)).toEqual(["Approved art-1", "Approved art-2", "Approved art-3"]);
  });

  it("T1 a failed type discovery refuses the approved send before any mail", async () => {
    typesListMock.mockRejectedValue(new Error("objects unavailable"));
    const fx = makeFixture({ emitEmailFanout: "production" });
    const result = await fx.start({ approvedBodies: approved });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("the registered object types could not be read");
    expect(fx.sendEmail).not.toHaveBeenCalled();
    expect(bindRevisionMock).not.toHaveBeenCalled();
  });

  it("T2 a failed type discovery leaves the reference-only send as it was", async () => {
    typesListMock.mockRejectedValue(new Error("objects unavailable"));
    const fx = makeFixture({ emitEmailFanout: "production" });
    const result = await fx.start({});
    expect(result.status).toBe("completed");
    expect(fx.sent.map((m) => m.textBody)).toEqual(["Bundle body 1", "Bundle body 2", "Bundle body 3"]);
    expect(writeRevisionMock).not.toHaveBeenCalled();
  });

  it("N1 bundles without a run id refuse the approved send before any mail", async () => {
    const fx = makeFixture({ runId: null });
    const result = await fx.start({ approvedBodies: approved });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("the campaign bundles carry no run id");
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("B1 a binding refused at the second of three messages mails nothing and never binds the third", async () => {
    const fx = makeFixture();
    fx.bindBody.mockImplementationOnce(async (b) => ({
      ok: true as const,
      artifactId: b.artifactId,
      representationRevisionId: b.representationRevisionId,
      deduped: false,
    }));
    fx.bindBody.mockImplementationOnce(async () => ({ ok: false, error: "the ledger refused the row" }) as never);
    const result = await fx.start({ approvedBodies: approved });
    // red-first-expect: expected 'completed' to be 'failed'
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("the ledger refused the row");
    expect(fx.bindBody).toHaveBeenCalledTimes(2);
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("B2 a fan-out that leaves a message unbound refuses the send before any mail", async () => {
    const emitEmailFanout = vi.fn(
      async (): Promise<EmailFanoutResult> => ({
        bodies: [
          { typeId: EMAIL_BODY_TYPE_ID, externalId: "e1", objectId: "art-1", isNew: false },
          { typeId: EMAIL_BODY_TYPE_ID, externalId: "e3", objectId: "art-3", isNew: false },
        ],
        skipped: { bodies: false },
      }),
    );
    const skipped = vi.fn(async (): Promise<EmailFanoutResult> => ({ bodies: [], skipped: { bodies: true } }));
    for (const [emit, words] of [
      [emitEmailFanout, "draft 2 of the bundle was not bound to its approved body"],
      [skipped, `the body type ${EMAIL_BODY_TYPE_ID} is not registered`],
    ] as const) {
      const fx = makeFixture({ emitEmailFanout: emit });
      const result = await fx.start({ approvedBodies: approved });
      // red-first-expect: expected 'completed' to be 'failed'
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain(words);
      expect(fx.sendEmail).not.toHaveBeenCalled();
    }
  });

  it("B3 a retry after a mail failed at message 2 of 3 mails message 3, never message 1 again, and leaves message 2 in doubt", async () => {
    const ledger: Ledger = new Map();
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; textBody: string }> = [];
    const first = makeFixture({ ledger, sendLedger, sent, failMailAt: 2 });
    const failed = await first.start({ approvedBodies: approved });
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toContain("the mail transport failed");
    // Every binding was written before the first mail.
    // red-first-expect: expected "vi.fn()" to be called 3 times, but got 0 times
    expect(first.bindBody).toHaveBeenCalledTimes(3);
    const written = new Map(ledger);
    expect([...written.values()].map((v) => v.artifactId)).toEqual(["art-1", "art-2", "art-3"]);
    // The answer counts the mail this call handed over.
    expect(failed.sentCount).toBe(1);

    const retry = makeFixture({ ledger, sendLedger, sent });
    const done = await retry.start({ approvedBodies: approved });
    expect(ledger).toEqual(written);
    // Deliveries across BOTH calls, per recipient: message 1 once, message 2
    // never (its failed hand-over may or may not have reached the provider, so
    // no call mails it again), message 3 once, by the retry.
    const deliveries = (to: string) => sent.filter((m) => m.to[0] === to).length;
    expect(["p1@example.com", "p2@example.com", "p3@example.com"].map(deliveries)).toEqual([1, 0, 1]);
    expect(done).toMatchObject({ status: "failed", sentCount: 1, alreadySentCount: 1, inDoubtCount: 1 });
    expect(done.errorMessage).toContain("draft 2 (email-body:run-1:idx-1)");
    expect(done.errorMessage).toContain("in doubt");
  });

  it("I1 the same approved call twice mails every recipient once; the second mails nobody and reports them as already sent", async () => {
    const sendLedger = memorySendLedger();
    const ledger: Ledger = new Map();
    const sent: Array<{ to: string[]; textBody: string }> = [];
    const one = await makeFixture({ ledger, sendLedger, sent }).start({ approvedBodies: approved });
    const again = makeFixture({ ledger, sendLedger, sent });
    const two = await again.start({ approvedBodies: approved });
    // red-first-expect: expected { …(7) } to match object { status: 'completed', …(3) }
    expect(one).toMatchObject({ status: "completed", sentCount: 3, alreadySentCount: 0, inDoubtCount: 0 });
    expect(again.sendEmail).not.toHaveBeenCalled();
    expect(sent.map((m) => m.to[0])).toEqual(["p1@example.com", "p2@example.com", "p3@example.com"]);
    expect(two).toMatchObject({ status: "completed", sentCount: 0, alreadySentCount: 3, inDoubtCount: 0 });
    expect(two.errorMessage).toBeUndefined();
  });

  it("I2 two concurrent approved calls mail each message at most once", async () => {
    const sendLedger = memorySendLedger();
    const ledger: Ledger = new Map();
    const sent: Array<{ to: string[]; textBody: string }> = [];
    const [a, b] = await Promise.all([
      makeFixture({ ledger, sendLedger, sent, slowMail: true }).start({ approvedBodies: approved }),
      makeFixture({ ledger, sendLedger, sent, slowMail: true }).start({ approvedBodies: approved }),
    ]);
    const deliveries = (to: string) => sent.filter((m) => m.to[0] === to).length;
    // red-first-expect: expected [ 2, 2, 2 ] to deeply equal [ 1, 1, 1 ]
    expect(["p1@example.com", "p2@example.com", "p3@example.com"].map(deliveries)).toEqual([1, 1, 1]);
    expect(a.sentCount + b.sentCount).toBe(3);
    // A message the other call holds while it is in flight is reported, not mailed.
    expect((a.inDoubtCount ?? 0) + (a.alreadySentCount ?? 0) + a.sentCount).toBe(3);
    expect((b.inDoubtCount ?? 0) + (b.alreadySentCount ?? 0) + b.sentCount).toBe(3);
  });

  it("I3 a message claimed by a call that stopped before the hand-over is not mailed by the retry and is reported in doubt", async () => {
    const sendLedger = memorySendLedger();
    // The earlier call claimed message 1 and stopped: no mark, no release.
    const held = await sendLedger.ledger.claim(
      { runId: "run-1", outputId: "email-body:run-1:idx-0", artifactId: "art-1", representationRevisionId: "rev-1" },
      actor,
    );
    expect(held.kind).toBe("won");
    const fx = makeFixture({ sendLedger });
    const result = await fx.start({ approvedBodies: approved });
    // red-first-expect: expected [ 'p1@example.com', …(2) ] to deeply equal [ 'p2@example.com', 'p3@example.com' ]
    expect(fx.sent.map((m) => m.to[0])).toEqual(["p2@example.com", "p3@example.com"]);
    expect(result).toMatchObject({ status: "failed", sentCount: 2, alreadySentCount: 0, inDoubtCount: 1 });
    expect(result.errorMessage).toContain("draft 1 (email-body:run-1:idx-0)");
    expect(result.errorMessage).toContain("in doubt");
  });

  it("I4 a mail stopped before any provider was reached gives its claim back, and the retry mails it", async () => {
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; textBody: string }> = [];
    const first = makeFixture({ sendLedger, sent });
    first.sendEmail.mockImplementationOnce(async () => {
      throw new MailNotHandedOverError("No connected email connector is available.");
    });
    const stopped = await first.start({ approvedBodies: approved });
    // red-first-expect: expected { …(7) } to match object { status: 'failed', …(2) }
    expect(stopped).toMatchObject({ status: "failed", sentCount: 0, inDoubtCount: 0 });
    expect(stopped.errorMessage).toContain("no mail provider was reached");
    const retry = await makeFixture({ sendLedger, sent }).start({ approvedBodies: approved });
    expect(retry).toMatchObject({ status: "completed", sentCount: 3, alreadySentCount: 0, inDoubtCount: 0 });
    expect(sent.map((m) => m.to[0])).toEqual(["p1@example.com", "p2@example.com", "p3@example.com"]);
  });

  it("R1 the reference-only form is unchanged: every call mails the whole bundle, keeps no send record and adds no field", async () => {
    const sendLedger = memorySendLedger();
    const claim = vi.spyOn(sendLedger.ledger, "claim");
    const sent: Array<{ to: string[]; textBody: string }> = [];
    const one = await makeFixture({ sendLedger, sent }).start({});
    const two = await makeFixture({ sendLedger, sent }).start({});
    expect(sent.map((m) => m.textBody)).toEqual([
      "Bundle body 1", "Bundle body 2", "Bundle body 3",
      "Bundle body 1", "Bundle body 2", "Bundle body 3",
    ]);
    expect(claim).not.toHaveBeenCalled();
    for (const answer of [one, two]) {
      expect(answer).toMatchObject({ status: "completed", sentCount: 3 });
      expect(answer).not.toHaveProperty("alreadySentCount");
      expect(answer).not.toHaveProperty("inDoubtCount");
    }
    // A failed mail still reports no count, as before.
    const failed = await makeFixture({ sendLedger, failMailAt: 2 }).start({});
    expect(failed).toMatchObject({ status: "failed", sentCount: 0 });
    expect(failed).not.toHaveProperty("inDoubtCount");
  });
});
