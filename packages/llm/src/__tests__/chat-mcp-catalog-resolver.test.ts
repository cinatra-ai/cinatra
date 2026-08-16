import { describe, it, expect, vi } from "vitest";

// The state-derived self-MCP catalog for the chat surface.
//
// The property that matters is BIDIRECTIONAL, and a one-directional test is
// what made the previous shape wrong. Proving "everything we expose is
// allowed" is only half: it passes trivially for a resolver that exposes
// almost nothing, which is exactly how a fixed table hides a newly installed
// connector's primitives. So both directions are pinned here:
//
//   FORWARD   nothing outside the authoritative policy is ever exposed.
//   BACKWARD  every host-approved servable primitive an authorized actor may
//             use IS exposed. No admissible primitive is silently dropped.
//
// The backward direction is what makes the catalog extensible: a primitive
// this test has never heard of, registered by a connector installed after this
// file was written, is required to appear.

// server-only is a runtime marker with no test value; stub it.
vi.mock("server-only", () => ({}));

// Isolate mcp-access from its heavy @/ + external-MCP module graph. None of it
// is exercised by the pure resolver.
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
  buildLlmMcpServerToolForChat,
  resolveChatMcpAllowedTools,
  type ChatMcpCatalogState,
  type ServableChatPrimitive,
} from "../mcp-access";
import {
  delegatedChatAllowedToolNames,
  isDelegatedChatMcpToolAllowed,
} from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";

const ACTOR = {
  delegation: "chat" as const,
  userId: "user_1",
  orgId: "org_1",
  platformRole: "member" as const,
};

/** Everything the policy admits today, as if all of it were registered. */
function servableFromPolicy(): ServableChatPrimitive[] {
  return delegatedChatAllowedToolNames().map((name) => ({ name }));
}

function stateOf(
  servable: readonly ServableChatPrimitive[],
  overrides: Partial<ChatMcpCatalogState> = {},
): ChatMcpCatalogState {
  return {
    servable,
    isHostApproved: isDelegatedChatMcpToolAllowed,
    isCapabilityAvailable: () => true,
    ...overrides,
  };
}

describe("chat MCP catalog: forward direction", () => {
  it("never exposes a name the authoritative policy would refuse", () => {
    const resolved = resolveChatMcpAllowedTools(stateOf(servableFromPolicy()));
    const refused = resolved.filter((name) => !isDelegatedChatMcpToolAllowed(name));
    expect(refused).toEqual([]);
  });

  it("drops a servable primitive the policy refuses, however it was registered", () => {
    const resolved = resolveChatMcpAllowedTools(
      stateOf([
        { name: "agent_list" },
        // Carries a denied verb token.
        { name: "objects_delete" },
        // Denied family prefix.
        { name: "permissions_grant_list" },
      ]),
    );
    expect(resolved).toEqual(["agent_list"]);
  });

  it("a declared class cannot widen: an unadmitted name stays out", () => {
    const resolved = resolveChatMcpAllowedTools(
      stateOf([{ name: "objects_delete", declaredClass: "read" }]),
    );
    expect(resolved).toEqual([]);
  });

  it("a declared class can narrow: an unrecognized class removes an admitted name", () => {
    const admitted = resolveChatMcpAllowedTools(
      stateOf([{ name: "agent_list", declaredClass: "read" }]),
    );
    expect(admitted).toEqual(["agent_list"]);

    const narrowed = resolveChatMcpAllowedTools(
      stateOf([{ name: "agent_list", declaredClass: "internal_only" }]),
    );
    expect(narrowed).toEqual([]);
  });
});

describe("chat MCP catalog: backward direction", () => {
  it("exposes every host-approved servable primitive for an authorized actor", () => {
    // The load-bearing case. Anything the policy admits and the instance can
    // serve must appear, or the catalog is silently hiding capability.
    const resolved = resolveChatMcpAllowedTools(stateOf(servableFromPolicy()));
    expect(resolved).toEqual([...delegatedChatAllowedToolNames()].sort());
  });

  it("exposes a primitive this test has never heard of once it is servable", () => {
    // A connector installed after this file was written registers a primitive
    // whose name no table here knows. With host approval it must appear.
    const NOVEL = "acme_widget_catalog_list";
    expect(delegatedChatAllowedToolNames()).not.toContain(NOVEL);
    const resolved = resolveChatMcpAllowedTools(
      stateOf([{ name: "agent_list" }, { name: NOVEL, declaredClass: "read" }], {
        isHostApproved: (name) => name === NOVEL || isDelegatedChatMcpToolAllowed(name),
      }),
    );
    expect(resolved).toContain(NOVEL);
  });

  it("grows and shrinks with what the instance can serve", () => {
    const two = resolveChatMcpAllowedTools(
      stateOf([{ name: "agent_list" }, { name: "objects_list" }]),
    );
    const one = resolveChatMcpAllowedTools(stateOf([{ name: "agent_list" }]));
    expect(two).toEqual(["agent_list", "objects_list"]);
    expect(one).toEqual(["agent_list"]);
  });
});

describe("chat MCP catalog: capability availability", () => {
  it("withholds a connection-gated primitive with no authorized connection", () => {
    const servable: ServableChatPrimitive[] = [
      { name: "agent_list" },
      { name: "crm_account_get", capabilityKey: "crm" },
    ];
    const withCrm = resolveChatMcpAllowedTools(stateOf(servable));
    const withoutCrm = resolveChatMcpAllowedTools(
      stateOf(servable, { isCapabilityAvailable: () => false }),
    );
    expect(withCrm).toContain("crm_account_get");
    expect(withoutCrm).not.toContain("crm_account_get");
    // An ungated primitive is unaffected by connection state.
    expect(withoutCrm).toContain("agent_list");
  });

  it("does not consult availability for an ungated primitive", () => {
    const isCapabilityAvailable = vi.fn(() => true);
    resolveChatMcpAllowedTools(
      stateOf([{ name: "agent_list" }], { isCapabilityAvailable }),
    );
    expect(isCapabilityAvailable).not.toHaveBeenCalled();
  });
});

describe("chat MCP catalog: determinism", () => {
  it("is registry-order independent and sorted", () => {
    const a = resolveChatMcpAllowedTools(
      stateOf([{ name: "objects_list" }, { name: "agent_list" }]),
    );
    const b = resolveChatMcpAllowedTools(
      stateOf([{ name: "agent_list" }, { name: "objects_list" }]),
    );
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it("deduplicates a primitive registered twice", () => {
    const resolved = resolveChatMcpAllowedTools(
      stateOf([{ name: "agent_list" }, { name: "agent_list" }]),
    );
    expect(resolved).toEqual(["agent_list"]);
  });

  it("is stable across repeated derivations for the same state", () => {
    const state = stateOf(servableFromPolicy());
    expect(JSON.stringify(resolveChatMcpAllowedTools(state))).toBe(
      JSON.stringify(resolveChatMcpAllowedTools(state)),
    );
  });

  it("ignores a malformed registration rather than failing the turn", () => {
    const resolved = resolveChatMcpAllowedTools(
      stateOf([
        { name: "" },
        { name: undefined as unknown as string },
        { name: "agent_list" },
      ]),
    );
    expect(resolved).toEqual(["agent_list"]);
  });
});

describe("buildLlmMcpServerToolForChat: carries the derived catalog", () => {
  const issueToken = vi.fn(() => "signed-token");

  it("stays unrestricted when the host resolves no state", async () => {
    const tool = await buildLlmMcpServerToolForChat("openai", ACTOR, issueToken);
    expect(tool?.allowedTools).toBeNull();
    expect(tool?.type).toBe("mcp");
    expect(tool?.serverLabel).toBe("cinatra");
  });

  it("carries the derived allowlist on the same hosted reference", async () => {
    const tool = await buildLlmMcpServerToolForChat("openai", ACTOR, issueToken, {
      catalogState: stateOf([{ name: "agent_list" }, { name: "objects_list" }]),
    });
    expect(tool?.allowedTools).toEqual(["agent_list", "objects_list"]);
    // Narrowing never becomes inlining, and never changes transport.
    expect(tool?.type).toBe("mcp");
    expect(tool?.serverUrl).toBe("https://mcp.example.test/api/mcp");
    expect(tool?.transport).toBe("streamable-http");
  });

  it("falls back to unrestricted rather than sending an empty allowlist", async () => {
    // Both adapters read an empty allowlist as unrestricted, so an empty
    // derivation must never reach the wire as an allowlist.
    const tool = await buildLlmMcpServerToolForChat("openai", ACTOR, issueToken, {
      catalogState: stateOf([], { isHostApproved: () => false }),
    });
    expect(tool?.allowedTools).toBeNull();
  });

  it("produces a byte-identical allowlist for the same state on both providers", async () => {
    const catalogState = stateOf(servableFromPolicy());
    const first = await buildLlmMcpServerToolForChat("openai", ACTOR, issueToken, {
      catalogState,
    });
    const second = await buildLlmMcpServerToolForChat("anthropic", ACTOR, issueToken, {
      catalogState,
    });
    expect(JSON.stringify(first?.allowedTools)).toBe(
      JSON.stringify(second?.allowedTools),
    );
  });
});
