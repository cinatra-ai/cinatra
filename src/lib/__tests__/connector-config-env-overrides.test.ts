/**
 * Env-override precedence for the instance-global `connector-config` store
 * (cinatra#982, Option A) — the resolution the host `connector-config`
 * capability binds so nango (which KEEPS its instance-global blob) can let an
 * operator env override win WITHOUT the org-scoped settings/secrets ports.
 *
 * Proves, against nango's exact manifest declaration:
 *   - an env var that is SET wins, keyed by the settings/secrets KEY (the
 *     `settings:`/`secrets:` port prefix is dropped onto the single blob);
 *   - an UNSET or BLANK env var is absent from the map (caller falls back to
 *     the DB value — the UI-configured, no-env deployment shape);
 *   - a legacy (non-namespaced `NANGO_*`) name is honored ONLY for a
 *     `resolution: "required"` extension — REJECTED for a `guardedOptional` one;
 *   - a namespaced (`CINATRA_EXT_<PKG>__*`) name is honored regardless of
 *     resolution;
 *   - the resolution is ACTOR-FREE: it reads only `process.env` + its args, so a
 *     no-actor (boot/webhook) read still resolves env-first.
 */
import { describe, it, expect, afterEach } from "vitest";
import { computeConnectorConfigEnvOverrides } from "@/lib/connector-config-env-overrides";
import { envNamespacePrefixForPackage } from "@cinatra-ai/sdk-extensions";

const NANGO_PKG = "@cinatra-ai/nango-connector";

// Nango's manifest `cinatra.envOverrides` (kept in sync with the connector).
const NANGO_ENV_OVERRIDES = {
  NANGO_SECRET_KEY: "secrets:secretKey",
  NANGO_SERVER_URL: "settings:serverUrl",
  NANGO_PUBLIC_CONNECT_URL: "settings:connectUrl",
} as const;

const TOUCHED_ENV = [
  "NANGO_SECRET_KEY",
  "NANGO_SERVER_URL",
  "NANGO_PUBLIC_CONNECT_URL",
];

afterEach(() => {
  for (const key of TOUCHED_ENV) delete process.env[key];
});

describe("computeConnectorConfigEnvOverrides — nango (resolution: required)", () => {
  it("returns {} when no env var is set (DB-backed, no-env deployment)", () => {
    expect(computeConnectorConfigEnvOverrides(NANGO_PKG, NANGO_ENV_OVERRIDES, "required")).toEqual({});
  });

  it("returns a SET env var keyed by its settings/secrets KEY (port prefix dropped)", () => {
    process.env.NANGO_SECRET_KEY = "env-secret";
    process.env.NANGO_SERVER_URL = "https://env.nango.example";

    expect(computeConnectorConfigEnvOverrides(NANGO_PKG, NANGO_ENV_OVERRIDES, "required")).toEqual({
      secretKey: "env-secret",
      serverUrl: "https://env.nango.example",
    });
  });

  it("treats a BLANK env var as unset (preserves `?.trim() || stored` fall-through)", () => {
    process.env.NANGO_SECRET_KEY = "   ";
    process.env.NANGO_SERVER_URL = "";

    expect(computeConnectorConfigEnvOverrides(NANGO_PKG, NANGO_ENV_OVERRIDES, "required")).toEqual({});
  });

  it("trims a set value (matching the connector's evicted `?.trim()`)", () => {
    process.env.NANGO_PUBLIC_CONNECT_URL = "  https://connect.example  ";

    expect(computeConnectorConfigEnvOverrides(NANGO_PKG, NANGO_ENV_OVERRIDES, "required")).toEqual({
      connectUrl: "https://connect.example",
    });
  });

  it("is ACTOR-FREE — resolves the secret from env alone, no org/DB argument", () => {
    process.env.NANGO_SECRET_KEY = "webhook-secret";
    // No org, no actor, no DB — exactly the inbound-webhook verify shape.
    const resolved = computeConnectorConfigEnvOverrides(NANGO_PKG, NANGO_ENV_OVERRIDES, "required");
    expect(resolved.secretKey).toBe("webhook-secret");
  });
});

describe("computeConnectorConfigEnvOverrides — legacy-name eligibility guard", () => {
  it("REJECTS the legacy NANGO_* names for a non-required (guardedOptional) extension", () => {
    process.env.NANGO_SECRET_KEY = "env-secret";
    process.env.NANGO_SERVER_URL = "https://env.nango.example";

    // A marketplace / guardedOptional extension may not claim a legacy name —
    // fail-closed: the mapping is dropped, so the caller keeps its DB value.
    expect(
      computeConnectorConfigEnvOverrides(NANGO_PKG, NANGO_ENV_OVERRIDES, "guardedOptional"),
    ).toEqual({});
  });

  it("honors a NAMESPACED env name regardless of resolution", () => {
    const pkg = "@acme/example-connector";
    const envKey = `${envNamespacePrefixForPackage(pkg)}API_KEY`;
    process.env[envKey] = "namespaced-value";
    try {
      expect(
        computeConnectorConfigEnvOverrides(pkg, { [envKey]: "secrets:apiKey" }, "guardedOptional"),
      ).toEqual({ apiKey: "namespaced-value" });
    } finally {
      delete process.env[envKey];
    }
  });

  it("returns {} when the manifest declares no envOverrides", () => {
    expect(computeConnectorConfigEnvOverrides(NANGO_PKG, null, "required")).toEqual({});
    expect(computeConnectorConfigEnvOverrides(NANGO_PKG, undefined, "guardedOptional")).toEqual({});
  });
});
