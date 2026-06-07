// Unit test for the host-app convenience wrapper that composes the async
// Verdaccio config loader with the instance identity and secret readers.
//
// Asserts:
//   - The wrapper produces a config whose packageScope is "@" + the injected
//     vendor name, confirming end-to-end wiring at the host-app seam.
//   - The token comes back as the decrypted plaintext (decryptSecret is
//     invoked exactly as required by the loader's signature).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { readInstanceIdentityMock } = vi.hoisted(() => ({
  readInstanceIdentityMock: vi.fn(),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: readInstanceIdentityMock,
}));

vi.mock("@/lib/instance-secrets", () => ({
  decryptSecret: vi.fn(() => "decrypted-token"),
}));

describe("loadVerdaccioConfigForServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CINATRA_AGENT_REGISTRY_URL;
    delete process.env.CINATRA_AGENT_REGISTRY_TOKEN;
    readInstanceIdentityMock.mockReturnValue({
      instanceNamespace: "example-namespace",
      tokenCiphertext: "ct",
      tokenIv: "iv",
      tokenAlgo: "aes-256-gcm" as const,
      passwordCiphertext: "pct",
      passwordIv: "piv",
      registryUrl: "https://registry.cinatra.ai",
      firstPublishedAt: null,
      createdAt: "2026-05-07T00:00:00.000Z",
    });
  });

  it("composes the async loader with the readers and returns a fully-resolved config", async () => {
    const { loadVerdaccioConfigForServer } = await import("@/lib/verdaccio-config");
    const config = await loadVerdaccioConfigForServer();
    expect(config.packageScope).toBe("@example-namespace");
    expect(config.token).toBe("decrypted-token");
    expect(config.registryUrl).toBe("https://registry.cinatra.ai");
  });

  it("treats an identity without publish-token fields as missing registry credentials", async () => {
    readInstanceIdentityMock.mockReturnValue({
      instanceNamespace: "example-namespace",
      registryUrl: "https://registry.cinatra.ai",
      firstPublishedAt: null,
      createdAt: "2026-05-07T00:00:00.000Z",
    });

    const { loadVerdaccioConfigForServer } = await import("@/lib/verdaccio-config");
    const { VendorCredentialsMissingError } = await import("@/lib/marketplace-credentials");

    await expect(loadVerdaccioConfigForServer()).rejects.toBeInstanceOf(
      VendorCredentialsMissingError,
    );
  });
});
