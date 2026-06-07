/**
 * updateAgentRunStatus triggers expireRunStream for terminal states.
 *
 * Proves that the centralized terminal-status TTL hook fires for every
 * terminal status (completed / failed / stopped) and does NOT fire for
 * non-terminal statuses (running / queued / pending_approval).
 *
 * The DB is mocked with a chainable Drizzle stub so the test runs without a
 * real PostgreSQL instance. @cinatra-ai/a2a is mocked to spy on expireRunStream.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock the DB before any import that might touch it.
// Drizzle's query builder uses a fluent chain: db.update(t).set(v).where(c)
// ---------------------------------------------------------------------------
vi.mock("../db", () => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return {
    db: { update },
    agentBuilderPool: { end: vi.fn() },
  };
});

// Spy on expireRunStream - captures the call without touching real Redis.
vi.mock("@cinatra-ai/a2a", () => ({
  expireRunStream: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks so the mocked modules are in scope.
// ---------------------------------------------------------------------------
import { expireRunStream } from "@cinatra-ai/a2a";
import { updateAgentRunStatus } from "../store";

const mockExpireRunStream = expireRunStream as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("updateAgentRunStatus - expireRunStream TTL hook", () => {
  beforeEach(() => {
    mockExpireRunStream.mockClear();
  });

  it.each(["completed", "failed", "stopped"])(
    "calls expireRunStream(%s) after a terminal status update",
    async (terminalStatus) => {
      const runId = randomUUID();
      await updateAgentRunStatus(runId, terminalStatus);

      // expireRunStream must have been called exactly once with the run's id.
      expect(mockExpireRunStream).toHaveBeenCalledTimes(1);
      expect(mockExpireRunStream).toHaveBeenCalledWith(runId);
    },
  );

  it.each(["running", "queued", "pending_approval", "pending_input"])(
    "does NOT call expireRunStream for non-terminal status '%s'",
    async (nonTerminalStatus) => {
      const runId = randomUUID();
      await updateAgentRunStatus(runId, nonTerminalStatus);

      expect(mockExpireRunStream).not.toHaveBeenCalled();
    },
  );
});
