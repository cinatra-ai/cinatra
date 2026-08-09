// cinatra#2581 — end-to-end behaviour of the openai-connection STORE over an
// in-memory `cinatra.metadata` KV.
//
// The at-rest transform is unit-tested in `openai-connection-at-rest.test.ts`
// against `@/lib/connector-config-secret-fields`;
// this file proves the STORE actually applies it on every path an operator can
// reach — save, disconnect, logging toggle, prompt-caching toggle — and that the
// default configuration never turns on OpenAI request/response body logging.
//
// Only `@/lib/database-metadata`'s LIVE Postgres binding is stubbed — the
// accessors it re-exports are the real ones from
// `@/lib/connector-config-secret-fields`, bound here to an in-memory KV port that
// performs the same JSON round-trip the metadata row does. So the seal, the
// migration and the merge-and-swap under test are all real code, and what the
// assertions inspect is exactly what would be persisted.
//
// SECRETS: obviously-fake placeholder keys only; assertions are on SHAPE.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isSealed } from "@/lib/connector-config-secret-fields";

const FAKE_API_KEY = "sk-FAKE-openai-store-key-0000";
const OTHER_FAKE_API_KEY = "sk-FAKE-openai-store-key-1111";
const VALID_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// In-memory metadata KV standing in for the Postgres `metadata` table.
// ---------------------------------------------------------------------------

const kv = new Map<string, string>();

/**
 * Fires ONCE, immediately after the write path has observed the row's raw bytes
 * and before it persists — the exact instant a competing writer would land. This
 * is how the race tests below prove the merge-and-swap is atomic rather than
 * merely "reads fresh".
 */
const raceHook = vi.hoisted(() => ({ injectAfterReadRaw: null as null | (() => void) }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The store's at-rest accessors are the REAL implementations from
// `@/lib/connector-config-secret-fields`, bound here to an in-memory port instead
// of Postgres. Only the LIVE binding module is stubbed — the seal, the migration
// and the merge-and-swap under test are all real code.
vi.mock("@/lib/database-metadata", async () => {
  const real = await import("@/lib/connector-config-secret-fields");
  const port: import("@/lib/connector-config-secret-fields").OpenAIConnectionMetadataPort = {
    readValue: <T,>(key: string, fallback: T): T => {
      const raw = kv.get(key);
      return raw === undefined ? fallback : (JSON.parse(raw) as T);
    },
    readRaw: (key: string) => {
      const observed = kv.get(key) ?? null;
      const inject = raceHook.injectAfterReadRaw;
      if (inject) {
        raceHook.injectAfterReadRaw = null;
        inject();
      }
      return observed;
    },
    // INSERT ... ON CONFLICT DO NOTHING — never clobbers a racing creator.
    insertIfAbsent: (key: string, value: unknown) => {
      if (!kv.has(key)) kv.set(key, JSON.stringify(value));
    },
    compareAndSwap: (key: string, newValue: string, expectedRaw: string) => {
      if (kv.get(key) !== expectedRaw) return false;
      kv.set(key, newValue);
      return true;
    },
  };
  return {
    readUnsealedOpenAIConnectionRow: () => real.readUnsealedOpenAIConnectionRowVia(port),
    readRawOpenAIConnectionRow: () => real.readRawOpenAIConnectionRowVia(port),
    writeSealedOpenAIConnectionRow: (
      next: unknown,
      options?: { preserveExistingSecret?: boolean },
    ) => real.writeSealedOpenAIConnectionRowVia(port, next, options),
    upgradeLegacyOpenAIConnectionRow: () => real.upgradeLegacyOpenAIConnectionRowVia(port),
  };
});

const runtimeMode = vi.hoisted(() => ({ development: false }));
vi.mock("@/lib/runtime-mode", () => ({
  isAppDevelopmentMode: () => runtimeMode.development,
}));

const ORIGINAL_KEY = process.env.CINATRA_ENCRYPTION_KEY;

beforeEach(() => {
  kv.clear();
  raceHook.injectAfterReadRaw = null;
  runtimeMode.development = false;
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

/** The row exactly as it sits at rest. */
function storedRow(): Record<string, unknown> {
  return JSON.parse(kv.get("openai_connection") ?? "null") as Record<string, unknown>;
}

/** The raw stored JSON — what a `SELECT value FROM metadata` would return. */
function storedRaw(): string {
  return kv.get("openai_connection") ?? "";
}

async function store() {
  return import("@/lib/openai-connection-store");
}

// =============================================================================
// At rest
// =============================================================================

describe("openai-connection-store — key at rest", () => {
  it("saving a key persists a SEALED blob, never the plaintext", async () => {
    const { updateOpenAIConnection } = await store();

    await updateOpenAIConnection({ apiKey: FAKE_API_KEY, defaultModel: "gpt-5.5" });

    expect(isSealed(storedRow().apiKey)).toBe(true);
    expect(storedRaw()).not.toContain(FAKE_API_KEY);
  });

  it("reading back returns the plaintext key (round-trip through the store)", async () => {
    const { updateOpenAIConnection, readOpenAIConnection } = await store();

    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });

    expect(readOpenAIConnection()?.apiKey).toBe(FAKE_API_KEY);
  });

  it("an unrelated toggle re-persists the key sealed and does not lose it", async () => {
    const { updateOpenAIConnection, updateOpenAIPromptCaching, readOpenAIConnection } =
      await store();
    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });

    await updateOpenAIPromptCaching(true);

    expect(isSealed(storedRow().apiKey)).toBe(true);
    expect(storedRaw()).not.toContain(FAKE_API_KEY);
    expect(readOpenAIConnection()?.apiKey).toBe(FAKE_API_KEY);
  });

  it("rotating the key to a new value replaces the sealed blob", async () => {
    const { updateOpenAIConnection, readOpenAIConnection } = await store();
    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });

    await updateOpenAIConnection({ apiKey: OTHER_FAKE_API_KEY });

    expect(readOpenAIConnection()?.apiKey).toBe(OTHER_FAKE_API_KEY);
    expect(storedRaw()).not.toContain(OTHER_FAKE_API_KEY);
    expect(storedRaw()).not.toContain(FAKE_API_KEY);
  });

  it("disconnecting actually DROPS the stored key", async () => {
    const { updateOpenAIConnection, clearOpenAIConnection, readOpenAIConnection } =
      await store();
    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });

    await clearOpenAIConnection();

    expect(storedRow().apiKey).toBeUndefined();
    expect(readOpenAIConnection()?.apiKey).toBeUndefined();
  });
});

// =============================================================================
// Lost-update races: an unrelated save must never resurrect a removed key
// =============================================================================

describe("openai-connection-store — a settings save cannot resurrect a key", () => {
  it("a prompt-caching toggle that RACES a disconnect does not bring the key back", async () => {
    const { updateOpenAIConnection, updateOpenAIPromptCaching, clearOpenAIConnection } =
      await store();
    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });

    // The toggle takes its snapshot of the connection…
    const { readOpenAIConnection } = await store();
    const snapshot = readOpenAIConnection();
    expect(snapshot?.apiKey).toBe(FAKE_API_KEY);
    // …another request disconnects OpenAI…
    await clearOpenAIConnection();
    // …and only then does the toggle write.
    await updateOpenAIPromptCaching(true);

    expect(storedRow().apiKey).toBeUndefined();
    expect(readOpenAIConnection()?.apiKey).toBeUndefined();
    expect(storedRow().promptCachingEnabled).toBe(true);
  });

  it("a logging toggle that RACES a key rotation does not undo the rotation", async () => {
    const { updateOpenAIConnection, updateOpenAILoggingEnabled, readOpenAIConnection } =
      await store();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });

    readOpenAIConnection(); // stale snapshot holding the OLD key
    await updateOpenAIConnection({ apiKey: OTHER_FAKE_API_KEY });
    await updateOpenAILoggingEnabled(true);

    expect(readOpenAIConnection()?.apiKey).toBe(OTHER_FAKE_API_KEY);
    expect(storedRaw()).not.toContain(FAKE_API_KEY);
  });

  it("a disconnect landing INSIDE the write (after its read, before its persist) still wins", async () => {
    // The merge-and-swap must be atomic, not merely read-fresh: this injects the
    // competing write between the write path's own raw read and its persist.
    const { updateOpenAIConnection, updateOpenAIPromptCaching, readOpenAIConnection } =
      await store();
    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });

    raceHook.injectAfterReadRaw = () => {
      // Another request disconnects OpenAI right here.
      const row = JSON.parse(kv.get("openai_connection") ?? "{}") as Record<string, unknown>;
      delete row.apiKey;
      kv.set("openai_connection", JSON.stringify(row));
    };

    await updateOpenAIPromptCaching(true);

    expect(storedRow().apiKey).toBeUndefined();
    expect(readOpenAIConnection()?.apiKey).toBeUndefined();
    expect(storedRow().promptCachingEnabled).toBe(true);
  });

  it("a prompt-caching toggle cannot UNDO a body-logging opt-out that lands inside its write", async () => {
    // The whole read-modify-write must be atomic, not just the secret: an
    // unrelated toggle re-enabling body logging would silently undo an operator's
    // explicit "do not write my prompts to disk" choice.
    const { updateOpenAILoggingEnabled, updateOpenAIPromptCaching, readOpenAIConnection } =
      await store();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await updateOpenAILoggingEnabled(true);

    raceHook.injectAfterReadRaw = () => {
      // Another request explicitly disables body logging right here.
      const row = JSON.parse(kv.get("openai_connection") ?? "{}") as Record<string, unknown>;
      row.loggingEnabled = false;
      kv.set("openai_connection", JSON.stringify(row));
    };

    await updateOpenAIPromptCaching(true);

    // Both survive: the opt-out is respected AND the caching toggle applied.
    expect(storedRow().loggingEnabled).toBe(false);
    expect(storedRow().promptCachingEnabled).toBe(true);
    expect(readOpenAIConnection()?.loggingEnabled).toBe(false);
  });

  it("a model-only save that RACES a disconnect does not bring the key back", async () => {
    const { updateOpenAIConnection, clearOpenAIConnection, readOpenAIConnection } =
      await store();
    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });
    readOpenAIConnection(); // stale snapshot

    await clearOpenAIConnection();
    await updateOpenAIConnection({ defaultModel: "gpt-5.5" });

    expect(storedRow().apiKey).toBeUndefined();
    expect(storedRow().defaultModel).toBe("gpt-5.5");
  });
});

// =============================================================================
// Legacy row: reads, and upgrades
// =============================================================================

describe("openai-connection-store — legacy plaintext row", () => {
  it("still READS a legacy plaintext row", async () => {
    kv.set(
      "openai_connection",
      JSON.stringify({ apiKey: FAKE_API_KEY, defaultModel: "gpt-5.5" }),
    );
    const { readOpenAIConnection } = await store();

    expect(readOpenAIConnection()?.apiKey).toBe(FAKE_API_KEY);
  });

  it("UPGRADES the legacy row to sealed on read (compare-and-swap, no migration file)", async () => {
    kv.set(
      "openai_connection",
      JSON.stringify({ apiKey: FAKE_API_KEY, defaultModel: "gpt-5.5" }),
    );
    const { readOpenAIConnection } = await store();

    readOpenAIConnection();

    expect(isSealed(storedRow().apiKey)).toBe(true);
    expect(storedRaw()).not.toContain(FAKE_API_KEY);
    // …and the upgraded row still reads back correctly.
    expect(readOpenAIConnection()?.apiKey).toBe(FAKE_API_KEY);
    expect(storedRow().defaultModel).toBe("gpt-5.5");
  });

  it("the RUNTIME reader migrates too — not only the settings surface", async () => {
    // `@/lib/database#readOpenAIConnectionFromDatabase` (published to the
    // openai-connector as `readRowFromDatabase`, and therefore the path that
    // resolves the credential on every LLM call) goes through this same shared
    // accessor. Without the migration here, an instance that uses OpenAI but
    // never opens a settings page would keep its key in plaintext forever.
    kv.set("openai_connection", JSON.stringify({ apiKey: FAKE_API_KEY }));
    const { readUnsealedOpenAIConnectionRow } = await import("@/lib/database-metadata");

    expect(readUnsealedOpenAIConnectionRow()?.apiKey).toBe(FAKE_API_KEY);

    expect(isSealed(storedRow().apiKey)).toBe(true);
    expect(storedRaw()).not.toContain(FAKE_API_KEY);
    // The migrated row still resolves for the next call.
    expect(readUnsealedOpenAIConnectionRow()?.apiKey).toBe(FAKE_API_KEY);
  });

  it("the migration CAS does not clobber a write that landed under it", async () => {
    kv.set("openai_connection", JSON.stringify({ apiKey: FAKE_API_KEY }));
    const { upgradeLegacyOpenAIConnectionRow } = await import("@/lib/database-metadata");
    // A concurrent writer replaces the row between the snapshot and the swap.
    const rotated = JSON.stringify({ apiKey: OTHER_FAKE_API_KEY });
    raceHook.injectAfterReadRaw = () => kv.set("openai_connection", rotated);

    upgradeLegacyOpenAIConnectionRow();

    // The stale re-seal was rejected; the newer row survives untouched.
    expect(kv.get("openai_connection")).toBe(rotated);
  });

  it("UPGRADES on write even if no read preceded it", async () => {
    kv.set("openai_connection", JSON.stringify({ apiKey: FAKE_API_KEY }));
    const { updateOpenAILoggingEnabled } = await store();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await updateOpenAILoggingEnabled(false);

    expect(isSealed(storedRow().apiKey)).toBe(true);
    expect(storedRaw()).not.toContain(FAKE_API_KEY);
  });
});

// =============================================================================
// Body logging — default OFF, and the preference is never silently frozen
// =============================================================================

describe("openai-connection-store — request/response body logging", () => {
  it("DEFAULT CONFIG does not enable body logging (production)", async () => {
    const { updateOpenAIConnection, readOpenAIConnection } = await store();

    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });

    expect(readOpenAIConnection()?.loggingEnabled).toBe(false);
    // The unexpressed preference is not frozen into the row either.
    expect(storedRow().loggingEnabled).toBeUndefined();
  });

  it("defaults ON in development only", async () => {
    runtimeMode.development = true;
    const { updateOpenAIConnection, readOpenAIConnection } = await store();

    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });

    expect(readOpenAIConnection()?.loggingEnabled).toBe(true);
    expect(storedRow().loggingEnabled).toBeUndefined();
  });

  it("a dev-mode save does NOT freeze `true` into a row that later runs in production", async () => {
    runtimeMode.development = true;
    const { updateOpenAIConnection, readOpenAIConnection } = await store();
    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });

    // Same row, promoted to a production deployment.
    runtimeMode.development = false;

    expect(readOpenAIConnection()?.loggingEnabled).toBe(false);
  });

  it("an EXPLICIT operator opt-in is persisted and survives unrelated saves", async () => {
    const { updateOpenAILoggingEnabled, updateOpenAIPromptCaching, readOpenAIConnection } =
      await store();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await updateOpenAILoggingEnabled(true);
    expect(storedRow().loggingEnabled).toBe(true);

    await updateOpenAIPromptCaching(true);
    expect(storedRow().loggingEnabled).toBe(true);
    expect(readOpenAIConnection()?.loggingEnabled).toBe(true);
  });

  it("an EXPLICIT opt-out is persisted (not collapsed back into the default)", async () => {
    runtimeMode.development = true;
    const { updateOpenAILoggingEnabled, readOpenAIConnection } = await store();

    await updateOpenAILoggingEnabled(false);

    expect(storedRow().loggingEnabled).toBe(false);
    expect(readOpenAIConnection()?.loggingEnabled).toBe(false);
  });

  it("enabling body logging emits a loud warning that carries NO key material", async () => {
    const { updateOpenAIConnection, updateOpenAILoggingEnabled } = await store();
    await updateOpenAIConnection({ apiKey: FAKE_API_KEY });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await updateOpenAILoggingEnabled(true);

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toMatch(/body logging ENABLED/i);
    expect(logged).not.toContain(FAKE_API_KEY);
  });

  it("disconnecting keeps an explicit logging preference intact", async () => {
    const { updateOpenAILoggingEnabled, clearOpenAIConnection } = await store();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await updateOpenAILoggingEnabled(true);

    await clearOpenAIConnection();

    expect(storedRow().loggingEnabled).toBe(true);
  });
});

// =============================================================================
// No key material anywhere in the default-configuration log stream
// =============================================================================

describe("openai-connection-store — logs never carry key material", () => {
  it("a full default-config save/read cycle logs nothing containing the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { updateOpenAIConnection, readOpenAIConnection, clearOpenAIConnection } =
      await store();

    await updateOpenAIConnection({ apiKey: FAKE_API_KEY, projectId: "proj_fake" });
    readOpenAIConnection();
    await clearOpenAIConnection();

    const everything = [...warn.mock.calls, ...log.mock.calls, ...error.mock.calls]
      .flat()
      .join(" ");
    expect(everything).not.toContain(FAKE_API_KEY);
  });
});
