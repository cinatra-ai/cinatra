/**
 * Tests for LegacyAgentA2AExecutor and createLegacyAgentA2AClient.
 *
 * These tests exercise the hook-driven bridge to legacy code-based agent
 * packages (scrape, research, enrichment). No Postgres / Redis / BullMQ
 * involvement — the `LegacyAgentHooks` interface is pure DI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { TextPart } from "@a2a-js/sdk";

import { createLegacyAgentA2AClient } from "../legacy-client";
import type { LegacyAgentHooks } from "../legacy-agent-executor";

function buildHooks(overrides: Partial<LegacyAgentHooks> = {}): LegacyAgentHooks {
  return {
    start: vi.fn().mockResolvedValue({ executionId: "e-1" }),
    readStatus: vi.fn().mockResolvedValue({ status: "succeeded" }),
    readArtifacts: vi.fn().mockResolvedValue([] as TextPart[]),
    cancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("LegacyAgentA2AExecutor + createLegacyAgentA2AClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1) start hook called once with user message text and a taskId", async () => {
    const hooks = buildHooks();
    const client = createLegacyAgentA2AClient({
      agentId: "scrape",
      hooks,
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });

    await client.sendMessage({ text: "url1\nurl2" });
    expect(hooks.start).toHaveBeenCalledTimes(1);
    const arg = (hooks.start as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { text: string; taskId: string };
    expect(arg.text).toBe("url1\nurl2");
    expect(typeof arg.taskId).toBe("string");
    expect(arg.taskId.length).toBeGreaterThan(0);
  }, 5_000);

  it("2) state mapping — running → working → completed", async () => {
    let call = 0;
    const hooks = buildHooks({
      readStatus: vi.fn().mockImplementation(async () => {
        call += 1;
        if (call <= 2) return { status: "running" as const };
        return { status: "succeeded" as const };
      }),
      readArtifacts: vi.fn().mockResolvedValue([
        { kind: "text", text: "r" } satisfies TextPart,
      ]),
    });
    const client = createLegacyAgentA2AClient({
      agentId: "scrape",
      hooks,
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });

    const task = await client.sendMessage({ text: "x" });
    expect(task.status.state).toBe("completed");
    expect(hooks.readArtifacts).toHaveBeenCalledTimes(1);
  }, 5_000);

  it("3) state mapping — failed propagates error into status message", async () => {
    const hooks = buildHooks({
      readStatus: vi
        .fn()
        .mockResolvedValue({ status: "failed", error: "boom" }),
    });
    const client = createLegacyAgentA2AClient({
      agentId: "scrape",
      hooks,
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });

    const task = await client.sendMessage({ text: "x" });
    expect(task.status.state).toBe("failed");
    const parts = task.status.message?.parts ?? [];
    const text = parts
      .filter((p): p is TextPart => p.kind === "text")
      .map((p) => p.text)
      .join(" ");
    expect(text).toContain("boom");
  }, 5_000);

  it("4) state mapping — stopped → canceled", async () => {
    const hooks = buildHooks({
      readStatus: vi.fn().mockResolvedValue({ status: "stopped" }),
    });
    const client = createLegacyAgentA2AClient({
      agentId: "scrape",
      hooks,
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });

    const task = await client.sendMessage({ text: "x" });
    expect(task.status.state).toBe("canceled");
  }, 5_000);

  it("5) state mapping — idle on first poll → submitted (non-terminal), then succeeded → completed", async () => {
    let call = 0;
    const hooks = buildHooks({
      readStatus: vi.fn().mockImplementation(async () => {
        call += 1;
        if (call <= 1) return { status: "idle" as const };
        return { status: "succeeded" as const };
      }),
      readArtifacts: vi.fn().mockResolvedValue([] as TextPart[]),
    });
    const client = createLegacyAgentA2AClient({
      agentId: "scrape",
      hooks,
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });

    const task = await client.sendMessage({ text: "x" });
    // idle maps to "submitted" (non-terminal) — polling continues until a terminal state.
    expect(task.status.state).toBe("completed");
    expect(hooks.readStatus).toHaveBeenCalledTimes(2);
  }, 5_000);

  it("6) artifacts populated from readArtifacts with agentId-results name", async () => {
    const hooks = buildHooks({
      readArtifacts: vi.fn().mockResolvedValue([
        { kind: "text", text: "result-a" } satisfies TextPart,
        { kind: "text", text: "result-b" } satisfies TextPart,
      ]),
    });
    const client = createLegacyAgentA2AClient({
      agentId: "scrape",
      hooks,
      pollIntervalMs: 5,
      pollTimeoutMs: 2_000,
    });

    const task = await client.sendMessage({ text: "x" });
    expect(task.artifacts).toBeDefined();
    expect(Array.isArray(task.artifacts)).toBe(true);
    expect(task.artifacts!.length).toBeGreaterThan(0);
    const first = task.artifacts![0];
    expect(first.name).toBe("scrape-results");
    const texts = first.parts
      .filter((p): p is TextPart => p.kind === "text")
      .map((p) => p.text);
    expect(texts).toContain("result-a");
    expect(texts).toContain("result-b");
  }, 5_000);

  it("7) cancelTask calls the cancel hook and yields canceled Task", async () => {
    const hooks = buildHooks({
      readStatus: vi.fn().mockResolvedValue({ status: "running" }),
    });
    const client = createLegacyAgentA2AClient({
      agentId: "scrape",
      hooks,
      pollIntervalMs: 5,
      pollTimeoutMs: 5_000,
    });

    // Kick off long-running sendMessage; don't await it.
    const sendPromise = client.sendMessage({ text: "x" });
    // Wait briefly for start hook to run and executor to register aborter.
    await new Promise((r) => setTimeout(r, 50));

    // Grab the taskId from start-hook invocation.
    const startArg = (hooks.start as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { taskId: string };
    const taskId = startArg.taskId;

    await client.cancelTask(taskId);
    // Let sendMessage settle.
    await sendPromise.catch(() => undefined);

    expect(hooks.cancel).toHaveBeenCalledTimes(1);
    const cancelArg = (hooks.cancel as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { executionId: string; taskId: string };
    expect(cancelArg.executionId).toBe("e-1");
    expect(cancelArg.taskId).toBe(taskId);

    const finalTask = await client.getTask(taskId);
    expect(finalTask.status.state).toBe("canceled");
  }, 10_000);

  it("8) observer timeout publishes failed with OBSERVER_TIMEOUT code and does NOT cancel legacy job", async () => {
    const hooks = buildHooks({
      readStatus: vi.fn().mockResolvedValue({ status: "running" }),
    });
    const client = createLegacyAgentA2AClient({
      agentId: "scrape",
      hooks,
      pollIntervalMs: 5,
      pollTimeoutMs: 20,
    });

    const task = await client.sendMessage({ text: "x" });
    expect(task.status.state).toBe("failed");
    const parts = task.status.message?.parts ?? [];
    const text = parts
      .filter((p): p is TextPart => p.kind === "text")
      .map((p) => p.text)
      .join(" ");
    expect(text).toContain("OBSERVER_TIMEOUT");
    expect(hooks.cancel).not.toHaveBeenCalled();
  }, 5_000);

  it("9) dedup — repeated running status does not call readArtifacts more than once", async () => {
    let call = 0;
    const hooks = buildHooks({
      readStatus: vi.fn().mockImplementation(async () => {
        call += 1;
        if (call <= 5) return { status: "running" as const };
        return { status: "succeeded" as const };
      }),
      readArtifacts: vi.fn().mockResolvedValue([
        { kind: "text", text: "done" } satisfies TextPart,
      ]),
    });
    const client = createLegacyAgentA2AClient({
      agentId: "scrape",
      hooks,
      pollIntervalMs: 5,
      pollTimeoutMs: 5_000,
    });

    const task = await client.sendMessage({ text: "x" });
    expect(task.status.state).toBe("completed");
    expect(hooks.readArtifacts).toHaveBeenCalledTimes(1);
  }, 10_000);
});
