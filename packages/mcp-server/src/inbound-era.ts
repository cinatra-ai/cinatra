import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  type McpServer,
} from "@modelcontextprotocol/server";

/**
 * The inbound `/api/mcp` protocol-revision surface (cinatra#2218 L1) — the era
 * split, the two serving legs, CORS admission, and Accept normalisation.
 *
 * ## INBOUND POSTURE
 *
 * `docs/internals/contracts/mcp-supported-revisions.md`, "Inbound — /api/mcp",
 * row **A** (`legacy: 'stateless'`); recorded product ruling on cinatra#2218
 * (2026-07-29). The accepted inbound set is:
 *
 *     2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07
 *
 * i.e. the new revision PLUS all five previously-accepted revisions. No caller
 * breaks; there is no release communication to make. Row **B**
 * (`legacy: 'reject'`, modern-only) is NOT the posture — it drops the entire
 * legacy era and is a separate, owner-gated decision.
 *
 * ## HOW row A is delivered, and why it is not the literal `legacy: 'stateless'`
 *
 * The SDK's built-in stateless fallback constructs its legacy transport with
 * ONLY `sessionIdGenerator: undefined` (`createLegacyStatelessFallback` in
 * `@modelcontextprotocol/server@2.0.0`) — WITHOUT `enableJsonResponse` — so every
 * 2025-era response comes back as `text/event-stream` instead of
 * `application/json`. That is a wire-format change for every caller we have
 * today, including the in-repo Anthropic function-tools probe at
 * `src/app/configuration/mcp/llm-access/test/route.ts`, which POSTs `tools/list`
 * and calls `.json()` on the result. The option exposes no way to re-enable JSON
 * framing on that leg (`responseMode` governs the MODERN leg only).
 *
 * Row A's ACCEPTED SET is therefore delivered by the upstream-documented
 * user-land composition — `isLegacyRequest()` in front of a `legacy: 'reject'`
 * handler, which the contract doc already records as reproducing row A's
 * accepted set — with our existing JSON-framed stateless transport kept as the
 * legacy leg. Accepted set: identical to row A. Response framing for existing
 * callers: unchanged.
 */
export const MCP_INBOUND_LEGACY_POSTURE: "stateless" | "reject" = "stateless";

/**
 * CORS request-header admission.
 *
 * `Mcp-Method` / `Mcp-Name` are NOT optional gateway-routing niceties: the
 * 2026-07-28 revision REQUIRES `Mcp-Method` on every modern REQUEST, and
 * `Mcp-Name` on `tools/call` / `prompts/get` / `resources/read` when the body
 * supplies the mirrored `params.name` / `params.uri` (those three methods only;
 * notifications are exempt from both). A modern request missing a required one
 * is answered `-32020` by the SDK (`validateStandardRequestHeaders`), so
 * omitting them here would make the revision unusable from any browser-origin
 * client — the reason the revision and this admission MUST ship in one change
 * (cinatra#2218 High-1).
 */
export const MCP_CORS_ALLOW_HEADERS =
  "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name";

export const MCP_CORS_EXPOSE_HEADERS = "WWW-Authenticate, MCP-Protocol-Version";

export function appendCorsHeaders(response: Response) {
  const nextHeaders = new Headers(response.headers);
  nextHeaders.set("Access-Control-Allow-Origin", "*");
  nextHeaders.set("Access-Control-Allow-Headers", MCP_CORS_ALLOW_HEADERS);
  nextHeaders.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  nextHeaders.set("Access-Control-Expose-Headers", MCP_CORS_EXPOSE_HEADERS);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders,
  });
}

/**
 * The MCP Streamable HTTP spec requires `Accept: application/json,
 * text/event-stream`. Some clients (e.g. OpenAI's hosted relay) send only
 * `application/json`; the legacy leg answers those `406`
 * (`Not Acceptable: Client must accept both …`). Normalise so the SDK validator
 * admits them. Framing is unaffected: the legacy leg runs with
 * `enableJsonResponse`, so SSE is never used there either way.
 *
 * Avoid `new Request(request, init)` — that form tries to copy the private
 * `#state` field from `request`, which fails when Next.js's bundled undici and
 * the MCP SDK's undici are different class instances.
 */
export function normaliseAcceptHeader(request: Request) {
  const acceptHeader = request.headers.get("accept") ?? "";
  if (acceptHeader.includes("text/event-stream")) return request;
  const bodylessMethod =
    request.method === "GET" || request.method === "HEAD" || request.method === "DELETE";
  return new Request(request.url, {
    method: request.method,
    headers: new Headers({
      ...Object.fromEntries(request.headers.entries()),
      accept: acceptHeader
        ? `${acceptHeader}, text/event-stream`
        : "application/json, text/event-stream",
    }),
    // The abort signal MUST be carried across: the modern leg registers its
    // per-request teardown on `request.signal`, so dropping it here would make
    // a normalised request (i.e. every JSON-only-Accept caller) blind to client
    // aborts and leave its exchange running after the client is gone.
    signal: request.signal,
    // Body must be omitted for bodyless methods to avoid "duplex" errors.
    ...(bodylessMethod ? {} : { body: request.body, duplex: "half" }),
  } as RequestInit & { duplex?: "half" });
}

/**
 * The 2025-era (legacy) serving leg — the established stateless idiom, kept on
 * `application/json` framing (see {@link MCP_INBOUND_LEGACY_POSTURE}).
 *
 * `GET` and `DELETE` are 2025 SESSION operations. Stateless serving has no
 * session, so both are answered `405` / `Method not allowed.` — exactly what
 * row A of the contract doc specifies and what the SDK's own
 * `createLegacyStatelessFallback` answers.
 *
 * This also closes a live defect: handed a `GET`, the stateless transport opens
 * a STANDALONE SSE STREAM (`200 text/event-stream`) that stays open for the life
 * of the request, and the transport handler's response-logging step buffered any
 * non-JSON body with `.text()` — so a `GET /api/mcp` never resolved. It cannot
 * have had a working caller.
 */
export function serveLegacyEra(
  transport: WebStandardStreamableHTTPServerTransport,
  request: Request,
  parsedBody: unknown,
) {
  if (request.method.toUpperCase() !== "POST") {
    return Promise.resolve(
      Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        { status: 405 },
      ),
    );
  }
  return transport.handleRequest(request, { parsedBody });
}

/**
 * Build the modern (2026-07-28) leg over the SAME per-request runtime server the
 * legacy leg serves, so the two eras can never advertise a different tool
 * surface. `legacy: 'reject'` is never reached under row A: {@link resolveInboundEra}
 * routes every legacy-classified request to the legacy leg first.
 */
export function createModernEraHandler(
  server: InstanceType<typeof McpServer>,
  onerror?: (error: Error) => void,
) {
  return createMcpHandler(() => server, {
    legacy: "reject",
    ...(onerror ? { onerror } : {}),
  });
}

/**
 * Which leg serves this request.
 *
 * `isLegacyRequest` is the SDK entry's OWN classification step exported as a
 * predicate, so this split runs exactly the code `createMcpHandler` runs — the
 * two can only ever agree or (below) refuse to answer. Note what is NOT legacy:
 *
 * - an envelope-less modern `MCP-Protocol-Version` header (answered `-32602`);
 * - a header/body revision mismatch (answered `-32020`);
 * - a claim-less modern-header NOTIFICATION, which the modern leg accepts with
 *   `202` and drops without requiring `_meta` or `Mcp-Method`.
 *
 * The modern path owns all of those answers, so they must never be routed to the
 * legacy leg.
 *
 * **Never fail to an era.** When the classifier itself cannot decide (it rejects
 * only when the request body cannot be read at all) the outcome is
 * `"unclassifiable"` and the caller answers a parse error. Downgrading a
 * classification failure to `"legacy"` would silently serve a request through the
 * 2025-era codec that the SDK might have routed to the modern path — a
 * conformance downgrade decided by an I/O error.
 *
 * Under row B (`MCP_INBOUND_LEGACY_POSTURE === "reject"`) everything goes modern
 * and legacy-classified traffic is answered with the unsupported-protocol-version
 * error naming 2026-07-28 as the only supported revision.
 */
export async function resolveInboundEra(
  request: Request,
  parsedBody: unknown,
): Promise<"legacy" | "modern" | "unclassifiable"> {
  if (MCP_INBOUND_LEGACY_POSTURE === "reject") return "modern";
  try {
    return (await isLegacyRequest(request, parsedBody)) ? "legacy" : "modern";
  } catch {
    return "unclassifiable";
  }
}

/**
 * The answer for a request whose era could not be classified because its body
 * was unreadable. A parse error is the honest JSON-RPC answer; serving it
 * through either era would be a guess.
 */
export function unclassifiableEraResponse() {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: "Parse error: the request body could not be read for protocol-era classification.",
      },
      id: null,
    },
    { status: 400 },
  );
}

/**
 * Re-wrap a streaming response so `onSettled` fires when the body drains (or
 * errors, or is cancelled), exactly once. Used to defer the modern handler's
 * teardown past an SSE upgrade — closing it while a stream is open would abort
 * the in-flight exchange and truncate the response. Mirrors the SDK's own
 * per-request teardown shape.
 */
export function monitorResponseBodyUntilSettled(response: Response, onSettled: () => void) {
  if (response.body === null) {
    onSettled();
    return response;
  }
  const reader = response.body.getReader();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    onSettled();
  };
  const monitored = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle();
          controller.close();
          return;
        }
        if (value !== undefined) controller.enqueue(value);
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    cancel(reason) {
      settle();
      return reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Close the modern handler once its exchange has actually settled and produce a
 * response safe to log: a `text/event-stream` body must NEVER be buffered
 * (an SSE stream may stay open for the life of the request, so `.text()` would
 * never resolve).
 */
export async function settleEraResponse(
  response: Response,
  modernHandler: { close: () => Promise<void> },
) {
  const contentType = response.headers.get("content-type");
  const isEventStream = !!contentType?.includes("text/event-stream");
  if (!isEventStream) {
    await modernHandler.close().catch(() => undefined);
    return {
      response,
      capturedBody: contentType?.includes("application/json")
        ? await response.clone().json().catch(() => null)
        : await response.clone().text().catch(() => null),
    };
  }
  return {
    response: monitorResponseBodyUntilSettled(response, () => {
      void modernHandler.close().catch(() => undefined);
    }),
    capturedBody: "[text/event-stream — body not captured]",
  };
}

/**
 * Settle the exchange and record it: tear the modern handler down at the right
 * moment, capture a LOG-SAFE view of the body, and return the response to serve.
 *
 * Response logging can never strand the exchange — `settleEraResponse` already
 * owns the teardown, so a logging failure is reported and swallowed rather than
 * being allowed to prevent the response from reaching the client (which would
 * leave an SSE stream and its handler unsettled).
 *
 * `writeLog` is injected so this module stays free of app-graph imports.
 */
export async function finishEraResponse(input: {
  request: Request;
  era: "legacy" | "modern";
  response: Response;
  modernHandler: { close: () => Promise<void> };
  writeLog: (entry: Record<string, unknown>) => Promise<void>;
}) {
  const settled = await settleEraResponse(input.response, input.modernHandler);
  try {
    await input.writeLog({
      method: input.request.method,
      url: input.request.url,
      status: input.response.status,
      era: input.era,
      headers: Object.fromEntries(input.response.headers.entries()),
      body: settled.capturedBody,
    });
  } catch (error) {
    console.warn("[mcp] response logging failed (response still served):", error);
  }
  return settled.response;
}
