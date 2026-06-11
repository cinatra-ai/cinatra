// BOOT-ORDER PIN (cinatra#151 Stage 1, design item 9a / risk R-B): auth.ts
// executes `await readBootGoogleOAuthSettings()` at module TOP LEVEL, which
// reaches nango via getGoogleOAuthSettings -> getNangoOAuth2IntegrationCredentials
// BEFORE static-bundle activation registers the nango-system surface. The ONE
// sanctioned pre-activation path must DEGRADE (unresolved surface =>
// nangoCredentials = null, DB-stored fallback) — never throw — and
// post-activation reads must see live Nango values. getGoogleOAuthSettings is
// the only nango-reaching call in auth's module-eval chain (audited in the
// frozen design); pinning it pins the auth module-eval behavior.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { configRows } = vi.hoisted(() => ({ configRows: new Map<string, unknown>() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: (id: string, fallback: unknown) =>
    configRows.has(id) ? configRows.get(id) : fallback,
  writeConnectorConfigToDatabase: (id: string, value: unknown) => {
    configRows.set(id, value);
  },
  deleteConnectorConfig: (id: string) => {
    configRows.delete(id);
  },
}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { NANGO_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions";
import { getGoogleOAuthSettings } from "@cinatra-ai/google-oauth-connection";

beforeEach(() => {
  __resetCapabilityRegistry();
  configRows.clear();
});

describe("getGoogleOAuthSettings pre-activation (the auth.ts module-eval path)", () => {
  it("NEVER throws while the nango surface is unresolved — degrades to the stored DB row", async () => {
    configRows.set("google_oauth", {
      clientId: "db-client-id",
      clientSecret: "db-client-secret",
      redirectUri: "https://example.com/cb",
    });
    const settings = await getGoogleOAuthSettings();
    expect(settings).toEqual({
      clientId: "db-client-id",
      clientSecret: "db-client-secret",
      redirectUri: "https://example.com/cb",
    });
  });

  it("degrades to empty settings when neither nango nor the DB row exist", async () => {
    const settings = await getGoogleOAuthSettings();
    expect(settings.clientId).toBeUndefined();
    expect(settings.clientSecret).toBeUndefined();
  });
});

describe("getGoogleOAuthSettings post-activation", () => {
  it("prefers the live Nango integration credentials over the DB row", async () => {
    configRows.set("google_oauth", { clientId: "db-id", clientSecret: "db-secret" });
    registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
      packageName: "@cinatra-ai/nango-connector",
      impl: {
        isNangoConfigured: () => true,
        getNangoStatus: () => ({ status: "connected", detail: "" }),
        getNangoSettings: () => ({ secretKey: "sk" }),
        providerConfigKeys: { googleOAuth: "cinatra-google-oauth" },
        getNangoOAuth2IntegrationCredentials: async (key: string) =>
          key === "cinatra-google-oauth"
            ? { clientId: "nango-id", clientSecret: "nango-secret" }
            : null,
        getNangoOAuthCallbackUrl: () => "https://api.nango.dev/oauth/callback",
      },
    });
    const settings = await getGoogleOAuthSettings();
    expect(settings.clientId).toBe("nango-id");
    expect(settings.clientSecret).toBe("nango-secret");
    expect(settings.redirectUri).toBe("https://api.nango.dev/oauth/callback");
  });
});
