import { describe, expect, it, vi } from "vitest";

// Capabilities endpoint (cinatra#220). AUTH-FREE static contract metadata. The
// generated agent map is mocked as DATA; the route + buildCapabilities run
// REAL. The key assertion is that NO instance data / auth config keys / package
// names / extension internals leak into the body.
vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_WIDGET_STREAM_AGENTS: {
    "wordpress-content-editor": {
      load: async () => ({}),
      packageName: "@cinatra-ai/wordpress-mcp-connector",
      factory: "createWordPressWidgetChatTool",
      label: "WordPress",
      subjectNoun: "post",
      skillCapability: "widget-chat.wordpress-content-editor",
      contextFields: [{ key: "postId", maxLength: 32 }],
      auth: {
        tokenConfigKey: "wordpress_widget_auth",
        instancesConfigKey: "wordpress",
        requiredInstanceFields: ["id", "name", "username", "applicationPassword"],
      },
    },
  },
}));

import { GET, OPTIONS } from "../route";

const params = (agentSlug: string) => ({ params: Promise.resolve({ agentSlug }) });

function capRequest(slug: string): Request {
  return new Request(`https://instance.cinatra.ai/api/agents/${slug}/capabilities`, {
    method: "GET",
  });
}

describe("capabilities route", () => {
  it("404s an unknown agent slug", async () => {
    const res = await GET(capRequest("nope"), params("nope"));
    expect(res.status).toBe(404);
  });

  it("returns the slug-scoped capability shape", async () => {
    const res = await GET(capRequest("wordpress-content-editor"), params("wordpress-content-editor"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      agentSlug: string;
      contractVersion: string;
      supportedContractVersions: string[];
      minContractVersion: string;
      maxContractVersion: string;
      capabilities: Record<string, unknown>;
    };
    expect(json.agentSlug).toBe("wordpress-content-editor");
    expect(json.contractVersion).toBe("v2");
    expect(json.supportedContractVersions).toEqual(["v1", "v2"]);
    expect(json.minContractVersion).toBe("v1");
    expect(json.maxContractVersion).toBe("v2");
    expect(json.capabilities.supportsTokenExchange).toBe(true);
    expect(json.capabilities.supportsChangesFrame).toBe(true);
    expect(json.capabilities.sseFrames).toEqual(["text", "changes", "error", "done"]);
    expect(json.capabilities.streamPath).toBe("/api/agents/wordpress-content-editor/stream");
    expect(json.capabilities.tokenPath).toBe("/api/agents/wordpress-content-editor/token");
  });

  it("emits CORS headers so the browser widget can read it cross-origin", async () => {
    const res = await GET(capRequest("wordpress-content-editor"), params("wordpress-content-editor"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("OPTIONS: 200 + CORS for a known slug, 404 for an unknown slug", async () => {
    const ok = await OPTIONS(capRequest("wordpress-content-editor"), params("wordpress-content-editor"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const missing = await OPTIONS(capRequest("nope"), params("nope"));
    expect(missing.status).toBe(404);
  });

  it("leaks NO instance data, auth config keys, package names, or extension internals", async () => {
    const res = await GET(capRequest("wordpress-content-editor"), params("wordpress-content-editor"));
    const text = await res.text();
    // None of the manifest internals may appear in the auth-free body.
    expect(text).not.toContain("wordpress_widget_auth"); // tokenConfigKey
    expect(text).not.toContain("instancesConfigKey");
    expect(text).not.toContain("requiredInstanceFields");
    expect(text).not.toContain("applicationPassword");
    expect(text).not.toContain("@cinatra-ai/wordpress-mcp-connector"); // package name
    expect(text).not.toContain("createWordPressWidgetChatTool"); // factory
    expect(text).not.toContain("skillCapability");
  });
});
