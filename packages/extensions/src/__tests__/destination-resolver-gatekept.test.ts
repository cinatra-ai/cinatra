// Gatekept-install coverage for resolveInstallEnvironment.
//
// Flag OFF  → behavior EXACTLY unchanged (legacy public/private path; the
//             deployment-wide publicReadToken is used; no authorize call).
// Flag ON   → the public path is replaced by a broker-pointed environment whose
//             registryUrl is the broker base URL and whose _authToken arg is the
//             OPAQUE install grant (NOT the deployment read token).
//
// The gatekept resolver + flag are injected via the `options` seam so the test
// never touches the marketplace HTTP client.

import { describe, it, expect, vi, afterEach } from "vitest";
import type { VerdaccioConfig } from "@cinatra-ai/registries";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/extension-destinations-store", () => ({
  readDestinationCredential: vi.fn(() => Promise.resolve(null)),
  writeDestinationCredential: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
}));

vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: vi.fn(() => ({ ciphertext: "x", iv: "y" })),
  decryptSecret: vi.fn(({ ciphertext }: { ciphertext: string }) => ciphertext),
}));

vi.mock("pg", () => {
  class MockPool {
    on() {}
    query() {}
    connect() {}
    end() {}
  }
  return { Pool: MockPool };
});

vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentTemplateOrigin: vi.fn(async () => null), // null = public (grandfathered)
  updateAgentTemplateOrigin: vi.fn(async () => {}),
}));

const BROKER_URL = "https://marketplace.cinatra.ai/install/v1";

function brokerConfig(grant: string): VerdaccioConfig {
  return { registryUrl: BROKER_URL, packageScope: "@scope", token: grant, uiUrl: null };
}

describe("resolveInstallEnvironment — gatekept install", () => {
  afterEach(() => {
    vi.resetModules();
  });

  // ---------------------------------------------------------------------------
  // Flag OFF — legacy path is exactly unchanged.
  // ---------------------------------------------------------------------------
  it("flag OFF: returns the legacy public-registry environment, never calling the gatekept resolver", async () => {
    const resolveGatekept = vi.fn();
    const { resolveInstallEnvironment } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    const result = await resolveInstallEnvironment("@scope/ext", "1.2.3", {
      isGatekeptInstallEnabled: () => false,
      resolveGatekeptInstallConfig: resolveGatekept,
    });

    expect(resolveGatekept).not.toHaveBeenCalled();
    expect(result.registryUrl).toBe("https://registry.cinatra.ai");
    // Legacy public path uses the deployment-wide read token, NOT a grant.
    expect(result.args.some((a) => a.includes(":_authToken="))).toBe(true);
    expect(result.args.some((a) => a.includes("registry.cinatra.ai"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Flag ON — broker-pointed environment sourced from the grant.
  // ---------------------------------------------------------------------------
  it("flag ON: builds the install environment from the broker base URL + opaque grant", async () => {
    const resolveGatekept = vi.fn(async () => ({ config: brokerConfig("opaque.grant.value") }));
    const { resolveInstallEnvironment } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    const result = await resolveInstallEnvironment("@scope/ext", "1.2.3", {
      isGatekeptInstallEnabled: () => true,
      resolveGatekeptInstallConfig: resolveGatekept,
    });

    // Authorized for the EXACT requested package + version.
    expect(resolveGatekept).toHaveBeenCalledWith("@scope/ext", "1.2.3");
    // registryUrl is the BROKER base URL (not registry.cinatra.ai).
    expect(result.registryUrl).toBe(BROKER_URL);
    expect(result.routingMode).toBe("shared-acl");
    // The _authToken arg carries the OPAQUE grant verbatim (callers extract it
    // via args.find(a => a.includes(":_authToken="))).
    const authArg = result.args.find((a) => a.includes(":_authToken="));
    expect(authArg).toBeDefined();
    expect(authArg).toContain("opaque.grant.value");
    // The broker host (not registry.cinatra.ai) is the registry arg.
    expect(result.args.some((a) => a === `--registry=${BROKER_URL}`)).toBe(true);
    expect(result.args.some((a) => a.includes("registry.cinatra.ai"))).toBe(false);
  });

  it("flag ON: passes the version straight through (resolver resolves absent → exact)", async () => {
    const resolveGatekept = vi.fn(async () => ({ config: brokerConfig("g") }));
    const { resolveInstallEnvironment } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    // No "latest" coalescing in the resolver layer: `undefined` is forwarded and
    // `resolveGatekeptInstallConfig` resolves it to the EXACT storefront-listed
    // version (via `extensionGet`) before authorizing.
    await resolveInstallEnvironment("@scope/ext", undefined, {
      isGatekeptInstallEnabled: () => true,
      resolveGatekeptInstallConfig: resolveGatekept,
    });
    expect(resolveGatekept).toHaveBeenCalledWith("@scope/ext", undefined);
  });

  it("flag ON: an authorize denial propagates (no fallback to a direct registry read)", async () => {
    const resolveGatekept = vi.fn(async () => {
      throw new Error("not entitled");
    });
    const { resolveInstallEnvironment } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    await expect(
      resolveInstallEnvironment("@scope/ext", "1.2.3", {
        isGatekeptInstallEnabled: () => true,
        resolveGatekeptInstallConfig: resolveGatekept,
      }),
    ).rejects.toThrow("not entitled");
  });
});
