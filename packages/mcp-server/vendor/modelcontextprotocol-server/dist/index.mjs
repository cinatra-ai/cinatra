import { $ as PARSE_ERROR, A as parseJSONRPCMessage, B as ListRootsResultSchema, C as isInitializeRequest, D as isJSONRPCRequest, E as isJSONRPCNotification, F as CreateTaskResultSchema, G as ProtocolErrorCode, H as getResultSchema, I as ElicitResultSchema, J as INVALID_PARAMS, K as DEFAULT_NEGOTIATED_PROTOCOL_VERSION, L as EmptyResultSchema, M as CallToolResultSchema, N as CreateMessageResultSchema, O as isJSONRPCResultResponse, P as CreateMessageResultWithToolsSchema, Q as METHOD_NOT_FOUND, R as GetTaskPayloadResultSchema, S as assertCompleteRequestResourceTemplate, T as isJSONRPCErrorResponse, U as ProtocolError, V as LoggingLevelSchema, W as UrlElicitationRequiredError, X as JSONRPC_VERSION, Y as INVALID_REQUEST, Z as LATEST_PROTOCOL_VERSION, _ as mergeCapabilities, a as standardSchemaToJsonSchema, at as SdkError, b as parseSchema, c as createFetchWithInit, ct as OAuthErrorCode, d as deserializeMessage, et as RELATED_TASK_META_KEY, f as serializeMessage, g as Protocol, h as DEFAULT_REQUEST_TIMEOUT_MSEC, i as promptArgumentsFromStandardSchema, it as resourceUrlFromServerUrl, j as CallToolRequestSchema, k as isTaskAugmentedRequestParams, l as validateAndWarnToolName, m as toArrayAsync, n as CfWorkerJsonSchemaValidator, nt as getDisplayName, o as validateStandardSchema, ot as SdkErrorCode, p as takeResult, q as INTERNAL_ERROR, r as AjvJsonSchemaValidator, rt as checkResourceAllowed, s as UriTemplate, st as OAuthError, t as fromJsonSchema, tt as SUPPORTED_PROTOCOL_VERSIONS, u as ReadBuffer, v as extractTaskManagerOptions, w as isInitializedNotification, x as assertCompleteRequestPrompt, y as isTerminal, z as JSONRPCMessageSchema } from "./src-Zzjv-NPI.mjs";
import { DefaultJsonSchemaValidator, process } from "@modelcontextprotocol/server/_shims";

//#region src/server/completable.ts
const COMPLETABLE_SYMBOL = Symbol.for("mcp.completable");
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
function completable(schema, complete) {
	Object.defineProperty(schema, COMPLETABLE_SYMBOL, {
		value: { complete },
		enumerable: false,
		writable: false,
		configurable: false
	});
	return schema;
}
/**
* Checks if a schema is completable (has completion metadata).
*/
function isCompletable(schema) {
	return !!schema && typeof schema === "object" && COMPLETABLE_SYMBOL in schema;
}
/**
* Gets the completer callback from a completable schema, if it exists.
*/
function getCompleter(schema) {
	return schema[COMPLETABLE_SYMBOL]?.complete;
}

//#endregion
//#region ../core/src/experimental/tasks/helpers.ts
/**
* Experimental task capability assertion helpers.
* WARNING: These APIs are experimental and may change without notice.
*
* @experimental
*/
/**
* Asserts that task creation is supported for `tools/call`.
* Used to implement the `assertTaskCapability` or `assertTaskHandlerCapability` abstract methods on Protocol.
*
* @param requests - The task requests capability object
* @param method - The method being checked
* @param entityName - `'Server'` or `'Client'` for error messages
* @throws {@linkcode SdkError} with {@linkcode SdkErrorCode.CapabilityNotSupported} if the capability is not supported
*
* @experimental
*/
function assertToolsCallTaskCapability(requests, method, entityName) {
	if (!requests) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `${entityName} does not support task creation (required for ${method})`);
	switch (method) {
		case "tools/call":
			if (!requests.tools?.call) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `${entityName} does not support task creation for tools/call (required for ${method})`);
			break;
		default: break;
	}
}
/**
* Asserts that task creation is supported for `sampling/createMessage` or `elicitation/create`.
* Used to implement the `assertTaskCapability` or `assertTaskHandlerCapability` abstract methods on Protocol.
*
* @param requests - The task requests capability object
* @param method - The method being checked
* @param entityName - `'Server'` or `'Client'` for error messages
* @throws {@linkcode SdkError} with {@linkcode SdkErrorCode.CapabilityNotSupported} if the capability is not supported
*
* @experimental
*/
function assertClientRequestTaskCapability(requests, method, entityName) {
	if (!requests) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `${entityName} does not support task creation (required for ${method})`);
	switch (method) {
		case "sampling/createMessage":
			if (!requests.sampling?.createMessage) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `${entityName} does not support task creation for sampling/createMessage (required for ${method})`);
			break;
		case "elicitation/create":
			if (!requests.elicitation?.create) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `${entityName} does not support task creation for elicitation/create (required for ${method})`);
			break;
		default: break;
	}
}

//#endregion
//#region ../core/src/experimental/tasks/stores/inMemory.ts
/**
* In-memory {@linkcode TaskStore} implementation for development and testing.
* For production, use a database or distributed cache.
* @experimental
*/
var InMemoryTaskStore = class {
	tasks = /* @__PURE__ */ new Map();
	cleanupTimers = /* @__PURE__ */ new Map();
	/**
	* Generates a unique task ID using Web Crypto API.
	*/
	generateTaskId() {
		return crypto.randomUUID().replaceAll("-", "");
	}
	/** {@inheritDoc TaskStore.createTask} */
	async createTask(taskParams, requestId, request, sessionId) {
		const taskId = this.generateTaskId();
		if (this.tasks.has(taskId)) throw new Error(`Task with ID ${taskId} already exists`);
		const actualTtl = taskParams.ttl ?? null;
		const createdAt = (/* @__PURE__ */ new Date()).toISOString();
		const task = {
			taskId,
			status: "working",
			ttl: actualTtl,
			createdAt,
			lastUpdatedAt: createdAt,
			pollInterval: taskParams.pollInterval ?? 1e3
		};
		this.tasks.set(taskId, {
			task,
			request,
			requestId,
			sessionId
		});
		if (actualTtl) {
			const timer = setTimeout(() => {
				this.tasks.delete(taskId);
				this.cleanupTimers.delete(taskId);
			}, actualTtl);
			this.cleanupTimers.set(taskId, timer);
		}
		return task;
	}
	/**
	* Retrieves a stored task, enforcing session ownership when a sessionId is provided.
	* Returns undefined if the task does not exist or belongs to a different session.
	*/
	getStoredTask(taskId, sessionId) {
		const stored = this.tasks.get(taskId);
		if (!stored) return;
		if (sessionId !== void 0 && stored.sessionId !== void 0 && stored.sessionId !== sessionId) return;
		return stored;
	}
	async getTask(taskId, sessionId) {
		const stored = this.getStoredTask(taskId, sessionId);
		return stored ? { ...stored.task } : null;
	}
	/** {@inheritDoc TaskStore.storeTaskResult} */
	async storeTaskResult(taskId, status, result, sessionId) {
		const stored = this.getStoredTask(taskId, sessionId);
		if (!stored) throw new Error(`Task with ID ${taskId} not found`);
		if (isTerminal(stored.task.status)) throw new Error(`Cannot store result for task ${taskId} in terminal status '${stored.task.status}'. Task results can only be stored once.`);
		stored.result = result;
		stored.task.status = status;
		stored.task.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
		if (stored.task.ttl) {
			const existingTimer = this.cleanupTimers.get(taskId);
			if (existingTimer) clearTimeout(existingTimer);
			const timer = setTimeout(() => {
				this.tasks.delete(taskId);
				this.cleanupTimers.delete(taskId);
			}, stored.task.ttl);
			this.cleanupTimers.set(taskId, timer);
		}
	}
	/** {@inheritDoc TaskStore.getTaskResult} */
	async getTaskResult(taskId, sessionId) {
		const stored = this.getStoredTask(taskId, sessionId);
		if (!stored) throw new Error(`Task with ID ${taskId} not found`);
		if (!stored.result) throw new Error(`Task ${taskId} has no result stored`);
		return stored.result;
	}
	/** {@inheritDoc TaskStore.updateTaskStatus} */
	async updateTaskStatus(taskId, status, statusMessage, sessionId) {
		const stored = this.getStoredTask(taskId, sessionId);
		if (!stored) throw new Error(`Task with ID ${taskId} not found`);
		if (isTerminal(stored.task.status)) throw new Error(`Cannot update task ${taskId} from terminal status '${stored.task.status}' to '${status}'. Terminal states (completed, failed, cancelled) cannot transition to other states.`);
		stored.task.status = status;
		if (statusMessage) stored.task.statusMessage = statusMessage;
		stored.task.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
		if (isTerminal(status) && stored.task.ttl) {
			const existingTimer = this.cleanupTimers.get(taskId);
			if (existingTimer) clearTimeout(existingTimer);
			const timer = setTimeout(() => {
				this.tasks.delete(taskId);
				this.cleanupTimers.delete(taskId);
			}, stored.task.ttl);
			this.cleanupTimers.set(taskId, timer);
		}
	}
	/** {@inheritDoc TaskStore.listTasks} */
	async listTasks(cursor, sessionId) {
		const PAGE_SIZE = 10;
		const filteredTaskIds = [...this.tasks.entries()].filter(([, stored]) => {
			if (sessionId === void 0 || stored.sessionId === void 0) return true;
			return stored.sessionId === sessionId;
		}).map(([taskId]) => taskId);
		let startIndex = 0;
		if (cursor) {
			const cursorIndex = filteredTaskIds.indexOf(cursor);
			if (cursorIndex === -1) throw new Error(`Invalid cursor: ${cursor}`);
			else startIndex = cursorIndex + 1;
		}
		const pageTaskIds = filteredTaskIds.slice(startIndex, startIndex + PAGE_SIZE);
		return {
			tasks: pageTaskIds.map((taskId) => {
				return { ...this.tasks.get(taskId).task };
			}),
			nextCursor: startIndex + PAGE_SIZE < filteredTaskIds.length ? pageTaskIds.at(-1) : void 0
		};
	}
	/**
	* Cleanup all timers (useful for testing or graceful shutdown)
	*/
	cleanup() {
		for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
		this.cleanupTimers.clear();
		this.tasks.clear();
	}
	/**
	* Get all tasks (useful for debugging)
	*/
	getAllTasks() {
		return [...this.tasks.values()].map((stored) => ({ ...stored.task }));
	}
};
/**
* In-memory {@linkcode TaskMessageQueue} implementation for development and testing.
* For production, use Redis or another distributed queue.
* @experimental
*/
var InMemoryTaskMessageQueue = class {
	queues = /* @__PURE__ */ new Map();
	/**
	* Generates a queue key from taskId.
	* SessionId is intentionally ignored because taskIds are globally unique
	* and tasks need to be accessible across HTTP requests/sessions.
	*/
	getQueueKey(taskId, _sessionId) {
		return taskId;
	}
	/**
	* Gets or creates a queue for the given task and session.
	*/
	getQueue(taskId, sessionId) {
		const key = this.getQueueKey(taskId, sessionId);
		let queue = this.queues.get(key);
		if (!queue) {
			queue = [];
			this.queues.set(key, queue);
		}
		return queue;
	}
	/**
	* Adds a message to the end of the queue for a specific task.
	* Atomically checks queue size and throws if maxSize would be exceeded.
	* @param taskId The task identifier
	* @param message The message to enqueue
	* @param sessionId Optional session ID for binding the operation to a specific session
	* @param maxSize Optional maximum queue size - if specified and queue is full, throws an error
	* @throws Error if maxSize is specified and would be exceeded
	*/
	async enqueue(taskId, message, sessionId, maxSize) {
		const queue = this.getQueue(taskId, sessionId);
		if (maxSize !== void 0 && queue.length >= maxSize) throw new Error(`Task message queue overflow: queue size (${queue.length}) exceeds maximum (${maxSize})`);
		queue.push(message);
	}
	/**
	* Removes and returns the first message from the queue for a specific task.
	* @param taskId The task identifier
	* @param sessionId Optional session ID for binding the query to a specific session
	* @returns The first message, or `undefined` if the queue is empty
	*/
	async dequeue(taskId, sessionId) {
		return this.getQueue(taskId, sessionId).shift();
	}
	/**
	* Removes and returns all messages from the queue for a specific task.
	* @param taskId The task identifier
	* @param sessionId Optional session ID for binding the query to a specific session
	* @returns Array of all messages that were in the queue
	*/
	async dequeueAll(taskId, sessionId) {
		const key = this.getQueueKey(taskId, sessionId);
		const queue = this.queues.get(key) ?? [];
		this.queues.delete(key);
		return queue;
	}
};

//#endregion
//#region src/experimental/tasks/mcpServer.ts
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
var ExperimentalMcpServerTasks = class {
	constructor(_mcpServer) {
		this._mcpServer = _mcpServer;
	}
	registerToolTask(name, config, handler) {
		const execution = {
			taskSupport: "required",
			...config.execution
		};
		if (execution.taskSupport === "forbidden") throw new Error(`Cannot register task-based tool '${name}' with taskSupport 'forbidden'. Use registerTool() instead.`);
		return this._mcpServer._createRegisteredTool(name, config.title, config.description, config.inputSchema, config.outputSchema, config.annotations, execution, config._meta, handler);
	}
};

//#endregion
//#region src/experimental/tasks/server.ts
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
var ExperimentalServerTasks = class {
	constructor(_server) {
		this._server = _server;
	}
	get _module() {
		return this._server.taskManager;
	}
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
	requestStream(request, options) {
		const resultSchema = getResultSchema(request.method);
		return this._module.requestStream(request, resultSchema, options);
	}
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
	createMessageStream(params, options) {
		const clientCapabilities = this._server.getClientCapabilities();
		if ((params.tools || params.toolChoice) && !clientCapabilities?.sampling?.tools) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support sampling tools capability.");
		if (params.messages.length > 0) {
			const lastMessage = params.messages.at(-1);
			const lastContent = Array.isArray(lastMessage.content) ? lastMessage.content : [lastMessage.content];
			const hasToolResults = lastContent.some((c) => c.type === "tool_result");
			const previousMessage = params.messages.length > 1 ? params.messages.at(-2) : void 0;
			const previousContent = previousMessage ? Array.isArray(previousMessage.content) ? previousMessage.content : [previousMessage.content] : [];
			const hasPreviousToolUse = previousContent.some((c) => c.type === "tool_use");
			if (hasToolResults) {
				if (lastContent.some((c) => c.type !== "tool_result")) throw new Error("The last message must contain only tool_result content if any is present");
				if (!hasPreviousToolUse) throw new Error("tool_result blocks are not matching any tool_use from the previous message");
			}
			if (hasPreviousToolUse) {
				const toolUseIds = new Set(previousContent.filter((c) => c.type === "tool_use").map((c) => c.id));
				const toolResultIds = new Set(lastContent.filter((c) => c.type === "tool_result").map((c) => c.toolUseId));
				if (toolUseIds.size !== toolResultIds.size || ![...toolUseIds].every((id) => toolResultIds.has(id))) throw new Error("ids of tool_result blocks and tool_use blocks from previous message do not match");
			}
		}
		return this.requestStream({
			method: "sampling/createMessage",
			params
		}, options);
	}
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
	elicitInputStream(params, options) {
		const clientCapabilities = this._server.getClientCapabilities();
		const mode = params.mode ?? "form";
		switch (mode) {
			case "url":
				if (!clientCapabilities?.elicitation?.url) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support url elicitation.");
				break;
			case "form":
				if (!clientCapabilities?.elicitation?.form) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support form elicitation.");
				break;
		}
		const normalizedParams = mode === "form" && params.mode !== "form" ? {
			...params,
			mode: "form"
		} : params;
		return this.requestStream({
			method: "elicitation/create",
			params: normalizedParams
		}, options);
	}
	/**
	* Gets the current status of a task.
	*
	* @param taskId - The task identifier
	* @param options - Optional request options
	* @returns The task status
	*
	* @experimental
	*/
	async getTask(taskId, options) {
		return this._module.getTask({ taskId }, options);
	}
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
	async getTaskResult(taskId, options) {
		return this._module.getTaskResult({ taskId }, GetTaskPayloadResultSchema, options);
	}
	/**
	* Lists tasks with optional pagination.
	*
	* @param cursor - Optional pagination cursor
	* @param options - Optional request options
	* @returns List of tasks with optional next cursor
	*
	* @experimental
	*/
	async listTasks(cursor, options) {
		return this._module.listTasks(cursor ? { cursor } : void 0, options);
	}
	/**
	* Cancels a running task.
	*
	* @param taskId - The task identifier
	* @param options - Optional request options
	*
	* @experimental
	*/
	async cancelTask(taskId, options) {
		return this._module.cancelTask({ taskId }, options);
	}
};

//#endregion
//#region src/server/server.ts
/**
* An MCP server on top of a pluggable transport.
*
* This server will automatically respond to the initialization flow as initiated from the client.
*
* @deprecated Use {@linkcode server/mcp.McpServer | McpServer} instead for the high-level API. Only use `Server` for advanced use cases.
*/
var Server = class extends Protocol {
	_clientCapabilities;
	_clientVersion;
	_capabilities;
	_instructions;
	_jsonSchemaValidator;
	_experimental;
	/**
	* Callback for when initialization has fully completed (i.e., the client has sent an `notifications/initialized` notification).
	*/
	oninitialized;
	/**
	* Initializes this server with the given name and version information.
	*/
	constructor(_serverInfo, options) {
		super({
			...options,
			tasks: extractTaskManagerOptions(options?.capabilities?.tasks)
		});
		this._serverInfo = _serverInfo;
		this._capabilities = options?.capabilities ? { ...options.capabilities } : {};
		this._instructions = options?.instructions;
		this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new DefaultJsonSchemaValidator();
		if (options?.capabilities?.tasks) {
			const { taskStore, taskMessageQueue, defaultTaskPollInterval, maxTaskQueueSize, ...wireCapabilities } = options.capabilities.tasks;
			this._capabilities.tasks = wireCapabilities;
		}
		this.setRequestHandler("initialize", (request) => this._oninitialize(request));
		this.setNotificationHandler("notifications/initialized", () => this.oninitialized?.());
		if (this._capabilities.logging) this._registerLoggingHandler();
	}
	_registerLoggingHandler() {
		this.setRequestHandler("logging/setLevel", async (request, ctx) => {
			const transportSessionId = ctx.sessionId || ctx.http?.req?.headers.get("mcp-session-id") || void 0;
			const { level } = request.params;
			const parseResult = parseSchema(LoggingLevelSchema, level);
			if (parseResult.success) this._loggingLevels.set(transportSessionId, parseResult.data);
			return {};
		});
	}
	buildContext(ctx, transportInfo) {
		const hasHttpInfo = ctx.http || transportInfo?.requestInfo || transportInfo?.closeSSEStream || transportInfo?.closeStandaloneSSEStream;
		return {
			...ctx,
			mcpReq: {
				...ctx.mcpReq,
				log: (level, data, logger) => this.sendLoggingMessage({
					level,
					data,
					logger
				}),
				elicitInput: (params, options) => this.elicitInput(params, options),
				requestSampling: (params, options) => this.createMessage(params, options)
			},
			http: hasHttpInfo ? {
				...ctx.http,
				req: transportInfo?.requestInfo,
				closeSSE: transportInfo?.closeSSEStream,
				closeStandaloneSSE: transportInfo?.closeStandaloneSSEStream
			} : void 0
		};
	}
	/**
	* Access experimental features.
	*
	* WARNING: These APIs are experimental and may change without notice.
	*
	* @experimental
	*/
	get experimental() {
		if (!this._experimental) this._experimental = { tasks: new ExperimentalServerTasks(this) };
		return this._experimental;
	}
	_loggingLevels = /* @__PURE__ */ new Map();
	LOG_LEVEL_SEVERITY = new Map(LoggingLevelSchema.options.map((level, index) => [level, index]));
	isMessageIgnored = (level, sessionId) => {
		const currentLevel = this._loggingLevels.get(sessionId);
		return currentLevel ? this.LOG_LEVEL_SEVERITY.get(level) < this.LOG_LEVEL_SEVERITY.get(currentLevel) : false;
	};
	/**
	* Registers new capabilities. This can only be called before connecting to a transport.
	*
	* The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
	*/
	registerCapabilities(capabilities) {
		if (this.transport) throw new SdkError(SdkErrorCode.AlreadyConnected, "Cannot register capabilities after connecting to transport");
		const hadLogging = !!this._capabilities.logging;
		this._capabilities = mergeCapabilities(this._capabilities, capabilities);
		if (!hadLogging && this._capabilities.logging) this._registerLoggingHandler();
	}
	/**
	* Override request handler registration to enforce server-side validation for `tools/call`.
	*/
	setRequestHandler(method, handler) {
		if (method === "tools/call") {
			const wrappedHandler = async (request, ctx) => {
				const validatedRequest = parseSchema(CallToolRequestSchema, request);
				if (!validatedRequest.success) {
					const errorMessage = validatedRequest.error instanceof Error ? validatedRequest.error.message : String(validatedRequest.error);
					throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tools/call request: ${errorMessage}`);
				}
				const { params } = validatedRequest.data;
				const result = await Promise.resolve(handler(request, ctx));
				if (params.task) {
					const taskValidationResult = parseSchema(CreateTaskResultSchema, result);
					if (!taskValidationResult.success) {
						const errorMessage = taskValidationResult.error instanceof Error ? taskValidationResult.error.message : String(taskValidationResult.error);
						throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid task creation result: ${errorMessage}`);
					}
					return taskValidationResult.data;
				}
				const validationResult = parseSchema(CallToolResultSchema, result);
				if (!validationResult.success) {
					const errorMessage = validationResult.error instanceof Error ? validationResult.error.message : String(validationResult.error);
					throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid tools/call result: ${errorMessage}`);
				}
				return validationResult.data;
			};
			return super.setRequestHandler(method, wrappedHandler);
		}
		return super.setRequestHandler(method, handler);
	}
	assertCapabilityForMethod(method) {
		switch (method) {
			case "sampling/createMessage":
				if (!this._clientCapabilities?.sampling) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support sampling (required for ${method})`);
				break;
			case "elicitation/create":
				if (!this._clientCapabilities?.elicitation) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support elicitation (required for ${method})`);
				break;
			case "roots/list":
				if (!this._clientCapabilities?.roots) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support listing roots (required for ${method})`);
				break;
			case "ping": break;
		}
	}
	assertNotificationCapability(method) {
		switch (method) {
			case "notifications/message":
				if (!this._capabilities.logging) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
				break;
			case "notifications/resources/updated":
			case "notifications/resources/list_changed":
				if (!this._capabilities.resources) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support notifying about resources (required for ${method})`);
				break;
			case "notifications/tools/list_changed":
				if (!this._capabilities.tools) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support notifying of tool list changes (required for ${method})`);
				break;
			case "notifications/prompts/list_changed":
				if (!this._capabilities.prompts) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support notifying of prompt list changes (required for ${method})`);
				break;
			case "notifications/elicitation/complete":
				if (!this._clientCapabilities?.elicitation?.url) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support URL elicitation (required for ${method})`);
				break;
			case "notifications/cancelled": break;
			case "notifications/progress": break;
		}
	}
	assertRequestHandlerCapability(method) {
		switch (method) {
			case "completion/complete":
				if (!this._capabilities.completions) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support completions (required for ${method})`);
				break;
			case "logging/setLevel":
				if (!this._capabilities.logging) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
				break;
			case "prompts/get":
			case "prompts/list":
				if (!this._capabilities.prompts) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support prompts (required for ${method})`);
				break;
			case "resources/list":
			case "resources/templates/list":
			case "resources/read":
				if (!this._capabilities.resources) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resources (required for ${method})`);
				break;
			case "tools/call":
			case "tools/list":
				if (!this._capabilities.tools) throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support tools (required for ${method})`);
				break;
			case "ping":
			case "initialize": break;
		}
	}
	assertTaskCapability(method) {
		assertClientRequestTaskCapability(this._clientCapabilities?.tasks?.requests, method, "Client");
	}
	assertTaskHandlerCapability(method) {
		assertToolsCallTaskCapability(this._capabilities?.tasks?.requests, method, "Server");
	}
	async _oninitialize(request) {
		const requestedVersion = request.params.protocolVersion;
		this._clientCapabilities = request.params.capabilities;
		this._clientVersion = request.params.clientInfo;
		return {
			protocolVersion: this._supportedProtocolVersions.includes(requestedVersion) ? requestedVersion : this._supportedProtocolVersions[0] ?? LATEST_PROTOCOL_VERSION,
			capabilities: this.getCapabilities(),
			serverInfo: this._serverInfo,
			...this._instructions && { instructions: this._instructions }
		};
	}
	/**
	* After initialization has completed, this will be populated with the client's reported capabilities.
	*/
	getClientCapabilities() {
		return this._clientCapabilities;
	}
	/**
	* After initialization has completed, this will be populated with information about the client's name and version.
	*/
	getClientVersion() {
		return this._clientVersion;
	}
	/**
	* Returns the current server capabilities.
	*/
	getCapabilities() {
		return this._capabilities;
	}
	async ping() {
		return this._requestWithSchema({ method: "ping" }, EmptyResultSchema);
	}
	async createMessage(params, options) {
		if ((params.tools || params.toolChoice) && !this._clientCapabilities?.sampling?.tools) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support sampling tools capability.");
		if (params.messages.length > 0) {
			const lastMessage = params.messages.at(-1);
			const lastContent = Array.isArray(lastMessage.content) ? lastMessage.content : [lastMessage.content];
			const hasToolResults = lastContent.some((c) => c.type === "tool_result");
			const previousMessage = params.messages.length > 1 ? params.messages.at(-2) : void 0;
			const previousContent = previousMessage ? Array.isArray(previousMessage.content) ? previousMessage.content : [previousMessage.content] : [];
			const hasPreviousToolUse = previousContent.some((c) => c.type === "tool_use");
			if (hasToolResults) {
				if (lastContent.some((c) => c.type !== "tool_result")) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "The last message must contain only tool_result content if any is present");
				if (!hasPreviousToolUse) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "tool_result blocks are not matching any tool_use from the previous message");
			}
			if (hasPreviousToolUse) {
				const toolUseIds = new Set(previousContent.filter((c) => c.type === "tool_use").map((c) => c.id));
				const toolResultIds = new Set(lastContent.filter((c) => c.type === "tool_result").map((c) => c.toolUseId));
				if (toolUseIds.size !== toolResultIds.size || ![...toolUseIds].every((id) => toolResultIds.has(id))) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "ids of tool_result blocks and tool_use blocks from previous message do not match");
			}
		}
		if (params.tools) return this._requestWithSchema({
			method: "sampling/createMessage",
			params
		}, CreateMessageResultWithToolsSchema, options);
		return this._requestWithSchema({
			method: "sampling/createMessage",
			params
		}, CreateMessageResultSchema, options);
	}
	/**
	* Creates an elicitation request for the given parameters.
	* For backwards compatibility, `mode` may be omitted for form requests and will default to `"form"`.
	* @param params The parameters for the elicitation request.
	* @param options Optional request options.
	* @returns The result of the elicitation request.
	*/
	async elicitInput(params, options) {
		switch (params.mode ?? "form") {
			case "url": {
				if (!this._clientCapabilities?.elicitation?.url) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support url elicitation.");
				const urlParams = params;
				return this._requestWithSchema({
					method: "elicitation/create",
					params: urlParams
				}, ElicitResultSchema, options);
			}
			case "form": {
				if (!this._clientCapabilities?.elicitation?.form) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support form elicitation.");
				const formParams = params.mode === "form" ? params : {
					...params,
					mode: "form"
				};
				const result = await this._requestWithSchema({
					method: "elicitation/create",
					params: formParams
				}, ElicitResultSchema, options);
				if (result.action === "accept" && result.content && formParams.requestedSchema) try {
					const validationResult = this._jsonSchemaValidator.getValidator(formParams.requestedSchema)(result.content);
					if (!validationResult.valid) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation response content does not match requested schema: ${validationResult.errorMessage}`);
				} catch (error) {
					if (error instanceof ProtocolError) throw error;
					throw new ProtocolError(ProtocolErrorCode.InternalError, `Error validating elicitation response: ${error instanceof Error ? error.message : String(error)}`);
				}
				return result;
			}
		}
	}
	/**
	* Creates a reusable callback that, when invoked, will send a `notifications/elicitation/complete`
	* notification for the specified elicitation ID.
	*
	* @param elicitationId The ID of the elicitation to mark as complete.
	* @param options Optional notification options. Useful when the completion notification should be related to a prior request.
	* @returns A function that emits the completion notification when awaited.
	*/
	createElicitationCompletionNotifier(elicitationId, options) {
		if (!this._clientCapabilities?.elicitation?.url) throw new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support URL elicitation (required for notifications/elicitation/complete)");
		return () => this.notification({
			method: "notifications/elicitation/complete",
			params: { elicitationId }
		}, options);
	}
	async listRoots(params, options) {
		return this._requestWithSchema({
			method: "roots/list",
			params
		}, ListRootsResultSchema, options);
	}
	/**
	* Sends a logging message to the client, if connected.
	* Note: You only need to send the parameters object, not the entire JSON-RPC message.
	* @see {@linkcode LoggingMessageNotification}
	* @param params
	* @param sessionId Optional for stateless transports and backward compatibility.
	*/
	async sendLoggingMessage(params, sessionId) {
		if (this._capabilities.logging && !this.isMessageIgnored(params.level, sessionId)) return this.notification({
			method: "notifications/message",
			params
		});
	}
	async sendResourceUpdated(params) {
		return this.notification({
			method: "notifications/resources/updated",
			params
		});
	}
	async sendResourceListChanged() {
		return this.notification({ method: "notifications/resources/list_changed" });
	}
	async sendToolListChanged() {
		return this.notification({ method: "notifications/tools/list_changed" });
	}
	async sendPromptListChanged() {
		return this.notification({ method: "notifications/prompts/list_changed" });
	}
};

//#endregion
//#region src/server/mcp.ts
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
var McpServer = class {
	/**
	* The underlying {@linkcode Server} instance, useful for advanced operations like sending notifications.
	*/
	server;
	_registeredResources = {};
	_registeredResourceTemplates = {};
	_registeredTools = {};
	_registeredPrompts = {};
	_experimental;
	constructor(serverInfo, options) {
		this.server = new Server(serverInfo, options);
	}
	/**
	* Access experimental features.
	*
	* WARNING: These APIs are experimental and may change without notice.
	*
	* @experimental
	*/
	get experimental() {
		if (!this._experimental) this._experimental = { tasks: new ExperimentalMcpServerTasks(this) };
		return this._experimental;
	}
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
	async connect(transport) {
		return await this.server.connect(transport);
	}
	/**
	* Closes the connection.
	*/
	async close() {
		await this.server.close();
	}
	_toolHandlersInitialized = false;
	setToolRequestHandlers() {
		if (this._toolHandlersInitialized) return;
		this.server.assertCanSetRequestHandler("tools/list");
		this.server.assertCanSetRequestHandler("tools/call");
		this.server.registerCapabilities({ tools: { listChanged: this.server.getCapabilities().tools?.listChanged ?? true } });
		this.server.setRequestHandler("tools/list", () => ({ tools: Object.entries(this._registeredTools).filter(([, tool]) => tool.enabled).map(([name, tool]) => {
			const toolDefinition = {
				name,
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema ? standardSchemaToJsonSchema(tool.inputSchema, "input") : EMPTY_OBJECT_JSON_SCHEMA,
				annotations: tool.annotations,
				execution: tool.execution,
				_meta: tool._meta
			};
			if (tool.outputSchema) toolDefinition.outputSchema = standardSchemaToJsonSchema(tool.outputSchema, "output");
			return toolDefinition;
		}) }));
		this.server.setRequestHandler("tools/call", async (request, ctx) => {
			const tool = this._registeredTools[request.params.name];
			if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
			if (!tool.enabled) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} disabled`);
			try {
				const isTaskRequest = !!request.params.task;
				const taskSupport = tool.execution?.taskSupport;
				const isTaskHandler = "createTask" in tool.handler;
				if ((taskSupport === "required" || taskSupport === "optional") && !isTaskHandler) throw new ProtocolError(ProtocolErrorCode.InternalError, `Tool ${request.params.name} has taskSupport '${taskSupport}' but was not registered with registerToolTask`);
				if (taskSupport === "required" && !isTaskRequest) throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Tool ${request.params.name} requires task augmentation (taskSupport: 'required')`);
				if (taskSupport === "optional" && !isTaskRequest && isTaskHandler) return await this.handleAutomaticTaskPolling(tool, request, ctx);
				const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
				const result = await this.executeToolHandler(tool, args, ctx);
				if (isTaskRequest) return result;
				await this.validateToolOutput(tool, result, request.params.name);
				return result;
			} catch (error) {
				if (error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired) throw error;
				return this.createToolError(error instanceof Error ? error.message : String(error));
			}
		});
		this._toolHandlersInitialized = true;
	}
	/**
	* Creates a tool error result.
	*
	* @param errorMessage - The error message.
	* @returns The tool error result.
	*/
	createToolError(errorMessage) {
		return {
			content: [{
				type: "text",
				text: errorMessage
			}],
			isError: true
		};
	}
	/**
	* Validates tool input arguments against the tool's input schema.
	*/
	async validateToolInput(tool, args, toolName) {
		if (!tool.inputSchema) return;
		const parseResult = await validateStandardSchema(tool.inputSchema, args ?? {});
		if (!parseResult.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ${toolName}: ${parseResult.error}`);
		return parseResult.data;
	}
	/**
	* Validates tool output against the tool's output schema.
	*/
	async validateToolOutput(tool, result, toolName) {
		if (!tool.outputSchema) return;
		if (!("content" in result)) return;
		if (result.isError) return;
		if (!result.structuredContent) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`);
		const parseResult = await validateStandardSchema(tool.outputSchema, result.structuredContent);
		if (!parseResult.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Output validation error: Invalid structured content for tool ${toolName}: ${parseResult.error}`);
	}
	/**
	* Executes a tool handler (either regular or task-based).
	*/
	async executeToolHandler(tool, args, ctx) {
		return tool.executor(args, ctx);
	}
	/**
	* Handles automatic task polling for tools with `taskSupport` `'optional'`.
	*/
	async handleAutomaticTaskPolling(tool, request, ctx) {
		if (!ctx.task?.store) throw new Error("No task store provided for task-capable tool.");
		const args = await this.validateToolInput(tool, request.params.arguments, request.params.name);
		const createTaskResult = await tool.executor(args, ctx);
		const taskId = createTaskResult.task.taskId;
		let task = createTaskResult.task;
		const pollInterval = task.pollInterval ?? 5e3;
		while (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
			await new Promise((resolve) => setTimeout(resolve, pollInterval));
			const updatedTask = await ctx.task.store.getTask(taskId);
			if (!updatedTask) throw new ProtocolError(ProtocolErrorCode.InternalError, `Task ${taskId} not found during polling`);
			task = updatedTask;
		}
		return await ctx.task.store.getTaskResult(taskId);
	}
	_completionHandlerInitialized = false;
	setCompletionRequestHandler() {
		if (this._completionHandlerInitialized) return;
		this.server.assertCanSetRequestHandler("completion/complete");
		this.server.registerCapabilities({ completions: {} });
		this.server.setRequestHandler("completion/complete", async (request) => {
			switch (request.params.ref.type) {
				case "ref/prompt":
					assertCompleteRequestPrompt(request);
					return this.handlePromptCompletion(request, request.params.ref);
				case "ref/resource":
					assertCompleteRequestResourceTemplate(request);
					return this.handleResourceCompletion(request, request.params.ref);
				default: throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid completion reference: ${request.params.ref}`);
			}
		});
		this._completionHandlerInitialized = true;
	}
	async handlePromptCompletion(request, ref) {
		const prompt = this._registeredPrompts[ref.name];
		if (!prompt) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${ref.name} not found`);
		if (!prompt.enabled) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${ref.name} disabled`);
		if (!prompt.argsSchema) return EMPTY_COMPLETION_RESULT;
		const field = unwrapOptionalSchema(getSchemaShape(prompt.argsSchema)?.[request.params.argument.name]);
		if (!isCompletable(field)) return EMPTY_COMPLETION_RESULT;
		const completer = getCompleter(field);
		if (!completer) return EMPTY_COMPLETION_RESULT;
		return createCompletionResult(await completer(request.params.argument.value, request.params.context));
	}
	async handleResourceCompletion(request, ref) {
		const template = Object.values(this._registeredResourceTemplates).find((t) => t.resourceTemplate.uriTemplate.toString() === ref.uri);
		if (!template) {
			if (this._registeredResources[ref.uri]) return EMPTY_COMPLETION_RESULT;
			throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource template ${request.params.ref.uri} not found`);
		}
		const completer = template.resourceTemplate.completeCallback(request.params.argument.name);
		if (!completer) return EMPTY_COMPLETION_RESULT;
		return createCompletionResult(await completer(request.params.argument.value, request.params.context));
	}
	_resourceHandlersInitialized = false;
	setResourceRequestHandlers() {
		if (this._resourceHandlersInitialized) return;
		this.server.assertCanSetRequestHandler("resources/list");
		this.server.assertCanSetRequestHandler("resources/templates/list");
		this.server.assertCanSetRequestHandler("resources/read");
		this.server.registerCapabilities({ resources: { listChanged: this.server.getCapabilities().resources?.listChanged ?? true } });
		this.server.setRequestHandler("resources/list", async (_request, ctx) => {
			const resources = Object.entries(this._registeredResources).filter(([_, resource]) => resource.enabled).map(([uri, resource]) => ({
				uri,
				name: resource.name,
				...resource.metadata
			}));
			const templateResources = [];
			for (const template of Object.values(this._registeredResourceTemplates)) {
				if (!template.resourceTemplate.listCallback) continue;
				const result = await template.resourceTemplate.listCallback(ctx);
				for (const resource of result.resources) templateResources.push({
					...template.metadata,
					...resource
				});
			}
			return { resources: [...resources, ...templateResources] };
		});
		this.server.setRequestHandler("resources/templates/list", async () => {
			return { resourceTemplates: Object.entries(this._registeredResourceTemplates).map(([name, template]) => ({
				name,
				uriTemplate: template.resourceTemplate.uriTemplate.toString(),
				...template.metadata
			})) };
		});
		this.server.setRequestHandler("resources/read", async (request, ctx) => {
			const uri = new URL(request.params.uri);
			const resource = this._registeredResources[uri.toString()];
			if (resource) {
				if (!resource.enabled) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource ${uri} disabled`);
				return resource.readCallback(uri, ctx);
			}
			for (const template of Object.values(this._registeredResourceTemplates)) {
				const variables = template.resourceTemplate.uriTemplate.match(uri.toString());
				if (variables) return template.readCallback(uri, variables, ctx);
			}
			throw new ProtocolError(ProtocolErrorCode.ResourceNotFound, `Resource ${uri} not found`);
		});
		this._resourceHandlersInitialized = true;
	}
	_promptHandlersInitialized = false;
	setPromptRequestHandlers() {
		if (this._promptHandlersInitialized) return;
		this.server.assertCanSetRequestHandler("prompts/list");
		this.server.assertCanSetRequestHandler("prompts/get");
		this.server.registerCapabilities({ prompts: { listChanged: this.server.getCapabilities().prompts?.listChanged ?? true } });
		this.server.setRequestHandler("prompts/list", () => ({ prompts: Object.entries(this._registeredPrompts).filter(([, prompt]) => prompt.enabled).map(([name, prompt]) => {
			return {
				name,
				title: prompt.title,
				description: prompt.description,
				arguments: prompt.argsSchema ? promptArgumentsFromStandardSchema(prompt.argsSchema) : void 0
			};
		}) }));
		this.server.setRequestHandler("prompts/get", async (request, ctx) => {
			const prompt = this._registeredPrompts[request.params.name];
			if (!prompt) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
			if (!prompt.enabled) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Prompt ${request.params.name} disabled`);
			return prompt.handler(request.params.arguments, ctx);
		});
		this._promptHandlersInitialized = true;
	}
	registerResource(name, uriOrTemplate, config, readCallback) {
		if (typeof uriOrTemplate === "string") {
			if (this._registeredResources[uriOrTemplate]) throw new Error(`Resource ${uriOrTemplate} is already registered`);
			const registeredResource = this._createRegisteredResource(name, config.title, uriOrTemplate, config, readCallback);
			this.setResourceRequestHandlers();
			this.sendResourceListChanged();
			return registeredResource;
		} else {
			if (this._registeredResourceTemplates[name]) throw new Error(`Resource template ${name} is already registered`);
			const registeredResourceTemplate = this._createRegisteredResourceTemplate(name, config.title, uriOrTemplate, config, readCallback);
			this.setResourceRequestHandlers();
			this.sendResourceListChanged();
			return registeredResourceTemplate;
		}
	}
	_createRegisteredResource(name, title, uri, metadata, readCallback) {
		const registeredResource = {
			name,
			title,
			metadata,
			readCallback,
			enabled: true,
			disable: () => registeredResource.update({ enabled: false }),
			enable: () => registeredResource.update({ enabled: true }),
			remove: () => registeredResource.update({ uri: null }),
			update: (updates) => {
				if (updates.uri !== void 0 && updates.uri !== uri) {
					delete this._registeredResources[uri];
					if (updates.uri) this._registeredResources[updates.uri] = registeredResource;
				}
				if (updates.name !== void 0) registeredResource.name = updates.name;
				if (updates.title !== void 0) registeredResource.title = updates.title;
				if (updates.metadata !== void 0) registeredResource.metadata = updates.metadata;
				if (updates.callback !== void 0) registeredResource.readCallback = updates.callback;
				if (updates.enabled !== void 0) registeredResource.enabled = updates.enabled;
				this.sendResourceListChanged();
			}
		};
		this._registeredResources[uri] = registeredResource;
		return registeredResource;
	}
	_createRegisteredResourceTemplate(name, title, template, metadata, readCallback) {
		const registeredResourceTemplate = {
			resourceTemplate: template,
			title,
			metadata,
			readCallback,
			enabled: true,
			disable: () => registeredResourceTemplate.update({ enabled: false }),
			enable: () => registeredResourceTemplate.update({ enabled: true }),
			remove: () => registeredResourceTemplate.update({ name: null }),
			update: (updates) => {
				if (updates.name !== void 0 && updates.name !== name) {
					delete this._registeredResourceTemplates[name];
					if (updates.name) this._registeredResourceTemplates[updates.name] = registeredResourceTemplate;
				}
				if (updates.title !== void 0) registeredResourceTemplate.title = updates.title;
				if (updates.template !== void 0) registeredResourceTemplate.resourceTemplate = updates.template;
				if (updates.metadata !== void 0) registeredResourceTemplate.metadata = updates.metadata;
				if (updates.callback !== void 0) registeredResourceTemplate.readCallback = updates.callback;
				if (updates.enabled !== void 0) registeredResourceTemplate.enabled = updates.enabled;
				this.sendResourceListChanged();
			}
		};
		this._registeredResourceTemplates[name] = registeredResourceTemplate;
		const variableNames = template.uriTemplate.variableNames;
		if (Array.isArray(variableNames) && variableNames.some((v) => !!template.completeCallback(v))) this.setCompletionRequestHandler();
		return registeredResourceTemplate;
	}
	_createRegisteredPrompt(name, title, description, argsSchema, callback) {
		let currentArgsSchema = argsSchema;
		let currentCallback = callback;
		const registeredPrompt = {
			title,
			description,
			argsSchema,
			handler: createPromptHandler(name, argsSchema, callback),
			enabled: true,
			disable: () => registeredPrompt.update({ enabled: false }),
			enable: () => registeredPrompt.update({ enabled: true }),
			remove: () => registeredPrompt.update({ name: null }),
			update: (updates) => {
				if (updates.name !== void 0 && updates.name !== name) {
					delete this._registeredPrompts[name];
					if (updates.name) this._registeredPrompts[updates.name] = registeredPrompt;
				}
				if (updates.title !== void 0) registeredPrompt.title = updates.title;
				if (updates.description !== void 0) registeredPrompt.description = updates.description;
				let needsHandlerRegen = false;
				if (updates.argsSchema !== void 0) {
					registeredPrompt.argsSchema = updates.argsSchema;
					currentArgsSchema = updates.argsSchema;
					needsHandlerRegen = true;
				}
				if (updates.callback !== void 0) {
					currentCallback = updates.callback;
					needsHandlerRegen = true;
				}
				if (needsHandlerRegen) registeredPrompt.handler = createPromptHandler(name, currentArgsSchema, currentCallback);
				if (updates.enabled !== void 0) registeredPrompt.enabled = updates.enabled;
				this.sendPromptListChanged();
			}
		};
		this._registeredPrompts[name] = registeredPrompt;
		if (argsSchema) {
			const shape = getSchemaShape(argsSchema);
			if (shape) {
				if (Object.values(shape).some((field) => {
					return isCompletable(unwrapOptionalSchema(field));
				})) this.setCompletionRequestHandler();
			}
		}
		return registeredPrompt;
	}
	_createRegisteredTool(name, title, description, inputSchema, outputSchema, annotations, execution, _meta, handler) {
		validateAndWarnToolName(name);
		let currentHandler = handler;
		const registeredTool = {
			title,
			description,
			inputSchema,
			outputSchema,
			annotations,
			execution,
			_meta,
			handler,
			executor: createToolExecutor(inputSchema, handler),
			enabled: true,
			disable: () => registeredTool.update({ enabled: false }),
			enable: () => registeredTool.update({ enabled: true }),
			remove: () => registeredTool.update({ name: null }),
			update: (updates) => {
				if (updates.name !== void 0 && updates.name !== name) {
					if (typeof updates.name === "string") validateAndWarnToolName(updates.name);
					delete this._registeredTools[name];
					if (updates.name) this._registeredTools[updates.name] = registeredTool;
				}
				if (updates.title !== void 0) registeredTool.title = updates.title;
				if (updates.description !== void 0) registeredTool.description = updates.description;
				let needsExecutorRegen = false;
				if (updates.paramsSchema !== void 0) {
					registeredTool.inputSchema = updates.paramsSchema;
					needsExecutorRegen = true;
				}
				if (updates.callback !== void 0) {
					registeredTool.handler = updates.callback;
					currentHandler = updates.callback;
					needsExecutorRegen = true;
				}
				if (needsExecutorRegen) registeredTool.executor = createToolExecutor(registeredTool.inputSchema, currentHandler);
				if (updates.outputSchema !== void 0) registeredTool.outputSchema = updates.outputSchema;
				if (updates.annotations !== void 0) registeredTool.annotations = updates.annotations;
				if (updates._meta !== void 0) registeredTool._meta = updates._meta;
				if (updates.enabled !== void 0) registeredTool.enabled = updates.enabled;
				this.sendToolListChanged();
			}
		};
		this._registeredTools[name] = registeredTool;
		this.setToolRequestHandlers();
		this.sendToolListChanged();
		return registeredTool;
	}
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
	registerTool(name, config, cb) {
		if (this._registeredTools[name]) throw new Error(`Tool ${name} is already registered`);
		const { title, description, inputSchema, outputSchema, annotations, _meta } = config;
		return this._createRegisteredTool(name, title, description, inputSchema, outputSchema, annotations, { taskSupport: "forbidden" }, _meta, cb);
	}
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
	registerPrompt(name, config, cb) {
		if (this._registeredPrompts[name]) throw new Error(`Prompt ${name} is already registered`);
		const { title, description, argsSchema } = config;
		const registeredPrompt = this._createRegisteredPrompt(name, title, description, argsSchema, cb);
		this.setPromptRequestHandlers();
		this.sendPromptListChanged();
		return registeredPrompt;
	}
	/**
	* Checks if the server is connected to a transport.
	* @returns `true` if the server is connected
	*/
	isConnected() {
		return this.server.transport !== void 0;
	}
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
	async sendLoggingMessage(params, sessionId) {
		return this.server.sendLoggingMessage(params, sessionId);
	}
	/**
	* Sends a resource list changed event to the client, if connected.
	*/
	sendResourceListChanged() {
		if (this.isConnected()) this.server.sendResourceListChanged();
	}
	/**
	* Sends a tool list changed event to the client, if connected.
	*/
	sendToolListChanged() {
		if (this.isConnected()) this.server.sendToolListChanged();
	}
	/**
	* Sends a prompt list changed event to the client, if connected.
	*/
	sendPromptListChanged() {
		if (this.isConnected()) this.server.sendPromptListChanged();
	}
};
/**
* A resource template combines a URI pattern with optional functionality to enumerate
* all resources matching that pattern.
*/
var ResourceTemplate = class {
	_uriTemplate;
	constructor(uriTemplate, _callbacks) {
		this._callbacks = _callbacks;
		this._uriTemplate = typeof uriTemplate === "string" ? new UriTemplate(uriTemplate) : uriTemplate;
	}
	/**
	* Gets the URI template pattern.
	*/
	get uriTemplate() {
		return this._uriTemplate;
	}
	/**
	* Gets the list callback, if one was provided.
	*/
	get listCallback() {
		return this._callbacks.list;
	}
	/**
	* Gets the callback for completing a specific URI template variable, if one was provided.
	*/
	completeCallback(variable) {
		return this._callbacks.complete?.[variable];
	}
};
/**
* Creates an executor that invokes the handler with the appropriate arguments.
* When `inputSchema` is defined, the handler is called with `(args, ctx)`.
* When `inputSchema` is undefined, the handler is called with just `(ctx)`.
*/
function createToolExecutor(inputSchema, handler) {
	if ("createTask" in handler) {
		const taskHandler = handler;
		return async (args, ctx) => {
			if (!ctx.task?.store) throw new Error("No task store provided.");
			const taskCtx = {
				...ctx,
				task: {
					store: ctx.task.store,
					requestedTtl: ctx.task?.requestedTtl
				}
			};
			if (inputSchema) return taskHandler.createTask(args, taskCtx);
			return taskHandler.createTask(taskCtx);
		};
	}
	if (inputSchema) {
		const callback$1 = handler;
		return async (args, ctx) => callback$1(args, ctx);
	}
	const callback = handler;
	return async (_args, ctx) => callback(ctx);
}
const EMPTY_OBJECT_JSON_SCHEMA = {
	type: "object",
	properties: {}
};
/**
* Creates a type-safe prompt handler that captures the schema and callback in a closure.
* This eliminates the need for type assertions at the call site.
*/
function createPromptHandler(name, argsSchema, callback) {
	if (argsSchema) {
		const typedCallback = callback;
		return async (args, ctx) => {
			const parseResult = await validateStandardSchema(argsSchema, args);
			if (!parseResult.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for prompt ${name}: ${parseResult.error}`);
			return typedCallback(parseResult.data, ctx);
		};
	} else {
		const typedCallback = callback;
		return async (_args, ctx) => {
			return typedCallback(ctx);
		};
	}
}
function createCompletionResult(suggestions) {
	return { completion: {
		values: suggestions.map(String).slice(0, 100),
		total: suggestions.length,
		hasMore: suggestions.length > 100
	} };
}
const EMPTY_COMPLETION_RESULT = { completion: {
	values: [],
	hasMore: false
} };
/** @internal Gets the shape of a Zod object schema */
function getSchemaShape(schema) {
	const candidate = schema;
	if (candidate.shape && typeof candidate.shape === "object") return candidate.shape;
}
/** @internal Checks if a Zod schema is optional */
function isOptionalSchema(schema) {
	return schema?.type === "optional";
}
/** @internal Unwraps an optional Zod schema */
function unwrapOptionalSchema(schema) {
	if (!isOptionalSchema(schema)) return schema;
	return schema.def?.innerType ?? schema;
}

//#endregion
//#region src/server/middleware/hostHeaderValidation.ts
/**
* Parse and validate a `Host` header against an allowlist of hostnames (port-agnostic).
*
* - Input host header may include a port (e.g. `localhost:3000`) or IPv6 brackets (e.g. `[::1]:3000`).
* - Allowlist items should be hostnames only (no ports). For IPv6, include brackets (e.g. `[::1]`).
*/
function validateHostHeader(hostHeader, allowedHostnames) {
	if (!hostHeader) return {
		ok: false,
		errorCode: "missing_host",
		message: "Missing Host header"
	};
	let hostname;
	try {
		hostname = new URL(`http://${hostHeader}`).hostname;
	} catch {
		return {
			ok: false,
			errorCode: "invalid_host_header",
			message: `Invalid Host header: ${hostHeader}`,
			hostHeader
		};
	}
	if (!allowedHostnames.includes(hostname)) return {
		ok: false,
		errorCode: "invalid_host",
		message: `Invalid Host: ${hostname}`,
		hostHeader,
		hostname
	};
	return {
		ok: true,
		hostname
	};
}
/**
* Convenience allowlist for `localhost` DNS rebinding protection.
*/
function localhostAllowedHostnames() {
	return [
		"localhost",
		"127.0.0.1",
		"[::1]"
	];
}
/**
* Web-standard `Request` helper for DNS rebinding protection.
* @example
* ```ts source="./hostHeaderValidation.examples.ts#hostHeaderValidationResponse_basicUsage"
* const result = validateHostHeader(req.headers.get('host'), ['localhost']);
* ```
*/
function hostHeaderValidationResponse(req, allowedHostnames) {
	const result = validateHostHeader(req.headers.get("host"), allowedHostnames);
	if (result.ok) return void 0;
	return Response.json({
		jsonrpc: "2.0",
		error: {
			code: -32e3,
			message: result.message
		},
		id: null
	}, {
		status: 403,
		headers: { "Content-Type": "application/json" }
	});
}

//#endregion
//#region src/server/stdio.ts
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
var StdioServerTransport = class {
	_readBuffer = new ReadBuffer();
	_started = false;
	_closed = false;
	constructor(_stdin = process.stdin, _stdout = process.stdout) {
		this._stdin = _stdin;
		this._stdout = _stdout;
	}
	onclose;
	onerror;
	onmessage;
	_ondata = (chunk) => {
		this._readBuffer.append(chunk);
		this.processReadBuffer();
	};
	_onerror = (error) => {
		this.onerror?.(error);
	};
	_onstdouterror = (error) => {
		this.onerror?.(error);
		this.close().catch(() => {});
	};
	/**
	* Starts listening for messages on `stdin`.
	*/
	async start() {
		if (this._started) throw new Error("StdioServerTransport already started! If using Server class, note that connect() calls start() automatically.");
		this._started = true;
		this._stdin.on("data", this._ondata);
		this._stdin.on("error", this._onerror);
		this._stdout.on("error", this._onstdouterror);
	}
	processReadBuffer() {
		while (true) try {
			const message = this._readBuffer.readMessage();
			if (message === null) break;
			this.onmessage?.(message);
		} catch (error) {
			this.onerror?.(error);
		}
	}
	async close() {
		if (this._closed) return;
		this._closed = true;
		this._stdin.off("data", this._ondata);
		this._stdin.off("error", this._onerror);
		this._stdout.off("error", this._onstdouterror);
		if (this._stdin.listenerCount("data") === 0) this._stdin.pause();
		this._readBuffer.clear();
		this.onclose?.();
	}
	send(message) {
		if (this._closed) return Promise.reject(/* @__PURE__ */ new Error("StdioServerTransport is closed"));
		return new Promise((resolve, reject) => {
			const json = serializeMessage(message);
			let settled = false;
			const onError = (error) => {
				if (settled) return;
				settled = true;
				this._stdout.off("error", onError);
				this._stdout.off("drain", onDrain);
				reject(error);
			};
			const onDrain = () => {
				if (settled) return;
				settled = true;
				this._stdout.off("error", onError);
				this._stdout.off("drain", onDrain);
				resolve();
			};
			this._stdout.once("error", onError);
			if (this._stdout.write(json)) {
				if (settled) return;
				settled = true;
				this._stdout.off("error", onError);
				resolve();
			} else if (!settled) this._stdout.once("drain", onDrain);
		});
	}
};

//#endregion
//#region src/server/streamableHttp.ts
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
var WebStandardStreamableHTTPServerTransport = class {
	sessionIdGenerator;
	_started = false;
	_streamMapping = /* @__PURE__ */ new Map();
	_requestToStreamMapping = /* @__PURE__ */ new Map();
	_requestResponseMap = /* @__PURE__ */ new Map();
	_initialized = false;
	_enableJsonResponse = false;
	_standaloneSseStreamId = "_GET_stream";
	_eventStore;
	_onsessioninitialized;
	_onsessionclosed;
	_allowedHosts;
	_allowedOrigins;
	_enableDnsRebindingProtection;
	_retryInterval;
	_supportedProtocolVersions;
	sessionId;
	onclose;
	onerror;
	onmessage;
	constructor(options = {}) {
		this.sessionIdGenerator = options.sessionIdGenerator;
		this._enableJsonResponse = options.enableJsonResponse ?? false;
		this._eventStore = options.eventStore;
		this._onsessioninitialized = options.onsessioninitialized;
		this._onsessionclosed = options.onsessionclosed;
		this._allowedHosts = options.allowedHosts;
		this._allowedOrigins = options.allowedOrigins;
		this._enableDnsRebindingProtection = options.enableDnsRebindingProtection ?? false;
		this._retryInterval = options.retryInterval;
		this._supportedProtocolVersions = options.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
	}
	/**
	* Starts the transport. This is required by the {@linkcode Transport} interface but is a no-op
	* for the Streamable HTTP transport as connections are managed per-request.
	*/
	async start() {
		if (this._started) throw new Error("Transport already started");
		this._started = true;
	}
	/**
	* Sets the supported protocol versions for header validation.
	* Called by the server during {@linkcode server/server.Server.connect | connect()} to pass its supported versions.
	*/
	setSupportedProtocolVersions(versions) {
		this._supportedProtocolVersions = versions;
	}
	/**
	* Helper to create a JSON error response
	*/
	createJsonErrorResponse(status, code, message, options) {
		const error = {
			code,
			message
		};
		if (options?.data !== void 0) error.data = options.data;
		return Response.json({
			jsonrpc: "2.0",
			error,
			id: null
		}, {
			status,
			headers: {
				"Content-Type": "application/json",
				...options?.headers
			}
		});
	}
	/**
	* Validates request headers for DNS rebinding protection.
	* @returns Error response if validation fails, `undefined` if validation passes.
	*/
	validateRequestHeaders(req) {
		if (!this._enableDnsRebindingProtection) return;
		if (this._allowedHosts && this._allowedHosts.length > 0) {
			const hostHeader = req.headers.get("host");
			if (!hostHeader || !this._allowedHosts.includes(hostHeader)) {
				const error = `Invalid Host header: ${hostHeader}`;
				this.onerror?.(new Error(error));
				return this.createJsonErrorResponse(403, -32e3, error);
			}
		}
		if (this._allowedOrigins && this._allowedOrigins.length > 0) {
			const originHeader = req.headers.get("origin");
			if (originHeader && !this._allowedOrigins.includes(originHeader)) {
				const error = `Invalid Origin header: ${originHeader}`;
				this.onerror?.(new Error(error));
				return this.createJsonErrorResponse(403, -32e3, error);
			}
		}
	}
	/**
	* Handles an incoming HTTP request, whether `GET`, `POST`, or `DELETE`
	* Returns a `Response` object (Web Standard)
	*/
	async handleRequest(req, options) {
		const validationError = this.validateRequestHeaders(req);
		if (validationError) return validationError;
		switch (req.method) {
			case "POST": return this.handlePostRequest(req, options);
			case "GET": return this.handleGetRequest(req);
			case "DELETE": return this.handleDeleteRequest(req);
			default: return this.handleUnsupportedRequest();
		}
	}
	/**
	* Writes a priming event to establish resumption capability.
	* Only sends if `eventStore` is configured (opt-in for resumability) and
	* the client's protocol version supports empty SSE data (>= `2025-11-25`).
	*/
	async writePrimingEvent(controller, encoder, streamId, protocolVersion) {
		if (!this._eventStore) return;
		if (protocolVersion < "2025-11-25") return;
		const primingEventId = await this._eventStore.storeEvent(streamId, {});
		let primingEvent = `id: ${primingEventId}\ndata: \n\n`;
		if (this._retryInterval !== void 0) primingEvent = `id: ${primingEventId}\nretry: ${this._retryInterval}\ndata: \n\n`;
		controller.enqueue(encoder.encode(primingEvent));
	}
	/**
	* Handles `GET` requests for SSE stream
	*/
	async handleGetRequest(req) {
		if (!req.headers.get("accept")?.includes("text/event-stream")) {
			this.onerror?.(/* @__PURE__ */ new Error("Not Acceptable: Client must accept text/event-stream"));
			return this.createJsonErrorResponse(406, -32e3, "Not Acceptable: Client must accept text/event-stream");
		}
		const sessionError = this.validateSession(req);
		if (sessionError) return sessionError;
		const protocolError = this.validateProtocolVersion(req);
		if (protocolError) return protocolError;
		if (this._eventStore) {
			const lastEventId = req.headers.get("last-event-id");
			if (lastEventId) return this.replayEvents(lastEventId);
		}
		if (this._streamMapping.get(this._standaloneSseStreamId) !== void 0) {
			this.onerror?.(/* @__PURE__ */ new Error("Conflict: Only one SSE stream is allowed per session"));
			return this.createJsonErrorResponse(409, -32e3, "Conflict: Only one SSE stream is allowed per session");
		}
		const encoder = new TextEncoder();
		let streamController;
		const readable = new ReadableStream({
			start: (controller) => {
				streamController = controller;
			},
			cancel: () => {
				this._streamMapping.delete(this._standaloneSseStreamId);
			}
		});
		const headers = {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive"
		};
		if (this.sessionId !== void 0) headers["mcp-session-id"] = this.sessionId;
		this._streamMapping.set(this._standaloneSseStreamId, {
			controller: streamController,
			encoder,
			cleanup: () => {
				this._streamMapping.delete(this._standaloneSseStreamId);
				try {
					streamController.close();
				} catch {}
			}
		});
		return new Response(readable, { headers });
	}
	/**
	* Replays events that would have been sent after the specified event ID
	* Only used when resumability is enabled
	*/
	async replayEvents(lastEventId) {
		if (!this._eventStore) {
			this.onerror?.(/* @__PURE__ */ new Error("Event store not configured"));
			return this.createJsonErrorResponse(400, -32e3, "Event store not configured");
		}
		try {
			let streamId;
			if (this._eventStore.getStreamIdForEventId) {
				streamId = await this._eventStore.getStreamIdForEventId(lastEventId);
				if (!streamId) {
					this.onerror?.(/* @__PURE__ */ new Error("Invalid event ID format"));
					return this.createJsonErrorResponse(400, -32e3, "Invalid event ID format");
				}
				if (this._streamMapping.get(streamId) !== void 0) {
					this.onerror?.(/* @__PURE__ */ new Error("Conflict: Stream already has an active connection"));
					return this.createJsonErrorResponse(409, -32e3, "Conflict: Stream already has an active connection");
				}
			}
			const headers = {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive"
			};
			if (this.sessionId !== void 0) headers["mcp-session-id"] = this.sessionId;
			const encoder = new TextEncoder();
			let streamController;
			const readable = new ReadableStream({
				start: (controller) => {
					streamController = controller;
				},
				cancel: () => {}
			});
			const replayedStreamId = await this._eventStore.replayEventsAfter(lastEventId, { send: async (eventId, message) => {
				if (!this.writeSSEEvent(streamController, encoder, message, eventId)) try {
					streamController.close();
				} catch {}
			} });
			this._streamMapping.set(replayedStreamId, {
				controller: streamController,
				encoder,
				cleanup: () => {
					this._streamMapping.delete(replayedStreamId);
					try {
						streamController.close();
					} catch {}
				}
			});
			return new Response(readable, { headers });
		} catch (error) {
			this.onerror?.(error);
			return this.createJsonErrorResponse(500, -32e3, "Error replaying events");
		}
	}
	/**
	* Writes an event to an SSE stream via controller with proper formatting
	*/
	writeSSEEvent(controller, encoder, message, eventId) {
		try {
			let eventData = `event: message\n`;
			if (eventId) eventData += `id: ${eventId}\n`;
			eventData += `data: ${JSON.stringify(message)}\n\n`;
			controller.enqueue(encoder.encode(eventData));
			return true;
		} catch (error) {
			this.onerror?.(error);
			return false;
		}
	}
	/**
	* Handles unsupported requests (`PUT`, `PATCH`, etc.)
	*/
	handleUnsupportedRequest() {
		this.onerror?.(/* @__PURE__ */ new Error("Method not allowed."));
		return Response.json({
			jsonrpc: "2.0",
			error: {
				code: -32e3,
				message: "Method not allowed."
			},
			id: null
		}, {
			status: 405,
			headers: {
				Allow: "GET, POST, DELETE",
				"Content-Type": "application/json"
			}
		});
	}
	/**
	* Handles `POST` requests containing JSON-RPC messages
	*/
	async handlePostRequest(req, options) {
		try {
			const acceptHeader = req.headers.get("accept");
			if (!acceptHeader?.includes("application/json") || !acceptHeader.includes("text/event-stream")) {
				this.onerror?.(/* @__PURE__ */ new Error("Not Acceptable: Client must accept both application/json and text/event-stream"));
				return this.createJsonErrorResponse(406, -32e3, "Not Acceptable: Client must accept both application/json and text/event-stream");
			}
			const ct = req.headers.get("content-type");
			if (!ct || !ct.includes("application/json")) {
				this.onerror?.(/* @__PURE__ */ new Error("Unsupported Media Type: Content-Type must be application/json"));
				return this.createJsonErrorResponse(415, -32e3, "Unsupported Media Type: Content-Type must be application/json");
			}
			const requestInfo = { headers: req.headers };
			let rawMessage;
			if (options?.parsedBody === void 0) try {
				rawMessage = await req.json();
			} catch (error) {
				this.onerror?.(error);
				return this.createJsonErrorResponse(400, -32700, "Parse error: Invalid JSON");
			}
			else rawMessage = options.parsedBody;
			let messages;
			try {
				messages = Array.isArray(rawMessage) ? rawMessage.map((msg) => JSONRPCMessageSchema.parse(msg)) : [JSONRPCMessageSchema.parse(rawMessage)];
			} catch (error) {
				this.onerror?.(error);
				return this.createJsonErrorResponse(400, -32700, "Parse error: Invalid JSON-RPC message");
			}
			const isInitializationRequest = messages.some((element) => isInitializeRequest(element));
			if (isInitializationRequest) {
				if (this._initialized && this.sessionId !== void 0) {
					this.onerror?.(/* @__PURE__ */ new Error("Invalid Request: Server already initialized"));
					return this.createJsonErrorResponse(400, -32600, "Invalid Request: Server already initialized");
				}
				if (messages.length > 1) {
					this.onerror?.(/* @__PURE__ */ new Error("Invalid Request: Only one initialization request is allowed"));
					return this.createJsonErrorResponse(400, -32600, "Invalid Request: Only one initialization request is allowed");
				}
				this.sessionId = this.sessionIdGenerator?.();
				this._initialized = true;
				if (this.sessionId && this._onsessioninitialized) await Promise.resolve(this._onsessioninitialized(this.sessionId));
			}
			if (!isInitializationRequest) {
				const sessionError = this.validateSession(req);
				if (sessionError) return sessionError;
				const protocolError = this.validateProtocolVersion(req);
				if (protocolError) return protocolError;
			}
			if (!messages.some((element) => isJSONRPCRequest(element))) {
				for (const message of messages) this.onmessage?.(message, {
					authInfo: options?.authInfo,
					requestInfo
				});
				return new Response(null, { status: 202 });
			}
			const streamId = crypto.randomUUID();
			const initRequest = messages.find((m) => isInitializeRequest(m));
			const clientProtocolVersion = initRequest ? initRequest.params.protocolVersion : req.headers.get("mcp-protocol-version") ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
			if (this._enableJsonResponse) return new Promise((resolve) => {
				this._streamMapping.set(streamId, {
					resolveJson: resolve,
					cleanup: () => {
						this._streamMapping.delete(streamId);
					}
				});
				for (const message of messages) if (isJSONRPCRequest(message)) this._requestToStreamMapping.set(message.id, streamId);
				for (const message of messages) this.onmessage?.(message, {
					authInfo: options?.authInfo,
					requestInfo
				});
			});
			const encoder = new TextEncoder();
			let streamController;
			const readable = new ReadableStream({
				start: (controller) => {
					streamController = controller;
				},
				cancel: () => {
					this._streamMapping.delete(streamId);
				}
			});
			const headers = {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive"
			};
			if (this.sessionId !== void 0) headers["mcp-session-id"] = this.sessionId;
			for (const message of messages) if (isJSONRPCRequest(message)) {
				this._streamMapping.set(streamId, {
					controller: streamController,
					encoder,
					cleanup: () => {
						this._streamMapping.delete(streamId);
						try {
							streamController.close();
						} catch {}
					}
				});
				this._requestToStreamMapping.set(message.id, streamId);
			}
			await this.writePrimingEvent(streamController, encoder, streamId, clientProtocolVersion);
			for (const message of messages) {
				let closeSSEStream;
				let closeStandaloneSSEStream;
				if (isJSONRPCRequest(message) && this._eventStore && clientProtocolVersion >= "2025-11-25") {
					closeSSEStream = () => {
						this.closeSSEStream(message.id);
					};
					closeStandaloneSSEStream = () => {
						this.closeStandaloneSSEStream();
					};
				}
				this.onmessage?.(message, {
					authInfo: options?.authInfo,
					requestInfo,
					closeSSEStream,
					closeStandaloneSSEStream
				});
			}
			return new Response(readable, {
				status: 200,
				headers
			});
		} catch (error) {
			this.onerror?.(error);
			return this.createJsonErrorResponse(400, -32700, "Parse error", { data: String(error) });
		}
	}
	/**
	* Handles `DELETE` requests to terminate sessions
	*/
	async handleDeleteRequest(req) {
		const sessionError = this.validateSession(req);
		if (sessionError) return sessionError;
		const protocolError = this.validateProtocolVersion(req);
		if (protocolError) return protocolError;
		await Promise.resolve(this._onsessionclosed?.(this.sessionId));
		await this.close();
		return new Response(null, { status: 200 });
	}
	/**
	* Validates session ID for non-initialization requests.
	* Returns `Response` error if invalid, `undefined` otherwise
	*/
	validateSession(req) {
		if (this.sessionIdGenerator === void 0) return;
		if (!this._initialized) {
			this.onerror?.(/* @__PURE__ */ new Error("Bad Request: Server not initialized"));
			return this.createJsonErrorResponse(400, -32e3, "Bad Request: Server not initialized");
		}
		const sessionId = req.headers.get("mcp-session-id");
		if (!sessionId) {
			this.onerror?.(/* @__PURE__ */ new Error("Bad Request: Mcp-Session-Id header is required"));
			return this.createJsonErrorResponse(400, -32e3, "Bad Request: Mcp-Session-Id header is required");
		}
		if (sessionId !== this.sessionId) {
			this.onerror?.(/* @__PURE__ */ new Error("Session not found"));
			return this.createJsonErrorResponse(404, -32001, "Session not found");
		}
	}
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
	validateProtocolVersion(req) {
		const protocolVersion = req.headers.get("mcp-protocol-version");
		if (protocolVersion !== null && !this._supportedProtocolVersions.includes(protocolVersion)) {
			const error = `Bad Request: Unsupported protocol version: ${protocolVersion} (supported versions: ${this._supportedProtocolVersions.join(", ")})`;
			this.onerror?.(new Error(error));
			return this.createJsonErrorResponse(400, -32e3, error);
		}
	}
	async close() {
		for (const { cleanup } of this._streamMapping.values()) cleanup();
		this._streamMapping.clear();
		this._requestResponseMap.clear();
		this.onclose?.();
	}
	/**
	* Close an SSE stream for a specific request, triggering client reconnection.
	* Use this to implement polling behavior during long-running operations -
	* client will reconnect after the retry interval specified in the priming event.
	*/
	closeSSEStream(requestId) {
		const streamId = this._requestToStreamMapping.get(requestId);
		if (!streamId) return;
		const stream = this._streamMapping.get(streamId);
		if (stream) stream.cleanup();
	}
	/**
	* Close the standalone `GET` SSE stream, triggering client reconnection.
	* Use this to implement polling behavior for server-initiated notifications.
	*/
	closeStandaloneSSEStream() {
		const stream = this._streamMapping.get(this._standaloneSseStreamId);
		if (stream) stream.cleanup();
	}
	async send(message, options) {
		let requestId = options?.relatedRequestId;
		if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) requestId = message.id;
		if (requestId === void 0) {
			if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) throw new Error("Cannot send a response on a standalone SSE stream unless resuming a previous client request");
			let eventId;
			if (this._eventStore) eventId = await this._eventStore.storeEvent(this._standaloneSseStreamId, message);
			const standaloneSse = this._streamMapping.get(this._standaloneSseStreamId);
			if (standaloneSse === void 0) return;
			if (standaloneSse.controller && standaloneSse.encoder) this.writeSSEEvent(standaloneSse.controller, standaloneSse.encoder, message, eventId);
			return;
		}
		const streamId = this._requestToStreamMapping.get(requestId);
		if (!streamId) throw new Error(`No connection established for request ID: ${String(requestId)}`);
		const stream = this._streamMapping.get(streamId);
		if (!this._enableJsonResponse && stream?.controller && stream?.encoder) {
			let eventId;
			if (this._eventStore) eventId = await this._eventStore.storeEvent(streamId, message);
			this.writeSSEEvent(stream.controller, stream.encoder, message, eventId);
		}
		if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
			this._requestResponseMap.set(requestId, message);
			const relatedIds = [...this._requestToStreamMapping.entries()].filter(([_, sid]) => sid === streamId).map(([id]) => id);
			if (relatedIds.every((id) => this._requestResponseMap.has(id))) {
				if (!stream) throw new Error(`No connection established for request ID: ${String(requestId)}`);
				if (this._enableJsonResponse && stream.resolveJson) {
					const headers = { "Content-Type": "application/json" };
					if (this.sessionId !== void 0) headers["mcp-session-id"] = this.sessionId;
					const responses = relatedIds.map((id) => this._requestResponseMap.get(id));
					if (responses.length === 1) stream.resolveJson(Response.json(responses[0], {
						status: 200,
						headers
					}));
					else stream.resolveJson(Response.json(responses, {
						status: 200,
						headers
					}));
				} else stream.cleanup();
				for (const id of relatedIds) {
					this._requestResponseMap.delete(id);
					this._requestToStreamMapping.delete(id);
				}
			}
		}
	}
};

//#endregion
export { AjvJsonSchemaValidator, CfWorkerJsonSchemaValidator, DEFAULT_NEGOTIATED_PROTOCOL_VERSION, DEFAULT_REQUEST_TIMEOUT_MSEC, ExperimentalMcpServerTasks, ExperimentalServerTasks, INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, InMemoryTaskMessageQueue, InMemoryTaskStore, JSONRPC_VERSION, LATEST_PROTOCOL_VERSION, METHOD_NOT_FOUND, McpServer, OAuthError, OAuthErrorCode, PARSE_ERROR, ProtocolError, ProtocolErrorCode, RELATED_TASK_META_KEY, ReadBuffer, ResourceTemplate, SUPPORTED_PROTOCOL_VERSIONS, SdkError, SdkErrorCode, Server, StdioServerTransport, UriTemplate, UrlElicitationRequiredError, WebStandardStreamableHTTPServerTransport, assertClientRequestTaskCapability, assertCompleteRequestPrompt, assertCompleteRequestResourceTemplate, assertToolsCallTaskCapability, checkResourceAllowed, completable, createFetchWithInit, deserializeMessage, fromJsonSchema, getDisplayName, hostHeaderValidationResponse, isCompletable, isInitializeRequest, isInitializedNotification, isJSONRPCErrorResponse, isJSONRPCNotification, isJSONRPCRequest, isJSONRPCResultResponse, isTaskAugmentedRequestParams, isTerminal, localhostAllowedHostnames, parseJSONRPCMessage, resourceUrlFromServerUrl, serializeMessage, takeResult, toArrayAsync, validateHostHeader };
//# sourceMappingURL=index.mjs.map