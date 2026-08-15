import { describe, it, expect, vi } from "vitest";

// The canonical self-MCP tool-name projection for the chat surface.
//
// Two properties matter and both are pinned here:
//
//   1. AUTHORITY. The projection is an advisory narrowing hint on the provider
//      request. It must never name a primitive the authoritative delegated-chat
//      policy would refuse. Such a name is an unresolvable hint that tells the
//      model a tool exists when the transport will deny it. The check runs
//      through `isDelegatedChatMcpToolAllowed`, the policy's own predicate,
//      rather than against a copied list, so a policy change is caught here
//      instead of drifting silently.
//
//   2. DETERMINISM. The tool block is part of the provider's cacheable prefix,
//      so the same enabled-tier SET must yield a byte-identical array whatever
//      order the tiers arrive in and however many times it is built. Without
//      that, a prefix that looks stable to a reader is unstable on the wire and
//      the cache never reads.

// server-only is a runtime marker with no test value; stub it.
vi.mock("server-only", () => ({}));

// Isolate mcp-access from its heavy @/ + external-MCP module graph. None of it
// is exercised by the pure projection helpers.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: [],
}));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(),
  sanitizeExternalMcpToolboxTools: vi.fn(),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildSingleExternalMcpTool: vi.fn(),
}));
vi.mock("@/lib/llm-toolbox-providers", () => ({
  buildAllToolboxProviderTools: vi.fn(),
}));
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getPublicMcpServerUrl: () => "https://mcp.example.test/api/mcp",
  getLlmMcpCredentials: () => null,
  getLocalTokenEndpointUrl: () => "https://local.example.test/api/auth/token",
  getLocalMcpServerUrl: () => "https://local.example.test/api/mcp",
  hasLlmMcpAccess: () => true,
  getLlmMcpAccessStatus: () => "ok",
}));

import {
  CHAT_MCP_TOOL_TIER_NAMES,
  buildLlmMcpServerToolForChat,
  chatMcpToolTierNames,
  projectAllChatMcpAllowedTools,
  projectChatMcpAllowedTools,
  type ChatMcpToolTier,
} from "../mcp-access";
import { isDelegatedChatMcpToolAllowed } from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";

const ACTOR = {
  delegation: "chat" as const,
  userId: "user_1",
  orgId: "org_1",
  platformRole: "member" as const,
};

describe("chat self-MCP tool projection: authority", () => {
  it("names only primitives the authoritative delegated-chat policy allows", () => {
    const refused = projectAllChatMcpAllowedTools().filter(
      (name) => !isDelegatedChatMcpToolAllowed(name),
    );
    // Name the offenders so a drift is diagnosable from CI output alone.
    expect(refused).toEqual([]);
  });

  it("keeps every individual tier inside the authoritative policy", () => {
    const offenders: Array<{ tier: ChatMcpToolTier; name: string }> = [];
    for (const tier of CHAT_MCP_TOOL_TIER_NAMES) {
      for (const name of chatMcpToolTierNames(tier)) {
        if (!isDelegatedChatMcpToolAllowed(name)) offenders.push({ tier, name });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("narrows: the core tier is materially smaller than the full projection", () => {
    const core = projectChatMcpAllowedTools([]);
    const all = projectAllChatMcpAllowedTools();
    expect(core.length).toBeLessThan(all.length);
    // The whole point is a materially cheaper cold turn, so guard the size of
    // the win rather than merely asserting "smaller".
    expect(core.length / all.length).toBeLessThan(0.5);
  });

  it("assigns every tiered name to exactly one tier", () => {
    const seen = new Map<string, ChatMcpToolTier>();
    const duplicated: string[] = [];
    for (const tier of CHAT_MCP_TOOL_TIER_NAMES) {
      for (const name of chatMcpToolTierNames(tier)) {
        if (seen.has(name)) duplicated.push(name);
        else seen.set(name, tier);
      }
    }
    expect(duplicated).toEqual([]);
  });
});

describe("chat self-MCP tool projection: determinism", () => {
  it("always includes the core tier, whatever is enabled", () => {
    const core = projectChatMcpAllowedTools([]);
    const withCrm = projectChatMcpAllowedTools(["crm"]);
    for (const name of core) expect(withCrm).toContain(name);
  });

  it("is order-independent and sorted", () => {
    const a = projectChatMcpAllowedTools(["crm", "site_content", "metrics_detail"]);
    const b = projectChatMcpAllowedTools(["metrics_detail", "crm", "site_content"]);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it("is idempotent across repeated builds and deduplicates a repeated tier", () => {
    const once = projectChatMcpAllowedTools(["crm"]);
    const twice = projectChatMcpAllowedTools(["crm", "crm", "core"]);
    expect(twice).toEqual(once);
    expect(new Set(once).size).toBe(once.length);
  });

  it("returns a fresh array so a caller cannot mutate the tier tables", () => {
    const first = projectChatMcpAllowedTools([]);
    first.push("not_a_tool");
    expect(projectChatMcpAllowedTools([])).not.toContain("not_a_tool");
  });

  it("ignores an unknown tier rather than failing the turn", () => {
    const projected = projectChatMcpAllowedTools([
      "definitely_not_a_tier" as ChatMcpToolTier,
    ]);
    expect(projected).toEqual(projectChatMcpAllowedTools([]));
  });
});

describe("measurement script stays in lockstep with the projection", () => {
  it("measures the same core tier the chat surface actually sends", async () => {
    // The A/B script is standalone (no workspace resolution, so it can run
    // against a deployed instance from a bare shell) and therefore carries its
    // own copy of the core tier. A copy that drifts would measure a tool set
    // nobody ships, so the copy is pinned here rather than trusted.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.resolve(
      here,
      "../../../../scripts/measure/mcp-allowlist-ab.mjs",
    );
    const source = readFileSync(scriptPath, "utf8");
    const match = source.match(/const CORE_TIER = \[([\s\S]*?)\];/);
    expect(match, "CORE_TIER literal not found in the measurement script").toBeTruthy();
    const scriptTier = [...(match?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(scriptTier).toEqual(projectChatMcpAllowedTools([]));
  });
});

describe("buildLlmMcpServerToolForChat: carries the projection", () => {
  const issueToken = vi.fn(() => "signed-token");

  it("pins allowedTools to the core tier when no tiers are enabled", async () => {
    const tool = await buildLlmMcpServerToolForChat("openai", ACTOR, issueToken);
    expect(tool?.allowedTools).toEqual(projectChatMcpAllowedTools([]));
    // Still ONE hosted MCP reference on the same server, so narrowing never
    // becomes inlining.
    expect(tool?.type).toBe("mcp");
    expect(tool?.serverLabel).toBe("cinatra");
  });

  it("widens to the enabled tiers without touching the transport", async () => {
    const tool = await buildLlmMcpServerToolForChat("openai", ACTOR, issueToken, {
      enabledTiers: ["crm", "site_content"],
    });
    expect(tool?.allowedTools).toEqual(
      projectChatMcpAllowedTools(["crm", "site_content"]),
    );
    expect(tool?.allowedTools).toContain("crm_account_get");
    expect(tool?.allowedTools).toContain("wordpress_site_tools_list");
    expect(tool?.serverUrl).toBe("https://mcp.example.test/api/mcp");
    expect(tool?.transport).toBe("streamable-http");
  });

  it("produces a byte-identical allowlist across two turns with the same tiers", async () => {
    const first = await buildLlmMcpServerToolForChat("openai", ACTOR, issueToken, {
      enabledTiers: ["metrics_detail"],
    });
    const second = await buildLlmMcpServerToolForChat("anthropic", ACTOR, issueToken, {
      enabledTiers: ["metrics_detail"],
    });
    expect(JSON.stringify(first?.allowedTools)).toBe(
      JSON.stringify(second?.allowedTools),
    );
  });

  it("never emits an empty allowlist, which both adapters read as unrestricted", async () => {
    const tool = await buildLlmMcpServerToolForChat("openai", ACTOR, issueToken);
    expect(tool?.allowedTools?.length).toBeGreaterThan(0);
  });
});
