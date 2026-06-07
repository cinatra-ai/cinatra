import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The default-client path reads the instance identity + resolves the marketplace
// bearer + builds an HTTP client. Tests that inject a client never touch these;
// the one default-path test asserts the wiring through these mocks. Hoisted so
// the spies exist when the (hoisted) vi.mock factories below run.
const { readInstanceIdentityMock, resolveTokenMock, createHttpClientMock } = vi.hoisted(() => ({
  readInstanceIdentityMock: vi.fn(),
  resolveTokenMock: vi.fn(),
  createHttpClientMock: vi.fn(),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: readInstanceIdentityMock,
}));
vi.mock("@/lib/marketplace-credentials", () => ({
  resolveConsumerOrVendorMarketplaceToken: resolveTokenMock,
}));
vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", () => ({
  createHttpMarketplaceMcpClient: createHttpClientMock,
}));

import { createMockMarketplaceMcpClient, MarketplaceMcpError } from "@cinatra-ai/marketplace-mcp-client";
import type {
  MarketplaceExtensionGetOutput,
  MarketplaceMcpClient,
} from "@cinatra-ai/marketplace-mcp-client";
import {
  isGatekeptInstallEnabled,
  resolveGatekeptInstallConfig,
} from "@/lib/gatekept-install";

/**
 * Minimal valid `ExtensionDetail` fixture for `extensionGet`. The
 * exact-version-resolution path only reads `latestVersion`; the rest is padding
 * so the typed mock fixture is well-formed.
 */
function extensionDetail(
  packageName: string,
  latestVersion: string | null,
): MarketplaceExtensionGetOutput {
  return {
    packageName,
    name: packageName,
    description: null,
    kind: "agent",
    category: "agent",
    latestVersion,
    vendorSlug: "cinatra-ai",
    iconAssetUrl: null,
    publicationState: "published",
    longDescription: null,
    readmeMarkdown: null,
    marketplaceAssets: [],
    license: null,
    versionHistory: [],
  };
}

const ORIGINAL_FLAG = process.env.CINATRA_GATEKEPT_INSTALL;

beforeEach(() => {
  readInstanceIdentityMock.mockReset();
  resolveTokenMock.mockReset();
  createHttpClientMock.mockReset();
  delete process.env.CINATRA_GATEKEPT_INSTALL;
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.CINATRA_GATEKEPT_INSTALL;
  } else {
    process.env.CINATRA_GATEKEPT_INSTALL = ORIGINAL_FLAG;
  }
});

describe("isGatekeptInstallEnabled", () => {
  it("defaults to OFF when the flag is unset", () => {
    expect(isGatekeptInstallEnabled()).toBe(false);
  });

  it("is OFF for any value other than the exact string 'true'", () => {
    process.env.CINATRA_GATEKEPT_INSTALL = "1";
    expect(isGatekeptInstallEnabled()).toBe(false);
    process.env.CINATRA_GATEKEPT_INSTALL = "TRUE";
    expect(isGatekeptInstallEnabled()).toBe(false);
    process.env.CINATRA_GATEKEPT_INSTALL = "false";
    expect(isGatekeptInstallEnabled()).toBe(false);
  });

  it("is ON only for the exact string 'true'", () => {
    process.env.CINATRA_GATEKEPT_INSTALL = "true";
    expect(isGatekeptInstallEnabled()).toBe(true);
  });
});

describe("resolveGatekeptInstallConfig", () => {
  it("returns a broker-pointed VerdaccioConfig + authorize metadata from the (injected) client", async () => {
    const client = createMockMarketplaceMcpClient({
      installAuthorizations: {
        "@scope/ext@1.2.3": {
          grant: "opaque.grant.value",
          kind: "connector",
          resolved_version: "1.2.3",
          broker_base_url: "https://marketplace.cinatra.ai/install/v1",
          closure: [{ name: "@scope/dep", version: "1.0.0" }],
          expires_at: "2026-06-04T00:02:00Z",
        },
      },
    });

    const out = await resolveGatekeptInstallConfig("@scope/ext", "1.2.3", client);

    // Broker config: registryUrl = broker base URL, token = opaque grant.
    expect(out.config.registryUrl).toBe("https://marketplace.cinatra.ai/install/v1");
    expect(out.config.token).toBe("opaque.grant.value");
    expect(out.config.packageScope).toBe("@scope");
    expect(out.config.uiUrl).toBeNull();

    // Authorize metadata mapped to camelCase.
    expect(out.authorize.kind).toBe("connector");
    expect(out.authorize.resolvedVersion).toBe("1.2.3");
    expect(out.authorize.closure).toEqual([{ name: "@scope/dep", version: "1.0.0" }]);
    expect(out.authorize.expiresAt).toBe("2026-06-04T00:02:00Z");
  });

  it("explicit exact version passes straight through (no extensionGet listed-version lookup)", async () => {
    const onInstallAuthorize = vi.fn();
    const client = createMockMarketplaceMcpClient({
      // No `extensions` fixture → extensionGet would throw 404 if consulted.
      onInstallAuthorize,
      installAuthorizations: {
        "@scope/ext@1.2.3": {
          grant: "g",
          kind: "agent",
          resolved_version: "1.2.3",
          broker_base_url: "https://marketplace.cinatra.ai/install/v1",
          closure: [],
          expires_at: "2026-06-04T00:02:00Z",
        },
      },
    });

    const out = await resolveGatekeptInstallConfig("@scope/ext", "1.2.3", client);

    // Authorize was called with the EXACT supplied version — no listed-version
    // lookup detour (the missing extensionGet fixture would have thrown).
    expect(onInstallAuthorize).toHaveBeenCalledWith({
      package_name: "@scope/ext",
      version: "1.2.3",
    });
    expect(out.authorize.resolvedVersion).toBe("1.2.3");
  });

  it("resolves an absent version to the EXACT listed version via extensionGet before authorizing", async () => {
    const onInstallAuthorize = vi.fn();
    const extensionGetSpy = vi.fn();
    const base = createMockMarketplaceMcpClient({
      extensions: { "@scope/ext": extensionDetail("@scope/ext", "4.5.6") },
      onInstallAuthorize,
      installAuthorizations: {
        // Keyed on the EXACT resolved version — proves authorize used "4.5.6".
        "@scope/ext@4.5.6": {
          grant: "exact-grant",
          kind: "agent",
          resolved_version: "4.5.6",
          broker_base_url: "https://marketplace.cinatra.ai/install/v1",
          closure: [],
          expires_at: "2026-06-04T00:02:00Z",
        },
      },
    });
    const client: MarketplaceMcpClient = {
      ...base,
      extensionGet: (input) => {
        extensionGetSpy(input);
        return base.extensionGet(input);
      },
    };

    const out = await resolveGatekeptInstallConfig("@scope/ext", undefined, client);

    // extensionGet consulted for the listed version (no version pinned by caller).
    expect(extensionGetSpy).toHaveBeenCalledWith({ packageName: "@scope/ext" });
    // Authorize bound to the EXACT resolved version, NOT "latest"/undefined.
    expect(onInstallAuthorize).toHaveBeenCalledWith({
      package_name: "@scope/ext",
      version: "4.5.6",
    });
    expect(out.authorize.resolvedVersion).toBe("4.5.6");
    expect(out.config.token).toBe("exact-grant");
  });

  it("resolves the 'latest' sentinel to the EXACT listed version via extensionGet before authorizing", async () => {
    const onInstallAuthorize = vi.fn();
    const extensionGetSpy = vi.fn();
    const base = createMockMarketplaceMcpClient({
      extensions: { "@scope/ext": extensionDetail("@scope/ext", "7.8.9") },
      onInstallAuthorize,
    });
    const client: MarketplaceMcpClient = {
      ...base,
      extensionGet: (input) => {
        extensionGetSpy(input);
        return base.extensionGet(input);
      },
    };

    await resolveGatekeptInstallConfig("@scope/ext", "latest", client);

    expect(extensionGetSpy).toHaveBeenCalledWith({ packageName: "@scope/ext" });
    expect(onInstallAuthorize).toHaveBeenCalledWith({
      package_name: "@scope/ext",
      version: "7.8.9",
    });
  });

  it("throws (no authorize call) when the storefront has no listed version", async () => {
    const onInstallAuthorize = vi.fn();
    const client = createMockMarketplaceMcpClient({
      extensions: { "@scope/ext": extensionDetail("@scope/ext", null) },
      onInstallAuthorize,
    });

    await expect(
      resolveGatekeptInstallConfig("@scope/ext", "latest", client),
    ).rejects.toThrow(/no storefront-listed version/i);
    expect(onInstallAuthorize).not.toHaveBeenCalled();
  });

  it("surfaces an authorize denial (does not fall back to a direct read)", async () => {
    const client = createMockMarketplaceMcpClient({
      installAuthorizations: {
        "@scope/ext@1.2.3": new MarketplaceMcpError("not entitled", 403, ""),
      },
    });
    await expect(
      resolveGatekeptInstallConfig("@scope/ext", "1.2.3", client),
    ).rejects.toBeInstanceOf(MarketplaceMcpError);
  });

  it("derives an empty packageScope for an unscoped package name", async () => {
    const client = createMockMarketplaceMcpClient();
    const out = await resolveGatekeptInstallConfig("plain-pkg", "1.0.0", client);
    expect(out.config.packageScope).toBe("");
  });

  it("builds the default HTTP client from the resolved marketplace bearer when none is injected", async () => {
    readInstanceIdentityMock.mockReturnValue({ instanceNamespace: "acme" });
    resolveTokenMock.mockReturnValue("instance-bearer-token");
    const injectedDefault = createMockMarketplaceMcpClient({
      installAuthorizations: {
        "@scope/ext": {
          grant: "default.grant",
          kind: "agent",
          resolved_version: "1.0.0",
          broker_base_url: "https://marketplace.cinatra.ai/install/v1",
          closure: [],
          expires_at: "2026-06-04T00:02:00Z",
        },
      },
    });
    createHttpClientMock.mockReturnValue(injectedDefault);

    const out = await resolveGatekeptInstallConfig("@scope/ext", "1.0.0");

    expect(resolveTokenMock).toHaveBeenCalledWith({ instanceNamespace: "acme" });
    expect(createHttpClientMock).toHaveBeenCalledWith({ token: "instance-bearer-token" });
    expect(out.config.token).toBe("default.grant");
  });
});
