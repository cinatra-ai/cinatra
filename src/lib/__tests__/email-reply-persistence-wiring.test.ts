// cinatra#1456 — findReplyInEmailThread persists a received-reply on a match.
//
// Drives the REAL email-send capability registry with a fake provider whose
// findReply returns a match, plus a fake host email-routing service, and
// verifies the host reply lookup best-effort persists a received-reply record
// (forwarding relate-back correlation) WITHOUT changing the returned match.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(<T,>(_key: string, fallback: T): T => fallback),
  writeConnectorConfigToDatabase: vi.fn(),
}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { findReplyInEmailThread } from "@/lib/email-system";

const MATCH = {
  providerId: "gmailish",
  providerMessageId: "reply-1",
  providerThreadId: "thread-9",
  internetMessageId: "<reply@mail>",
  fromEmail: "them@y.co",
  subject: "Re: Hello",
  receivedAt: "2026-07-18T12:00:00.000Z",
};

function fakeReplyProvider() {
  const findReply = vi.fn(async () => MATCH);
  registerCapabilityProvider("email-send", {
    packageName: "@v/gmailish-connector",
    impl: {
      definition: {
        connectorId: "gmailish",
        name: "gmailish",
        slug: "gmailish",
        description: "",
        settingsHref: "/connectors/gmailish",
        connectionScope: "user",
      },
      send: vi.fn(),
      findReply,
      getStatus: vi.fn(async () => ({ status: "connected" as const })),
    },
  });
  return findReply;
}

function fakeRouting() {
  const saveReceivedReplyObject = vi.fn(async () => undefined);
  registerCapabilityProvider("@cinatra-ai/host:email-routing", {
    packageName: "@cinatra-ai/host",
    impl: {
      resolveConnectorId: async () => null,
      applyDevModeOverride: <M,>(msg: M): M => msg,
      saveReceivedReplyObject,
    },
  });
  return saveReceivedReplyObject;
}

beforeEach(() => {
  __resetCapabilityRegistry();
});

describe("findReplyInEmailThread — received-reply persistence", () => {
  it("persists the match via the host routing writer, forwarding correlation", async () => {
    fakeReplyProvider();
    const save = fakeRouting();

    const result = await findReplyInEmailThread({
      providerThreadId: "thread-9",
      recipientEmail: "them@y.co",
      userId: "user-1",
      correlation: { campaignId: "camp-1", contactId: "c-77" },
    });

    // The returned match is unchanged by the persistence side-effect.
    expect(result).toEqual(MATCH);

    // Best-effort persistence fired (allow the fire-and-forget microtask to run).
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        match: MATCH,
        routing: expect.objectContaining({ connectorId: "gmailish", userId: "user-1" }),
        correlation: { campaignId: "camp-1", contactId: "c-77" },
      }),
    );
  });

  it("no match → no received-reply write", async () => {
    // Provider whose findReply returns null.
    registerCapabilityProvider("email-send", {
      packageName: "@v/gmailish-connector",
      impl: {
        definition: {
          connectorId: "gmailish",
          name: "gmailish",
          slug: "gmailish",
          description: "",
          settingsHref: "/connectors/gmailish",
          connectionScope: "user",
        },
        send: vi.fn(),
        findReply: vi.fn(async () => null),
        getStatus: vi.fn(async () => ({ status: "connected" as const })),
      },
    });
    const save = fakeRouting();

    const result = await findReplyInEmailThread({
      providerThreadId: "thread-9",
      recipientEmail: "them@y.co",
      userId: "user-1",
    });

    expect(result).toBeNull();
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
  });

  it("host routing without a received-reply writer is harmless", async () => {
    const findReply = fakeReplyProvider();
    registerCapabilityProvider("@cinatra-ai/host:email-routing", {
      packageName: "@cinatra-ai/host",
      impl: {
        resolveConnectorId: async () => null,
        applyDevModeOverride: <M,>(msg: M): M => msg,
        // saveReceivedReplyObject intentionally absent (older host).
      },
    });

    const result = await findReplyInEmailThread({
      providerThreadId: "thread-9",
      recipientEmail: "them@y.co",
      userId: "user-1",
    });
    expect(result).toEqual(MATCH);
    expect(findReply).toHaveBeenCalled();
  });
});
