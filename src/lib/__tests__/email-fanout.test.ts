/**
 * Per-email artifact fan-out tests (cinatra#1455).
 *
 * Proves: (1) each campaign email materializes as an individual claimed
 * artifact — one `email:body` per draft item, one `email:recipient` per
 * confirmed recipient; (2) the fan-out is idempotent under its
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
  emailRecipientExternalId,
  EMAIL_BODY_TYPE_ID,
  EMAIL_RECIPIENT_TYPE_ID,
  type EmailFanoutArgs,
  type EmailFanoutResult,
  type EmailFanoutSaveFn,
} from "../trigger-email-send-use-cases";

const actor: PrimitiveActorContext = {
  actorType: "human",
  source: "route",
  userId: "user-1",
  sessionId: "sess-1",
};

// ---------------------------------------------------------------------------
// Fake objects store: models the objects_save identity-upsert semantics.
// Identity mirrors `packages/objects/src/identity.ts` Layer 1 — an explicit
// `externalId` on the payload is the strongest identity layer, hashed WITH the
// type and lowercased. Re-saving the same (type, externalId) UPDATES the same
// object id instead of inserting a duplicate. That is exactly the guarantee the
// fan-out relies on for idempotent retries.
// ---------------------------------------------------------------------------
function makeFakeStore() {
  const rows = new Map<string, { id: string; type: string; data: Record<string, unknown> }>();
  const calls: Array<{ typeHint: string; rawData: Record<string, unknown> }> = [];
  let seq = 0;
  const save: EmailFanoutSaveFn = async ({ rawData, typeHint }) => {
    calls.push({ typeHint, rawData });
    const externalId = String(rawData.externalId ?? "");
    // Faithful to resolveIdentity: identity requires an explicit externalId.
    const key = `${typeHint}::external:${externalId.trim().toLowerCase()}`;
    const existing = externalId.trim() !== "" ? rows.get(key) : undefined;
    if (existing) {
      existing.data = rawData;
      return { objectId: existing.id, type: typeHint, isNew: false, wasMerged: true };
    }
    seq += 1;
    const id = `obj-${seq}`;
    const row = { id, type: typeHint, data: rawData };
    if (externalId.trim() !== "") rows.set(key, row);
    return { objectId: id, type: typeHint, isNew: true, wasMerged: false };
  };
  return { save, calls, rows };
}

const ALL_TYPES = new Set([EMAIL_BODY_TYPE_ID, EMAIL_RECIPIENT_TYPE_ID]);

const twoDrafts = [
  { id: "d1", contactId: "c1", subject: "Hello One", body: "Body one" },
  { id: "d2", contactId: "c2", subject: "Hello Two", body: "Body two" },
];
const twoRecipients = [
  { contactId: "c1", email: "one@example.com", name: "One" },
  { contactId: "c2", email: "two@example.com", name: "Two" },
];

describe("materializeEmailFanout — per-item emission", () => {
  it("emits one email:body per draft and one email:recipient per recipient", async () => {
    const { save, calls } = makeFakeStore();
    const result = await materializeEmailFanout(
      { runScopeId: "run-1", campaignId: "camp-1", drafts: twoDrafts, recipients: twoRecipients },
      { save, registeredTypes: ALL_TYPES },
    );

    expect(result.bodies).toHaveLength(2);
    expect(result.recipients).toHaveLength(2);
    expect(result.skipped).toEqual({ bodies: false, recipients: false });

    // Every write targets a per-item ARTIFACT type — never a bundle type.
    const bodyCalls = calls.filter((c) => c.typeHint === EMAIL_BODY_TYPE_ID);
    const recipCalls = calls.filter((c) => c.typeHint === EMAIL_RECIPIENT_TYPE_ID);
    expect(bodyCalls).toHaveLength(2);
    expect(recipCalls).toHaveLength(2);

    // email:body keyed (runScopeId, draftItemId); carries content + soft
    // provenance, NOT the recipient address (PII stays off the body surface).
    expect(bodyCalls[0].rawData).toMatchObject({
      externalId: emailBodyExternalId("run-1", "d1"),
      runId: "run-1",
      campaignId: "camp-1",
      draftItemId: "d1",
      subject: "Hello One",
      body: "Body one",
      contactId: "c1",
    });
    expect(bodyCalls[0].rawData.email).toBeUndefined();
    expect(bodyCalls[0].rawData.recipientEmail).toBeUndefined();

    // email:recipient keyed (runScopeId, contact key); minimum fields.
    expect(recipCalls[0].rawData).toMatchObject({
      externalId: emailRecipientExternalId("run-1", "contact:c1"),
      runId: "run-1",
      campaignId: "camp-1",
      contactId: "c1",
      email: "one@example.com",
      name: "One",
    });
  });

  it("every emitted type is a claimed artifact type — no bundle type is ever an artifact", async () => {
    const { save, calls } = makeFakeStore();
    await materializeEmailFanout(
      { runScopeId: "run-1", campaignId: "camp-1", drafts: twoDrafts, recipients: twoRecipients },
      { save, registeredTypes: ALL_TYPES },
    );
    const bundleTypeFragments = ["bundle", "campaigns:recipients", "dynamic:", "send-attempt"];
    for (const c of calls) {
      expect([EMAIL_BODY_TYPE_ID, EMAIL_RECIPIENT_TYPE_ID]).toContain(c.typeHint);
      for (const frag of bundleTypeFragments) {
        expect(c.typeHint.includes(frag)).toBe(false);
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
      save: store.save,
      registeredTypes: ALL_TYPES,
    });
    // First run inserts everything.
    expect(first.bodies.every((b) => b.isNew)).toBe(true);
    expect(first.recipients.every((r) => r.isNew)).toBe(true);

    const second = await materializeEmailFanout(input, {
      save: store.save,
      registeredTypes: ALL_TYPES,
    });
    // Second run updates in place — nothing is new.
    expect(second.bodies.every((b) => !b.isNew)).toBe(true);
    expect(second.recipients.every((r) => !r.isNew)).toBe(true);

    // Same object ids across runs, and exactly 4 durable rows (2 bodies + 2
    // recipients) — no duplication despite 8 save calls.
    expect(second.bodies.map((b) => b.objectId)).toEqual(first.bodies.map((b) => b.objectId));
    expect(second.recipients.map((r) => r.objectId)).toEqual(
      first.recipients.map((r) => r.objectId),
    );
    expect(store.rows.size).toBe(4);
    expect(store.calls).toHaveLength(8);
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
    const ra = await materializeEmailFanout(input, { save: a.save, registeredTypes: ALL_TYPES });
    const rb = await materializeEmailFanout(input, { save: b.save, registeredTypes: ALL_TYPES });
    expect(ra.bodies.map((x) => x.externalId)).toEqual(rb.bodies.map((x) => x.externalId));
    expect(ra.recipients.map((x) => x.externalId)).toEqual(rb.recipients.map((x) => x.externalId));
    // Distinct items get distinct keys.
    expect(new Set(ra.bodies.map((x) => x.externalId)).size).toBe(2);
    expect(new Set(ra.recipients.map((x) => x.externalId)).size).toBe(2);
  });
});

describe("materializeEmailFanout — registration seam (coupling with #1454)", () => {
  it("emits NOTHING when neither claimed type is registered (dormant seam)", async () => {
    const { save, calls } = makeFakeStore();
    const result = await materializeEmailFanout(
      { runScopeId: "run-1", campaignId: "camp-1", drafts: twoDrafts, recipients: twoRecipients },
      { save, registeredTypes: new Set() },
    );
    expect(calls).toHaveLength(0);
    expect(result.bodies).toHaveLength(0);
    expect(result.recipients).toHaveLength(0);
    expect(result.skipped).toEqual({ bodies: true, recipients: true });
  });

  it("emits only the registered half when the pack partially registers", async () => {
    const { save, calls } = makeFakeStore();
    const result = await materializeEmailFanout(
      { runScopeId: "run-1", campaignId: "camp-1", drafts: twoDrafts, recipients: twoRecipients },
      { save, registeredTypes: new Set([EMAIL_BODY_TYPE_ID]) },
    );
    expect(result.bodies).toHaveLength(2);
    expect(result.recipients).toHaveLength(0);
    expect(result.skipped).toEqual({ bodies: false, recipients: true });
    expect(calls.every((c) => c.typeHint === EMAIL_BODY_TYPE_ID)).toBe(true);
  });
});

describe("materializeEmailFanout — draft-item identity (non-PII, no collapse)", () => {
  it("keys body on the explicit draft id, never on contactId or the recipient email", async () => {
    const { save, calls } = makeFakeStore();
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
      { save, registeredTypes: ALL_TYPES },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].rawData.externalId).toBe(emailBodyExternalId("run-1", "d1"));
    expect(calls[1].rawData.externalId).toBe(emailBodyExternalId("run-1", "d2"));
    for (const c of calls) {
      expect(String(c.rawData.externalId)).not.toContain("person@example.com");
      expect(String(c.rawData.draftItemId)).not.toContain("person@example.com");
      expect(String(c.rawData.externalId)).not.toContain("same");
      expect(c.rawData.email).toBeUndefined();
      expect(c.rawData.recipientEmail).toBeUndefined();
    }
  });

  it("falls back to the positional index when a draft has no explicit id (no PII fallback)", async () => {
    const { save, calls } = makeFakeStore();
    await materializeEmailFanout(
      {
        runScopeId: "run-1",
        campaignId: "camp-1",
        drafts: [
          { contactId: "c9", email: "leak@example.com", subject: "S", body: "B" }, // no id
        ],
        recipients: [],
      },
      { save, registeredTypes: ALL_TYPES },
    );
    expect(calls[0].rawData.draftItemId).toBe("idx-0");
    expect(calls[0].rawData.externalId).toBe(emailBodyExternalId("run-1", "idx-0"));
    expect(String(calls[0].rawData.externalId)).not.toContain("leak@example.com");
  });
});

describe("materializeEmailFanout — recipient identity + PII discipline", () => {
  it("prefers the provider-scoped contact key and falls back to normalized email", async () => {
    const { save, calls } = makeFakeStore();
    await materializeEmailFanout(
      {
        runScopeId: "run-1",
        campaignId: "camp-1",
        drafts: [],
        recipients: [
          { contactId: "twenty-99", email: "WITH.Contact@Example.com" },
          { email: "Only.Email@Example.com" }, // no contactId -> normalized email
        ],
      },
      { save, registeredTypes: ALL_TYPES },
    );
    expect(calls[0].rawData.externalId).toBe(emailRecipientExternalId("run-1", "contact:twenty-99"));
    expect(calls[1].rawData.externalId).toBe(
      emailRecipientExternalId("run-1", "email:only.email@example.com"),
    );
  });

  it("never projects an unidentifiable recipient and de-dupes within the batch", async () => {
    const { save, calls } = makeFakeStore();
    const result = await materializeEmailFanout(
      {
        runScopeId: "run-1",
        campaignId: "camp-1",
        drafts: [],
        recipients: [
          { name: "No Contact, No Email" }, // unidentifiable -> skipped
          { contactId: "dup" },
          { contactId: "dup" }, // duplicate contact key -> collapsed
        ],
      },
      { save, registeredTypes: ALL_TYPES },
    );
    expect(result.recipients).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].rawData.externalId).toBe(emailRecipientExternalId("run-1", "contact:dup"));
  });
});

describe("externalId helpers", () => {
  it("body and recipient namespaces never collide", () => {
    expect(emailBodyExternalId("r", "x")).not.toBe(emailRecipientExternalId("r", "x"));
    expect(emailBodyExternalId("r", "a")).toBe("email-body:r:a");
    expect(emailRecipientExternalId("r", "a")).toBe("email-recipient:r:a");
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
        recipients: [],
        skipped: { bodies: false, recipients: false },
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
