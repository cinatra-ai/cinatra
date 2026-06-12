import { describe, it, expect, vi } from "vitest";

// Raw-MCP-exposure proofs.
//
// Asserts the Layer B catalog allowlist actually enforces toolName filtering.
// The Layer A native-MCP allowlist enforcement lives in
// `src/lib/external-mcp-registry.ts` and is tested by its own tests; the focus
// here is the proxy contract that downstream features depend on.
//
// RELOCATED HOST-SIDE (cinatra#172 Stage H1): this test lived in
// `@cinatra-ai/twenty-connector` (`src/__tests__/raw-mcp-exposure.test.ts`)
// but exercises HOST proxy logic — `twenty-execute-tool-proxy` is host code
// whose only runtime importer is the host route — and its `@/` import was the
// connector's last test-only hostInternal edge in the extension-import-ban
// baseline. The connector's vitest config had EXCLUDED the file (it could not
// resolve `@/` from the package sandbox), so the move also makes the proof
// actually run, under the root vitest include.
//
// The registry row lookup (`getExternalMcpServerById`) reads Postgres through
// `runPostgresQueriesSync`; the mock below answers with zero rows so the
// pure-validation branches run DB-free — an unknown serverId is exactly the
// "no matching row" case. A real Twenty row (DB connectivity + the registry
// CRUD helpers) stays out of scope for this unit test.

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(() => [{ rows: [] }]),
}));

import { validateExecuteToolCall } from "@/lib/external-mcp/twenty-execute-tool-proxy";

describe("twenty-execute-tool-proxy — Layer B catalog allowlist", () => {
  it("rejects calls to unknown servers", () => {
    const verdict = validateExecuteToolCall({
      serverId: "definitely-not-a-real-server-id",
      jsonRpc: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "execute_tool", arguments: { toolName: "find_companies" } },
      },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe(-32600);
      expect(verdict.message).toMatch(/not found/);
    }
  });
});
