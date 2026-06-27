import "server-only";

// Host self-primitive invoker for `ctx.mcp.callPrimitive`.
//
// A connector reaches another host primitive by NAME through
// `ctx.mcp.callPrimitive(primitiveName, input)` instead of importing the host
// package that owns it. This module backs that port: it MEMOISES the host's
// universal `name → handler` map (built once via
// `buildHostSelfPrimitiveHandlers()` in `@/lib/mcp-server` — the same
// registration pass the live MCP transport runs) and invokes the named handler
// under the caller's resolved request-context.
//
// AUTHORIZATION PARITY (critical): the live MCP transport wraps every tool with
// the deny-by-default `enforceMcpBoundary()` gate (see `policedRegisterTool` in
// packages/mcp-server). The captured handlers are the RAW callbacks WITHOUT that
// wrapper, so this invoker applies the SAME boundary before dispatch and FAILS
// CLOSED on a deny or a boundary error — a connector with the `mcp` port can
// never reach a privileged primitive it would be denied over the wire.
//
// Context handling: when the call originates inside a live MCP request, the
// existing `mcpRequestContextStorage` frame is PRESERVED verbatim (so
// delegated-chat / A2A / run / project restrictions carry through — never
// widened). Off the transport (worker/cookie), a minimal frame is derived from
// the trusted actor so the boundary + handler resolve the right tenant.
//
// Result envelope: the captured handler returns a `CallToolResult`
// ({ content, structuredContent }). `callHostPrimitive` returns the
// `structuredContent` when present, else the JSON-parsed first text content.
// Note: handlers that read auth from `mcpRequestContextStorage` (the host
// convention) work through this path; a handler that inspects the MCP-SDK
// `extra` argument beyond `signal` is not supported in-process (it should read
// the request-context store instead).

import type { ActorContext } from "@/lib/authz/actor-context";
import { getActivationGeneration } from "@/lib/extension-activation-generation";

type CapturedMcpToolHandler = (...args: unknown[]) => unknown | Promise<unknown>;

// GENERATION-KEYED CACHE (#310): the host's `name → handler` map is memoised, but
// the cache is now keyed by the extension CONTROL-PLANE generation instead of an
// ad-hoc `null`-on-transition reset. A lifecycle transition (activate / hot-update
// / rollback / teardown) bumps the generation; this cache compares the generation
// it was built at against the current one and REBUILDS iff they differ — so a
// newly-activated extension's primitives appear (and a torn-down extension's
// disappear) on the next call without a per-site `__reset`. A Promise so concurrent
// first-callers share one build; the `{ generation, promise }` pairing lets a
// concurrent caller that started a build for an OLD generation be superseded.
let cached: { generation: number; promise: Promise<Map<string, CapturedMcpToolHandler>> } | null =
  null;

async function getHandlers(): Promise<Map<string, CapturedMcpToolHandler>> {
  const generation = getActivationGeneration();
  if (!cached || cached.generation !== generation) {
    cached = {
      generation,
      promise: import("@/lib/mcp-server").then((m) => m.buildHostSelfPrimitiveHandlers()),
    };
  }
  const startedAt = cached.generation;
  const handlers = await cached.promise;
  // Re-check after the await: a transition during the build may have bumped the
  // generation, so the resolved map is stale. Rebuild against the current
  // generation rather than returning the stale map (closes the in-flight window).
  if (getActivationGeneration() !== startedAt) {
    return getHandlers();
  }
  return handlers;
}

/**
 * Test/back-compat helper — drop the memoised map so the next call rebuilds it.
 * Production invalidation now flows through the control-plane generation (a
 * lifecycle transition bumps it; this cache compares + rebuilds), so production
 * call sites bump the generation instead of calling this. Kept for tests and for
 * any path that wants an explicit local clear.
 */
export function __resetHostSelfPrimitiveHandlers(): void {
  cached = null;
}

export type CallHostPrimitiveOptions = {
  /** Trusted actor resolved from the request/run context (NOT caller input). */
  actor?: ActorContext | null;
};

/**
 * Invoke a host primitive by name in-process, under the same deny-by-default MCP
 * authorization boundary the live transport enforces. Throws on an unknown
 * primitive, an authorization denial, or a boundary error (fail-closed).
 */
export async function callHostPrimitive(
  primitiveName: string,
  input: unknown,
  options: CallHostPrimitiveOptions = {},
): Promise<unknown> {
  const handlers = await getHandlers();
  const handler = handlers.get(primitiveName);
  if (!handler) {
    throw new Error(
      `[extension-self-mcp] ctx.mcp.callPrimitive("${primitiveName}") — no host primitive is ` +
        `registered under that name. Known primitives are the host's MCP tool set; check the name.`,
    );
  }

  const { mcpRequestContextStorage, isDelegatedChatMcpToolAllowed } = await import("@cinatra-ai/mcp-server");

  const invoke = async () => {
    const ctx = mcpRequestContextStorage.getStore();
    // (a) Delegated-chat allowlist — parity with policedRegisterTool: a
    // delegated-restricted frame may only reach allowlisted (read/discovery/
    // dispatch) primitives. Deny otherwise, BEFORE the boundary classification.
    if (ctx?.delegatedRestricted && !isDelegatedChatMcpToolAllowed(primitiveName)) {
      throw new Error(
        `[extension-self-mcp] "${primitiveName}" is not available to delegated chat MCP requests.`,
      );
    }
    // (b) Deny-by-default MCP boundary — identical gate to the live transport.
    // Fail CLOSED on a deny OR any boundary error.
    let decision: { allowed: boolean; shouldBlock?: boolean; reason?: string };
    try {
      const { enforceMcpBoundary } = await import("@/lib/authz/mcp-boundary");
      decision = await enforceMcpBoundary({
        primitiveName,
        ctx,
        delegatedRestricted: !!ctx?.delegatedRestricted,
      });
    } catch (err) {
      throw new Error(
        `[extension-self-mcp] authorization unavailable for "${primitiveName}" (boundary_error): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    if (!decision.allowed && decision.shouldBlock) {
      throw new Error(
        `[extension-self-mcp] authorization denied for "${primitiveName}": ${decision.reason}`,
      );
    }
    // (c) RE-ENTER the ALS frame around the handler — the awaits above (boundary
    // import + enforcement) can drop the mcpRequestContextStorage frame on some
    // runtimes, so re-run under `ctx` exactly as policedRegisterTool does, or the
    // handler would see a missing request context.
    const runHandler = () => handler(input, makeMinimalExtra());
    const result = (await (ctx ? mcpRequestContextStorage.run(ctx, runHandler) : runHandler())) as
      | { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> }
      | undefined;
    return unwrapCallToolResult(result);
  };

  const existing = mcpRequestContextStorage.getStore();
  if (existing) {
    // Already inside a live MCP request — PRESERVE the full trusted context
    // (delegated-chat / A2A / run / project restrictions). Never rebuild/widen it.
    return invoke();
  }

  // Off the MCP transport (worker/cookie): derive a minimal request-context from
  // the trusted actor so the boundary + handler resolve the right tenant. When
  // no actor resolves, run with an EMPTY context so the boundary denies any
  // privileged primitive (deny-by-default), rather than fabricating identity.
  const actor = options.actor;
  const requestContext = actor
    ? {
        ...(actor.principalType === "HumanUser" ? { userId: actor.principalId } : {}),
        orgId: actor.organizationId ?? null,
        ...(actor.platformRole ? { platformRole: actor.platformRole } : {}),
      }
    : {};
  return mcpRequestContextStorage.run(requestContext, invoke);
}

// ---------------------------------------------------------------------------

function unwrapCallToolResult(result: {
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
} | undefined): unknown {
  if (result && result.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result ?? null;
}

// A minimal RequestHandlerExtra stand-in for in-process invocation. The host's
// primitive handlers resolve auth from `mcpRequestContextStorage`, not from this
// argument, so an aborted-signal-only stub is sufficient.
function makeMinimalExtra(): unknown {
  return {
    signal: new AbortController().signal,
    requestId: `self:${Math.round(performance.now())}`,
    sendNotification: async () => undefined,
    sendRequest: async () => undefined,
  };
}
