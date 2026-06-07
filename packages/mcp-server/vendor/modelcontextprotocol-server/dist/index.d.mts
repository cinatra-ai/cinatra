import { $ as ToolAnnotations, A as ElicitRequestFormParams, B as ListTasksResult, C as CreateMessageRequest, D as CreateMessageResult, E as CreateMessageRequestParamsWithTools, F as GetTaskResult, G as RequestId, H as MessageExtraInfo, I as Implementation, J as Resource, K as RequestMethod, L as JSONRPCMessage, M as ElicitResult, N as GetPromptResult, O as CreateMessageResultWithTools, P as GetTaskPayloadResult, Q as ServerCapabilities, R as ListResourcesResult, S as ClientCapabilities, T as CreateMessageRequestParamsBase, U as NotificationMethod, V as LoggingMessageNotification, W as ReadResourceResult, X as Result, Y as ResourceUpdatedNotification, Z as ResultTypeMap, _ as TaskServerContext, a as UriTemplate, b as CallToolResult, c as NotificationOptions, d as RequestOptions, et as ToolExecution, f as ServerContext, g as CreateTaskServerContext, h as ResponseMessage, i as StandardSchemaWithJSON, j as ElicitRequestURLParams, k as CreateTaskResult, l as Protocol, m as TaskManagerOptions, o as Variables, p as Transport, q as RequestTypeMap, r as jsonSchemaValidator, s as BaseContext, u as ProtocolOptions, v as TaskToolExecution, w as CreateMessageRequestParams, x as CancelTaskResult, y as AuthInfo, z as ListRootsRequest } from "./index-Df8mSdyO.mjs";
import { Readable, Writable } from "node:stream";

//#region src/server/completable.d.ts
declare const COMPLETABLE_SYMBOL: unique symbol;
type CompleteCallback<T extends StandardSchemaWithJSON = StandardSchemaWithJSON> = (value: StandardSchemaWithJSON.InferInput<T>, context?: {
  arguments?: Record<string, string>;
}) => StandardSchemaWithJSON.InferInput<T>[] | Promise<StandardSchemaWithJSON.InferInput<T>[]>;
type CompletableMeta<T extends StandardSchemaWithJSON = StandardSchemaWithJSON> = {
  complete: CompleteCallback<T>;
};
type CompletableSchema<T extends StandardSchemaWithJSON> = T & {
  [COMPLETABLE_SYMBOL]: CompletableMeta<T>;
};
/**
 * Wraps a schema to provide autocompletion capabilities. Useful for, e.g., prompt arguments in MCP.
 *
 * @example
 * ```ts source="./completable.examples.ts#completable_basicUsage"
 * server.registerPrompt(
 *     'review-code',
 *     {
 *         title: 'Code Review',
 *         argsSchema: z.object({
 *             language: completable(z.string().describe('Programming language'), value =>
 *                 ['typescript', 'javascript', 'python', 'rust', 'go'].filter(lang => lang.startsWith(value))
 *             )
 *         })
 *     },
 *     ({ language }) => ({
 *         messages: [
 *             {
 *                 role: 'user' as const,
 *                 content: {
 *                     type: 'text' as const,
 *                     text: `Review this ${language} code.`
 *                 }
 *             }
 *         ]
 *     })
 * );
 * ```
 *
 * @see {@linkcode server/mcp.McpServer.registerPrompt | McpServer.registerPrompt} for using completable schemas in prompt argument definitions
 */
declare function completable<T extends StandardSchemaWithJSON>(schema: T, complete: CompleteCallback<T>): CompletableSchema<T>;
/**
 * Checks if a schema is completable (has completion metadata).
 */
declare function isCompletable(schema: unknown): schema is CompletableSchema<StandardSchemaWithJSON>;
//#endregion
//#region src/experimental/tasks/interfaces.d.ts
/**
 * Handler for creating a task.
 * @experimental
 */
type CreateTaskRequestHandler<SendResultT extends Result, Args extends StandardSchemaWithJSON | undefined = undefined> = BaseToolCallback<SendResultT, CreateTaskServerContext, Args>;
/**
 * Handler for task operations (`get`, `getResult`).
 * @experimental
 */
type TaskRequestHandler<SendResultT extends Result, Args extends StandardSchemaWithJSON | undefined = undefined> = BaseToolCallback<SendResultT, TaskServerContext, Args>;
/**
 * Interface for task-based tool handlers.
 *
 * Task-based tools split a long-running operation into three phases:
 * `createTask`, `getTask`, and `getTaskResult`.
 *
 * @see {@linkcode @modelcontextprotocol/server!experimental/tasks/mcpServer.ExperimentalMcpServerTasks#registerToolTask | registerToolTask} for registration.
 * @experimental
 */
interface ToolTaskHandler<Args extends StandardSchemaWithJSON | undefined = undefined> {
  /**
   * Called on the initial `tools/call` request.
   *
   * Creates a task via `ctx.task.store.createTask(...)`, starts any
   * background work, and returns the task object.
   */
  createTask: CreateTaskRequestHandler<CreateTaskResult, Args>;
  /**
   * Handler for `tasks/get` requests.
   */
  getTask: TaskRequestHandler<GetTaskResult, Args>;
  /**
   * Handler for `tasks/result` requests.
   */
  getTaskResult: TaskRequestHandler<CallToolResult, Args>;
}
//#endregion
//#region src/experimental/tasks/mcpServer.d.ts
/**
 * Experimental task features for {@linkcode McpServer}.
 *
 * Access via `server.experimental.tasks`:
 * ```typescript
 * server.experimental.tasks.registerToolTask('long-running', config, handler);
 * ```
 *
 * @experimental
 */
declare class ExperimentalMcpServerTasks {
  private readonly _mcpServer;
  constructor(_mcpServer: McpServer);
  /**
   * Registers a task-based tool with a config object and handler.
   *
   * Task-based tools support long-running operations that can be polled for status
   * and results. The handler must implement {@linkcode ToolTaskHandler.createTask | createTask}, {@linkcode ToolTaskHandler.getTask | getTask}, and {@linkcode ToolTaskHandler.getTaskResult | getTaskResult}
   * methods.
   *
   * @example
   * ```typescript
   * server.experimental.tasks.registerToolTask('long-computation', {
   *   description: 'Performs a long computation',
   *   inputSchema: z.object({ input: z.string() }),
   *   execution: { taskSupport: 'required' }
   * }, {
   *   createTask: async (args, ctx) => {
   *     const task = await ctx.task.store.createTask({ ttl: 300000 });
   *     startBackgroundWork(task.taskId, args);
   *     return { task };
   *   },
   *   getTask: async (args, ctx) => {
   *     return ctx.task.store.getTask(ctx.task.id);
   *   },
   *   getTaskResult: async (args, ctx) => {
   *     return ctx.task.store.getTaskResult(ctx.task.id);
   *   }
   * });
   * ```
   *
   * @param name - The tool name
   * @param config - Tool configuration (description, schemas, etc.)
   * @param handler - Task handler with {@linkcode ToolTaskHandler.createTask | createTask}, {@linkcode ToolTaskHandler.getTask | getTask}, {@linkcode ToolTaskHandler.getTaskResult | getTaskResult} methods
   * @returns {@linkcode server/mcp.RegisteredTool | RegisteredTool} for managing the tool's lifecycle
   *
   * @experimental
   */
  registerToolTask<OutputArgs extends StandardSchemaWithJSON | undefined>(name: string, config: {
    title?: string;
    description?: string;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    execution?: TaskToolExecution;
    _meta?: Record<string, unknown>;
  }, handler: ToolTaskHandler<undefined>): RegisteredTool;
  registerToolTask<InputArgs extends StandardSchemaWithJSON, OutputArgs extends StandardSchemaWithJSON | undefined>(name: string, config: {
    title?: string;
    description?: string;
    inputSchema: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    execution?: TaskToolExecution;
    _meta?: Record<string, unknown>;
  }, handler: ToolTaskHandler<InputArgs>): RegisteredTool;
}
//#endregion
//#region src/experimental/tasks/server.d.ts
/**
 * Experimental task features for low-level MCP servers.
 *
 * Access via `server.experimental.tasks`:
 * ```typescript
 * const stream = server.experimental.tasks.requestStream(request, options);
 * ```
 *
 * For high-level server usage with task-based tools, use {@linkcode index.McpServer | McpServer}.experimental.tasks instead.
 *
 * @experimental
 */
declare class ExperimentalServerTasks {
  private readonly _server;
  constructor(_server: Server);
  private get _module();
  /**
   * Sends a request and returns an AsyncGenerator that yields response messages.
   * The generator is guaranteed to end with either a `'result'` or `'error'` message.
   *
   * This method provides streaming access to request processing, allowing you to
   * observe intermediate task status updates for task-augmented requests.
   *
   * @param request - The request to send (method name determines the result schema)
   * @param options - Optional request options (timeout, signal, task creation params, etc.)
   * @returns AsyncGenerator that yields {@linkcode ResponseMessage} objects
   *
   * @experimental
   */
  requestStream<M extends RequestMethod>(request: {
    method: M;
    params?: Record<string, unknown>;
  }, options?: RequestOptions): AsyncGenerator<ResponseMessage<ResultTypeMap[M]>, void, void>;
  /**
   * Sends a sampling request and returns an AsyncGenerator that yields response messages.
   * The generator is guaranteed to end with either a 'result' or 'error' message.
   *
   * For task-augmented requests, yields 'taskCreated' and 'taskStatus' messages
   * before the final result.
   *
   * @example
   * ```typescript
   * const stream = server.experimental.tasks.createMessageStream({
   *     messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
   *     maxTokens: 100
   * }, {
   *     onprogress: (progress) => {
   *         // Handle streaming tokens via progress notifications
   *         console.log('Progress:', progress.message);
   *     }
   * });
   *
   * for await (const message of stream) {
   *     switch (message.type) {
   *         case 'taskCreated':
   *             console.log('Task created:', message.task.taskId);
   *             break;
   *         case 'taskStatus':
   *             console.log('Task status:', message.task.status);
   *             break;
   *         case 'result':
   *             console.log('Final result:', message.result);
   *             break;
   *         case 'error':
   *             console.error('Error:', message.error);
   *             break;
   *     }
   * }
   * ```
   *
   * @param params - The sampling request parameters
   * @param options - Optional request options (timeout, signal, task creation params, onprogress, etc.)
   * @returns AsyncGenerator that yields ResponseMessage objects
   *
   * @experimental
   */
  createMessageStream(params: CreateMessageRequestParams, options?: RequestOptions): AsyncGenerator<ResponseMessage<CreateMessageResult>, void, void>;
  /**
   * Sends an elicitation request and returns an AsyncGenerator that yields response messages.
   * The generator is guaranteed to end with either a 'result' or 'error' message.
   *
   * For task-augmented requests (especially URL-based elicitation), yields 'taskCreated'
   * and 'taskStatus' messages before the final result.
   *
   * @example
   * ```typescript
   * const stream = server.experimental.tasks.elicitInputStream({
   *     mode: 'url',
   *     message: 'Please authenticate',
   *     elicitationId: 'auth-123',
   *     url: 'https://example.com/auth'
   * }, {
   *     task: { ttl: 300000 } // Task-augmented for long-running auth flow
   * });
   *
   * for await (const message of stream) {
   *     switch (message.type) {
   *         case 'taskCreated':
   *             console.log('Task created:', message.task.taskId);
   *             break;
   *         case 'taskStatus':
   *             console.log('Task status:', message.task.status);
   *             break;
   *         case 'result':
   *             console.log('User action:', message.result.action);
   *             break;
   *         case 'error':
   *             console.error('Error:', message.error);
   *             break;
   *     }
   * }
   * ```
   *
   * @param params - The elicitation request parameters
   * @param options - Optional request options (timeout, signal, task creation params, etc.)
   * @returns AsyncGenerator that yields ResponseMessage objects
   *
   * @experimental
   */
  elicitInputStream(params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions): AsyncGenerator<ResponseMessage<ElicitResult>, void, void>;
  /**
   * Gets the current status of a task.
   *
   * @param taskId - The task identifier
   * @param options - Optional request options
   * @returns The task status
   *
   * @experimental
   */
  getTask(taskId: string, options?: RequestOptions): Promise<GetTaskResult>;
  /**
   * Retrieves the result of a completed task.
   *
   * @param taskId - The task identifier
   * @param options - Optional request options
   * @returns The task result. The payload structure matches the result type of the
   *   original request (e.g., a `tools/call` task returns a `CallToolResult`).
   *
   * @experimental
   */
  getTaskResult(taskId: string, options?: RequestOptions): Promise<GetTaskPayloadResult>;
  /**
   * Lists tasks with optional pagination.
   *
   * @param cursor - Optional pagination cursor
   * @param options - Optional request options
   * @returns List of tasks with optional next cursor
   *
   * @experimental
   */
  listTasks(cursor?: string, options?: RequestOptions): Promise<ListTasksResult>;
  /**
   * Cancels a running task.
   *
   * @param taskId - The task identifier
   * @param options - Optional request options
   *
   * @experimental
   */
  cancelTask(taskId: string, options?: RequestOptions): Promise<CancelTaskResult>;
}
//#endregion
//#region src/server/server.d.ts
/**
 * Extended tasks capability that includes runtime configuration (store, messageQueue).
 * The runtime-only fields are stripped before advertising capabilities to clients.
 */
type ServerTasksCapabilityWithRuntime = NonNullable<ServerCapabilities['tasks']> & TaskManagerOptions;
type ServerOptions = ProtocolOptions & {
  /**
   * Capabilities to advertise as being supported by this server.
   */
  capabilities?: Omit<ServerCapabilities, 'tasks'> & {
    tasks?: ServerTasksCapabilityWithRuntime;
  };
  /**
   * Optional instructions describing how to use the server and its features.
   */
  instructions?: string;
  /**
   * JSON Schema validator for elicitation response validation.
   *
   * The validator is used to validate user input returned from elicitation
   * requests against the requested schema.
   *
   * @default {@linkcode DefaultJsonSchemaValidator} ({@linkcode index.AjvJsonSchemaValidator | AjvJsonSchemaValidator} on Node.js, {@linkcode index.CfWorkerJsonSchemaValidator | CfWorkerJsonSchemaValidator} on Cloudflare Workers)
   */
  jsonSchemaValidator?: jsonSchemaValidator;
};
/**
 * An MCP server on top of a pluggable transport.
 *
 * This server will automatically respond to the initialization flow as initiated from the client.
 *
 * @deprecated Use {@linkcode server/mcp.McpServer | McpServer} instead for the high-level API. Only use `Server` for advanced use cases.
 */
declare class Server extends Protocol<ServerContext> {
  private _serverInfo;
  private _clientCapabilities?;
  private _clientVersion?;
  private _capabilities;
  private _instructions?;
  private _jsonSchemaValidator;
  private _experimental?;
  /**
   * Callback for when initialization has fully completed (i.e., the client has sent an `notifications/initialized` notification).
   */
  oninitialized?: () => void;
  /**
   * Initializes this server with the given name and version information.
   */
  constructor(_serverInfo: Implementation, options?: ServerOptions);
  private _registerLoggingHandler;
  protected buildContext(ctx: BaseContext, transportInfo?: MessageExtraInfo): ServerContext;
  /**
   * Access experimental features.
   *
   * WARNING: These APIs are experimental and may change without notice.
   *
   * @experimental
   */
  get experimental(): {
    tasks: ExperimentalServerTasks;
  };
  private _loggingLevels;
  private readonly LOG_LEVEL_SEVERITY;
  private isMessageIgnored;
  /**
   * Registers new capabilities. This can only be called before connecting to a transport.
   *
   * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
   */
  registerCapabilities(capabilities: ServerCapabilities): void;
  /**
   * Override request handler registration to enforce server-side validation for `tools/call`.
   */
  setRequestHandler<M extends RequestMethod>(method: M, handler: (request: RequestTypeMap[M], ctx: ServerContext) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>): void;
  protected assertCapabilityForMethod(method: RequestMethod): void;
  protected assertNotificationCapability(method: NotificationMethod): void;
  protected assertRequestHandlerCapability(method: string): void;
  protected assertTaskCapability(method: string): void;
  protected assertTaskHandlerCapability(method: string): void;
  private _oninitialize;
  /**
   * After initialization has completed, this will be populated with the client's reported capabilities.
   */
  getClientCapabilities(): ClientCapabilities | undefined;
  /**
   * After initialization has completed, this will be populated with information about the client's name and version.
   */
  getClientVersion(): Implementation | undefined;
  /**
   * Returns the current server capabilities.
   */
  getCapabilities(): ServerCapabilities;
  ping(): Promise<{
    _meta?: {
      [x: string]: unknown;
      progressToken?: string | number | undefined;
      "io.modelcontextprotocol/related-task"?: {
        taskId: string;
      } | undefined;
    } | undefined;
  }>;
  /**
   * Request LLM sampling from the client (without tools).
   * Returns single content block for backwards compatibility.
   */
  createMessage(params: CreateMessageRequestParamsBase, options?: RequestOptions): Promise<CreateMessageResult>;
  /**
   * Request LLM sampling from the client with tool support.
   * Returns content that may be a single block or array (for parallel tool calls).
   */
  createMessage(params: CreateMessageRequestParamsWithTools, options?: RequestOptions): Promise<CreateMessageResultWithTools>;
  /**
   * Request LLM sampling from the client.
   * When tools may or may not be present, returns the union type.
   */
  createMessage(params: CreateMessageRequest['params'], options?: RequestOptions): Promise<CreateMessageResult | CreateMessageResultWithTools>;
  /**
   * Creates an elicitation request for the given parameters.
   * For backwards compatibility, `mode` may be omitted for form requests and will default to `"form"`.
   * @param params The parameters for the elicitation request.
   * @param options Optional request options.
   * @returns The result of the elicitation request.
   */
  elicitInput(params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions): Promise<ElicitResult>;
  /**
   * Creates a reusable callback that, when invoked, will send a `notifications/elicitation/complete`
   * notification for the specified elicitation ID.
   *
   * @param elicitationId The ID of the elicitation to mark as complete.
   * @param options Optional notification options. Useful when the completion notification should be related to a prior request.
   * @returns A function that emits the completion notification when awaited.
   */
  createElicitationCompletionNotifier(elicitationId: string, options?: NotificationOptions): () => Promise<void>;
  listRoots(params?: ListRootsRequest['params'], options?: RequestOptions): Promise<{
    [x: string]: unknown;
    roots: {
      uri: string;
      name?: string | undefined;
      _meta?: Record<string, unknown> | undefined;
    }[];
    _meta?: {
      [x: string]: unknown;
      progressToken?: string | number | undefined;
      "io.modelcontextprotocol/related-task"?: {
        taskId: string;
      } | undefined;
    } | undefined;
  }>;
  /**
   * Sends a logging message to the client, if connected.
   * Note: You only need to send the parameters object, not the entire JSON-RPC message.
   * @see {@linkcode LoggingMessageNotification}
   * @param params
   * @param sessionId Optional for stateless transports and backward compatibility.
   */
  sendLoggingMessage(params: LoggingMessageNotification['params'], sessionId?: string): Promise<void>;
  sendResourceUpdated(params: ResourceUpdatedNotification['params']): Promise<void>;
  sendResourceListChanged(): Promise<void>;
  sendToolListChanged(): Promise<void>;
  sendPromptListChanged(): Promise<void>;
}
//#endregion
//#region src/server/mcp.d.ts
/**
 * High-level MCP server that provides a simpler API for working with resources, tools, and prompts.
 * For advanced usage (like sending notifications or setting custom request handlers), use the underlying
 * {@linkcode Server} instance available via the {@linkcode McpServer.server | server} property.
 *
 * @example
 * ```ts source="./mcp.examples.ts#McpServer_basicUsage"
 * const server = new McpServer({
 *     name: 'my-server',
 *     version: '1.0.0'
 * });
 * ```
 */
declare class McpServer {
  /**
   * The underlying {@linkcode Server} instance, useful for advanced operations like sending notifications.
   */
  readonly server: Server;
  private _registeredResources;
  private _registeredResourceTemplates;
  private _registeredTools;
  private _registeredPrompts;
  private _experimental?;
  constructor(serverInfo: Implementation, options?: ServerOptions);
  /**
   * Access experimental features.
   *
   * WARNING: These APIs are experimental and may change without notice.
   *
   * @experimental
   */
  get experimental(): {
    tasks: ExperimentalMcpServerTasks;
  };
  /**
   * Attaches to the given transport, starts it, and starts listening for messages.
   *
   * The `server` object assumes ownership of the {@linkcode Transport}, replacing any callbacks that have already been set, and expects that it is the only user of the {@linkcode Transport} instance going forward.
   *
   * @example
   * ```ts source="./mcp.examples.ts#McpServer_connect_stdio"
   * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
   * const transport = new StdioServerTransport();
   * await server.connect(transport);
   * ```
   */
  connect(transport: Transport): Promise<void>;
  /**
   * Closes the connection.
   */
  close(): Promise<void>;
  private _toolHandlersInitialized;
  private setToolRequestHandlers;
  /**
   * Creates a tool error result.
   *
   * @param errorMessage - The error message.
   * @returns The tool error result.
   */
  private createToolError;
  /**
   * Validates tool input arguments against the tool's input schema.
   */
  private validateToolInput;
  /**
   * Validates tool output against the tool's output schema.
   */
  private validateToolOutput;
  /**
   * Executes a tool handler (either regular or task-based).
   */
  private executeToolHandler;
  /**
   * Handles automatic task polling for tools with `taskSupport` `'optional'`.
   */
  private handleAutomaticTaskPolling;
  private _completionHandlerInitialized;
  private setCompletionRequestHandler;
  private handlePromptCompletion;
  private handleResourceCompletion;
  private _resourceHandlersInitialized;
  private setResourceRequestHandlers;
  private _promptHandlersInitialized;
  private setPromptRequestHandlers;
  /**
   * Registers a resource with a config object and callback.
   * For static resources, use a URI string. For dynamic resources, use a {@linkcode ResourceTemplate}.
   *
   * @example
   * ```ts source="./mcp.examples.ts#McpServer_registerResource_static"
   * server.registerResource(
   *     'config',
   *     'config://app',
   *     {
   *         title: 'Application Config',
   *         mimeType: 'text/plain'
   *     },
   *     async uri => ({
   *         contents: [{ uri: uri.href, text: 'App configuration here' }]
   *     })
   * );
   * ```
   */
  registerResource(name: string, uriOrTemplate: string, config: ResourceMetadata, readCallback: ReadResourceCallback): RegisteredResource;
  registerResource(name: string, uriOrTemplate: ResourceTemplate, config: ResourceMetadata, readCallback: ReadResourceTemplateCallback): RegisteredResourceTemplate;
  private _createRegisteredResource;
  private _createRegisteredResourceTemplate;
  private _createRegisteredPrompt;
  private _createRegisteredTool;
  /**
   * Registers a tool with a config object and callback.
   *
   * @example
   * ```ts source="./mcp.examples.ts#McpServer_registerTool_basic"
   * server.registerTool(
   *     'calculate-bmi',
   *     {
   *         title: 'BMI Calculator',
   *         description: 'Calculate Body Mass Index',
   *         inputSchema: z.object({
   *             weightKg: z.number(),
   *             heightM: z.number()
   *         }),
   *         outputSchema: z.object({ bmi: z.number() })
   *     },
   *     async ({ weightKg, heightM }) => {
   *         const output = { bmi: weightKg / (heightM * heightM) };
   *         return {
   *             content: [{ type: 'text', text: JSON.stringify(output) }],
   *             structuredContent: output
   *         };
   *     }
   * );
   * ```
   */
  registerTool<OutputArgs extends StandardSchemaWithJSON, InputArgs extends StandardSchemaWithJSON | undefined = undefined>(name: string, config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  }, cb: ToolCallback<InputArgs>): RegisteredTool;
  /**
   * Registers a prompt with a config object and callback.
   *
   * @example
   * ```ts source="./mcp.examples.ts#McpServer_registerPrompt_basic"
   * server.registerPrompt(
   *     'review-code',
   *     {
   *         title: 'Code Review',
   *         description: 'Review code for best practices',
   *         argsSchema: z.object({ code: z.string() })
   *     },
   *     ({ code }) => ({
   *         messages: [
   *             {
   *                 role: 'user' as const,
   *                 content: {
   *                     type: 'text' as const,
   *                     text: `Please review this code:\n\n${code}`
   *                 }
   *             }
   *         ]
   *     })
   * );
   * ```
   */
  registerPrompt<Args extends StandardSchemaWithJSON>(name: string, config: {
    title?: string;
    description?: string;
    argsSchema?: Args;
  }, cb: PromptCallback<Args>): RegisteredPrompt;
  /**
   * Checks if the server is connected to a transport.
   * @returns `true` if the server is connected
   */
  isConnected(): boolean;
  /**
   * Sends a logging message to the client, if connected.
   * Note: You only need to send the parameters object, not the entire JSON-RPC message.
   * @see {@linkcode LoggingMessageNotification}
   * @param params
   * @param sessionId Optional for stateless transports and backward compatibility.
   *
   * @example
   * ```ts source="./mcp.examples.ts#McpServer_sendLoggingMessage_basic"
   * await server.sendLoggingMessage({
   *     level: 'info',
   *     data: 'Processing complete'
   * });
   * ```
   */
  sendLoggingMessage(params: LoggingMessageNotification['params'], sessionId?: string): Promise<void>;
  /**
   * Sends a resource list changed event to the client, if connected.
   */
  sendResourceListChanged(): void;
  /**
   * Sends a tool list changed event to the client, if connected.
   */
  sendToolListChanged(): void;
  /**
   * Sends a prompt list changed event to the client, if connected.
   */
  sendPromptListChanged(): void;
}
/**
 * A callback to complete one variable within a resource template's URI template.
 */
type CompleteResourceTemplateCallback = (value: string, context?: {
  arguments?: Record<string, string>;
}) => string[] | Promise<string[]>;
/**
 * A resource template combines a URI pattern with optional functionality to enumerate
 * all resources matching that pattern.
 */
declare class ResourceTemplate {
  private _callbacks;
  private _uriTemplate;
  constructor(uriTemplate: string | UriTemplate, _callbacks: {
    /**
     * A callback to list all resources matching this template. This is required to be specified, even if `undefined`, to avoid accidentally forgetting resource listing.
     */
    list: ListResourcesCallback | undefined;
    /**
     * An optional callback to autocomplete variables within the URI template. Useful for clients and users to discover possible values.
     */
    complete?: {
      [variable: string]: CompleteResourceTemplateCallback;
    };
  });
  /**
   * Gets the URI template pattern.
   */
  get uriTemplate(): UriTemplate;
  /**
   * Gets the list callback, if one was provided.
   */
  get listCallback(): ListResourcesCallback | undefined;
  /**
   * Gets the callback for completing a specific URI template variable, if one was provided.
   */
  completeCallback(variable: string): CompleteResourceTemplateCallback | undefined;
}
type BaseToolCallback<SendResultT extends Result, Ctx extends ServerContext, Args extends StandardSchemaWithJSON | undefined> = Args extends StandardSchemaWithJSON ? (args: StandardSchemaWithJSON.InferOutput<Args>, ctx: Ctx) => SendResultT | Promise<SendResultT> : (ctx: Ctx) => SendResultT | Promise<SendResultT>;
/**
 * Callback for a tool handler registered with {@linkcode McpServer.registerTool}.
 */
type ToolCallback<Args extends StandardSchemaWithJSON | undefined = undefined> = BaseToolCallback<CallToolResult, ServerContext, Args>;
/**
 * Supertype that can handle both regular tools (simple callback) and task-based tools (task handler object).
 */
type AnyToolHandler<Args extends StandardSchemaWithJSON | undefined = undefined> = ToolCallback<Args> | ToolTaskHandler<Args>;
/**
 * Internal executor type that encapsulates handler invocation with proper types.
 */
type ToolExecutor = (args: unknown, ctx: ServerContext) => Promise<CallToolResult | CreateTaskResult>;
type RegisteredTool = {
  title?: string;
  description?: string;
  inputSchema?: StandardSchemaWithJSON;
  outputSchema?: StandardSchemaWithJSON;
  annotations?: ToolAnnotations;
  execution?: ToolExecution;
  _meta?: Record<string, unknown>;
  handler: AnyToolHandler<StandardSchemaWithJSON | undefined>;
  /** @hidden */
  executor: ToolExecutor;
  enabled: boolean;
  enable(): void;
  disable(): void;
  update(updates: {
    name?: string | null;
    title?: string;
    description?: string;
    paramsSchema?: StandardSchemaWithJSON;
    outputSchema?: StandardSchemaWithJSON;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
    callback?: ToolCallback<StandardSchemaWithJSON>;
    enabled?: boolean;
  }): void;
  remove(): void;
};
/**
 * Additional, optional information for annotating a resource.
 */
type ResourceMetadata = Omit<Resource, 'uri' | 'name'>;
/**
 * Callback to list all resources matching a given template.
 */
type ListResourcesCallback = (ctx: ServerContext) => ListResourcesResult | Promise<ListResourcesResult>;
/**
 * Callback to read a resource at a given URI.
 */
type ReadResourceCallback = (uri: URL, ctx: ServerContext) => ReadResourceResult | Promise<ReadResourceResult>;
type RegisteredResource = {
  name: string;
  title?: string;
  metadata?: ResourceMetadata;
  readCallback: ReadResourceCallback;
  enabled: boolean;
  enable(): void;
  disable(): void;
  update(updates: {
    name?: string;
    title?: string;
    uri?: string | null;
    metadata?: ResourceMetadata;
    callback?: ReadResourceCallback;
    enabled?: boolean;
  }): void;
  remove(): void;
};
/**
 * Callback to read a resource at a given URI, following a filled-in URI template.
 */
type ReadResourceTemplateCallback = (uri: URL, variables: Variables, ctx: ServerContext) => ReadResourceResult | Promise<ReadResourceResult>;
type RegisteredResourceTemplate = {
  resourceTemplate: ResourceTemplate;
  title?: string;
  metadata?: ResourceMetadata;
  readCallback: ReadResourceTemplateCallback;
  enabled: boolean;
  enable(): void;
  disable(): void;
  update(updates: {
    name?: string | null;
    title?: string;
    template?: ResourceTemplate;
    metadata?: ResourceMetadata;
    callback?: ReadResourceTemplateCallback;
    enabled?: boolean;
  }): void;
  remove(): void;
};
type PromptCallback<Args extends StandardSchemaWithJSON | undefined = undefined> = Args extends StandardSchemaWithJSON ? (args: StandardSchemaWithJSON.InferOutput<Args>, ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult> : (ctx: ServerContext) => GetPromptResult | Promise<GetPromptResult>;
/**
 * Internal handler type that encapsulates parsing and callback invocation.
 * This allows type-safe handling without runtime type assertions.
 */
type PromptHandler = (args: Record<string, unknown> | undefined, ctx: ServerContext) => Promise<GetPromptResult>;
type RegisteredPrompt = {
  title?: string;
  description?: string;
  argsSchema?: StandardSchemaWithJSON;
  /** @hidden */
  handler: PromptHandler;
  enabled: boolean;
  enable(): void;
  disable(): void;
  update<Args extends StandardSchemaWithJSON>(updates: {
    name?: string | null;
    title?: string;
    description?: string;
    argsSchema?: Args;
    callback?: PromptCallback<Args>;
    enabled?: boolean;
  }): void;
  remove(): void;
};
//#endregion
//#region src/server/middleware/hostHeaderValidation.d.ts
type HostHeaderValidationResult = {
  ok: true;
  hostname: string;
} | {
  ok: false;
  errorCode: 'missing_host' | 'invalid_host_header' | 'invalid_host';
  message: string;
  hostHeader?: string;
  hostname?: string;
};
/**
 * Parse and validate a `Host` header against an allowlist of hostnames (port-agnostic).
 *
 * - Input host header may include a port (e.g. `localhost:3000`) or IPv6 brackets (e.g. `[::1]:3000`).
 * - Allowlist items should be hostnames only (no ports). For IPv6, include brackets (e.g. `[::1]`).
 */
declare function validateHostHeader(hostHeader: string | null | undefined, allowedHostnames: string[]): HostHeaderValidationResult;
/**
 * Convenience allowlist for `localhost` DNS rebinding protection.
 */
declare function localhostAllowedHostnames(): string[];
/**
 * Web-standard `Request` helper for DNS rebinding protection.
 * @example
 * ```ts source="./hostHeaderValidation.examples.ts#hostHeaderValidationResponse_basicUsage"
 * const result = validateHostHeader(req.headers.get('host'), ['localhost']);
 * ```
 */
declare function hostHeaderValidationResponse(req: Request, allowedHostnames: string[]): Response | undefined;
//#endregion
//#region src/server/stdio.d.ts
/**
 * Server transport for stdio: this communicates with an MCP client by reading from the current process' `stdin` and writing to `stdout`.
 *
 * This transport is only available in Node.js environments.
 *
 * @example
 * ```ts source="./stdio.examples.ts#StdioServerTransport_basicUsage"
 * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 * ```
 */
declare class StdioServerTransport implements Transport {
  private _stdin;
  private _stdout;
  private _readBuffer;
  private _started;
  private _closed;
  constructor(_stdin?: Readable, _stdout?: Writable);
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  _ondata: (chunk: Buffer) => void;
  _onerror: (error: Error) => void;
  _onstdouterror: (error: Error) => void;
  /**
   * Starts listening for messages on `stdin`.
   */
  start(): Promise<void>;
  private processReadBuffer;
  close(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
}
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
interface HandleRequestOptions {
  /**
   * Pre-parsed request body. If provided, the transport will use this instead of parsing `req.json()`.
   * Useful when using body-parser middleware that has already parsed the body.
   */
  parsedBody?: unknown;
  /**
   * Authentication info from middleware. If provided, will be passed to message handlers.
   */
  authInfo?: AuthInfo;
}
/**
 * Server transport for Web Standards Streamable HTTP: this implements the MCP Streamable HTTP transport specification
 * using Web Standard APIs (`Request`, `Response`, `ReadableStream`).
 *
 * This transport works on any runtime that supports Web Standards: Node.js 18+, Cloudflare Workers, Deno, Bun, etc.
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
 * ```ts source="./streamableHttp.examples.ts#WebStandardStreamableHTTPServerTransport_stateful"
 * const server = new McpServer({ name: 'my-server', version: '1.0.0' });
 *
 * const transport = new WebStandardStreamableHTTPServerTransport({
 *     sessionIdGenerator: () => crypto.randomUUID()
 * });
 *
 * await server.connect(transport);
 * ```
 *
 * @example Stateless setup
 * ```ts source="./streamableHttp.examples.ts#WebStandardStreamableHTTPServerTransport_stateless"
 * const transport = new WebStandardStreamableHTTPServerTransport({
 *     sessionIdGenerator: undefined
 * });
 * ```
 *
 * @example Hono.js
 * ```ts source="./streamableHttp.examples.ts#WebStandardStreamableHTTPServerTransport_hono"
 * app.all('/mcp', async c => {
 *     return transport.handleRequest(c.req.raw);
 * });
 * ```
 *
 * @example Cloudflare Workers
 * ```ts source="./streamableHttp.examples.ts#WebStandardStreamableHTTPServerTransport_workers"
 * const worker = {
 *     async fetch(request: Request): Promise<Response> {
 *         return transport.handleRequest(request);
 *     }
 * };
 * ```
 */
declare class WebStandardStreamableHTTPServerTransport implements Transport {
  private sessionIdGenerator;
  private _started;
  private _streamMapping;
  private _requestToStreamMapping;
  private _requestResponseMap;
  private _initialized;
  private _enableJsonResponse;
  private _standaloneSseStreamId;
  private _eventStore?;
  private _onsessioninitialized?;
  private _onsessionclosed?;
  private _allowedHosts?;
  private _allowedOrigins?;
  private _enableDnsRebindingProtection;
  private _retryInterval?;
  private _supportedProtocolVersions;
  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  constructor(options?: WebStandardStreamableHTTPServerTransportOptions);
  /**
   * Starts the transport. This is required by the {@linkcode Transport} interface but is a no-op
   * for the Streamable HTTP transport as connections are managed per-request.
   */
  start(): Promise<void>;
  /**
   * Sets the supported protocol versions for header validation.
   * Called by the server during {@linkcode server/server.Server.connect | connect()} to pass its supported versions.
   */
  setSupportedProtocolVersions(versions: string[]): void;
  /**
   * Helper to create a JSON error response
   */
  private createJsonErrorResponse;
  /**
   * Validates request headers for DNS rebinding protection.
   * @returns Error response if validation fails, `undefined` if validation passes.
   */
  private validateRequestHeaders;
  /**
   * Handles an incoming HTTP request, whether `GET`, `POST`, or `DELETE`
   * Returns a `Response` object (Web Standard)
   */
  handleRequest(req: Request, options?: HandleRequestOptions): Promise<Response>;
  /**
   * Writes a priming event to establish resumption capability.
   * Only sends if `eventStore` is configured (opt-in for resumability) and
   * the client's protocol version supports empty SSE data (>= `2025-11-25`).
   */
  private writePrimingEvent;
  /**
   * Handles `GET` requests for SSE stream
   */
  private handleGetRequest;
  /**
   * Replays events that would have been sent after the specified event ID
   * Only used when resumability is enabled
   */
  private replayEvents;
  /**
   * Writes an event to an SSE stream via controller with proper formatting
   */
  private writeSSEEvent;
  /**
   * Handles unsupported requests (`PUT`, `PATCH`, etc.)
   */
  private handleUnsupportedRequest;
  /**
   * Handles `POST` requests containing JSON-RPC messages
   */
  private handlePostRequest;
  /**
   * Handles `DELETE` requests to terminate sessions
   */
  private handleDeleteRequest;
  /**
   * Validates session ID for non-initialization requests.
   * Returns `Response` error if invalid, `undefined` otherwise
   */
  private validateSession;
  /**
   * Validates the `MCP-Protocol-Version` header on incoming requests.
   *
   * For initialization: Version negotiation handles unknown versions gracefully
   * (server responds with its supported version).
   *
   * For subsequent requests with `MCP-Protocol-Version` header:
   * - Accept if in supported list
   * - 400 if unsupported
   *
   * For HTTP requests without the `MCP-Protocol-Version` header:
   * - Accept and default to the version negotiated at initialization
   */
  private validateProtocolVersion;
  close(): Promise<void>;
  /**
   * Close an SSE stream for a specific request, triggering client reconnection.
   * Use this to implement polling behavior during long-running operations -
   * client will reconnect after the retry interval specified in the priming event.
   */
  closeSSEStream(requestId: RequestId): void;
  /**
   * Close the standalone `GET` SSE stream, triggering client reconnection.
   * Use this to implement polling behavior for server-initiated notifications.
   */
  closeStandaloneSSEStream(): void;
  send(message: JSONRPCMessage, options?: {
    relatedRequestId?: RequestId;
  }): Promise<void>;
}
//#endregion
export { type AnyToolHandler, type BaseToolCallback, type CompletableSchema, type CompleteCallback, type CompleteResourceTemplateCallback, type CreateTaskRequestHandler, type EventId, type EventStore, ExperimentalMcpServerTasks, ExperimentalServerTasks, type HandleRequestOptions, type HostHeaderValidationResult, type ListResourcesCallback, McpServer, type PromptCallback, type ReadResourceCallback, type ReadResourceTemplateCallback, type RegisteredPrompt, type RegisteredResource, type RegisteredResourceTemplate, type RegisteredTool, type ResourceMetadata, ResourceTemplate, Server, type ServerOptions, StdioServerTransport, type StreamId, type TaskRequestHandler, type ToolCallback, type ToolTaskHandler, WebStandardStreamableHTTPServerTransport, type WebStandardStreamableHTTPServerTransportOptions, completable, hostHeaderValidationResponse, isCompletable, localhostAllowedHostnames, validateHostHeader };
//# sourceMappingURL=index.d.mts.map