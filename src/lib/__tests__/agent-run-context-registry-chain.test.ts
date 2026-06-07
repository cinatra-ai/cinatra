/**
 * Agent-run-context registry chain integration test.
 *
 * The agent-run-context registry is the contract wired between the
 * /api/llm-bridge writer and the getRunContext reader in
 * packages/mcp-server/src/index.tsx. This test does NOT mock the registry —
 * it exercises the REAL module to verify the set/clear/get chain honors the
 * contract asserted by run-context-wiring.test.ts. Without this baseline,
 * those mocks could pass while the real registry silently violates the
 * contract.
 *
 * No type-suppression directive — the registry module exists today
 * (src/lib/agent-run-context-registry.ts) so the imports type-check cleanly.
 * This file locks the existing contract.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  setRunContext,
  getRunContext,
  clearRunContext,
} from "@/lib/agent-run-context-registry";

describe("agent-run-context registry chain", () => {
  beforeEach(() => {
    // Defensive: clear all known keys to avoid cross-test bleed via the
    // module-level Map. The registry has no exported "clear all" helper —
    // we clear each key individually.
    [
      "client-A",
      "client-B",
      "client-X",
      "client-Y",
      "client-Z",
    ].forEach((key) => clearRunContext(key));
  });

  it("setRunContext write is readable by getRunContext with the same key", () => {
    setRunContext("client-A", { runId: "run-1", agentId: "email-recipient-selection" });
    const ctx = getRunContext("client-A");
    expect(ctx).toEqual({ runId: "run-1", agentId: "email-recipient-selection" });
  });

  it("clearRunContext removes the entry — getRunContext returns undefined", () => {
    setRunContext("client-B", { runId: "run-2" });
    clearRunContext("client-B");
    expect(getRunContext("client-B")).toBeUndefined();
  });

  it("different keys are independent — writing client-X does not pollute client-Y", () => {
    setRunContext("client-X", { runId: "run-X" });
    expect(getRunContext("client-Y")).toBeUndefined();
    expect(getRunContext("client-X")?.runId).toBe("run-X");
  });

  it("overwrite — second setRunContext for the same key replaces the value", () => {
    setRunContext("client-Z", { runId: "run-Z1" });
    setRunContext("client-Z", { runId: "run-Z2" });
    expect(getRunContext("client-Z")?.runId).toBe("run-Z2");
  });

  it("TTL — entries older than 300s expire and getRunContext returns undefined", () => {
    vi.useFakeTimers();
    try {
      setRunContext("client-A", { runId: "run-ttl" });
      expect(getRunContext("client-A")?.runId).toBe("run-ttl");
      // Registry expires at Date.now() + 300_000; advance just past that.
      vi.advanceTimersByTime(300_001);
      expect(getRunContext("client-A")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
