/**
 * Per-email artifact fan-out tests (cinatra#1455).
 *
 * Proves: (1) each campaign email materializes as an individual claimed
 * artifact — one `email:body` per draft item; (2) the fan-out is idempotent under its
 * `(runScopeId, itemKey)` identity (retry updates, never duplicates);
 * (3) the bundle types stay INTERNAL machinery (never emitted as artifacts);
 * (4) the seam is dormant until the #1454 pack registers the claimed types
 * (build-behind-the-registration-seam); (5) the initial-send path drives the
 * projection at the fan-out boundary without changing send behavior.
 *
 * Lives under src/lib/__tests__/ to be picked up by vitest.config.ts's include
 * glob (src/**\/__tests__/**\/*.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  createTriggerEmailSendUseCases,
  materializeEmailFanout,
  emailBodyExternalId,
  EMAIL_BODY_TYPE_ID,
  type EmailFanoutArgs,
  type EmailFanoutBodyWrite,
  type EmailFanoutBodyWriteFn,
  type EmailFanoutResult,
} from "../trigger-email-send-use-cases";

const actor: PrimitiveActorContext = {
  actorType: "human",
  source: "route",
  userId: "user-1",
  sessionId: "sess-1",
};

function makeFakeStore() {
  // The bodies go through the ledgered writer (cinatra#3089): one artifact per
  // (run, message identity, content) — a re-write of the same key reuses it.
  const bodyWrites: EmailFanoutBodyWrite[] = [];
  const bodyArtifacts = new Map<string, string>();
  const writeBody: EmailFanoutBodyWriteFn = async (w) => {
    bodyWrites.push(w);
    const key = `${w.runId}|${w.outputId}|${w.markdown}`;
    const existing = bodyArtifacts.get(key);
    if (existing) {
      return { ok: true, artifactId: existing, representationRevisionId: `${existing}-rev`, deduped: true };
    }
    const artifactId = `art-${bodyArtifacts.size + 1}`;
    bodyArtifacts.set(key, artifactId);
    return { ok: true, artifactId, representationRevisionId: `${artifactId}-rev`, deduped: false };
  };
  return { writeBody, bodyWrites, bodyArtifacts };
}

const ALL_TYPES = new Set([EMAIL_BODY_TYPE_ID]);

const twoDrafts = [
  { id: "d1", contactId: "c1", subject: "Hello One", body: "Body one" },
  { id: "d2", contactId: "c2", subject: "Hello Two", body: "Body two" },
];
const twoRecipients = [
  { contactId: "c1", email: "one@example.com", name: "One" },
  { contactId: "c2", email: "two@example.com", name: "Two" },
];

describe("materializeEmailFanout — per-item emission", () => {
  it("emits one email:body per draft", async () => {
    const { writeBody, bodyWrites } = makeFakeStore();
    const result = await materializeEmailFanout(
      { runScopeId: "run-1", campaignId: "camp-1", drafts: twoDrafts, recipients: twoRecipients },
      { writeBody, registeredTypes: ALL_TYPES },
    );

    expect(result.bodies).toHaveLength(2);
    expect(result.skipped).toEqual({ bodies: false });

    // Bodies go through the ledgered writer.
    expect(bodyWrites).toHaveLength(2);

    // email:body keyed (runScopeId, draftItemId); carries content under the
    // declared bodyMarkdown + soft provenance, NOT the recipient address (PII
    // stays off the body surface).
    expect(bodyWrites[0]).toMatchObject({
      runId: "run-1",
      outputId: emailBodyExternalId("run-1", "d1"),
      markdown: "Body one",
      typedData: {
        runId: "run-1",
        campaignId: "camp-1",
        subject: "Hello One",
        bodyMarkdown: "Body one",
        contactId: "c1",
      },
    });
    expect(bodyWrites[0].typedData.email).toBeUndefined();
    expect(bodyWrites[0].typedData.recipientEmail).toBeUndefined();
    expect(bodyWrites[0].typedData.body).toBeUndefined();
  });

  it("every emitted type is a claimed artifact type — no bundle type is ever an artifact", async () => {
    const { writeBody } = makeFakeStore();
    const result = await materializeEmailFanout(
      { runScopeId: "run-1", campaignId: "camp-1", drafts: twoDrafts, recipients: twoRecipients },
      { writeBody, registeredTypes: ALL_TYPES },
    );
    const bundleTypeFragments = ["bundle", "campaigns:recipients", "dynamic:", "send-attempt"];
    for (const c of result.bodies) {
      expect([EMAIL_BODY_TYPE_ID]).toContain(c.typeId);
      for (const frag of bundleTypeFragments) {
        expect(c.typeId.includes(frag)).toBe(false);
      }
    }
  });
});

describe("materializeEmailFanout — idempotent re-run (the fan-out identity)", () => {
  it("a retried run updates the same rows, never duplicates", async () => {
    const store = makeFakeStore();
    const input = {
      runScopeId: "run-1",
      campaignId: "camp-1",
      drafts: twoDrafts,
      recipients: twoRecipients,
    };

    const first = await materializeEmailFanout(input, {
      writeBody: store.writeBody,
      registeredTypes: ALL_TYPES,
    });
    // First run inserts everything.
    expect(first.bodies.every((b) => b.isNew)).toBe(true);

    const second = await materializeEmailFanout(input, {
      writeBody: store.writeBody,
      registeredTypes: ALL_TYPES,
    });
    // Second run updates in place — nothing is new.
    expect(second.bodies.every((b) => !b.isNew)).toBe(true);

    // Same object ids across runs, and exactly 2 body artifacts — no
    // duplication despite 4 body writes.
    expect(second.bodies.map((b) => b.objectId)).toEqual(first.bodies.map((b) => b.objectId));
    expect(store.bodyArtifacts.size).toBe(2);
    expect(store.bodyWrites).toHaveLength(4);
  });

  it("the fan-out externalId is deterministic across independent calls", async () => {
    const a = makeFakeStore();
    const b = makeFakeStore();
    const input = {
      runScopeId: "run-7",
      campaignId: "camp-7",
      drafts: twoDrafts,
      recipients: twoRecipients,
    };
    const ra = await materializeEmailFanout(input, {
      writeBody: a.writeBody,
      registeredTypes: ALL_TYPES,
    });
    const rb = await materializeEmailFanout(input, {
      writeBody: b.writeBody,
      registeredTypes: ALL_TYPES,
    });
    expect(ra.bodies.map((x) => x.externalId)).toEqual(rb.bodies.map((x) => x.externalId));
    // Distinct items get distinct keys.
    expect(new Set(ra.bodies.map((x) => x.externalId)).size).toBe(2);
  });
});

describe("materializeEmailFanout — registration seam (coupling with #1454)", () => {
  it("emits NOTHING when neither claimed type is registered (dormant seam)", async () => {
    const result = await materializeEmailFanout(
      { runScopeId: "run-1", campaignId: "camp-1", drafts: twoDrafts, recipients: twoRecipients },
      { registeredTypes: new Set() },
    );
    expect(result.bodies).toHaveLength(0);
    expect(result.skipped).toEqual({ bodies: true });
  });

  it("emits only the registered half when the pack partially registers", async () => {
    const { writeBody, bodyWrites } = makeFakeStore();
    const result = await materializeEmailFanout(
      { runScopeId: "run-1", campaignId: "camp-1", drafts: twoDrafts, recipients: twoRecipients },
      { writeBody, registeredTypes: new Set([EMAIL_BODY_TYPE_ID]) },
    );
    expect(result.bodies).toHaveLength(2);
    expect(result.skipped).toEqual({ bodies: false });
    // The body half ran: two ledgered body writes.
    expect(bodyWrites).toHaveLength(2);
  });
});

describe("materializeEmailFanout — draft-item identity (non-PII, no collapse)", () => {
  it("keys body on the explicit draft id, never on contactId or the recipient email", async () => {
    const { writeBody, bodyWrites } = makeFakeStore();
    // Two drafts targeting the SAME contact, each with its own draft id — they
    // must NOT collapse to one artifact, and neither the contactId nor the email
    // may appear in the body identity fields (PII stays off the body surface).
    await materializeEmailFanout(
      {
        runScopeId: "run-1",
        campaignId: "camp-1",
        drafts: [
          { id: "d1", contactId: "same", email: "person@example.com", subject: "A", body: "a" },
          { id: "d2", contactId: "same", email: "person@example.com", subject: "B", body: "b" },
        ],
        recipients: [],
      },
      { writeBody, registeredTypes: ALL_TYPES },
    );
    expect(bodyWrites).toHaveLength(2);
    expect(bodyWrites[0].outputId).toBe(emailBodyExternalId("run-1", "d1"));
    expect(bodyWrites[1].outputId).toBe(emailBodyExternalId("run-1", "d2"));
    for (const w of bodyWrites) {
      expect(w.outputId).not.toContain("person@example.com");
      expect(w.outputId).not.toContain("same");
      expect(w.typedData.email).toBeUndefined();
      expect(w.typedData.recipientEmail).toBeUndefined();
    }
  });

  it("falls back to the positional index when a draft has no explicit id (no PII fallback)", async () => {
    const { writeBody, bodyWrites } = makeFakeStore();
    await materializeEmailFanout(
      {
        runScopeId: "run-1",
        campaignId: "camp-1",
        drafts: [
          { contactId: "c9", email: "leak@example.com", subject: "S", body: "B" }, // no id
        ],
        recipients: [],
      },
      { writeBody, registeredTypes: ALL_TYPES },
    );
    expect(bodyWrites[0].outputId).toBe(emailBodyExternalId("run-1", "idx-0"));
    expect(bodyWrites[0].outputId).not.toContain("leak@example.com");
  });
});

// ---------------------------------------------------------------------------
// Initial-send integration: the fan-out fires at the send boundary, the send
// behavior is unchanged, and a projection failure never fails the send.
// ---------------------------------------------------------------------------
type Bundle = { id?: string; type?: string; data?: unknown };

function makeSendDeps(overrides: {
  draftBundle?: Bundle | null;
  recipBundle?: Bundle | null;
  emitImpl?: (args: EmailFanoutArgs) => Promise<EmailFanoutResult>;
  sendEmail?: ReturnType<typeof vi.fn>;
}) {
  const draftBundle: Bundle =
    overrides.draftBundle ?? {
      id: "draft-ref",
      type: "@cinatra-ai/campaigns:email-draft-bundle",
      data: {
        cinatraAgentRunId: "run-42",
        drafts: [
          { id: "d1", contactId: "c1", subject: "S1", body: "B1" },
          { id: "d2", contactId: "c2", subject: "S2", body: "B2" },
        ],
      },
    };
  const recipBundle: Bundle =
    overrides.recipBundle ?? {
      id: "recip-ref",
      type: "@cinatra-ai/campaigns:recipients",
      data: {
        confirmedRecipients: [
          { contactId: "c1", email: "one@example.com", name: "One" },
          { contactId: "c2", email: "two@example.com", name: "Two" },
        ],
      },
    };
  const sendEmail =
    overrides.sendEmail ??
    vi.fn().mockResolvedValue({
      providerId: "gmail",
      providerMessageId: "m1",
      sentAt: new Date().toISOString(),
    });
  const emitEmailFanout = vi.fn(
    overrides.emitImpl ??
      (async (): Promise<EmailFanoutResult> => ({
        bodies: [],
        skipped: { bodies: false },
      })),
  );
  const getObjectByRef = vi.fn(async (ref: string) => {
    if (ref === "draft-ref") return draftBundle;
    if (ref === "recip-ref") return recipBundle;
    return null;
  });
  const deps = {
    getCampaign: vi.fn().mockResolvedValue(null),
    getDraftsByIds: vi.fn().mockResolvedValue([]),
    sendEmail: sendEmail as never,
    getObjectByRef: getObjectByRef as never,
    emitEmailFanout: emitEmailFanout as never,
  };
  return { deps, sendEmail, emitEmailFanout, getObjectByRef };
}

const sendInput = {
  serviceId: "s",
  campaignId: "camp-1",
  approvedDraftBundleRef: "draft-ref",
  confirmedRecipientsRef: "recip-ref",
  senderEmail: "sender@cinatra.ai",
};

describe("startInitialSend — fan-out at the send boundary", () => {
  it("sends one email per draft AND projects the fan-out with the resolved run scope", async () => {
    const { deps, sendEmail, emitEmailFanout } = makeSendDeps({});
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.startInitialSend(sendInput, actor);

    // Send behavior unchanged: one email per draft.
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "completed", sentCount: 2 });

    // Projection fired once, with the run id lifted off the bundle envelope and
    // the resolved drafts + recipients.
    expect(emitEmailFanout).toHaveBeenCalledTimes(1);
    const fanoutArgs = emitEmailFanout.mock.calls[0][0] as EmailFanoutArgs;
    expect(fanoutArgs.runScopeId).toBe("run-42");
    expect(fanoutArgs.campaignId).toBe("camp-1");
    expect(fanoutArgs.drafts).toHaveLength(2);
    expect(fanoutArgs.recipients).toHaveLength(2);
  });

  it("a projection failure never fails the send", async () => {
    const { deps, sendEmail } = makeSendDeps({
      emitImpl: async () => {
        throw new Error("projection boom");
      },
    });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.startInitialSend(sendInput, actor);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "completed", sentCount: 2 });
  });

  it("does not project when the send fails early (missing refs)", async () => {
    const { deps, emitEmailFanout } = makeSendDeps({});
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.startInitialSend({ serviceId: "s", campaignId: "camp-1" }, actor);
    expect(result).toMatchObject({ status: "failed", sentCount: 0 });
    expect(emitEmailFanout).not.toHaveBeenCalled();
  });

  it("skips the projection (but still sends) when no run id is on the bundles", async () => {
    // Bundles with NO cinatraAgentRunId — the fan-out identity requires a real
    // run id, so the projection is skipped rather than keyed on the campaign.
    const { deps, sendEmail, emitEmailFanout } = makeSendDeps({
      draftBundle: {
        id: "draft-ref",
        type: "@cinatra-ai/campaigns:email-draft-bundle",
        data: {
          drafts: [
            { id: "d1", contactId: "c1", subject: "S1", body: "B1" },
            { id: "d2", contactId: "c2", subject: "S2", body: "B2" },
          ],
        },
      },
      recipBundle: {
        id: "recip-ref",
        type: "@cinatra-ai/campaigns:recipients",
        data: {
          confirmedRecipients: [
            { contactId: "c1", email: "one@example.com" },
            { contactId: "c2", email: "two@example.com" },
          ],
        },
      },
    });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.startInitialSend(sendInput, actor);
    expect(result).toMatchObject({ status: "completed", sentCount: 2 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(emitEmailFanout).not.toHaveBeenCalled();
  });
});

describe("startInitialSend — a draft is addressed to its own recipient only", () => {
  const mixedRecipients = {
    id: "recip-ref",
    type: "@cinatra-ai/campaigns:recipients",
    data: {
      confirmedRecipients: [
        { contactId: "c1", email: "one@example.com", name: "One" },
        { contactId: "c2", name: "Two" },
      ],
    },
  };
  const sentCallsFor = (sendEmail: ReturnType<typeof vi.fn>, subject: string) =>
    sendEmail.mock.calls.filter(
      (call) => (call[0] as { subject: string }).subject === subject,
    );

  it("a draft without an address of its own is never addressed to another recipient", async () => {
    const { deps, sendEmail } = makeSendDeps({ recipBundle: mixedRecipients });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.startInitialSend(sendInput, actor);
    expect(result).toMatchObject({ status: "completed", sentCount: 1 });
    for (const call of sentCallsFor(sendEmail, "S2")) {
      expect((call[0] as { to: string[] }).to).not.toContain("one@example.com");
    }
    expect(sentCallsFor(sendEmail, "S2")).toHaveLength(0);
  });

  it("the first recipient's own draft still goes to the first recipient", async () => {
    const { deps, sendEmail } = makeSendDeps({ recipBundle: mixedRecipients });
    const uc = createTriggerEmailSendUseCases(deps);
    await uc.startInitialSend(sendInput, actor);
    const calls = sentCallsFor(sendEmail, "S1");
    expect(calls).toHaveLength(1);
    expect((calls[0][0] as { to: string[] }).to).toEqual(["one@example.com"]);
  });

  it("a draft matched by its contact id takes the matched recipient's address", async () => {
    const { deps, sendEmail } = makeSendDeps({
      draftBundle: {
        id: "draft-ref",
        type: "@cinatra-ai/campaigns:email-draft-bundle",
        data: {
          drafts: [{ id: "d1", contactId: "c2", subject: "S1", body: "B1" }],
        },
      },
    });
    const uc = createTriggerEmailSendUseCases(deps);
    await uc.startInitialSend(sendInput, actor);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0][0] as { to: string[] }).to).toEqual(["two@example.com"]);
  });

  it("a draft without any address is not sent and the run completes with the drafts that were sent", async () => {
    const { deps, sendEmail } = makeSendDeps({
      draftBundle: {
        id: "draft-ref",
        type: "@cinatra-ai/campaigns:email-draft-bundle",
        data: {
          drafts: [
            { id: "d1", contactId: "c1", subject: "S1", body: "B1" },
            { id: "d2", recipientEmail: "own@example.com", subject: "S2", body: "B2" },
          ],
        },
      },
      recipBundle: {
        id: "recip-ref",
        type: "@cinatra-ai/campaigns:recipients",
        data: { confirmedRecipients: [{ contactId: "c1", name: "One" }] },
      },
    });
    const uc = createTriggerEmailSendUseCases(deps);
    const result = await uc.startInitialSend(sendInput, actor);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0][0] as { to: string[] }).to).toEqual(["own@example.com"]);
    expect(result).toMatchObject({ status: "completed", sentCount: 1 });
    expect((result as { errorMessage?: string }).errorMessage).toBeUndefined();
    const status = await uc.getInitialSendStatus({ campaignId: "camp-1" }, actor);
    expect(status).toMatchObject({ status: "completed", sentCount: 1 });
  });
});
