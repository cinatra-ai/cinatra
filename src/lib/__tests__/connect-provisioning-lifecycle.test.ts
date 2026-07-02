// Lifecycle coverage for cinatra#221 Connect provisioning: code issuance,
// authorization_code + install_code exchange, single-use, PKCE/client/redirect
// mismatch → generic failure, rotate-vs-create. The store + instance-identity
// are mocked so this is pure logic (no DB).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const store = vi.hoisted(() => ({
  insertAuthorizationCode: vi.fn(),
  consumeAuthorizationCode: vi.fn(),
  upsertConnectSiteCredential: vi.fn(),
  sweepExpiredAuthorizationCodes: vi.fn(),
  listConnectSitesForOrg: vi.fn(),
  revokeConnectSiteRow: vi.fn(),
}));

vi.mock("@/lib/connect-sites-store", () => store);
vi.mock("@/lib/instance-identity-store", () => ({
  ensureInstanceId: vi.fn(async () => ({ instanceId: "inst-uuid-123" })),
}));

// cinatra#343: the WordPress grant mints a per-site legacy-bridge webhook binding
// via the host secret service. Mock it (the real impl needs a DB + secretsCodec).
const webhookSecretServiceMock = vi.hoisted(() => ({
  upsertLegacy: vi.fn(),
  mint: vi.fn(),
  resolveByBindingId: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("@/lib/webhook-secret-service", () => ({
  webhookSecretService: webhookSecretServiceMock,
}));

import {
  issueAuthorizationCode,
  exchangeAuthorizationCode,
  exchangeInstallCode,
  mintInstallCode,
  sha256Base64Url,
  sha256Hex,
  validateAuthorizeParams,
  CONNECT_SCOPE,
} from "@/lib/connect-provisioning";

const WP_CALLBACK =
  "https://shop.example.com/wp-admin/admin-post.php?action=cinatra_connect_callback";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  process.env.NEXT_PUBLIC_APP_URL = "https://cinatra.example.com";
  for (const fn of Object.values(store)) fn.mockReset();
  store.insertAuthorizationCode.mockReturnValue(true);
  for (const fn of Object.values(webhookSecretServiceMock)) fn.mockReset();
  webhookSecretServiceMock.upsertLegacy.mockResolvedValue({
    bindingId: "wh-binding-1",
    secret: "hex32",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makeValidParams() {
  const r = validateAuthorizeParams({
    client: "wordpress",
    redirect_uri: WP_CALLBACK,
    widget_origin: "https://shop.example.com",
    state: "state",
    scope: CONNECT_SCOPE,
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  });
  if (!r.ok) throw new Error("expected valid params");
  return r.params;
}

describe("issueAuthorizationCode", () => {
  it("persists only the sha256 hash and returns the plaintext code once", () => {
    const params = makeValidParams();
    const { code, codeHash } = issueAuthorizationCode({
      params,
      adminUserId: "u1",
      orgId: "o1",
    });
    expect(code).toBeTruthy();
    expect(codeHash).toBe(sha256Base64Url(code));
    const writeArg = store.insertAuthorizationCode.mock.calls[0][0];
    expect(writeArg.codeHash).toBe(codeHash);
    expect(writeArg.grantType).toBe("auth_code");
    // The plaintext code is NEVER passed to the store.
    expect(JSON.stringify(writeArg)).not.toContain(code);
  });
});

describe("exchangeAuthorizationCode", () => {
  const verifier = "verifier-" + "x".repeat(40);
  const challenge = sha256Base64Url(verifier);

  function storedRow(overrides: Record<string, unknown> = {}) {
    return {
      codeHash: "h",
      grantType: "auth_code",
      client: "wordpress",
      redirectUri: WP_CALLBACK,
      widgetOrigin: "https://shop.example.com",
      callbackOrigin: "https://shop.example.com",
      codeChallenge: challenge,
      adminUserId: "u1",
      orgId: "o1",
      scope: CONNECT_SCOPE,
      createdAt: "t0",
      expiresAt: "t1",
      consumedAt: "t2",
      ...overrides,
    };
  }

  it("succeeds and returns the per-site credential + mapped fields (create path)", async () => {
    store.consumeAuthorizationCode.mockReturnValue(storedRow());
    store.upsertConnectSiteCredential.mockReturnValue({
      siteId: "site-uuid-1",
      client: "wordpress",
      widgetOrigin: "https://shop.example.com",
      callbackOrigin: "https://shop.example.com",
      credentialHash: "hash",
      credentialVersion: 1,
      webhookSecretHash: null,
      adminUserId: "u1",
      orgId: "o1",
      createdAt: "t0",
      lastExchangedAt: "t0",
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
    });
    const r = await exchangeAuthorizationCode({
      code: "plaintext-code",
      client: "wordpress",
      redirectUri: WP_CALLBACK,
      codeVerifier: verifier,
      webhookSecret: "hex32",
      tokenBrokerAvailable: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.url).toBe("https://cinatra.example.com");
      expect(r.response.siteId).toBe("site-uuid-1");
      expect(r.response.cinatraInstanceId).toBe("inst-uuid-123");
      expect(r.response.credential).toMatch(/^cnx_site-uuid-1_/);
      expect(r.response.credentialVersion).toBe(1);
      expect(r.response.contractVersion).toBe("v1");
      expect(r.response.capabilities.tokenBroker).toBe(false);
      // cinatra#343: the WP grant mints a per-site legacy-bridge webhook binding
      // and surfaces its id so the plugin can POST to the generic /webhook path.
      expect(r.response.webhookBindingId).toBe("wh-binding-1");
    }
    // The store received the WEBHOOK secret HASH, never the plaintext.
    const upsertArg = store.upsertConnectSiteCredential.mock.calls[0][0];
    expect(upsertArg.webhookSecretHash).toBe(sha256Hex("hex32"));
    // The binding is minted for the resolved site, bridging the shared secret as
    // the legacy HMAC secret, on the WordPress connector tuple.
    expect(webhookSecretServiceMock.upsertLegacy).toHaveBeenCalledWith({
      vendor: "cinatra-ai",
      slug: "wordpress-mcp-connector",
      hook: "post-published",
      siteId: "site-uuid-1",
      legacySecret: "hex32",
    });
  });

  it("returns site_rotated semantics via credentialVersion>1 on reconnect", async () => {
    store.consumeAuthorizationCode.mockReturnValue(storedRow());
    store.upsertConnectSiteCredential.mockReturnValue({
      siteId: "site-uuid-existing",
      client: "wordpress",
      widgetOrigin: "https://shop.example.com",
      callbackOrigin: "https://shop.example.com",
      credentialHash: "hash2",
      credentialVersion: 2,
      webhookSecretHash: "wsh",
      adminUserId: "u1",
      orgId: "o1",
      createdAt: "t0",
      lastExchangedAt: "t1",
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
    });
    const r = await exchangeAuthorizationCode({
      code: "plaintext-code",
      client: "wordpress",
      redirectUri: WP_CALLBACK,
      codeVerifier: verifier,
      webhookSecret: "hex32",
      tokenBrokerAvailable: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.credentialVersion).toBe(2);
      expect(r.response.credential).toMatch(/^cnx_site-uuid-existing_/);
      expect(r.response.capabilities.tokenBroker).toBe(true);
    }
  });

  it("fails generically when the code is already consumed/expired/unknown (consume returns null)", async () => {
    store.consumeAuthorizationCode.mockReturnValue(null);
    const r = await exchangeAuthorizationCode({
      code: "plaintext-code",
      client: "wordpress",
      redirectUri: WP_CALLBACK,
      codeVerifier: verifier,
      webhookSecret: "hex32",
      tokenBrokerAvailable: false,
    });
    expect(r.ok).toBe(false);
    expect(store.upsertConnectSiteCredential).not.toHaveBeenCalled();
  });

  it("fails generically on client mismatch, redirect_uri mismatch, and PKCE mismatch", async () => {
    store.consumeAuthorizationCode.mockReturnValue(storedRow());
    // client mismatch
    expect(
      (
        await exchangeAuthorizationCode({
          code: "c",
          client: "drupal",
          redirectUri: WP_CALLBACK,
          codeVerifier: verifier,
          webhookSecret: "w",
          tokenBrokerAvailable: false,
        })
      ).ok,
    ).toBe(false);

    store.consumeAuthorizationCode.mockReturnValue(storedRow());
    // redirect_uri mismatch
    expect(
      (
        await exchangeAuthorizationCode({
          code: "c",
          client: "wordpress",
          redirectUri: "https://shop.example.com/wp-admin/admin-post.php?action=cinatra_connect_callback&x=1",
          codeVerifier: verifier,
          webhookSecret: "w",
          tokenBrokerAvailable: false,
        })
      ).ok,
    ).toBe(false);

    store.consumeAuthorizationCode.mockReturnValue(storedRow());
    // PKCE mismatch
    expect(
      (
        await exchangeAuthorizationCode({
          code: "c",
          client: "wordpress",
          redirectUri: WP_CALLBACK,
          codeVerifier: "wrong-verifier",
          webhookSecret: "w",
          tokenBrokerAvailable: false,
        })
      ).ok,
    ).toBe(false);
    // No provisioning happened on any failure.
    expect(store.upsertConnectSiteCredential).not.toHaveBeenCalled();
  });
});

describe("install-code flow", () => {
  it("mints with a validated widget_origin and persists only the hash", () => {
    const r = mintInstallCode({
      client: "drupal",
      widgetOrigin: "https://news.example.com",
      adminUserId: "u1",
      orgId: "o1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.installCode).toMatch(/^cci_/);
    const writeArg = store.insertAuthorizationCode.mock.calls[0][0];
    expect(writeArg.grantType).toBe("install_code");
    expect(writeArg.codeChallenge).toBeNull();
    if (r.ok) expect(JSON.stringify(writeArg)).not.toContain(r.installCode);
  });

  it("rejects an invalid widget_origin without writing", () => {
    vi.stubEnv("NODE_ENV", "production");
    const r = mintInstallCode({
      client: "drupal",
      widgetOrigin: "http://news.example.com", // http in prod
      adminUserId: "u1",
      orgId: "o1",
    });
    expect(r.ok).toBe(false);
    expect(store.insertAuthorizationCode).not.toHaveBeenCalled();
  });

  it("redeems an install_code with NO PKCE (the code is the bearer)", async () => {
    store.consumeAuthorizationCode.mockReturnValue({
      codeHash: "h",
      grantType: "install_code",
      client: "drupal",
      redirectUri: null,
      widgetOrigin: "https://news.example.com",
      callbackOrigin: null,
      codeChallenge: null,
      adminUserId: "u1",
      orgId: "o1",
      scope: CONNECT_SCOPE,
      createdAt: "t0",
      expiresAt: "t1",
      consumedAt: "t2",
    });
    store.upsertConnectSiteCredential.mockReturnValue({
      siteId: "site-d",
      client: "drupal",
      widgetOrigin: "https://news.example.com",
      callbackOrigin: null,
      credentialHash: "h",
      credentialVersion: 1,
      webhookSecretHash: null,
      adminUserId: "u1",
      orgId: "o1",
      createdAt: "t0",
      lastExchangedAt: "t0",
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
    });
    const r = await exchangeInstallCode({
      installCode: "cci_abc",
      client: "drupal",
      webhookSecret: "w",
      tokenBrokerAvailable: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.response.credential).toMatch(/^cnx_site-d_/);
    // grant type used for consume was install_code.
    expect(store.consumeAuthorizationCode.mock.calls[0][0].grantType).toBe("install_code");
    // cinatra#343: a non-WordPress (Drupal) client mints NO webhook binding and
    // surfaces no bindingId (only the WP connector declares cinatra.webhooks).
    expect(webhookSecretServiceMock.upsertLegacy).not.toHaveBeenCalled();
    if (r.ok) expect(r.response.webhookBindingId).toBeUndefined();
  });

  it("install_code single-use: a second redeem fails generically", async () => {
    store.consumeAuthorizationCode.mockReturnValue(null);
    const r = await exchangeInstallCode({
      installCode: "cci_abc",
      client: "drupal",
      webhookSecret: "w",
      tokenBrokerAvailable: false,
    });
    expect(r.ok).toBe(false);
  });
});

describe("cinatra#343 — per-site WordPress webhook binding at connect time", () => {
  const verifier = "verifier-" + "y".repeat(40);
  const challenge = sha256Base64Url(verifier);

  function wpRow() {
    return {
      codeHash: "h",
      grantType: "auth_code",
      client: "wordpress",
      redirectUri: WP_CALLBACK,
      widgetOrigin: "https://shop.example.com",
      callbackOrigin: "https://shop.example.com",
      codeChallenge: challenge,
      adminUserId: "u1",
      orgId: "o1",
      scope: CONNECT_SCOPE,
      createdAt: "t0",
      expiresAt: "t1",
      consumedAt: "t2",
    };
  }

  function wpSite(siteId: string, credentialVersion: number) {
    return {
      siteId,
      client: "wordpress",
      widgetOrigin: "https://shop.example.com",
      callbackOrigin: "https://shop.example.com",
      credentialHash: "hash",
      credentialVersion,
      webhookSecretHash: null,
      adminUserId: "u1",
      orgId: "o1",
      createdAt: "t0",
      lastExchangedAt: "t0",
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
    };
  }

  it("rotation/reconnect path: upsertLegacy returns the SAME stable bindingId for the same site", async () => {
    store.consumeAuthorizationCode.mockReturnValue(wpRow());
    store.upsertConnectSiteCredential.mockReturnValue(wpSite("site-stable", 2));
    // The idempotent tuple-scoped upsert preserves the bindingId across reconnects.
    webhookSecretServiceMock.upsertLegacy.mockResolvedValue({
      bindingId: "wh-binding-stable",
      secret: "hex32",
    });
    const r = await exchangeAuthorizationCode({
      code: "plaintext-code",
      client: "wordpress",
      redirectUri: WP_CALLBACK,
      codeVerifier: verifier,
      webhookSecret: "hex32",
      tokenBrokerAvailable: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.credentialVersion).toBe(2);
      expect(r.response.webhookBindingId).toBe("wh-binding-stable");
    }
    expect(webhookSecretServiceMock.upsertLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-stable", legacySecret: "hex32" }),
    );
  });

  it("a webhook-binding mint FAILURE is non-fatal: the credential is still issued, no bindingId surfaced", async () => {
    store.consumeAuthorizationCode.mockReturnValue(wpRow());
    store.upsertConnectSiteCredential.mockReturnValue(wpSite("site-x", 1));
    webhookSecretServiceMock.upsertLegacy.mockRejectedValue(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await exchangeAuthorizationCode({
      code: "plaintext-code",
      client: "wordpress",
      redirectUri: WP_CALLBACK,
      codeVerifier: verifier,
      webhookSecret: "hex32",
      tokenBrokerAvailable: false,
    });
    // The exchange SUCCEEDS (the already-committed credential is never stranded);
    // the binding is re-minted idempotently on the next reconnect.
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.credential).toMatch(/^cnx_site-x_/);
      expect(r.response.webhookBindingId).toBeUndefined();
    }
    // The failure is logged WITHOUT leaking the secret.
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain("hex32");
    errSpy.mockRestore();
  });
});
