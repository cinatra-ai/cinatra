import { describe, it, expect } from "vitest";
import {
  parseEnvOverrideTarget,
  envNamespaceForPackage,
  envNamespacePrefixForPackage,
  isNamespacedEnvKey,
  validateEnvOverrides,
  splitEnvOverridesByPort,
} from "../env-overrides";

describe("parseEnvOverrideTarget", () => {
  it("parses settings:<key> and secrets:<key>", () => {
    expect(parseEnvOverrideTarget("settings:serverUrl")).toEqual({ port: "settings", key: "serverUrl" });
    expect(parseEnvOverrideTarget("secrets:secretKey")).toEqual({ port: "secrets", key: "secretKey" });
  });

  it("rejects any other shape", () => {
    expect(parseEnvOverrideTarget("db:foo")).toBeNull();
    expect(parseEnvOverrideTarget("settings:")).toBeNull();
    expect(parseEnvOverrideTarget("settings")).toBeNull();
    expect(parseEnvOverrideTarget("")).toBeNull();
    // @ts-expect-error — deliberately non-string input at the JSON boundary
    expect(parseEnvOverrideTarget(123)).toBeNull();
  });
});

describe("envNamespaceForPackage / isNamespacedEnvKey", () => {
  it("derives the namespace from the FULL package name (scope included) via an INJECTIVE, `__`-free encoding (each separator -> `_`+marker)", () => {
    // `-`->`_H`, `_`->`_U`, `.`->`_D`, `/`->`_S`; alnum passes through uppercased.
    expect(envNamespaceForPackage("@cinatra-ai/nango-connector")).toBe("CINATRA_HAI_SNANGO_HCONNECTOR");
    expect(envNamespaceForPackage("@acme/acme-crm")).toBe("ACME_SACME_HCRM");
    expect(envNamespaceForPackage("simple")).toBe("SIMPLE");
    // no `__` is ever produced (the property the `__` key-terminator relies on).
    for (const p of ["@cinatra-ai/nango-connector", "@acme/acme-crm", "@a/b.c_d-e"]) {
      expect(envNamespaceForPackage(p)).not.toContain("__");
    }
  });

  it("REGRESSION (codex round-0): different scopes whose SLUG normalizes the same do NOT collide — the scope is part of the namespace", () => {
    expect(envNamespaceForPackage("@trusted/foo-bar")).not.toBe(envNamespaceForPackage("@attacker/foo_bar"));
    expect(envNamespaceForPackage("@trusted/foo-bar")).toBe("TRUSTED_SFOO_HBAR");
    expect(envNamespaceForPackage("@attacker/foo_bar")).toBe("ATTACKER_SFOO_UBAR");
  });

  it("REGRESSION (codex round-1): CROSS-scope collisions via `/`<->`-`<->`_` ambiguity are eliminated — the encoding is injective", () => {
    // A lossy "collapse every run to `_`" derivation maps all three of these
    // DISTINCT (independently-ownable) package names to the SAME `ACME_FOO_BAR`,
    // letting an extension in one scope claim an env key namespaced to another.
    const a = envNamespaceForPackage("@acme-foo/bar"); // scope `@acme-foo`
    const b = envNamespaceForPackage("@acme/foo-bar"); // scope `@acme`
    const c = envNamespaceForPackage("@acme/foo_bar"); // scope `@acme`
    expect(new Set([a, b, c]).size).toBe(3);
    expect([a, b, c]).toEqual(["ACME_HFOO_SBAR", "ACME_SFOO_HBAR", "ACME_SFOO_UBAR"]);
  });

  it("REGRESSION (codex round-1): PREFIX escalation is eliminated — a shorter package name cannot claim a longer one's namespaced key", () => {
    // `@acme/foo`'s namespace (`ACME_SFOO`) is a STRING-prefix of
    // `@acme/foo-bar`'s (`ACME_SFOO_HBAR`). With a single-`_` terminator the
    // shorter package's prefix would `startsWith`-match the longer's keys; the
    // `__` terminator + `__`-free namespaces prevent it.
    const longKey = "CINATRA_EXT_ACME_SFOO_HBAR__SECRET"; // belongs to @acme/foo-bar
    expect(isNamespacedEnvKey("@acme/foo-bar", longKey)).toBe(true);
    expect(isNamespacedEnvKey("@acme/foo", longKey)).toBe(false);
  });

  it("computes the required prefix and validates membership", () => {
    expect(envNamespacePrefixForPackage("@cinatra-ai/nango-connector")).toBe(
      "CINATRA_EXT_CINATRA_HAI_SNANGO_HCONNECTOR__",
    );
    expect(
      isNamespacedEnvKey("@cinatra-ai/nango-connector", "CINATRA_EXT_CINATRA_HAI_SNANGO_HCONNECTOR__API_KEY"),
    ).toBe(true);
    expect(isNamespacedEnvKey("@cinatra-ai/nango-connector", "NANGO_SECRET_KEY")).toBe(false);
    // The bare prefix with no key after the `__` terminator is not a valid claim.
    expect(
      isNamespacedEnvKey("@cinatra-ai/nango-connector", "CINATRA_EXT_CINATRA_HAI_SNANGO_HCONNECTOR__"),
    ).toBe(false);
    // A different extension cannot claim another's namespace.
    expect(isNamespacedEnvKey("@acme/acme-crm", "CINATRA_EXT_CINATRA_HAI_SNANGO_HCONNECTOR__API_KEY")).toBe(false);
  });
});

describe("validateEnvOverrides — the security guard", () => {
  const PKG = "@cinatra-ai/nango-connector";

  it("namespaced keys are honored regardless of allowLegacyNames", () => {
    const raw = { CINATRA_EXT_CINATRA_HAI_SNANGO_HCONNECTOR__API_KEY: "secrets:apiKey" };
    for (const allowLegacyNames of [true, false]) {
      const { overrides, rejected } = validateEnvOverrides(PKG, raw, { allowLegacyNames });
      expect(rejected).toEqual([]);
      expect(overrides).toEqual({
        CINATRA_EXT_CINATRA_HAI_SNANGO_HCONNECTOR__API_KEY: { port: "secrets", key: "apiKey" },
      });
    }
  });

  it("a legacy (non-namespaced) name is REJECTED for a non-required extension", () => {
    const raw = { NANGO_SECRET_KEY: "secrets:secretKey" };
    const { overrides, rejected } = validateEnvOverrides(PKG, raw, { allowLegacyNames: false });
    expect(overrides).toEqual({});
    expect(rejected).toHaveLength(1);
    expect(rejected[0].envKey).toBe("NANGO_SECRET_KEY");
    expect(rejected[0].reason).toMatch(/not namespaced/);
  });

  it("a legacy (non-namespaced) name is HONORED when allowLegacyNames is true (required system extension)", () => {
    const raw = { NANGO_SECRET_KEY: "secrets:secretKey", NANGO_SERVER_URL: "settings:serverUrl" };
    const { overrides, rejected } = validateEnvOverrides(PKG, raw, { allowLegacyNames: true });
    expect(rejected).toEqual([]);
    expect(overrides).toEqual({
      NANGO_SECRET_KEY: { port: "secrets", key: "secretKey" },
      NANGO_SERVER_URL: { port: "settings", key: "serverUrl" },
    });
  });

  it("cannot map an arbitrary host env var (e.g. DATABASE_URL) even with allowLegacyNames — security guard is about NAME shape, not a blanket allow", () => {
    // NOTE: allowLegacyNames only lifts the namespace requirement; it does NOT
    // change target-shape validation. An extension still can only declare a
    // settings/secrets TARGET (never e.g. "db:query" or an unparseable shape).
    const raw = { DATABASE_URL: "db:connectionString" };
    const { overrides, rejected } = validateEnvOverrides(PKG, raw, { allowLegacyNames: true });
    expect(overrides).toEqual({});
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/invalid target/);
  });

  it("rejects a malformed env-var name", () => {
    const { overrides, rejected } = validateEnvOverrides(PKG, { "not-a-valid-name": "settings:x" }, { allowLegacyNames: true });
    expect(overrides).toEqual({});
    expect(rejected[0].reason).toMatch(/not a valid env-var name/);
  });

  it("drops an unparseable target string", () => {
    const { overrides, rejected } = validateEnvOverrides(PKG, { NANGO_SECRET_KEY: "bogus" }, { allowLegacyNames: true });
    expect(overrides).toEqual({});
    expect(rejected[0].reason).toMatch(/invalid target/);
  });

  it("null/undefined/empty input yields no overrides and no rejections", () => {
    expect(validateEnvOverrides(PKG, null, { allowLegacyNames: true })).toEqual({ overrides: {}, rejected: [] });
    expect(validateEnvOverrides(PKG, undefined, { allowLegacyNames: true })).toEqual({ overrides: {}, rejected: [] });
    expect(validateEnvOverrides(PKG, {}, { allowLegacyNames: true })).toEqual({ overrides: {}, rejected: [] });
  });
});

describe("splitEnvOverridesByPort", () => {
  it("groups by port into per-port reverse (key -> envVar) maps", () => {
    const { overrides } = validateEnvOverrides(
      "@cinatra-ai/nango-connector",
      { NANGO_SECRET_KEY: "secrets:secretKey", NANGO_SERVER_URL: "settings:serverUrl" },
      { allowLegacyNames: true },
    );
    expect(splitEnvOverridesByPort(overrides)).toEqual({
      settings: { serverUrl: "NANGO_SERVER_URL" },
      secrets: { secretKey: "NANGO_SECRET_KEY" },
    });
  });

  it("empty input yields empty per-port maps", () => {
    expect(splitEnvOverridesByPort({})).toEqual({ settings: {}, secrets: {} });
  });
});
