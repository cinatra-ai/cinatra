import { getRequestListener } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

//#region src/streamableHttp.ts
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
var NodeStreamableHTTPServerTransport = class {
	_webStandardTransport;
	_requestListener;
	_requestContext = /* @__PURE__ */ new WeakMap();
	constructor(options = {}) {
		this._webStandardTransport = new WebStandardStreamableHTTPServerTransport(options);
		this._requestListener = getRequestListener(async (webRequest) => {
			const context = this._requestContext.get(webRequest);
			return this._webStandardTransport.handleRequest(webRequest, {
				authInfo: context?.authInfo,
				parsedBody: context?.parsedBody
			});
		}, { overrideGlobalObjects: false });
	}
	/**
	* Gets the session ID for this transport instance.
	*/
	get sessionId() {
		return this._webStandardTransport.sessionId;
	}
	/**
	* Sets callback for when the transport is closed.
	*/
	set onclose(handler) {
		this._webStandardTransport.onclose = handler;
	}
	get onclose() {
		return this._webStandardTransport.onclose;
	}
	/**
	* Sets callback for transport errors.
	*/
	set onerror(handler) {
		this._webStandardTransport.onerror = handler;
	}
	get onerror() {
		return this._webStandardTransport.onerror;
	}
	/**
	* Sets callback for incoming messages.
	*/
	set onmessage(handler) {
		this._webStandardTransport.onmessage = handler;
	}
	get onmessage() {
		return this._webStandardTransport.onmessage;
	}
	/**
	* Starts the transport. This is required by the {@linkcode Transport} interface but is a no-op
	* for the Streamable HTTP transport as connections are managed per-request.
	*/
	async start() {
		return this._webStandardTransport.start();
	}
	/**
	* Closes the transport and all active connections.
	*/
	async close() {
		return this._webStandardTransport.close();
	}
	/**
	* Sends a JSON-RPC message through the transport.
	*/
	async send(message, options) {
		return this._webStandardTransport.send(message, options);
	}
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
	async handleRequest(req, res, parsedBody) {
		const authInfo = req.auth;
		await getRequestListener(async (webRequest) => {
			return this._webStandardTransport.handleRequest(webRequest, {
				authInfo,
				parsedBody
			});
		}, { overrideGlobalObjects: false })(req, res);
	}
	/**
	* Close an SSE stream for a specific request, triggering client reconnection.
	* Use this to implement polling behavior during long-running operations -
	* client will reconnect after the retry interval specified in the priming event.
	*/
	closeSSEStream(requestId) {
		this._webStandardTransport.closeSSEStream(requestId);
	}
	/**
	* Close the standalone GET SSE stream, triggering client reconnection.
	* Use this to implement polling behavior for server-initiated notifications.
	*/
	closeStandaloneSSEStream() {
		this._webStandardTransport.closeStandaloneSSEStream();
	}
};

//#endregion
export { NodeStreamableHTTPServerTransport };
//# sourceMappingURL=index.mjs.map