/**
 * Manifest-declared env-override layer (cinatra#982) — precedence regression
 * tests against the REAL host factory (`createExtensionHostContext`), reusing
 * the same in-memory KV + controllable actor-org + fake GCM harness as
 * `extension-host-context-org-scoping.test.ts`.
 *
 * Proves:
 *   - env SET wins over a DB-stored value (settings + secrets);
 *   - env UNSET (or blank) falls back to the DB value exactly as before;
 *   - a legacy (non-namespaced) env name is honored ONLY for a
 *     `resolution: "required"` extension — REJECTED (falls through to DB) for
 *     a `guardedOptional` one;
 *   - a namespaced (`CINATRA_EXT_<PKG>_*`) env name is honored regardless of
 *     `resolution`;
 *   - BOOT-TIME resolution for a required systemExtension: when the env var is
 *     set, `settings.get`/`secrets.get` succeed even with NO resolvable actor/
 *     org (the webhook/boot-time call shape a required system extension like
 *     nango-connector needs) — proving the env-first check runs BEFORE the
 *     org-scoped DB path, never after.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { kv, orgRef } = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  orgRef: { current: null as string | null },
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: <T>(id: string, fallback: T): T =>
    kv.has(id) ? (kv.get(id) as T) : fallback,
  writeConnectorConfigToDatabase: (id: string, value: unknown): void => {
    kv.set(id, value);
  },
  deleteConnectorConfig: (id: string): void => {
    kv.delete(id);
  },
}));

vi.mock("@/lib/extension-host-actor", () => ({
  requireExtensionOrganizationId: async (pkg: string): Promise<string> => {
    if (!orgRef.current) {
      throw new Error(`[ExtensionHostContext] ${pkg}: no organizationId on the current actor`);
    }
    return orgRef.current;
  },
  resolveExtensionActorContext: async () => null,
  resolveExtensionActorSummary: async () => null,
}));

vi.mock("@/lib/instance-secrets", () => ({
  encryptSecret: (value: string, aad: string) => ({
    ciphertext: `${Buffer.from(value).toString("base64")}::${aad}`,
    iv: "iv",
  }),
  decryptSecret: (stored: { ciphertext: string; iv: string }, aad: string): string => {
    const [b64, boundAad] = stored.ciphertext.split("::");
    if (boundAad !== aad) throw new Error("GCM AAD mismatch — cross-tenant replay rejected");
    return Buffer.from(b64, "base64").toString("utf8");
  },
}));

import { createExtensionHostContext } from "@/lib/extension-host-context";

const REQUIRED_PKG = "@cinatra-ai/nango-connector";
const GUARDED_PKG = "@cinatra-ai/some-marketplace-connector";
// Every env var any test below actually sets — kept in sync deliberately (a
// stale/incomplete list here would leak an unrestored value across test
// files, exactly the class of bug codex round-0 flagged).
const ENV_VARS = [
  "NANGO_SECRET_KEY",
  "NANGO_SERVER_URL",
  "CINATRA_EXT_CINATRA_HAI_SSOME_HMARKETPLACE_HCONNECTOR__ENDPOINT",
] as const;

function snapshotEnv() {
  return Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_VARS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe("extension host context — manifest-declared env-override precedence (cinatra#982)", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    kv.clear();
    orgRef.current = null;
    envSnap = snapshotEnv();
    for (const k of ENV_VARS) delete process.env[k];
  });
  afterEach(() => restoreEnv(envSnap));

  it("env set wins over a DB-stored settings value (required system extension, legacy name)", async () => {
    orgRef.current = "orgA";
    const ctx = createExtensionHostContext(REQUIRED_PKG, ["settings"], {
      envOverrides: { NANGO_SERVER_URL: "settings:serverUrl" },
      resolution: "required",
    });
    await ctx.settings.set("serverUrl", "https://db-configured.example.com");
    expect(await ctx.settings.get("serverUrl")).toBe("https://db-configured.example.com");

    process.env.NANGO_SERVER_URL = "https://env-configured.example.com";
    expect(await ctx.settings.get("serverUrl")).toBe("https://env-configured.example.com");
  });

  it("env unset falls back to the DB value exactly as before (settings + secrets)", async () => {
    orgRef.current = "orgA";
    const ctx = createExtensionHostContext(REQUIRED_PKG, ["settings", "secrets"], {
      envOverrides: { NANGO_SERVER_URL: "settings:serverUrl", NANGO_SECRET_KEY: "secrets:secretKey" },
      resolution: "required",
    });
    await ctx.settings.set("serverUrl", "https://db.example.com");
    await ctx.secrets.set("secretKey", "db-secret");
    expect(await ctx.settings.get("serverUrl")).toBe("https://db.example.com");
    expect(await ctx.secrets.get("secretKey")).toBe("db-secret");
  });

  it("a blank env value (KEY= with empty string) is treated as unset, falling back to DB (matches nango's pre-existing `?.trim() || stored` precedence)", async () => {
    orgRef.current = "orgA";
    const ctx = createExtensionHostContext(REQUIRED_PKG, ["secrets"], {
      envOverrides: { NANGO_SECRET_KEY: "secrets:secretKey" },
      resolution: "required",
    });
    await ctx.secrets.set("secretKey", "db-secret");
    process.env.NANGO_SECRET_KEY = "   "; // blank after trim
    expect(await ctx.secrets.get("secretKey")).toBe("db-secret");
  });

  it("env set wins over a DB-stored secrets value", async () => {
    orgRef.current = "orgA";
    const ctx = createExtensionHostContext(REQUIRED_PKG, ["secrets"], {
      envOverrides: { NANGO_SECRET_KEY: "secrets:secretKey" },
      resolution: "required",
    });
    await ctx.secrets.set("secretKey", "db-secret");
    process.env.NANGO_SECRET_KEY = "env-secret";
    expect(await ctx.secrets.get("secretKey")).toBe("env-secret");
  });

  it("a legacy (non-namespaced) env name is REJECTED for a guardedOptional (marketplace) extension — falls through to DB, never honors the env value", async () => {
    orgRef.current = "orgA";
    const ctx = createExtensionHostContext(GUARDED_PKG, ["settings"], {
      envOverrides: { NANGO_SERVER_URL: "settings:serverUrl" }, // not namespaced to GUARDED_PKG
      resolution: "guardedOptional",
    });
    await ctx.settings.set("serverUrl", "https://db.example.com");
    process.env.NANGO_SERVER_URL = "https://attacker-controlled.example.com";
    // The rejected mapping never activates — DB value wins (env is ignored).
    expect(await ctx.settings.get("serverUrl")).toBe("https://db.example.com");
  });

  it("a namespaced env name (CINATRA_EXT_<PKG>_*) is honored for a guardedOptional (marketplace) extension", async () => {
    orgRef.current = "orgA";
    const ctx = createExtensionHostContext(GUARDED_PKG, ["settings"], {
      // Namespace is the INJECTIVE encoding of the FULL package name (scope
      // included) — "@cinatra-ai/some-marketplace-connector" ->
      // "CINATRA_HAI_SSOME_HMARKETPLACE_HCONNECTOR" (`-`->`_H`, `/`->`_S`), with
      // a `__` terminator before the key.
      envOverrides: { CINATRA_EXT_CINATRA_HAI_SSOME_HMARKETPLACE_HCONNECTOR__ENDPOINT: "settings:endpoint" },
      resolution: "guardedOptional",
    });
    await ctx.settings.set("endpoint", "https://db.example.com");
    process.env.CINATRA_EXT_CINATRA_HAI_SSOME_HMARKETPLACE_HCONNECTOR__ENDPOINT = "https://env.example.com";
    expect(await ctx.settings.get("endpoint")).toBe("https://env.example.com");
  });

  it("BOOT-TIME resolution for a required systemExtension: env set → settings.get succeeds with NO resolvable actor/org (webhook/boot-time shape)", async () => {
    orgRef.current = null; // no actor at all — the webhook-verification call shape
    const ctx = createExtensionHostContext(REQUIRED_PKG, ["settings", "secrets"], {
      envOverrides: { NANGO_SERVER_URL: "settings:serverUrl", NANGO_SECRET_KEY: "secrets:secretKey" },
      resolution: "required",
    });
    process.env.NANGO_SERVER_URL = "https://env.example.com";
    process.env.NANGO_SECRET_KEY = "env-secret";
    // Would normally reject with "no organizationId" — env short-circuits BEFORE
    // the org-scoped DB path is ever reached.
    await expect(ctx.settings.get("serverUrl")).resolves.toBe("https://env.example.com");
    await expect(ctx.secrets.get("secretKey")).resolves.toBe("env-secret");
  });

  it("with NO env override declared at all, behavior is unchanged (org-scoped DB read/write, unaffected by this feature)", async () => {
    orgRef.current = "orgA";
    const ctx = createExtensionHostContext(REQUIRED_PKG, ["settings"]); // no envInput passed
    expect(await ctx.settings.get("serverUrl")).toBeNull();
    await ctx.settings.set("serverUrl", "https://db.example.com");
    expect(await ctx.settings.get("serverUrl")).toBe("https://db.example.com");
  });

  it("a rejected env-override entry is logged (warn) but never throws — activation stays probe-safe", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      createExtensionHostContext(GUARDED_PKG, ["settings"], {
        envOverrides: { NANGO_SERVER_URL: "settings:serverUrl" },
        resolution: "guardedOptional",
      }),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
