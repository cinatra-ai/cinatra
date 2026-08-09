// cinatra#2581 — the OpenAI credential must not sit in `cinatra.metadata` as
// plaintext, and OpenAI request/response BODIES must not be written to a local
// log file by default.
//
// Coverage:
//   1. At-rest seal/unseal of `openai_connection.apiKey` — the stored value is
//      not plaintext, the round-trip works, a legacy plaintext row still reads
//      and is upgraded by the write path, and every failure mode is fail-closed.
//   2. The body-logging default policy — an UNSET preference resolves OFF
//      everywhere (dev and prod — the "dev-off" ruling) and only an EXPLICIT
//      operator choice overrides.
//
// SECRETS: every value here is an obviously-fake placeholder, and the assertions
// are on SHAPE (sealed vs not, round-trip identity) — no real key material.
//
// `@/lib/database` is an ASYNC module (its graph reaches `import()`-loaded
// externals via drizzle-store → pg), so it can never be imported from a unit
// test; the pure at-rest transforms live in `@/lib/connector-config-secret-fields`
// (no Postgres dependency) and are exercised directly here — the same shape as
// the connector-config half in `connector-config-secret-at-rest.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isSealed,
  OPENAI_CONNECTION_METADATA_KEY,
  OPENAI_CONNECTION_SECRET_FIELD,
  prepareSealedOpenAIConnectionWrite,
  readOpenAIApiKeyFromRow,
  resolveOpenAIBodyLoggingDefault,
  sealOpenAIConnectionSecrets,
  unsealOpenAIConnectionSecrets,
} from "@/lib/connector-config-secret-fields";

// Obviously-fake placeholders — never a real credential.
const FAKE_API_KEY = "sk-FAKE-openai-key-for-tests-0000";
const OTHER_FAKE_API_KEY = "sk-FAKE-openai-key-rotated-1111";

const VALID_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ROTATED_KEY_HEX =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const ORIGINAL_KEY = process.env.CINATRA_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CINATRA_ENCRYPTION_KEY = VALID_KEY_HEX;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.CINATRA_ENCRYPTION_KEY;
  } else {
    process.env.CINATRA_ENCRYPTION_KEY = ORIGINAL_KEY;
  }
  vi.restoreAllMocks();
});

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// =============================================================================
// 1. At-rest seal — the stored value is not plaintext
// =============================================================================

describe("openai_connection.apiKey at rest", () => {
  it("the persisted row holds NO plaintext key — only a sealed blob", () => {
    const sealed = record(
      sealOpenAIConnectionSecrets({
        apiKey: FAKE_API_KEY,
        defaultModel: "gpt-5.5",
        projectId: "proj_fake",
      }),
    );

    expect(isSealed(sealed.apiKey)).toBe(true);
    // The whole serialized row is checked, not just the field: this is the
    // assertion that would have caught the original defect.
    expect(JSON.stringify(sealed)).not.toContain(FAKE_API_KEY);
    // Non-secret fields ride through verbatim.
    expect(sealed.defaultModel).toBe("gpt-5.5");
    expect(sealed.projectId).toBe("proj_fake");
  });

  it("round-trips: unsealing a sealed row returns the original key", () => {
    const sealed = sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY });
    const { value, sawLegacyPlaintext, decryptFailed } = unsealOpenAIConnectionSecrets(sealed);

    expect(record(value).apiKey).toBe(FAKE_API_KEY);
    expect(sawLegacyPlaintext).toBe(false);
    expect(decryptFailed).toBe(false);
  });

  it("is idempotent — sealing an already-sealed row never double-seals", () => {
    const once = record(sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY }));
    const twice = record(sealOpenAIConnectionSecrets(once));

    expect(twice.apiKey).toEqual(once.apiKey);
    expect(record(unsealOpenAIConnectionSecrets(twice).value).apiKey).toBe(FAKE_API_KEY);
  });

  it("uses a fresh IV per seal — two seals of the same key differ at rest", () => {
    const a = record(sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY }));
    const b = record(sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY }));

    expect((a.apiKey as { iv: string }).iv).not.toBe((b.apiKey as { iv: string }).iv);
    expect((a.apiKey as { ciphertext: string }).ciphertext).not.toBe(
      (b.apiKey as { ciphertext: string }).ciphertext,
    );
  });

  it("strips a sidecar plaintext property from an externally-crafted sealed row", () => {
    const sealed = record(sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY }));
    const crafted = {
      apiKey: { ...(sealed.apiKey as object), plaintext: FAKE_API_KEY },
    };

    const persisted = record(sealOpenAIConnectionSecrets(crafted));
    expect(Object.keys(persisted.apiKey as object).sort()).toEqual([
      "__enc",
      "ciphertext",
      "iv",
    ]);
    expect(JSON.stringify(persisted)).not.toContain(FAKE_API_KEY);
  });

  it("leaves a row without an apiKey untouched", () => {
    const input = { defaultModel: "gpt-5.5", availableModels: ["gpt-5.5"] };
    expect(sealOpenAIConnectionSecrets(input)).toEqual(input);
    expect(unsealOpenAIConnectionSecrets(input).value).toEqual(input);
  });
});

// =============================================================================
// 2. Legacy plaintext row — reads, and upgrades on write
// =============================================================================

describe("legacy plaintext row migration (no migration file)", () => {
  it("a legacy plaintext row STILL READS and is flagged for upgrade", () => {
    const legacyRow = { apiKey: FAKE_API_KEY, defaultModel: "gpt-5.5" };

    const { value, sawLegacyPlaintext, decryptFailed } =
      unsealOpenAIConnectionSecrets(legacyRow);

    expect(record(value).apiKey).toBe(FAKE_API_KEY);
    expect(sawLegacyPlaintext).toBe(true);
    expect(decryptFailed).toBe(false);
  });

  it("the next write UPGRADES the legacy row to a sealed row", () => {
    const legacyRow = { apiKey: FAKE_API_KEY, defaultModel: "gpt-5.5" };
    const readBack = unsealOpenAIConnectionSecrets(legacyRow).value;

    const upgraded = record(prepareSealedOpenAIConnectionWrite(readBack, legacyRow));

    expect(isSealed(upgraded.apiKey)).toBe(true);
    expect(JSON.stringify(upgraded)).not.toContain(FAKE_API_KEY);
    // And the upgraded row still resolves to the same key.
    expect(readOpenAIApiKeyFromRow(upgraded)).toBe(FAKE_API_KEY);
  });

  it("an empty legacy value is not treated as a migration candidate", () => {
    expect(unsealOpenAIConnectionSecrets({ apiKey: "" }).sawLegacyPlaintext).toBe(false);
  });
});

// =============================================================================
// 3. Write orchestration — preserve vs explicit clear
// =============================================================================

describe("prepareSealedOpenAIConnectionWrite", () => {
  it("preserves the stored sealed key when the write carries none", () => {
    const stored = record(sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY }));

    // An unrelated settings save (a logging toggle) with no key in hand.
    const next = record(
      prepareSealedOpenAIConnectionWrite({ loggingEnabled: false }, stored),
    );

    expect(next.apiKey).toEqual(stored.apiKey);
    expect(readOpenAIApiKeyFromRow(next)).toBe(FAKE_API_KEY);
  });

  it("preserves the stored blob even when THIS process cannot decrypt it", () => {
    const stored = record(sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY }));
    // Key rotated: the read path drops the field fail-closed…
    process.env.CINATRA_ENCRYPTION_KEY = ROTATED_KEY_HEX;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const readBack = record(unsealOpenAIConnectionSecrets(stored).value);
    expect(readBack.apiKey).toBeUndefined();

    // …and an unrelated save must NOT destroy the operator's stored blob.
    const next = record(prepareSealedOpenAIConnectionWrite(readBack, stored));
    expect(next.apiKey).toEqual(stored.apiKey);
  });

  it("carries a LEGACY plaintext key forward (and seals it) instead of dropping it", () => {
    // An unrelated settings save on a not-yet-migrated instance must not delete
    // the operator's key — and it doubles as the upgrade-on-write.
    const legacyRow = { apiKey: FAKE_API_KEY, defaultModel: "gpt-5.5" };

    const next = record(
      prepareSealedOpenAIConnectionWrite({ loggingEnabled: false }, legacyRow),
    );

    expect(isSealed(next.apiKey)).toBe(true);
    expect(readOpenAIApiKeyFromRow(next)).toBe(FAKE_API_KEY);
    expect(JSON.stringify(next)).not.toContain(FAKE_API_KEY);
  });

  it("an explicit clear DROPS a legacy plaintext key too", () => {
    const legacyRow = { apiKey: FAKE_API_KEY };

    const cleared = record(
      prepareSealedOpenAIConnectionWrite({}, legacyRow, { preserveExistingSecret: false }),
    );

    expect(cleared.apiKey).toBeUndefined();
  });

  it("a new plaintext key REPLACES the stored sealed key", () => {
    const stored = record(sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY }));

    const next = prepareSealedOpenAIConnectionWrite({ apiKey: OTHER_FAKE_API_KEY }, stored);

    expect(readOpenAIApiKeyFromRow(next)).toBe(OTHER_FAKE_API_KEY);
    expect(JSON.stringify(next)).not.toContain(OTHER_FAKE_API_KEY);
  });

  it("an explicit clear DROPS the stored key instead of preserving it", () => {
    const stored = record(sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY }));

    const cleared = record(
      prepareSealedOpenAIConnectionWrite({ defaultModel: "gpt-5.5" }, stored, {
        preserveExistingSecret: false,
      }),
    );

    expect(cleared.apiKey).toBeUndefined();
    expect(readOpenAIApiKeyFromRow(cleared)).toBeUndefined();
  });
});

// =============================================================================
// 4. Fail-closed posture
// =============================================================================

describe("fail-closed posture", () => {
  it("a rotated encryption key drops the field and NEVER leaks material to the log", () => {
    const stored = sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY });
    const sealedBlob = record(stored).apiKey as { ciphertext: string; iv: string };
    process.env.CINATRA_ENCRYPTION_KEY = ROTATED_KEY_HEX;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { value, decryptFailed } = unsealOpenAIConnectionSecrets(stored);

    expect(record(value).apiKey).toBeUndefined();
    expect(decryptFailed).toBe(true);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain(OPENAI_CONNECTION_METADATA_KEY);
    expect(logged).not.toContain(FAKE_API_KEY);
    expect(logged).not.toContain(sealedBlob.ciphertext);
    expect(logged).not.toContain(sealedBlob.iv);
  });

  it("a blob sealed under a DIFFERENT field's AAD does not decrypt here", async () => {
    const { encryptSecret } = await import("@/lib/instance-secrets");
    const foreign = encryptSecret(FAKE_API_KEY, "connector_config:nango.secretKey");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { value, decryptFailed } = unsealOpenAIConnectionSecrets({
      apiKey: { __enc: 1, ...foreign },
    });

    expect(record(value).apiKey).toBeUndefined();
    expect(decryptFailed).toBe(true);
  });

  it("a missing encryption key makes the WRITE throw rather than persist plaintext", () => {
    delete process.env.CINATRA_ENCRYPTION_KEY;
    expect(() => sealOpenAIConnectionSecrets({ apiKey: FAKE_API_KEY })).toThrow(
      /CINATRA_ENCRYPTION_KEY/,
    );
  });

  it("a malformed at-rest value is dropped fail-closed on both read and write", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(record(sealOpenAIConnectionSecrets({ apiKey: 42 })).apiKey).toBeUndefined();
    const read = unsealOpenAIConnectionSecrets({ apiKey: { nope: true } });
    expect(record(read.value).apiKey).toBeUndefined();
    expect(read.decryptFailed).toBe(true);
  });

  it("readOpenAIApiKeyFromRow returns undefined for a blank or absent key", () => {
    expect(readOpenAIApiKeyFromRow({ apiKey: "" })).toBeUndefined();
    expect(readOpenAIApiKeyFromRow({})).toBeUndefined();
    expect(readOpenAIApiKeyFromRow(null)).toBeUndefined();
  });

  it("guards the field name the whole seam keys off", () => {
    expect(OPENAI_CONNECTION_SECRET_FIELD).toBe("apiKey");
    expect(OPENAI_CONNECTION_METADATA_KEY).toBe("openai_connection");
  });
});

// =============================================================================
// 5. Body-logging default — the second half of cinatra#2581
// =============================================================================

describe("OpenAI request/response body-logging default", () => {
  it("DEFAULTS OFF in production when the operator has never chosen", () => {
    // This is the original defect: the platform substituted a hard `true`
    // here, so every production instance wrote prompts and completions to a
    // local log file.
    expect(resolveOpenAIBodyLoggingDefault(undefined)).toBe(false);
  });

  it("DEFAULTS OFF in development too (\"dev-off\" ruling)", () => {
    // An unset preference used to resolve ON in development for local-
    // debugging convenience. The owner ruled that convenience default out —
    // an operator must opt in explicitly even on a dev box.
    expect(resolveOpenAIBodyLoggingDefault(undefined)).toBe(false);
  });

  it("an EXPLICIT operator preference always wins over the default", () => {
    expect(resolveOpenAIBodyLoggingDefault(true)).toBe(true);
    expect(resolveOpenAIBodyLoggingDefault(false)).toBe(false);
  });

  it("mirrors the openai-connector policy exactly (explicit ?? false)", () => {
    for (const explicit of [undefined, true, false] as const) {
      expect(resolveOpenAIBodyLoggingDefault(explicit)).toBe(explicit ?? false);
    }
  });
});
