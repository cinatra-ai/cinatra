// Transport-registration cutover: email-system dispatches over the `email-send` capability registry —
// no provider package import, no hardcoded connector-id branch. These tests
// drive the REAL capability registry with fake providers and verify:
//   - the per-user surfaces only consider `connectionScope: "user"` providers
//     (an instance transport is never auto-picked as a personal mailbox);
//   - send/findReply route through the resolved provider impl;
//   - platform mail dispatches on the purpose-routed provider directly and
//     applies the shared host routing override when present.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

const configStore = new Map<string, unknown>();
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(<T,>(key: string, fallback: T): T => {
    return (configStore.has(key) ? configStore.get(key) : fallback) as T;
  }),
  writeConnectorConfigToDatabase: vi.fn((key: string, value: unknown) => {
    configStore.set(key, value);
  }),
}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  listInstalledEmailConnectorStatuses,
  getActiveEmailConnectorStatus,
  sendEmailThroughSystem,
  findReplyInEmailThread,
  listEmailProvidersWithStatus,
  sendPlatformEmail,
} from "@/lib/email-system";

type FakeOpts = {
  connectionScope?: "user" | "instance";
  supportsSystemEmail?: boolean;
  status?: "connected" | "incomplete" | "not_connected";
};

function fakeProvider(id: string, opts: FakeOpts = {}) {
  const send = vi.fn(async () => ({
    providerId: id,
    providerMessageId: `${id}-msg-1`,
    sentAt: new Date().toISOString(),
  }));
  const findReply = vi.fn(async () => null);
  const provider = {
    definition: {
      connectorId: id,
      name: id,
      slug: id,
      description: "",
      settingsHref: `/connectors/${id}`,
      ...(opts.connectionScope ? { connectionScope: opts.connectionScope } : {}),
      ...(opts.supportsSystemEmail !== undefined
        ? { supportsSystemEmail: opts.supportsSystemEmail }
        : {}),
    },
    send,
    findReply,
    getStatus: vi.fn(async () => ({ status: opts.status ?? "connected" })),
  };
  registerCapabilityProvider("email-send", { packageName: `@v/${id}-connector`, impl: provider });
  return provider;
}

beforeEach(() => {
  __resetCapabilityRegistry();
  configStore.clear();
});

describe("per-user surfaces (connectionScope dispatch)", () => {
  it("lists ONLY connectionScope:'user' providers", async () => {
    fakeProvider("gmailish", { connectionScope: "user" });
    fakeProvider("resendish", { connectionScope: "instance", supportsSystemEmail: true });
    const statuses = await listInstalledEmailConnectorStatuses({ userId: "user-1" });
    expect(statuses.map((s) => s.connectorId)).toEqual(["gmailish"]);
  });

  it("an instance transport is never auto-picked as the active per-user connector", async () => {
    fakeProvider("resendish", { connectionScope: "instance", status: "connected" });
    expect(await getActiveEmailConnectorStatus({ userId: "user-1" })).toBeNull();
  });

  it("sendEmailThroughSystem routes through the active per-user provider impl", async () => {
    const gmailish = fakeProvider("gmailish", { connectionScope: "user" });
    const receipt = await sendEmailThroughSystem(
      { to: ["a@b.c"], subject: "s", textBody: "t" },
      { userId: "user-1" },
    );
    expect(receipt.providerId).toBe("gmailish");
    expect(gmailish.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["a@b.c"] }),
      { userId: "user-1" },
    );
  });

  it("findReplyInEmailThread routes through the active per-user provider impl", async () => {
    const gmailish = fakeProvider("gmailish", { connectionScope: "user" });
    await findReplyInEmailThread({
      providerThreadId: "t-1",
      recipientEmail: "a@b.c",
      userId: "user-1",
    });
    expect(gmailish.findReply).toHaveBeenCalledWith(
      expect.objectContaining({ providerThreadId: "t-1", recipientEmail: "a@b.c" }),
    );
  });

  it("throws the unchanged no-connector error when nothing per-user is connected", async () => {
    await expect(
      sendEmailThroughSystem({ to: ["a@b.c"], subject: "s", textBody: "t" }, { userId: "user-1" }),
    ).rejects.toThrow("No connected email connector is available.");
  });
});

describe("instance-level provider hub + platform mail", () => {
  it("listEmailProvidersWithStatus lists EVERY registered provider", async () => {
    fakeProvider("gmailish", { connectionScope: "user" });
    fakeProvider("resendish", { connectionScope: "instance", supportsSystemEmail: true });
    const all = await listEmailProvidersWithStatus();
    expect(all.map((p) => p.connectorId).sort()).toEqual(["gmailish", "resendish"]);
  });

  it("sendPlatformEmail dispatches on the single connected supportsSystemEmail provider", async () => {
    fakeProvider("gmailish", { connectionScope: "user" }); // not system-capable
    const resendish = fakeProvider("resendish", {
      connectionScope: "instance",
      supportsSystemEmail: true,
    });
    const receipt = await sendPlatformEmail({ to: "a@b.c", subject: "s", text: "t" });
    expect(receipt.providerId).toBe("resendish");
    expect(resendish.send).toHaveBeenCalled();
  });

  it("sendPlatformEmail applies the shared host routing dev-mode override when registered", async () => {
    const resendish = fakeProvider("resendish", {
      connectionScope: "instance",
      supportsSystemEmail: true,
    });
    registerCapabilityProvider("@cinatra-ai/host:email-routing", {
      packageName: "@cinatra-ai/host",
      impl: {
        resolveConnectorId: async () => null,
        applyDevModeOverride: <M extends { to: string[] }>(msg: M): M => ({
          ...msg,
          to: ["override@dev.local"],
        }),
      },
    });
    await sendPlatformEmail({ to: "a@b.c", subject: "s", text: "t" });
    expect(resendish.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["override@dev.local"] }),
    );
  });

  it("sendPlatformEmail fails loud when no provider is eligible", async () => {
    fakeProvider("gmailish", { connectionScope: "user" });
    await expect(sendPlatformEmail({ to: "a@b.c", subject: "s", text: "t" })).rejects.toThrow(
      /No connected email provider is assigned to platform mail/,
    );
  });
});
