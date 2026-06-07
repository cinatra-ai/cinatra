import "server-only";

import type {
  AgentCard,
  MessageSendParams,
  SendMessageSuccessResponse,
  Task,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  JSONRPCResponse,
  JSONRPCErrorResponse,
  GetTaskPushNotificationConfigParams,
  DeleteTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
} from "@a2a-js/sdk";
import type { RequestOptions, Transport } from "@a2a-js/sdk/client";
import type { JsonRpcTransportHandler } from "@a2a-js/sdk/server";

// ---------------------------------------------------------------------------
// InProcessTransport
//
// Implements the `@a2a-js/sdk` `Transport` interface by routing all A2A
// JSON-RPC calls directly to a local `JsonRpcTransportHandler` — zero HTTP
// round-trips. Used to invoke A2A agents hosted in the same Node.js process
// (e.g. server-to-server composition inside Next.js server runtime).
//
// Streaming (`sendMessageStream`) is intentionally stubbed and throws a typed
// error until the generator bridge is implemented.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isErrorResponse(
  response: JSONRPCResponse,
): response is JSONRPCErrorResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    "error" in response &&
    response.error !== undefined
  );
}

function unwrapResult<T>(response: JSONRPCResponse, method: string): T {
  if (isErrorResponse(response)) {
    const { code, message, data } = response.error;
    const err = new Error(
      `A2A in-process ${method} failed (code ${code}): ${message}`,
    ) as Error & { code?: number; data?: unknown };
    err.code = code;
    err.data = data;
    throw err;
  }
  // SendMessageSuccessResponse / GetTaskSuccessResponse / CancelTaskSuccessResponse
  // all expose `result` keyed payloads.
  return (response as SendMessageSuccessResponse).result as T;
}

async function callRpc<T>(
  handler: JsonRpcTransportHandler,
  method: string,
  params: unknown,
): Promise<T> {
  const request = {
    jsonrpc: "2.0" as const,
    id: crypto.randomUUID(),
    method,
    params,
  };
  const response = await handler.handle(request);
  // Non-streaming methods resolve to a single JSONRPCResponse object. The
  // handler only returns an AsyncGenerator for `message/stream` and
  // `tasks/resubscribe` — which this transport does not invoke here.
  if (
    response !== null &&
    typeof response === "object" &&
    Symbol.asyncIterator in (response as object)
  ) {
    throw new Error(
      `A2A in-process ${method} unexpectedly returned a streaming response`,
    );
  }
  return unwrapResult<T>(response as JSONRPCResponse, method);
}

// ---------------------------------------------------------------------------
// InProcessTransport
// ---------------------------------------------------------------------------

export class InProcessTransport implements Transport {
  private readonly handler: JsonRpcTransportHandler;
  private readonly agentCard: AgentCard;

  constructor(handler: JsonRpcTransportHandler, agentCard: AgentCard) {
    this.handler = handler;
    this.agentCard = agentCard;
  }

  async getExtendedAgentCard(_options?: RequestOptions): Promise<AgentCard> {
    return this.agentCard;
  }

  async sendMessage(
    params: MessageSendParams,
    _options?: RequestOptions,
  ): ReturnType<Transport["sendMessage"]> {
    return callRpc(this.handler, "message/send", params);
  }

  // INTERIM CONTRACT (pre-streaming-bridge).
  // A real async generator should yield each `result` from the handler's
  // `AsyncGenerator<JSONRPCResponse>` and respect `options?.signal` for
  // cancellation.
  // eslint-disable-next-line require-yield
  async *sendMessageStream(
    _params: MessageSendParams,
    _options?: RequestOptions,
  ): ReturnType<Transport["sendMessageStream"]> {
    throw new Error(
      "Streaming not yet supported on InProcessTransport — use sendMessage for polling-based tasks.",
    );
  }

  async getTask(
    params: TaskQueryParams,
    _options?: RequestOptions,
  ): Promise<Task> {
    return callRpc<Task>(this.handler, "tasks/get", params);
  }

  async cancelTask(
    params: TaskIdParams,
    _options?: RequestOptions,
  ): Promise<Task> {
    return callRpc<Task>(this.handler, "tasks/cancel", params);
  }

  async setTaskPushNotificationConfig(
    _params: TaskPushNotificationConfig,
    _options?: RequestOptions,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error(
      "Push notifications not supported on in-process transport",
    );
  }

  async getTaskPushNotificationConfig(
    _params: GetTaskPushNotificationConfigParams,
    _options?: RequestOptions,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error(
      "Push notifications not supported on in-process transport",
    );
  }

  async listTaskPushNotificationConfig(
    _params: ListTaskPushNotificationConfigParams,
    _options?: RequestOptions,
  ): Promise<TaskPushNotificationConfig[]> {
    throw new Error(
      "Push notifications not supported on in-process transport",
    );
  }

  async deleteTaskPushNotificationConfig(
    _params: DeleteTaskPushNotificationConfigParams,
    _options?: RequestOptions,
  ): Promise<void> {
    throw new Error(
      "Push notifications not supported on in-process transport",
    );
  }

  // INTERIM CONTRACT — resubscribe is a streaming method.
  // eslint-disable-next-line require-yield
  async *resubscribeTask(
    _params: TaskIdParams,
    _options?: RequestOptions,
  ): ReturnType<Transport["resubscribeTask"]> {
    throw new Error(
      "Streaming (resubscribeTask) not yet supported on InProcessTransport.",
    );
  }
}
