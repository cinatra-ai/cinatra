// red-first-expect: Cannot find module '/src/lib/approved-body-send'
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
 *   N1 a call without a run reads no released list: the bundle is mailed as in
 *      the reference-only form and no approved body is read
 *   B1 a binding refused at the second of three messages: nothing is mailed and
 *      the third is never bound
 *   B2 a fan-out that leaves a message unbound refuses the send before any mail
 *   B4 a binder refusal that quotes a store error answers a fixed code only
 *   B3 a mail failed at message 2 of 3, then a retry: deliveries per recipient
 *      across both calls are 1, 0, 1 (message 2 stays in doubt)
 *   I1 the same approved call twice mails every recipient once
 *   I2 two concurrent approved calls mail each message at most once
 *   I3 a claim without a hand-over is not mailed by the retry and is in doubt
 *   H1-H5 the shipped mail sender tells a failure before the hand-over to the
 *      transport from one at or after it: no connected mailbox, no installed
 *      connector, the development redirect on with no address are given back
 *      and mailed by the retry; a transport that throws, and a provider that
 *      answers with a rejection, leave the message in doubt
 *   M1-M3 a mail handed over whose done mark cannot be written is counted
 *      and named in doubt and the answer is failed; the record is written
 *      again a bounded number of times when the write throws
 *   R1 the reference-only form is unchanged
 *   R2 the default deps keep the facade sender for the reference-only form
 *      and the test send (no mailbox check, no pinned connector); only the
 *      approved form's sender checks the mailbox and pins the connector
 *   D1 a provider that fails on recipient two: the call stops there (recipient
 *      three is not attempted), answers failed with sentCount 1 and names
 *      recipient two in doubt (by draft, message and contact, no address) with
 *      the manual check; a new approval mails recipient three only: recipient
 *      one is skipped, recipient two is not mailed again
 *   L1 a provider error, or a mailbox status, that quotes an address reaches
 *      neither the answer nor any log line: each failure answers a fixed code
 *   P1 no request routes a publishing-step call (a decision governs its step)
 *      into the reference-only form: a decision with no approved list, one not
 *      released, or a signed call with no decision is refused before any mail
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { createTriggerEmailSendHandlers } from "@cinatra-ai/trigger-email-send";

const {
  readRevisionMock,
  typesListMock,
  bindRevisionMock,
  writeRevisionMock,
  transportMock,
  mailboxes,
  routing,
} = vi.hoisted(() => ({
  readRevisionMock: vi.fn(),
  typesListMock: vi.fn(),
  bindRevisionMock: vi.fn(),
  writeRevisionMock: vi.fn(),
  // The mail facade's send: the hand-over to the provider's transport.
  transportMock: vi.fn(),
  // The installed email connectors (the mailbox lookup).
  mailboxes: { list: [] as Array<{ definition: { connectorId: string; name: string }; getStatus: () => Promise<{ status: string; detail?: string }> }> },
  // The host routing: the routed connector and the development redirect.
  routing: { connectorId: null as string | null, redirectOn: false, redirectTo: "" },
}));

vi.mock("../artifacts/current-decided-revision-read", async (importOriginal) => ({
  // The refusal class stays the module's own, so a refusal answers its code.
  ReviewedArtifactsRequiredError: (await importOriginal<typeof import("../artifacts/current-decided-revision-read")>()).ReviewedArtifactsRequiredError,
  readCurrentDecidedRevision: readRevisionMock,
}));
vi.mock("@cinatra-ai/objects", () => ({
  createDeterministicObjectsClient: () => ({ typesList: typesListMock }),
}));
vi.mock("../artifacts/run-artifact-materializer", () => ({
  bindFanoutMessageRevision: bindRevisionMock,
  materializeFanoutMessageRevision: writeRevisionMock,
}));
vi.mock("../email-transport-provider", () => ({
  requireEmailSystemFacade: () => ({ sendEmail: transportMock }),
}));
vi.mock("../email-send-providers", () => ({
  resolveEmailSendProviders: () => mailboxes.list,
  resolveHostEmailRouting: () => ({
    resolveConnectorId: async () => routing.connectorId,
    // The host's override: with the redirect on and no address it throws.
    applyDevModeOverride: <M extends { to: string[] }>(msg: M): M => {
      if (!routing.redirectOn) return msg;
      if (!routing.redirectTo) {
        throw new Error("Development mode is enabled, but no override recipient email is configured.");
      }
      return { ...msg, to: [routing.redirectTo] };
    },
  }),
}));

import {
  buildLazyDefaultDeps,
  createTriggerEmailSendUseCases,
  EMAIL_BODY_TYPE_ID,
  materializeEmailFanout,
  type DecidedBodyRead,
  type EmailFanoutArgs,
  type EmailFanoutResult,
  type MessageSendLedger,
  type TriggerEmailSendDeps,
} from "../trigger-email-send-use-cases";

// Loaded inside the test that needs it, so the file loads before the change and a missing module fails that test.
const createDefaultSendEmail = async () => (await import("../approved-body-send")).createDefaultSendEmail();

// The claim the passthrough route took for the call (cinatra#3089): the decision the call was signed for, else the
// step's decision, `d-1`; each stubbed decision carries that id unless it names its own.
const withClaim = <T extends { runId: string; publishDecisionId?: string; claim?: unknown } | null>(run: T): T =>
  run && !run.claim ? { ...run, claim: { runId: run.runId, decisionId: run.publishDecisionId ?? "d-1" } } : run;
const withDecisionId = <T extends object | null | undefined>(decision: T): T =>
  decision ? ({ id: "d-1", ...decision } as T) : decision;


/** A stand-in for the message send records with the claim's semantics: the
 *  first claim of a message wins (checked and set with no await between, so
 *  concurrent calls cannot both win), a sent message reads "done", and a
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
function releasedCardFor(named: unknown) {
  const list = (named === undefined ? [] : typeof named === "string" ? JSON.parse(named) : named) as Array<{
    recipientEmail: string;
    subject: string;
  }>;
  return {
    status: "released" as const,
    decidedBy: "user-2",
    surfacedValues: {
      campaignId: CAMPAIGN_ID,
      recipients: list.map((e) => ({ email: e.recipientEmail, subject: e.subject })),
      ...(named === undefined ? {} : { emailBodies: named }),
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

// Each draft holds the text its body was filed from (with a trailing newline
// the filed revision does not carry; trailing white space is not compared).
const drafts = [1, 2, 3].map((n) => ({
  recipientId: `c${n}`,
  recipientEmail: `p${n}@example.com`,
  subject: `Bundle subject ${n}`,
  body: `Approved art-${n}\n`,
}));
const recipients = [1, 2, 3].map((n) => ({ contactId: `c${n}`, email: `p${n}@example.com` }));
const approved = [1, 2, 3].map((n) => ({
  artifactId: `art-${n}`,
  representationRevisionId: `rev-${n}`,
  contactId: `c${n}`,
  recipientEmail: `p${n}@example.com`,
  subject: `Bundle subject ${n}`,
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
  /** The mail sender in place of the recording stand-in (the shipped one). */
  sendEmail?: TriggerEmailSendDeps["sendEmail"];
  /** The id of the released decision this call was signed for (a new approval
   *  is a new id); the decision read carries it. */
  decisionId?: string;
  /** The decision read, in place of the released card of the case's list. */
  decision?: unknown;
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
  // binder does (find the row, else record it and read it back). A message
  // bound to another revision is refused, as the shipped binder refuses it,
  // unless it is another revision of the same artifact and the message has no
  // send record (`moveUnsentBinding`): then the binding moves.
  const ledger: Ledger = opts?.ledger ?? new Map();
  const bindBody = vi.fn(
    async (b: { outputId: string; artifactId: string; representationRevisionId: string }) => {
      const own = ledger.get(b.outputId);
      if (own && own.artifactId === b.artifactId && own.representationRevisionId === b.representationRevisionId) {
        return { ok: true as const, ...own, deduped: true };
      }
      if (own && (own.artifactId !== b.artifactId || sendLedger.rows.has(b.outputId))) {
        return {
          ok: false as const,
          error: `message ${b.outputId} of run ${runId} is already bound to revision ${own.representationRevisionId} of artifact ${own.artifactId}`,
        };
      }
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
          data: { campaignId: CAMPAIGN_ID },
        });
  const governing = () =>
    opts && "decision" in opts
      ? opts.decision
      : named === undefined
        ? null
        : { ...(opts?.decisionId ? { id: opts.decisionId } : {}), ...releasedCardFor(named) };
  const deps: TriggerEmailSendDeps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: opts?.sendEmail ?? (sendEmail as unknown as TriggerEmailSendDeps["sendEmail"]),
    getObjectByRef: async (ref) => envelopes[ref] ?? null,
    ...(emitEmailFanout ? { emitEmailFanout } : {}),
    ...(readDecidedBody ? { readDecidedBody } : {}),
    messageSendLedger: sendLedger.ledger,
    // A run without bodies filed for review, so the reference-only form runs.
    readRunReviewedBodies: async () => false,
    readObjectRuns: async () => [],
    // The run of the call follows the case's run: none when the case has none.
    readCallingRun: async () =>
      withClaim(runId ? { runId, stepId: "send", ...(opts?.decisionId ? { publishDecisionId: opts.decisionId } : {}) } : null),
    // A case that names no list calls from a step no publish decision governs.
    readPublishDecision: async () => withDecisionId(governing() as object | null),
    readClaimedPublishDecision: async (_runId: string, decisionId: string) => {
      const decision = withDecisionId(governing() as { id?: string } | null);
      return decision?.id === decisionId ? decision : null;
    },
  } as unknown as TriggerEmailSendDeps;
  let named: unknown;
  const handlers = createTriggerEmailSendHandlers(createTriggerEmailSendUseCases(deps));
  // `releasedList` is what the stubbed decision surfaced; every other key goes
  // to the tool as the request.
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
    } as never) as unknown as Promise<{
      status: string;
      sentCount: number;
      errorMessage?: string;
      alreadySentCount?: number;
      inDoubtCount?: number;
    }>;
  };
  return { sent, sendEmail, bindBody, writeBody, ledger, sendLedger, start };
}

/** One connected mailbox, routed by the sender identity. */
function connectedMailbox(status = "connected") {
  return {
    definition: { connectorId: "mailbox-a", name: "Mailbox A" },
    getStatus: async () => ({ status, ...(status === "connected" ? {} : { detail: "not signed in" }) }),
  };
}

/** The transport, recording each message it took. */
function recordingTransport(sent: Array<{ to: string[]; textBody: string }>) {
  return async (message: { to: string[]; textBody: string }) => {
    sent.push(message);
    return { providerId: "mailbox-a", providerMessageId: `m-${sent.length}`, sentAt: "2026-11-25T00:00:00Z" };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transportMock.mockReset();
  mailboxes.list = [connectedMailbox()];
  routing.connectorId = "mailbox-a";
  routing.redirectOn = false;
  routing.redirectTo = "";
  typesListMock.mockResolvedValue({ types: [{ type: EMAIL_BODY_TYPE_ID }] });
  readRevisionMock.mockImplementation(async (input: { artifactId: string; actor?: { principalId?: string } }) =>
    input.actor?.principalId === "user-1"
      ? { ok: true, artifactId: input.artifactId, representationRevisionId: "x", text: `Approved ${input.artifactId}`, data: { campaignId: CAMPAIGN_ID } }
      : { ok: false, error: `artifact ${input.artifactId} is not an artifact this organisation can see` },
  );
});

describe("cinatra#3089 — the approved send reads as the actor and binds before it mails", () => {
  it("A1 a body the acting actor may not read refuses the send, mails nothing and does not tell that it exists", async () => {
    // The production reader runs: it is handed the acting actor and the run.
    readRevisionMock.mockImplementation(async (input: { artifactId: string; actor?: { principalId?: string } }) =>
      input.artifactId === "art-2" || input.actor?.principalId !== "user-1"
        ? { ok: false, error: `artifact ${input.artifactId} is not an artifact this organisation can see` }
        : { ok: true, artifactId: input.artifactId, representationRevisionId: "x", text: `Approved ${input.artifactId}`, data: { campaignId: CAMPAIGN_ID } },
    );
    const fx = makeFixture({ readDecidedBody: "production" });
    const result = await fx.start({ releasedList: approved });
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
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("completed");
    expect(fx.sent.map((m) => m.textBody)).toEqual(["Approved art-1", "Approved art-2", "Approved art-3"]);
  });

  it("T1 a failed type discovery refuses the approved send before any mail", async () => {
    typesListMock.mockRejectedValue(new Error("objects unavailable"));
    const fx = makeFixture({ emitEmailFanout: "production" });
    const result = await fx.start({ releasedList: approved });
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
    expect(fx.sent.map((m) => m.textBody)).toEqual(["Approved art-1\n", "Approved art-2\n", "Approved art-3\n"]);
    expect(writeRevisionMock).not.toHaveBeenCalled();
  });

  it("N1 a call without a run reads no released list: the bundle is mailed as before", async () => {
    const fx = makeFixture({ runId: null });
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("completed");
    expect(fx.sent.map((m) => m.textBody)).toEqual(["Approved art-1\n", "Approved art-2\n", "Approved art-3\n"]);
    expect(fx.bindBody).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("alreadySentCount");
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
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("was refused (bind_refused)");
    expect(fx.bindBody).toHaveBeenCalledTimes(2);
    expect(fx.sendEmail).not.toHaveBeenCalled();
  });

  it("B4 a binder refusal that quotes a store error reaches neither the answer nor a log line: a fixed code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = 'message body binding failed: duplicate key value violates unique constraint "p2@example.com"';
    const fx = makeFixture();
    fx.bindBody.mockImplementationOnce(async () => ({ ok: false, error: raw }) as never);
    const result = await fx.start({ releasedList: approved });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("was refused (bind_refused)");
    expect(JSON.stringify(result)).not.toContain("duplicate key");
    expect(JSON.stringify(result)).not.toContain("p2@example.com");
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain("duplicate key");
    expect(fx.sendEmail).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
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
      const result = await fx.start({ releasedList: approved });
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
    const failed = await first.start({ releasedList: approved });
    expect(failed.status).toBe("failed");
    // Every binding was written before the first mail.
    expect(first.bindBody).toHaveBeenCalledTimes(3);
    const written = new Map(ledger);
    expect([...written.values()].map((v) => v.artifactId)).toEqual(["art-1", "art-2", "art-3"]);
    // The answer counts the mail this call handed over.
    expect(failed.sentCount).toBe(1);
    // A fixed code, never the provider's own text (cinatra#3089).
    expect(failed.errorMessage).toContain("may or may not have gone out (provider_error)");
    expect(failed.errorMessage).not.toContain("the mail transport failed");

    const retry = makeFixture({ ledger, sendLedger, sent });
    const done = await retry.start({ releasedList: approved });
    expect(ledger).toEqual(written);
    // Deliveries across BOTH calls, per recipient: message 1 once, message 2
    // never (its failed hand-over may or may not have reached the provider, so
    // no call mails it again), message 3 once, by the retry.
    const deliveries = (to: string) => sent.filter((m) => m.to[0] === to).length;
    expect(["p1@example.com", "p2@example.com", "p3@example.com"].map(deliveries)).toEqual([1, 0, 1]);
    expect(done).toMatchObject({ status: "failed", sentCount: 1, alreadySentCount: 1, inDoubtCount: 1 });
    expect(done.errorMessage).toContain("draft 2 (email-body:run-1:art-2)");
    expect(done.errorMessage).toContain("in doubt");
  });

  it("I1 the same approved call twice mails every recipient once; the second mails nobody and reports them as already sent", async () => {
    const sendLedger = memorySendLedger();
    const ledger: Ledger = new Map();
    const sent: Array<{ to: string[]; textBody: string }> = [];
    const one = await makeFixture({ ledger, sendLedger, sent }).start({ releasedList: approved });
    const again = makeFixture({ ledger, sendLedger, sent });
    const two = await again.start({ releasedList: approved });
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
      makeFixture({ ledger, sendLedger, sent, slowMail: true }).start({ releasedList: approved }),
      makeFixture({ ledger, sendLedger, sent, slowMail: true }).start({ releasedList: approved }),
    ]);
    const deliveries = (to: string) => sent.filter((m) => m.to[0] === to).length;
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
      {
        runId: "run-1",
        path: "email_fanout",
        bindingOutputId: "email-body:run-1:art-1",
        effect: "message-send",
        artifactId: "art-1",
        representationRevisionId: "rev-1",
      },
      actor,
    );
    expect(held.kind).toBe("won");
    const fx = makeFixture({ sendLedger });
    const result = await fx.start({ releasedList: approved });
    expect(fx.sent.map((m) => m.to[0])).toEqual(["p2@example.com", "p3@example.com"]);
    expect(result).toMatchObject({ status: "failed", sentCount: 2, alreadySentCount: 0, inDoubtCount: 1 });
    expect(result.errorMessage).toContain("draft 1 (email-body:run-1:art-1)");
    expect(result.errorMessage).toContain("in doubt");
  });

  it("H1 no connected mailbox stops before the hand-over: the claim is given back and the retry mails it", async () => {
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; textBody: string }> = [];
    transportMock.mockImplementation(recordingTransport(sent));
    mailboxes.list = [connectedMailbox("not_connected")];
    const stopped = await makeFixture({ sendLedger, sendEmail: await createDefaultSendEmail() }).start({
      releasedList: approved,
    });
    expect(stopped).toMatchObject({ status: "failed", sentCount: 0, inDoubtCount: 0 });
    expect(stopped.errorMessage).toContain("no mail provider was reached");
    expect(stopped.errorMessage).toContain("no mail provider was reached (provider_not_reached)");
    expect(stopped.errorMessage).not.toContain("Mailbox A is not connected");
    expect(transportMock).not.toHaveBeenCalled();
    mailboxes.list = [connectedMailbox()];
    const retry = await makeFixture({ sendLedger, sendEmail: await createDefaultSendEmail() }).start({
      releasedList: approved,
    });
    expect(retry).toMatchObject({ status: "completed", sentCount: 3, alreadySentCount: 0, inDoubtCount: 0 });
    expect(sent.map((m) => m.to[0])).toEqual(["p1@example.com", "p2@example.com", "p3@example.com"]);
    // The transport is handed the connector the routing resolved.
    expect(transportMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["p1@example.com"] }),
      expect.objectContaining({ connectorId: "mailbox-a", userId: "user-1", orgId: "org-1" }),
    );
  });

  it("H2 no installed email connector stops before the hand-over and the claim is given back", async () => {
    const sendLedger = memorySendLedger();
    mailboxes.list = [];
    routing.connectorId = null;
    const stopped = await makeFixture({ sendLedger, sendEmail: await createDefaultSendEmail() }).start({
      releasedList: approved,
    });
    expect(stopped).toMatchObject({ status: "failed", sentCount: 0, inDoubtCount: 0 });
    expect(stopped.errorMessage).toContain("no mail provider was reached (provider_not_reached)");
    expect(stopped.errorMessage).not.toContain("No connected email connector is available.");
    expect(transportMock).not.toHaveBeenCalled();
    expect([...sendLedger.rows.values()]).toEqual([]);
  });

  it("H3 the development redirect on with no address stops before the hand-over and the claim is given back", async () => {
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; textBody: string }> = [];
    transportMock.mockImplementation(recordingTransport(sent));
    routing.redirectOn = true;
    const stopped = await makeFixture({ sendLedger, sendEmail: await createDefaultSendEmail() }).start({
      releasedList: approved,
    });
    expect(stopped).toMatchObject({ status: "failed", sentCount: 0, inDoubtCount: 0 });
    expect(stopped.errorMessage).toContain("no mail provider was reached (provider_not_reached)");
    expect(stopped.errorMessage).not.toContain("no override recipient email is configured");
    expect(transportMock).not.toHaveBeenCalled();
    routing.redirectTo = "dev@example.com";
    const retry = await makeFixture({ sendLedger, sendEmail: await createDefaultSendEmail() }).start({
      releasedList: approved,
    });
    expect(retry).toMatchObject({ status: "completed", sentCount: 3, inDoubtCount: 0 });
  });

  it("H4 a transport that throws leaves the message in doubt, and the retry does not mail it", async () => {
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; textBody: string }> = [];
    transportMock.mockImplementation(recordingTransport(sent));
    transportMock.mockImplementationOnce(async () => {
      throw new Error("socket hang up");
    });
    const first = await makeFixture({ sendLedger, sendEmail: await createDefaultSendEmail() }).start({
      releasedList: approved,
    });
    expect(first).toMatchObject({ status: "failed", sentCount: 0, inDoubtCount: 1 });
    expect(first.errorMessage).toContain("may or may not have gone out (provider_error)");
    expect(first.errorMessage).not.toContain("socket hang up");
    const retry = await makeFixture({ sendLedger, sendEmail: await createDefaultSendEmail() }).start({
      releasedList: approved,
    });
    expect(sent.map((m) => m.to[0])).toEqual(["p2@example.com", "p3@example.com"]);
    expect(retry).toMatchObject({ status: "failed", sentCount: 2, inDoubtCount: 1 });
  });

  it("H5 a provider that answers with a rejection leaves the message in doubt: the answer does not show it took nothing", async () => {
    const sendLedger = memorySendLedger();
    // The connectors throw a plain error on a provider error answer (an
    // invalid recipient included); no status or code reaches this module.
    transportMock.mockImplementationOnce(async () => {
      throw new Error("Resend send failed: Invalid `to` field.");
    });
    const first = await makeFixture({ sendLedger, sendEmail: await createDefaultSendEmail() }).start({
      releasedList: approved,
    });
    expect(first).toMatchObject({ status: "failed", sentCount: 0, inDoubtCount: 1 });
    expect(first.errorMessage).toContain("may or may not have gone out (provider_error)");
    expect(first.errorMessage).not.toContain("Resend send failed");
    expect([...sendLedger.rows.values()][0]).toMatchObject({ phase: "claimed" });
  });

  it("M1 a mail whose sent record is not open is counted and named in doubt, and the answer is failed", async () => {
    const sendLedger = memorySendLedger();
    const markDone = vi.spyOn(sendLedger.ledger, "markDone");
    markDone.mockResolvedValueOnce(false);
    const fx = makeFixture({ sendLedger });
    const result = await fx.start({ releasedList: approved });
    // The mail went out: all three were handed over.
    expect(fx.sent).toHaveLength(3);
    expect(result).toMatchObject({ status: "failed", sentCount: 3, inDoubtCount: 1 });
    expect(result.errorMessage).toContain("draft 1 (email-body:run-1:art-1) was mailed, but its sent record could not be written");
    // A record that is not open is not written again.
    expect(markDone).toHaveBeenCalledTimes(3);
  });

  it("M2 a sent record whose write throws is written again, and a later success answers completed", async () => {
    const sendLedger = memorySendLedger();
    const markDone = vi.spyOn(sendLedger.ledger, "markDone");
    markDone.mockRejectedValueOnce(new Error("connection reset")).mockRejectedValueOnce(new Error("connection reset"));
    const result = await makeFixture({ sendLedger }).start({ releasedList: approved });
    expect(markDone).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ status: "completed", sentCount: 3, inDoubtCount: 0 });
    expect([...sendLedger.rows.values()].map((r) => r.phase)).toEqual(["finalized", "finalized", "finalized"]);
  });

  it("M3 a sent record that cannot be written in the bounded attempts is in doubt; the retry does not mail it again", async () => {
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; textBody: string }> = [];
    const markDone = vi.spyOn(sendLedger.ledger, "markDone");
    markDone
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockRejectedValueOnce(new Error("connection reset"));
    const first = await makeFixture({ sendLedger, sent }).start({ releasedList: approved });
    expect(first).toMatchObject({ status: "failed", sentCount: 3, inDoubtCount: 1 });
    expect(first.errorMessage).toContain("draft 1 (email-body:run-1:art-1) was mailed, but its sent record could not be written (send_record_write_failed)");
    expect(first.errorMessage).not.toContain("connection reset");
    expect(markDone).toHaveBeenCalledTimes(5);
    const retry = await makeFixture({ sendLedger, sent }).start({ releasedList: approved });
    expect(sent.map((m) => m.to[0])).toEqual(["p1@example.com", "p2@example.com", "p3@example.com"]);
    expect(retry).toMatchObject({ status: "failed", sentCount: 0, alreadySentCount: 2, inDoubtCount: 1 });
  });

  it("R1 the reference-only form is unchanged: every call mails the whole bundle, keeps no send record and adds no field", async () => {
    const sendLedger = memorySendLedger();
    const claim = vi.spyOn(sendLedger.ledger, "claim");
    const sent: Array<{ to: string[]; textBody: string }> = [];
    const one = await makeFixture({ sendLedger, sent }).start({});
    const two = await makeFixture({ sendLedger, sent }).start({});
    expect(sent.map((m) => m.textBody)).toEqual([
      "Approved art-1\n", "Approved art-2\n", "Approved art-3\n",
      "Approved art-1\n", "Approved art-2\n", "Approved art-3\n",
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

  it("R2 the default deps keep the facade sender for the reference-only form; only the approved sender checks the mailbox", async () => {
    mailboxes.list = [connectedMailbox("not_connected")];
    const sent: Array<{ to: string[]; textBody: string }> = [];
    transportMock.mockImplementation(recordingTransport(sent));
    const deps = buildLazyDefaultDeps();
    const message = { to: ["p1@example.com"], subject: "S", textBody: "T" };
    await deps.sendEmail(message, { userId: "user-1", orgId: "org-1" });
    expect(transportMock).toHaveBeenCalledTimes(1);
    expect(transportMock.mock.calls[0]?.[1]).toEqual({ userId: "user-1", orgId: "org-1" });
    await expect(deps.sendApprovedEmail!(message, { userId: "user-1", orgId: "org-1" })).rejects.toMatchObject({
      name: "EffectNotStartedError",
    });
    expect(transportMock).toHaveBeenCalledTimes(1);
  });
});

// The invariant the send rests on, with the route that consumes each released decision once before the send (that
// route and its own test belong to the sibling change, which merges after this one): an approved body is handed to a
// recipient at most once across all calls and all decisions; a call that did not complete answers failed; the rest
// takes a new approval, which mails only the recipients not yet sent and not in doubt.
describe("cinatra#3089 — one send per decision, one mail per recipient across decisions", () => {
  it("D1 a provider that fails on recipient two: the call stops there; a new approval mails recipient three only", async () => {
    const ledger: Ledger = new Map();
    const sendLedger = memorySendLedger();
    const sent: Array<{ to: string[]; textBody: string }> = [];
    const first = makeFixture({ ledger, sendLedger, sent, failMailAt: 2, decisionId: "decision-1" });
    const failed = await first.start({ releasedList: approved });
    // Stopped at the first provider failure: recipient three was not attempted by this call.
    expect(first.sendEmail.mock.calls.map((c) => (c[0] as { to: string[] }).to[0])).toEqual(["p1@example.com", "p2@example.com"]);
    expect(failed).toMatchObject({ status: "failed", sentCount: 1, alreadySentCount: 0, inDoubtCount: 1 });
    // The answer names the message in doubt by draft, message and contact, says that no later send mails it and that
    // clearing it is a manual check with the mail provider; it names no address.
    expect(failed.errorMessage).toContain("draft 2 (email-body:run-1:art-2) for contact c2");
    expect(failed.errorMessage).toContain("never mailed again by this or any later send, also not under a new approval");
    expect(failed.errorMessage).toContain("Nothing in the app clears an in-doubt mark; this is a manual check");
    expect(failed.errorMessage).not.toMatch(/@example\.com/);

    // A NEW approval: another released decision of the same step, signed for its own call.
    const second = makeFixture({ ledger, sendLedger, sent, decisionId: "decision-2" });
    const rest = await second.start({ releasedList: approved });
    expect(second.sendEmail.mock.calls.map((c) => (c[0] as { to: string[] }).to[0])).toEqual(["p3@example.com"]);
    expect(rest).toMatchObject({ status: "failed", sentCount: 1, alreadySentCount: 1, inDoubtCount: 1 });
    expect(rest.errorMessage).toContain("draft 2 (email-body:run-1:art-2) for contact c2");
    // Handed to the provider across both calls: recipient one once, recipient two once (the failed hand-over, never
    // again), recipient three once; delivered: one and three.
    const attempts = [...first.sendEmail.mock.calls, ...second.sendEmail.mock.calls].map((c) => (c[0] as { to: string[] }).to[0]);
    expect(["p1@example.com", "p2@example.com", "p3@example.com"].map((to) => attempts.filter((a) => a === to).length)).toEqual([1, 1, 1]);
    expect(sent.map((m) => m.to[0])).toEqual(["p1@example.com", "p3@example.com"]);
  });

  it("L1 a provider error that quotes the recipient's address reaches neither the answer nor any log line", async () => {
    const lines: string[] = [];
    const record = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(record));
    try {
      const sendLedger = memorySendLedger();
      const ledger: Ledger = new Map();
      // At the hand-over: the provider rejects the recipient, naming the address.
      const rejecting = vi.fn(async (message: { to: string[] }) => {
        if (message.to[0] === "p2@example.com") throw new Error(`550 mailbox unavailable: <${message.to[0]}> rejected`);
        return { providerId: "p", providerMessageId: "m", sentAt: "2026-11-25T00:00:00Z" };
      });
      const first = await makeFixture({ sendLedger, ledger, sendEmail: rejecting as unknown as TriggerEmailSendDeps["sendEmail"] })
        .start({ releasedList: approved });
      // Before the hand-over: a mailbox status that names the mailbox's address.
      const { EffectNotStartedError } = await import("../artifacts/materialization-ledger");
      const notReached = vi.fn(async () => {
        throw new EffectNotStartedError("The mailbox of p3@example.com is not connected: token for p3@example.com expired");
      });
      const second = await makeFixture({ sendEmail: notReached as unknown as TriggerEmailSendDeps["sendEmail"] })
        .start({ releasedList: approved });
      expect(first.errorMessage).not.toContain("p2@example.com");
      expect(first.errorMessage).toContain("may or may not have gone out (provider_error)");
      expect(second.errorMessage).not.toContain("p3@example.com");
      expect(second.errorMessage).toContain("no mail provider was reached (provider_not_reached)");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toMatch(/p[123]@example\.com/);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("P1 no request routes a publishing-step call into the reference-only form, which keeps no send record", async () => {
    // The calling step is governed by a released decision that holds no approved list, or by one not released.
    const noList = releasedCardFor(undefined);
    const requests: Array<Record<string, unknown>> = [
      {},
      { approvedBodies: approved },
      { senderEmail: "team@example.com" },
      { releasedList: undefined },
    ];
    for (const decision of [noList, { ...noList, status: "parked" }, { ...noList, decidedBy: null }]) {
      for (const request of requests) {
        const fx = makeFixture({ decision });
        const result = await fx.start(request);
        expect(result.status).toBe("failed");
        expect(result.sentCount).toBe(0);
        expect(fx.sendEmail).not.toHaveBeenCalled();
        expect(fx.bindBody).not.toHaveBeenCalled();
        expect(fx.sendLedger.rows.size).toBe(0);
      }
    }
    const fx = makeFixture({ decision: noList });
    expect((await fx.start({})).errorMessage).toContain("holds no list of approved bodies, and a publishing step sends only the bodies a person released");
    // A call signed for a decision while no decision governs its step is refused too.
    const signed = makeFixture({ decision: null, decisionId: "decision-1" });
    expect(await signed.start({})).toMatchObject({ status: "failed", sentCount: 0 });
    expect(signed.sendEmail).not.toHaveBeenCalled();
  });
});
