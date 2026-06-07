/**
 * Smoke tests for InProcessTransport.
 *
 * Wires up:
 *   InMemoryTaskStore
 *     → DefaultRequestHandler (with a toy echo AgentExecutor)
 *     → JsonRpcTransportHandler
 *     → InProcessTransport
 *
 * Verifies sendMessage / getTask / cancelTask / getExtendedAgentCard routes
 * match the @a2a-js/sdk JSON-RPC contract without any HTTP round-trip, and
 * that sendMessageStream throws the documented interim error.
 */
import { describe, it, expect } from "vitest";
import type {
  AgentCard,
  Artifact,
  Message,
  TextPart,
} from "@a2a-js/sdk";
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";

import { InProcessTransport } from "../in-process-transport";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_CARD: AgentCard = {
  name: "echo-agent",
  description: "Echoes user text back as a completed task artifact.",
  url: "in-process://echo-agent",
  version: "0.0.1",
  protocolVersion: "0.3.0",
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "echo",
      name: "Echo",
      description: "Returns the input text unchanged.",
      tags: ["echo"],
    },
  ],
} as unknown as AgentCard;

function textOf(message: Message): string {
  return message.parts
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * An AgentExecutor that echoes the user's text back as a single completed
 * task artifact.
 */
class EchoExecutor implements AgentExecutor {
  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    const inputText = textOf(requestContext.userMessage);

    const artifact: Artifact = {
      artifactId: crypto.randomUUID(),
      name: "echo-output",
      parts: [{ kind: "text", text: inputText }],
    };

    // 1) Initial Task with status working
    eventBus.publish({
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "working",
        timestamp: new Date().toISOString(),
      },
      artifacts: [artifact],
      history: [requestContext.userMessage],
    });

    // 2) Terminal status-update with final=true → ends the event queue
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state: "completed",
        timestamp: new Date().toISOString(),
      },
      final: true,
    });

    eventBus.finished();
  }

  async cancelTask(
    taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId: "cancel-ctx",
      status: {
        state: "canceled",
        timestamp: new Date().toISOString(),
      },
      final: true,
    });
    eventBus.finished();
  }
}

/**
 * An AgentExecutor that sits in `working` state until explicitly canceled,
 * used to verify cancelTask round-trip without racing against completion.
 */
class LongRunningExecutor implements AgentExecutor {
  private buses = new Map<string, ExecutionEventBus>();

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    this.buses.set(requestContext.taskId, eventBus);
    eventBus.publish({
      kind: "task",
      id: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state: "working",
        timestamp: new Date().toISOString(),
      },
      history: [requestContext.userMessage],
    });
    // Do not publish a terminal event — cancelTask will drive completion.
  }

  async cancelTask(
    taskId: string,
    _eventBus: ExecutionEventBus,
  ): Promise<void> {
    const bus = this.buses.get(taskId) ?? _eventBus;
    bus.publish({
      kind: "status-update",
      taskId,
      contextId: "long-running-ctx",
      status: {
        state: "canceled",
        timestamp: new Date().toISOString(),
      },
      final: true,
    });
    bus.finished();
    this.buses.delete(taskId);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function buildHarness(executor: AgentExecutor) {
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(
    AGENT_CARD,
    taskStore,
    executor,
  );
  const jsonRpcHandler = new JsonRpcTransportHandler(requestHandler);
  const transport = new InProcessTransport(jsonRpcHandler, AGENT_CARD);
  return { transport, taskStore, requestHandler };
}

function userMessage(text: string): Message {
  return {
    kind: "message",
    role: "user",
    messageId: crypto.randomUUID(),
    parts: [{ kind: "text", text }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InProcessTransport", () => {
  it("routes sendMessage to JsonRpcTransportHandler and returns the completed task", async () => {
    const { transport } = buildHarness(new EchoExecutor());

    const result = await transport.sendMessage({
      message: userMessage("hello in-process"),
    });

    // Result is a Task (not a Message) because the executor published a Task.
    expect(result).toBeDefined();
    expect((result as { kind: string }).kind).toBe("task");
    const task = result as {
      id: string;
      status: { state: string };
      artifacts?: Artifact[];
    };
    expect(task.status.state).toBe("completed");
    expect(task.artifacts?.[0]?.parts[0]).toMatchObject({
      kind: "text",
      text: "hello in-process",
    });
  });

  it("routes getTask to tasks/get and returns the stored task state", async () => {
    const { transport } = buildHarness(new EchoExecutor());

    const result = (await transport.sendMessage({
      message: userMessage("round trip"),
    })) as { id: string };
    const taskId = result.id;

    const task = await transport.getTask({ id: taskId });
    expect(task.id).toBe(taskId);
    expect(task.status.state).toBe("completed");
  });

  it("routes cancelTask to tasks/cancel without unhandled errors", async () => {
    const executor = new LongRunningExecutor();
    const { transport } = buildHarness(executor);

    const sendPromise = transport.sendMessage({
      message: userMessage("long running"),
      configuration: { blocking: false },
    });
    const initial = (await sendPromise) as { id: string; status: { state: string } };
    const taskId = initial.id;

    const canceled = await transport.cancelTask({ id: taskId });
    expect(canceled.id).toBe(taskId);
    expect(canceled.status.state).toBe("canceled");
  });

  it("getExtendedAgentCard returns the constructor-provided AgentCard", async () => {
    const { transport } = buildHarness(new EchoExecutor());
    const card = await transport.getExtendedAgentCard();
    expect(card).toBe(AGENT_CARD);
    expect(card.name).toBe("echo-agent");
  });

  it("sendMessageStream throws the interim 'not yet supported' error (locked contract)", async () => {
    const { transport } = buildHarness(new EchoExecutor());

    const iter = transport.sendMessageStream({
      message: userMessage("stream me"),
    });

    await expect(iter.next()).rejects.toThrow(/Streaming not yet supported/);
  });

  it("push notification methods throw a descriptive error", async () => {
    const { transport } = buildHarness(new EchoExecutor());

    await expect(
      transport.setTaskPushNotificationConfig({
        taskId: "any",
        pushNotificationConfig: { url: "http://unused" },
      }),
    ).rejects.toThrow(/not supported on in-process transport/);

    await expect(
      transport.getTaskPushNotificationConfig({ id: "any" }),
    ).rejects.toThrow(/not supported on in-process transport/);

    await expect(
      transport.listTaskPushNotificationConfig({ id: "any" }),
    ).rejects.toThrow(/not supported on in-process transport/);

    await expect(
      transport.deleteTaskPushNotificationConfig({
        id: "any",
        pushNotificationConfigId: "x",
      }),
    ).rejects.toThrow(/not supported on in-process transport/);
  });
});
