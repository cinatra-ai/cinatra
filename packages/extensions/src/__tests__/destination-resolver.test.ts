// destination-resolver tests cover both fixture variants.
// resolvePublishDestination is real; resolveInstallEnvironment returns the public registry.
// AAD-binding assertion for destination credential decryption.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// Mock database dependencies so no real DB is needed in extensions package tests
vi.mock("@/lib/extension-destinations-store", () => ({
  readDestinationCredential: vi.fn(() => Promise.resolve(null)),
  writeDestinationCredential: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: vi.fn(() => null),
}));

vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: vi.fn((plaintext: string, aad?: string) => ({
    ciphertext: `enc(${plaintext})`,
    iv: "mock-iv",
  })),
  decryptSecret: vi.fn(({ ciphertext }: { ciphertext: string }, aad?: string) =>
    ciphertext.replace(/^enc\(/, "").replace(/\)$/, ""),
  ),
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

// Mock @cinatra-ai/agents/store to avoid pulling in @cinatra-ai/objects
// (store.ts imports AgentIOSpec from @cinatra-ai/objects; not available in extensions vitest env).
// resolveInstallEnvironment dynamically imports readAgentTemplateOrigin from this module.
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentTemplateOrigin: vi.fn(async () => null), // null = public (grandfathered)
  updateAgentTemplateOrigin: vi.fn(async () => {}),
}));

describe("resolvePublishDestination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("throws PublishDestinationNotConfiguredError when constructed with visibility 'private'", async () => {
    // Test the error class itself.
    const { PublishDestinationNotConfiguredError } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    const err = new PublishDestinationNotConfiguredError("private");
    expect(err.code).toBe("PUBLISH_DESTINATION_NOT_CONFIGURED");
    expect(err.visibility).toBe("private");
    expect(err.message).toContain("private");
    expect(err.message).toContain("Contact your admin");
  });

  it("throws PublishDestinationNotConfiguredError when constructed with visibility 'public'", async () => {
    const { PublishDestinationNotConfiguredError } = await import(
      "@cinatra-ai/extensions/destination-resolver"
    );
    const err = new PublishDestinationNotConfiguredError("public");
    expect(err.code).toBe("PUBLISH_DESTINATION_NOT_CONFIGURED");
    expect(err.visibility).toBe("public");
  });

  it("resolvePublishDestination('private') throws PublishDestinationNotConfiguredError when private not configured (baseline fixture)", async () => {
    // Baseline fixture has privateDestinationConfigured: false.
    const { resolvePublishDestination, PublishDestinationNotConfiguredError } = await import("@cinatra-ai/extensions/destination-resolver");
    await expect(resolvePublishDestination("private")).rejects.toBeInstanceOf(PublishDestinationNotConfiguredError);
  });

  it("resolvePublishDestination('public') throws PublishDestinationNotConfiguredError when publicPublishToken is null (baseline fixture)", async () => {
    // Baseline fixture has publicPublishToken: null.
    const { resolvePublishDestination, PublishDestinationNotConfiguredError } = await import("@cinatra-ai/extensions/destination-resolver");
    await expect(resolvePublishDestination("public")).rejects.toBeInstanceOf(PublishDestinationNotConfiguredError);
  });

  it("fixture has privateDestinationConfigured: false (topology B baseline, not configured)", async () => {
    // The fixture itself is real.
    const { DEPLOYMENT_REGISTRY_CONFIG_FIXTURE } = await import(
      "@/lib/__fixtures__/deployment-registry-config.fixture"
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE.privateDestinationConfigured).toBe(false);
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE.privateRegistryUrl).toBeNull();
  });

  it("fixture-with-private has privateDestinationConfigured: true and non-null privateRegistryUrl", async () => {
    // The fixture itself is real.
    const { DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE } = await import(
      "@/lib/__fixtures__/deployment-registry-config.fixture"
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.privateDestinationConfigured).toBe(true);
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.privateRegistryUrl).toBe(
      "https://private.registry.example.com",
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.privateDestinationId).toBe(
      "fixture-dest-01",
    );
  });

  it("decrypts publish token with AAD 'destination.<id>.publish-token' (resolvePublishDestination)", async () => {
    // Behavioral assertion for destination credential decryption.
    // This test calls resolvePublishDestination with a mocked private destination and
    // verifies that decryptSecret is invoked with the locked AAD binding.
    // If the aad argument were removed from destination-resolver.ts, this test fails.
    const FIXTURE_DEST_ID = "fixture-dest-01";

    vi.doMock("@/lib/deployment-registry-config", () => ({
      loadDeploymentRegistryConfig: () => ({
        publicRegistryUrl: "https://registry.cinatra.ai",
        publicReadToken: "fixture-public-read",
        publicPublishToken: null,
        privateRegistryUrl: "https://private.registry.example.com",
        privateReadToken: "fixture-private-read",
        privatePublishToken: "fixture-private-publish",
        privateDestinationConfigured: true,
        privateDestinationId: FIXTURE_DEST_ID,
        routingMode: "shared-acl" as const,
      }),
      DeploymentRegistryConfigNotAvailableError: class extends Error {
        readonly code = "DEPLOYMENT_REGISTRY_CONFIG_NOT_AVAILABLE";
        constructor() { super("routingMode missing"); }
      },
    }));

    vi.doMock("@/lib/extension-destinations-store", () => ({
      readDestinationCredential: vi.fn(async () => ({
        id: FIXTURE_DEST_ID,
        label: "test",
        registryUrl: "https://private.registry.example.com",
        tokenCiphertext: "ciphertext-publish",
        tokenIv: "iv-publish",
        tokenAlgo: "aes-256-gcm",
        readTokenCiphertext: null,
        readTokenIv: null,
      })),
      writeDestinationCredential: vi.fn(async () => {}),
    }));

    const decryptMock = vi.fn(() => "decrypted-token");
    vi.doMock("@/lib/instance-secrets", () => ({
      encryptSecret: vi.fn(),
      decryptSecret: decryptMock,
    }));

    const { resolvePublishDestination } = await import("@cinatra-ai/extensions/destination-resolver");
    await resolvePublishDestination("private");

    expect(decryptMock).toHaveBeenCalledTimes(1);
    const [cryptoInput, aad] = decryptMock.mock.calls[0] as unknown as [unknown, string];
    expect(cryptoInput).toMatchObject({ ciphertext: "ciphertext-publish", iv: "iv-publish" });
    // Locked AAD pattern: "destination.<destinationId>.publish-token"
    expect(aad).toBe(`destination.${FIXTURE_DEST_ID}.publish-token`);
  });
});

describe("resolveInstallEnvironment", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("resolveInstallEnvironment returns InstallEnvironment with public registry args", async () => {
    // Returns shared-acl args for public registry.
    const { resolveInstallEnvironment } = await import("@cinatra-ai/extensions/destination-resolver");
    const result = await resolveInstallEnvironment("ext-01");
    expect(result).toHaveProperty("args");
    expect(result).toHaveProperty("registryUrl");
    expect(result.routingMode).toMatch(/^(scope-based|shared-acl)$/);
    expect(result.registryUrl).toBe("https://registry.cinatra.ai");
  });

  it("topology A fixture has routingMode: 'scope-based' (adapter independence test shape)", async () => {
    // Fixture is real and drives --@<scope>:registry= args.
    const { DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A } = await import(
      "@/lib/__fixtures__/deployment-registry-config.fixture"
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A.routingMode).toBe("scope-based");
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_TOPOLOGY_A.privateDestinationConfigured).toBe(true);
  });

  it("topology B (with-private) fixture has routingMode: 'shared-acl' (shared-registry args shape)", async () => {
    // Fixture is real and drives --registry= args.
    const { DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE } = await import(
      "@/lib/__fixtures__/deployment-registry-config.fixture"
    );
    expect(DEPLOYMENT_REGISTRY_CONFIG_FIXTURE_WITH_PRIVATE.routingMode).toBe("shared-acl");
  });
});
