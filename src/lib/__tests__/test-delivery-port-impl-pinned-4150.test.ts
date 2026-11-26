/**
 * The host test-delivery port and the pinned send (cinatra#4150). prepareSend answers the plan detail a publish card
 * shows (the From, each draft with its revision, subject and preview). performPinnedSend reads the run owner's
 * campaign access again, then mails exactly the plan from the owner's mailbox and refuses anything that changed since.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Draft = { id: string; subject: string; body: string };

const h = vi.hoisted(() => ({
  objectsGet: vi.fn<(id: string) => Promise<unknown>>(),
  planTestSendSelection: vi.fn(),
  deps: null as null | Record<string, unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz", () => ({
  AuthzError: class AuthzError extends Error {},
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({ principalType: "HumanUser", principalId: "owner-1", organizationId: "org-1" })),
}));
vi.mock("@cinatra-ai/objects", () => ({ createSessionObjectsClient: () => ({ get: h.objectsGet }) }));
vi.mock("@/lib/trigger-email-send-use-cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trigger-email-send-use-cases")>()),
  planTestSendSelection: h.planTestSendSelection,
  buildLazyDefaultDeps: () => h.deps,
}));

import { AuthzError } from "@/lib/authz";
import { testDeliverySendPortImpl } from "@/lib/test-delivery-send-port-impl";

// The revision is the SHA-256 of the JSON of [subject, body], written out here so the test pins the form.
const rev = (d: { subject: string; body: string }) =>
  createHash("sha256").update(JSON.stringify([d.subject, d.body]), "utf8").digest("hex");

const D1: Draft = { id: "d1", subject: "Hello", body: "Hi {{first_name}}, a short note." };
const D2: Draft = { id: "d2", subject: "Follow", body: "Second draft body." };
const RUN = { id: "run-1", runBy: "owner-1", orgId: "org-1", inputParams: { campaignId: "c1" } };
const PLAN = {
  campaignId: "c1",
  sender: { email: "sales@example.com", name: "Sales" },
  recipientEmail: "tester@example.com",
  drafts: [
    { id: "d1", revision: rev(D1) },
    { id: "d2", revision: rev(D2) },
  ],
};

function stubDeps(over: { drafts?: Draft[]; senderName?: string; senderEmail?: string; draftIds?: string[]; failOn?: string } = {}) {
  const drafts = over.drafts ?? [D1, D2];
  const sendEmail = vi.fn(async (message: { subject: string }) => {
    if (over.failOn && message.subject === `[Test] ${over.failOn}`) throw new Error("transport down");
    return { providerId: "p", providerMessageId: "m", sentAt: new Date().toISOString() };
  });
  h.deps = {
    getCampaign: vi.fn(async () => ({
      id: "c1",
      senderName: over.senderName ?? "Sales",
      senderEmail: over.senderEmail ?? "sales@example.com",
      draftIds: over.draftIds ?? drafts.map((d) => d.id),
    })),
    getDraftsByIds: vi.fn(async (ids: string[]) => drafts.filter((d) => ids.includes(d.id))),
    sendEmail,
  };
  return sendEmail;
}

async function send(plan: typeof PLAN = PLAN, submissionId = "task-9", shownDrafts?: Array<{ subject: string; preview: string }>) {
  expect(typeof testDeliverySendPortImpl.performPinnedSend).toBe("function");
  return testDeliverySendPortImpl.performPinnedSend!({ run: RUN, submissionId, plan, ...(shownDrafts ? { shownDrafts } : {}) });
}

// What the approved card showed of D1 and D2: the subject, and the preview of the body as the message carries it.
const SHOWN = [{ subject: "Hello", preview: "Hi there, a short note." }, { subject: "Follow", preview: "Second draft body." }];

beforeEach(() => {
  vi.clearAllMocks();
  h.objectsGet.mockResolvedValue({ object: { id: "c1" } });
  stubDeps();
});

describe("prepareSend answers the plan detail the card shows", () => {
  it("adds the sender and each selected draft with its revision, subject and preview", async () => {
    h.planTestSendSelection.mockResolvedValue({
      ok: true,
      recipientEmail: "tester@example.com",
      selectedDraftIds: ["d1"],
      sender: { email: "sales@example.com", name: "Sales" },
      selectedDrafts: [{ id: "d1", subject: "Hello", body: "Hi {{first_name}},\n\nthanks." }],
    });
    const out = await testDeliverySendPortImpl.prepareSend({
      run: RUN, campaignId: "c1", recipientEmail: "tester@example.com", selectionMode: "random_initial",
    });
    expect(out).toEqual({
      ok: true,
      recipientEmail: "tester@example.com",
      selectedDraftIds: ["d1"],
      sender: { email: "sales@example.com", name: "Sales" },
      drafts: [{ id: "d1", revision: rev({ subject: "Hello", body: "Hi {{first_name}},\n\nthanks." }), subject: "Hello", preview: "Hi there, thanks." }],
    });
  });

  it("cuts a long preview to 140 characters", async () => {
    h.planTestSendSelection.mockResolvedValue({
      ok: true, recipientEmail: "t@example.com", selectedDraftIds: ["d1"], sender: { email: "", name: "" },
      selectedDrafts: [{ id: "d1", subject: "S", body: "x".repeat(300) }],
    });
    const out = (await testDeliverySendPortImpl.prepareSend({
      run: RUN, campaignId: "c1", recipientEmail: "t@example.com", selectionMode: "all_initial",
    })) as { drafts?: Array<{ preview: string }> };
    expect(out.drafts?.[0]?.preview).toHaveLength(140);
    expect(out.drafts?.[0]?.preview.endsWith("…")).toBe(true);
  });
});

describe("performPinnedSend mails exactly the plan", () => {
  it("sends the plan's drafts in order, from the plan's sender, to the plan's recipient, as the run owner", async () => {
    const sendEmail = stubDeps();
    expect(await send()).toEqual({
      ok: true,
      sentTo: "tester@example.com",
      sentCount: 2,
      deliveredDraftIds: ["d1", "d2"],
      message: "Test email sent to tester@example.com.",
    });
    expect(h.objectsGet).toHaveBeenCalledWith("c1");
    expect(sendEmail.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.objectContaining({ to: ["tester@example.com"], subject: "[Test] Hello", fromEmail: "sales@example.com", fromName: "Sales", textBody: "Hi there, a short note." }),
      expect.objectContaining({ to: ["tester@example.com"], subject: "[Test] Follow" }),
    ]);
    expect((sendEmail.mock.calls[0] as unknown[])[1]).toMatchObject({
      userId: "owner-1",
      orgId: "org-1",
      correlation: { campaignId: "c1", submissionId: "task-9", draftId: "d1" },
    });
  });

  it("refuses, sending nothing, when a draft was edited since the plan", async () => {
    const sendEmail = stubDeps({ drafts: [D1, { ...D2, body: "Edited." }] });
    expect(await send()).toMatchObject({ ok: false, reason: "plan_changed", deliveredDraftIds: [] });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses, sending nothing, when a draft left the campaign or no longer exists", async () => {
    let sendEmail = stubDeps({ draftIds: ["d1"] });
    expect(await send()).toMatchObject({ ok: false, reason: "plan_changed" });
    expect(sendEmail).not.toHaveBeenCalled();
    sendEmail = stubDeps({ drafts: [D1], draftIds: ["d1", "d2"] });
    expect(await send()).toMatchObject({ ok: false, reason: "plan_changed" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses, sending nothing, when the campaign's sender changed since the plan", async () => {
    for (const over of [{ senderEmail: "other@example.com" }, { senderName: "Support" }]) {
      const sendEmail = stubDeps(over);
      expect(await send()).toMatchObject({ ok: false, reason: "plan_changed" });
      expect(sendEmail).not.toHaveBeenCalled();
    }
  });

  it("refuses a recipient that is not a valid address as typed, and a plan with a repeated draft or none", async () => {
    const sendEmail = stubDeps();
    for (const recipientEmail of ["no-at-sign", " tester@example.com"]) {
      expect(await send({ ...PLAN, recipientEmail })).toMatchObject({ ok: false, reason: "invalid_recipient" });
    }
    expect(await send({ ...PLAN, drafts: [PLAN.drafts[0]!, PLAN.drafts[0]!] })).toMatchObject({ ok: false, reason: "plan_changed" });
    expect(await send({ ...PLAN, drafts: [] })).toMatchObject({ ok: false, reason: "plan_changed" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("answers send_failed with the drafts that went out when the transport fails part way", async () => {
    stubDeps({ failOn: "Follow" });
    expect(await send()).toEqual({ ok: false, reason: "send_failed", deliveredDraftIds: ["d1"], message: "transport down" });
  });

  it("refuses, sending nothing, when the campaign is gone or the owner may no longer read it", async () => {
    const sendEmail = stubDeps();
    h.objectsGet.mockResolvedValueOnce({ object: null });
    expect(await send()).toMatchObject({ ok: false, reason: "campaign_access_denied", deliveredDraftIds: [] });
    h.objectsGet.mockRejectedValueOnce(new (AuthzError as unknown as new (m: string) => Error)("denied"));
    expect(await send()).toMatchObject({ ok: false, reason: "campaign_access_denied" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends when each draft's subject and recomputed preview are what the approved card showed", async () => {
    const sendEmail = stubDeps();
    expect(await send(PLAN, "task-9", SHOWN)).toMatchObject({ ok: true, sentCount: 2 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("refuses, sending nothing, when the card showed another subject or preview than the draft read now", async () => {
    for (const shown of [
      [{ ...SHOWN[0]!, subject: "Hello!" }, SHOWN[1]!],
      [SHOWN[0]!, { ...SHOWN[1]!, preview: "Other text." }],
      [SHOWN[0]!],
    ]) {
      const sendEmail = stubDeps();
      expect(await send(PLAN, "task-9", shown)).toMatchObject({ ok: false, reason: "plan_changed", deliveredDraftIds: [] });
      expect(sendEmail).not.toHaveBeenCalled();
    }
  });

  it("lets an unrelated store fault propagate", async () => {
    const sendEmail = stubDeps();
    h.objectsGet.mockRejectedValueOnce(new Error("db down"));
    await expect(send()).rejects.toThrow("db down");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
