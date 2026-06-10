// Tests for vendorScopeOverride parameter on resolvePublishDestination. The
// override should drive packageScope when set and fall back to identity-derived
// scope when null/undefined.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: vi.fn((plaintext: string) => ({ ciphertext: `enc(${plaintext})`, iv: "mock-iv" })),
  decryptSecret: vi.fn(({ ciphertext }: { ciphertext: string }) =>
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

vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentTemplateOrigin: vi.fn(async () => null),
  updateAgentTemplateOrigin: vi.fn(async () => {}),
}));

describe("resolvePublishDestination — vendorScopeOverride", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("public publish without override uses identity-derived scope", async () => {
    vi.doMock("@/lib/deployment-registry-config", () => ({
      loadDeploymentRegistryConfig: () => ({
        publicRegistryUrl: "https://registry.cinatra.ai",
        publicReadToken: "fixture-public-read",
        publicPublishToken: "fixture-public-publish",
        privateRegistryUrl: null,
        privateReadToken: null,
        privatePublishToken: null,
        privateDestinationConfigured: false,
        privateDestinationId: null,
        routingMode: "shared-acl" as const,
      }),
      DeploymentRegistryConfigNotAvailableError: class extends Error {},
    }));
    vi.doMock("@/lib/extension-destinations-store", () => ({
      readDestinationCredential: vi.fn(async () => null),
      writeDestinationCredential: vi.fn(async () => {}),
    }));
    vi.doMock("@/lib/instance-identity-store", () => ({
      readInstanceIdentity: vi.fn(() => ({
        instanceNamespace: "dev-alice",
        registryUrl: "https://registry.cinatra.ai",
      })),
    }));

    const { resolvePublishDestination } = await import("@cinatra-ai/extensions/destination-resolver");
    const config = await resolvePublishDestination("public");
    expect(config.packageScope).toBe("@dev-alice");
  });

  it("public publish with vendorScopeOverride drives packageScope to the override", async () => {
    vi.doMock("@/lib/deployment-registry-config", () => ({
      loadDeploymentRegistryConfig: () => ({
        publicRegistryUrl: "https://registry.cinatra.ai",
        publicReadToken: "fixture-public-read",
        publicPublishToken: "fixture-public-publish",
        privateRegistryUrl: null,
        privateReadToken: null,
        privatePublishToken: null,
        privateDestinationConfigured: false,
        privateDestinationId: null,
        routingMode: "shared-acl" as const,
      }),
      DeploymentRegistryConfigNotAvailableError: class extends Error {},
    }));
    vi.doMock("@/lib/extension-destinations-store", () => ({
      readDestinationCredential: vi.fn(async () => null),
      writeDestinationCredential: vi.fn(async () => {}),
    }));
    vi.doMock("@/lib/instance-identity-store", () => ({
      readInstanceIdentity: vi.fn(() => ({
        instanceNamespace: "dev-alice",
        registryUrl: "https://registry.cinatra.ai",
      })),
    }));

    const { resolvePublishDestination } = await import("@cinatra-ai/extensions/destination-resolver");
    const config = await resolvePublishDestination("public", { vendorScopeOverride: "acme-corp" });
    expect(config.packageScope).toBe("@acme-corp");
    // Other fields preserved — only scope overridden.
    expect(config.registryUrl).toBe("https://registry.cinatra.ai");
    expect(config.token).toBe("fixture-public-publish");
  });

  it("private publish with vendorScopeOverride drives packageScope to the override", async () => {
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
      DeploymentRegistryConfigNotAvailableError: class extends Error {},
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
    vi.doMock("@/lib/instance-identity-store", () => ({
      readInstanceIdentity: vi.fn(() => ({
        instanceNamespace: "dev-alice",
        registryUrl: "https://registry.cinatra.ai",
      })),
    }));

    const { resolvePublishDestination } = await import("@cinatra-ai/extensions/destination-resolver");
    const config = await resolvePublishDestination("private", { vendorScopeOverride: "acme-corp" });
    expect(config.packageScope).toBe("@acme-corp");
  });

  it("vendorScopeOverride: null falls back to identity-derived scope", async () => {
    vi.doMock("@/lib/deployment-registry-config", () => ({
      loadDeploymentRegistryConfig: () => ({
        publicRegistryUrl: "https://registry.cinatra.ai",
        publicReadToken: "fixture-public-read",
        publicPublishToken: "fixture-public-publish",
        privateRegistryUrl: null,
        privateReadToken: null,
        privatePublishToken: null,
        privateDestinationConfigured: false,
        privateDestinationId: null,
        routingMode: "shared-acl" as const,
      }),
      DeploymentRegistryConfigNotAvailableError: class extends Error {},
    }));
    vi.doMock("@/lib/extension-destinations-store", () => ({
      readDestinationCredential: vi.fn(async () => null),
      writeDestinationCredential: vi.fn(async () => {}),
    }));
    vi.doMock("@/lib/instance-identity-store", () => ({
      readInstanceIdentity: vi.fn(() => ({
        instanceNamespace: "dev-alice",
        registryUrl: "https://registry.cinatra.ai",
      })),
    }));

    const { resolvePublishDestination } = await import("@cinatra-ai/extensions/destination-resolver");
    const config = await resolvePublishDestination("public", { vendorScopeOverride: null });
    expect(config.packageScope).toBe("@dev-alice");
  });

  it("vendorScopeOverride: empty string falls back to identity-derived scope", async () => {
    vi.doMock("@/lib/deployment-registry-config", () => ({
      loadDeploymentRegistryConfig: () => ({
        publicRegistryUrl: "https://registry.cinatra.ai",
        publicReadToken: "fixture-public-read",
        publicPublishToken: "fixture-public-publish",
        privateRegistryUrl: null,
        privateReadToken: null,
        privatePublishToken: null,
        privateDestinationConfigured: false,
        privateDestinationId: null,
        routingMode: "shared-acl" as const,
      }),
      DeploymentRegistryConfigNotAvailableError: class extends Error {},
    }));
    vi.doMock("@/lib/extension-destinations-store", () => ({
      readDestinationCredential: vi.fn(async () => null),
      writeDestinationCredential: vi.fn(async () => {}),
    }));
    vi.doMock("@/lib/instance-identity-store", () => ({
      readInstanceIdentity: vi.fn(() => ({
        instanceNamespace: "dev-alice",
        registryUrl: "https://registry.cinatra.ai",
      })),
    }));

    const { resolvePublishDestination } = await import("@cinatra-ai/extensions/destination-resolver");
    const config = await resolvePublishDestination("public", { vendorScopeOverride: "   " });
    expect(config.packageScope).toBe("@dev-alice");
  });
});
