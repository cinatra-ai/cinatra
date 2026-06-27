import "server-only";

import { randomUUID } from "node:crypto";

import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  createAuthenticatingFetchWithRetry,
  type AuthenticationHandler,
} from "@a2a-js/sdk/client";
import type {
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";

// The SDK's internal `SendMessageResult` / `A2AStreamEventData` unions are not
// re-exported from any public subpath. Recreate them here from the same
// public building blocks the SDK uses internally so our public wrapper API
// matches the underlying `Client.sendMessage` / `Client.sendMessageStream`
// return shapes exactly.
type SendMessageResult = Message | Task;
export type A2AStreamEventData =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

/**
 * Strips trailing `/` characters from a string in linear time.
 *
 * Replaces the regex `value.replace(/\/+$/, "")`, which is polynomial
 * (O(n^2)) on adversarial input such as `"/".repeat(n) + "x"` — the
 * end-anchored `\/+$` retries at every offset (js/polynomial-redos).
 * `options.agentUrl` is caller-supplied, so the linear form is preferred.
 * Behaviorally identical to the old regex (verified by fuzz).
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return value.slice(0, end);
}

// ---------------------------------------------------------------------------
// createExternalA2AClient
//
// Cinatra-idiomatic wrapper around `@a2a-js/sdk`'s `ClientFactory` that adds
// credential injection (static bearer token OR OAuth2 client_credentials with
// cached access tokens), a default timeout for `sendTask`, and cancellation
// ergonomics (AbortSignal composition) on top of the SDK's own transport
// retry behavior.
//
// This wrapper is the remote counterpart to `createInProcessA2AClient` in
// `./client.ts` — orchestrator code using `client.sendTask(...)` is identical
// for both in-process virtual agents and external HTTP A2A agents (LangGraph,
// ADK, CrewAI, remote Cinatra instances, etc.).
//
// Notes:
// - Do NOT add retry logic on top of the SDK's own transport retries — the
//   `AuthenticationHandler.shouldRetryWithHeaders` 401-retry is the only
//   retry this wrapper introduces.
// - Push-notification methods are intentionally out of scope.
// - Independent from `./client.ts` (the in-process client) — no shared code.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StaticTokenCredentials = { token: string };

export type ClientCredentials = {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
};

export type ExternalA2AClientCredentials =
  | StaticTokenCredentials
  | ClientCredentials;

export type ExternalA2AClientOptions = {
  agentUrl: string;
  /**
   * Optional override for the AgentCard discovery path. When omitted, the
   * SDK's `ClientFactory.createFromUrl` uses "/.well-known/agent-card.json"
   * by default.
   */
  agentCardPath?: string;
  credentials?: ExternalA2AClientCredentials;
  /**
   * Default timeout (ms) applied to `sendTask` when the caller omits a
   * per-call `timeoutMs`. Defaults to 30_000. Pass `0` to disable the
   * default timeout entirely.
   */
  timeoutMs?: number;
  /**
   * Factory-level cancellation signal composed into every per-call signal.
   */
  signal?: AbortSignal;
  /**
   * Dependency injection seam for tests. Defaults to `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
};

export type SendTaskOptions = { signal?: AbortSignal; timeoutMs?: number };
export type StreamTaskOptions = { signal?: AbortSignal };
export type GetTaskOptions = { signal?: AbortSignal };
export type CancelTaskOptions = { signal?: AbortSignal };

export type ExternalA2AClient = {
  sendTask(
    message: string | MessageSendParams,
    options?: SendTaskOptions,
  ): Promise<Task>;
  streamTask(
    message: string | MessageSendParams,
    options?: StreamTaskOptions,
  ): AsyncGenerator<A2AStreamEventData, void, undefined>;
  getTask(taskId: string, options?: GetTaskOptions): Promise<Task>;
  cancelTask(taskId: string, options?: CancelTaskOptions): Promise<void>;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function composeSignals(
  signals: (AbortSignal | undefined)[],
  timeoutMs?: number,
): AbortSignal | undefined {
  const list: AbortSignal[] = signals.filter(
    (s): s is AbortSignal => s !== undefined,
  );
  if (
    typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
  ) {
    list.push(AbortSignal.timeout(timeoutMs));
  }
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return AbortSignal.any(list);
}

function isClientCredentials(
  creds: ExternalA2AClientCredentials,
): creds is ClientCredentials {
  return (
    "clientId" in creds && "clientSecret" in creds && "tokenUrl" in creds
  );
}

function buildMessageParams(
  input: string | MessageSendParams,
): MessageSendParams {
  if (typeof input === "string") {
    return {
      message: {
        role: "user",
        kind: "message",
        messageId: randomUUID(),
        parts: [{ kind: "text", text: input }],
      },
    };
  }
  return input;
}

function narrowToTask(result: SendMessageResult): Task {
  if ((result as { kind?: string }).kind !== "task") {
    throw new Error(
      `createExternalA2AClient.sendTask: expected Task result, got kind="${(result as { kind?: string }).kind ?? "unknown"}"`,
    );
  }
  return result as Task;
}

// ---------------------------------------------------------------------------
// TokenCache — AuthenticationHandler for OAuth2 client_credentials
// ---------------------------------------------------------------------------

class TokenCache implements AuthenticationHandler {
  private cachedToken: string | null = null;
  private expiresAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private readonly creds: ClientCredentials,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async headers(): Promise<Record<string, string>> {
    if (this.cachedToken && Date.now() < this.expiresAt) {
      return { Authorization: `Bearer ${this.cachedToken}` };
    }
    await this.refresh();
    return { Authorization: `Bearer ${this.cachedToken}` };
  }

  async shouldRetryWithHeaders(
    _req: RequestInit,
    res: Response,
  ): Promise<Record<string, string> | undefined> {
    if (res.status === 401 && this.cachedToken !== null) {
      // The token we handed out was rejected. Clear, refresh once, retry.
      this.cachedToken = null;
      await this.refresh();
      return { Authorization: `Bearer ${this.cachedToken}` };
    }
    return undefined;
  }

  private async refresh(): Promise<void> {
    // Single-flight deduplication — concurrent callers share the same fetch.
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async _doRefresh(): Promise<void> {
    const basic = Buffer.from(
      `${this.creds.clientId}:${this.creds.clientSecret}`,
    ).toString("base64");
    const body = new URLSearchParams({
      grant_type: "client_credentials",
    }).toString();

    let res: Response;
    try {
      res = await this.fetchImpl(this.creds.tokenUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      });
    } catch (err) {
      throw new Error(
        `createExternalA2AClient: token exchange failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Truncate to avoid leaking verbose OAuth2 debug payloads into error logs.
      const preview = body.length > 200 ? `${body.slice(0, 200)}…` : body;
      throw new Error(
        `createExternalA2AClient: token exchange failed (${res.status}): ${preview}`,
      );
    }

    const parsed = (await res.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    const accessToken = parsed.access_token;
    const expiresIn = parsed.expires_in;
    if (typeof accessToken !== "string" || typeof expiresIn !== "number") {
      throw new Error(
        "createExternalA2AClient: token exchange response missing access_token or expires_in",
      );
    }
    this.cachedToken = accessToken;
    this.expiresAt = Date.now() + expiresIn * 1000 - 30_000;
  }
}

function createStaticTokenAuthHandler(token: string): AuthenticationHandler {
  return {
    headers: async () => ({ Authorization: `Bearer ${token}` }),
    shouldRetryWithHeaders: async () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createExternalA2AClient(
  options: ExternalA2AClientOptions,
): Promise<ExternalA2AClient> {
  const baseFetch = options.fetchImpl ?? globalThis.fetch;
  const defaultTimeoutMs = options.timeoutMs ?? 30_000;

  let fetchImpl: typeof fetch = baseFetch;
  if (options.credentials) {
    const authHandler = isClientCredentials(options.credentials)
      ? new TokenCache(options.credentials, baseFetch)
      : createStaticTokenAuthHandler(options.credentials.token);
    fetchImpl = createAuthenticatingFetchWithRetry(baseFetch, authHandler);
  }

  const transportFactory = new JsonRpcTransportFactory({ fetchImpl });
  // Pass the same auth-aware fetchImpl to DefaultAgentCardResolver so
  // AgentCard fetches (/.well-known/agent-card.json) carry auth headers when
  // the remote endpoint requires authentication.
  const cardResolver = new DefaultAgentCardResolver({ fetchImpl });
  const factoryOptions = ClientFactoryOptions.createFrom(
    ClientFactoryOptions.default,
    { transports: [transportFactory], cardResolver },
  );
  const factory = new ClientFactory(factoryOptions);

  // URL-override fix: resolve the agent card first, then override its `url` field
  // with options.agentUrl before creating the client.
  //
  // Background: the @a2a-js/sdk ClientFactory.createFromUrl() fetches the agent
  // card via `options.agentUrl` but uses the card's own `url` field as the
  // service endpoint for subsequent requests. When agents run inside Docker
  // containers and advertise their container-internal bind address
  // (e.g. "http://0.0.0.0:10002/"), that address is unreachable from the host
  // running the cinatra BullMQ worker. Overriding agentCard.url with the
  // caller-provided agentUrl (which is the host-mapped address, e.g.
  // "http://localhost:10007") ensures all requests reach the agent via the
  // Docker port mapping.
  const agentCard = await cardResolver.resolve(options.agentUrl, options.agentCardPath);
  const agentCardWithOverriddenUrl = {
    ...agentCard,
    url: stripTrailingSlashes(options.agentUrl) + "/",
  };
  const sdkClient = await factory.createFromAgentCard(agentCardWithOverriddenUrl);

  return {
    async sendTask(message, callOptions) {
      const signal = composeSignals(
        [options.signal, callOptions?.signal],
        callOptions?.timeoutMs ?? defaultTimeoutMs,
      );
      const params = buildMessageParams(message);
      const result = await sdkClient.sendMessage(params, { signal });
      return narrowToTask(result);
    },
    streamTask(message, callOptions) {
      const signal = composeSignals([options.signal, callOptions?.signal]);
      const params = buildMessageParams(message);
      return sdkClient.sendMessageStream(params, { signal });
    },
    async getTask(taskId, callOptions) {
      const signal = composeSignals([options.signal, callOptions?.signal]);
      return sdkClient.getTask({ id: taskId }, { signal });
    },
    async cancelTask(taskId, callOptions) {
      const signal = composeSignals([options.signal, callOptions?.signal]);
      await sdkClient.cancelTask({ id: taskId }, { signal });
    },
  };
}
