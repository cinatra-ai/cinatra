// Tests for the partitioned marketplace-credential resolvers (consumer vs
// vendor vs sync-worker).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSUMER_MARKETPLACE_TOKEN_AAD,
  type InstanceIdentity,
} from "@/lib/instance-identity-store";
import { encryptSecret } from "@/lib/instance-secrets";
import {
  VendorCredentialsMissingError,
  resolveConsumerOrVendorMarketplaceToken,
  resolveMarketplaceSyncWorkerToken,
} from "@/lib/marketplace-credentials";

beforeEach(() => {
  process.env.CINATRA_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
  delete process.env.MARKETPLACE_INSTANCE_TOKEN;
  delete process.env.MARKETPLACE_SYNC_WORKER_TOKEN;
});

afterEach(() => {
  delete process.env.CINATRA_ENCRYPTION_KEY;
  delete process.env.MARKETPLACE_INSTANCE_TOKEN;
  delete process.env.MARKETPLACE_SYNC_WORKER_TOKEN;
  vi.restoreAllMocks();
});

const BARE_IDENTITY: InstanceIdentity = {
  instanceNamespace: "acme",
  instanceDisplayName: "Acme",
  tokenCiphertext: "",
  tokenIv: "",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pw-ct",
  passwordIv: "pw-iv",
  firstPublishedAt: null,
  createdAt: "2026-05-01T00:00:00.000Z",
};

describe("resolveConsumerOrVendorMarketplaceToken", () => {
  it("returns the env override when MARKETPLACE_INSTANCE_TOKEN is set, even when consumerAttachment is present", () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "  env-bearer-1234  ";
    const enc = encryptSecret("consumer-bearer", CONSUMER_MARKETPLACE_TOKEN_AAD);
    const identity: InstanceIdentity = {
      ...BARE_IDENTITY,
      consumerAttachment: {
        instanceIdAtAttach: "11111111-1111-4111-8111-111111111111",
        attachedAt: "2026-05-27T00:00:00.000Z",
        lastRefreshedAt: "2026-05-27T00:00:00.000Z",
        marketplaceUsername: "cinatra-instance-foo",
        verdaccioUsername: "ci-foo",
        marketplaceTokenCiphertext: enc.ciphertext,
        marketplaceTokenIv: enc.iv,
        marketplaceTokenAlgo: "aes-256-gcm",
        verdaccioReadTokenCiphertext: "v-ct",
        verdaccioReadTokenIv: "v-iv",
        verdaccioReadTokenAlgo: "aes-256-gcm",
      },
    };
    expect(resolveConsumerOrVendorMarketplaceToken(identity)).toBe("env-bearer-1234");
  });

  it("decrypts consumerAttachment.marketplaceTokenCiphertext when env override is absent", () => {
    const plaintext = "consumer-decoded-bearer";
    const enc = encryptSecret(plaintext, CONSUMER_MARKETPLACE_TOKEN_AAD);
    const identity: InstanceIdentity = {
      ...BARE_IDENTITY,
      consumerAttachment: {
        instanceIdAtAttach: "11111111-1111-4111-8111-111111111111",
        attachedAt: "2026-05-27T00:00:00.000Z",
        lastRefreshedAt: "2026-05-27T00:00:00.000Z",
        marketplaceUsername: "cinatra-instance-foo",
        verdaccioUsername: "ci-foo",
        marketplaceTokenCiphertext: enc.ciphertext,
        marketplaceTokenIv: enc.iv,
        marketplaceTokenAlgo: "aes-256-gcm",
        verdaccioReadTokenCiphertext: "v-ct",
        verdaccioReadTokenIv: "v-iv",
        verdaccioReadTokenAlgo: "aes-256-gcm",
      },
    };
    expect(resolveConsumerOrVendorMarketplaceToken(identity)).toBe(plaintext);
  });

  it("falls back to vendor tokenCiphertext when no env override + no consumerAttachment", () => {
    const plaintext = "vendor-bearer-xyz";
    const enc = encryptSecret(plaintext, "vendor.token");
    const identity: InstanceIdentity = {
      ...BARE_IDENTITY,
      tokenCiphertext: enc.ciphertext,
      tokenIv: enc.iv,
    };
    expect(resolveConsumerOrVendorMarketplaceToken(identity)).toBe(plaintext);
  });

  it("throws VendorCredentialsMissingError when no source is available", () => {
    expect(() => resolveConsumerOrVendorMarketplaceToken(null)).toThrow(
      VendorCredentialsMissingError,
    );
    expect(() => resolveConsumerOrVendorMarketplaceToken(BARE_IDENTITY)).toThrow(
      VendorCredentialsMissingError,
    );
  });

  it("throws CONSUMER_ATTACHMENT_CORRUPTED when consumerAttachment is present but ciphertext is empty — does NOT fall back to vendor token", () => {
    const vendorEnc = encryptSecret("vendor-bearer", "vendor.token");
    const identity: InstanceIdentity = {
      ...BARE_IDENTITY,
      // Valid vendor token AVAILABLE in the legacy slot.
      tokenCiphertext: vendorEnc.ciphertext,
      tokenIv: vendorEnc.iv,
      // But consumerAttachment is present-but-broken (empty ciphertext).
      consumerAttachment: {
        instanceIdAtAttach: "11111111-1111-4111-8111-111111111111",
        attachedAt: "2026-05-27T00:00:00.000Z",
        lastRefreshedAt: "2026-05-27T00:00:00.000Z",
        marketplaceUsername: "u",
        verdaccioUsername: "v",
        marketplaceTokenCiphertext: "",
        marketplaceTokenIv: "iv-base64",
        marketplaceTokenAlgo: "aes-256-gcm",
        verdaccioReadTokenCiphertext: "v-ct",
        verdaccioReadTokenIv: "v-iv",
        verdaccioReadTokenAlgo: "aes-256-gcm",
      },
    };
    let thrown: unknown;
    try {
      resolveConsumerOrVendorMarketplaceToken(identity);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VendorCredentialsMissingError);
    expect((thrown as VendorCredentialsMissingError).code).toBe("CONSUMER_ATTACHMENT_CORRUPTED");
  });

  it("throws CONSUMER_ATTACHMENT_CORRUPTED on a wrong algo — does NOT fall back to vendor token", () => {
    const vendorEnc = encryptSecret("vendor-bearer", "vendor.token");
    const identity: InstanceIdentity = {
      ...BARE_IDENTITY,
      tokenCiphertext: vendorEnc.ciphertext,
      tokenIv: vendorEnc.iv,
      consumerAttachment: {
        instanceIdAtAttach: "11111111-1111-4111-8111-111111111111",
        attachedAt: "2026-05-27T00:00:00.000Z",
        lastRefreshedAt: "2026-05-27T00:00:00.000Z",
        marketplaceUsername: "u",
        verdaccioUsername: "v",
        marketplaceTokenCiphertext: "ct",
        marketplaceTokenIv: "iv",
        // Wrong algo — corruption signal.
        marketplaceTokenAlgo: "chacha20-poly1305" as "aes-256-gcm",
        verdaccioReadTokenCiphertext: "v-ct",
        verdaccioReadTokenIv: "v-iv",
        verdaccioReadTokenAlgo: "aes-256-gcm",
      },
    };
    expect(() => resolveConsumerOrVendorMarketplaceToken(identity)).toThrow(
      VendorCredentialsMissingError,
    );
    try {
      resolveConsumerOrVendorMarketplaceToken(identity);
    } catch (e) {
      expect((e as VendorCredentialsMissingError).code).toBe("CONSUMER_ATTACHMENT_CORRUPTED");
    }
  });

  it("throws CONSUMER_ATTACHMENT_CORRUPTED when consumerAttachment is present with missing IV — does NOT fall back", () => {
    const vendorEnc = encryptSecret("vendor-bearer", "vendor.token");
    const identity: InstanceIdentity = {
      ...BARE_IDENTITY,
      tokenCiphertext: vendorEnc.ciphertext,
      tokenIv: vendorEnc.iv,
      consumerAttachment: {
        instanceIdAtAttach: "11111111-1111-4111-8111-111111111111",
        attachedAt: "2026-05-27T00:00:00.000Z",
        lastRefreshedAt: "2026-05-27T00:00:00.000Z",
        marketplaceUsername: "u",
        verdaccioUsername: "v",
        marketplaceTokenCiphertext: "ct",
        marketplaceTokenIv: "",
        marketplaceTokenAlgo: "aes-256-gcm",
        verdaccioReadTokenCiphertext: "v-ct",
        verdaccioReadTokenIv: "v-iv",
        verdaccioReadTokenAlgo: "aes-256-gcm",
      },
    };
    expect(() => resolveConsumerOrVendorMarketplaceToken(identity)).toThrow(
      VendorCredentialsMissingError,
    );
  });

  it("crypto failure on a tampered ciphertext propagates as a hard error (NOT VendorCredentialsMissingError)", () => {
    const enc = encryptSecret("bearer", CONSUMER_MARKETPLACE_TOKEN_AAD);
    const identity: InstanceIdentity = {
      ...BARE_IDENTITY,
      consumerAttachment: {
        instanceIdAtAttach: "11111111-1111-4111-8111-111111111111",
        attachedAt: "2026-05-27T00:00:00.000Z",
        lastRefreshedAt: "2026-05-27T00:00:00.000Z",
        marketplaceUsername: "u",
        verdaccioUsername: "v",
        // Tamper the IV — every byte authenticated by GCM auth tag.
        marketplaceTokenCiphertext: enc.ciphertext,
        marketplaceTokenIv: Buffer.alloc(12, 0).toString("base64"),
        marketplaceTokenAlgo: "aes-256-gcm",
        verdaccioReadTokenCiphertext: "v-ct",
        verdaccioReadTokenIv: "v-iv",
        verdaccioReadTokenAlgo: "aes-256-gcm",
      },
    };
    let thrown: unknown;
    try {
      resolveConsumerOrVendorMarketplaceToken(identity);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(VendorCredentialsMissingError);
  });
});

describe("resolveMarketplaceSyncWorkerToken", () => {
  it("returns the env value when set", () => {
    process.env.MARKETPLACE_SYNC_WORKER_TOKEN = "sync-worker-bearer";
    expect(resolveMarketplaceSyncWorkerToken()).toBe("sync-worker-bearer");
  });

  it("trims trailing whitespace from the env value", () => {
    process.env.MARKETPLACE_SYNC_WORKER_TOKEN = "  sw-bearer-321  ";
    expect(resolveMarketplaceSyncWorkerToken()).toBe("sw-bearer-321");
  });

  it("throws VendorCredentialsMissingError when env is absent", () => {
    expect(() => resolveMarketplaceSyncWorkerToken()).toThrow(VendorCredentialsMissingError);
    try {
      resolveMarketplaceSyncWorkerToken();
    } catch (e) {
      expect((e as VendorCredentialsMissingError).code).toBe("SYNC_WORKER_TOKEN_MISSING");
    }
  });

  it("does NOT fall back to MARKETPLACE_INSTANCE_TOKEN (catalog-poisoning guard)", () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "consumer-bearer";
    expect(() => resolveMarketplaceSyncWorkerToken()).toThrow(VendorCredentialsMissingError);
  });
});
