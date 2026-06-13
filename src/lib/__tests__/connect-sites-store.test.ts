// Unit coverage for the connect-sites-store SQL primitives (cinatra#221).
//
// Mocks the postgres-sync worker bridge + schema-init so we can assert the
// exact SQL shape (atomic single-statement consume, the active-row partial
// unique conflict target, the in-SQL credential hash binding) and the
// row-mapping behavior WITHOUT a live Postgres. The true atomic-consume race is
// additionally exercised by the DB-integration test under __tests__/integration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runQueries = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: unknown) => runQueries(input),
  quotePostgresIdentifier: (v: string) => `"${v}"`,
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: vi.fn(),
}));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import {
  consumeAuthorizationCode,
  insertAuthorizationCode,
  upsertConnectSiteCredential,
  getActiveConnectSiteById,
  listActiveConnectSiteOrigins,
  revokeConnectSiteRow,
} from "@/lib/connect-sites-store";

beforeEach(() => {
  runQueries.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function lastQuery() {
  const call = runQueries.mock.calls.at(-1)?.[0] as {
    queries: Array<{ text: string; values?: unknown[] }>;
    transaction?: boolean;
  };
  return call;
}

describe("consumeAuthorizationCode — atomic single-use SQL", () => {
  it("is a single UPDATE...RETURNING gated on consumed_at IS NULL AND expires_at > now()", () => {
    runQueries.mockReturnValueOnce([{ rows: [], rowCount: 0 }]);
    const result = consumeAuthorizationCode({ codeHash: "h", grantType: "auth_code" });
    expect(result).toBeNull();
    const q = lastQuery();
    expect(q.transaction).toBe(true);
    expect(q.queries).toHaveLength(1);
    const sql = q.queries[0].text;
    expect(sql).toMatch(/UPDATE\s+"cinatra"\.connect_authorization_codes/i);
    expect(sql).toMatch(/SET\s+consumed_at\s*=\s*now\(\)/i);
    expect(sql).toMatch(/consumed_at IS NULL/i);
    expect(sql).toMatch(/expires_at > now\(\)/i);
    expect(sql).toMatch(/RETURNING/i);
    expect(q.queries[0].values).toEqual(["h", "auth_code"]);
  });

  it("maps a returned row to camelCase", () => {
    runQueries.mockReturnValueOnce([
      {
        rows: [
          {
            code_hash: "h",
            grant_type: "install_code",
            client: "drupal",
            redirect_uri: null,
            widget_origin: "https://news.example.com",
            callback_origin: null,
            code_challenge: null,
            admin_user_id: "u1",
            org_id: "o1",
            scope: "connector:provision",
            created_at: "t0",
            expires_at: "t1",
            consumed_at: "t2",
          },
        ],
        rowCount: 1,
      },
    ]);
    const result = consumeAuthorizationCode({ codeHash: "h", grantType: "install_code" });
    expect(result).toEqual(
      expect.objectContaining({
        codeHash: "h",
        grantType: "install_code",
        client: "drupal",
        widgetOrigin: "https://news.example.com",
        orgId: "o1",
      }),
    );
  });
});

describe("insertAuthorizationCode", () => {
  it("INSERTs with ON CONFLICT DO NOTHING and returns true only when a row was written", () => {
    runQueries.mockReturnValueOnce([{ rows: [], rowCount: 1 }]);
    const ok = insertAuthorizationCode({
      codeHash: "h",
      grantType: "auth_code",
      client: "wordpress",
      redirectUri: "https://shop.example.com/wp-admin/admin-post.php?action=cinatra_connect_callback",
      widgetOrigin: "https://shop.example.com",
      callbackOrigin: "https://shop.example.com",
      codeChallenge: "c".repeat(43),
      adminUserId: "u1",
      orgId: "o1",
      scope: "connector:provision",
      expiresAtIso: "2026-01-01T00:00:00.000Z",
    });
    expect(ok).toBe(true);
    const sql = lastQuery().queries[0].text;
    expect(sql).toMatch(/INSERT INTO\s+"cinatra"\.connect_authorization_codes/i);
    expect(sql).toMatch(/ON CONFLICT \(code_hash\) DO NOTHING/i);

    runQueries.mockReturnValueOnce([{ rows: [], rowCount: 0 }]);
    const collision = insertAuthorizationCode({
      codeHash: "h",
      grantType: "auth_code",
      client: "wordpress",
      redirectUri: null,
      widgetOrigin: "https://shop.example.com",
      callbackOrigin: null,
      codeChallenge: null,
      adminUserId: null,
      orgId: null,
      scope: null,
      expiresAtIso: "2026-01-01T00:00:00.000Z",
    });
    expect(collision).toBe(false);
  });
});

describe("upsertConnectSiteCredential — active-row uniqueness + in-SQL hash", () => {
  it("uses the active-row partial-unique conflict target and computes the hash over the final site_id", () => {
    runQueries.mockReturnValueOnce([
      {
        rows: [
          {
            site_id: "11111111-1111-4111-8111-111111111111",
            client: "wordpress",
            widget_origin: "https://shop.example.com",
            callback_origin: "https://shop.example.com",
            credential_hash: "deadbeef",
            credential_version: 1,
            webhook_secret_hash: "wsh",
            admin_user_id: "u1",
            org_id: "o1",
            created_at: "t0",
            last_exchanged_at: "t0",
            last_used_at: null,
            revoked_at: null,
            revoked_by: null,
          },
        ],
        rowCount: 1,
      },
    ]);
    const site = upsertConnectSiteCredential({
      candidateSiteId: "11111111-1111-4111-8111-111111111111",
      client: "wordpress",
      widgetOrigin: "https://shop.example.com",
      callbackOrigin: "https://shop.example.com",
      credentialSecret: "secret-bytes",
      webhookSecretHash: "wsh",
      adminUserId: "u1",
      orgId: "o1",
    });
    expect(site.siteId).toBe("11111111-1111-4111-8111-111111111111");
    expect(site.credentialVersion).toBe(1);
    const sql = lastQuery().queries[0].text;
    // Active-row uniqueness: conflict target is the partial unique index pred.
    expect(sql).toMatch(/ON CONFLICT \(org_id, client, widget_origin\) WHERE revoked_at IS NULL/i);
    // Reconnect rotates the same row (version + 1).
    expect(sql).toMatch(/credential_version = "cinatra"\.connect_sites\.credential_version \+ 1/i);
    // Hash bound to the FINAL site_id, computed in SQL (insert + update arms).
    expect(sql).toMatch(/encode\(\s*sha256\(\('cnx_' \|\| \$1::text \|\| '_' \|\| \$5::text\)::bytea\)/i);
    expect(sql).toMatch(/encode\(\s*\n?\s*sha256\(\('cnx_' \|\| "cinatra"\.connect_sites\.site_id::text \|\| '_' \|\| \$5::text\)::bytea\)/i);
  });
});

describe("getActiveConnectSiteById / listActiveConnectSiteOrigins / revoke", () => {
  it("scopes the active-site lookup to non-revoked rows", () => {
    runQueries.mockReturnValueOnce([{ rows: [], rowCount: 0 }]);
    expect(getActiveConnectSiteById("x")).toBeNull();
    expect(lastQuery().queries[0].text).toMatch(/revoked_at IS NULL/i);
  });

  it("lists distinct active widget origins", () => {
    runQueries.mockReturnValueOnce([
      { rows: [{ widget_origin: "https://a.example.com" }, { widget_origin: "https://b.example.com" }], rowCount: 2 },
    ]);
    expect(listActiveConnectSiteOrigins()).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(lastQuery().queries[0].text).toMatch(/SELECT DISTINCT widget_origin/i);
  });

  it("revoke is org-scoped and only affects active rows", () => {
    runQueries.mockReturnValueOnce([{ rows: [], rowCount: 1 }]);
    expect(revokeConnectSiteRow({ siteId: "s", orgId: "o", actor: "a" })).toBe(true);
    const sql = lastQuery().queries[0].text;
    expect(sql).toMatch(/SET revoked_at = now\(\), revoked_by = \$3/i);
    expect(sql).toMatch(/site_id = \$1 AND org_id = \$2 AND revoked_at IS NULL/i);

    runQueries.mockReturnValueOnce([{ rows: [], rowCount: 0 }]);
    expect(revokeConnectSiteRow({ siteId: "s", orgId: "other", actor: "a" })).toBe(false);
  });
});
