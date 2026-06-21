// cinatra#221 coverage for the widget-stream-auth extensions:
//   - cnx_ per-site credential branch is SERVER-TO-SERVER ONLY (browser rejects)
//   - revoke → immediate reject + origin drop from the allowlist
//   - rotate → old credential rejected, new accepted
//   - paired Origin↔siteId binding (wrong origin for a valid token → reject)
//   - CORS allowlist UNION (legacy instances[] + connect_sites)
//   - legacy shared-apiKey kill switch

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const connectStore = vi.hoisted(() => ({
  getActiveConnectSiteById: vi.fn(),
  listActiveConnectSiteOrigins: vi.fn(() => [] as string[]),
  touchConnectSiteLastUsed: vi.fn(),
}));
vi.mock("@/lib/connect-sites-store", () => connectStore);

// @/lib/database is stubbed by the root vitest config; provide a controllable
// connector_config reader keyed by an explicit config map.
const dbConfig = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: <T,>(key: string, fallback: T): T =>
    (key in dbConfig ? (dbConfig[key] as T) : fallback),
  // cinatra#220 reads the legacy apiKey AND the forceFresh instances UNCACHED
  // via readMetadataValueFromDatabase on the `connector_config:<key>` metadata
  // key. Strip that prefix so it resolves against the same dbConfig map the
  // bare-key reader uses, keeping the existing dbConfig["wordpress_widget_auth"]
  // / dbConfig["wordpress"] fixtures authoritative.
  readMetadataValueFromDatabase: <T,>(key: string, fallback: T): T => {
    const bare = key.startsWith("connector_config:")
      ? key.slice("connector_config:".length)
      : key;
    return bare in dbConfig ? (dbConfig[bare] as T) : fallback;
  },
}));

import {
  validateWidgetStreamToken,
  validateConnectServerCredential,
  resolveWidgetStreamOrigin,
} from "@/lib/widget-stream-auth";

const AUTH = {
  tokenConfigKey: "wordpress_widget_auth",
  instancesConfigKey: "wordpress",
  requiredInstanceFields: ["id", "name"],
};

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL = `cnx_${SITE_ID}_supersecretvalue`;
const CREDENTIAL_HASH = createHash("sha256").update(CREDENTIAL).digest("hex");

function activeSite(overrides: Record<string, unknown> = {}) {
  return {
    siteId: SITE_ID,
    client: "wordpress",
    widgetOrigin: "https://shop.example.com",
    callbackOrigin: "https://shop.example.com",
    credentialHash: CREDENTIAL_HASH,
    credentialVersion: 1,
    webhookSecretHash: null,
    adminUserId: "u1",
    orgId: "o1",
    createdAt: "t0",
    lastExchangedAt: "t0",
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    ...overrides,
  };
}

// Expected validated-binding shape for the default activeSite() fixture
// (cinatra#407 rotation TOCTOU fix: validateConnectServerCredential returns the
// binding fields — orgId/widgetOrigin/credentialVersion — from the SAME row it
// hash-checked, so the credential generation is bound to the credential that
// authenticated, never a fresher row's).
const VALIDATED_SITE_A = {
  siteId: SITE_ID,
  client: "wordpress",
  orgId: "o1",
  widgetOrigin: "https://shop.example.com",
  credentialVersion: 1,
};

beforeEach(() => {
  for (const k of Object.keys(dbConfig)) delete dbConfig[k];
  connectStore.getActiveConnectSiteById.mockReset();
  connectStore.listActiveConnectSiteOrigins.mockReset().mockReturnValue([]);
  connectStore.touchConnectSiteLastUsed.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateConnectServerCredential (server-to-server cnx_ path)", () => {
  it("accepts a matching credential for a non-revoked site WITH the paired origin", () => {
    connectStore.getActiveConnectSiteById.mockReturnValue(activeSite());
    expect(
      validateConnectServerCredential({
        credential: CREDENTIAL,
        requestOrigin: "https://shop.example.com",
      }),
    ).toEqual(VALIDATED_SITE_A);
    expect(connectStore.touchConnectSiteLastUsed).toHaveBeenCalledWith(SITE_ID);
  });

  it("FAILS CLOSED when no requestOrigin is supplied (paired binding required by default)", () => {
    connectStore.getActiveConnectSiteById.mockReturnValue(activeSite());
    expect(validateConnectServerCredential({ credential: CREDENTIAL })).toBeNull();
    // An explicit server-internal opt-out skips the binding.
    expect(
      validateConnectServerCredential({ credential: CREDENTIAL, enforcePairedOrigin: false }),
    ).toEqual(VALIDATED_SITE_A);
  });

  it("rejects a non-cnx_ bearer and an unknown/revoked site", () => {
    expect(
      validateConnectServerCredential({ credential: "not-a-cnx-token", requestOrigin: "https://shop.example.com" }),
    ).toBeNull();
    connectStore.getActiveConnectSiteById.mockReturnValue(null); // revoked → not active
    expect(
      validateConnectServerCredential({ credential: CREDENTIAL, requestOrigin: "https://shop.example.com" }),
    ).toBeNull();
  });

  it("rejects a wrong secret for a valid siteId (hash mismatch)", () => {
    connectStore.getActiveConnectSiteById.mockReturnValue(
      activeSite({ credentialHash: "0".repeat(64) }),
    );
    expect(
      validateConnectServerCredential({ credential: CREDENTIAL, requestOrigin: "https://shop.example.com" }),
    ).toBeNull();
  });

  it("enforces the paired Origin↔siteId binding (wrong origin → reject)", () => {
    connectStore.getActiveConnectSiteById.mockReturnValue(activeSite());
    // Correct origin accepted.
    expect(
      validateConnectServerCredential({
        credential: CREDENTIAL,
        requestOrigin: "https://shop.example.com",
      }),
    ).toEqual(VALIDATED_SITE_A);
    // A different (even if otherwise-valid) origin is a confused-deputy attempt.
    expect(
      validateConnectServerCredential({
        credential: CREDENTIAL,
        requestOrigin: "https://other.example.com",
      }),
    ).toBeNull();
  });

  it("rejects when the credential's client differs from expectedClient (codex: Drupal cnx_ cannot authorize a WordPress agent)", () => {
    // Stored row is a WordPress site; caller expects a Drupal agent.
    connectStore.getActiveConnectSiteById.mockReturnValue(activeSite({ client: "wordpress" }));
    expect(
      validateConnectServerCredential({
        credential: CREDENTIAL,
        requestOrigin: "https://shop.example.com",
        expectedClient: "drupal",
      }),
    ).toBeNull();
    // Matching client is accepted.
    expect(
      validateConnectServerCredential({
        credential: CREDENTIAL,
        requestOrigin: "https://shop.example.com",
        expectedClient: "wordpress",
      }),
    ).toEqual(VALIDATED_SITE_A);
  });

  it("returns credentialVersion + orgId + widgetOrigin FROM the hash-checked row (cinatra#407 rotation TOCTOU)", () => {
    // The binding the caller pins MUST come from the SAME row whose
    // credential_hash matched the presented credential — never a fresher read.
    // Here the active row is at generation 7; the returned credentialVersion
    // must be 7 (and org/origin from this same row), so a caller can bind the
    // minted user token to the generation that actually authenticated.
    connectStore.getActiveConnectSiteById.mockReturnValue(
      activeSite({ credentialVersion: 7, orgId: "o-rotated", widgetOrigin: "https://shop.example.com" }),
    );
    expect(
      validateConnectServerCredential({
        credential: CREDENTIAL,
        requestOrigin: "https://shop.example.com",
      }),
    ).toEqual({
      siteId: SITE_ID,
      client: "wordpress",
      orgId: "o-rotated",
      widgetOrigin: "https://shop.example.com",
      credentialVersion: 7,
    });
  });
});

describe("validateWidgetStreamToken caller-context gating", () => {
  it("REJECTS a cnx_ credential on the browser path (default)", () => {
    connectStore.getActiveConnectSiteById.mockReturnValue(activeSite());
    expect(validateWidgetStreamToken(CREDENTIAL, AUTH)).toBe(false);
    expect(validateWidgetStreamToken(CREDENTIAL, AUTH, { callerContext: "browser" })).toBe(false);
    // The cnx_ lookup must NOT even run on the browser path.
    expect(connectStore.getActiveConnectSiteById).not.toHaveBeenCalled();
  });

  it("ACCEPTS a cnx_ credential on the server-to-server path with paired origin", () => {
    connectStore.getActiveConnectSiteById.mockReturnValue(activeSite());
    expect(
      validateWidgetStreamToken(CREDENTIAL, AUTH, {
        callerContext: "server-to-server",
        requestOrigin: "https://shop.example.com",
      }),
    ).toBe(true);
  });

  it("rotate: old credential rejected, new accepted (hash changed on the row)", () => {
    // After rotate the stored hash is for a NEW secret; the OLD credential's
    // hash no longer matches.
    const newCredential = `cnx_${SITE_ID}_rotated-secret`;
    const newHash = createHash("sha256").update(newCredential).digest("hex");
    connectStore.getActiveConnectSiteById.mockReturnValue(
      activeSite({ credentialHash: newHash, credentialVersion: 2 }),
    );
    const origin = "https://shop.example.com";
    expect(
      validateWidgetStreamToken(CREDENTIAL, AUTH, { callerContext: "server-to-server", requestOrigin: origin }),
    ).toBe(false);
    expect(
      validateWidgetStreamToken(newCredential, AUTH, { callerContext: "server-to-server", requestOrigin: origin }),
    ).toBe(true);
  });

  it("revoke: a revoked site is not active → cnx_ credential immediately rejected", () => {
    connectStore.getActiveConnectSiteById.mockReturnValue(null);
    expect(
      validateWidgetStreamToken(CREDENTIAL, AUTH, {
        callerContext: "server-to-server",
        requestOrigin: "https://shop.example.com",
      }),
    ).toBe(false);
  });

  it("server-to-server cnx_ FAILS CLOSED without a requestOrigin (paired binding required)", () => {
    connectStore.getActiveConnectSiteById.mockReturnValue(activeSite());
    expect(
      validateWidgetStreamToken(CREDENTIAL, AUTH, { callerContext: "server-to-server" }),
    ).toBe(false);
  });

  it("server-to-server cnx_ defaults expectedClient to the agent's client (rejects a cross-client cnx_)", () => {
    // The stored site is a Drupal site; the AUTH agent is WordPress
    // (instancesConfigKey="wordpress"). Even on the s2s path with the right
    // origin, the default client binding rejects it — no explicit expectedClient
    // needed (codex re-review High: omission hole closed).
    connectStore.getActiveConnectSiteById.mockReturnValue(
      activeSite({ client: "drupal" }),
    );
    expect(
      validateWidgetStreamToken(CREDENTIAL, AUTH, {
        callerContext: "server-to-server",
        requestOrigin: "https://shop.example.com",
      }),
    ).toBe(false);
  });

  it("legacy shared apiKey accepted on browser path when kill switch ON (default)", () => {
    dbConfig["wordpress_widget_auth"] = { apiKey: "legacy-key" };
    expect(validateWidgetStreamToken("legacy-key", AUTH)).toBe(true);
  });

  it("legacy shared apiKey rejected when kill switch is OFF", () => {
    dbConfig["wordpress_widget_auth"] = { apiKey: "legacy-key" };
    dbConfig["connect_legacy_shared_key_enabled"] = false;
    expect(validateWidgetStreamToken("legacy-key", AUTH)).toBe(false);
  });
});

describe("resolveWidgetStreamOrigin allowlist union", () => {
  it("matches a legacy configured instance siteUrl", () => {
    dbConfig["wordpress"] = {
      instances: [{ siteUrl: "https://legacy.example.com", id: "1", name: "n" }],
    };
    expect(
      resolveWidgetStreamOrigin("https://legacy.example.com", AUTH),
    ).toBe("https://legacy.example.com");
  });

  it("matches a non-revoked connect_sites widgetOrigin (UNION) and drops revoked", () => {
    dbConfig["wordpress"] = { instances: [] };
    connectStore.listActiveConnectSiteOrigins.mockReturnValue(["https://shop.example.com"]);
    expect(
      resolveWidgetStreamOrigin("https://shop.example.com", AUTH),
    ).toBe("https://shop.example.com");
    // After revoke the origin is absent from the active list → CORS drops.
    connectStore.listActiveConnectSiteOrigins.mockReturnValue([]);
    expect(resolveWidgetStreamOrigin("https://shop.example.com", AUTH)).toBeNull();
  });

  it("returns null for an origin in neither source", () => {
    dbConfig["wordpress"] = { instances: [] };
    connectStore.listActiveConnectSiteOrigins.mockReturnValue([]);
    expect(resolveWidgetStreamOrigin("https://unknown.example.com", AUTH)).toBeNull();
  });

  it("SCOPES the connect-site origin union to the agent's client (codex: no cross-client CORS broadening)", () => {
    dbConfig["wordpress"] = { instances: [] };
    connectStore.listActiveConnectSiteOrigins.mockReturnValue([]);
    resolveWidgetStreamOrigin("https://shop.example.com", AUTH);
    // The union query was scoped by the agent's client (instancesConfigKey).
    expect(connectStore.listActiveConnectSiteOrigins).toHaveBeenCalledWith("wordpress");
  });
});
