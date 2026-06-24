import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

// Widget-stream token broker (cinatra#220).
//
// The DB layer is mocked as an in-memory row store keyed by token_hash so the
// mint→consume lifecycle, expiry sweep, binding re-checks, and key-rotation
// fingerprint logic run REAL against synthetic rows. connector_config reads are
// mocked as data. The broker's own SHA-256-at-rest, prefix, and TTL constants
// are exercised end-to-end (a raw token is NEVER stored).
const {
  runPostgresQueriesSyncMock,
  readConnectorConfigMock,
  readMetadataValueMock,
  ensureSchemaMock,
  getActiveConnectSiteByIdMock,
} = vi.hoisted(() => ({
  runPostgresQueriesSyncMock: vi.fn(),
  readConnectorConfigMock: vi.fn(),
  readMetadataValueMock: vi.fn(),
  ensureSchemaMock: vi.fn(),
  getActiveConnectSiteByIdMock: vi.fn(),
}));

vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "test_schema",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: ensureSchemaMock,
}));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: runPostgresQueriesSyncMock,
  quotePostgresIdentifier: (v: string) => `"${v.replaceAll('"', '""')}"`,
}));
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: readConnectorConfigMock,
  readMetadataValueFromDatabase: readMetadataValueMock,
}));
vi.mock("@/lib/connect-sites-store", () => ({
  getActiveConnectSiteById: getActiveConnectSiteByIdMock,
}));

import {
  mintWidgetStreamToken,
  consumeWidgetStreamToken,
  isAuthorizedLongLivedKey,
  isLongLivedTokenPathEnabled,
  normalizeOriginStrict,
  __testing,
} from "@/lib/widget-token-broker";
import type { GeneratedWidgetStreamAuth } from "@/lib/generated/extensions.server";

const WP_AUTH: GeneratedWidgetStreamAuth = {
  tokenConfigKey: "wordpress_widget_auth",
  instancesConfigKey: "wordpress",
  requiredInstanceFields: ["id", "name", "username", "applicationPassword"],
};

const ORIGIN = "https://wp.test";
const ISS = "https://instance.cinatra.ai";
let CONFIG: Record<string, unknown>;

// In-memory row store keyed by token_hash. The mock interprets the broker's SQL
// at a coarse level (INSERT / SELECT by token_hash / DELETE by token_hash /
// DELETE expired) — enough to exercise the lifecycle deterministically.
type Row = {
  token_hash: string;
  jti: string;
  agent_slug: string;
  aud: string;
  iss: string;
  origin: string;
  scope: string;
  sub: string | null;
  token_config_key: string;
  token_key_fingerprint: string;
  expires_at_ms: number;
};
let store: Map<string, Row>;
let nowMs: number;

// Cached read: bare connectorId key. Fresh read: `connector_config:<id>` key.
function configFor(key: string, fallback: unknown) {
  return key in CONFIG ? CONFIG[key] : fallback;
}
function metadataFor(key: string, fallback: unknown) {
  const id = key.startsWith("connector_config:") ? key.slice("connector_config:".length) : key;
  return id in CONFIG ? CONFIG[id] : fallback;
}

function runQueries(input: {
  queries: Array<{ text: string; values?: unknown[] }>;
}) {
  return input.queries.map((q) => {
    const text = q.text;
    const values = q.values ?? [];
    if (text.includes("DELETE FROM") && text.includes("expires_at < now()")) {
      for (const [h, row] of [...store]) if (row.expires_at_ms < nowMs) store.delete(h);
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("INSERT INTO")) {
      // expires_at is computed in SQL as now() + make_interval(secs => $11);
      // the mock mirrors that against its synthetic clock (nowMs).
      const [
        token_hash,
        jti,
        agent_slug,
        aud,
        iss,
        origin,
        scope,
        sub,
        token_config_key,
        token_key_fingerprint,
        ttl_secs,
      ] = values as [
        string, string, string, string, string, string, string,
        string | null, string, string, number,
      ];
      store.set(token_hash, {
        token_hash,
        jti,
        agent_slug,
        aud,
        iss,
        origin,
        scope,
        sub: sub ?? null,
        token_config_key,
        token_key_fingerprint,
        expires_at_ms: nowMs + Number(ttl_secs) * 1000,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("SELECT") && text.includes("WHERE token_hash =")) {
      const row = store.get(values[0] as string);
      if (!row) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            jti: row.jti,
            agent_slug: row.agent_slug,
            aud: row.aud,
            origin: row.origin,
            scope: row.scope,
            sub: row.sub,
            token_config_key: row.token_config_key,
            token_key_fingerprint: row.token_key_fingerprint,
            not_expired: row.expires_at_ms > nowMs,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.startsWith("DELETE FROM") && text.includes("WHERE token_hash =")) {
      store.delete(values[0] as string);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  store = new Map();
  nowMs = Date.now();
  CONFIG = {
    wordpress: {
      instances: [
        {
          id: "wp-1",
          name: "WP",
          siteUrl: ORIGIN,
          username: "admin",
          applicationPassword: "secret",
        },
      ],
    },
    wordpress_widget_auth: { apiKey: "long-lived-key-value" },
  };
  readConnectorConfigMock.mockReset();
  readConnectorConfigMock.mockImplementation(configFor);
  readMetadataValueMock.mockReset();
  readMetadataValueMock.mockImplementation(metadataFor);
  ensureSchemaMock.mockReset();
  runPostgresQueriesSyncMock.mockReset();
  runPostgresQueriesSyncMock.mockImplementation(runQueries);
  getActiveConnectSiteByIdMock.mockReset();
});

function mint(overrides: Partial<Parameters<typeof mintWidgetStreamToken>[0]> = {}) {
  return mintWidgetStreamToken({
    agentSlug: "wordpress-content-editor",
    auth: WP_AUTH,
    origin: ORIGIN,
    issuerBaseUrl: ISS,
    ...overrides,
  });
}

function consume(token: string, overrides: Partial<Parameters<typeof consumeWidgetStreamToken>[0]> = {}) {
  return consumeWidgetStreamToken({
    token,
    agentSlug: "wordpress-content-editor",
    auth: WP_AUTH,
    routePath: "/api/agents/wordpress-content-editor/stream",
    requestOrigin: ORIGIN,
    ...overrides,
  });
}

describe("widget-token-broker — mint → consume happy path", () => {
  it("mints a cit_ token and consumes it; the raw token is never persisted (hash-only at rest)", () => {
    const minted = mint({ sub: "wp-user-42" });
    expect(minted).not.toBeNull();
    expect(minted!.token).toMatch(/^cit_[A-Za-z0-9_-]{43}$/);
    expect(minted!.expiresIn).toBe(300);
    expect(minted!.scope).toBe("wordpress-content-editor.stream");

    // Hash-at-rest: the stored PK is SHA-256(token); the raw token is absent.
    const expectedHash = createHash("sha256").update(minted!.token, "utf8").digest("hex");
    expect(store.has(expectedHash)).toBe(true);
    const serialized = JSON.stringify([...store.values()]);
    expect(serialized).not.toContain(minted!.token);
    expect(serialized).toContain(expectedHash);

    const res = consume(minted!.token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.sub).toBe("wp-user-42");
      expect(res.origin).toBe(ORIGIN);
    }
  });

  it("is multi-use within the TTL (a chat session reuses the token across turns)", () => {
    const minted = mint();
    expect(consume(minted!.token).ok).toBe(true);
    expect(consume(minted!.token).ok).toBe(true);
    expect(consume(minted!.token).ok).toBe(true);
  });
});

describe("widget-token-broker — rejections", () => {
  it("rejects a non-cit_ token without touching the DB", () => {
    const res = consume("long-lived-key-value");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_cit_token");
  });

  it("rejects an unknown (never-minted) cit_ token", () => {
    const res = consume("cit_" + "A".repeat(43));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  it("rejects (and deletes) an expired token", () => {
    const minted = mint();
    const hash = __testing.sha256Hex(minted!.token);
    expect(store.has(hash)).toBe(true);
    nowMs += 301_000; // advance past the 300s TTL
    const res = consume(minted!.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
    expect(store.has(hash)).toBe(false); // deleted on consume
  });

  it("rejects a wrong aud (route path mismatch)", () => {
    const minted = mint();
    const res = consume(minted!.token, { routePath: "/api/agents/other/stream" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("aud_mismatch");
  });

  it("rejects an agent_slug mismatch", () => {
    const minted = mint();
    const res = consume(minted!.token, {
      agentSlug: "drupal-content-editor",
      routePath: "/api/agents/drupal-content-editor/stream",
    });
    expect(res.ok).toBe(false);
    // agent_slug is checked before aud/scope
    if (!res.ok) expect(res.reason).toBe("agent_mismatch");
  });

  it("rejects when the request Origin does not match the token-bound origin", () => {
    const minted = mint();
    const res = consume(minted!.token, { requestOrigin: "https://evil.test" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("origin_mismatch");
  });

  it("rejects when the bound origin is no longer a configured instance", () => {
    const minted = mint();
    // Operator removed the instance after mint.
    CONFIG.wordpress = { instances: [] };
    const res = consume(minted!.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("origin_unconfigured");
  });

  it("rejects when the long-lived key was rotated after mint (fingerprint mismatch)", () => {
    const minted = mint();
    // Rotate the long-lived key.
    CONFIG.wordpress_widget_auth = { apiKey: "rotated-key-value" };
    const res = consume(minted!.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("key_rotated");
  });
});

describe("widget-token-broker — mint guards + sweep", () => {
  it("returns null for an unparseable / non-http origin", () => {
    expect(mint({ origin: "not a url" })).toBeNull();
    expect(mint({ origin: "ftp://wp.test" })).toBeNull();
    expect(mint({ origin: "" })).toBeNull();
  });

  it("strips path/query/hash from the bound origin", () => {
    expect(normalizeOriginStrict("https://wp.test/wp-admin/post.php?x=1#frag")).toBe(
      "https://wp.test",
    );
  });

  it("sweeps expired rows on mint", () => {
    const a = mint();
    const hashA = __testing.sha256Hex(a!.token);
    nowMs += 301_000; // a expires
    const b = mint(); // sweep on this mint removes a
    expect(store.has(hashA)).toBe(false);
    expect(store.has(__testing.sha256Hex(b!.token))).toBe(true);
  });

  it("returns null when no long-lived key is configured (cannot bind a fingerprint)", () => {
    CONFIG.wordpress_widget_auth = {};
    expect(mint()).toBeNull();
  });
});

describe("widget-token-broker — long-lived key auth + flag", () => {
  it("isAuthorizedLongLivedKey: constant-time match against configured apiKey", () => {
    expect(isAuthorizedLongLivedKey("long-lived-key-value", WP_AUTH)).toBe(true);
    expect(isAuthorizedLongLivedKey("wrong", WP_AUTH)).toBe(false);
    expect(isAuthorizedLongLivedKey("", WP_AUTH)).toBe(false);
  });

  it("isLongLivedTokenPathEnabled: default-enabled; only explicit false disables", () => {
    expect(isLongLivedTokenPathEnabled(WP_AUTH)).toBe(true);
    CONFIG.wordpress_widget_auth = { apiKey: "x", widgetLongLivedTokenEnabled: false };
    expect(isLongLivedTokenPathEnabled(WP_AUTH)).toBe(false);
    CONFIG.wordpress_widget_auth = { apiKey: "x", widgetLongLivedTokenEnabled: true };
    expect(isLongLivedTokenPathEnabled(WP_AUTH)).toBe(true);
  });
});

// cinatra#410 — connect-site (`cnx_`) cit_ minting + consume.
describe("widget-token-broker — connect-site (cnx_) cit_ path", () => {
  const SITE_ID = "11111111-1111-4111-8111-111111111111";

  function mintCnx(version = 1, overrides: Partial<Parameters<typeof mintWidgetStreamToken>[0]> = {}) {
    return mintWidgetStreamToken({
      agentSlug: "wordpress-content-editor",
      auth: WP_AUTH,
      origin: ORIGIN,
      issuerBaseUrl: ISS,
      connectSite: { siteId: SITE_ID, credentialVersion: version },
      ...overrides,
    });
  }

  function liveSite(version: number, over: Partial<{ client: string; widgetOrigin: string }> = {}) {
    return {
      siteId: SITE_ID,
      client: over.client ?? "wordpress",
      widgetOrigin: over.widgetOrigin ?? ORIGIN,
      callbackOrigin: null,
      credentialVersion: version,
      webhookSecretHash: null,
      adminUserId: "u-1",
      orgId: "org-1",
      revokedAt: null,
    };
  }

  it("mints a cnx_-bound cit_ (stores connect_site:<id> config key) and consumes it against the live site", () => {
    const minted = mintCnx(3);
    expect(minted).not.toBeNull();
    expect(minted!.token).toMatch(/^cit_[A-Za-z0-9_-]{43}$/);
    const stored = [...store.values()][0]!;
    expect(stored.token_config_key).toBe(`connect_site:${SITE_ID}`);

    getActiveConnectSiteByIdMock.mockReturnValue(liveSite(3));
    const res = consume(minted!.token);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.origin).toBe(ORIGIN);
  });

  it("mints WITHOUT a configured legacy apiKey (the cnx_ path needs no apiKey)", () => {
    delete (CONFIG as Record<string, unknown>).wordpress_widget_auth;
    expect(mintCnx(1)).not.toBeNull();
  });

  it("invalidates on credential_version bump (reconnect) — key_rotated", () => {
    const minted = mintCnx(2);
    getActiveConnectSiteByIdMock.mockReturnValue(liveSite(3)); // bumped
    const res = consume(minted!.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("key_rotated");
  });

  it("invalidates when the connect-site is revoked / missing (no active row) — key_rotated", () => {
    const minted = mintCnx(1);
    getActiveConnectSiteByIdMock.mockReturnValue(null);
    const res = consume(minted!.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("key_rotated");
  });

  it("invalidates when the live site re-binds to a different client — key_rotated", () => {
    const minted = mintCnx(1);
    getActiveConnectSiteByIdMock.mockReturnValue(liveSite(1, { client: "drupal" }));
    const res = consume(minted!.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("key_rotated");
  });

  it("invalidates when the live site re-binds to a different origin — key_rotated", () => {
    const minted = mintCnx(1);
    getActiveConnectSiteByIdMock.mockReturnValue(liveSite(1, { widgetOrigin: "https://evil.test" }));
    const res = consume(minted!.token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("key_rotated");
  });

  it("a legacy tokenConfigKey may NOT use the reserved connect_site: prefix (fail-closed mint → null)", () => {
    const forged: GeneratedWidgetStreamAuth = { ...WP_AUTH, tokenConfigKey: "connect_site:forged" };
    expect(mint({ auth: forged })).toBeNull();
  });
});
