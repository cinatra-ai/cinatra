import { IncomingMessage, ServerResponse } from "node:http";
import * as z from "zod/v4";

//#region ../../core/src/types/schemas.d.ts

/**
 * A uniquely identifying ID for a request in JSON-RPC.
 */
declare const RequestIdSchema: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
declare const JSONRPCMessageSchema$1: z.ZodUnion<readonly [z.ZodObject<{
  method: z.ZodString;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
}, z.core.$strict>, z.ZodObject<{
  method: z.ZodString;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
  jsonrpc: z.ZodLiteral<"2.0">;
}, z.core.$strict>, z.ZodObject<{
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
  result: z.ZodObject<{
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>;
}, z.core.$strict>, z.ZodObject<{
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
  error: z.ZodObject<{
    code: z.ZodNumber;
    message: z.ZodString;
    data: z.ZodOptional<z.ZodUnknown>;
  }, z.core.$strip>;
}, z.core.$strict>]>;
//#endregion
//#region ../../core/src/types/types.d.ts
type Primitive$1 = string | number | boolean | bigint | null | undefined;
type Flatten$1<T$1> = T$1 extends Primitive$1 ? T$1 : T$1 extends Array<infer U> ? Array<Flatten$1<U>> : T$1 extends Set<infer U> ? Set<Flatten$1<U>> : T$1 extends Map<infer K, infer V> ? Map<Flatten$1<K>, Flatten$1<V>> : T$1 extends object ? { [K in keyof T$1]: Flatten$1<T$1[K]> } : T$1;
type Infer$1<Schema extends z.ZodTypeAny> = Flatten$1<z.infer<Schema>>;
type RequestId = Infer$1<typeof RequestIdSchema>;
type JSONRPCMessage$1 = Infer$1<typeof JSONRPCMessageSchema$1>;
/**
 * Information about a validated access token, provided to request handlers.
 */
interface AuthInfo {
  /**
   * The access token.
   */
  token: string;
  /**
   * The client ID associated with this token.
   */
  clientId: string;
  /**
   * Scopes associated with this token.
   */
  scopes: string[];
  /**
   * When the token expires (in seconds since epoch).
   */
  expiresAt?: number;
  /**
   * The RFC 8707 resource server identifier for which this token is valid.
   * If set, this MUST match the MCP server's resource identifier (minus hash fragment).
   */
  resource?: URL;
  /**
   * Additional data associated with the token.
   * This field should be used for any additional data that needs to be attached to the auth info.
   */
  extra?: Record<string, unknown>;
}
/**
 * Information about the incoming request.
 */
interface RequestInfo {
  /**
   * The headers of the request.
   */
  headers: Headers;
}
/**
 * Extra information about a message.
 */
interface MessageExtraInfo {
  /**
   * The request information.
   */
  requestInfo?: RequestInfo;
  /**
   * The authentication information.
   */
  authInfo?: AuthInfo;
  /**
   * Callback to close the SSE stream for this request, triggering client reconnection.
   * Only available when using {@linkcode @modelcontextprotocol/node!streamableHttp.NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport} with eventStore configured.
   */
  closeSSEStream?: () => void;
  /**
   * Callback to close the standalone GET SSE stream, triggering client reconnection.
   * Only available when using {@linkcode @modelcontextprotocol/node!streamableHttp.NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport} with eventStore configured.
   */
  closeStandaloneSSEStream?: () => void;
}
//#endregion
//#region ../../core/src/shared/transport.d.ts
/**
 * Options for sending a JSON-RPC message.
 */
type TransportSendOptions = {
  /**
   * If present, `relatedRequestId` is used to indicate to the transport which incoming request to associate this outgoing message with.
   */
  relatedRequestId?: RequestId;
  /**
   * The resumption token used to continue long-running requests that were interrupted.
   *
   * This allows clients to reconnect and continue from where they left off, if supported by the transport.
   */
  resumptionToken?: string;
  /**
   * A callback that is invoked when the resumption token changes, if supported by the transport.
   *
   * This allows clients to persist the latest token for potential reconnection.
   */
  onresumptiontoken?: (token: string) => void;
};
/**
 * Describes the minimal contract for an MCP transport that a client or server can communicate over.
 */
interface Transport {
  /**
   * Starts processing messages on the transport, including any connection steps that might need to be taken.
   *
   * This method should only be called after callbacks are installed, or else messages may be lost.
   *
   * NOTE: This method should not be called explicitly when using {@linkcode @modelcontextprotocol/client!client/client.Client | Client} or {@linkcode @modelcontextprotocol/server!server/server.Server | Server} classes, as they will implicitly call {@linkcode Transport.start | start()}.
   */
  start(): Promise<void>;
  /**
   * Sends a JSON-RPC message (request or response).
   *
   * If present, `relatedRequestId` is used to indicate to the transport which incoming request to associate this outgoing message with.
   */
  send(message: JSONRPCMessage$1, options?: TransportSendOptions): Promise<void>;
  /**
   * Closes the connection.
   */
  close(): Promise<void>;
  /**
   * Callback for when the connection is closed for any reason.
   *
   * This should be invoked when {@linkcode Transport.close | close()} is called as well.
   */
  onclose?: () => void;
  /**
   * Callback for when an error occurs.
   *
   * Note that errors are not necessarily fatal; they are used for reporting any kind of exceptional condition out of band.
   */
  onerror?: (error: Error) => void;
  /**
   * Callback for when a message (request or response) is received over the connection.
   *
   * Includes the {@linkcode MessageExtraInfo.requestInfo | requestInfo} and {@linkcode MessageExtraInfo.authInfo | authInfo} if the transport is authenticated.
   *
   * The {@linkcode MessageExtraInfo.requestInfo | requestInfo} can be used to get the original request information (headers, etc.)
   */
  onmessage?: <T$1 extends JSONRPCMessage$1>(message: T$1, extra?: MessageExtraInfo) => void;
  /**
   * The session ID generated for this connection.
   */
  sessionId?: string;
  /**
   * Sets the protocol version used for the connection (called when the initialize response is received).
   */
  setProtocolVersion?: (version: string) => void;
  /**
   * Sets the supported protocol versions for header validation (called during connect).
   * This allows the server to pass its supported versions to the transport.
   */
  setSupportedProtocolVersions?: (versions: string[]) => void;
}
//#endregion
//#region ../../server/dist/index-Df8mSdyO.d.mts

declare const JSONRPCMessageSchema: z.ZodUnion<readonly [z.ZodObject<{
  method: z.ZodString;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
}, z.core.$strict>, z.ZodObject<{
  method: z.ZodString;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
  jsonrpc: z.ZodLiteral<"2.0">;
}, z.core.$strict>, z.ZodObject<{
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
  result: z.ZodObject<{
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>;
}, z.core.$strict>, z.ZodObject<{
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
  error: z.ZodObject<{
    code: z.ZodNumber;
    message: z.ZodString;
    data: z.ZodOptional<z.ZodUnknown>;
  }, z.core.$strip>;
}, z.core.$strict>]>;
type Primitive = string | number | boolean | bigint | null | undefined;
type Flatten<T$1> = T$1 extends Primitive ? T$1 : T$1 extends Array<infer U> ? Array<Flatten<U>> : T$1 extends Set<infer U> ? Set<Flatten<U>> : T$1 extends Map<infer K, infer V> ? Map<Flatten<K>, Flatten<V>> : T$1 extends object ? { [K in keyof T$1]: Flatten<T$1[K]> } : T$1;
type Infer<Schema extends z.ZodTypeAny> = Flatten<z.infer<Schema>>;
type JSONRPCMessage = Infer<typeof JSONRPCMessageSchema>;
//#endregion
//#region ../../server/dist/index.d.mts

//#endregion
//#region src/server/streamableHttp.d.ts
type StreamId = string;
type EventId = string;
/**
 * Interface for resumability support via event storage
 */
interface EventStore {
  /**
   * Stores an event for later retrieval
   * @param streamId ID of the stream the event belongs to
   * @param message The JSON-RPC message to store
   * @returns The generated event ID for the stored event
   */
  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;
  /**
   * Get the stream ID associated with a given event ID.
   * @param eventId The event ID to look up
   * @returns The stream ID, or `undefined` if not found
   *
   * Optional: If not provided, the SDK will use the `streamId` returned by
   * {@linkcode replayEventsAfter} for stream mapping.
   */
  getStreamIdForEventId?(eventId: EventId): Promise<StreamId | undefined>;
  replayEventsAfter(lastEventId: EventId, {
    send
  }: {
    send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
  }): Promise<StreamId>;
}
/**
 * Configuration options for {@linkcode WebStandardStreamableHTTPServerTransport}
 */
interface WebStandardStreamableHTTPServerTransportOptions {
  /**
   * Function that generates a session ID for the transport.
   * The session ID SHOULD be globally unique and cryptographically secure (e.g., a securely generated UUID, a JWT, or a cryptographic hash)
   *
   * If not provided, session management is disabled (stateless mode).
   */
  sessionIdGenerator?: () => string;
  /**
   * A callback for session initialization events
   * This is called when the server initializes a new session.
   * Useful in cases when you need to register multiple mcp sessions
   * and need to keep track of them.
   * @param sessionId The generated session ID
   */
  onsessioninitialized?: (sessionId: string) => void | Promise<void>;
  /**
   * A callback for session close events
   * This is called when the server closes a session due to a `DELETE` request.
   * Useful in cases when you need to clean up resources associated with the session.
   * Note that this is different from the transport closing, if you are handling
   * HTTP requests from multiple nodes you might want to close each
   * {@linkcode WebStandardStreamableHTTPServerTransport} after a request is completed while still keeping the
   * session open/running.
   * @param sessionId The session ID that was closed
   */
  onsessionclosed?: (sessionId: string) => void | Promise<void>;
  /**
   * If `true`, the server will return JSON responses instead of starting an SSE stream.
   * This can be useful for simple request/response scenarios without streaming.
   * Default is `false` (SSE streams are preferred).
   */
  enableJsonResponse?: boolean;
  /**
   * Event store for resumability support
   * If provided, resumability will be enabled, allowing clients to reconnect and resume messages
   */
  eventStore?: EventStore;
  /**
   * List of allowed `Host` header values for DNS rebinding protection.
   * If not specified, host validation is disabled.
   * @deprecated Use external middleware for host validation instead.
   */
  allowedHosts?: string[];
  /**
   * List of allowed `Origin` header values for DNS rebinding protection.
   * If not specified, origin validation is disabled.
   * @deprecated Use external middleware for origin validation instead.
   */
  allowedOrigins?: string[];
  /**
   * Enable DNS rebinding protection (requires `allowedHosts` and/or `allowedOrigins` to be configured).
   * Default is `false` for backwards compatibility.
   * @deprecated Use external middleware for DNS rebinding protection instead.
   */
  enableDnsRebindingProtection?: boolean;
  /**
   * Retry interval in milliseconds to suggest to clients in SSE `retry` field.
   * When set, the server will send a `retry` field in SSE priming events to control
   * client reconnection timing for polling behavior.
   */
  retryInterval?: number;
  /**
   * List of protocol versions that this transport will accept.
   * Used to validate the `mcp-protocol-version` header in incoming requests.
   *
   * Note: When using {@linkcode server/server.Server.connect | Server.connect()}, the server automatically passes its
   * `supportedProtocolVersions` to the transport, so you typically don't need
   * to set this option directly.
   *
   * @default {@linkcode SUPPORTED_PROTOCOL_VERSIONS}
   */
  supportedProtocolVersions?: string[];
}
/**
 * Options for handling a request
 */
//#endregion
//#region src/streamableHttp.d.ts
/**
 * Configuration options for {@linkcode NodeStreamableHTTPServerTransport}
 *
 * This is an alias for {@linkcode WebStandardStreamableHTTPServerTransportOptions} for backward compatibility.
 */
type StreamableHTTPServerTransportOptions = WebStandardStreamableHTTPServerTransportOptions;
/**
 * Server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It supports both SSE streaming and direct HTTP responses.
 *
 * This is a wrapper around {@linkcode WebStandardStreamableHTTPServerTransport} that provides Node.js HTTP compatibility.
 * It uses the `@hono/node-server` library to convert between Node.js HTTP and Web Standard APIs.
 *
 * In stateful mode:
 * - Session ID is generated and included in response headers
 * - Session ID is always included in initialization responses
 * - Requests with invalid session IDs are rejected with `404 Not Found`
 * - Non-initialization requests without a session ID are rejected with `400 Bad Request`
 * - State is maintained in-memory (connections, message history)
 *
 * In stateless mode:
 * - No Session ID is included in any responses
 * - No session validation is performed
 *
 * @example Stateful setup
 * ```ts source="./streamableHttp.examples.ts#NodeStreamableHTTPServerTransport_stateful"
 * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 *
 * const transport = new NodeStreamableHTTPServerTransport({
 *     sessionIdGenerator: () => randomUUID()
 * });
 *
 * await server.connect(transport);
 * ```
 *
 * @example Stateless setup
 * ```ts source="./streamableHttp.examples.ts#NodeStreamableHTTPServerTransport_stateless"
 * const transport = new NodeStreamableHTTPServerTransport({
 *     sessionIdGenerator: undefined
 * });
 * ```
 *
 * @example Using with a pre-parsed request body (e.g. Express)
 * ```ts source="./streamableHttp.examples.ts#NodeStreamableHTTPServerTransport_express"
 * app.post('/mcp', (req, res) => {
 *     transport.handleRequest(req, res, req.body);
 * });
 * ```
 */
declare class NodeStreamableHTTPServerTransport implements Transport {
  private _webStandardTransport;
  private _requestListener;
  private _requestContext;
  constructor(options?: StreamableHTTPServerTransportOptions);
  /**
   * Gets the session ID for this transport instance.
   */
  get sessionId(): string | undefined;
  /**
   * Sets callback for when the transport is closed.
   */
  set onclose(handler: (() => void) | undefined);
  get onclose(): (() => void) | undefined;
  /**
   * Sets callback for transport errors.
   */
  set onerror(handler: ((error: Error) => void) | undefined);
  get onerror(): ((error: Error) => void) | undefined;
  /**
   * Sets callback for incoming messages.
   */
  set onmessage(handler: ((message: JSONRPCMessage$1, extra?: MessageExtraInfo) => void) | undefined);
  get onmessage(): ((message: JSONRPCMessage$1, extra?: MessageExtraInfo) => void) | undefined;
  /**
   * Starts the transport. This is required by the {@linkcode Transport} interface but is a no-op
   * for the Streamable HTTP transport as connections are managed per-request.
   */
  start(): Promise<void>;
  /**
   * Closes the transport and all active connections.
   */
  close(): Promise<void>;
  /**
   * Sends a JSON-RPC message through the transport.
   */
  send(message: JSONRPCMessage$1, options?: {
    relatedRequestId?: RequestId;
  }): Promise<void>;
  /**
   * Handles an incoming HTTP request, whether `GET` or `POST`.
   *
   * This method converts Node.js HTTP objects to Web Standard Request/Response
   * and delegates to the underlying {@linkcode WebStandardStreamableHTTPServerTransport}.
   *
   * @param req - Node.js `IncomingMessage`, optionally with `auth` property from middleware
   * @param res - Node.js `ServerResponse`
   * @param parsedBody - Optional pre-parsed body from body-parser middleware
   */
  handleRequest(req: IncomingMessage & {
    auth?: AuthInfo;
  }, res: ServerResponse, parsedBody?: unknown): Promise<void>;
  /**
   * Close an SSE stream for a specific request, triggering client reconnection.
   * Use this to implement polling behavior during long-running operations -
   * client will reconnect after the retry interval specified in the priming event.
   */
  closeSSEStream(requestId: RequestId): void;
  /**
   * Close the standalone GET SSE stream, triggering client reconnection.
   * Use this to implement polling behavior for server-initiated notifications.
   */
  closeStandaloneSSEStream(): void;
}
//#endregion
export { NodeStreamableHTTPServerTransport, StreamableHTTPServerTransportOptions };
//# sourceMappingURL=index.d.mts.map