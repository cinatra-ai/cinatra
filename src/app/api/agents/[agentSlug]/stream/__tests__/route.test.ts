import { beforeEach, describe, expect, it, vi } from "vitest";

// Manifest-driven widget-stream RELAY route contract (cinatra#246).
//
// The route is a RELAY: it runs NO LLM and exposes NO function tool. It
// authenticates the widget, builds a deterministic payload (latest user message
// + declared contextFields), and forwards it to the content-editor agent via
// `dispatchContentEditorViaA2A`, then maps the agent's reply to the FROZEN SSE
// wire format (text/changes/error/done). Generic auth (widget-stream-auth +
// broker) and manifest resolution (widget-stream-agents.server, incl. the
// real resolveContentEditorRelay table) run REAL; the A2A dispatch and the DB
// layer are mocked.
const {
  dispatchMock,
  readConnectorConfigMock,
  readMetadataValueMock,
  runPostgresQueriesSyncMock,
  consumeUserWidgetTokenMock,
  resolveCanonicalInstanceForOriginMock,
  resolveOrgRoleForUserMock,
  emitWidgetAuthAuditMock,
} = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  readConnectorConfigMock: vi.fn(),
  readMetadataValueMock: vi.fn(),
  runPostgresQueriesSyncMock: vi.fn(),
  // cinatra#408 dual-token seams (the #407 verify surface + the membership
  // gate). Mocked at the route's call boundary so the test exercises the route's
  // AGREEMENT / fail-closed / override-build / resolver-skip logic, not the
  // (separately, exhaustively #407-tested) token-consume internals.
  consumeUserWidgetTokenMock: vi.fn(),
  resolveCanonicalInstanceForOriginMock: vi.fn(),
  resolveOrgRoleForUserMock: vi.fn(),
  emitWidgetAuthAuditMock: vi.fn(),
}));

// The single host-side relay seam — the route awaits this and maps its returned
// text to SSE frames. Mocked so no real A2A client / OBO carrier run is opened.
vi.mock("@/lib/host-content-editor-dispatch", () => ({
  dispatchContentEditorViaA2A: dispatchMock,
}));
vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: readConnectorConfigMock,
  readMetadataValueFromDatabase: readMetadataValueMock,
}));
// The widget-token-broker (cit_ path) DB layer — mocked as an in-memory store.
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "test_schema",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: vi.fn(),
}));
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: runPostgresQueriesSyncMock,
  quotePostgresIdentifier: (v: string) => `"${v}"`,
}));
// cinatra#408 — the #407 user-token verify surface + the canonical instance
// re-resolver, mocked at the route boundary.
vi.mock("@/lib/widget-user-auth", () => ({
  consumeUserWidgetToken: consumeUserWidgetTokenMock,
  resolveCanonicalInstanceForOrigin: resolveCanonicalInstanceForOriginMock,
}));
// The up-front org-membership gate (resolves a role, undefined = non-member).
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: resolveOrgRoleForUserMock,
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: emitWidgetAuthAuditMock,
}));

const WP_ORIGIN = "https://wp.test";
const ACME_ORIGIN = "https://acme.test";

// cinatra#408 — the per-user proof token. The route now FAIL-CLOSES BY DEFAULT,
// so every request that must REACH dispatch (transport / SSE / contract tests)
// carries this header; the `beforeEach` happy-path mocks make it validate
// (member, agreeing origin/instance). Tests that target the per-user fail-closed
// branches override the relevant mock to drive each denial.
const CWU = "cwu_validusertoken";

// Generated-manifest DATA (what the generator emits from cinatra.widgetStream
// declarations). The wordpress entry mirrors the real one; the acme entry is a
// synthetic third agent that proves manifest+auth routing is generic — but,
// post-#246, a content-editor agent ALSO needs a `relayAgentPackage` in its
// cinatra.widgetStream manifest declaration (read by resolveContentEditorRelay).
// Acme intentionally declares none, so it reaches the relay-resolution step and
// 500s — documenting the one declaration a new content-editor agent requires.
vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_WIDGET_STREAM_AGENTS: {
    "wordpress-content-editor": {
      load: async () => ({}),
      packageName: "@cinatra-ai/wordpress-mcp-connector",
      factory: "createWordPressWidgetChatTool",
      label: "WordPress",
      subjectNoun: "post",
      skillCapability: "widget-chat.wordpress-content-editor",
      relayAgentPackage: "@cinatra-ai/wordpress-agent",
      contextFields: [
        { key: "instanceId", maxLength: 64 },
        { key: "postId", maxLength: 32 },
        { key: "postType", maxLength: 32 },
        { key: "postStatus", maxLength: 32 },
        { key: "href", maxLength: 500 },
      ],
      auth: {
        tokenConfigKey: "wordpress_widget_auth",
        instancesConfigKey: "wordpress",
        requiredInstanceFields: ["id", "name", "username", "applicationPassword"],
      },
    },
    "acme-content-editor": {
      load: async () => ({}),
      packageName: "@acme/acme-cms-connector",
      factory: "createAcmeWidgetChatTool",
      label: "AcmeCMS",
      subjectNoun: "page",
      skillCapability: "widget-chat.acme-content-editor",
      contextFields: [{ key: "pageId", maxLength: 32 }],
      auth: {
        tokenConfigKey: "acme_widget_auth",
        instancesConfigKey: "acme",
        requiredInstanceFields: ["id"],
      },
    },
  },
}));

import { OPTIONS, POST } from "../route";
import { mintWidgetStreamToken } from "@/lib/widget-token-broker";

// In-memory widget_stream_tokens store for the cit_ path (keyed by token_hash),
// driven by the mocked runPostgresQueriesSync. Mirrors the broker SQL coarsely.
type TokenRow = Record<string, unknown> & { token_hash: string; expires_at_ms: number };
const tokenStore = new Map<string, TokenRow>();
let tokenNowMs = Date.now();
function brokerRunQueries(input: { queries: Array<{ text: string; values?: unknown[] }> }) {
  return input.queries.map((q) => {
    const text = q.text;
    const values = q.values ?? [];
    if (text.includes("DELETE FROM") && text.includes("expires_at < now()")) {
      for (const [h, r] of [...tokenStore]) if (r.expires_at_ms < tokenNowMs) tokenStore.delete(h);
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("INSERT INTO")) {
      // expires_at = now() + make_interval(secs => $11) (DB clock); mirror it.
      const [
        token_hash, jti, agent_slug, aud, iss, origin, scope, sub,
        token_config_key, token_key_fingerprint, ttl_secs,
      ] = values as [
        string, string, string, string, string, string, string,
        string | null, string, string, number,
      ];
      tokenStore.set(token_hash, {
        token_hash, jti, agent_slug, aud, iss, origin, scope,
        sub: sub ?? null, token_config_key, token_key_fingerprint,
        expires_at_ms: tokenNowMs + Number(ttl_secs) * 1000,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("SELECT") && text.includes("WHERE token_hash =")) {
      const r = tokenStore.get(values[0] as string);
      if (!r) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          jti: r.jti, agent_slug: r.agent_slug, aud: r.aud, origin: r.origin,
          scope: r.scope, sub: r.sub, token_key_fingerprint: r.token_key_fingerprint,
          not_expired: r.expires_at_ms > tokenNowMs,
        }],
        rowCount: 1,
      };
    }
    if (text.startsWith("DELETE FROM") && text.includes("WHERE token_hash =")) {
      tokenStore.delete(values[0] as string);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

// connector_config fixtures keyed exactly like prod rows. Rebuilt fresh in
// beforeEach (some dual-path tests mutate it — e.g. key rotation, flag flip).
function freshConnectorConfig(): Record<string, unknown> {
  return {
    wordpress: {
      instances: [
        {
          id: "wp-1",
          name: "WP Site",
          siteUrl: WP_ORIGIN,
          username: "admin",
          applicationPassword: "secret",
        },
        // Half-configured row (no applicationPassword): must NOT broaden the
        // origin allowlist (requiredInstanceFields filter).
        { id: "wp-2", name: "Half", siteUrl: "https://half.test", username: "x" },
      ],
    },
    wordpress_widget_auth: { apiKey: "test-key" },
    acme: { instances: [{ id: "acme-1", siteUrl: ACME_ORIGIN }] },
    acme_widget_auth: { apiKey: "acme-key" },
  };
}
let CONNECTOR_CONFIG: Record<string, unknown> = freshConnectorConfig();

function wpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/agents/wordpress-content-editor/stream", {
    method: "POST",
    headers: {
      Origin: WP_ORIGIN,
      Authorization: "Bearer test-key",
      // cinatra#408 — the route fail-closes WITHOUT a per-user token by default,
      // so the generic happy-path request carries it (the beforeEach mocks make
      // it validate). A test can override this header to drive a token-less or
      // failing per-user branch.
      "X-Cinatra-Widget-User-Token": CWU,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const params = (agentSlug: string) => ({ params: Promise.resolve({ agentSlug }) });
const wpParams = params("wordpress-content-editor");

beforeEach(() => {
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue(""); // default: empty agent reply
  CONNECTOR_CONFIG = freshConnectorConfig();
  readConnectorConfigMock.mockReset();
  readConnectorConfigMock.mockImplementation(
    (key: string, fallback: unknown) => CONNECTOR_CONFIG[key] ?? fallback,
  );
  // Fresh (uncached) reads — broker key-auth/mint/kill-switch + forceFresh
  // configured-origin re-check — keyed by `connector_config:<id>`.
  readMetadataValueMock.mockReset();
  readMetadataValueMock.mockImplementation((key: string, fallback: unknown) => {
    const id = key.startsWith("connector_config:") ? key.slice("connector_config:".length) : key;
    return CONNECTOR_CONFIG[id] ?? fallback;
  });
  tokenStore.clear();
  tokenNowMs = Date.now();
  runPostgresQueriesSyncMock.mockReset();
  runPostgresQueriesSyncMock.mockImplementation(brokerRunQueries);

  // cinatra#408 dual-token defaults — happy path: a valid cwu_ that AGREES with
  // the site token (origin/agent/instance) and a user who IS an org member.
  // Individual tests override these to drive each fail-closed branch.
  consumeUserWidgetTokenMock.mockReset();
  consumeUserWidgetTokenMock.mockReturnValue({
    ok: true,
    claims: {
      userId: "u_enduser",
      orgId: "org_1",
      siteId: "site_1",
      client: "wordpress",
      siteOrigin: WP_ORIGIN,
      agentSlug: "wordpress-content-editor",
      instanceId: "wp-1",
      jti: "jti_1",
    },
  });
  resolveCanonicalInstanceForOriginMock.mockReset();
  resolveCanonicalInstanceForOriginMock.mockReturnValue("wp-1");
  resolveOrgRoleForUserMock.mockReset();
  resolveOrgRoleForUserMock.mockResolvedValue("org_member");
  emitWidgetAuthAuditMock.mockReset();
});

describe("widget stream route — manifest-driven resolution + auth", () => {
  it("404s an agent slug with no widgetStream manifest entry", async () => {
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
      params("unknown-agent"),
    );
    expect(res.status).toBe(404);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("403s an Origin that matches no configured instance", async () => {
    const res = await POST(
      wpRequest(
        { contractVersion: "v1", messages: [{ role: "user", content: "hi" }] },
        { Origin: "https://evil.test" },
      ),
      wpParams,
    );
    expect(res.status).toBe(403);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("403s an Origin from a half-configured instance (requiredInstanceFields filter)", async () => {
    const res = await POST(
      wpRequest(
        { contractVersion: "v1", messages: [{ role: "user", content: "hi" }] },
        { Origin: "https://half.test" },
      ),
      wpParams,
    );
    expect(res.status).toBe(403);
  });

  it("401s a wrong Bearer token (with CORS headers)", async () => {
    const res = await POST(
      wpRequest(
        { contractVersion: "v1", messages: [{ role: "user", content: "hi" }] },
        { Authorization: "Bearer wrong" },
      ),
      wpParams,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(WP_ORIGIN);
  });

  it("OPTIONS: 200 + CORS for an allowed origin, 404 for an unknown slug", async () => {
    const ok = await OPTIONS(
      new Request("http://localhost/api/agents/wordpress-content-editor/stream", {
        method: "OPTIONS",
        headers: { Origin: WP_ORIGIN },
      }),
      wpParams,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(WP_ORIGIN);

    const missing = await OPTIONS(
      new Request("http://localhost/api/agents/unknown-agent/stream", {
        method: "OPTIONS",
        headers: { Origin: WP_ORIGIN },
      }),
      params("unknown-agent"),
    );
    expect(missing.status).toBe(404);
  });
});

describe("widget stream route — contract gate wiring", () => {
  it("rejects an unknown contractVersion with a 400 structured error + CORS headers", async () => {
    const res = await POST(
      wpRequest({ contractVersion: "v9", messages: [{ role: "user", content: "hi" }] }),
      wpParams,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(WP_ORIGIN);
    const json = (await res.json()) as { error?: { code?: string; supportedVersions?: string[] } };
    expect(json.error?.code).toBe("unsupported_contract_version");
    expect(json.error?.supportedVersions).toContain("v1");
    // Gate rejected before any relay work.
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("lets a valid v1 request PAST the contract gate (reaches the A2A relay dispatch)", async () => {
    dispatchMock.mockResolvedValueOnce(
      JSON.stringify({ postId: "42", changes: [{ field: "title", before: "a", after: "b" }] }),
    );
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "edit the title" }] }),
      wpParams,
    );
    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("500s a manifest agent that has no content-editor relay configured", async () => {
    // Acme is a valid widgetStream manifest entry with valid auth, so it passes
    // auth + contract — but it has no entry in the host relay table, so the
    // route fails visibly (pre-SSE) rather than half-opening a stream.
    // cinatra#408 — the route now requires the per-user token by default, so the
    // acme request carries one and the consume/agreement mocks are pointed at the
    // acme origin/instance for THIS test (the 500 is reached AFTER the per-user
    // block passes).
    consumeUserWidgetTokenMock.mockReturnValueOnce({
      ok: true,
      claims: {
        userId: "u_enduser",
        orgId: "org_1",
        siteId: "site_acme",
        client: "acme",
        siteOrigin: ACME_ORIGIN,
        agentSlug: "acme-content-editor",
        instanceId: "acme-1",
        jti: "jti_acme",
      },
    });
    resolveCanonicalInstanceForOriginMock.mockReturnValueOnce("acme-1");
    const res = await POST(
      new Request("http://localhost/api/agents/acme-content-editor/stream", {
        method: "POST",
        headers: {
          Origin: ACME_ORIGIN,
          Authorization: "Bearer acme-key",
          "X-Cinatra-Widget-User-Token": CWU,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ contractVersion: "v1", messages: [{ role: "user", content: "edit" }] }),
      }),
      params("acme-content-editor"),
    );
    expect(res.status).toBe(500);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe("widget stream route — relay dispatch + SSE mapping (frozen wire format)", () => {
  it("forwards the latest user instruction + declared contextFields as the A2A payload", async () => {
    await POST(
      wpRequest({
        contractVersion: "v1",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "change the title to Hello" },
        ],
        context: { instanceId: "wp-1", postId: "42", postType: "post", postStatus: "publish" },
      }),
      wpParams,
    );
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0]![0] as {
      agentUrl: string;
      packageName: string;
      timeoutMs: number;
      payload: Record<string, unknown>;
    };
    expect(arg.packageName).toBe("@cinatra-ai/wordpress-agent");
    expect(arg.agentUrl).toBe("http://localhost:3010/agents/cinatra-ai/wordpress-agent/");
    expect(arg.timeoutMs).toBe(300_000);
    expect(arg.payload).toMatchObject({
      instructions: "change the title to Hello",
      instanceId: "wp-1",
      postId: "42",
      postType: "post",
      postStatus: "publish",
    });
  });

  it("maps a structured { changes } reply to a `changes` SSE frame (fields/postId)", async () => {
    dispatchMock.mockResolvedValueOnce(
      JSON.stringify({ postId: "42", changes: [{ field: "title", before: "a", after: "b" }] }),
    );
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "edit" }] }),
      wpParams,
    );
    const body = await res.text();
    expect(body).toContain("event: changes");
    expect(body).toContain('"fields"');
    expect(body).toContain('"postId":"42"');
    expect(body).toContain("event: done");
  });

  it("strips code fences before parsing the agent's JSON reply", async () => {
    dispatchMock.mockResolvedValueOnce(
      '```json\n{"postId":"7","changes":[{"field":"title","before":"x","after":"y"}]}\n```',
    );
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "edit" }] }),
      wpParams,
    );
    const body = await res.text();
    expect(body).toContain("event: changes");
    expect(body).toContain('"postId":"7"');
  });

  it("surfaces a { result } text-fallback reply as a `text` frame (not raw JSON)", async () => {
    dispatchMock.mockResolvedValueOnce(JSON.stringify({ result: "I left the post unchanged." }));
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
      wpParams,
    );
    const body = await res.text();
    expect(body).not.toContain("event: changes");
    expect(body).toContain("event: text");
    expect(body).toContain("I left the post unchanged.");
    expect(body).not.toContain('"result"'); // never dump the JSON wrapper
  });

  it("surfaces a non-JSON conversational reply as a `text` frame", async () => {
    dispatchMock.mockResolvedValueOnce("Hello! How can I help with this post?");
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
      wpParams,
    );
    const body = await res.text();
    expect(body).not.toContain("event: changes");
    expect(body).toContain("event: text");
    expect(body).toContain("Hello! How can I help with this post?");
  });

  it("emits done{fallback:true} for an empty agent reply", async () => {
    dispatchMock.mockResolvedValueOnce("");
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
      wpParams,
    );
    const body = await res.text();
    expect(body).not.toContain("event: text");
    expect(body).not.toContain("event: changes");
    expect(body).toContain("event: done");
    expect(body).toContain('"fallback":true');
  });

  it("emits an `error` frame (then done) when the A2A dispatch throws", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "edit" }] }),
      wpParams,
    );
    expect(res.status).toBe(200); // SSE opened; error surfaced as a frame
    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).not.toContain("boom"); // internal message is sanitized
    expect(body).toContain("event: done");
  });
});

describe("widget stream route — dual-path auth (cinatra#220)", () => {
  // Mint a real cit_ token through the broker (the broker's DB is mocked to the
  // in-memory tokenStore above), then present it to the stream route.
  function mintCit(origin = WP_ORIGIN) {
    const minted = mintWidgetStreamToken({
      agentSlug: "wordpress-content-editor",
      auth: CONNECTOR_CONFIG.wordpress_widget_auth
        ? {
            tokenConfigKey: "wordpress_widget_auth",
            instancesConfigKey: "wordpress",
            requiredInstanceFields: ["id", "name", "username", "applicationPassword"],
          }
        : (undefined as never),
      origin,
      issuerBaseUrl: "https://instance.cinatra.ai",
    });
    if (!minted) throw new Error("mint failed in test setup");
    return minted.token;
  }

  function streamRequestWith(token: string, headers: Record<string, string> = {}) {
    return new Request("http://localhost/api/agents/wordpress-content-editor/stream", {
      method: "POST",
      headers: {
        Origin: WP_ORIGIN,
        Authorization: `Bearer ${token}`,
        // cinatra#408 — carry the per-user proof so the site-token-path tests
        // that EXPECT to reach dispatch (cit_/legacy accepted) pass the now
        // default-on per-user gate. Site-auth FAILURE tests (wrong origin /
        // rotated key / kill-switch) deny earlier at the site gate, before the
        // per-user block, so this header is inert for them.
        "X-Cinatra-Widget-User-Token": CWU,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
    });
  }

  it("accepts a short-lived cit_ token (no Deprecation header on the modern path)", async () => {
    dispatchMock.mockResolvedValueOnce("hi");
    const token = mintCit();
    const res = await POST(streamRequestWith(token), wpParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
  });

  it("401s a cit_ token whose bound origin ≠ the request Origin (token-bound origin is authoritative)", async () => {
    const token = mintCit(WP_ORIGIN);
    const res = await POST(streamRequestWith(token, { Origin: "https://half.test" }), wpParams);
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("401s a cit_ token after the long-lived key is rotated (fingerprint mismatch)", async () => {
    const token = mintCit();
    // Rotate the key AFTER mint.
    CONNECTOR_CONFIG.wordpress_widget_auth = { apiKey: "rotated-key" };
    const res = await POST(streamRequestWith(token), wpParams);
    expect(res.status).toBe(401);
  });

  it("legacy long-lived path: accepted + emits Deprecation/Sunset (exposed via CORS)", async () => {
    dispatchMock.mockResolvedValueOnce("hi");
    const res = await POST(streamRequestWith("test-key"), wpParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Sunset")).toBeTruthy();
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Deprecation");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Sunset");
  });

  it("legacy long-lived path: 403 when widgetLongLivedTokenEnabled=false", async () => {
    CONNECTOR_CONFIG.wordpress_widget_auth = {
      apiKey: "test-key",
      widgetLongLivedTokenEnabled: false,
    };
    const res = await POST(streamRequestWith("test-key"), wpParams);
    expect(res.status).toBe(403);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("legacy long-lived path: rotating the key immediately 401s the old key (fresh read, no cache)", async () => {
    // The validator reads UNCACHED, so the rotated key takes effect at once.
    CONNECTOR_CONFIG.wordpress_widget_auth = { apiKey: "rotated-legacy-key" };
    const res = await POST(streamRequestWith("test-key"), wpParams);
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cinatra#408 — DUAL-TOKEN per-user validation (fail-closed runBy=userId).
// The legacy long-lived `Authorization` key (`test-key`) carries the site/origin
// proof; the new `X-Cinatra-Widget-User-Token` header carries the per-user proof.
// (CWU is declared near the top — the route now fail-closes by default.)
// ---------------------------------------------------------------------------

function dualTokenRequest(
  headers: Record<string, string> = {},
  body?: unknown,
): Request {
  return new Request("http://localhost/api/agents/wordpress-content-editor/stream", {
    method: "POST",
    headers: {
      Origin: WP_ORIGIN,
      Authorization: "Bearer test-key", // site proof (legacy path, accepted)
      "X-Cinatra-Widget-User-Token": CWU, // per-user proof
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(
      body ?? { contractVersion: "v1", messages: [{ role: "user", content: "edit the title" }] },
    ),
  });
}

describe("widget stream route — dual-token per-user validation (cinatra#408)", () => {
  it("authed member: dispatches with an actorOverride runBy=userId, sourceType=public_site_widget, instance pinned", async () => {
    dispatchMock.mockResolvedValueOnce("ok");
    const res = await POST(dualTokenRequest(), wpParams);
    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const arg = dispatchMock.mock.calls[0]![0] as {
      actorOverride?: { runBy: string; orgId: string; instanceId: string; sourceType: string };
      payload: Record<string, unknown>;
    };
    expect(arg.actorOverride).toEqual({
      runBy: "u_enduser",
      orgId: "org_1",
      instanceId: "wp-1",
      sourceType: "public_site_widget",
    });
    // The write target in the payload is the SERVER-DERIVED token instance.
    expect(arg.payload.instanceId).toBe("wp-1");
    // An authorization audit event is emitted (the per-user OBO override was
    // minted; the event marks the decision, not dispatch success).
    expect(emitWidgetAuthAuditMock).toHaveBeenCalledWith(
      "stream_user_dispatch_authorized",
      expect.objectContaining({ actor: "u_enduser", orgId: "org_1" }),
    );
  });

  it("invalid/expired cwu_: 401 with X-Cinatra-Widget-Auth: required, NO run, resolver-skip", async () => {
    consumeUserWidgetTokenMock.mockReturnValueOnce({ ok: false, reason: "expired" });
    const res = await POST(dualTokenRequest(), wpParams);
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Cinatra-Widget-Auth")).toBe("required");
    // FAIL-CLOSED: no dispatch (so no carrier run), and the reject is audited.
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(emitWidgetAuthAuditMock).toHaveBeenCalledWith(
      "stream_user_token_rejected",
      expect.objectContaining({ reason: "expired" }),
    );
  });

  it("not_found cwu_ (tampered token): 401, no run", async () => {
    consumeUserWidgetTokenMock.mockReturnValueOnce({ ok: false, reason: "not_found" });
    const res = await POST(dualTokenRequest(), wpParams);
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("origin disagreement (cwu_ siteOrigin ≠ verified cit_ origin): 401, no run", async () => {
    // The token validates but is bound to a DIFFERENT site than the request.
    consumeUserWidgetTokenMock.mockReturnValueOnce({
      ok: true,
      claims: {
        userId: "u_enduser",
        orgId: "org_1",
        siteId: "site_2",
        client: "wordpress",
        siteOrigin: "https://other.test", // ≠ WP_ORIGIN (the verified cit_ origin)
        agentSlug: "wordpress-content-editor",
        instanceId: "wp-1",
        jti: "jti_1",
      },
    });
    const res = await POST(dualTokenRequest(), wpParams);
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(emitWidgetAuthAuditMock).toHaveBeenCalledWith(
      "stream_user_token_rejected",
      expect.objectContaining({ reason: "origin_disagreement" }),
    );
  });

  it("instance re-assert fails (zero/multiple origin rows): 401, no run", async () => {
    resolveCanonicalInstanceForOriginMock.mockReturnValueOnce(null);
    const res = await POST(dualTokenRequest(), wpParams);
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(emitWidgetAuthAuditMock).toHaveBeenCalledWith(
      "stream_user_token_rejected",
      expect.objectContaining({ reason: "instance_binding_failed" }),
    );
  });

  it("non-member (valid cwu_ but not in claims.org): 401, no run, no dispatch", async () => {
    resolveOrgRoleForUserMock.mockResolvedValueOnce(undefined); // non-member
    const res = await POST(dualTokenRequest(), wpParams);
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(emitWidgetAuthAuditMock).toHaveBeenCalledWith(
      "stream_user_token_rejected",
      expect.objectContaining({ reason: "not_org_member" }),
    );
  });

  it("forged body.context.instanceId (≠ token instance): 401, no run", async () => {
    const res = await POST(
      dualTokenRequest(
        {},
        {
          contractVersion: "v1",
          messages: [{ role: "user", content: "edit" }],
          context: { instanceId: "wp-FORGED" }, // ≠ claims.instanceId "wp-1"
        },
      ),
      wpParams,
    );
    expect(res.status).toBe(401);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(emitWidgetAuthAuditMock).toHaveBeenCalledWith(
      "stream_user_token_rejected",
      expect.objectContaining({ reason: "instance_mismatch" }),
    );
  });

  it("matching body.context.instanceId == token instance: allowed", async () => {
    dispatchMock.mockResolvedValueOnce("ok");
    const res = await POST(
      dualTokenRequest(
        {},
        {
          contractVersion: "v1",
          messages: [{ role: "user", content: "edit" }],
          context: { instanceId: "wp-1" }, // == claims.instanceId
        },
      ),
      wpParams,
    );
    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("NO user token present + no flag (production default): 401 fail-closed, NO dispatch", async () => {
    // cinatra#408 fail-closed-by-DEFAULT: the wordpress-content-editor entry
    // declares NO requireUserToken (mirrors the real generated manifest). The
    // route MUST still require the per-user cwu_ token on this interactive
    // public_site_widget surface — a missing token can NEVER fall back to the
    // install/site identity (the confused-deputy bypass this change closes).
    dispatchMock.mockResolvedValueOnce("ok");
    const res = await POST(
      new Request("http://localhost/api/agents/wordpress-content-editor/stream", {
        method: "POST",
        headers: {
          Origin: WP_ORIGIN,
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ contractVersion: "v1", messages: [{ role: "user", content: "edit" }] }),
      }),
      wpParams,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Cinatra-Widget-Auth")).toBe("required");
    // No carrier run / install-identity dispatch may occur on the token-less path.
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(consumeUserWidgetTokenMock).not.toHaveBeenCalled();
  });

  it("EXPLICIT requireUserToken=false opt-out: token-less dispatch allowed (install identity, NO override)", async () => {
    // The ONLY way to permit a token-less dispatch is an EXPLICIT, audited
    // opt-out. This is the deliberate escape hatch — proving (a) it works and
    // (b) it is the SOLE path to a token-less site-identity dispatch.
    const { GENERATED_WIDGET_STREAM_AGENTS } = await import("@/lib/generated/extensions.server");
    const entry = GENERATED_WIDGET_STREAM_AGENTS["wordpress-content-editor"] as {
      auth: { requireUserToken?: boolean };
    };
    entry.auth.requireUserToken = false;
    try {
      dispatchMock.mockResolvedValueOnce("ok");
      const res = await POST(
        new Request("http://localhost/api/agents/wordpress-content-editor/stream", {
          method: "POST",
          headers: {
            Origin: WP_ORIGIN,
            Authorization: "Bearer test-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ contractVersion: "v1", messages: [{ role: "user", content: "edit" }] }),
        }),
        wpParams,
      );
      expect(res.status).toBe(200);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      const arg = dispatchMock.mock.calls[0]![0] as { actorOverride?: unknown };
      // No override → the install/single-tenant resolver path (legacy back-compat).
      expect(arg.actorOverride).toBeUndefined();
      expect(consumeUserWidgetTokenMock).not.toHaveBeenCalled();
    } finally {
      delete entry.auth.requireUserToken;
    }
  });

  it("requireUserToken=true + NO user token: 401 re-login (fail-closed mandatory path)", async () => {
    // Flip the per-agent policy flag on the resolved manifest entry for this test.
    const { GENERATED_WIDGET_STREAM_AGENTS } = await import("@/lib/generated/extensions.server");
    const entry = GENERATED_WIDGET_STREAM_AGENTS["wordpress-content-editor"] as {
      auth: { requireUserToken?: boolean };
    };
    entry.auth.requireUserToken = true;
    try {
      const res = await POST(
        new Request("http://localhost/api/agents/wordpress-content-editor/stream", {
          method: "POST",
          headers: {
            Origin: WP_ORIGIN,
            Authorization: "Bearer test-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ contractVersion: "v1", messages: [{ role: "user", content: "edit" }] }),
        }),
        wpParams,
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("X-Cinatra-Widget-Auth")).toBe("required");
      expect(dispatchMock).not.toHaveBeenCalled();
    } finally {
      delete entry.auth.requireUserToken;
    }
  });

  it("CORS: OPTIONS allow-headers includes X-Cinatra-Widget-User-Token; expose includes X-Cinatra-Widget-Auth", async () => {
    const res = await OPTIONS(
      new Request("http://localhost/api/agents/wordpress-content-editor/stream", {
        method: "OPTIONS",
        headers: { Origin: WP_ORIGIN },
      }),
      wpParams,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Cinatra-Widget-User-Token");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("X-Cinatra-Widget-Auth");
  });
});
