// cinatra#967 (W3 residue of #952/#953): proves `resolveWordPressBasicAuth`
// routes the WordPress instance credential read through the W2 owner-aware
// resolver — the instance's {orgId, runBy} binding is threaded to the gate
// BEFORE the raw Nango credential read, and a deny fails closed.

import { describe, expect, it, vi, beforeEach } from "vitest";

let CONFIG_STORE: Record<string, unknown> = {};

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(<T>(key: string, fallback: T): T => {
    return (CONFIG_STORE[key] as T) ?? fallback;
  }),
  writeConnectorConfigToDatabase: vi.fn((key: string, value: unknown) => {
    CONFIG_STORE[key] = value;
  }),
}));

vi.mock("@/lib/fetch-with-timeout", () => ({
  fetchWithTimeout: vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ([{ id: 1, title: { rendered: "Hello" }, status: "publish", date: "2026-01-01", link: "https://a.example.com/hello" }]),
  })),
}));

vi.mock("@/lib/nango-system", () => ({
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { wordpress: "cinatra-wordpress" },
  deleteNangoConnection: vi.fn(),
  getNangoConnection: vi.fn(async () => null),
  ensureNangoIntegration: vi.fn(async () => null),
  getNangoCredentials: vi.fn(async () => ({ username: "admin", password: "app-pass" })),
  importNangoConnection: vi.fn(async () => null),
  isNangoConfigured: vi.fn(() => true),
}));

const enforceInstanceConnectionUse = vi.fn(async (..._args: unknown[]) => null);
vi.mock("@/lib/instance-connection-actor", () => ({
  enforceInstanceConnectionUse: (...a: unknown[]) => enforceInstanceConnectionUse(...a),
  resolveOrSeedInstanceIdentity: vi.fn(async () => null),
}));

import { getNangoCredentials } from "@/lib/nango-system";
import { readLatestPublishedWordPressPost } from "@/lib/wordpress-api";

const instance = {
  id: "inst-1",
  name: "Site A",
  siteUrl: "https://a.example.com",
  username: "admin",
  applicationPassword: "app-pass",
  providerConfigKey: "cinatra-wordpress",
  connectionId: "conn-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  orgId: "org-1",
  runBy: "user-1",
};

beforeEach(() => {
  CONFIG_STORE = { wordpress: { instances: [], loggingEnabled: false } };
  vi.clearAllMocks();
  enforceInstanceConnectionUse.mockResolvedValue(null);
});

describe("resolveWordPressBasicAuth — cinatra#967 gating", () => {
  it("gates via enforceInstanceConnectionUse, threading the instance's {orgId, runBy} binding, BEFORE the raw credential read", async () => {
    const callOrder: string[] = [];
    enforceInstanceConnectionUse.mockImplementationOnce(async () => {
      callOrder.push("gate");
      return null;
    });
    vi.mocked(getNangoCredentials).mockImplementationOnce(async () => {
      callOrder.push("readback");
      return { username: "admin", password: "app-pass" };
    });

    await readLatestPublishedWordPressPost(instance);

    expect(enforceInstanceConnectionUse).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      connectionId: "conn-1",
      binding: { orgId: "org-1", runBy: "user-1" },
      source: "wordpress-api",
    });
    expect(callOrder).toEqual(["gate", "readback"]);
  });

  it("a denied gate propagates (fails closed) and never reaches the raw credential read", async () => {
    class Denied extends Error {}
    enforceInstanceConnectionUse.mockRejectedValueOnce(new Denied("denied"));

    await expect(readLatestPublishedWordPressPost(instance)).rejects.toThrow(Denied);
    expect(getNangoCredentials).not.toHaveBeenCalled();
  });

  it("an instance with no resolvable identity (gate returns null) still resolves credentials via the legacy path — never a regression", async () => {
    const result = await readLatestPublishedWordPressPost(instance);
    expect(getNangoCredentials).toHaveBeenCalledWith("cinatra-wordpress", "conn-1");
    expect(result?.apiResponse.id).toBe(1);
  });
});
