// #180 PR-2 / #162: the batch grant context — `resolveGatekeptInstallConfig`
// DERIVES member resolutions from the ROOT grant inside a batch (per-member
// authorize is structurally impossible), and the P2-5 refresh seam calls the
// LIVE marketplace ability, mapping epoch-seconds → ISO, preserving kind, and
// failing closed on drift / refusal / unparseable expiry.
import { describe, expect, it, vi } from "vitest";

import {
  resolveGatekeptInstallConfig,
  refreshGatekeptInstallGrant,
  computeClosureHash,
  GrantRefreshUnavailableError,
  GrantRefreshRefusedError,
  type GatekeptInstallResolution,
} from "@/lib/gatekept-install";
import {
  withInstallGrantContext,
  deriveMemberInstallConfig,
} from "@/lib/extension-install-grant-context";

// The injectable client param's type, derived WITHOUT importing the banned
// vendored marketplace-mcp-client package.
type MarketplaceMcpClient = NonNullable<Parameters<typeof resolveGatekeptInstallConfig>[2]>;

const ROOT = "@cinatra-ai/root";

function rootResolution(): GatekeptInstallResolution {
  return {
    config: {
      registryUrl: "https://broker.example/install",
      packageScope: "@cinatra-ai",
      token: "opaque-root-grant",
      uiUrl: null,
    },
    authorize: {
      kind: "agent",
      resolvedVersion: "2.0.0",
      closure: [{ name: "@cinatra-ai/member", version: "1.1.0" }],
      expiresAt: "2026-06-12T23:59:59Z",
    },
  };
}

function ctx(memberKinds = new Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">()) {
  return { rootPackageName: ROOT, resolution: rootResolution(), memberKinds };
}

/** A marketplace client whose authorize MUST NOT be reached inside a context. */
function forbiddenClient(): MarketplaceMcpClient {
  return {
    extensionInstallAuthorize: vi.fn(async () => {
      throw new Error("FORBIDDEN: authorize called inside an active batch grant context");
    }),
    extensionGet: vi.fn(async () => {
      throw new Error("FORBIDDEN: extensionGet called inside an active batch grant context");
    }),
  } as unknown as MarketplaceMcpClient;
}

/**
 * A marketplace client stub exposing ONLY `extensionInstallGrantRefresh`, for
 * the refresh-seam tests. `refresh` is invoked with the presented-grant input.
 */
function refreshClient(
  refresh: (input: { grant: string }) => Promise<unknown>,
): MarketplaceMcpClient {
  return {
    extensionInstallGrantRefresh: vi.fn(refresh),
  } as unknown as MarketplaceMcpClient;
}

describe("resolveGatekeptInstallConfig under the batch grant context", () => {
  it("ROOT reads reuse the root resolution verbatim — NO authorize call", async () => {
    const client = forbiddenClient();
    const res = await withInstallGrantContext(ctx(), () =>
      resolveGatekeptInstallConfig(ROOT, "2.0.0", client),
    );
    expect(res.config.token).toBe("opaque-root-grant");
    expect(res.authorize.resolvedVersion).toBe("2.0.0");
    expect(client.extensionInstallAuthorize).not.toHaveBeenCalled();
  });

  it("MEMBER reads derive the broker config from the ROOT grant (same token/base, member scope, member pin + kind) — NO authorize call", async () => {
    const client = forbiddenClient();
    const kinds = new Map<string, "agent" | "skill" | "connector" | "artifact" | "workflow">([
      ["@cinatra-ai/member", "connector"],
    ]);
    const res = await withInstallGrantContext(ctx(kinds), () =>
      resolveGatekeptInstallConfig("@cinatra-ai/member", "1.1.0", client),
    );
    expect(res.config).toEqual({
      registryUrl: "https://broker.example/install",
      packageScope: "@cinatra-ai",
      token: "opaque-root-grant",
      uiUrl: null,
    });
    expect(res.authorize.resolvedVersion).toBe("1.1.0");
    expect(res.authorize.kind).toBe("connector"); // the MEMBER's kind, not the root's
    expect(client.extensionInstallAuthorize).not.toHaveBeenCalled();
  });

  it("a package OUTSIDE the authorized closure is an AUTHORIZATION MISMATCH — fail-loud, never a fresh authorize", async () => {
    const client = forbiddenClient();
    await expect(
      withInstallGrantContext(ctx(), () =>
        resolveGatekeptInstallConfig("@cinatra-ai/not-in-closure", "1.0.0", client),
      ),
    ).rejects.toThrow(/not a member of the authorized closure/);
    expect(client.extensionInstallAuthorize).not.toHaveBeenCalled();
  });

  it("version drift against the closure pin (member) or authorized version (root) is refused", async () => {
    const client = forbiddenClient();
    await expect(
      withInstallGrantContext(ctx(), () =>
        resolveGatekeptInstallConfig("@cinatra-ai/member", "9.9.9", client),
      ),
    ).rejects.toThrow(/pinned at 1\.1\.0/);
    await expect(
      withInstallGrantContext(ctx(), () => resolveGatekeptInstallConfig(ROOT, "9.9.9", client)),
    ).rejects.toThrow(/authorizes @cinatra-ai\/root@2\.0\.0/);
  });

  it("'latest'/empty version requests inside the context resolve to the pinned versions (no extensionGet round-trip)", async () => {
    const client = forbiddenClient();
    const res = await withInstallGrantContext(ctx(), () =>
      resolveGatekeptInstallConfig("@cinatra-ai/member", "latest", client),
    );
    expect(res.authorize.resolvedVersion).toBe("1.1.0");
    expect(client.extensionGet).not.toHaveBeenCalled();
  });
});

describe("deriveMemberInstallConfig", () => {
  it("is pure: broker base + root grant + the member's own scope", () => {
    const cfg = deriveMemberInstallConfig(rootResolution(), "@other-vendor/pkg");
    expect(cfg).toEqual({
      registryUrl: "https://broker.example/install",
      packageScope: "@other-vendor",
      token: "opaque-root-grant",
      uiUrl: null,
    });
  });
});

describe("computeClosureHash (P2-5 binding basis)", () => {
  it("is deterministic and ORDER-INSENSITIVE over name@version (the binding the refresh ability cross-checks)", () => {
    const a = computeClosureHash([
      { name: "@cinatra-ai/x", version: "1.0.0" },
      { name: "@cinatra-ai/y", version: "2.0.0" },
    ]);
    const b = computeClosureHash([
      { name: "@cinatra-ai/y", version: "2.0.0" },
      { name: "@cinatra-ai/x", version: "1.0.0" },
    ]);
    expect(a).toBe(b);
    const c = computeClosureHash([{ name: "@cinatra-ai/x", version: "1.0.1" }]);
    expect(c).not.toBe(a);
  });
});

describe("refreshGatekeptInstallGrant (P2-5 — calls the LIVE marketplace ability)", () => {
  const CLOSURE_HASH = computeClosureHash(rootResolution().authorize.closure);
  const rootBinding = { packageName: ROOT, version: "2.0.0", closureHash: CLOSURE_HASH };

  /** A well-formed refreshed-output factory (epoch SECONDS expiry, same closure). */
  function refreshedOut(over: Partial<Record<string, unknown>> = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      grant: "opaque-refreshed-grant",
      resolved_version: "2.0.0",
      broker_base_url: "https://broker.example/install",
      closure: [{ name: "@cinatra-ai/member", version: "1.1.0" }],
      expires_at: nowSec + 3600,
      closure_hash: CLOSURE_HASH,
      op: "op-123",
      ...over,
    };
  }

  it("SUCCESS: maps epoch-seconds expiry → ISO, preserves kind, presents the CURRENT grant, returns the new token/broker", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const client = refreshClient(async () => refreshedOut({ expires_at: nowSec + 3600 }));
    const res = await refreshGatekeptInstallGrant(rootResolution(), rootBinding, client);

    // Presented the CURRENT opaque grant (config.token), not anything decoded.
    expect(client.extensionInstallGrantRefresh).toHaveBeenCalledWith({
      grant: "opaque-root-grant",
    });
    // New token + broker mapped into the resolution.
    expect(res.config.token).toBe("opaque-refreshed-grant");
    expect(res.config.registryUrl).toBe("https://broker.example/install");
    expect(res.config.packageScope).toBe("@cinatra-ai"); // root scope preserved
    // kind preserved from the CURRENT authorize metadata (refresh has no kind).
    expect(res.authorize.kind).toBe("agent");
    expect(res.authorize.resolvedVersion).toBe("2.0.0");
    // expires_at converted to an ISO string the saga's Date.parse can read.
    expect(typeof res.authorize.expiresAt).toBe("string");
    expect(Number.isNaN(Date.parse(res.authorize.expiresAt))).toBe(false);
    expect(Date.parse(res.authorize.expiresAt)).toBe((nowSec + 3600) * 1000);
  });

  it("CLOSURE drift (different closure array) is REFUSED (GrantRefreshRefusedError)", async () => {
    const client = refreshClient(async () =>
      refreshedOut({
        closure: [{ name: "@cinatra-ai/member", version: "9.9.9" }],
        // The server even reports a matching hash for its (drifted) closure —
        // the host still refuses because it ≠ the AUTHORIZED closure's hash.
        closure_hash: computeClosureHash([{ name: "@cinatra-ai/member", version: "9.9.9" }]),
      }),
    );
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), rootBinding, client),
    ).rejects.toBeInstanceOf(GrantRefreshRefusedError);
  });

  it("ROOT-VERSION drift (same closure, different resolved_version) is REFUSED", async () => {
    const client = refreshClient(async () => refreshedOut({ resolved_version: "3.0.0" }));
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), rootBinding, client),
    ).rejects.toBeInstanceOf(GrantRefreshRefusedError);
  });

  it("server closure_hash mismatch (closure array OK) is REFUSED", async () => {
    const client = refreshClient(async () => refreshedOut({ closure_hash: "deadbeef" }));
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), rootBinding, client),
    ).rejects.toBeInstanceOf(GrantRefreshRefusedError);
  });

  it("a requested binding hash that does not describe the current closure is REFUSED (no call to the market)", async () => {
    const refreshFn = vi.fn(async () => refreshedOut());
    const client = refreshClient(refreshFn);
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), { ...rootBinding, closureHash: "wrong" }, client),
    ).rejects.toBeInstanceOf(GrantRefreshRefusedError);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 1.5],
    ["NaN", Number.NaN],
  ])("invalid expiry (%s) FAILS CLOSED with GrantRefreshUnavailableError", async (_label, bad) => {
    const client = refreshClient(async () => refreshedOut({ expires_at: bad }));
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), rootBinding, client),
    ).rejects.toBeInstanceOf(GrantRefreshUnavailableError);
  });

  it("an expiry already inside the near-expiry margin FAILS CLOSED (refuses a stale grant)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const client = refreshClient(async () => refreshedOut({ expires_at: nowSec + 1 }));
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), rootBinding, client),
    ).rejects.toBeInstanceOf(GrantRefreshUnavailableError);
  });

  it("a MILLISECOND-shaped expires_at FAILS CLOSED (implausibly far-future after *1000)", async () => {
    // A ms epoch (~1.78e12) re-multiplied by 1000 lands ~50,000 years out.
    const client = refreshClient(async () => refreshedOut({ expires_at: Date.now() }));
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), rootBinding, client),
    ).rejects.toBeInstanceOf(GrantRefreshUnavailableError);
  });

  it("a refresh that echoes the SAME grant back is REFUSED (re-mint invariant)", async () => {
    const client = refreshClient(async () => refreshedOut({ grant: "opaque-root-grant" }));
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), rootBinding, client),
    ).rejects.toBeInstanceOf(GrantRefreshRefusedError);
  });

  it("a malformed (non-array) closure FAILS CLOSED with GrantRefreshUnavailableError (not a raw TypeError)", async () => {
    const client = refreshClient(async () =>
      refreshedOut({ closure: null as unknown as [] }),
    );
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), rootBinding, client),
    ).rejects.toBeInstanceOf(GrantRefreshUnavailableError);
  });

  it.each([
    ["grant", ""],
    ["broker_base_url", ""],
    ["resolved_version", ""],
    ["op", ""],
  ])("a missing/empty %s FAILS CLOSED with GrantRefreshUnavailableError", async (field, value) => {
    // resolved_version must stay valid for the version check to be reached; when
    // testing resolved_version itself an empty string trips the required-string
    // guard first, which is the intended fail-closed.
    const client = refreshClient(async () => refreshedOut({ [field]: value }));
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), rootBinding, client),
    ).rejects.toBeInstanceOf(GrantRefreshUnavailableError);
  });

  it("a non-MCP transport throw is UNAVAILABLE", async () => {
    const client = refreshClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      refreshGatekeptInstallGrant(rootResolution(), rootBinding, client),
    ).rejects.toBeInstanceOf(GrantRefreshUnavailableError);
  });

  // NOTE: the marketplace-error status-class mapping (409/429/403 → refused,
  // 503 → unavailable) is exercised in gatekept-install.test.ts, which is the
  // allowlisted call site for the vendored MarketplaceMcpError type (this file
  // deliberately avoids importing the vendored package — see the
  // marketplace-mcp-client-banned regression guard).
});
