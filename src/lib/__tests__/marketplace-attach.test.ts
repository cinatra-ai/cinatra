import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Hoisted spies for every collaborator the boot hook reaches. The MCP client is
// injected via createHttpMarketplaceMcpClient; encryptSecret is stubbed so we can
// assert which credential AADs were encrypted (i.e. whether the Verdaccio read
// token was stored or sanitized away).
const {
  readInstanceIdentityMock,
  writeInstanceIdentityMock,
  decryptInstanceAttachSecretMock,
  encryptSecretMock,
  resolveTokenMock,
  createHttpClientMock,
  isGatekeptInstallEnabledMock,
} = vi.hoisted(() => ({
  readInstanceIdentityMock: vi.fn(),
  writeInstanceIdentityMock: vi.fn(),
  decryptInstanceAttachSecretMock: vi.fn(),
  encryptSecretMock: vi.fn(),
  resolveTokenMock: vi.fn(),
  createHttpClientMock: vi.fn(),
  isGatekeptInstallEnabledMock: vi.fn(),
}));

vi.mock("@/lib/instance-identity-store", () => ({
  // Inline string literals (the mock factory is hoisted above any module-level
  // const, so it cannot reference outer variables).
  CONSUMER_MARKETPLACE_TOKEN_AAD: "consumer.marketplace.token",
  CONSUMER_VERDACCIO_TOKEN_AAD: "consumer.verdaccio.token",
  decryptInstanceAttachSecret: decryptInstanceAttachSecretMock,
  readInstanceIdentity: readInstanceIdentityMock,
  writeInstanceIdentity: writeInstanceIdentityMock,
}));

const CONSUMER_MARKETPLACE_TOKEN_AAD = "consumer.marketplace.token";
const CONSUMER_VERDACCIO_TOKEN_AAD = "consumer.verdaccio.token";
vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: encryptSecretMock,
}));
vi.mock("@/lib/marketplace-credentials", () => ({
  resolveConsumerOrVendorMarketplaceToken: resolveTokenMock,
}));
vi.mock("@/lib/gatekept-install", () => ({
  isGatekeptInstallEnabled: isGatekeptInstallEnabledMock,
}));
vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", () => ({
  createHttpMarketplaceMcpClient: createHttpClientMock,
}));

import { ensureMarketplaceAttachment } from "@/lib/marketplace-attach";

const BASE_IDENTITY = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  instanceDisplayName: "Acme Inst",
  instanceAttachSecretCiphertext: "ct",
  instanceAttachSecretIv: "iv",
  instanceAttachSecretAlgo: "aes-256-gcm" as const,
  // consumerAttachment intentionally absent → triggers the attach branch.
};

const ORIGINAL_TOKEN = process.env.MARKETPLACE_INSTANCE_TOKEN;

/** Stub MCP client whose attach output the test controls. vendorApplicationStatus
 * returns a benign "none" so the reconcile step does not affect the attach assertions. */
function stubClient(attachOut: Record<string, unknown>) {
  return {
    instanceAttachSelf: vi.fn().mockResolvedValue(attachOut),
    vendorApplicationStatus: vi.fn().mockResolvedValue({ state: "none" }),
    vendorRegistryTokenRotateSelf: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MARKETPLACE_INSTANCE_TOKEN;
  // Default encryptSecret: deterministic ciphertext keyed by AAD so assertions
  // can tell which credential category was encrypted.
  encryptSecretMock.mockImplementation((_plaintext: string, aad: string) => ({
    ciphertext: `enc(${aad})`,
    iv: `iv(${aad})`,
  }));
  decryptInstanceAttachSecretMock.mockReturnValue("plaintext-secret");
  resolveTokenMock.mockReturnValue("consumer-bearer");
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.MARKETPLACE_INSTANCE_TOKEN;
  } else {
    process.env.MARKETPLACE_INSTANCE_TOKEN = ORIGINAL_TOKEN;
  }
});

/** Find the writeInstanceIdentity call whose payload carries a consumerAttachment. */
function consumerAttachmentWrite() {
  const call = writeInstanceIdentityMock.mock.calls.find(
    (c) => (c[0] as { consumerAttachment?: unknown }).consumerAttachment !== undefined,
  );
  return call?.[0] as { consumerAttachment?: Record<string, unknown> } | undefined;
}

describe("ensureMarketplaceAttachment — attach flip", () => {
  it("flag OFF: stores the Verdaccio read token (exact legacy behavior)", async () => {
    isGatekeptInstallEnabledMock.mockReturnValue(false);
    const client = stubClient({
      marketplace_user_id: 1,
      marketplace_username: "cinatra-instance-abc",
      verdaccio_username: "ci-abc",
      marketplace_token: "mk-tok",
      verdaccio_read_token: "vd-read-tok",
      attached_at: "2026-06-04T00:00:00Z",
      rotated: false,
    });
    createHttpClientMock.mockReturnValue(client);
    // First read = pre-attach (no consumerAttachment); subsequent reads = post-write.
    readInstanceIdentityMock
      .mockReturnValueOnce({ ...BASE_IDENTITY })
      .mockReturnValue({ ...BASE_IDENTITY, consumerAttachment: { marketplaceUsername: "x" } });

    await ensureMarketplaceAttachment();

    // Did NOT declare gatekept_install.
    expect(client.instanceAttachSelf).toHaveBeenCalledWith(
      expect.not.objectContaining({ gatekept_install: expect.anything() }),
    );
    // Verdaccio read token WAS encrypted + stored.
    expect(encryptSecretMock).toHaveBeenCalledWith("vd-read-tok", CONSUMER_VERDACCIO_TOKEN_AAD);
    const written = consumerAttachmentWrite();
    expect(written?.consumerAttachment?.verdaccioReadTokenCiphertext).toBe(
      `enc(${CONSUMER_VERDACCIO_TOKEN_AAD})`,
    );
    expect(written?.consumerAttachment?.verdaccioUsername).toBe("ci-abc");
  });

  it("flag ON: sends gatekept_install + stores NO Verdaccio read token (sanitized attachment)", async () => {
    isGatekeptInstallEnabledMock.mockReturnValue(true);
    // Gatekept marketplace omits verdaccio_* fields entirely.
    const client = stubClient({
      marketplace_user_id: 1,
      marketplace_username: "cinatra-instance-abc",
      marketplace_token: "mk-tok",
      attached_at: "2026-06-04T00:00:00Z",
      rotated: false,
    });
    createHttpClientMock.mockReturnValue(client);
    readInstanceIdentityMock
      .mockReturnValueOnce({ ...BASE_IDENTITY })
      .mockReturnValue({ ...BASE_IDENTITY, consumerAttachment: { marketplaceUsername: "x" } });

    await ensureMarketplaceAttachment();

    // Declared gatekept_install: true.
    expect(client.instanceAttachSelf).toHaveBeenCalledWith(
      expect.objectContaining({ gatekept_install: true }),
    );
    // The marketplace consumer bearer WAS encrypted...
    expect(encryptSecretMock).toHaveBeenCalledWith("mk-tok", CONSUMER_MARKETPLACE_TOKEN_AAD);
    // ...but the Verdaccio read-token AAD was NEVER touched.
    expect(encryptSecretMock).not.toHaveBeenCalledWith(
      expect.anything(),
      CONSUMER_VERDACCIO_TOKEN_AAD,
    );
    const written = consumerAttachmentWrite();
    expect(written?.consumerAttachment).toBeDefined();
    expect(written?.consumerAttachment).not.toHaveProperty("verdaccioReadTokenCiphertext");
    expect(written?.consumerAttachment).not.toHaveProperty("verdaccioReadTokenIv");
    expect(written?.consumerAttachment).not.toHaveProperty("verdaccioReadTokenAlgo");
  });

  it("flag OFF + missing read token: fails closed (no consumerAttachment persisted)", async () => {
    isGatekeptInstallEnabledMock.mockReturnValue(false);
    // Marketplace omitted the read token but the instance is flag-OFF.
    const client = stubClient({
      marketplace_user_id: 1,
      marketplace_username: "cinatra-instance-abc",
      marketplace_token: "mk-tok",
      attached_at: "2026-06-04T00:00:00Z",
      rotated: false,
    });
    createHttpClientMock.mockReturnValue(client);
    readInstanceIdentityMock.mockReturnValue({ ...BASE_IDENTITY });

    // The hook is soft-failing (never throws); it logs + bails on the attach error.
    await expect(ensureMarketplaceAttachment()).resolves.toBeUndefined();

    // Fail-closed: no consumerAttachment was written, and the vendor reconcile
    // (which needs the consumer bearer) was NOT reached.
    expect(consumerAttachmentWrite()).toBeUndefined();
    expect(client.vendorApplicationStatus).not.toHaveBeenCalled();
  });

  it("flag ON + marketplace still returns a read token: stores it (back-compat)", async () => {
    isGatekeptInstallEnabledMock.mockReturnValue(true);
    const client = stubClient({
      marketplace_user_id: 1,
      marketplace_username: "cinatra-instance-abc",
      verdaccio_username: "ci-abc",
      marketplace_token: "mk-tok",
      verdaccio_read_token: "vd-read-tok",
      attached_at: "2026-06-04T00:00:00Z",
      rotated: false,
    });
    createHttpClientMock.mockReturnValue(client);
    readInstanceIdentityMock
      .mockReturnValueOnce({ ...BASE_IDENTITY })
      .mockReturnValue({ ...BASE_IDENTITY, consumerAttachment: { marketplaceUsername: "x" } });

    await ensureMarketplaceAttachment();

    expect(encryptSecretMock).toHaveBeenCalledWith("vd-read-tok", CONSUMER_VERDACCIO_TOKEN_AAD);
    const written = consumerAttachmentWrite();
    expect(written?.consumerAttachment?.verdaccioReadTokenCiphertext).toBe(
      `enc(${CONSUMER_VERDACCIO_TOKEN_AAD})`,
    );
  });
});
