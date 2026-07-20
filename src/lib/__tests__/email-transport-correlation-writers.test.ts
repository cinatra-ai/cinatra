// cinatra#1456 — email transport correlation writers.
//
// Drives the REAL host email-routing capability that register-email-providers
// publishes, with a fake objects client, and verifies:
//   - the sent-email writer persists campaign / contact / run correlation as
//     soft provenance (non-empty ids only; absent correlation stays backward-
//     compatible);
//   - the received-reply writer persists a received-reply record with a
//     `threadId` DERIVED as (connectorId, providerThreadId) — never an
//     artifact id — plus relate-back campaign / contact;
//   - both writers are best-effort: an objects-layer failure is swallowed, so a
//     missing / tombstoned correlation target never surfaces as a throw
//     (soft-relation harmlessness).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Fake objects client: the writers `await import("@cinatra-ai/objects")` and
// call `objectsClient.save`. Capture every save; let a test flip it to throw.
const saveCalls: Array<{ typeHint?: string; rawData: Record<string, unknown> }> = [];
let saveImpl: (inp: { typeHint?: string; rawData: Record<string, unknown> }) => Promise<unknown> =
  async (inp) => {
    saveCalls.push(inp);
    return { objectId: "obj-1", isNew: true };
  };
vi.mock("@cinatra-ai/objects", () => ({
  objectsClient: { save: (inp: { typeHint?: string; rawData: Record<string, unknown> }) => saveImpl(inp) },
  // Imported at module top by the routing resolver; unused by the writers.
  createSessionObjectsClient: () => ({ list: async () => ({ items: [] }), get: async () => null }),
}));

// The dev-override reader; the writers never touch it, but the module imports it.
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(<T,>(_key: string, fallback: T): T => fallback),
}));

import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";
import { HOST_CONNECTOR_SERVICE_CAPABILITIES } from "@cinatra-ai/sdk-extensions/internal";
import type { HostEmailRoutingService } from "@cinatra-ai/sdk-extensions";
// Importing the module auto-registers the routing capability once (module
// bottom, guarded by an internal `_registered` flag). We never reset the
// capability registry here — the single auto-registration serves every test;
// only the per-test save-call capture is reset.
import "@/lib/register-email-providers";

function routing(): HostEmailRoutingService {
  const provider = resolveCapabilityProviders(
    HOST_CONNECTOR_SERVICE_CAPABILITIES.emailRouting,
  )[0];
  if (!provider) throw new Error("email-routing capability not registered");
  return provider.impl as HostEmailRoutingService;
}

const RECEIPT = {
  providerId: "gmailish",
  providerMessageId: "msg-1",
  providerThreadId: "thread-9",
  internetMessageId: "<abc@mail>",
  sentAt: "2026-07-18T10:00:00.000Z",
};
const MSG = { fromEmail: "me@x.co", to: ["them@y.co"], subject: "Hello" };

const MATCH = {
  providerId: "gmailish",
  providerMessageId: "reply-1",
  providerThreadId: "thread-9",
  internetMessageId: "<reply@mail>",
  fromEmail: "them@y.co",
  subject: "Re: Hello",
  snippet: "sure",
  receivedAt: "2026-07-18T12:00:00.000Z",
};

beforeEach(() => {
  saveCalls.length = 0;
  saveImpl = async (inp) => {
    saveCalls.push(inp);
    return { objectId: "obj-1", isNew: true };
  };
});

describe("saveSentEmailObject — correlation population", () => {
  it("persists campaign / contact / run correlation as soft provenance", async () => {
    await routing().saveSentEmailObject!({
      msg: MSG,
      receipt: RECEIPT,
      routing: { connectorId: "gmailish" },
      correlation: { campaignId: "camp-1", contactId: "c-77", runId: "run-42" },
    });
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].typeHint).toBe("@cinatra-ai/email:sent-email");
    expect(saveCalls[0].rawData).toMatchObject({
      idempotencyKey: "email-send:gmailish:msg-1",
      connectorId: "gmailish",
      providerThreadId: "thread-9",
      // cinatra#1456: standardized derived thread key on the SEND record too —
      // the same (connectorId, providerThreadId) bucket the reply carries.
      threadId: "gmailish:thread-9",
      campaignId: "camp-1",
      contactId: "c-77",
      runId: "run-42",
    });
  });

  it("derives the sent-email threadId from the RESOLVED connector, omits it with no thread id", async () => {
    await routing().saveSentEmailObject!({
      msg: MSG,
      receipt: RECEIPT,
      routing: { connectorId: "resendish" },
    });
    expect(saveCalls[0].rawData.threadId).toBe("resendish:thread-9");
    saveCalls.length = 0;
    await routing().saveSentEmailObject!({
      msg: MSG,
      receipt: { ...RECEIPT, providerThreadId: undefined },
      routing: { connectorId: "gmailish" },
    });
    expect("threadId" in saveCalls[0].rawData).toBe(false);
  });

  it("omits blank / whitespace-only correlation ids (no phantom '' bucket)", async () => {
    await routing().saveSentEmailObject!({
      msg: MSG,
      receipt: RECEIPT,
      routing: { connectorId: "gmailish" },
      correlation: { campaignId: "camp-1", contactId: "   ", runId: "" },
    });
    const data = saveCalls[0].rawData;
    expect(data.campaignId).toBe("camp-1");
    expect("contactId" in data).toBe(false);
    expect("runId" in data).toBe(false);
  });

  it("is backward-compatible: no correlation → no correlation fields written", async () => {
    await routing().saveSentEmailObject!({
      msg: MSG,
      receipt: RECEIPT,
      routing: { connectorId: "gmailish" },
    });
    const data = saveCalls[0].rawData;
    expect("campaignId" in data).toBe(false);
    expect("contactId" in data).toBe(false);
    expect("runId" in data).toBe(false);
    // The pre-existing transport fields are untouched.
    expect(data.toEmail).toBe("them@y.co");
    expect(data.subject).toBe("Hello");
  });

  it("swallows an objects-layer failure (best-effort — never throws)", async () => {
    saveImpl = async () => {
      throw new Error("objects layer down");
    };
    await expect(
      routing().saveSentEmailObject!({
        msg: MSG,
        receipt: RECEIPT,
        routing: { connectorId: "gmailish" },
        correlation: { campaignId: "camp-1" },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("saveReceivedReplyObject — received-reply persistence", () => {
  it("persists a received-reply with threadId derived as (connectorId, providerThreadId)", async () => {
    await routing().saveReceivedReplyObject!({
      match: MATCH,
      routing: { connectorId: "gmailish" },
      correlation: { campaignId: "camp-1", contactId: "c-77" },
    });
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].typeHint).toBe("@cinatra-ai/email:received-reply");
    expect(saveCalls[0].rawData).toMatchObject({
      connectorId: "gmailish",
      providerMessageId: "reply-1",
      providerThreadId: "thread-9",
      internetMessageId: "<reply@mail>",
      fromEmail: "them@y.co",
      subject: "Re: Hello",
      // Derived correlation key — the SAME identity email:thread uses.
      threadId: "gmailish:thread-9",
      // Relate-back soft provenance.
      campaignId: "camp-1",
      contactId: "c-77",
    });
  });

  it("threadId is a DERIVED key, not an artifact id (never an objects reference)", async () => {
    await routing().saveReceivedReplyObject!({
      match: MATCH,
      routing: { connectorId: "resendish" },
    });
    // Keyed on the RESOLVED routing connector, not the match's providerId, so it
    // aligns with the sends' thread bucket for that connector.
    expect(saveCalls[0].rawData.threadId).toBe("resendish:thread-9");
  });

  it("omits threadId when the provider surfaced no thread id (bare reply still persists)", async () => {
    await routing().saveReceivedReplyObject!({
      match: { ...MATCH, providerThreadId: undefined },
      routing: { connectorId: "gmailish" },
    });
    const data = saveCalls[0].rawData;
    expect("threadId" in data).toBe(false);
    expect(data.providerMessageId).toBe("reply-1");
  });

  it("swallows an objects-layer failure (best-effort — never throws)", async () => {
    saveImpl = async () => {
      throw new Error("objects layer down");
    };
    await expect(
      routing().saveReceivedReplyObject!({
        match: MATCH,
        routing: { connectorId: "gmailish" },
      }),
    ).resolves.toBeUndefined();
  });
});
