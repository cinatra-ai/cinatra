// Regression tests for cinatra#396 — local/self-hosted instance namespace rename
// must NOT be permanently blocked when the Cinatra Marketplace is unreachable,
// while a hosted/governed instance still fails CLOSED on a real
// vendor-application denial or a reachable marketplace error.
//
// The rename gate (`assertNamespaceRenameAllowed` in
// `src/app/configuration/instance/actions.ts`) probes vendor-application status
// via the marketplace MCP client. Before #396 it failed CLOSED on ANY error,
// permanently pausing the rename on an offline local box. The fix fails OPEN
// only for a genuine local/offline instance with no recorded reservation.
//
// These tests drive the PUBLIC action (`renameInstanceNamespaceAction`) and
// observe whether the gate let the rename through to `writeInstanceIdentity`
// (allowed) or short-circuited via `redirect(...&error=...)` (blocked). The
// marketplace MCP client is mocked so each case can reject the status probe
// with a specific error class; the SDK error classes themselves stay REAL so
// the `instanceof` discrimination in the fix is exercised faithfully.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { MarketplaceMcpError } from "@cinatra-ai/marketplace-mcp-client";

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(),
  writeInstanceIdentity: vi.fn(),
}));
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({
    user: { id: "admin-1", email: "admin@example.com" },
  })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Configurable marketplace MCP client: each test sets what the status probe
// does (reject with a chosen error, or resolve to a non-locking state).
const vendorApplicationStatusMock = vi.fn();
vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", () => ({
  createHttpMarketplaceMcpClient: vi.fn(() => ({
    vendorApplicationStatus: vendorApplicationStatusMock,
  })),
}));

import { renameInstanceNamespaceAction } from "@/app/configuration/instance/actions";
import {
  readInstanceIdentity,
  writeInstanceIdentity,
  type InstanceIdentity,
} from "@/lib/instance-identity-store";
import { redirect } from "next/navigation";
// Real encryption — vitest sets a valid CINATRA_ENCRYPTION_KEY, so the rename
// gate can resolve+decrypt a genuine vendor token from the identity row.
import { encryptSecret } from "@/lib/instance-secrets";

const TOKEN_ENC = encryptSecret("local-vendor-token", "vendor.token");
const PASSWORD_ENC = encryptSecret("local-vendor-password", "vendor.password");

// A frozen LOCAL instance identity with a usable vendor token but NO recorded
// vendor reservation (vendorState/vendorApplicationId absent) — the #396 setup.
const LOCAL_FROZEN_IDENTITY: InstanceIdentity = {
  instanceNamespace: "localvendor",
  instanceDisplayName: "Local Vendor",
  tokenCiphertext: TOKEN_ENC.ciphertext,
  tokenIv: TOKEN_ENC.iv,
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: PASSWORD_ENC.ciphertext,
  passwordIv: PASSWORD_ENC.iv,
  registryUrl: "https://registry.cinatra.ai",
  firstPublishedAt: "2026-04-01T00:00:00.000Z",
  createdAt: "2026-03-01T00:00:00.000Z",
};

function renameFormData(newName: string): FormData {
  const fd = new FormData();
  fd.append("instanceNamespace", newName);
  fd.append("instanceDisplayName", "Local Vendor");
  return fd;
}

// Drives the rename action, tolerating the control-flow throw that
// redirectWithError raises after calling the mocked next/navigation `redirect`
// (in production `redirect` throws its own NEXT_REDIRECT first; the mock is a
// no-op, so the "unreachable" guard surfaces here). Either outcome is fine —
// what matters is the observable redirect/write state asserted afterward.
async function runRename(newName: string): Promise<void> {
  try {
    await renameInstanceNamespaceAction(renameFormData(newName));
  } catch {
    // swallow the redirect control-flow / unreachable guard throw
  }
}

// True when the action short-circuited via redirectWithError (rename blocked).
function wasBlockedWithError(): boolean {
  return vi
    .mocked(redirect)
    .mock.calls.some(([url]) => typeof url === "string" && url.includes("&error="));
}

// True when the action redirected to the success state (rename allowed).
function wasSaved(): boolean {
  return vi
    .mocked(redirect)
    .mock.calls.some(([url]) => typeof url === "string" && url.includes("saved=1"));
}

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  // Local/offline, non-production, no marketplace override — the #396 baseline.
  // vi.stubEnv mutates process.env safely (NODE_ENV is a read-only literal type
  // otherwise) and is reverted by vi.unstubAllEnvs() in afterEach.
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MARKETPLACE_BASE_URL", "");
  // Verdaccio adduser succeeds so a rename that PASSES the gate reaches
  // writeInstanceIdentity (and isn't blocked by a later provisioning failure).
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ token: "fresh-token" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
  vi.mocked(readInstanceIdentity).mockReturnValue(LOCAL_FROZEN_IDENTITY);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("namespace rename — offline LOCAL instance fails OPEN (cinatra#396)", () => {
  it("allows the rename when the marketplace is genuinely unreachable (raw network error)", async () => {
    // A connect/transport failure surfaces as a raw Error (undici TypeError, DNS,
    // ECONNREFUSED, …), NOT a MarketplaceMcpError/SDK error.
    vendorApplicationStatusMock.mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(false);
    expect(wasSaved()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeInstanceIdentity).mock.calls[0]?.[0]?.instanceNamespace).toBe(
      "newlocalvendor",
    );
  });
});

describe("namespace rename — still fails CLOSED when the marketplace ANSWERED", () => {
  it("blocks on a StreamableHTTPError (reachable 503 — marketplace transiently erroring, not unreachable)", async () => {
    vendorApplicationStatusMock.mockRejectedValue(
      new StreamableHTTPError(503, "Error POSTing to endpoint: service unavailable"),
    );

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("blocks on an McpError (reachable JSON-RPC error)", async () => {
    vendorApplicationStatusMock.mockRejectedValue(new McpError(-32603, "internal error"));

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("blocks on a MarketplaceMcpError (structured marketplace error)", async () => {
    vendorApplicationStatusMock.mockRejectedValue(
      new MarketplaceMcpError("bad gateway", 502, ""),
    );

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });
});

describe("namespace rename — fails CLOSED when a reservation could be orphaned", () => {
  it("blocks an unreachable-marketplace rename when the LOCAL row records an applied reservation", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue({
      ...LOCAL_FROZEN_IDENTITY,
      vendorState: "applied",
      vendorApplicationId: "app_123",
    });
    vendorApplicationStatusMock.mockRejectedValue(new TypeError("fetch failed"));

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("blocks an unreachable-marketplace rename when only a vendorApplicationId is recorded", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue({
      ...LOCAL_FROZEN_IDENTITY,
      vendorApplicationId: "app_456",
    });
    vendorApplicationStatusMock.mockRejectedValue(new TypeError("fetch failed"));

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });
});

describe("namespace rename — hosted/governed instance never fails OPEN", () => {
  it("blocks an unreachable-marketplace rename in production (NODE_ENV=production)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vendorApplicationStatusMock.mockRejectedValue(new TypeError("fetch failed"));

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("blocks an unreachable-marketplace rename when MARKETPLACE_BASE_URL is configured", async () => {
    vi.stubEnv("MARKETPLACE_BASE_URL", "https://marketplace.example.com");
    vendorApplicationStatusMock.mockRejectedValue(new TypeError("fetch failed"));

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });
});

describe("namespace rename — definitive vendor-application denial still blocks", () => {
  it("blocks when the marketplace returns an 'approved' reservation (reachable, definitive)", async () => {
    vendorApplicationStatusMock.mockResolvedValue({ state: "approved" });

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("allows when the marketplace returns a non-locking state (reachable, none)", async () => {
    vendorApplicationStatusMock.mockResolvedValue({ state: "none" });

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(false);
    expect(wasSaved()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).toHaveBeenCalledTimes(1);
  });
});
