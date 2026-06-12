// #180 PR-2: the batch grant context — `resolveGatekeptInstallConfig` DERIVES
// member resolutions from the ROOT grant inside a batch (per-member authorize
// is structurally impossible), and the P2-5 refresh seam fails closed until
// the marketplace ability ships.
import { describe, expect, it, vi } from "vitest";

import {
  resolveGatekeptInstallConfig,
  refreshGatekeptInstallGrant,
  computeClosureHash,
  GrantRefreshUnavailableError,
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

describe("refreshGatekeptInstallGrant (P2-5 — marketplace ability not yet live)", () => {
  it("fails CLOSED with GrantRefreshUnavailableError naming the root and the compensation consequence", async () => {
    try {
      await refreshGatekeptInstallGrant(rootResolution(), {
        packageName: ROOT,
        version: "2.0.0",
        closureHash: computeClosureHash(rootResolution().authorize.closure),
      });
      expect.unreachable("must fail closed");
    } catch (e) {
      expect(e).toBeInstanceOf(GrantRefreshUnavailableError);
      expect((e as Error).message).toContain(`${ROOT}@2.0.0`);
      expect((e as Error).message).toContain("compensated");
    }
  });
});
