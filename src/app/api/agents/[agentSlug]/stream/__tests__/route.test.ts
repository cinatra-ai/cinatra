import { beforeEach, describe, expect, it, vi } from "vitest";

// Manifest-driven widget-stream route contract.
//
// The generated agent map + connector_config DB reads are mocked as DATA; the
// route, the generic registry resolution (widget-stream-agents.server) and the
// generic auth (widget-stream-auth) run REAL. Heavy orchestration is mocked:
// buildSkillTools proves a valid-version request gets PAST the contract gate;
// `stream` is driven to exercise the SSE onToolResult → `changes` mapping.
// The synthetic "acme-content-editor" entry proves HOST ROUTING + TOOL LOADING
// extensibility only (adding a widget agent = a manifest entry, no host edit) —
// NOT a generalized widget wire protocol (the request/SSE contract stays the
// frozen WP/Drupal v1 shape).
const {
  buildSkillTools,
  streamMock,
  ensureSkillForCapabilityMock,
  readConnectorConfigMock,
  readMetadataValueMock,
  runPostgresQueriesSyncMock,
} = vi.hoisted(() => ({
  buildSkillTools: vi.fn(),
  streamMock: vi.fn(),
  ensureSkillForCapabilityMock: vi.fn(),
  readConnectorConfigMock: vi.fn(),
  readMetadataValueMock: vi.fn(),
  runPostgresQueriesSyncMock: vi.fn(),
}));

vi.mock("@cinatra-ai/llm", () => ({
  stream: streamMock,
  buildSkillTools,
}));
vi.mock("@cinatra-ai/skills", () => ({
  ensureSkillForCapability: ensureSkillForCapabilityMock,
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

const WP_ORIGIN = "https://wp.test";
const ACME_ORIGIN = "https://acme.test";

// Generated-manifest DATA (what the generator emits from cinatra.widgetStream
// declarations). The wordpress entry mirrors the real one; the acme entry is
// the synthetic third agent that proves no-host-edit extensibility.
vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_WIDGET_STREAM_AGENTS: {
    "wordpress-content-editor": {
      load: async () => ({
        createWordPressWidgetChatTool: (opts: { context: Record<string, unknown> }) => ({
          type: "function",
          name: "wordpress_content_editor_run",
          description: "x",
          parameters: { type: "object" },
          execute: async () => ({ context: opts.context }),
        }),
      }),
      packageName: "@cinatra-ai/wordpress-mcp-connector",
      factory: "createWordPressWidgetChatTool",
      label: "WordPress",
      subjectNoun: "post",
      skillCapability: "widget-chat.wordpress-content-editor",
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
      load: async () => ({
        createAcmeWidgetChatTool: () => ({
          type: "function",
          name: "acme_content_editor_run",
          description: "x",
          parameters: { type: "object" },
          execute: async () => ({}),
        }),
      }),
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
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const params = (agentSlug: string) => ({ params: Promise.resolve({ agentSlug }) });
const wpParams = params("wordpress-content-editor");

// Realistic buildSkillTools result: since the read_skill function-tool was
// retired (skills CATALOG-registry-only + shell-tool delivery rule, enforced
// by scripts/audit/read-skill-function-tool-banned.mjs), skills are delivered
// as a single shell tool — `{ type: "shell", skills, execute }`. The route
// only requires a non-empty array here; the SSE `changes` mapping keys off
// the WIDGET function tool's name, never the skill tool.
const mountedSkillShellTool = {
  type: "shell",
  skills: [
    {
      name: "widget-content-editor",
      description: "Widget content-editing skill",
      path: "/skills/widget-content-editor/SKILL.md",
    },
  ],
  execute: async () => [],
};

beforeEach(() => {
  buildSkillTools.mockReset();
  streamMock.mockReset();
  ensureSkillForCapabilityMock.mockReset();
  ensureSkillForCapabilityMock.mockImplementation(async (cap: string) => `${cap}:skill-id`);
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
});

describe("widget stream route — manifest-driven resolution + auth", () => {
  it("404s an agent slug with no widgetStream manifest entry", async () => {
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
      params("unknown-agent"),
    );
    expect(res.status).toBe(404);
    expect(buildSkillTools).not.toHaveBeenCalled();
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
    // Gate rejected before any orchestration work.
    expect(buildSkillTools).not.toHaveBeenCalled();
    expect(ensureSkillForCapabilityMock).not.toHaveBeenCalled();
  });

  it("lets a valid v1 request PAST the contract gate (reaches buildSkillTools)", async () => {
    // buildSkillTools throwing proves the gate passed; the route converts the
    // throw into a clean 500, not a contract 400.
    buildSkillTools.mockRejectedValueOnce(new Error("__past_gate__"));
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
      wpParams,
    );
    expect(buildSkillTools).toHaveBeenCalledTimes(1);
    // The skill is resolved through the DECLARED capability key via the
    // generic extension-skill-resolver (connector-co-located skills allowed).
    expect(ensureSkillForCapabilityMock).toHaveBeenCalledWith(
      "widget-chat.wordpress-content-editor",
      { allowKinds: ["skill", "connector"] },
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("__past_gate__");
  });

  it("500s (fail-visible, pre-SSE) when the skill capability resolves to NO mountable skill tools", async () => {
    buildSkillTools.mockResolvedValueOnce([]);
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
      wpParams,
    );
    expect(res.status).toBe(500);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("500s (fail-visible, pre-SSE) when no active extension provides the skill capability", async () => {
    ensureSkillForCapabilityMock.mockRejectedValueOnce(
      new Error("No active extension provides the skill capability"),
    );
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
      wpParams,
    );
    expect(res.status).toBe(500);
    expect(buildSkillTools).not.toHaveBeenCalled();
  });
});

describe("widget stream route — SSE tool-result mapping (frozen wire format)", () => {
  it("a text-fallback tool result ({ result }) does NOT emit a `changes` SSE frame", async () => {
    buildSkillTools.mockResolvedValueOnce([mountedSkillShellTool]);
    streamMock.mockImplementationOnce(async (opts: { onToolResult?: (r: { name: string; result: string }) => void }) => {
      opts.onToolResult?.({
        name: "wordpress_content_editor_run",
        result: JSON.stringify({ result: "I left the post unchanged." }),
      });
    });
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
      wpParams,
    );
    const body = await res.text();
    expect(body).not.toContain("event: changes");
    // No text + no changes → done with fallback:true.
    expect(body).toContain("event: done");
    expect(body).toContain('"fallback":true');
  });

  it("a structured tool result ({ changes }) emits a `changes` SSE frame mapped to `fields`", async () => {
    buildSkillTools.mockResolvedValueOnce([mountedSkillShellTool]);
    streamMock.mockImplementationOnce(async (opts: { onToolResult?: (r: { name: string; result: string }) => void }) => {
      opts.onToolResult?.({
        name: "wordpress_content_editor_run",
        result: JSON.stringify({ postId: "42", changes: [{ field: "title", before: "a", after: "b" }] }),
      });
    });
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "edit" }] }),
      wpParams,
    );
    const body = await res.text();
    expect(body).toContain("event: changes");
    expect(body).toContain('"fields"');
    expect(body).toContain('"postId":"42"');
  });

  it("a foreign tool result (name ≠ the built widget tool's name) is ignored", async () => {
    buildSkillTools.mockResolvedValueOnce([mountedSkillShellTool]);
    streamMock.mockImplementationOnce(async (opts: { onToolResult?: (r: { name: string; result: string }) => void }) => {
      opts.onToolResult?.({
        name: "some_other_tool",
        result: JSON.stringify({ changes: [{ field: "title", before: "a", after: "b" }] }),
      });
    });
    const res = await POST(
      wpRequest({ contractVersion: "v1", messages: [{ role: "user", content: "edit" }] }),
      wpParams,
    );
    const body = await res.text();
    expect(body).not.toContain("event: changes");
  });
});

describe("widget stream route — host extensibility (synthetic third agent)", () => {
  // Routing + tool loading + auth for a NEW widget agent work from manifest
  // data alone (no host edit). Scope: host plumbing only — the widget wire
  // protocol itself remains the frozen WP/Drupal v1 contract.
  it("serves a manifest-declared third agent end-to-end with its own tool name + auth keys", async () => {
    buildSkillTools.mockResolvedValueOnce([mountedSkillShellTool]);
    streamMock.mockImplementationOnce(async (opts: { onToolResult?: (r: { name: string; result: string }) => void }) => {
      opts.onToolResult?.({
        name: "acme_content_editor_run",
        result: JSON.stringify({ changes: [{ field: "body", before: "a", after: "b" }] }),
      });
    });
    const res = await POST(
      new Request("http://localhost/api/agents/acme-content-editor/stream", {
        method: "POST",
        headers: {
          Origin: ACME_ORIGIN,
          Authorization: "Bearer acme-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ contractVersion: "v1", messages: [{ role: "user", content: "edit" }] }),
      }),
      params("acme-content-editor"),
    );
    expect(res.status).toBe(200);
    expect(ensureSkillForCapabilityMock).toHaveBeenCalledWith(
      "widget-chat.acme-content-editor",
      { allowKinds: ["skill", "connector"] },
    );
    const body = await res.text();
    expect(body).toContain("event: changes");
    // System prompt was built from the declared label/subjectNoun/contextFields.
    const streamArgs = streamMock.mock.calls[0]![0] as { system: string };
    expect(streamArgs.system).toContain("AcmeCMS content editor");
    expect(streamArgs.system).toContain("current page");
    expect(streamArgs.system).toContain("Current AcmeCMS context:");
    expect(streamArgs.system).toContain("- pageId:");
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
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ contractVersion: "v1", messages: [{ role: "user", content: "hi" }] }),
    });
  }

  it("accepts a short-lived cit_ token (no Deprecation header on the modern path)", async () => {
    buildSkillTools.mockResolvedValueOnce([mountedSkillShellTool]);
    streamMock.mockImplementationOnce(async (opts: { onTextDelta?: (d: string) => void }) => {
      opts.onTextDelta?.("hi");
    });
    const token = mintCit();
    const res = await POST(streamRequestWith(token), wpParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
  });

  it("401s a cit_ token whose bound origin ≠ the request Origin (token-bound origin is authoritative)", async () => {
    const token = mintCit(WP_ORIGIN);
    // Present the token from a DIFFERENT (but still-configured) site? Only one
    // configured site exists; spoof the request Origin to a non-bound value.
    const res = await POST(streamRequestWith(token, { Origin: "https://half.test" }), wpParams);
    // half.test is half-configured → not a valid CORS allowlist origin either,
    // but the cit_ path's authority is the token-bound origin mismatch → 401.
    expect(res.status).toBe(401);
    expect(buildSkillTools).not.toHaveBeenCalled();
  });

  it("401s a cit_ token after the long-lived key is rotated (fingerprint mismatch)", async () => {
    const token = mintCit();
    // Rotate the key AFTER mint.
    CONNECTOR_CONFIG.wordpress_widget_auth = { apiKey: "rotated-key" };
    const res = await POST(streamRequestWith(token), wpParams);
    expect(res.status).toBe(401);
  });

  it("legacy long-lived path: accepted + emits Deprecation/Sunset (exposed via CORS)", async () => {
    buildSkillTools.mockResolvedValueOnce([mountedSkillShellTool]);
    streamMock.mockImplementationOnce(async (opts: { onTextDelta?: (d: string) => void }) => {
      opts.onTextDelta?.("hi");
    });
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
    expect(buildSkillTools).not.toHaveBeenCalled();
  });

  it("legacy long-lived path: rotating the key immediately 401s the old key (fresh read, no cache)", async () => {
    // The validator reads UNCACHED, so the rotated key takes effect at once.
    CONNECTOR_CONFIG.wordpress_widget_auth = { apiKey: "rotated-legacy-key" };
    const res = await POST(streamRequestWith("test-key"), wpParams);
    expect(res.status).toBe(401);
    expect(buildSkillTools).not.toHaveBeenCalled();
  });
});
