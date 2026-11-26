/**
 * cinatra#3089: the released-list road decides from what the card DECLARED, and answers fixed codes only.
 *
 * Cases:
 *   M1 a card that declared a list, whose released value is not of the exact form (an entry with one field more, the
 *      reviewer's trigger; a missing value; another shape; an empty list; 51 entries; JSON text with a field more), is
 *      refused with `released_list_malformed`: nothing is read, bound or mailed, and the old road is not taken
 *   M2 a card that declared no list keeps the old road (the bundle is mailed as before)
 *   S1 for type discovery and for every reader and writer on the road, a thrown and a returned raw text with a
 *      secret-looking string reaches neither the answer, nor the persisted status, nor any console call
 *   S2 the old road's answer is untouched: a raw provider text is answered as before, byte for byte
 *   G1 the answer's guard passes only the closed set of texts and codes (with numbers), and turns anything else,
 *      an unexpected raw string included, into the fixed `send_failed` text
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { createTriggerEmailSendHandlers } from "@cinatra-ai/trigger-email-send";

const { readRevisionMock, typesListMock, bindRevisionMock, transportMock, mailbox } = vi.hoisted(() => ({
  readRevisionMock: vi.fn(),
  typesListMock: vi.fn(),
  bindRevisionMock: vi.fn(),
  transportMock: vi.fn(),
  mailbox: { status: "connected", detail: undefined as string | undefined },
}));

vi.mock("../artifacts/current-decided-revision-read", async (importOriginal) => ({
  ReviewedArtifactsRequiredError: (await importOriginal<typeof import("../artifacts/current-decided-revision-read")>())
    .ReviewedArtifactsRequiredError,
  readCurrentDecidedRevision: readRevisionMock,
}));
vi.mock("@cinatra-ai/objects", () => ({ createDeterministicObjectsClient: () => ({ typesList: typesListMock }) }));
vi.mock("../artifacts/run-artifact-materializer", () => ({
  bindFanoutMessageRevision: bindRevisionMock,
  materializeFanoutMessageRevision: vi.fn(),
}));
vi.mock("../email-transport-provider", () => ({ requireEmailSystemFacade: () => ({ sendEmail: transportMock }) }));
vi.mock("../email-send-providers", () => ({
  resolveEmailSendProviders: () => [
    {
      definition: { connectorId: "mailbox-a", name: "Mailbox A" },
      getStatus: async () => ({ status: mailbox.status, ...(mailbox.detail ? { detail: mailbox.detail } : {}) }),
    },
  ],
  resolveHostEmailRouting: () => ({
    resolveConnectorId: async () => "mailbox-a",
    applyDevModeOverride: <M,>(m: M): M => m,
  }),
}));

import {
  createTriggerEmailSendUseCases,
  EMAIL_BODY_TYPE_ID,
  type MessageSendLedger,
  type TriggerEmailSendDeps,
} from "../trigger-email-send-use-cases";

// Loaded inside the tests, so the file loads before the change and a missing export fails the test that needs it.
const answers = async () => await import("../approved-body-send");

/** A secret-looking text a reader, a store or a provider could carry. */
const SECRET = "sk_live_SECRET4242 postgres://admin:hunter2@db.internal/cinatra";
const LEAKS = /SECRET4242|hunter2|db\.internal|admin:/;

const BUNDLE_REF = "11111111-1111-4111-8111-111111111111";
const RECIPIENTS_REF = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_ID = "33333333-3333-4333-8333-333333333333";
const actor: PrimitiveActorContext = { actorType: "human", source: "route", userId: "user-1", sessionId: "sess-1", orgId: "org-1" };

const drafts = [1, 2].map((n) => ({ recipientId: `c${n}`, recipientEmail: `p${n}@example.com`, subject: `Subject ${n}`, body: `Body ${n}` }));
const recipients = [1, 2].map((n) => ({ contactId: `c${n}`, email: `p${n}@example.com` }));
const approved = [1, 2].map((n) => ({
  artifactId: `art-${n}`,
  representationRevisionId: `rev-${n}`,
  contactId: `c${n}`,
  recipientEmail: `p${n}@example.com`,
  subject: `Subject ${n}`,
}));
const DECLARED = [
  { kind: "list", label: "Recipients", input: "recipients", columns: [{ label: "Email", field: "email" }, { label: "Subject", field: "subject" }] },
  { kind: "artifacts", label: "Emails", input: "emailBodies" },
];

/** The released decision `d-1` of the calling step: its card declared `declaredRows` and surfaced `emailBodies`. */
function card(emailBodies: unknown, declaredRows: unknown[] = DECLARED) {
  const shown = Array.isArray(emailBodies) ? emailBodies : approved;
  return {
    id: "d-1",
    status: "released",
    decidedBy: "user-2",
    surfacedValues: {
      campaignId: CAMPAIGN_ID,
      recipients: shown.map((e: { recipientEmail?: unknown; subject?: unknown }) => ({ email: e?.recipientEmail, subject: e?.subject })),
      ...(emailBodies === undefined ? {} : { emailBodies }),
    },
    declaredRows,
  };
}

function memoryLedger(): MessageSendLedger {
  const rows = new Map<string, { id: string; done: boolean }>();
  return {
    // As the shipped ledger: the check under the revision's lock runs before the claim commits.
    async claim(m, _actor, verifyUnderLock) {
      const refusal = verifyUnderLock ? await verifyUnderLock((async () => ({ rows: [] })) as never) : null;
      if (refusal) return { kind: "refused", reason: refusal };
      const row = rows.get(m.bindingOutputId);
      if (row) return { kind: row.done ? "done" : "in_doubt" };
      const id = `send-${rows.size + 1}`;
      rows.set(m.bindingOutputId, { id, done: false });
      return { kind: "won", ledgerId: id };
    },
    async markDone(id) {
      for (const row of rows.values()) if (row.id === id) return (row.done = true);
      return false;
    },
    async release(id) {
      for (const [key, row] of rows) if (row.id === id) rows.delete(key);
    },
  };
}

function makeFixture(overrides: Partial<TriggerEmailSendDeps> & { decision?: unknown; claim?: false } = {}) {
  const { decision = card(approved), claim, ...deps } = overrides;
  const oldRoadSend = vi.fn(async () => ({ providerId: "p", providerMessageId: "m", sentAt: "2026-11-26T00:00:00Z" }));
  const full: TriggerEmailSendDeps = {
    getCampaign: async () => null,
    getDraftsByIds: async () => [],
    sendEmail: oldRoadSend as unknown as TriggerEmailSendDeps["sendEmail"],
    getObjectByRef: async (ref) =>
      ({
        [BUNDLE_REF]: { id: BUNDLE_REF, type: "b", data: { cinatraAgentRunId: "run-1", drafts } },
        [RECIPIENTS_REF]: { id: RECIPIENTS_REF, type: "r", data: { confirmedRecipients: recipients } },
      })[ref] ?? null,
    messageSendLedger: memoryLedger(),
    readCallingRun: async () => ({
      runId: "run-1",
      stepId: "send",
      ...(claim === false ? {} : { claim: { runId: "run-1", decisionId: "d-1" } }),
    }),
    readPublishDecision: async () => decision as never,
    readClaimedPublishDecision: async () => decision as never,
    readRevisionStateUnderLock: async () => null,
    ...deps,
  };
  const handlers = createTriggerEmailSendHandlers(createTriggerEmailSendUseCases(full));
  const input = { campaignId: CAMPAIGN_ID, approvedDraftBundleRef: BUNDLE_REF, confirmedRecipientsRef: RECIPIENTS_REF };
  const start = () =>
    handlers["email_outreach_send_initial_start"]({ input, actor } as never) as unknown as Promise<{
      status: string;
      sentCount: number;
      errorMessage?: string;
    }>;
  const status = () =>
    handlers["email_outreach_send_initial_status"]({ input: { campaignId: CAMPAIGN_ID }, actor } as never) as unknown as Promise<{
      errorMessage?: string;
    }>;
  return { start, status, oldRoadSend };
}

let consoleCalls: unknown[][] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mailbox.status = "connected";
  mailbox.detail = undefined;
  typesListMock.mockResolvedValue({ types: [{ type: EMAIL_BODY_TYPE_ID }] });
  readRevisionMock.mockImplementation(async (input: { artifactId: string }) => ({
    ok: true,
    artifactId: input.artifactId,
    representationRevisionId: "x",
    text: `Body ${input.artifactId.slice(-1)}`,
    data: { campaignId: CAMPAIGN_ID },
  }));
  bindRevisionMock.mockImplementation(async (b: { artifactId: string; representationRevisionId: string }) => ({
    ok: true,
    artifactId: b.artifactId,
    representationRevisionId: b.representationRevisionId,
    deduped: false,
  }));
  transportMock.mockResolvedValue({ providerId: "mailbox-a", providerMessageId: "m", sentAt: "2026-11-26T00:00:00Z" });
  consoleCalls = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void consoleCalls.push(args));
  }
});
afterEach(() => vi.restoreAllMocks());

/** No answer, no persisted status and no console call carries the secret. */
async function expectNoLeak(fx: ReturnType<typeof makeFixture>, answer: { errorMessage?: string }, code: string) {
  expect(answer.errorMessage).toContain(code);
  expect(answer.errorMessage ?? "").not.toMatch(LEAKS);
  expect((await fx.status()).errorMessage ?? "").not.toMatch(LEAKS);
  expect(JSON.stringify(consoleCalls.map((args) => args.map(String)))).not.toMatch(LEAKS);
}

describe("cinatra#3089 — a declared released list that is not exact is refused, never sent down the old road", () => {
  const MALFORMED: Array<[string, unknown]> = [
    // The reviewer's trigger: an otherwise valid reviewed entry with one more metadata field. No pinned pack surfaces
    // such an entry, so the send fails closed rather than tolerating it.
    ["an entry with one field more", [approved[0], { ...approved[1], reviewNote: "extra" }]],
    ["no released value", undefined],
    ["another shape", { list: approved }],
    ["an empty list", []],
    ["51 entries", Array.from({ length: 51 }, (_, i) => ({ ...approved[0]!, artifactId: `art-x${i}` }))],
    ["JSON text with one field more", JSON.stringify([{ ...approved[0], reviewNote: "extra" }])],
    ["an entry with a field less", [approved[0], { ...approved[1], subject: undefined }]],
  ];
  it.each(MALFORMED)("M1 %s: refused (released_list_malformed), nothing read, bound or mailed", async (_name, value) => {
    const fx = makeFixture({ decision: card(value) });
    const answer = await fx.start();
    expect(answer.status).toBe("failed");
    expect(answer.errorMessage).toBe(
      "The send was refused before any email went out: the released list of the publish decision was refused (released_list_malformed)",
    );
    expect(fx.oldRoadSend).not.toHaveBeenCalled();
    expect(transportMock).not.toHaveBeenCalled();
    expect(readRevisionMock).not.toHaveBeenCalled();
    expect(bindRevisionMock).not.toHaveBeenCalled();
  });

  it("M2 a claimed call under a card that declared no list keeps the old road", async () => {
    const fx = makeFixture({ decision: card(undefined, []) });
    expect(await fx.start()).toMatchObject({ status: "completed", sentCount: 2 });
    expect(fx.oldRoadSend).toHaveBeenCalledTimes(2);
  });
});

describe("cinatra#3089 — no raw text reaches the released-list answer, the status or the log", () => {
  const thrown = () => {
    throw new Error(SECRET);
  };
  const cases: Array<[string, () => Partial<TriggerEmailSendDeps> | void, string]> = [
    ["type discovery throws", () => void typesListMock.mockRejectedValue(new Error(SECRET)), "(types_unreadable)"],
    ["type discovery throws a raw string", () => void typesListMock.mockRejectedValue(SECRET), "(types_unreadable)"],
    ["the calling run read throws", () => ({ readCallingRun: async () => thrown() }), "(calling_run_unreadable)"],
    ["the governing decision read throws", () => ({ readPublishDecision: async () => thrown() }), "(decision_unreadable)"],
    ["the claimed decision read throws", () => ({ readClaimedPublishDecision: async () => thrown() }), "(decision_claim_unreadable)"],
    ["the bundle read throws", () => ({ getObjectByRef: async () => thrown() }), "(send_failed)"],
    ["the body read throws", () => void readRevisionMock.mockRejectedValue(new Error(SECRET)), "(body_read_failed)"],
    [
      "the body read returns a raw refusal",
      () => void readRevisionMock.mockResolvedValue({ ok: false, error: `art-1 could not be read: ${SECRET}` }),
      "(body_read_failed)",
    ],
    ["the binder throws", () => void bindRevisionMock.mockRejectedValue(new Error(SECRET)), "(bind_failed)"],
    ["the binder returns a raw refusal", () => void bindRevisionMock.mockResolvedValue({ ok: false, error: SECRET }), "(bind_refused)"],
    ["the check under the revision's lock returns a raw reason", () => ({ readRevisionStateUnderLock: async () => SECRET }), "(body_read_failed)"],
    ["the mailbox status carries a raw detail", () => void Object.assign(mailbox, { status: "error", detail: SECRET }), "(provider_not_reached)"],
    ["the provider throws", () => void transportMock.mockRejectedValue(new Error(SECRET)), "(provider_error)"],
    [
      "the send record claim throws",
      () => ({ messageSendLedger: { ...memoryLedger(), claim: async () => thrown() } }),
      "(send_record_claim_failed)",
    ],
    [
      "the sent record write throws",
      () => ({ messageSendLedger: { ...memoryLedger(), markDone: async () => thrown() } }),
      "(send_record_write_failed)",
    ],
  ];
  it.each(cases)("S1 %s", async (_name, arrange, code) => {
    const deps = arrange() ?? {};
    const fx = makeFixture({ ...deps, sendApprovedEmail: (await answers()).createDefaultSendEmail() });
    const answer = await fx.start();
    expect(answer.status).toBe("failed");
    await expectNoLeak(fx, answer, code);
  });

  it("S1 a body that reads another text at its send time answers a code, never the reader's text", async () => {
    let reads = 0;
    readRevisionMock.mockImplementation(async (input: { artifactId: string }) =>
      ++reads > 2
        ? { ok: false, error: `${input.artifactId} could not be read: ${SECRET}` }
        : { ok: true, artifactId: input.artifactId, representationRevisionId: "x", text: `Body ${input.artifactId.slice(-1)}`, data: { campaignId: CAMPAIGN_ID } },
    );
    const fx = makeFixture({ sendApprovedEmail: (await answers()).createDefaultSendEmail() });
    const answer = await fx.start();
    await expectNoLeak(fx, answer, "draft 1 was not sent, its body was refused at its send time (body_read_failed)");
  });

  it("S2 the old road answers as before: a raw provider text is passed on byte for byte", async () => {
    const fx = makeFixture({ claim: false });
    fx.oldRoadSend.mockRejectedValue(new Error(`raw provider text ${SECRET}`));
    expect((await fx.start()).errorMessage).toBe(`raw provider text ${SECRET}`);
    const noList = makeFixture({ decision: card(undefined, []) });
    noList.oldRoadSend.mockRejectedValue(new Error("raw provider text"));
    expect((await noList.start()).errorMessage).toBe("raw provider text");
  });
});

describe("cinatra#3089 — the one guard of a released-list answer", () => {
  it("G1 an unexpected raw string becomes the fixed send_failed text; known texts and codes pass with their numbers", async () => {
    const { releasedRoadAnswer, releasedRoadText, RELEASED_ROAD_TEXT, IN_DOUBT_MANUAL_CHECK } = await answers();
    const GENERIC = "the send failed for a reason that is not shown (send_failed)";
    expect(releasedRoadAnswer(SECRET)).toBe(GENERIC);
    expect(releasedRoadAnswer(`The send was refused before any email went out: ${SECRET}`)).toBe(GENERIC);
    // A known text with an id or a raw code in place of a number or a code does not pass.
    expect(releasedRoadAnswer("approved body art-1 names no contact (entry_no_contact)")).toBe(GENERIC);
    expect(releasedRoadAnswer("approved body 1 names no contact (sk_live_secret)")).toBe(GENERIC);
    expect(releasedRoadAnswer(`approved body 1 names no contact (entry_no_contact) ${SECRET}`)).toBe(GENERIC);
    // Each part is guarded on its own; known parts keep their numbers.
    const mixed = [releasedRoadText("in_doubt_count", [2]), SECRET, releasedRoadText("in_doubt", [7]), IN_DOUBT_MANUAL_CHECK].join("; ");
    expect(releasedRoadAnswer(mixed)).toBe(
      ["2 message(s) are in doubt (in_doubt_count)", GENERIC, "draft 7 is in doubt (in_doubt)", IN_DOUBT_MANUAL_CHECK].join("; "),
    );
    // A caller's own fixed form passes only as it is.
    expect(releasedRoadAnswer("a fixed own form", ["a fixed own form"])).toBe("a fixed own form");
    // Every text of the road, filled with numbers, passes unchanged, and none can split into two parts.
    for (const key of Object.keys(RELEASED_ROAD_TEXT) as Array<keyof typeof RELEASED_ROAD_TEXT>) {
      const text = releasedRoadText(key, [3, 4]);
      expect(text).not.toContain("; ");
      expect(releasedRoadAnswer(text)).toBe(text);
    }
    expect(IN_DOUBT_MANUAL_CHECK).not.toContain("; ");
  });
});
