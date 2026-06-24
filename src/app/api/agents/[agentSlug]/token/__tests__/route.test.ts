import { beforeEach, describe, expect, it, vi } from "vitest";

// Token-exchange endpoint (cinatra#220). The generated agent map + the broker's
// DB layer are mocked as DATA; the route + generic resolution +
// isConfiguredOrigin + the contract validator run REAL. The broker's mint is
// driven through a mocked runPostgresQueriesSync (in-memory) so a 200 returns a
// real cit_ token shape.
const {
  runPostgresQueriesSyncMock,
  readConnectorConfigMock,
  readMetadataValueMock,
  ensureSchemaMock,
  resolveVerifiedSiteMock,
} = vi.hoisted(() => ({
  runPostgresQueriesSyncMock: vi.fn(),
  readConnectorConfigMock: vi.fn(),
  readMetadataValueMock: vi.fn(),
  ensureSchemaMock: vi.fn(),
  resolveVerifiedSiteMock: vi.fn(),
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
  quotePostgresIdentifier: (v: string) => `"${v}"`,
}));
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: readConnectorConfigMock,
  readMetadataValueFromDatabase: readMetadataValueMock,
}));
// cinatra#410 — the `cnx_` credential validator is mocked as data; the route's
// branch logic (origin pinning + mint binding) runs REAL.
vi.mock("@/lib/widget-user-auth", () => ({
  resolveVerifiedSiteFromCredential: resolveVerifiedSiteMock,
}));

const WP_ORIGIN = "https://wp.test";

vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_WIDGET_STREAM_AGENTS: {
    "wordpress-content-editor": {
      load: async () => ({}),
      packageName: "@cinatra-ai/wordpress-mcp-connector",
      factory: "createWordPressWidgetChatTool",
      label: "WordPress",
      subjectNoun: "post",
      skillCapability: "widget-chat.wordpress-content-editor",
      contextFields: [],
      auth: {
        tokenConfigKey: "wordpress_widget_auth",
        instancesConfigKey: "wordpress",
        requiredInstanceFields: ["id", "name", "username", "applicationPassword"],
      },
    },
  },
}));

import { POST } from "../route";

const CONNECTOR_CONFIG: Record<string, unknown> = {
  wordpress: {
    instances: [
      { id: "wp-1", name: "WP", siteUrl: WP_ORIGIN, username: "admin", applicationPassword: "secret" },
    ],
  },
  wordpress_widget_auth: { apiKey: "long-lived-key-value" },
};

const params = (agentSlug: string) => ({ params: Promise.resolve({ agentSlug }) });
const wpParams = params("wordpress-content-editor");

function tokenRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://instance.cinatra.ai/api/agents/wordpress-content-editor/token", {
    method: "POST",
    headers: {
      Authorization: "Bearer long-lived-key-value",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = { contractVersion: "v2", origin: WP_ORIGIN, sub: "wp-user-42" };

beforeEach(() => {
  readConnectorConfigMock.mockReset();
  readConnectorConfigMock.mockImplementation(
    (key: string, fallback: unknown) => (key in CONNECTOR_CONFIG ? CONNECTOR_CONFIG[key] : fallback),
  );
  // Fresh (uncached) reads go through readMetadataValueFromDatabase keyed by
  // `connector_config:<id>` — the broker's key-auth + mint + kill-switch path.
  readMetadataValueMock.mockReset();
  readMetadataValueMock.mockImplementation((key: string, fallback: unknown) => {
    const id = key.startsWith("connector_config:") ? key.slice("connector_config:".length) : key;
    return id in CONNECTOR_CONFIG ? CONNECTOR_CONFIG[id] : fallback;
  });
  ensureSchemaMock.mockReset();
  resolveVerifiedSiteMock.mockReset();
  runPostgresQueriesSyncMock.mockReset();
  // mint runs a transactional [sweep, insert]; return empty results.
  runPostgresQueriesSyncMock.mockImplementation((input: { queries: unknown[] }) =>
    input.queries.map(() => ({ rows: [], rowCount: 0 })),
  );
});

describe("token-exchange route", () => {
  it("404s an unknown agent slug", async () => {
    const res = await POST(tokenRequest(validBody), params("nope"));
    expect(res.status).toBe(404);
  });

  it("400s an unsupported contractVersion with supportedVersions", async () => {
    const res = await POST(tokenRequest({ ...validBody, contractVersion: "v9" }), wpParams);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code?: string; supportedVersions?: string[] };
    expect(json.code).toBe("unsupported_contract_version");
    expect(json.supportedVersions).toEqual(expect.arrayContaining(["v1", "v2"]));
  });

  it("400s a malformed body (missing origin)", async () => {
    const res = await POST(tokenRequest({ contractVersion: "v2" }), wpParams);
    expect(res.status).toBe(400);
  });

  it("401s a missing Authorization header", async () => {
    const res = await POST(
      new Request("https://instance.cinatra.ai/api/agents/wordpress-content-editor/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      }),
      wpParams,
    );
    expect(res.status).toBe(401);
  });

  it("401s a wrong long-lived key", async () => {
    const res = await POST(tokenRequest(validBody, { Authorization: "Bearer wrong" }), wpParams);
    expect(res.status).toBe(401);
  });

  it("403s an origin that is not a configured instance", async () => {
    const res = await POST(tokenRequest({ ...validBody, origin: "https://evil.test" }), wpParams);
    expect(res.status).toBe(403);
  });

  it("403s an origin from a half-configured instance (requiredInstanceFields filter)", async () => {
    readConnectorConfigMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === "wordpress") {
        return { instances: [{ id: "wp-x", name: "Half", siteUrl: "https://half.test", username: "x" }] };
      }
      return key in CONNECTOR_CONFIG ? CONNECTOR_CONFIG[key] : fallback;
    });
    const res = await POST(tokenRequest({ ...validBody, origin: "https://half.test" }), wpParams);
    expect(res.status).toBe(403);
  });

  it("400s an unparseable origin", async () => {
    const res = await POST(tokenRequest({ ...validBody, origin: "not a url" }), wpParams);
    expect(res.status).toBe(400);
  });

  it("200s with a cit_ token + the expected response shape + echoed contractVersion", async () => {
    const res = await POST(tokenRequest(validBody), wpParams);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      token: string;
      tokenType: string;
      expiresIn: number;
      expiresAt: string;
      contractVersion: string;
      scope: string;
    };
    expect(json.token).toMatch(/^cit_[A-Za-z0-9_-]{43}$/);
    expect(json.tokenType).toBe("Bearer");
    expect(json.expiresIn).toBe(300);
    expect(typeof json.expiresAt).toBe("string");
    expect(json.contractVersion).toBe("v2");
    expect(json.scope).toBe("wordpress-content-editor.stream");
    // The minted row's INSERT was issued (sweep + insert in a transaction).
    const insertCall = runPostgresQueriesSyncMock.mock.calls.find((c) =>
      (c[0] as { queries: Array<{ text: string }> }).queries.some((q) => q.text.startsWith("INSERT INTO")),
    );
    expect(insertCall).toBeDefined();
  });

  it("authenticates BEFORE parsing the body: missing auth + garbage body → 401, no body parse", async () => {
    const res = await POST(
      new Request("https://instance.cinatra.ai/api/agents/wordpress-content-editor/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json",
      }),
      wpParams,
    );
    expect(res.status).toBe(401);
  });

  it("the long-lived key never appears in the response body", async () => {
    const res = await POST(tokenRequest(validBody), wpParams);
    const text = await res.text();
    expect(text).not.toContain("long-lived-key-value");
  });
});

// cinatra#410 — the broker also accepts a per-site `cnx_` connect-site credential.
describe("token-exchange route — cnx_ connect-site credential", () => {
  const cnxCred = "cnx_site_secret"; // shape-only; the validator is mocked.
  function cnxRequest(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request("https://instance.cinatra.ai/api/agents/wordpress-content-editor/token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cnxCred}`,
        "Content-Type": "application/json",
        Origin: WP_ORIGIN,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }
  const verifiedSite = {
    siteId: "site-1",
    client: "wordpress",
    orgId: "org-1",
    siteOrigin: WP_ORIGIN,
    credentialVersion: 2,
  };

  it("401s a cnx_ that does not resolve to a verified site", async () => {
    resolveVerifiedSiteMock.mockReturnValue(null);
    const res = await POST(cnxRequest(validBody), wpParams);
    expect(res.status).toBe(401);
  });

  it("200s a valid cnx_ + mints a cit_ bound to the connect-site (connect_site:<id>)", async () => {
    resolveVerifiedSiteMock.mockReturnValue(verifiedSite);
    const res = await POST(cnxRequest(validBody), wpParams);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { token: string };
    expect(json.token).toMatch(/^cit_[A-Za-z0-9_-]{43}$/);
    // The INSERT bound token_config_key to connect_site:<siteId>.
    const insert = runPostgresQueriesSyncMock.mock.calls
      .flatMap((c) => (c[0] as { queries: Array<{ text: string; values?: unknown[] }> }).queries)
      .find((q) => q.text.startsWith("INSERT INTO"));
    expect(insert).toBeDefined();
    expect(insert!.values).toContain(`connect_site:${verifiedSite.siteId}`);
  });

  it("403s when the body origin does not equal the connect-site's verified origin", async () => {
    // The site resolves for a DIFFERENT origin than the configured wp-1 row's;
    // pick an origin that IS configured but differs from the site's siteOrigin.
    readConnectorConfigMock.mockImplementation((key: string, fallback: unknown) => {
      if (key === "wordpress") {
        return {
          instances: [
            { id: "wp-1", name: "WP", siteUrl: WP_ORIGIN, username: "admin", applicationPassword: "secret" },
            { id: "wp-2", name: "WP2", siteUrl: "https://wp2.test", username: "admin", applicationPassword: "secret" },
          ],
        };
      }
      return key in CONNECTOR_CONFIG ? CONNECTOR_CONFIG[key] : fallback;
    });
    resolveVerifiedSiteMock.mockReturnValue({ ...verifiedSite, siteOrigin: WP_ORIGIN });
    // Request a configured-but-foreign origin (wp2) — the cnx_ is bound to wp.
    const res = await POST(cnxRequest({ ...validBody, origin: "https://wp2.test" }), wpParams);
    expect(res.status).toBe(403);
  });
});
