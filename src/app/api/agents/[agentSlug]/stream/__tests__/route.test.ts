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
const { buildSkillTools, streamMock, ensureSkillForCapabilityMock, readConnectorConfigMock } =
  vi.hoisted(() => ({
    buildSkillTools: vi.fn(),
    streamMock: vi.fn(),
    ensureSkillForCapabilityMock: vi.fn(),
    readConnectorConfigMock: vi.fn(),
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

// connector_config fixtures keyed exactly like prod rows.
const CONNECTOR_CONFIG: Record<string, unknown> = {
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
  readConnectorConfigMock.mockReset();
  readConnectorConfigMock.mockImplementation(
    (key: string, fallback: unknown) => CONNECTOR_CONFIG[key] ?? fallback,
  );
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
      wpRequest({ contractVersion: "v2", messages: [{ role: "user", content: "hi" }] }),
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
