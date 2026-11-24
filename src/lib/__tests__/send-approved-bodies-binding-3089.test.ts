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
 *   B3 a retry after a failed mail finds the same bindings and mails every
 *      message
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
  materializeEmailFanout,
  type DecidedBodyRead,
  type EmailFanoutArgs,
  type EmailFanoutResult,
  type TriggerEmailSendDeps,
} from "../trigger-email-send-use-cases";

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
}) {
  const sent: Array<{ to: string[]; textBody: string }> = [];
  let attempts = 0;
  const sendEmail = vi.fn(async (message: { to: string[]; textBody: string }) => {
    attempts += 1;
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
  return { sent, sendEmail, bindBody, writeBody, ledger, start };
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

  it("B3 a retry after a failed mail finds the same bindings and mails every message", async () => {
    const ledger: Ledger = new Map();
    const first = makeFixture({ ledger, failMailAt: 2 });
    const failed = await first.start({ approvedBodies: approved });
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toContain("the mail transport failed");
    // Every binding was written before the first mail.
    // red-first-expect: expected "vi.fn()" to be called 3 times, but got 0 times
    expect(first.bindBody).toHaveBeenCalledTimes(3);
    const written = new Map(ledger);
    expect([...written.values()].map((v) => v.artifactId)).toEqual(["art-1", "art-2", "art-3"]);

    const retry = makeFixture({ ledger });
    const done = await retry.start({ approvedBodies: approved });
    expect(done.status).toBe("completed");
    expect(await Promise.all(retry.bindBody.mock.results.map((r) => r.value))).toEqual(
      approved.map((a) => ({ ok: true, artifactId: a.artifactId, representationRevisionId: a.representationRevisionId, deduped: true })),
    );
    expect(ledger).toEqual(written);
    expect(retry.sent.map((m) => m.textBody)).toEqual(["Approved art-1", "Approved art-2", "Approved art-3"]);
  });
});
