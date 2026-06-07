import express from "express";
import { localhostAllowedHostnames, validateHostHeader } from "@modelcontextprotocol/server";

//#region src/middleware/hostHeaderValidation.ts
/**
* Express middleware for DNS rebinding protection.
* Validates `Host` header hostname (port-agnostic) against an allowed list.
*
* This is particularly important for servers without authorization or HTTPS,
* such as localhost servers or development servers. DNS rebinding attacks can
* bypass same-origin policy by manipulating DNS to point a domain to a
* localhost address, allowing malicious websites to access your local server.
*
* @param allowedHostnames - List of allowed hostnames (without ports).
*   For IPv6, provide the address with brackets (e.g., `[::1]`).
* @returns Express middleware function
*
* @example
* ```ts source="./hostHeaderValidation.examples.ts#hostHeaderValidation_basicUsage"
* const middleware = hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']);
* app.use(middleware);
* ```
*/
function hostHeaderValidation(allowedHostnames) {
	return (req, res, next) => {
		const result = validateHostHeader(req.headers.host, allowedHostnames);
		if (!result.ok) {
			res.status(403).json({
				jsonrpc: "2.0",
				error: {
					code: -32e3,
					message: result.message
				},
				id: null
			});
			return;
		}
		next();
	};
}
/**
* Convenience middleware for localhost DNS rebinding protection.
* Allows only `localhost`, `127.0.0.1`, and `[::1]` (IPv6 localhost) hostnames.
*
* @example
* ```ts source="./hostHeaderValidation.examples.ts#localhostHostValidation_basicUsage"
* app.use(localhostHostValidation());
* ```
*/
function localhostHostValidation() {
	return hostHeaderValidation(localhostAllowedHostnames());
}

//#endregion
//#region src/express.ts
/**
* Creates an Express application pre-configured for MCP servers.
*
* When the host is `'127.0.0.1'`, `'localhost'`, or `'::1'` (the default is `'127.0.0.1'`),
* DNS rebinding protection middleware is automatically applied to protect against
* DNS rebinding attacks on localhost servers.
*
* @param options - Configuration options
* @returns A configured Express application
*
* @example Basic usage - defaults to 127.0.0.1 with DNS rebinding protection
* ```ts source="./express.examples.ts#createMcpExpressApp_default"
* const app = createMcpExpressApp();
* ```
*
* @example Custom host - DNS rebinding protection only applied for localhost hosts
* ```ts source="./express.examples.ts#createMcpExpressApp_customHost"
* const appOpen = createMcpExpressApp({ host: '0.0.0.0' }); // No automatic DNS rebinding protection
* const appLocal = createMcpExpressApp({ host: 'localhost' }); // DNS rebinding protection enabled
* ```
*
* @example Custom allowed hosts for non-localhost binding
* ```ts source="./express.examples.ts#createMcpExpressApp_allowedHosts"
* const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local', 'localhost'] });
* ```
*/
function createMcpExpressApp(options = {}) {
	const { host = "127.0.0.1", allowedHosts, jsonLimit } = options;
	const app = express();
	app.use(express.json(jsonLimit ? { limit: jsonLimit } : void 0));
	if (allowedHosts) app.use(hostHeaderValidation(allowedHosts));
	else if ([
		"127.0.0.1",
		"localhost",
		"::1"
	].includes(host)) app.use(localhostHostValidation());
	else if (host === "0.0.0.0" || host === "::") console.warn(`Warning: Server is binding to ${host} without DNS rebinding protection. Consider using the allowedHosts option to restrict allowed hosts, or use authentication to protect your server.`);
	return app;
}

//#endregion
export { createMcpExpressApp, hostHeaderValidation, localhostHostValidation };
//# sourceMappingURL=index.mjs.map