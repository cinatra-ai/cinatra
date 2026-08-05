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
// (allowed) or short-circuited via `redirect(...&error=...)` (blocked). Only the
// client FACTORY is mocked, so each case can reject the status probe with a
// specific error class; the real `classifyMarketplaceFailure` and the real SDK
// error classes stay in play, so the gate's discrimination is exercised
// faithfully rather than against a stub.
//
// cinatra#2218 L2b moved that discrimination from a v1-SDK class DENYLIST in the
// gate to an ALLOWLIST owned by the marketplace client
// (`classifyMarketplaceFailure`), atomically with the client's migration to
// `@modelcontextprotocol/client@2.0.0`.
//
// COVERAGE SPLIT — deliberate, not a gap. `@modelcontextprotocol/client` is a
// dependency of `packages/marketplace-mcp-client` ONLY; the app's root manifest
// does not (and after this change still must not) declare it, so this suite
// cannot construct `SdkHttpError` / `ProtocolError` / the auto-mode negotiation
// wrapper. The split is:
//
//   * `packages/marketplace-mcp-client/tests/http-client.test.ts` owns
//     CLASS -> ORIGIN fidelity against the REAL v2 error classes, including the
//     auto-mode wrapper and the counterfactual proof that the pre-migration
//     denylist now fails OPEN on `SdkHttpError` / `ProtocolError`.
//   * `packages/marketplace-mcp-client/tests/failure-origin-transport.test.ts`
//     owns the same fidelity against the REAL transport on a local socket —
//     notably the connect-failure vs mid-body-failure split, which cannot be
//     shown by constructing an error class because both are `TypeError`.
//   * THIS suite owns ORIGIN -> GATE OUTCOME, end to end through the real
//     (un-stubbed) classifier, using failures it can construct without the SDK:
//     a branded `TypeError` (unreachable), an UNBRANDED one (indeterminate), a
//     `MarketplaceMcpError` (peer-response), and the measured plain-`Error`
//     escapes.
//
// Composed, the two cover gate -> classifier -> outcome for every migrated class.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MARKETPLACE_CONNECT_FAILURE,
  MarketplaceMcpError,
} from "@cinatra-ai/marketplace-mcp-client";

/**
 * Stamp the brand the marketplace client puts on an error thrown by the
 * `fetch()` call ITSELF. The brand — not the error class — is what
 * `classifyMarketplaceFailure` accepts as proof that no HTTP response arrived:
 * `TypeError` alone is ambiguous, because undici also raises it (`terminated`)
 * when a response WAS received and its body stream then died.
 */
function asConnectFailure<T extends object>(err: T): T {
  Object.defineProperty(err, MARKETPLACE_CONNECT_FAILURE, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return err;
}

vi.mock("@/lib/instance-identity-store", () => {
  const readInstanceIdentity = vi.fn();
  const writeInstanceIdentity = vi.fn();
  // provisionAndPersist's final write flows through a row-level-CAS wrapper
  // (`applyInstanceIdentityProvisioningWrite`)
  // instead of a plain writeInstanceIdentity call. This suite asserts on the
  // FINAL persisted identity shape via writeInstanceIdentity, not the CAS
  // mechanism itself, so this mock shims the wrapper to delegate to that same
  // sink (re-read the current identity, apply the caller's write fields,
  // append oldInstanceNamespaces when requested, persist) — mirrors the
  // convention already used for `updateInstanceIdentityRegistries` in the
  // sibling network/poll-job test suites (cinatra#850) and for
  // `applyInstanceIdentityProvisioningWrite` itself in
  // `rename-instance-namespace-action.test.ts`. The real CAS engine is
  // unit-tested directly in `src/lib/__tests__/instance-identity-cas.test.ts`.
  const applyInstanceIdentityProvisioningWrite = vi.fn(
    (
      write: {
        instanceNamespace: string;
        tokenCiphertext: string;
        tokenIv: string;
        tokenAlgo: "aes-256-gcm";
        passwordCiphertext: string;
        passwordIv: string;
      },
      opts: { appendPreviousNamespace: boolean },
    ) => {
      const latest = readInstanceIdentity() as
        | (typeof write & {
            oldInstanceNamespaces?: unknown[];
            [key: string]: unknown;
          })
        | null
        | undefined;
      const merged: Record<string, unknown> = {
        ...latest,
        ...write,
        firstPublishedAt: null,
      };
      if (opts.appendPreviousNamespace && latest) {
        merged.oldInstanceNamespaces = [
          ...(latest.oldInstanceNamespaces ?? []),
          {
            name: latest.instanceNamespace,
            frozenAt: new Date().toISOString(),
            lastTokenCiphertext: latest.tokenCiphertext ?? "",
            lastTokenIv: latest.tokenIv ?? "",
          },
        ];
      }
      writeInstanceIdentity(merged, { allowNamespaceRename: true });
      return "swapped";
    },
  );
  return {
    readInstanceIdentity,
    writeInstanceIdentity,
    applyInstanceIdentityProvisioningWrite,
  };
});
vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));
// Pending-provision stash (minted-credential reuse across a write conflict) —
// empty here so every run takes the fresh-mint path; the reuse behaviour has
// its own suite (rename-pending-provision-reuse.test.ts).
vi.mock("@/lib/instance-identity-pending-provision", () => ({
  readPendingProvisionedCredentials: vi.fn(() => null),
  writePendingProvisionedCredentials: vi.fn(),
  clearPendingProvisionedCredentials: vi.fn(),
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
//
// ONLY the factory is replaced. `classifyMarketplaceFailure` is re-exported from
// the REAL module, because it is the thing under test here — stubbing it would
// make every assertion below vacuous.
const vendorApplicationStatusMock = vi.fn();
vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@cinatra-ai/marketplace-mcp-client/http-client")>();
  return {
    ...actual,
    createHttpMarketplaceMcpClient: vi.fn(() => ({
      vendorApplicationStatus: vendorApplicationStatusMock,
    })),
  };
});

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
    // A connect failure: undici's TypeError, branded by the client's fetch
    // wrapper at the moment the call rejected.
    vendorApplicationStatusMock.mockRejectedValue(
      asConnectFailure(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      ),
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
  it("blocks on a MarketplaceMcpError (structured marketplace error)", async () => {
    vendorApplicationStatusMock.mockRejectedValue(
      new MarketplaceMcpError("bad gateway", 502, ""),
    );

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The allowlist inversion (cinatra#2218 L2b). The pre-migration gate enumerated
// the classes that meant "answered" and fell through to fail-OPEN on everything
// else. These three were MEASURED escaping a real connect/callTool cycle against
// a REACHABLE peer and were in no enumerated tree, so each one could relax the
// rename gate on a local instance before this change.
// ---------------------------------------------------------------------------
describe("namespace rename — fails CLOSED on a failure that cannot be PROVEN unreachable", () => {
  it("blocks on a SyntaxError (reachable peer, malformed 200 body)", async () => {
    vendorApplicationStatusMock.mockRejectedValue(
      new SyntaxError("Unexpected token n in JSON at position 1"),
    );

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("blocks on an insufficient_scope refusal (reachable peer, HTTP 403 challenge)", async () => {
    const insufficientScope = new Error('Insufficient scope: required "mcp:connect"');
    insufficientScope.name = "InsufficientScopeError";
    vendorApplicationStatusMock.mockRejectedValue(insufficientScope);

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("blocks on an unsupported negotiated revision (reachable peer, plain Error)", async () => {
    vendorApplicationStatusMock.mockRejectedValue(
      new Error("Server's protocol version is not supported: 1999-01-01"),
    );

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("blocks on an UNBRANDED TypeError — a response arrived and its body then died", async () => {
    // `TypeError: terminated` is what undici raises AFTER a real HTTP 200 whose
    // body stream fails. It is the same CLASS as a connect failure, from a
    // demonstrably reachable marketplace: the pre-fix rule (`instanceof
    // TypeError` as proof of unreachability) failed OPEN here.
    vendorApplicationStatusMock.mockRejectedValue(new TypeError("terminated"));

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("blocks on a thrown non-Error (nothing to classify)", async () => {
    vendorApplicationStatusMock.mockRejectedValue("fetch failed");

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
    vendorApplicationStatusMock.mockRejectedValue(asConnectFailure(new TypeError("fetch failed")));

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("blocks an unreachable-marketplace rename when only a vendorApplicationId is recorded", async () => {
    vi.mocked(readInstanceIdentity).mockReturnValue({
      ...LOCAL_FROZEN_IDENTITY,
      vendorApplicationId: "app_456",
    });
    vendorApplicationStatusMock.mockRejectedValue(asConnectFailure(new TypeError("fetch failed")));

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });
});

describe("namespace rename — hosted/governed instance never fails OPEN", () => {
  it("blocks an unreachable-marketplace rename in production (NODE_ENV=production)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vendorApplicationStatusMock.mockRejectedValue(asConnectFailure(new TypeError("fetch failed")));

    await runRename("newlocalvendor");

    expect(wasBlockedWithError()).toBe(true);
    expect(vi.mocked(writeInstanceIdentity)).not.toHaveBeenCalled();
  });

  it("blocks an unreachable-marketplace rename when MARKETPLACE_BASE_URL is configured", async () => {
    vi.stubEnv("MARKETPLACE_BASE_URL", "https://marketplace.example.com");
    vendorApplicationStatusMock.mockRejectedValue(asConnectFailure(new TypeError("fetch failed")));

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
