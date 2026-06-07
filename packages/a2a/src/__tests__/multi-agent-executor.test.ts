/**
 * Tests for MultiAgentExecutor.
 *
 * Mocks `@cinatra/agent-builder` (version lookup) and the `InProcessAgentExecutor`
 * class so behaviour is asserted without DB / BullMQ.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Message } from "@a2a-js/sdk";
import type { ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";

vi.mock("@cinatra/agent-builder", () => ({
  readAgentTemplateByPackageName: vi.fn(),
  readAgentTemplateVersionBySemver: vi.fn(),
}));

const executeSpy = vi.fn().mockResolvedValue(undefined);
const cancelSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../agent-executor", () => {
  class MockInProcessAgentExecutor {
    execute = executeSpy;
    cancelTask = cancelSpy;
    constructor(_opts: unknown) {
      // no-op — we only verify the delegated call behaviour on execute/cancelTask
    }
  }
  return { InProcessAgentExecutor: MockInProcessAgentExecutor };
});

import { readAgentTemplateByPackageName } from "@cinatra-ai/agents";
import { MultiAgentExecutor } from "../multi-agent-executor";

const mockTemplate = readAgentTemplateByPackageName as unknown as ReturnType<
  typeof vi.fn
>;

function buildMessage(opts: {
  metadata?: Record<string, unknown>;
  text?: string;
}): Message {
  return {
    kind: "message",
    messageId: "m-1",
    role: "user",
    parts: opts.text ? [{ kind: "text", text: opts.text }] : [],
    metadata: opts.metadata,
  } as Message;
}

function buildCtx(msg: Message, taskId = "task-x"): RequestContext {
  return {
    userMessage: msg,
    taskId,
    contextId: taskId,
  } as RequestContext;
}

function buildBus(): ExecutionEventBus {
  const published: unknown[] = [];
  return {
    publish: vi.fn((e: unknown) => {
      published.push(e);
    }),
    finished: vi.fn(),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    _published: published,
  } as unknown as ExecutionEventBus;
}

const templates = [
  { id: "t-a", packageName: "pkg-a", name: "A", packageVersion: "1.0.0" },
  { id: "t-b", packageName: "pkg-b", name: "B", packageVersion: "2.0.0" },
];

describe("MultiAgentExecutor", () => {
  beforeEach(() => {
    executeSpy.mockClear();
    cancelSpy.mockClear();
    mockTemplate.mockReset();
  });

  it("dispatches to the matching sub-executor when metadata.skillId is set", async () => {
    mockTemplate.mockResolvedValueOnce({
      id: "t-a",
      packageName: "pkg-a",
      packageVersion: "1.0.0",
    });
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
    });
    const ctx = buildCtx(buildMessage({ metadata: { skillId: "pkg-a" }, text: "hi" }));
    const bus = buildBus();
    await exec.execute(ctx, bus);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("publishes failed TaskStatusUpdateEvent for unknown skillId (SKILL_NOT_FOUND)", async () => {
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
    });
    const ctx = buildCtx(buildMessage({ metadata: { skillId: "unknown" } }));
    const bus = buildBus();
    await exec.execute(ctx, bus);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(bus.finished).toHaveBeenCalled();
    const published = (bus as unknown as { _published: unknown[] })._published;
    expect(published).toHaveLength(1);
    expect((published[0] as { kind: string }).kind).toBe("status-update");
    const text = (published[0] as {
      status: { message?: { parts: { text: string }[] } };
    }).status.message?.parts?.[0]?.text;
    expect(text).toContain("SKILL_NOT_FOUND");
    expect(text).toContain("unknown");
  });

  it("parses JSON envelope in first text part when metadata.skillId is missing", async () => {
    mockTemplate.mockResolvedValueOnce({
      id: "t-a",
      packageName: "pkg-a",
      packageVersion: "1.0.0",
    });
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
    });
    const ctx = buildCtx(
      buildMessage({ text: JSON.stringify({ skillId: "pkg-a", input: {} }) }),
    );
    await exec.execute(ctx, buildBus());
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("publishes failed event (SKILL_ID_REQUIRED) when no skillId is present anywhere", async () => {
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
    });
    const ctx = buildCtx(buildMessage({ text: "free form text" }));
    const bus = buildBus();
    await exec.execute(ctx, bus);
    expect(executeSpy).not.toHaveBeenCalled();
    const published = (bus as unknown as { _published: unknown[] })._published;
    const text = (published[0] as {
      status: { message?: { parts: { text: string }[] } };
    }).status.message?.parts?.[0]?.text;
    expect(text).toContain("SKILL_ID_REQUIRED");
  });

  it("cancelTask — no-op when this executor does not own the task", async () => {
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
    });
    await exec.cancelTask("not-owned", buildBus());
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("cancelTask — forwards exactly once to the owning sub-executor", async () => {
    mockTemplate.mockResolvedValueOnce({
      id: "t-a",
      packageName: "pkg-a",
      packageVersion: "1.0.0",
    });
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
    });
    const ctx = buildCtx(
      buildMessage({ metadata: { skillId: "pkg-a" } }),
      "task-owned",
    );
    await exec.execute(ctx, buildBus());
    // Ownership should persist through execute's finally block.
    expect(exec.ownsTask("task-owned")).toBe(true);
    await exec.cancelTask("task-owned", buildBus());
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    // Ownership is removed after cancel.
    expect(exec.ownsTask("task-owned")).toBe(false);
  });

  it("publishes failed event when version-resolution fails (VERSION_RESOLUTION_FAILED)", async () => {
    // Template is known so SKILL_NOT_FOUND does not trigger — but the template
    // lookup inside resolveVersionBeforeRun returns null, so invalidParams fires.
    mockTemplate.mockResolvedValueOnce(null);
    const exec = new MultiAgentExecutor({
      templates: templates as never,
      enqueueJob: vi.fn(),
    });
    const ctx = buildCtx(buildMessage({ metadata: { skillId: "pkg-a" } }));
    const bus = buildBus();
    await exec.execute(ctx, bus);
    expect(executeSpy).not.toHaveBeenCalled();
    const published = (bus as unknown as { _published: unknown[] })._published;
    const text = (published[0] as {
      status: { message?: { parts: { text: string }[] } };
    }).status.message?.parts?.[0]?.text;
    expect(text).toContain("VERSION_RESOLUTION_FAILED");
  });
});
