import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  callConnectorInstanceMcpTool,
  classifyTransportError,
  CONNECTOR_INSTANCE_VERSION_NEGOTIATION,
  InvokerError,
  listConnectorInstanceMcpTools,
  type ConnectorInstanceMcpListClient,
} from "@/lib/connector-instance-mcp-transport";

// cinatra#2017 S2 slice K5 — transport unwrap + typed absent-stack errors (§1.3).

// cinatra#2218 L2d — the transport now runs `@modelcontextprotocol/client@2.0.0`
// and `classifyTransportError` is an ALLOWLIST that fails CLOSED. The two codes
// that relax the invoker's server-health state (`network_error` / `timeout` ->
// `unreachable`) require POSITIVE PROOF; every unproven shape becomes
// `transport_error` -> `catalog_unavailable`.

/** The global-registry brand the default factory's `fetch` wrapper stamps on a
 * rejection proven to precede any HTTP response. Re-derived here through
 * `Symbol.for` — the same registry entry the module uses — so these tests can
 * construct the ONLY evidence the classifier accepts for `network_error`. */
const CONNECT_FAILURE_BRAND = Symbol.for("cinatra.connector-instance-mcp.connect-failure");

/** An error shaped like one the default factory's branded `fetch` would produce
 * for a peer that was never reached. */
function brandedConnectFailure(message = "fetch failed"): Error {
  const err = new TypeError(message);
  Object.defineProperty(err, CONNECT_FAILURE_BRAND, { value: true, enumerable: false, configurable: true });
  return err;
}

/** An error shaped like the `{ mode: 'auto' }` negotiator's wrapper around a
 * pre-response probe failure: the original rejection survives on `.data.cause`. */
function negotiatorWrapped(inner: unknown): SdkError {
  return new SdkError(SdkErrorCode.EraNegotiationFailed, "Version negotiation probe failed", { cause: inner });
}

/** An error shaped like the v2 transport's non-OK HTTP rejection: the raw body
 * rides `.data.text`, the status rides `.status`. */
function sdkHttp(status: number, body: string): SdkHttpError {
  return new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${body}`, {
    status,
    statusText: "",
    text: body,
  });
}

/** The exact frame the pinned WordPress mcp-adapter 0.5.0 answers a session-less
 * `tools/list` with — copied from the committed CI capture
 * `tests/e2e/wp-mcp-gateway/captures/annotations-a-raw-tools-list.json`. */
const WP_MISSING_SESSION_BODY =
  '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid Request: Missing Mcp-Session-Id header"}}';

function fakeClient(behavior: {
  connectError?: unknown;
  callResult?: unknown;
  callError?: unknown;
  listResult?: unknown;
  listError?: unknown;
}): { factory: () => ConnectorInstanceMcpListClient; closed: () => boolean } {
  let closed = false;
  // The list-capable surface satisfies BOTH transport entry points (it extends
  // the call-only `ConnectorInstanceMcpClient`).
  const factory = (): ConnectorInstanceMcpListClient => ({
    connect: async () => {
      if (behavior.connectError) throw behavior.connectError;
    },
    callTool: async () => {
      if (behavior.callError) throw behavior.callError;
      return behavior.callResult;
    },
    listTools: async () => {
      if (behavior.listError) throw behavior.listError;
      return behavior.listResult;
    },
    close: async () => {
      closed = true;
    },
  });
  return { factory, closed: () => closed };
}

async function call(behavior: Parameters<typeof fakeClient>[0]) {
  const { factory } = fakeClient(behavior);
  return callConnectorInstanceMcpTool({
    endpoint: "https://site/x",
    authHeader: "Basic secret-never-in-errors",
    name: "mcp-adapter-execute-ability",
    arguments: { ability_name: "core/get-site-info", parameters: {} },
    clientFactory: factory,
  });
}

describe("callConnectorInstanceMcpTool — unwrap", () => {
  it("prefers structuredContent (object)", async () => {
    await expect(call({ callResult: { structuredContent: { success: true, data: { a: 1 } } } })).resolves.toEqual({
      success: true,
      data: { a: 1 },
    });
  });
  it("falls back to the first text content parsed as JSON", async () => {
    await expect(
      call({ callResult: { content: [{ type: "text", text: '{"ok":true}' }] } }),
    ).resolves.toEqual({ ok: true });
  });
  it("empty response → empty_response", async () => {
    await expect(call({ callResult: { content: [] } })).rejects.toMatchObject({ code: "empty_response" });
  });
  it("non-JSON text → invalid_response", async () => {
    await expect(call({ callResult: { content: [{ type: "text", text: "not json" }] } })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("callConnectorInstanceMcpTool — tool error (WP_Error passthrough)", () => {
  it("isError result → tool_error with code + message", async () => {
    await expect(
      call({ callResult: { isError: true, structuredContent: { error: { code: "rest_forbidden", message: "no" } } } }),
    ).rejects.toMatchObject({ code: "tool_error", wpErrorCode: "rest_forbidden", message: "no" });
  });

  // codex round-1 finding 5 — `tool_error` is the ONE code whose message is
  // peer-authored, so it is the one path that could carry the credential back
  // into cinatra's logs and UI. The peer already holds it; the module header
  // promises it never appears in error text.
  it("REDACTS the credential a peer echoes back in its tool-error text", async () => {
    const echoed = "auth failed for Basic secret-never-in-errors (token secret-never-in-errors)";
    try {
      await call({ callResult: { isError: true, structuredContent: { error: { message: echoed } } } });
      throw new Error("expected a tool_error");
    } catch (e) {
      const err = e as InvokerError;
      expect(err.code).toBe("tool_error");
      expect(err.message).not.toContain("secret-never-in-errors");
      expect(err.message).toContain("[redacted]");
    }
  });

  // codex round-2 finding 3 — the non-JSON fallback truncates to 500 chars.
  // Redacting AFTER that slice would emit the surviving prefix of a credential
  // straddling the boundary. Redaction must happen first.
  it("REDACTS before the 500-char truncation, so a straddling credential cannot survive", async () => {
    // The bare token of the `call()` helper's own auth header.
    const secret = "secret-never-in-errors";
    // Place it so it spans the 500-char cut: redacting AFTER the slice would
    // emit the surviving prefix.
    const padded = "x".repeat(490) + secret + "y".repeat(200);
    try {
      await call({ callResult: { isError: true, content: [{ type: "text", text: padded }] } });
      throw new Error("expected a tool_error");
    } catch (e) {
      const message = (e as InvokerError).message;
      expect(message).not.toContain(secret);
      // No PREFIX of it survives either — this is what fails if the order flips.
      for (let n = 6; n <= secret.length; n++) {
        expect(message).not.toContain(secret.slice(0, n));
      }
      expect(message).toContain("[redacted]");
    }
  });

  // codex round-3 blocker, reproduced live by codex against the real module:
  // production sends `Basic base64(username:applicationPassword)` and the peer
  // MUST decode it to authenticate, so it can echo back the DECODED pair or the
  // bare password. Redacting only the header and its Base64 token missed both.
  it("REDACTS the DECODED Basic payload — the pair and the bare password", async () => {
    const username = "admin";
    const password = "app-password-secret";
    const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    const authHeader = `Basic ${token}`;

    let caught: InvokerError | undefined;
    try {
      await callConnectorInstanceMcpTool({
        endpoint: "https://site/x",
        authHeader,
        name: "mcp-adapter-execute-ability",
        arguments: {},
        clientFactory: () => ({
          connect: async () => {},
          callTool: async () => ({
            isError: true,
            structuredContent: {
              error: {
                code: `bad_${password}`,
                message: `user ${username} rejected: pair ${username}:${password}, header ${authHeader}`,
              },
            },
          }),
          listTools: async () => ({ tools: [] }),
          close: async () => {},
        }),
      });
    } catch (e) {
      caught = e as InvokerError;
    }

    expect(caught?.code).toBe("tool_error");
    const serialised = `${caught?.message}|${caught?.wpErrorCode ?? ""}`;
    expect(serialised).not.toContain(password);
    expect(serialised).not.toContain(`${username}:${password}`);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain(authHeader);
    // A STANDALONE username survives: it is an identifier, not a secret, and
    // scrubbing it would shred ordinary error prose. (Inside the pair it goes,
    // because the pair itself is the secret.)
    expect(serialised).toContain(`user ${username} rejected`);
  });

  it("a NON-Base64 token does not produce junk redaction terms", async () => {
    // `Buffer.from(x, "base64")` never throws — it silently drops invalid
    // characters — so the decode is only trusted when it round-trips. Without
    // that guard a non-Base64 token would add a mojibake redaction term and
    // could shred unrelated text.
    let caught: InvokerError | undefined;
    try {
      await callConnectorInstanceMcpTool({
        endpoint: "https://site/x",
        authHeader: "Basic not~valid~base64~!!",
        name: "x",
        arguments: {},
        clientFactory: () => ({
          connect: async () => {},
          callTool: async () => ({
            isError: true,
            structuredContent: { error: { message: "a clean message about the admin user" } },
          }),
          listTools: async () => ({ tools: [] }),
          close: async () => {},
        }),
      });
    } catch (e) {
      caught = e as InvokerError;
    }
    expect(caught?.message).toBe("a clean message about the admin user");
  });

  it("REDACTS it from the wpErrorCode passthrough too", async () => {
    try {
      await call({
        callResult: { isError: true, structuredContent: { error: { code: "bad_secret-never-in-errors" } } },
      });
      throw new Error("expected a tool_error");
    } catch (e) {
      expect((e as InvokerError).wpErrorCode).not.toContain("secret-never-in-errors");
    }
  });
});

describe("callConnectorInstanceMcpTool — absent-stack typed errors (§1.3)", () => {
  it("400 no-session (Missing Mcp-Session-Id) → session_required, distinct from network", async () => {
    await expect(
      call({ connectError: new Error("HTTP 400: Missing Mcp-Session-Id header (-32600)") }),
    ).rejects.toMatchObject({ code: "session_required", httpStatus: 400 });
  });
  it("AbortError → timeout", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    await expect(call({ connectError: err })).rejects.toMatchObject({ code: "timeout" });
  });
  it("a BRANDED pre-response connect failure → network_error", async () => {
    await expect(call({ connectError: brandedConnectFailure() })).rejects.toMatchObject({ code: "network_error" });
  });
  it("the same failure wrapped by the `auto` negotiator still → network_error (brand survives on .data.cause)", async () => {
    await expect(
      call({ connectError: negotiatorWrapped(brandedConnectFailure()) }),
    ).rejects.toMatchObject({ code: "network_error" });
  });
  it("an UNBRANDED connection-shaped error → transport_error, NOT network_error (fail CLOSED)", async () => {
    // Nothing proves the peer was never reached, so the classifier must not
    // report the relaxed `unreachable` health state.
    await expect(call({ connectError: new Error("ECONNREFUSED") })).rejects.toMatchObject({
      code: "transport_error",
    });
  });
  it("never leaks the auth header in the error message", async () => {
    try {
      await call({ connectError: new Error("boom Basic secret-never-in-errors") });
    } catch (e) {
      // The classifier composes its OWN message; it does not echo the raw error.
      expect((e as InvokerError).message).not.toContain("secret-never-in-errors");
    }
  });
});

describe("classifyTransportError", () => {
  it("maps the absent-stack classes", () => {
    expect(classifyTransportError(new Error("Mcp-Session-Id missing")).code).toBe("session_required");
    expect(classifyTransportError(Object.assign(new Error("x"), { name: "AbortError" })).code).toBe("timeout");
    expect(classifyTransportError(brandedConnectFailure("socket hang up")).code).toBe("network_error");
  });
});

// --- cinatra#2218 L2d: the v2 structural signals + the fail-CLOSED allowlist ---

describe("classifyTransportError — STRUCTURAL session split on client@2.0.0 shapes", () => {
  it("the real WP adapter frame (HTTP 400, JSON-RPC -32600) → session_required, read off .data.text", () => {
    const err = classifyTransportError(sdkHttp(400, WP_MISSING_SESSION_BODY));
    expect(err.code).toBe("session_required");
    expect(err.httpStatus).toBe(400);
  });
  it("HTTP 404 with a JSON-RPC -32005 body → session_not_found", () => {
    const err = classifyTransportError(
      sdkHttp(404, '{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"Session not found"}}'),
    );
    expect(err.code).toBe("session_not_found");
    expect(err.httpStatus).toBe(404);
  });
  it("a BARE 404 with no -32005 is NOT a session signal — it must not buy a retry", () => {
    // A mistyped endpoint answers 404 too. Classifying it `session_not_found`
    // would spend a retry and mislabel the failure.
    const err = classifyTransportError(sdkHttp(404, "<html>Not Found</html>"));
    expect(err.code).toBe("transport_error");
    expect(err.httpStatus).toBe(404);
  });
});

describe("classifyTransportError — fail CLOSED (allowlist)", () => {
  it("an answering peer's HTTP 500 → transport_error, never network_error", () => {
    expect(classifyTransportError(sdkHttp(500, "upstream boom")).code).toBe("transport_error");
  });

  it("an auth wall carries httpStatus so the health mapper can reach auth_error", () => {
    // Pre-migration this was `network_error` with NO httpStatus, so
    // `mapCatalogLoadErrorToServerHealth`'s 401/403 branch could never fire and
    // an auth failure reported the peer as `unreachable`.
    for (const status of [401, 403]) {
      const err = classifyTransportError(sdkHttp(status, "denied"));
      expect(err.code).toBe("transport_error");
      expect(err.httpStatus).toBe(status);
    }
  });

  it("a PEER-SUPPLIED 'timed out' body cannot forge the relaxing `timeout` code", () => {
    // The deleted text tail (`msg.includes("timeout")`) read a string the peer
    // controls. The peer demonstrably answered, so `timeout` is unreachable.
    const err = classifyTransportError(sdkHttp(504, "Gateway timed out"));
    expect(err.code).toBe("transport_error");
    expect(err.code).not.toBe("timeout");
  });

  it("`timeout` is proven from the SDK code, not from text", () => {
    expect(classifyTransportError(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out")).code).toBe(
      "timeout",
    );
  });

  it("a local SDK failure with no unreachability proof → transport_error", () => {
    expect(classifyTransportError(new SdkError(SdkErrorCode.InvalidResult, "bad result")).code).toBe(
      "transport_error",
    );
    expect(classifyTransportError(new SyntaxError("Unexpected token < in JSON")).code).toBe("transport_error");
  });

  it("a non-Error rejection value → transport_error (never the relaxed state)", () => {
    expect(classifyTransportError(undefined).code).toBe("transport_error");
    expect(classifyTransportError("boom").code).toBe("transport_error");
  });
});

describe("versionNegotiation — the bare-string trap", () => {
  it("is an OPTIONS OBJECT with mode 'auto', never a bare string", () => {
    expect(CONNECTOR_INSTANCE_VERSION_NEGOTIATION).toEqual({ mode: "auto" });
    expect(typeof CONNECTOR_INSTANCE_VERSION_NEGOTIATION).not.toBe("string");
    expect(CONNECTOR_INSTANCE_VERSION_NEGOTIATION.mode).toBe("auto");
    expect(CONNECTOR_INSTANCE_VERSION_NEGOTIATION.mode).not.toBe("legacy");
  });
});

// cinatra — bounded session-retry (owner-ruled, PR #2255 diagnosis): the
// pinned WordPress mcp-adapter plugin's SessionManager races concurrent
// session creations (unprotected read-modify-write), silently dropping a
// just-established session. The next call against it gets a clean JSON-RPC
// -32005 "session not found", surfaced by the SDK as an HTTP 404. This is
// its OWN classification (`session_not_found`, distinct from `session_required`
// — "never had a session" vs "had one, it got dropped"), and triggers exactly
// ONE transport-level retry against a freshly re-established session.

describe("classifyTransportError — session_not_found (§ retry)", () => {
  it("the v2 dropped-session frame (404 + JSON-RPC -32005) → session_not_found", () => {
    expect(
      classifyTransportError(
        sdkHttp(404, '{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"Session not found"}}'),
      ).code,
    ).toBe("session_not_found");
  });
  it("carries httpStatus 404, matching the WP mcp-adapter's mapping", () => {
    expect(
      classifyTransportError(
        sdkHttp(404, '{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"Session not found"}}'),
      ).httpStatus,
    ).toBe(404);
  });
  it("stays distinct from session_required (400 no-session, never had one)", () => {
    expect(classifyTransportError(new Error("HTTP 400: Missing Mcp-Session-Id header (-32600)")).code).toBe(
      "session_required",
    );
  });

  // codex rounds 1-2 — retry eligibility requires the adapter's FULL documented
  // contract (404 AND -32005), because a replayed `tools/call` can re-execute a
  // MUTATING ability. Each row below is a near-miss that must NOT earn a replay.
  it.each([
    ["a 500 whose body merely says 'session not found'", sdkHttp(500, "upstream error: session not found")],
    [
      "a 500 CARRYING -32005 (no dropped 2025-era session to re-establish)",
      sdkHttp(500, '{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"Session not found"}}'),
    ],
    ["a 404 with the phrase but NO -32005 code", sdkHttp(404, "session not found")],
    ["a bare 404 with neither", sdkHttp(404, "<html>Not Found</html>")],
    ["free text with no HTTP status at all", new Error("MCP error -32005: Session not found")],
    [
      "a ProtocolError carrying -32005 (modern/stateless era — no session exists)",
      new ProtocolError(-32005, "Session not found"),
    ],
  ])("does NOT earn a replay: %s", (_label, err) => {
    expect(classifyTransportError(err).code).not.toBe("session_not_found");
  });

  it("the near-misses land on non-relaxing codes, never on unreachable-eligible ones", () => {
    for (const err of [
      sdkHttp(500, "upstream error: session not found"),
      sdkHttp(404, "session not found"),
      new ProtocolError(-32005, "Session not found"),
    ]) {
      const code = classifyTransportError(err).code;
      expect(["network_error", "timeout"]).not.toContain(code);
    }
  });
});

// --- codex round-1 blocker 1: the peer-answered latch closes the allowlist ---

describe("classifyTransportError — a peer that ANSWERED can never reach the relaxed codes", () => {
  const timeout = new SdkError(SdkErrorCode.RequestTimeout, "Request timed out");

  it("a request timeout AFTER the peer answered is transport_error, not timeout", () => {
    // The handshake completed, then `tools/call` timed out. The peer is
    // reachable and hung — `unreachable` would be a lie, and it is the relaxed
    // state.
    expect(classifyTransportError(timeout, { peerAnswered: true }).code).toBe("transport_error");
  });

  it("the same timeout with NOTHING answered is still a genuine timeout", () => {
    expect(classifyTransportError(timeout, { peerAnswered: false }).code).toBe("timeout");
    expect(classifyTransportError(timeout).code).toBe("timeout");
  });

  it("a branded connect failure is ignored once the peer has answered", () => {
    expect(classifyTransportError(brandedConnectFailure(), { peerAnswered: true }).code).toBe("transport_error");
    expect(classifyTransportError(brandedConnectFailure(), { peerAnswered: false }).code).toBe("network_error");
  });
});

// --- codex round-1 finding 3: the brand cannot be inherited or trap-forged ---

describe("classifyTransportError — totality (codex round-2 finding 4)", () => {
  it("an error with a THROWING message getter still yields a typed InvokerError", () => {
    const err = new Error("x");
    Object.defineProperty(err, "message", {
      get() {
        throw new Error("nope");
      },
      configurable: true,
    });
    const out = classifyTransportError(err);
    expect(out).toBeInstanceOf(InvokerError);
    expect(out.code).toBe("transport_error");
  });

  it("an exotic Proxy rejection still yields a typed InvokerError", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("nope");
        },
        has() {
          throw new Error("nope");
        },
        getOwnPropertyDescriptor() {
          throw new Error("nope");
        },
      },
    );
    const out = classifyTransportError(hostile);
    expect(out).toBeInstanceOf(InvokerError);
    expect(out.code).toBe("transport_error");
  });
});

describe("classifyTransportError — brand hardening", () => {
  it("a brand on Object.prototype does NOT make every rejection look unreachable", () => {
    const brand = Symbol.for("cinatra.connector-instance-mcp.connect-failure");
    (Object.prototype as Record<PropertyKey, unknown>)[brand] = true;
    try {
      // Inherited, not own -> must not be accepted as proof.
      expect(classifyTransportError(new Error("boom")).code).toBe("transport_error");
    } finally {
      delete (Object.prototype as Record<PropertyKey, unknown>)[brand];
    }
  });

  it("a throwing getter on `cause` does not escape the classifier", () => {
    const err = new Error("boom");
    Object.defineProperty(err, "cause", {
      get() {
        throw new Error("nope");
      },
      configurable: true,
    });
    expect(() => classifyTransportError(err)).not.toThrow();
    expect(classifyTransportError(err).code).toBe("transport_error");
  });

  it("a self-referential cause chain terminates", () => {
    const err = new Error("boom") as Error & { cause?: unknown };
    err.cause = err;
    expect(classifyTransportError(err).code).toBe("transport_error");
  });
});

/** A SEQUENCED fake client/factory for retry tests: the bounded retry spins up
 * a brand-new client per attempt (`factory()` called again), so this queues
 * one behavior per attempt (the LAST entry repeats if more attempts happen
 * than entries) and tracks how many attempts/closes actually occurred — a
 * test can assert the retry closed the dead client and minted exactly one
 * fresh one, never looping past the bound. */
function sequencedClient(
  behaviors: Array<{ connectError?: unknown; error?: unknown; result?: unknown }>,
): { factory: () => ConnectorInstanceMcpListClient; attempts: () => number; closedCount: () => number } {
  let attempt = -1;
  let closedCount = 0;
  const factory = (): ConnectorInstanceMcpListClient => {
    attempt += 1;
    const behavior = behaviors[Math.min(attempt, behaviors.length - 1)];
    return {
      connect: async () => {
        if (behavior.connectError) throw behavior.connectError;
      },
      callTool: async () => {
        if (behavior.error) throw behavior.error;
        return behavior.result;
      },
      listTools: async () => {
        if (behavior.error) throw behavior.error;
        return behavior.result;
      },
      close: async () => {
        closedCount += 1;
      },
    };
  };
  return { factory, attempts: () => attempt + 1, closedCount: () => closedCount };
}

/** The pinned WP adapter's dropped-session frame as `client@2.0.0` raises it:
 * HTTP 404 whose body carries JSON-RPC `-32005`. Retry eligibility is now
 * STRUCTURAL, so this is the shape that must earn a replay — a free-text match
 * alone deliberately no longer does (codex round-1 blocker 2). */
const SESSION_NOT_FOUND_ERROR = sdkHttp(
  404,
  '{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"Session not found"}}',
);

describe("callConnectorInstanceMcpTool — bounded session-retry", () => {
  it("success-after-retry: session_not_found once, then a fresh session succeeds", async () => {
    const { factory, attempts, closedCount } = sequencedClient([
      { error: SESSION_NOT_FOUND_ERROR },
      { result: { structuredContent: { success: true } } },
    ]);
    await expect(
      callConnectorInstanceMcpTool({
        endpoint: "https://site/x",
        authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==",
        name: "mcp-adapter-execute-ability",
        arguments: {},
        clientFactory: factory,
      }),
    ).resolves.toEqual({ success: true });
    expect(attempts()).toBe(2); // exactly one retry — a fresh client per attempt
    expect(closedCount()).toBe(2); // the dead client AND the fresh one both close
  });

  it("double-failure: session_not_found twice surfaces the distinct code, no further retry", async () => {
    const { factory, attempts } = sequencedClient([{ error: SESSION_NOT_FOUND_ERROR }, { error: SESSION_NOT_FOUND_ERROR }]);
    await expect(
      callConnectorInstanceMcpTool({
        endpoint: "https://site/x",
        authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==",
        name: "mcp-adapter-execute-ability",
        arguments: {},
        clientFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "session_not_found", httpStatus: 404 });
    expect(attempts()).toBe(2); // retried exactly once, never a third attempt (no retry loop)
  });

  it("no retry on timeout — surfaces immediately, single attempt", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const { factory, attempts } = sequencedClient([{ connectError: err }, { result: { structuredContent: {} } }]);
    await expect(
      callConnectorInstanceMcpTool({
        endpoint: "https://site/x",
        authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==",
        name: "x",
        arguments: {},
        clientFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(attempts()).toBe(1);
  });

  it("no retry on a genuine network error — surfaces immediately, single attempt", async () => {
    const { factory, attempts } = sequencedClient([
      { connectError: brandedConnectFailure() },
      { result: { structuredContent: {} } },
    ]);
    await expect(
      callConnectorInstanceMcpTool({
        endpoint: "https://site/x",
        authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==",
        name: "x",
        arguments: {},
        clientFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(attempts()).toBe(1);
  });

  it("no retry on tool_error (isError result) — surfaces immediately, single attempt", async () => {
    const { factory, attempts } = sequencedClient([
      { result: { isError: true, structuredContent: { error: { code: "rest_forbidden", message: "no" } } } },
      { result: { structuredContent: {} } },
    ]);
    await expect(
      callConnectorInstanceMcpTool({
        endpoint: "https://site/x",
        authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==",
        name: "x",
        arguments: {},
        clientFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "tool_error", wpErrorCode: "rest_forbidden" });
    expect(attempts()).toBe(1);
  });

  it("never leaks the auth header on a session_not_found error — through the REAL retry path", async () => {
    // codex round-3 finding (e): this previously fed a plain `Error`, which
    // under the tightened contract is no longer `session_not_found` at all — so
    // it exercised no retry, and it had no fail-if-resolved assertion. It now
    // uses the real 404 + `-32005` frame with the credential echoed inside it,
    // so the double-failure path (retry, then surface) is what gets asserted.
    const leaky = sdkHttp(
      404,
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"Session not found for Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw=="}}',
    );
    const { factory, attempts } = sequencedClient([{ error: leaky }, { error: leaky }]);
    await expect(
      callConnectorInstanceMcpTool({
        endpoint: "https://site/x",
        authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==",
        name: "x",
        arguments: {},
        clientFactory: factory,
      }),
    ).rejects.toMatchObject({ code: "session_not_found" });
    // The retry genuinely ran — this is the path under test.
    expect(attempts()).toBe(2);

    let caught: InvokerError | undefined;
    try {
      await callConnectorInstanceMcpTool({
        endpoint: "https://site/x",
        authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==",
        name: "x",
        arguments: {},
        clientFactory: sequencedClient([{ error: leaky }, { error: leaky }]).factory,
      });
      throw new Error("expected session_not_found to surface");
    } catch (e) {
      caught = e as InvokerError;
    }
    expect(caught?.code).toBe("session_not_found");
    // The classifier composes its own message, so nothing from the peer's frame
    // — credential or otherwise — rides along.
    expect(caught?.message).toBe("connector instance MCP session no longer exists (session not found)");
    expect(caught?.message).not.toContain("dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==");
    expect(caught?.message).not.toContain("app-password-24chars");
  });
});

describe("listConnectorInstanceMcpTools — bounded session-retry", () => {
  it("success-after-retry: session_not_found once, then a fresh session succeeds", async () => {
    const { factory, attempts, closedCount } = sequencedClient([
      { error: SESSION_NOT_FOUND_ERROR },
      { result: { tools: [{ name: "a" }] } },
    ]);
    await expect(
      listConnectorInstanceMcpTools({ endpoint: "https://site/x", authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==", clientFactory: factory }),
    ).resolves.toEqual([{ name: "a" }]);
    expect(attempts()).toBe(2);
    expect(closedCount()).toBe(2);
  });

  it("double-failure: session_not_found twice surfaces the distinct code, no further retry", async () => {
    const { factory, attempts } = sequencedClient([{ error: SESSION_NOT_FOUND_ERROR }, { error: SESSION_NOT_FOUND_ERROR }]);
    await expect(
      listConnectorInstanceMcpTools({ endpoint: "https://site/x", authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==", clientFactory: factory }),
    ).rejects.toMatchObject({ code: "session_not_found", httpStatus: 404 });
    expect(attempts()).toBe(2);
  });

  it("no retry on other errors — surfaces immediately, single attempt", async () => {
    const { factory, attempts } = sequencedClient([
      { error: brandedConnectFailure("ECONNRESET") },
      { result: { tools: [] } },
    ]);
    await expect(
      listConnectorInstanceMcpTools({
        endpoint: "https://site/x",
        authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==",
        clientFactory: factory,
      }),
      // Raised from the LIST call, i.e. after connect succeeded — fail-closed.
    ).rejects.toMatchObject({ code: "transport_error" });
    expect(attempts()).toBe(1);
  });

  it("no retry on a fail-CLOSED transport_error either — single attempt", async () => {
    const { factory, attempts } = sequencedClient([{ error: sdkHttp(500, "boom") }, { result: { tools: [] } }]);
    await expect(
      listConnectorInstanceMcpTools({ endpoint: "https://site/x", authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==", clientFactory: factory }),
    ).rejects.toMatchObject({ code: "transport_error" });
    expect(attempts()).toBe(1);
  });
});

// cinatra#2018 S3 PR-B — the additive per-server `tools/list` wire primitive (§2).

async function listTools(behavior: Parameters<typeof fakeClient>[0]) {
  const { factory } = fakeClient(behavior);
  return listConnectorInstanceMcpTools({
    endpoint: "https://site/x",
    authHeader: "Basic secret-never-in-errors",
    clientFactory: factory,
  });
}

describe("listConnectorInstanceMcpTools — tools/list unwrap", () => {
  it("returns the tools[] rows on a well-formed result", async () => {
    await expect(
      listTools({ listResult: { tools: [{ name: "a" }, { name: "b", inputSchema: { type: "object" } }] } }),
    ).resolves.toEqual([{ name: "a" }, { name: "b", inputSchema: { type: "object" } }]);
  });
  it("an EMPTY tools array is valid → returns [] (not an error)", async () => {
    await expect(listTools({ listResult: { tools: [] } })).resolves.toEqual([]);
  });
  it("drops non-object rows so the return type is honest", async () => {
    await expect(listTools({ listResult: { tools: [{ name: "keep" }, null, 7, "x"] } })).resolves.toEqual([
      { name: "keep" },
    ]);
  });
  it("no tools array → invalid_response", async () => {
    await expect(listTools({ listResult: { notTools: 1 } })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("null / undefined result → typed invalid_response, never a raw TypeError (codex round-0 Low)", async () => {
    await expect(listTools({ listResult: null })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(listTools({ listResult: undefined })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("closes the client after a successful list (close-in-finally)", async () => {
    const { factory, closed } = fakeClient({ listResult: { tools: [] } });
    await listConnectorInstanceMcpTools({ endpoint: "https://site/x", authHeader: "Basic dXNlcjphcHAtcGFzc3dvcmQtMjRjaGFycw==", clientFactory: factory });
    expect(closed()).toBe(true);
  });
});

describe("listConnectorInstanceMcpTools — absent-stack typed errors (shared taxonomy §1.3)", () => {
  it("connect 400 no-session (Missing Mcp-Session-Id) → session_required", async () => {
    await expect(
      listTools({ connectError: new Error("HTTP 400: Missing Mcp-Session-Id header (-32600)") }),
    ).rejects.toMatchObject({ code: "session_required", httpStatus: 400 });
  });
  it("AbortError on connect → timeout", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    await expect(listTools({ connectError: err })).rejects.toMatchObject({ code: "timeout" });
  });
  it("list failure AFTER a successful connect is transport_error even when BRANDED", async () => {
    // codex round-2 finding 2: `connect()` already succeeded, so the peer
    // demonstrably answered. A branded socket loss on the SUBSEQUENT request is
    // therefore not evidence of an unreachable peer, and must not clear the
    // health state. The post-connect catches assert `peerAnswered: true` rather
    // than consulting the client's optional latch, so this holds for an injected
    // fake that reports nothing at all.
    await expect(listTools({ listError: brandedConnectFailure("ECONNRESET") })).rejects.toMatchObject({
      code: "transport_error",
    });
  });
  it("never leaks the auth header in the error message", async () => {
    try {
      await listTools({ connectError: new Error("boom Basic secret-never-in-errors") });
    } catch (e) {
      expect((e as InvokerError).message).not.toContain("secret-never-in-errors");
    }
  });
});
