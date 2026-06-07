// Unit tests for `loadVerdaccioConfigForReads` under the gatekept-install
// staging change (consumerAttachment Verdaccio read-token now OPTIONAL).
//
// Asserts:
//   - flag OFF, attachment WITH read token  → consumer read path (unchanged)
//   - flag OFF, attachment WITHOUT read token → still throws (corruption guard
//     intact — flag-OFF behavior is exactly as before)
//   - flag ON,  attachment WITHOUT read token → does NOT throw; falls through to
//     the legacy server loader (install reads route through the broker grant)
//   - flag ON,  attachment WITH read token    → consumer read path (still used)
//   - no attachment at all → legacy server loader (back-compat, unchanged)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const { readInstanceIdentityMock, decryptSecretMock, flagMock } = vi.hoisted(() => ({
  readInstanceIdentityMock: vi.fn(),
  decryptSecretMock: vi.fn(),
  flagMock: vi.fn<() => boolean>(),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: readInstanceIdentityMock,
}));
vi.mock("@/lib/instance-secrets", () => ({
  decryptSecret: decryptSecretMock,
}));
vi.mock("@/lib/gatekept-install", () => ({
  isGatekeptInstallEnabled: flagMock,
}));

import { loadVerdaccioConfigForReads } from "@/lib/verdaccio-config";
import { VendorCredentialsMissingError } from "@/lib/marketplace-credentials";

type Identity = Record<string, unknown>;

const VENDOR_IDENTITY: Identity = {
  instanceNamespace: "acme",
  tokenCiphertext: "vendor-ct",
  tokenIv: "vendor-iv",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pct",
  passwordIv: "piv",
  registryUrl: "https://registry.cinatra.ai",
  firstPublishedAt: null,
  createdAt: "2026-05-01T00:00:00.000Z",
};

const ATTACHMENT_WITH_TOKEN = {
  instanceIdAtAttach: "11111111-1111-4111-8111-111111111111",
  attachedAt: "2026-05-27T00:00:00.000Z",
  lastRefreshedAt: "2026-05-27T00:00:00.000Z",
  marketplaceUsername: "cinatra-instance-foo",
  verdaccioUsername: "ci-foo",
  marketplaceTokenCiphertext: "mkt-ct",
  marketplaceTokenIv: "mkt-iv",
  marketplaceTokenAlgo: "aes-256-gcm" as const,
  verdaccioReadTokenCiphertext: "vrd-ct",
  verdaccioReadTokenIv: "vrd-iv",
  verdaccioReadTokenAlgo: "aes-256-gcm" as const,
};

const ATTACHMENT_WITHOUT_TOKEN = {
  instanceIdAtAttach: "11111111-1111-4111-8111-111111111111",
  attachedAt: "2026-05-27T00:00:00.000Z",
  lastRefreshedAt: "2026-05-27T00:00:00.000Z",
  marketplaceUsername: "cinatra-instance-foo",
  verdaccioUsername: "ci-foo",
  marketplaceTokenCiphertext: "mkt-ct",
  marketplaceTokenIv: "mkt-iv",
  marketplaceTokenAlgo: "aes-256-gcm" as const,
};

beforeEach(() => {
  readInstanceIdentityMock.mockReset();
  decryptSecretMock.mockReset();
  flagMock.mockReset();
  decryptSecretMock.mockReturnValue("decrypted-token");
  // Env-override path must stay off so the identity-row branch is exercised.
  delete process.env.CINATRA_AGENT_REGISTRY_URL;
  delete process.env.CINATRA_AGENT_REGISTRY_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadVerdaccioConfigForReads — gatekept-install staging", () => {
  it("flag OFF, attachment WITH read token → consumer read path (unchanged)", async () => {
    flagMock.mockReturnValue(false);
    readInstanceIdentityMock.mockReturnValue({
      ...VENDOR_IDENTITY,
      consumerAttachment: ATTACHMENT_WITH_TOKEN,
    });

    const config = await loadVerdaccioConfigForReads();

    expect(config.token).toBe("decrypted-token");
    // Consumer AAD must be used for the read-token decrypt.
    expect(decryptSecretMock).toHaveBeenCalledWith(
      { ciphertext: "vrd-ct", iv: "vrd-iv" },
      "consumer.verdaccio.token",
    );
  });

  it("flag OFF, attachment WITHOUT read token → still throws (corruption guard intact)", async () => {
    flagMock.mockReturnValue(false);
    readInstanceIdentityMock.mockReturnValue({
      ...VENDOR_IDENTITY,
      consumerAttachment: ATTACHMENT_WITHOUT_TOKEN,
    });

    await expect(loadVerdaccioConfigForReads()).rejects.toBeInstanceOf(
      VendorCredentialsMissingError,
    );
  });

  it("flag ON, attachment WITHOUT read token → does NOT throw; falls through to the legacy server loader", async () => {
    flagMock.mockReturnValue(true);
    readInstanceIdentityMock.mockReturnValue({
      ...VENDOR_IDENTITY,
      consumerAttachment: ATTACHMENT_WITHOUT_TOKEN,
    });

    const config = await loadVerdaccioConfigForReads();

    // Fell through to loadVerdaccioConfigForServer → vendor AAD on the top-level token.
    expect(config.packageScope).toBe("@acme");
    expect(config.token).toBe("decrypted-token");
    expect(decryptSecretMock).toHaveBeenCalledWith(
      { ciphertext: "vendor-ct", iv: "vendor-iv" },
      "vendor.token",
    );
  });

  it("flag ON, attachment WITH read token → consumer read path still used", async () => {
    flagMock.mockReturnValue(true);
    readInstanceIdentityMock.mockReturnValue({
      ...VENDOR_IDENTITY,
      consumerAttachment: ATTACHMENT_WITH_TOKEN,
    });

    const config = await loadVerdaccioConfigForReads();

    expect(config.token).toBe("decrypted-token");
    expect(decryptSecretMock).toHaveBeenCalledWith(
      { ciphertext: "vrd-ct", iv: "vrd-iv" },
      "consumer.verdaccio.token",
    );
  });

  it("no consumerAttachment → legacy server loader (back-compat, unchanged)", async () => {
    flagMock.mockReturnValue(true);
    readInstanceIdentityMock.mockReturnValue({ ...VENDOR_IDENTITY });

    const config = await loadVerdaccioConfigForReads();

    expect(config.packageScope).toBe("@acme");
    expect(decryptSecretMock).toHaveBeenCalledWith(
      { ciphertext: "vendor-ct", iv: "vendor-iv" },
      "vendor.token",
    );
  });
});
