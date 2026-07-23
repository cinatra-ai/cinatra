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
//
// cinatra#1983: the SENT-EMAIL writer now builds an authorization-bearing,
// org-scoped actor and writes via `createSessionObjectsClient(actor).save`
// (NOT the roleless, org-less `objectsClient` singleton). These unit tests
// assert the ACTOR SHAPE the writer builds (AC1) and the clean org-less skip
// (AC3); the REAL objects_save/authz/store round-trip is proven separately by
// the real-DB regression in
// src/lib/__tests__/integration/sent-email-object-write-authz.integration.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Fake objects client. Capture every save; let a test flip it to throw.
//   - the RECEIVED-REPLY writer still uses the sessionless `objectsClient`
//     singleton → `objectsClient.save`;
//   - the SENT-EMAIL writer (cinatra#1983) now builds an authorization-bearing,
//     org-scoped actor and writes via `createSessionObjectsClient(actor).save`.
// Both funnel through the SAME `saveImpl` capture; `sessionActors` records the
// ActorContext the sent-email writer built so a test can assert AC1.
type SaveCall = { typeHint?: string; rawData: Record<string, unknown> };
const saveCalls: SaveCall[] = [];
const sessionActors: Array<Record<string, unknown>> = [];
let saveImpl: (inp: SaveCall) => Promise<unknown> = async (inp) => {
  saveCalls.push(inp);
  return { objectId: "obj-1", isNew: true };
};
vi.mock("@cinatra-ai/objects", () => ({
  objectsClient: { save: (inp: SaveCall) => saveImpl(inp) },
  // cinatra#1983: the sent-email writer builds the client from an ActorContext.
  // Capture that actor, and route `.save` through the shared capture. `list`/`get`
  // are used by the routing resolver (unused by the writers).
  createSessionObjectsClient: (actor: Record<string, unknown>) => {
    sessionActors.push(actor);
    return {
      save: (inp: SaveCall) => saveImpl(inp),
      list: async () => ({ items: [] }),
      get: async () => null,
    };
  },
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
  sessionActors.length = 0;
  saveImpl = async (inp) => {
    saveCalls.push(inp);
    return { objectId: "obj-1", isNew: true };
  };
});

// cinatra#1983: the sent-email writer requires an org context (routing.orgId) and
// writes under an authorization-bearing, org-scoped actor. Every sent-email test
// below threads an org (and, where relevant, the run-owner userId).
const ORG = "org-1983";
const OWNER = "user-owner-1983";

describe("saveSentEmailObject — correlation population", () => {
  it("persists campaign / contact / run correlation as soft provenance", async () => {
    await routing().saveSentEmailObject!({
      msg: MSG,
      receipt: RECEIPT,
      routing: { connectorId: "gmailish", orgId: ORG, userId: OWNER },
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
      routing: { connectorId: "resendish", orgId: ORG, userId: OWNER },
    });
    expect(saveCalls[0].rawData.threadId).toBe("resendish:thread-9");
    saveCalls.length = 0;
    await routing().saveSentEmailObject!({
      msg: MSG,
      receipt: { ...RECEIPT, providerThreadId: undefined },
      routing: { connectorId: "gmailish", orgId: ORG, userId: OWNER },
    });
    expect("threadId" in saveCalls[0].rawData).toBe(false);
  });

  it("omits blank / whitespace-only correlation ids (no phantom '' bucket)", async () => {
    await routing().saveSentEmailObject!({
      msg: MSG,
      receipt: RECEIPT,
      routing: { connectorId: "gmailish", orgId: ORG, userId: OWNER },
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
      routing: { connectorId: "gmailish", orgId: ORG, userId: OWNER },
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
        routing: { connectorId: "gmailish", orgId: ORG, userId: OWNER },
        correlation: { campaignId: "camp-1" },
      }),
    ).resolves.toBeUndefined();
  });

  // cinatra#1983 AC1 — the writer builds the client from an authorization-bearing,
  // ORG-SCOPED actor carrying real create authority (the run-owner / session
  // standing), NOT the roleless, org-less singleton. An org-stamped-but-roleless
  // actor is explicitly NOT sufficient — the `member` org-role floor is what
  // confers `object.create`.
  it("AC1: writes via an org-scoped, create-capable actor (member floor), not the roleless singleton", async () => {
    await routing().saveSentEmailObject!({
      msg: MSG,
      receipt: RECEIPT,
      routing: { connectorId: "gmailish", orgId: ORG, userId: OWNER },
    });
    expect(sessionActors).toHaveLength(1);
    const actor = sessionActors[0];
    expect(actor.organizationId).toBe(ORG);
    // Real create authority — NOT org-stamped-but-roleless.
    expect(actor.orgRole).toBe("member");
    // Run-owner identity → user-owned/private record readable by the owner's
    // org-scoped list (the reconcile vantage).
    expect(actor.principalType).toBe("HumanUser");
    expect(actor.principalId).toBe(OWNER);
  });

  it("AC1: an org-scoped send with NO userId writes as a create-capable System actor", async () => {
    await routing().saveSentEmailObject!({
      msg: MSG,
      receipt: RECEIPT,
      routing: { connectorId: "gmailish", orgId: ORG },
    });
    expect(saveCalls).toHaveLength(1);
    const actor = sessionActors[0];
    expect(actor.organizationId).toBe(ORG);
    expect(actor.orgRole).toBe("member");
    expect(actor.principalType).toBe("System");
  });

  // cinatra#1983 AC3 — a legitimately org-less send (pre-auth platform /
  // transactional mail, e.g. sendPlatformEmail's `routing: { connectorId }`)
  // NO-OPs the object write: no objects_save attempt (no session client built),
  // no null-org throw, no swallowed warn.
  it("AC3: a genuinely org-less send skips the write cleanly (no save, no throw)", async () => {
    await expect(
      routing().saveSentEmailObject!({
        msg: MSG,
        receipt: RECEIPT,
        routing: { connectorId: "gmailish" },
        correlation: { campaignId: "camp-1" },
      }),
    ).resolves.toBeUndefined();
    expect(saveCalls).toHaveLength(0);
    expect(sessionActors).toHaveLength(0);
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
