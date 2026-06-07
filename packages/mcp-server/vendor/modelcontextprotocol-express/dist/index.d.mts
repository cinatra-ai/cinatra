import { Express, RequestHandler } from "express";

//#region src/express.d.ts

/**
 * Options for creating an MCP Express application.
 */
interface CreateMcpExpressAppOptions {
  /**
   * The hostname to bind to. Defaults to `'127.0.0.1'`.
   * When set to `'127.0.0.1'`, `'localhost'`, or `'::1'`, DNS rebinding protection is automatically enabled.
   */
  host?: string;
  /**
   * List of allowed hostnames for DNS rebinding protection.
   * If provided, host header validation will be applied using this list.
   * For IPv6, provide addresses with brackets (e.g., `'[::1]'`).
   *
   * This is useful when binding to `'0.0.0.0'` or `'::'` but still wanting
   * to restrict which hostnames are allowed.
   */
  allowedHosts?: string[];
  /**
   * Controls the maximum request body size for the JSON body parser.
   * Passed directly to Express's `express.json({ limit })` option.
   * Defaults to Express's built-in default of `'100kb'`.
   *
   * @example '1mb', '500kb', '10mb'
   */
  jsonLimit?: string;
}
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
declare function createMcpExpressApp(options?: CreateMcpExpressAppOptions): Express;
//#endregion
//#region src/middleware/hostHeaderValidation.d.ts
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
declare function hostHeaderValidation(allowedHostnames: string[]): RequestHandler;
/**
 * Convenience middleware for localhost DNS rebinding protection.
 * Allows only `localhost`, `127.0.0.1`, and `[::1]` (IPv6 localhost) hostnames.
 *
 * @example
 * ```ts source="./hostHeaderValidation.examples.ts#localhostHostValidation_basicUsage"
 * app.use(localhostHostValidation());
 * ```
 */
declare function localhostHostValidation(): RequestHandler;
//#endregion
export { CreateMcpExpressAppOptions, createMcpExpressApp, hostHeaderValidation, localhostHostValidation };
//# sourceMappingURL=index.d.mts.map