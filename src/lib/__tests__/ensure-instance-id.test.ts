// ensureInstanceId() + decryptInstanceAttachSecret() +
// readInstanceIdentityRequiringInstanceId() + durable-field-preservation in
// writeInstanceIdentity().
//
// The CAS UPDATEs against the metadata row are exercised at the SQL boundary
// (runPostgresQueriesSync is mocked); the JS branches above the SQL — the
// decision to add instanceId, the decision to add attach-secret, the merging
// logic in writeInstanceIdentity — are tested through observable behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSTANCE_ATTACH_SECRET_AAD,
  buildFreshInstanceIdentityDurableFields,
  decryptInstanceAttachSecret,
  ensureInstanceId,
  readInstanceIdentity,
  readInstanceIdentityRequiringInstanceId,
  writeInstanceIdentity,
  type InstanceIdentity,
} from "@/lib/instance-identity-store";
import { encryptSecret } from "@/lib/instance-secrets";
import * as cache from "@/lib/instance-identity-cache";

vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: vi.fn(),
  writeMetadataValueToDatabase: vi.fn(),
  getPostgresConnectionString: vi.fn(() => "postgres://test"),
  postgresSchema: "cinatra",
}));

vi.mock("@/lib/instance-identity-cache", () => ({
  invalidateInstanceIdentityCache: vi.fn(),
}));

vi.mock("@/lib/postgres-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runPostgresQueriesSync: vi.fn(() => [{ rows: [], rowCount: 0 }]),
  };
});

import { readMetadataValueFromDatabase } from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

// Need a real encryption key for round-trip tests.
beforeEach(() => {
  vi.clearAllMocks();
  // Set a deterministic 32-byte key for the AES-256-GCM helper.
  process.env.CINATRA_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CINATRA_ENCRYPTION_KEY;
});

const LEGACY_IDENTITY: InstanceIdentity = {
  instanceNamespace: "example-namespace",
  instanceDisplayName: "OSS Flywheel",
  // Legacy row: no instanceId, no attach-secret.
  tokenCiphertext: "ct-base64",
  tokenIv: "iv-base64",
  tokenAlgo: "aes-256-gcm",
  passwordCiphertext: "pw-ct",
  passwordIv: "pw-iv",
  firstPublishedAt: null,
  createdAt: "2026-05-07T15:00:00.000Z",
};

const FULL_VALID_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

// -----------------------------------------------------------------------------
// ensureInstanceId()
// -----------------------------------------------------------------------------

describe("ensureInstanceId", () => {
  it("returns null and writes nothing when no identity row exists", async () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(null);
    const result = await ensureInstanceId();
    expect(result).toBeNull();
    expect(vi.mocked(runPostgresQueriesSync)).not.toHaveBeenCalled();
    expect(vi.mocked(cache.invalidateInstanceIdentityCache)).not.toHaveBeenCalled();
  });

  it("issues both CAS UPDATEs and returns ensured identity when no durable fields exist", async () => {
    const enc = encryptSecret("test-secret-32-bytes-base64url", INSTANCE_ATTACH_SECRET_AAD);
    // First read: legacy row.
    // Second read (post-CAS, inside readInstanceIdentityRequiringInstanceId): populated row.
    vi.mocked(readMetadataValueFromDatabase)
      .mockReturnValueOnce({ ...LEGACY_IDENTITY })
      .mockReturnValueOnce({
        ...LEGACY_IDENTITY,
        instanceId: FULL_VALID_INSTANCE_ID,
        instanceAttachSecretCiphertext: enc.ciphertext,
        instanceAttachSecretIv: enc.iv,
        instanceAttachSecretAlgo: "aes-256-gcm",
      });

    const result = await ensureInstanceId();
    expect(result).not.toBeNull();
    expect(result?.instanceId).toBe(FULL_VALID_INSTANCE_ID);
    expect(result?.instanceAttachSecretAlgo).toBe("aes-256-gcm");

    // Two CAS queries should have been bundled into the same transactional call.
    expect(vi.mocked(runPostgresQueriesSync)).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(runPostgresQueriesSync).mock.calls[0]![0];
    expect(callArgs.transaction).toBe(true);
    expect(callArgs.queries.length).toBe(2);
    expect((callArgs.queries[0] as { text: string }).text).toMatch(/instanceId/);
    expect((callArgs.queries[1] as { text: string }).text).toMatch(
      /instanceAttachSecretCiphertext/,
    );
    expect(vi.mocked(cache.invalidateInstanceIdentityCache)).toHaveBeenCalledTimes(1);
  });

  it("issues only the attach-secret CAS when instanceId already present", async () => {
    vi.mocked(readMetadataValueFromDatabase)
      .mockReturnValueOnce({ ...LEGACY_IDENTITY, instanceId: FULL_VALID_INSTANCE_ID })
      .mockReturnValueOnce({
        ...LEGACY_IDENTITY,
        instanceId: FULL_VALID_INSTANCE_ID,
        instanceAttachSecretCiphertext: "ct",
        instanceAttachSecretIv: "iv",
        instanceAttachSecretAlgo: "aes-256-gcm",
      });

    await ensureInstanceId();
    expect(vi.mocked(runPostgresQueriesSync)).toHaveBeenCalledTimes(1);
    const queries = vi.mocked(runPostgresQueriesSync).mock.calls[0]![0].queries;
    expect(queries.length).toBe(1);
    expect((queries[0] as { text: string }).text).toMatch(/instanceAttachSecretCiphertext/);
    expect((queries[0] as { text: string }).text).not.toMatch(/'instanceId'/);
  });

  it("issues only the instanceId CAS when attach-secret already present", async () => {
    vi.mocked(readMetadataValueFromDatabase)
      .mockReturnValueOnce({
        ...LEGACY_IDENTITY,
        instanceAttachSecretCiphertext: "ct",
        instanceAttachSecretIv: "iv",
        instanceAttachSecretAlgo: "aes-256-gcm",
      })
      .mockReturnValueOnce({
        ...LEGACY_IDENTITY,
        instanceId: FULL_VALID_INSTANCE_ID,
        instanceAttachSecretCiphertext: "ct",
        instanceAttachSecretIv: "iv",
        instanceAttachSecretAlgo: "aes-256-gcm",
      });

    await ensureInstanceId();
    expect(vi.mocked(runPostgresQueriesSync)).toHaveBeenCalledTimes(1);
    const queries = vi.mocked(runPostgresQueriesSync).mock.calls[0]![0].queries;
    expect(queries.length).toBe(1);
    expect((queries[0] as { text: string }).text).toMatch(/'instanceId'/);
  });

  it("is a no-op (no SQL, no cache invalidate) when both durable fields already valid", async () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceId: FULL_VALID_INSTANCE_ID,
      instanceAttachSecretCiphertext: "ct",
      instanceAttachSecretIv: "iv",
      instanceAttachSecretAlgo: "aes-256-gcm",
    });

    const result = await ensureInstanceId();
    expect(result?.instanceId).toBe(FULL_VALID_INSTANCE_ID);
    expect(vi.mocked(runPostgresQueriesSync)).not.toHaveBeenCalled();
    expect(vi.mocked(cache.invalidateInstanceIdentityCache)).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// decryptInstanceAttachSecret + AAD round-trip
// -----------------------------------------------------------------------------

describe("decryptInstanceAttachSecret", () => {
  it("round-trips a plaintext through encrypt → decrypt with the correct AAD", () => {
    const plaintext = "abc-test-secret-xyz";
    const enc = encryptSecret(plaintext, INSTANCE_ATTACH_SECRET_AAD);
    const identity: InstanceIdentity = {
      ...LEGACY_IDENTITY,
      instanceAttachSecretCiphertext: enc.ciphertext,
      instanceAttachSecretIv: enc.iv,
      instanceAttachSecretAlgo: "aes-256-gcm",
    };
    expect(decryptInstanceAttachSecret(identity)).toBe(plaintext);
  });

  it("throws when AAD differs (auth-tag failure)", () => {
    // Encrypt with the WRONG AAD on purpose.
    const enc = encryptSecret("plain", "wrong.aad");
    const identity: InstanceIdentity = {
      ...LEGACY_IDENTITY,
      instanceAttachSecretCiphertext: enc.ciphertext,
      instanceAttachSecretIv: enc.iv,
      instanceAttachSecretAlgo: "aes-256-gcm",
    };
    expect(() => decryptInstanceAttachSecret(identity)).toThrow();
  });

  it("throws when secret fields are absent", () => {
    expect(() => decryptInstanceAttachSecret(LEGACY_IDENTITY)).toThrow(/not populated/);
  });
});

// -----------------------------------------------------------------------------
// writeInstanceIdentity durable-field preservation
// -----------------------------------------------------------------------------

describe("writeInstanceIdentity durable-field preservation", () => {
  it("preserves persisted instanceId + attach-secret when the caller spread a pre-ensure snapshot", async () => {
    const { writeMetadataValueToDatabase } = await import("@/lib/database");
    // Persisted row already has the durable fields.
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceId: FULL_VALID_INSTANCE_ID,
      instanceAttachSecretCiphertext: "persisted-ct",
      instanceAttachSecretIv: "persisted-iv",
      instanceAttachSecretAlgo: "aes-256-gcm",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Caller's input does NOT carry the durable fields (they spread a stale snapshot).
    writeInstanceIdentity({
      ...LEGACY_IDENTITY,
      instanceDisplayName: "Renamed Display Name",
    });

    expect(warnSpy).toHaveBeenCalled();
    const writeCall = vi.mocked(writeMetadataValueToDatabase).mock.calls[0]![1];
    expect((writeCall as InstanceIdentity).instanceId).toBe(FULL_VALID_INSTANCE_ID);
    expect((writeCall as InstanceIdentity).instanceAttachSecretCiphertext).toBe("persisted-ct");
    expect((writeCall as InstanceIdentity).instanceAttachSecretIv).toBe("persisted-iv");
    expect((writeCall as InstanceIdentity).instanceAttachSecretAlgo).toBe("aes-256-gcm");
    expect((writeCall as InstanceIdentity).instanceDisplayName).toBe("Renamed Display Name");
    warnSpy.mockRestore();
  });

  it("preserves persisted consumerAttachment when caller spreads a pre-boot-hook snapshot", async () => {
    const { writeMetadataValueToDatabase } = await import("@/lib/database");
    const persistedAttachment = {
      instanceIdAtAttach: FULL_VALID_INSTANCE_ID,
      attachedAt: "2026-05-27T00:00:00.000Z",
      lastRefreshedAt: "2026-05-27T00:00:00.000Z",
      marketplaceUsername: "cinatra-instance-foo",
      verdaccioUsername: "ci-foo",
      marketplaceTokenCiphertext: "mkt-ct",
      marketplaceTokenIv: "mkt-iv",
      marketplaceTokenAlgo: "aes-256-gcm" as const,
      verdaccioReadTokenCiphertext: "ver-ct",
      verdaccioReadTokenIv: "ver-iv",
      verdaccioReadTokenAlgo: "aes-256-gcm" as const,
    };
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceId: FULL_VALID_INSTANCE_ID,
      instanceAttachSecretCiphertext: "ct",
      instanceAttachSecretIv: "iv",
      instanceAttachSecretAlgo: "aes-256-gcm",
      consumerAttachment: persistedAttachment,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Caller spread a snapshot WITHOUT consumerAttachment.
    writeInstanceIdentity({
      ...LEGACY_IDENTITY,
      instanceDisplayName: "Updated display",
    });

    expect(warnSpy).toHaveBeenCalled();
    const writeCall = vi.mocked(writeMetadataValueToDatabase).mock.calls[0]![1];
    expect((writeCall as InstanceIdentity).consumerAttachment).toEqual(persistedAttachment);
    warnSpy.mockRestore();
  });

  it("preserves persisted vendorState + vendorScope + vendorApplicationId across spread-snapshot writes", async () => {
    const { writeMetadataValueToDatabase } = await import("@/lib/database");
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceId: FULL_VALID_INSTANCE_ID,
      instanceAttachSecretCiphertext: "ct",
      instanceAttachSecretIv: "iv",
      instanceAttachSecretAlgo: "aes-256-gcm",
      vendorState: "approved",
      vendorScope: "@acme",
      vendorApplicationId: "app-uuid-1",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    writeInstanceIdentity({ ...LEGACY_IDENTITY, instanceDisplayName: "X" });

    const writeCall = vi.mocked(writeMetadataValueToDatabase).mock.calls[0]![1];
    expect((writeCall as InstanceIdentity).vendorState).toBe("approved");
    expect((writeCall as InstanceIdentity).vendorScope).toBe("@acme");
    expect((writeCall as InstanceIdentity).vendorApplicationId).toBe("app-uuid-1");
    warnSpy.mockRestore();
  });

  it("caller-supplied vendorState 'none' writes through (not preserved-over by persisted state)", async () => {
    const { writeMetadataValueToDatabase } = await import("@/lib/database");
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceId: FULL_VALID_INSTANCE_ID,
      instanceAttachSecretCiphertext: "ct",
      instanceAttachSecretIv: "iv",
      instanceAttachSecretAlgo: "aes-256-gcm",
      vendorState: "approved",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Caller explicitly resets vendorState to "none" (e.g. application
    // cancelled). Preservation must NOT overwrite this with the persisted
    // "approved" value — the merge treats only `undefined` as missing.
    writeInstanceIdentity({
      ...LEGACY_IDENTITY,
      instanceId: FULL_VALID_INSTANCE_ID,
      instanceAttachSecretCiphertext: "ct",
      instanceAttachSecretIv: "iv",
      instanceAttachSecretAlgo: "aes-256-gcm",
      vendorState: "none",
    });

    const writeCall = vi.mocked(writeMetadataValueToDatabase).mock.calls[0]![1];
    expect((writeCall as InstanceIdentity).vendorState).toBe("none");
    warnSpy.mockRestore();
  });

  it("read-shim preserves persisted vendorScope = null as a distinct durable value", async () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      vendorScope: null,
      vendorApplicationId: null,
    });
    const i = readInstanceIdentity();
    expect(i?.vendorScope).toBeNull();
    expect(i?.vendorApplicationId).toBeNull();
  });

  it("does NOT warn but STILL preserves durable fields when allowMissingDurableFields is true (fixture path)", async () => {
    const { writeMetadataValueToDatabase } = await import("@/lib/database");
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceId: FULL_VALID_INSTANCE_ID,
      instanceAttachSecretCiphertext: "persisted-ct",
      instanceAttachSecretIv: "persisted-iv",
      instanceAttachSecretAlgo: "aes-256-gcm",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    writeInstanceIdentity(
      { ...LEGACY_IDENTITY, instanceDisplayName: "Display Name" },
      { allowMissingDurableFields: true },
    );

    expect(warnSpy).not.toHaveBeenCalled();
    // The escape hatch suppresses the warn, but preservation still runs —
    // the persisted durable fields are merged into the write payload.
    const writeCall = vi.mocked(writeMetadataValueToDatabase).mock.calls[0]![1];
    expect((writeCall as InstanceIdentity).instanceId).toBe(FULL_VALID_INSTANCE_ID);
    expect((writeCall as InstanceIdentity).instanceAttachSecretCiphertext).toBe("persisted-ct");
    warnSpy.mockRestore();
  });
});

// -----------------------------------------------------------------------------
// readInstanceIdentityRequiringInstanceId — corruption surfacing
// -----------------------------------------------------------------------------

describe("readInstanceIdentityRequiringInstanceId", () => {
  it("returns null when no identity row exists", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue(null);
    expect(readInstanceIdentityRequiringInstanceId()).toBeNull();
  });

  it("returns the narrowed type when both fields present + valid", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceId: FULL_VALID_INSTANCE_ID,
      instanceAttachSecretCiphertext: "ct",
      instanceAttachSecretIv: "iv",
      instanceAttachSecretAlgo: "aes-256-gcm",
    });
    const i = readInstanceIdentityRequiringInstanceId();
    expect(i?.instanceId).toBe(FULL_VALID_INSTANCE_ID);
  });

  it("throws on a non-UUIDv4 instanceId (corruption — operator must repair)", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceId: "not-a-uuid",
      instanceAttachSecretCiphertext: "ct",
      instanceAttachSecretIv: "iv",
      instanceAttachSecretAlgo: "aes-256-gcm",
    });
    expect(() => readInstanceIdentityRequiringInstanceId()).toThrow(/non-UUIDv4/);
  });

  it("throws on a wrong instanceAttachSecretAlgo (corruption)", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceId: FULL_VALID_INSTANCE_ID,
      instanceAttachSecretCiphertext: "ct",
      instanceAttachSecretIv: "iv",
      // Intentionally feeding an invalid algo value to exercise the throw path.
      instanceAttachSecretAlgo: "chacha20-poly1305" as "aes-256-gcm",
    });
    expect(() => readInstanceIdentityRequiringInstanceId()).toThrow(/instanceAttachSecretAlgo/);
  });

  it("throws when instanceId is missing but other fields present", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceAttachSecretCiphertext: "ct",
      instanceAttachSecretIv: "iv",
      instanceAttachSecretAlgo: "aes-256-gcm",
    });
    expect(() => readInstanceIdentityRequiringInstanceId()).toThrow(/Call ensureInstanceId/);
  });
});

// -----------------------------------------------------------------------------
// Read-shim passes through new fields
// -----------------------------------------------------------------------------

describe("readInstanceIdentity passes through instanceId/attach-secret fields", () => {
  it("passes through instanceId + attach-secret triple when present in the raw row", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({
      ...LEGACY_IDENTITY,
      instanceId: FULL_VALID_INSTANCE_ID,
      instanceAttachSecretCiphertext: "ct-raw",
      instanceAttachSecretIv: "iv-raw",
      instanceAttachSecretAlgo: "aes-256-gcm",
    });
    const i = readInstanceIdentity();
    expect(i?.instanceId).toBe(FULL_VALID_INSTANCE_ID);
    expect(i?.instanceAttachSecretCiphertext).toBe("ct-raw");
    expect(i?.instanceAttachSecretIv).toBe("iv-raw");
    expect(i?.instanceAttachSecretAlgo).toBe("aes-256-gcm");
  });

  it("returns undefined for new fields when the raw row omits them (legacy)", () => {
    vi.mocked(readMetadataValueFromDatabase).mockReturnValue({ ...LEGACY_IDENTITY });
    const i = readInstanceIdentity();
    expect(i?.instanceId).toBeUndefined();
    expect(i?.instanceAttachSecretCiphertext).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// buildFreshInstanceIdentityDurableFields (setup-wizard helper)
// -----------------------------------------------------------------------------

describe("buildFreshInstanceIdentityDurableFields", () => {
  it("produces a valid UUIDv4 + a decryptable attach-secret", () => {
    const fields = buildFreshInstanceIdentityDurableFields();
    expect(fields.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(fields.instanceAttachSecretAlgo).toBe("aes-256-gcm");
    // Round-trip decrypt should succeed (we wrote it under the right AAD).
    const identity: InstanceIdentity = {
      ...LEGACY_IDENTITY,
      instanceId: fields.instanceId,
      instanceAttachSecretCiphertext: fields.instanceAttachSecretCiphertext,
      instanceAttachSecretIv: fields.instanceAttachSecretIv,
      instanceAttachSecretAlgo: fields.instanceAttachSecretAlgo,
    };
    const decrypted = decryptInstanceAttachSecret(identity);
    // base64url(32 bytes) ≈ 43 chars (no padding).
    expect(decrypted.length).toBeGreaterThan(40);
  });
});
