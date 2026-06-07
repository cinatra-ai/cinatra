import { beforeEach, describe, expect, it, vi } from "vitest";

// Heavy orchestration + connector barrels are mocked: the contract gate runs
// before any of them is used, so minimal factories are enough to let the route
// module import. buildSkillTools is used to prove a valid-version request gets
// PAST the contract gate (it is the first call after the gate); `stream` is
// driven to exercise the SSE onToolResult → `changes` mapping. Declared via
// vi.hoisted so the references inside the hoisted vi.mock factory are valid.
const { buildSkillTools, streamMock } = vi.hoisted(() => ({
  buildSkillTools: vi.fn(),
  streamMock: vi.fn(),
}));
vi.mock("@cinatra-ai/llm", () => ({
  stream: streamMock,
  buildSkillTools,
}));
vi.mock("@cinatra-ai/drupal-mcp-connector/widget-chat-tool", () => ({
  createDrupalWidgetChatTool: vi.fn(() => ({ type: "function", name: "x" })),
}));
vi.mock("@cinatra-ai/wordpress-mcp-connector/widget-chat-tool", () => ({
  createWordPressWidgetChatTool: vi.fn(() => ({ type: "function", name: "x" })),
}));
vi.mock("@cinatra-ai/skills", () => ({ registerExtensionSkill: vi.fn() }));

const WP_ORIGIN = "https://wp.test";
vi.mock("@/lib/wordpress-widget-auth", () => ({
  resolveWordPressWidgetOrigin: vi.fn(() => WP_ORIGIN),
  validateWordPressWidgetToken: vi.fn(() => true),
  buildWordPressCorsHeaders: vi.fn((origin: string) => ({
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  })),
}));
vi.mock("@/lib/drupal-widget-auth", () => ({
  resolveDrupalWidgetOrigin: vi.fn(() => "https://drupal.test"),
  validateDrupalWidgetToken: vi.fn(() => true),
  buildDrupalCorsHeaders: vi.fn((origin: string) => ({
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  })),
}));

import { POST } from "../route";

function wpRequest(body: unknown): Request {
  return new Request(
    "http://localhost/api/agents/wordpress-content-editor/stream",
    {
      method: "POST",
      headers: {
        Origin: WP_ORIGIN,
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

const wpParams = { params: Promise.resolve({ agentSlug: "wordpress-content-editor" }) };

describe("widget stream route — contract gate wiring", () => {
  beforeEach(() => {
    buildSkillTools.mockReset();
  });

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
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("__past_gate__");
  });

  it("a text-fallback tool result ({ result }) does NOT emit a `changes` SSE frame", async () => {
    buildSkillTools.mockResolvedValueOnce([]);
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
    buildSkillTools.mockResolvedValueOnce([]);
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
});
