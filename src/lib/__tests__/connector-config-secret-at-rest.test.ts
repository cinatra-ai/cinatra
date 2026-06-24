// Encrypt the Nango connector-config `secretKey` at rest.
//
// Two layers of coverage:
//   1. The transform primitives (`sealSecretFields` / `unsealSecretFields`) in
//      isolation — seal/unseal semantics, idempotency, AAD scoping, fail-closed.
//   2. The at-rest write/read orchestration (`prepareSealedWrite` +
//      `unsealSecretFields`) driven over an in-memory metadata KV through a
//      faithful re-implementation of the database.ts read/write wiring (cache +
//      seal-on-read migration). `@/lib/database` itself is an ASYNC module (its
//      import graph reaches `import()`-loaded externals via drizzle-store → pg
//      and objects-store → mcp-server), so it cannot be imported in a unit test;
//      the at-rest logic it calls lives entirely in
//      `connector-config-secret-fields` and is exercised directly here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalizeSealedFields,
  hasSecretFields,
  isSealed,
  prepareSealedWrite,
  sealSecretFields,
  secretFieldsFor,
  unsealSecretFields,
} from "@/lib/connector-config-secret-fields";

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

// =============================================================================
// 1. Transform-primitive coverage
// =============================================================================

describe("connector-config-secret-fields — transform primitives", () => {
  it("allow-map: nango has secretKey; an arbitrary connector has none", () => {
    expect(hasSecretFields("nango")).toBe(true);
    expect(secretFieldsFor("nango")).toEqual(["secretKey"]);
    expect(hasSecretFields("anthropic_connection")).toBe(false);
    expect(secretFieldsFor("anthropic_connection")).toEqual([]);
  });

  it("seal replaces a non-empty plaintext secretKey with a sealed object; serverUrl untouched", () => {
    const sealed = sealSecretFields("nango", {
      secretKey: "nango_sk_live_value",
      serverUrl: "https://nango.example.com",
    }) as Record<string, unknown>;
    expect(isSealed(sealed.secretKey)).toBe(true);
    expect(sealed.serverUrl).toBe("https://nango.example.com");
    // No plaintext substring of the secret survives in the serialized row.
    expect(JSON.stringify(sealed)).not.toContain("nango_sk_live_value");
  });

  it("round-trip: unseal returns the original plaintext secretKey", () => {
    const sealed = sealSecretFields("nango", { secretKey: "round_trip_secret" });
    const { value, sawLegacyPlaintext, decryptFailed } = unsealSecretFields("nango", sealed);
    expect((value as Record<string, unknown>).secretKey).toBe("round_trip_secret");
    expect(sawLegacyPlaintext).toBe(false);
    expect(decryptFailed).toBe(false);
  });

  it("idempotent: sealing an already-sealed value does not double-seal", () => {
    const once = sealSecretFields("nango", { secretKey: "abc" }) as Record<string, unknown>;
    const twice = sealSecretFields("nango", once) as Record<string, unknown>;
    expect(twice.secretKey).toEqual(once.secretKey);
    expect((unsealSecretFields("nango", twice).value as Record<string, unknown>).secretKey).toBe("abc");
  });

  it("AAD scoping: a tampered iv breaks the auth-tag/aad binding → field absent", () => {
    const sealed = sealSecretFields("nango", { secretKey: "scoped" }) as Record<string, unknown>;
    const tampered = {
      secretKey: {
        ...(sealed.secretKey as Record<string, unknown>),
        iv: Buffer.from("000000000000", "utf8").toString("base64"),
      },
    };
    const { value, decryptFailed } = unsealSecretFields("nango", tampered);
    expect(decryptFailed).toBe(true);
    expect("secretKey" in (value as Record<string, unknown>)).toBe(false);
  });

  it("legacy plaintext read-compat: a plaintext secretKey reads back unchanged + flagged", () => {
    const { value, sawLegacyPlaintext, decryptFailed } = unsealSecretFields("nango", {
      secretKey: "legacy_plaintext_secret",
    });
    expect((value as Record<string, unknown>).secretKey).toBe("legacy_plaintext_secret");
    expect(sawLegacyPlaintext).toBe(true);
    expect(decryptFailed).toBe(false);
  });

  it("fail-closed on corrupted ciphertext: field absent, no throw, redacted log carries no secret", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sealed = sealSecretFields("nango", { secretKey: "to_be_corrupted" }) as Record<string, unknown>;
    const corrupted = {
      secretKey: {
        ...(sealed.secretKey as Record<string, unknown>),
        ciphertext: Buffer.from("garbage-ciphertext-bytes").toString("base64"),
      },
    };
    const { value, decryptFailed } = unsealSecretFields("nango", corrupted);
    expect(decryptFailed).toBe(true);
    expect("secretKey" in (value as Record<string, unknown>)).toBe(false);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("to_be_corrupted");
    expect(logged).not.toContain((corrupted.secretKey as Record<string, unknown>).ciphertext as string);
  });

  it("malformed at write: a non-string/non-sealed secret field is dropped fail-closed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = sealSecretFields("nango", { secretKey: { junk: true } }) as Record<string, unknown>;
    expect("secretKey" in out).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("sealed-shaped value with a sidecar plaintext property is canonicalized (extras stripped, no plaintext at rest)", () => {
    // An externally-crafted value that passes the syntactic sealed-shape guard
    // but smuggles a plaintext sidecar must NOT be persisted/cached verbatim.
    const real = sealSecretFields("nango", { secretKey: "canon_secret" }) as Record<string, unknown>;
    const realSealed = real.secretKey as Record<string, unknown>;
    const smuggled = {
      secretKey: { ...realSealed, plaintext: "nango_sk_smuggled_value", extra: 42 },
    };
    const out = sealSecretFields("nango", smuggled) as Record<string, unknown>;
    expect(Object.keys(out.secretKey as Record<string, unknown>).sort()).toEqual([
      "__enc",
      "ciphertext",
      "iv",
    ]);
    expect(JSON.stringify(out)).not.toContain("nango_sk_smuggled_value");
    // Still a valid sealed blob that round-trips.
    expect((unsealSecretFields("nango", out).value as Record<string, unknown>).secretKey).toBe(
      "canon_secret",
    );
  });

  it("preserve-on-blank canonicalizes the preserved at-rest secret (no sidecar plaintext survives)", () => {
    const real = sealSecretFields("nango", { secretKey: "preserved_secret" }) as Record<string, unknown>;
    const currentRaw = {
      secretKey: { ...(real.secretKey as Record<string, unknown>), plaintext: "leak_via_preserve" },
      serverUrl: "https://nango.example.com",
    };
    // Incoming write omits the secret → preserve the existing sealed value.
    const out = prepareSealedWrite("nango", { serverUrl: "https://nango.example.com" }, currentRaw) as Record<
      string,
      unknown
    >;
    expect(Object.keys(out.secretKey as Record<string, unknown>).sort()).toEqual([
      "__enc",
      "ciphertext",
      "iv",
    ]);
    expect(JSON.stringify(out)).not.toContain("leak_via_preserve");
    expect((unsealSecretFields("nango", out).value as Record<string, unknown>).secretKey).toBe(
      "preserved_secret",
    );
  });

  it("empty/undefined secret fields are left as-is (no seal)", () => {
    const emptyStr = sealSecretFields("nango", { secretKey: "" }) as Record<string, unknown>;
    expect(emptyStr.secretKey).toBe("");
    const undef = sealSecretFields("nango", { secretKey: undefined, serverUrl: "x" }) as Record<string, unknown>;
    expect(undef.secretKey).toBeUndefined();
    expect(undef.serverUrl).toBe("x");
  });

  it("non-secret connector value passes through seal/unseal unchanged", () => {
    const v = { provider: "openai" };
    expect(sealSecretFields("llm_default_provider", v)).toEqual(v);
    expect(unsealSecretFields("llm_default_provider", v).value).toEqual(v);
  });

  it("seal throws fail-closed when the encryption key is missing (no plaintext persisted)", () => {
    delete process.env.CINATRA_ENCRYPTION_KEY;
    expect(() => sealSecretFields("nango", { secretKey: "x" })).toThrow(/CINATRA_ENCRYPTION_KEY/);
  });
});

// =============================================================================
// 2. At-rest write/read orchestration over an in-memory KV
//
// `fakeDb` mirrors the EXACT wiring database.ts applies around the real
// `prepareSealedWrite` / `unsealSecretFields`: write seals (with the raw current
// row for preserve-on-blank), cache holds the sealed value, read unseals on both
// cache HIT and MISS, and a legacy-plaintext read triggers a best-effort
// seal-on-read re-write.
// =============================================================================

function makeFakeDb() {
  const kv = new Map<string, string>(); // at-rest store (sealed JSON)
  const cache = new Map<string, unknown>(); // mirrors the connector-config cache

  function rawString(connectorId: string): string | null {
    return kv.get(`connector_config:${connectorId}`) ?? null;
  }

  function rawRow(connectorId: string): unknown {
    const raw = rawString(connectorId);
    return raw === null ? null : JSON.parse(raw);
  }

  // Atomic compare-and-swap: set the row to `newValue` only if the stored string
  // is byte-equal to `expectedRaw`. Returns true when the swap landed.
  function cas(connectorId: string, newValue: string, expectedRaw: string): boolean {
    const key = `connector_config:${connectorId}`;
    if (kv.get(key) !== expectedRaw) return false;
    kv.set(key, newValue);
    return true;
  }

  function write(connectorId: string, value: unknown): void {
    let toPersist = value;
    if (hasSecretFields(connectorId)) {
      const currentRaw = rawRow(connectorId);
      toPersist = prepareSealedWrite(connectorId, value, currentRaw);
    }
    kv.set(`connector_config:${connectorId}`, JSON.stringify(toPersist));
    cache.set(connectorId, structuredClone(toPersist)); // cache the SEALED value
  }

  // `beforeMigrationCas` is a test seam: invoked AFTER the read snapshot is taken
  // but BEFORE the migration's CAS, to simulate a concurrent writer rotating the
  // row.
  function read<T>(
    connectorId: string,
    fallback: T,
    beforeMigrationCas?: () => void,
  ): T {
    const cached = cache.get(connectorId);
    if (cached !== undefined) {
      if (!hasSecretFields(connectorId)) return structuredClone(cached) as T;
      return unsealSecretFields(connectorId, structuredClone(cached)).value as T;
    }
    if (!hasSecretFields(connectorId)) {
      const raw = rawRow(connectorId);
      const value = (raw === null ? fallback : raw) as T;
      cache.set(connectorId, structuredClone(value));
      return structuredClone(value);
    }
    // Byte-accurate snapshot for the CAS.
    const observedRaw = rawString(connectorId);
    const value = (observedRaw === null ? fallback : JSON.parse(observedRaw)) as T;
    const { value: unsealed, sawLegacyPlaintext } = unsealSecretFields(
      connectorId,
      structuredClone(value),
    );
    // MF#1: defer caching for the legacy-plaintext case so plaintext never sits
    // in cache if the migration fails. Only cache the already-sealed at-rest
    // value now.
    if (!sawLegacyPlaintext) {
      // MF#1: canonicalize the designated sealed fields before caching so a
      // sealed-shaped row with sidecar properties never seeds plaintext into
      // the cache (mirrors database.ts).
      cache.set(connectorId, structuredClone(canonicalizeSealedFields(connectorId, value)));
      return unsealed as T;
    }
    // Atomic seal-on-read migration (MF#3 race): seal then CAS on the byte
    // snapshot; only cache the SEALED value on a landed swap.
    try {
      const sealed = prepareSealedWrite(connectorId, unsealed, value);
      const sealedRaw = JSON.stringify(sealed);
      beforeMigrationCas?.(); // simulate a concurrent write before the CAS
      if (observedRaw !== null && cas(connectorId, sealedRaw, observedRaw)) {
        cache.set(connectorId, structuredClone(sealed));
      } else {
        cache.delete(connectorId); // row changed under us — never cache plaintext
      }
    } catch {
      cache.delete(connectorId); // migration failed — never cache plaintext
    }
    return unsealed as T;
  }

  return { kv, cache, rawRow, write, read };
}

describe("connector-config at-rest orchestration — nango secretKey", () => {
  it("(a) encrypt-on-write: at-rest row holds a sealed secretKey, no plaintext; serverUrl stays plaintext", () => {
    const db = makeFakeDb();
    db.write("nango", { secretKey: "atrest_secret_value", serverUrl: "https://nango.example.com" });
    const row = db.rawRow("nango") as Record<string, unknown>;
    expect(isSealed(row.secretKey)).toBe(true);
    expect(row.serverUrl).toBe("https://nango.example.com");
    expect(db.kv.get("connector_config:nango")).not.toContain("atrest_secret_value");
  });

  it("(b) decrypt-on-read round-trip (cache MISS) returns the plaintext secretKey", () => {
    const db = makeFakeDb();
    db.write("nango", { secretKey: "roundtrip_atrest", serverUrl: "u" });
    db.cache.clear(); // force a cache MISS / raw read
    const read = db.read<Record<string, unknown>>("nango", {});
    expect(read.secretKey).toBe("roundtrip_atrest");
    expect(read.serverUrl).toBe("u");
  });

  it("(h) cache holds ciphertext, not plaintext; a cache HIT still returns plaintext", () => {
    const db = makeFakeDb();
    db.write("nango", { secretKey: "cache_secret", serverUrl: "u" });
    const entry = db.cache.get("nango") as Record<string, unknown>;
    expect(isSealed(entry.secretKey)).toBe(true);
    const read = db.read<Record<string, unknown>>("nango", {}); // cache HIT
    expect(read.secretKey).toBe("cache_secret");
    expect(isSealed((db.cache.get("nango") as Record<string, unknown>).secretKey)).toBe(true);
  });

  it("(h2) read of a sealed-shaped at-rest row with a sidecar plaintext never seeds that plaintext into the cache", () => {
    const db = makeFakeDb();
    const real = sealSecretFields("nango", { secretKey: "real_secret" }) as Record<string, unknown>;
    const contaminated = {
      secretKey: { ...(real.secretKey as Record<string, unknown>), plaintext: "sidecar_leak_value" },
      serverUrl: "u",
    };
    // Simulate a contaminated row arriving via a lower-level metadata write.
    db.kv.set("connector_config:nango", JSON.stringify(contaminated));
    const read = db.read<Record<string, unknown>>("nango", {}); // cache MISS → populates cache
    expect(read.secretKey).toBe("real_secret");
    const cached = db.cache.get("nango") as Record<string, unknown>;
    expect(Object.keys(cached.secretKey as Record<string, unknown>).sort()).toEqual([
      "__enc",
      "ciphertext",
      "iv",
    ]);
    expect(JSON.stringify(cached)).not.toContain("sidecar_leak_value");
  });

  it("(h3) read of a malformed non-sealed secretKey object never caches the raw value (dropped fail-closed)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeFakeDb();
    // A non-sealed object that smuggles plaintext but is NOT a legacy plaintext
    // string and NOT sealed-shaped (no __enc/ciphertext/iv).
    const malformed = { secretKey: { not_sealed: true, plaintext: "malformed_leak" }, serverUrl: "u" };
    db.kv.set("connector_config:nango", JSON.stringify(malformed));
    const read = db.read<Record<string, unknown>>("nango", {}); // cache MISS
    expect("secretKey" in read).toBe(false); // fail-closed for the caller
    const cached = db.cache.get("nango") as Record<string, unknown>;
    expect("secretKey" in cached).toBe(false); // and dropped from cache
    expect(JSON.stringify(cached)).not.toContain("malformed_leak");
  });

  it("(c) AAD scoping at the DB layer: a tampered sealed blob fails closed on read", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeFakeDb();
    const foreign = sealSecretFields("nango", { secretKey: "x" }) as Record<string, unknown>;
    const swapped = {
      secretKey: { ...(foreign.secretKey as Record<string, unknown>), iv: Buffer.from("1".repeat(12)).toString("base64") },
    };
    db.kv.set("connector_config:nango", JSON.stringify(swapped));
    const read = db.read<Record<string, unknown>>("nango", {});
    expect("secretKey" in read).toBe(false); // fail-closed → Nango unconfigured
  });

  it("(d) legacy plaintext read-compat: a plaintext row reads back unchanged", () => {
    const db = makeFakeDb();
    db.kv.set("connector_config:nango", JSON.stringify({ secretKey: "legacy_db_plain", serverUrl: "u" }));
    const read = db.read<Record<string, unknown>>("nango", {});
    expect(read.secretKey).toBe("legacy_db_plain");
  });

  it("(e) seal-on-read migration: a legacy plaintext row is sealed at rest after a read", () => {
    const db = makeFakeDb();
    db.kv.set("connector_config:nango", JSON.stringify({ secretKey: "migrate_me", serverUrl: "u" }));
    const read = db.read<Record<string, unknown>>("nango", {});
    expect(read.secretKey).toBe("migrate_me"); // caller still sees plaintext
    const row = db.rawRow("nango") as Record<string, unknown>;
    expect(isSealed(row.secretKey)).toBe(true); // ...row now sealed at rest
    expect(db.kv.get("connector_config:nango")).not.toContain("migrate_me");
  });

  it("(e2) seal-on-read migration is best-effort: missing key returns plaintext, no throw, stays plaintext, NO plaintext cached", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeFakeDb();
    db.kv.set("connector_config:nango", JSON.stringify({ secretKey: "no_key_plain", serverUrl: "u" }));
    delete process.env.CINATRA_ENCRYPTION_KEY;
    const read = db.read<Record<string, unknown>>("nango", {});
    expect(read.secretKey).toBe("no_key_plain"); // returned for compat
    const row = db.rawRow("nango") as Record<string, unknown>;
    expect(row.secretKey).toBe("no_key_plain"); // migration could not seal → stays plaintext
    // MF#1: the failed migration must NOT have left plaintext in the cache.
    expect(db.cache.has("nango")).toBe(false);
  });

  it("(e3) MF#1 cache integrity: a failed migration leaves no plaintext in cache across reads", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeFakeDb();
    db.kv.set("connector_config:nango", JSON.stringify({ secretKey: "leak_check", serverUrl: "u" }));
    delete process.env.CINATRA_ENCRYPTION_KEY;
    db.read<Record<string, unknown>>("nango", {}); // migration fails, no cache
    // Any cache entry that DOES exist must never hold plaintext for secretKey.
    const entry = db.cache.get("nango") as Record<string, unknown> | undefined;
    if (entry !== undefined) {
      expect(typeof entry.secretKey === "string").toBe(false);
    }
  });

  it("(e4) seal-on-read migration is CAS-guarded: a concurrent newer write is not clobbered by stale legacy data", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Build a db whose rawRow returns the LEGACY value first (the read snapshot)
    // but a NEWER sealed write by the time the migration re-reads. Simulate by
    // swapping the kv row mid-read via a one-shot getter.
    const db = makeFakeDb();
    db.kv.set("connector_config:nango", JSON.stringify({ secretKey: "stale_legacy", serverUrl: "old" }));
    // A concurrent writer rotates the secret to a freshly sealed value AFTER the
    // read snapshot is taken but BEFORE the migration's CAS re-read.
    const newSealed = sealSecretFields("nango", { secretKey: "rotated_new", serverUrl: "new" });
    db.read<Record<string, unknown>>("nango", {}, () => {
      db.kv.set("connector_config:nango", JSON.stringify(newSealed));
    });
    // The newer rotated secret must survive — migration must NOT overwrite it.
    const finalRow = db.rawRow("nango") as Record<string, unknown>;
    expect(isSealed(finalRow.secretKey)).toBe(true);
    expect(finalRow).toEqual(newSealed); // not clobbered by "stale_legacy"
  });

  it("(g) non-secret keys are untouched: plaintext stored as before", () => {
    const db = makeFakeDb();
    db.write("llm_default_provider", "openai");
    expect(db.kv.get("connector_config:llm_default_provider")).toBe(JSON.stringify("openai"));
    expect(db.read<string>("llm_default_provider", "openai")).toBe("openai");
  });

  it("(i) idempotent write: re-writing a read (plaintext) value keeps a single seal that still decrypts", () => {
    const db = makeFakeDb();
    db.write("nango", { secretKey: "idem_secret", serverUrl: "u" });
    db.cache.clear();
    const read = db.read<Record<string, unknown>>("nango", {});
    db.write("nango", read); // re-write the unsealed clone
    const row = db.rawRow("nango") as Record<string, unknown>;
    expect(isSealed(row.secretKey)).toBe(true);
    db.cache.clear();
    expect(db.read<Record<string, unknown>>("nango", {}).secretKey).toBe("idem_secret");
  });

  it("(j) preserve-on-blank-save: a serverUrl-only write keeps the existing sealed secret", () => {
    const db = makeFakeDb();
    db.write("nango", { secretKey: "preserve_me", serverUrl: "old" });
    const sealedBefore = (db.rawRow("nango") as Record<string, unknown>).secretKey;
    db.write("nango", { serverUrl: "new" }); // wizard re-saves serverUrl only
    const row = db.rawRow("nango") as Record<string, unknown>;
    expect(row.serverUrl).toBe("new");
    expect(isSealed(row.secretKey)).toBe(true);
    expect(row.secretKey).toEqual(sealedBefore); // same sealed blob preserved
    db.cache.clear();
    const read = db.read<Record<string, unknown>>("nango", {});
    expect(read.secretKey).toBe("preserve_me");
    expect(read.serverUrl).toBe("new");
  });

  it("(k) env-override-equivalent: a DB decrypt-failure (key rotation) leaves secretKey absent so env override can win", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeFakeDb();
    db.write("nango", { secretKey: "rotated_out", serverUrl: "u" });
    db.cache.clear();
    process.env.CINATRA_ENCRYPTION_KEY = ROTATED_KEY_HEX; // rotate → decrypt fails
    const read = db.read<Record<string, unknown>>("nango", {});
    // secretKey absent → the connector's `NANGO_SECRET_KEY || stored.secretKey`
    // env-override path supplies the value; the host never persisted the env
    // value (migration only re-seals DB-stored plaintext, never the env value).
    expect("secretKey" in read).toBe(false);
    expect(read.serverUrl).toBe("u");
  });
});
