/**
 * TriggerEmailSendUseCases adapter tests.
 *
 * These tests inject mocked deps into createTriggerEmailSendUseCases() so the
 * heavy @cinatra-ai/gmail-connector and @/lib/database modules are never loaded.
 *
 * Note: this file lives under src/lib/__tests__/ rather than src/lib/ to be
 * picked up by vitest.config.ts's include glob (src/**\/__tests__/**\/*.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { createTriggerEmailSendUseCases } from "../trigger-email-send-use-cases";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

type Campaign = {
  id: string;
  name: string;
  senderName: string;
  senderEmail: string;
  draftIds: string[];
};

type Draft = {
  id: string;
  subject: string;
  body: string;
};

const actor: PrimitiveActorContext = {
  actorType: "human",
  source: "route",
  userId: "user-1",
  sessionId: "sess-1",
};

function makeDeps(overrides: {
  campaign?: Campaign | null;
  drafts?: Draft[];
  sendEmail?: ReturnType<typeof vi.fn>;
}) {
  const campaign = overrides.campaign === undefined
    ? ({
        id: "c1",
        name: "Camp",
        senderName: "Sender",
        senderEmail: "sender@cinatra.ai",
        draftIds: overrides.drafts?.map((d) => d.id) ?? [],
      } as Campaign)
    : overrides.campaign;
  const drafts = overrides.drafts ?? [];
  const sendEmail = overrides.sendEmail ?? vi.fn().mockResolvedValue({
    providerId: "gmail",
    providerMessageId: "m1",
    sentAt: new Date().toISOString(),
  });
  return {
    deps: {
      getCampaign: vi.fn().mockResolvedValue(campaign),
      getDraftsByIds: vi.fn().mockResolvedValue(drafts),
      sendEmail: sendEmail as never,
    },
    sendEmail,
  };
}

describe("createTriggerEmailSendUseCases.sendTestEmail", () => {
  it("throws 'Campaign not found.' when getCampaign returns null", async () => {
    const { deps } = makeDeps({ campaign: null });
    const uc = createTriggerEmailSendUseCases(deps);
    await expect(
      uc.sendTestEmail(
        { campaignId: "missing", recipientEmail: "x@y.com", selectionMode: "random_initial" },
        actor,
      ),
    ).rejects.toThrow("Campaign not found.");
  });

  it("returns failure-as-data { ok:false, reason:'no_drafts_selected' } when no drafts resolve", async () => {
    const { deps } = makeDeps({ drafts: [] });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      { campaignId: "c1", recipientEmail: "x@y.com", selectionMode: "all_initial" },
      actor,
    );
    expect(result).toMatchObject({ ok: false, reason: "no_drafts_selected" });
  });

  it("returns failure-as-data { ok:false, reason:'invalid_recipient' } for a bad recipient", async () => {
    const drafts: Draft[] = [{ id: "d1", subject: "One", body: "B1" }];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      { campaignId: "c1", recipientEmail: "not-an-email", selectionMode: "all_initial" },
      actor,
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid_recipient" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("random_initial picks exactly one draft and calls sendEmail with [Test] prefix", async () => {
    const drafts: Draft[] = [
      { id: "d1", subject: "Hello", body: "Hi {{contact_first_name_or_company}}, welcome." },
      { id: "d2", subject: "Two", body: "Body 2 {{contact_first_name_or_company}}" },
    ];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      { campaignId: "c1", recipientEmail: "to@y.com", selectionMode: "random_initial" },
      actor,
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [message, options] = sendEmail.mock.calls[0];
    expect(message.to).toEqual(["to@y.com"]);
    expect(message.subject).toMatch(/^\[Test\] /);
    expect(message.fromEmail).toBe("sender@cinatra.ai");
    expect(message.fromName).toBe("Sender");
    expect(message.replyTo).toBe("sender@cinatra.ai");
    // Token replacement
    expect(message.textBody).not.toContain("{{contact_first_name_or_company}}");
    expect(message.textBody).toContain("there");
    expect(options).toEqual({ userId: "user-1" });
    expect(result).toMatchObject({ ok: true, recipientEmail: "to@y.com", sentCount: 1 });
  });

  // #1625 (D1): the run OWNER's org must reach the routing chain so the
  // owner's USER-level sender-identity resolves from the org-partitioned objects
  // store (otherwise the send falls through to the first-registered connector).
  it("threads the actor's orgId into sendEmail options (owner-mailbox routing)", async () => {
    const drafts: Draft[] = [{ id: "d1", subject: "Hello", body: "Hi" }];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const ownerActor: PrimitiveActorContext = {
      actorType: "human",
      source: "a2a",
      userId: "owner-1",
      orgId: "org-xyz",
    };
    await uc.sendTestEmail(
      { campaignId: "c1", recipientEmail: "to@y.com", selectionMode: "random_initial" },
      ownerActor,
    );
    const [, options] = sendEmail.mock.calls[0];
    expect(options.userId).toBe("owner-1");
    expect(options.orgId).toBe("org-xyz");
  });

  // #1625 (D1): a submission-scoped test send threads BOTH orgId and the
  // (submissionId, draftId) correlation into the send OPTIONS the use-case emits.
  // This asserts the use-case→deps.sendEmail boundary only; end-to-end
  // persistence of the correlation onto the sent-email record additionally
  // depends on the email-connector facade forwarding it (tracked follow-up —
  // the released facade currently drops `correlation`).
  it("threads orgId alongside the submissionId/draftId correlation on a wrapped send", async () => {
    const drafts: Draft[] = [{ id: "d1", subject: "Hello", body: "Hi" }];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const ownerActor: PrimitiveActorContext = {
      actorType: "human", source: "a2a", userId: "owner-1", orgId: "org-xyz",
    };
    await uc.sendTestEmail(
      {
        campaignId: "c1", recipientEmail: "to@y.com", selectionMode: "random_initial",
        submissionId: "sub-1",
      },
      ownerActor,
    );
    const [, options] = sendEmail.mock.calls[0];
    expect(options.orgId).toBe("org-xyz");
    expect(options.correlation).toEqual({ campaignId: "c1", submissionId: "sub-1", draftId: "d1" });
  });

  it("specific_initial filters drafts by specificInitialDraftIds", async () => {
    const drafts: Draft[] = [
      { id: "d1", subject: "One", body: "B1" },
      { id: "d2", subject: "Two", body: "B2" },
      { id: "d3", subject: "Three", body: "B3" },
    ];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      {
        campaignId: "c1",
        recipientEmail: "to@y.com",
        selectionMode: "specific_initial",
        specificInitialDraftIds: ["d1", "d3"],
      },
      actor,
    );
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const subjects = sendEmail.mock.calls.map((c) => c[0].subject);
    expect(subjects).toEqual(["[Test] One", "[Test] Three"]);
    expect(result).toMatchObject({ ok: true, sentCount: 2 });
  });

  it("all_initial sends one email per initial draft", async () => {
    const drafts: Draft[] = [
      { id: "d1", subject: "One", body: "B1" },
      { id: "d2", subject: "Two", body: "B2" },
    ];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      { campaignId: "c1", recipientEmail: "to@y.com", selectionMode: "all_initial" },
      actor,
    );
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, sentCount: 2 });
  });

  it("returns failure-as-data { ok:false, reason:'send_failed' } when sendEmail rejects (never throws)", async () => {
    const drafts: Draft[] = [{ id: "d1", subject: "One", body: "B" }];
    const sendEmail = vi.fn().mockRejectedValue(new Error("boom"));
    const { deps } = makeDeps({ drafts, sendEmail });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      { campaignId: "c1", recipientEmail: "to@y.com", selectionMode: "all_initial" },
      actor,
    );
    expect(result).toMatchObject({ ok: false, reason: "send_failed", message: "boom" });
  });

  it("reports the delivered PREFIX on a mid-batch failure (partial-batch-retry regression)", async () => {
    const drafts: Draft[] = [
      { id: "d1", subject: "One", body: "B1" },
      { id: "d2", subject: "Two", body: "B2" },
      { id: "d3", subject: "Three", body: "B3" },
    ];
    // d1 sends, d2 throws → d1 is the delivered prefix; d3 never attempted.
    const sendEmail = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom on d2"));
    const { deps } = makeDeps({ drafts, sendEmail });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      { campaignId: "c1", recipientEmail: "to@y.com", selectionMode: "all_initial" },
      actor,
    );
    expect(result).toMatchObject({ ok: false, reason: "send_failed", deliveredDraftIds: ["d1"] });
  });

  it("reports every delivered id on a full success (deliveredDraftIds == sent set)", async () => {
    const drafts: Draft[] = [
      { id: "d1", subject: "One", body: "B1" },
      { id: "d2", subject: "Two", body: "B2" },
    ];
    const { deps } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      { campaignId: "c1", recipientEmail: "to@y.com", selectionMode: "all_initial" },
      actor,
    );
    expect(result).toMatchObject({ ok: true, sentCount: 2, deliveredDraftIds: ["d1", "d2"] });
  });

  // FOLLOW-UP DRAFT-ID FIX (contract (6)): specificFollowUpDraftIds was accepted
  // but never read. In-campaign follow-ups must now actually send; an
  // out-of-campaign follow-up id is dropped by the membership predicate.
  it("sends membership-checked follow-up drafts and drops out-of-campaign follow-up ids", async () => {
    const drafts: Draft[] = [
      { id: "d1", subject: "Initial", body: "B1" },
      { id: "f1", subject: "FollowUp1", body: "FB1" },
      { id: "f2", subject: "FollowUp2", body: "FB2" },
    ];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      {
        campaignId: "c1",
        recipientEmail: "to@y.com",
        selectionMode: "specific_initial",
        specificInitialDraftIds: ["d1"],
        // f1 is in the campaign; "f-foreign" is not → dropped.
        specificFollowUpDraftIds: ["f1", "f-foreign"],
      },
      actor,
    );
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const subjects = sendEmail.mock.calls.map((c) => c[0].subject).sort();
    expect(subjects).toEqual(["[Test] FollowUp1", "[Test] Initial"]);
    expect(result).toMatchObject({ ok: true, sentCount: 2 });
  });

  it("dedupes a follow-up id that also matches an initial selection (no double-send)", async () => {
    const drafts: Draft[] = [
      { id: "d1", subject: "One", body: "B1" },
      { id: "d2", subject: "Two", body: "B2" },
    ];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      {
        campaignId: "c1",
        recipientEmail: "to@y.com",
        selectionMode: "specific_initial",
        specificInitialDraftIds: ["d1"],
        specificFollowUpDraftIds: ["d1"],
      },
      actor,
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, sentCount: 1 });
  });

  it("replaces {{contact_full_name_or_company}} token with 'there'", async () => {
    const drafts: Draft[] = [
      { id: "d1", subject: "S", body: "Hello {{contact_full_name_or_company}}!" },
    ];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    await uc.sendTestEmail(
      { campaignId: "c1", recipientEmail: "to@y.com", selectionMode: "all_initial" },
      actor,
    );
    const body = sendEmail.mock.calls[0][0].textBody;
    expect(body).toBe("Hello there!");
  });

  // any Mustache-style token should be replaced, not just the
  // legacy 2-token allowlist.
  it("replaces arbitrary {{...}} tokens with 'there'", async () => {
    const drafts: Draft[] = [
      {
        id: "d1",
        subject: "S",
        body: "Hi {{first_name}}, your email {{contact_email}} at {{contact_company}} is verified.",
      },
    ];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    await uc.sendTestEmail(
      { campaignId: "c1", recipientEmail: "to@y.com", selectionMode: "all_initial" },
      actor,
    );
    const body = sendEmail.mock.calls[0][0].textBody;
    expect(body).not.toMatch(/\{\{[^}]+\}\}/);
    expect(body).toBe("Hi there, your email there at there is verified.");
  });

  // specificInitialDraftIds containing ids that are NOT in the
  // campaign's draftIds list must be silently dropped before reaching the
  // store. The selected set should still resolve to the matching campaign
  // drafts, never to drafts belonging to a different campaign.
  it("drops specificInitialDraftIds that are not in campaign.draftIds", async () => {
    const drafts: Draft[] = [
      { id: "d1", subject: "One", body: "B1" },
      { id: "d2", subject: "Two", body: "B2" },
    ];
    const { deps, sendEmail } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      {
        campaignId: "c1",
        recipientEmail: "to@y.com",
        selectionMode: "specific_initial",
        // d1 is in the campaign; "d-foreign" is not — it must be dropped.
        specificInitialDraftIds: ["d1", "d-foreign"],
      },
      actor,
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].subject).toBe("[Test] One");
    expect(result).toMatchObject({ ok: true, sentCount: 1 });
  });

  it("returns { ok:false, reason:'no_drafts_selected' } when every specificInitialDraftId is foreign", async () => {
    const drafts: Draft[] = [{ id: "d1", subject: "One", body: "B1" }];
    const { deps } = makeDeps({ drafts });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.sendTestEmail(
      {
        campaignId: "c1",
        recipientEmail: "to@y.com",
        selectionMode: "specific_initial",
        specificInitialDraftIds: ["d-foreign-1", "d-foreign-2"],
      },
      actor,
    );
    expect(result).toMatchObject({ ok: false, reason: "no_drafts_selected" });
  });
});

describe("createTriggerEmailSendUseCases — initial-send + worker methods", () => {
  const { deps } = makeDeps({});
  const uc = createTriggerEmailSendUseCases(deps);

  it("startInitialSend fails synchronously when the required refs are absent", async () => {
    // The initial-send loop now runs inline. Without an approvedDraftBundleRef
    // and confirmedRecipientsRef it returns a `failed` envelope rather than
    // throwing.
    const result = await uc.startInitialSend({ serviceId: "s", campaignId: "c" }, actor);
    expect(result).toMatchObject({
      operationId: "c",
      kind: "initial_send",
      status: "failed",
      sentCount: 0,
    });
  });
  it("getInitialSendStatus returns the in-process send state envelope", async () => {
    const result = await uc.getInitialSendStatus({ campaignId: "c" }, actor);
    expect(result).toMatchObject({ operationId: "c", kind: "initial_send" });
  });
  it("cancelInitialSend returns a cancelled envelope", async () => {
    const result = await uc.cancelInitialSend({ campaignId: "c" }, actor);
    expect(result).toMatchObject({
      operationId: "c",
      kind: "initial_send",
      status: "cancelled",
    });
  });
  it("runInitialSendWorker returns a typed not_supported result (retired, does not throw)", async () => {
    await expect(
      uc.runInitialSendWorker({ serviceId: "s", campaignId: "c", jobId: "j" }, actor),
    ).resolves.toEqual({
      ok: false,
      status: "not_supported",
      reason: "The initial-send worker is retired under the synchronous send path.",
    });
  });
  it("processDueFollowUps returns a typed not_supported result (retired, does not throw)", async () => {
    await expect(uc.processDueFollowUps({ campaignId: "c" }, actor)).resolves.toEqual({
      ok: false,
      status: "not_supported",
      reason: "Due follow-up processing is not implemented under the synchronous send path.",
    });
  });
});
