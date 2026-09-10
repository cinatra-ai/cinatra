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

// Keep the suite hermetic. The admin arm of `agent_source_compile` /
// `agent_source_publish` runs past the gate into on-disk path resolution,
// which asks `readInstanceIdentity()` for the operator vendor segment — a
// database read. This is a unit suite: it is handed a connection string that
// points at no database, so that read must never become a real socket
// attempt. It used to look harmless because a refused connection came back
// from the query worker as an empty, successful result set; the worker now
// reports any failure as a failure, so the read raises here exactly as it
// would anywhere else. The seam is the identity read itself: stub it to
// "no identity configured" — the default first-party vendor segment — and the
// gate assertions below are unchanged, positional as they always were.
vi.mock("@/lib/instance-identity-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instance-identity-store")>()),
  readInstanceIdentity: vi.fn(() => null),
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

describe("agent_source_* handlers — admin gate", () => {
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
