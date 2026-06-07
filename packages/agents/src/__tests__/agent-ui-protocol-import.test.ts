// This test verifies that the TypeScript path alias for @cinatra-ai/agent-ui-protocol/server
// resolves correctly from packages/agent-builder. If this file compiles, the path alias is wired correctly.
import { describe, expect, it } from "vitest";
import { AgUiAdapter } from "@cinatra-ai/agent-ui-protocol/server";
import type { AgentUIAdapter } from "@cinatra-ai/agent-ui-protocol";

describe("@cinatra-ai/agent-ui-protocol import resolution (consumer-side check)", () => {
  it("AgUiAdapter is importable from @cinatra-ai/agent-ui-protocol/server", () => {
    // If this test file compiles without TypeScript errors, the tsconfig path alias works.
    expect(typeof AgUiAdapter).toBe("function");
  });

  it("AgentUIAdapter type is importable from @cinatra-ai/agent-ui-protocol root", () => {
    // Type-only import — verifies tier-neutral root is also reachable.
    const _typeCheck: AgentUIAdapter = {
      onRunStarted: () => {},
      onRunFinished: () => {},
      onTextDelta: () => {},
      onToolCallStart: () => {},
      onToolCallEnd: () => {},
      onStateSnapshot: () => {},
      onInterrupt: () => {},
      onResume: () => {},
    };
    expect(_typeCheck).toBeDefined();
  });
});
