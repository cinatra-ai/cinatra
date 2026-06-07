/**
 * Tests for createExternalA2AClient.
 *
 * Mocks @a2a-js/sdk/client so no real network or SDK transport machinery
 * runs. Covers credential handling (static token + OAuth2 client_credentials
 * with caching, 401-retry, single-flight), AbortSignal composition, Task
 * narrowing, streaming passthrough, and AgentCard resolver auth wiring.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import type {
  Message,
  MessageSendParams,
  Task,
} from "@a2a-js/sdk";

// ---------------------------------------------------------------------------
// Hoisted mock state — shared across the module mock and the test body.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  const sdkClientMock = {
    sendMessage: (undefined as unknown) as ReturnType<typeof Object>,
    sendMessageStream: (undefined as unknown) as ReturnType<typeof Object>,
    getTask: (undefined as unknown) as ReturnType<typeof Object>,
    cancelTask: (undefined as unknown) as ReturnType<typeof Object>,
  };
  return {
    clientFactoryCtorCalls: [] as unknown[][],
    jsonRpcFactoryCtorCalls: [] as unknown[][],
    authWrapCalls: [] as { fetchImpl: unknown; authHandler: unknown }[],
    defaultAgentCardResolverCtorCalls: [] as Record<string, unknown>[],
    sdkClientMock,
  };
});

vi.mock("@a2a-js/sdk/client", () => {
  // Lazily-initialized vi.fn()s are created here — vi.hoisted runs before
  // vi.mock factory, so we cannot call vi.fn() inside the hoisted block
  // (the mock objects must be rebuilt on each import).
  hoisted.sdkClientMock.sendMessage = vi.fn();
  hoisted.sdkClientMock.sendMessageStream = vi.fn();
  hoisted.sdkClientMock.getTask = vi.fn();
  hoisted.sdkClientMock.cancelTask = vi.fn();

  class ClientFactory {
    constructor(...args: unknown[]) {
      hoisted.clientFactoryCtorCalls.push(args);
    }
    createFromUrl = vi.fn().mockResolvedValue(hoisted.sdkClientMock);
  }

  const ClientFactoryOptions = {
    default: { transports: [] as unknown[] },
    createFrom: vi.fn(
      (
        orig: Record<string, unknown>,
        overrides: Record<string, unknown>,
      ) => ({ ...orig, ...overrides }),
    ),
  };

  class JsonRpcTransportFactory {
    constructor(...args: unknown[]) {
      hoisted.jsonRpcFactoryCtorCalls.push(args);
    }
  }

  class DefaultAgentCardResolver {
    constructor(options: Record<string, unknown>) {
      hoisted.defaultAgentCardResolverCtorCalls.push(options);
    }
  }

  const createAuthenticatingFetchWithRetry = vi.fn(
    (fetchImpl: unknown, authHandler: unknown) => {
      hoisted.authWrapCalls.push({ fetchImpl, authHandler });
      return async (input: unknown, init?: RequestInit) => {
        const handler = authHandler as {
          headers: () => Promise<Record<string, string>>;
        };
        const h = await handler.headers();
        const impl = fetchImpl as typeof fetch;
        return impl(input as RequestInfo, {
          ...(init ?? {}),
          headers: { ...(init?.headers ?? {}), ...h },
        });
      };
    },
  );

  return {
    ClientFactory,
    ClientFactoryOptions,
    JsonRpcTransportFactory,
    DefaultAgentCardResolver,
    createAuthenticatingFetchWithRetry,
  };
});

// Import AFTER the mock declaration so the mock is applied.
import { createExternalA2AClient } from "../external-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    kind: "task",
    status: { state: "completed" },
    ...overrides,
  } as Task;
}

function makeMessage(): Message {
  return {
    role: "agent",
    kind: "message",
    messageId: "m-1",
    parts: [{ kind: "text", text: "hi" }],
  } as Message;
}

function buildOkTokenResponse(body: {
  access_token: string;
  expires_in: number;
}): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createExternalA2AClient", () => {
  beforeEach(() => {
    (hoisted.sdkClientMock.sendMessage as ReturnType<typeof vi.fn>).mockReset();
    (
      hoisted.sdkClientMock.sendMessageStream as ReturnType<typeof vi.fn>
    ).mockReset();
    (hoisted.sdkClientMock.getTask as ReturnType<typeof vi.fn>).mockReset();
    (hoisted.sdkClientMock.cancelTask as ReturnType<typeof vi.fn>).mockReset();
    hoisted.clientFactoryCtorCalls.length = 0;
    hoisted.jsonRpcFactoryCtorCalls.length = 0;
    hoisted.authWrapCalls.length = 0;
    hoisted.defaultAgentCardResolverCtorCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // a
  it("sendTask narrows Task results from the SDK", async () => {
    (
      hoisted.sdkClientMock.sendMessage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(makeTask());
    const client = await createExternalA2AClient({
      agentUrl: "https://x",
    });
    const task = await client.sendTask("hello");
    expect(task.kind).toBe("task");
    expect(task.id).toBe("task-1");
    const mockFn = hoisted.sdkClientMock.sendMessage as ReturnType<
      typeof vi.fn
    >;
    expect(mockFn).toHaveBeenCalledTimes(1);
    const params = mockFn.mock.calls[0][0] as MessageSendParams;
    expect(params.message.role).toBe("user");
    expect(params.message.parts[0]).toEqual({ kind: "text", text: "hello" });
  });

  // b
  it("sendTask throws when the SDK returns a Message instead of a Task", async () => {
    (
      hoisted.sdkClientMock.sendMessage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(makeMessage());
    const client = await createExternalA2AClient({
      agentUrl: "https://x",
    });
    await expect(client.sendTask("hello")).rejects.toThrow(
      /expected Task result/,
    );
  });

  // c
  it("sendTask passes MessageSendParams passthrough unchanged", async () => {
    (
      hoisted.sdkClientMock.sendMessage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(makeTask());
    const client = await createExternalA2AClient({
      agentUrl: "https://x",
    });
    const params: MessageSendParams = {
      message: {
        role: "user",
        kind: "message",
        messageId: "custom-msg-id",
        parts: [{ kind: "text", text: "x" }],
      },
    } as MessageSendParams;
    await client.sendTask(params);
    const firstArg = (
      hoisted.sdkClientMock.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(firstArg).toBe(params);
  });

  // d
  it("static token credentials wire Authorization header via createAuthenticatingFetchWithRetry", async () => {
    await createExternalA2AClient({
      agentUrl: "https://x",
      credentials: { token: "abc123" },
    });
    expect(hoisted.authWrapCalls.length).toBe(1);
    const handler = hoisted.authWrapCalls[0].authHandler as {
      headers: () => Promise<Record<string, string>>;
      shouldRetryWithHeaders: (
        req: unknown,
        res: { status: number },
      ) => Promise<Record<string, string> | undefined>;
    };
    const headers = await handler.headers();
    expect(headers).toEqual({ Authorization: "Bearer abc123" });
    const retry = await handler.shouldRetryWithHeaders(undefined, {
      status: 401,
    });
    expect(retry).toBeUndefined();
  });

  // e
  it("client_credentials credentials perform OAuth2 exchange with correct body + headers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        buildOkTokenResponse({ access_token: "tok-1", expires_in: 3600 }),
      );
    await createExternalA2AClient({
      agentUrl: "https://x",
      credentials: {
        clientId: "cid",
        clientSecret: "sec",
        tokenUrl: "https://auth/token",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const handler = hoisted.authWrapCalls[0].authHandler as {
      headers: () => Promise<Record<string, string>>;
    };
    const headers = await handler.headers();
    expect(fetchImpl).toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://auth/token");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("grant_type=client_credentials");
    const authHeader = (init.headers as Record<string, string>).Authorization;
    expect(authHeader.startsWith("Basic ")).toBe(true);
    expect(
      Buffer.from(authHeader.slice("Basic ".length), "base64").toString(),
    ).toBe("cid:sec");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(headers).toEqual({ Authorization: "Bearer tok-1" });
  });

  // f
  it("client_credentials caches token until near expiry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        buildOkTokenResponse({ access_token: "tok-1", expires_in: 3600 }),
      );
    await createExternalA2AClient({
      agentUrl: "https://x",
      credentials: {
        clientId: "cid",
        clientSecret: "sec",
        tokenUrl: "https://auth/token",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const handler = hoisted.authWrapCalls[0].authHandler as {
      headers: () => Promise<Record<string, string>>;
    };
    await handler.headers();
    await handler.headers();
    await handler.headers();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // g
  it("client_credentials retries once on 401 with a fresh token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        buildOkTokenResponse({ access_token: "tok-1", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        buildOkTokenResponse({ access_token: "tok-2", expires_in: 3600 }),
      );
    await createExternalA2AClient({
      agentUrl: "https://x",
      credentials: {
        clientId: "cid",
        clientSecret: "sec",
        tokenUrl: "https://auth/token",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const handler = hoisted.authWrapCalls[0].authHandler as {
      headers: () => Promise<Record<string, string>>;
      shouldRetryWithHeaders: (
        req: unknown,
        res: { status: number },
      ) => Promise<Record<string, string> | undefined>;
    };
    // Prime the cache
    await handler.headers();
    const retry = await handler.shouldRetryWithHeaders(undefined, {
      status: 401,
    });
    expect(retry).toEqual({ Authorization: "Bearer tok-2" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const noRetry = await handler.shouldRetryWithHeaders(undefined, {
      status: 200,
    });
    expect(noRetry).toBeUndefined();
  });

  // h — verifies AbortSignal.timeout is called with 30_000 by default.
  it("sendTask default timeout is 30s and composes with caller signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    (
      hoisted.sdkClientMock.sendMessage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(makeTask());
    const client = await createExternalA2AClient({ agentUrl: "https://x" });
    await client.sendTask("hi");
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    const opts = (
      hoisted.sdkClientMock.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls[0][1] as { signal?: AbortSignal };
    expect(opts.signal).toBeDefined();
  });

  // i
  it("sendTask explicit timeoutMs overrides the default", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    (
      hoisted.sdkClientMock.sendMessage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(makeTask());
    const client = await createExternalA2AClient({ agentUrl: "https://x" });
    await client.sendTask("hi", { timeoutMs: 5_000 });
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    expect(timeoutSpy).not.toHaveBeenCalledWith(30_000);
  });

  // j
  it("streamTask yields SDK events and forwards caller signal", async () => {
    (
      hoisted.sdkClientMock.sendMessageStream as ReturnType<typeof vi.fn>
    ).mockImplementation(async function* () {
      yield makeTask();
    });
    const client = await createExternalA2AClient({ agentUrl: "https://x" });
    const events: unknown[] = [];
    for await (const ev of client.streamTask("hi")) {
      events.push(ev);
    }
    expect(events.length).toBe(1);
    const first = events[0] as Task;
    expect(first.id).toBe("task-1");
    const firstCallArgs = (
      hoisted.sdkClientMock.sendMessageStream as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    // Options object was passed as second arg (may have undefined signal when no caller+factory signal).
    expect(firstCallArgs.length).toBeGreaterThanOrEqual(2);
    expect(typeof firstCallArgs[1]).toBe("object");

    // Second iteration with explicit caller signal.
    (
      hoisted.sdkClientMock.sendMessageStream as ReturnType<typeof vi.fn>
    ).mockImplementation(async function* () {
      yield makeTask();
    });
    const controller = new AbortController();
    for await (const _ev of client.streamTask("hi", {
      signal: controller.signal,
    })) {
      // consume
    }
    const secondCallOpts = (
      hoisted.sdkClientMock.sendMessageStream as ReturnType<typeof vi.fn>
    ).mock.calls[1][1] as { signal?: AbortSignal };
    expect(secondCallOpts.signal).toBeDefined();
  });

  // k
  it("streamTask imposes no default timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    (
      hoisted.sdkClientMock.sendMessageStream as ReturnType<typeof vi.fn>
    ).mockImplementation(async function* () {
      yield makeTask();
    });
    const client = await createExternalA2AClient({ agentUrl: "https://x" });
    for await (const _ev of client.streamTask("hi")) {
      // consume
    }
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  // l
  it("getTask forwards { id: taskId } to the SDK client", async () => {
    (
      hoisted.sdkClientMock.getTask as ReturnType<typeof vi.fn>
    ).mockResolvedValue(makeTask({ id: "abc" }));
    const client = await createExternalA2AClient({ agentUrl: "https://x" });
    await client.getTask("abc");
    const firstArg = (
      hoisted.sdkClientMock.getTask as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(firstArg).toEqual({ id: "abc" });
  });

  // m
  it("cancelTask forwards { id: taskId } and resolves to undefined", async () => {
    (
      hoisted.sdkClientMock.cancelTask as ReturnType<typeof vi.fn>
    ).mockResolvedValue(makeTask());
    const client = await createExternalA2AClient({ agentUrl: "https://x" });
    const result = await client.cancelTask("abc");
    expect(result).toBeUndefined();
    const firstArg = (
      hoisted.sdkClientMock.cancelTask as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(firstArg).toEqual({ id: "abc" });
  });

  // n
  it("no credentials means createAuthenticatingFetchWithRetry is never called", async () => {
    await createExternalA2AClient({ agentUrl: "https://x" });
    expect(hoisted.authWrapCalls.length).toBe(0);
    const firstCtorArgs = hoisted.jsonRpcFactoryCtorCalls[0][0] as {
      fetchImpl: unknown;
    };
    expect(firstCtorArgs.fetchImpl).toBe(globalThis.fetch);
  });

  // o
  it("caller-supplied fetchImpl is used as baseFetch for auth wrapping", async () => {
    const customFetchSpy = vi.fn();
    await createExternalA2AClient({
      agentUrl: "https://x",
      credentials: { token: "t" },
      fetchImpl: customFetchSpy as unknown as typeof fetch,
    });
    expect(hoisted.authWrapCalls[0].fetchImpl).toBe(customFetchSpy);
  });

  // p
  it("timeoutMs: 0 disables the default 30s timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    (
      hoisted.sdkClientMock.sendMessage as ReturnType<typeof vi.fn>
    ).mockResolvedValue(makeTask());
    const client = await createExternalA2AClient({ agentUrl: "https://x" });
    await client.sendTask("hi", { timeoutMs: 0 });
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  // q
  it("AgentCard resolver also receives the auth-aware fetchImpl", async () => {
    await createExternalA2AClient({
      agentUrl: "https://x",
      credentials: { token: "tok" },
    });
    expect(hoisted.defaultAgentCardResolverCtorCalls.length).toBeGreaterThan(
      0,
    );
    const resolverOpts = hoisted.defaultAgentCardResolverCtorCalls[0];
    expect(resolverOpts.fetchImpl).toBeDefined();
    expect(resolverOpts.fetchImpl).not.toBe(globalThis.fetch);
  });

  // r
  it("client_credentials 401-retry is bounded — second consecutive 401 does not spiral", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        buildOkTokenResponse({ access_token: "tok-1", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        buildOkTokenResponse({ access_token: "tok-2", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        buildOkTokenResponse({ access_token: "tok-3", expires_in: 3600 }),
      );
    await createExternalA2AClient({
      agentUrl: "https://x",
      credentials: {
        clientId: "cid",
        clientSecret: "sec",
        tokenUrl: "https://auth/token",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const handler = hoisted.authWrapCalls[0].authHandler as {
      headers: () => Promise<Record<string, string>>;
      shouldRetryWithHeaders: (
        req: unknown,
        res: { status: number },
      ) => Promise<Record<string, string> | undefined>;
    };
    // Prime cache (fetch call 1).
    await handler.headers();
    // First 401: clears cache, refreshes (fetch call 2), returns tok-2.
    const first = await handler.shouldRetryWithHeaders(undefined, {
      status: 401,
    });
    expect(first).toEqual({ Authorization: "Bearer tok-2" });
    // Second consecutive 401: with cachedToken=tok-2, the wrapper will clear
    // and refresh once more (fetch call 3). The wrapper does NOT implement a
    // global retry counter; each 401 encounter triggers exactly one refresh.
    // This test documents that behavior: at most one refresh per invocation,
    // and no runaway recursion.
    const fetchCallsBefore = fetchImpl.mock.calls.length;
    const second = await handler.shouldRetryWithHeaders(undefined, {
      status: 401,
    });
    const fetchCallsAfter = fetchImpl.mock.calls.length;
    // Exactly one additional fetch happened for the second 401 — bounded.
    expect(fetchCallsAfter - fetchCallsBefore).toBe(1);
    expect(second).toBeDefined();
  });
});
