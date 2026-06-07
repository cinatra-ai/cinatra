import { describe, it, expect, vi, beforeEach } from "vitest";

// Handler-level admin gate regression. Each of the four
// live `agent_source_*` mutating handlers MUST reject a non-admin actor with
// "Unauthorized — admin session required …". The non-delegated
// `/api/agents/passthrough` surface uses createAgentBuilderPrimitiveHandlers()
// without the relay policy, so the handler-level admin gate is the PRIMARY
// gate there (the delegated-chat relay policy is the second wall — pinned in
// packages/mcp-server/src/__tests__/delegated-chat-tool-policy.test.ts).

// Mock auth-session BEFORE the handlers module imports it.
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => false),
}));

import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";

type Handler = (req: {
  primitiveName: string;
  input: Record<string, unknown>;
  actor: { actorType: string; source: string; platformRole?: string };
  mode: string;
}) => Promise<unknown>;

const handlers = createAgentBuilderPrimitiveHandlers() as Record<string, Handler>;

function req(name: string, platformRole: string | null, input: Record<string, unknown> = {}) {
  return {
    primitiveName: name,
    input,
    actor: {
      actorType: "human",
      source: "ui",
      ...(platformRole ? { platformRole } : {}),
    },
    mode: "deterministic",
  };
}

const LIVE = [
  "agent_source_write",
  "agent_source_write_files",
  "agent_source_compile",
  "agent_source_publish",
] as const;

describe("agent_source_* handlers — admin gate (ACCI-GATE-01 + ACCI-CIGATE-02B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const name of LIVE) {
    it(`${name}: non-admin actor → Unauthorized`, async () => {
      const result = (await handlers[name](req(name, null, { packageSlug: "any" }))) as {
        error?: string;
      };
      expect(result.error).toMatch(/Unauthorized.*admin session required/i);
    });

    it(`${name}: admin actor passes the gate (downstream error is fine — gate test is positional)`, async () => {
      const result = (await handlers[name](
        req(name, "platform_admin", { packageSlug: "nonexistent-test-slug" }),
      )) as { error?: string };
      // EITHER no error (gate passed AND downstream produced nothing) OR the
      // error is NOT the admin Unauthorized message (any downstream error
      // like "Agent file not found" or "packageSlug … not found" is acceptable
      // — the gate test is positional, not end-to-end).
      if (result.error) {
        expect(result.error).not.toMatch(/Unauthorized.*admin session required/i);
      }
    });
  }
});
