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
// DELEGATED-CHAT PARITY (cinatra#2817): a delegated-restricted self-invocation
// now runs the SAME pure evaluator, over the SAME planned primitive identity and
// the SAME immutable admission snapshot, that the transport's registration choke
// point and call-time guard run. The one thing this path must do for itself is
// re-pin the identity to the CALLER: the captured map is a union built once per
// generation, while the version a given caller is served depends on that
// caller's own resolved edges. Deciding against the union's identity instead of
// the caller's would let a same-name admission for another version authorize a
// call that dispatches somewhere else.
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
import type { PlannedPrimitive } from "@cinatra-ai/mcp-server/capability-plan";
import {
  admissionSnapshotCacheKey,
  type DelegatedChatAdmissionSnapshot,
} from "@cinatra-ai/mcp-server/delegated-chat-admission";
import { getActivationGeneration } from "@/lib/extension-activation-generation";

type CapturedMcpToolHandler = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * The captured entry the host's primitive map now holds: the handler PLUS the
 * PLANNED PRIMITIVE its registration produced (cinatra#2771 → cinatra#2817).
 * Locally mirrored (this module is deliberately import-light and loads
 * `@/lib/mcp-server` lazily); the host's `CapturedHostPrimitive` is the
 * authoritative shape and is structurally identical.
 */
type CapturedHostPrimitive = {
  handler: CapturedMcpToolHandler;
  planned: PlannedPrimitive;
};

// TWO-AXIS CACHE KEY (#310 → cinatra#2817). The host's `name → handler` map is
// memoised, keyed by the extension CONTROL-PLANE generation AND by the
// admission snapshot's identity (both generations plus its content digest).
//
// One axis is not enough, and the missing one is the dangerous one. The
// activation generation answers "which primitives EXIST" — it moves on
// activate / hot-update / rollback / teardown. A marketplace REVOCATION moves
// none of those, so a map keyed on activation alone would keep serving a
// revoked primitive's captured handler until something unrelated happened to be
// installed. Keying on the snapshot too means a revocation invalidates the
// cached authorization before the next self-invocation can reach the handler.
//
// The content digest is in the key as well as the counter: the counter is
// process-local, so two processes at the same counter can hold different record
// sets, and a digest cannot silently match a different set.
//
// A Promise so concurrent first-callers share one build; the `{ key, promise }`
// pairing lets a concurrent caller that started a build for an OLD key be
// superseded.
let cached: { key: string; promise: Promise<Map<string, CapturedHostPrimitive>> } | null = null;

function handlerCacheKey(snapshot: DelegatedChatAdmissionSnapshot): string {
  return `${getActivationGeneration()}|${admissionSnapshotCacheKey(snapshot)}`;
}

async function getHandlers(
  snapshot: DelegatedChatAdmissionSnapshot,
): Promise<Map<string, CapturedHostPrimitive>> {
  const key = handlerCacheKey(snapshot);
  if (!cached || cached.key !== key) {
    cached = {
      key,
      promise: import("@/lib/mcp-server").then((m) => m.buildHostSelfPrimitiveHandlers()),
    };
  }
  const startedAt = cached.key;
  const handlers = await cached.promise;
  // Re-check after the await: a transition or a revocation during the build
  // moves the key, so the resolved map is stale. Rebuild against the current
  // key rather than returning it (closes the in-flight window).
  if (handlerCacheKey(snapshot) !== startedAt) {
    return getHandlers(snapshot);
  }
  return handlers;
}

/**
 * Resolve the identity the CALLER's invocation will actually dispatch to.
 *
 * This is the difference between "an admission exists for a primitive with this
 * name" and "an admission exists for the package at the version that is about
 * to run". The captured map is a UNION built once per activation generation; the
 * version a given caller is served depends on that caller's own resolved edges,
 * so the planned identity must be re-pinned to the caller before the evaluator
 * sees it. Without this, a same-name admission belonging to another version
 * could authorize a call that dispatches somewhere else entirely.
 *
 * `null` means the identity could not be resolved, which DENIES.
 */
async function resolveCallerBoundIdentity(
  planned: PlannedPrimitive,
): Promise<PlannedPrimitive | null> {
  if (planned.identityFailure !== null) return null;
  const target = planned.dispatchTarget;
  if (!target) return null;
  // A core/bundled primitive has no edges — the host identity IS the dispatch.
  if (target.kind === "host") return planned;

  const { resolveEdgeBoundExtensionVersion } = await import("@/lib/extension-edge-bound-serving");
  const decision = await resolveEdgeBoundExtensionVersion({
    targetPackageName: target.packageName,
  });
  // A fail-closed edge refusal is exactly that: the dispatch would throw, so the
  // decision must not pretend an identity exists.
  if (decision.kind === "refuse") return null;
  if (decision.kind === "versioned") {
    return {
      ...planned,
      resolvedVersion: decision.version,
      dispatchTarget: { ...target, kind: "extension-versioned", version: decision.version },
    };
  }
  // `none` / `default`: the DEFAULT version serves. A RETAINED-only union entry
  // has no default to fall back to — the strict versioned-only dispatch would
  // refuse an unpinned caller — so the identity is unresolved rather than
  // silently the default's.
  if (target.kind === "extension-versioned") return null;
  return planned;
}

/**
 * Test/back-compat helper — drop the memoised map so the next call rebuilds it.
 * Production invalidation flows through the two-axis key above (a lifecycle
 * transition or an admission change moves it; this cache compares + rebuilds),
 * so production call sites bump a generation instead of calling this. Kept for
 * tests and for any path that wants an explicit local clear.
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
  const { loadDelegatedChatAdmissionSnapshot } = await import(
    "@/lib/delegated-chat-admission-store"
  );
  // ONE snapshot for this whole invocation — the same shape the live transport
  // uses for a request, so the handler-map key, the identity resolution and the
  // decision below cannot be made against three different admission states.
  const admissionSnapshot = await loadDelegatedChatAdmissionSnapshot();
  const handlers = await getHandlers(admissionSnapshot);
  const captured = handlers.get(primitiveName);
  if (!captured) {
    throw new Error(
      `[extension-self-mcp] ctx.mcp.callPrimitive("${primitiveName}") — no host primitive is ` +
        `registered under that name. Known primitives are the host's MCP tool set; check the name.`,
    );
  }
  const handler = captured.handler;

  const { mcpRequestContextStorage } = await import("@cinatra-ai/mcp-server");
  const { evaluateDelegatedChatAdmission } = await import(
    "@cinatra-ai/mcp-server/delegated-chat-evaluator"
  );

  const invoke = async () => {
    const ctx = mcpRequestContextStorage.getStore();
    // (a) THE SHARED EVALUATOR — parity with the live transport's registration
    // choke point and call-time guard: the same pure function, the same planned
    // primitive identity, the same immutable request snapshot.
    //
    // The identity is re-pinned to THIS CALLER first, so a same-name admission
    // belonging to another owner or another version cannot authorize the call
    // that is actually about to dispatch.
    if (ctx?.delegatedRestricted) {
      const identity = await resolveCallerBoundIdentity(captured.planned);
      if (!identity) {
        throw new Error(
          `[extension-self-mcp] "${primitiveName}" is not available to delegated chat MCP ` +
            "requests: identity_unresolved (the caller's serving version could not be resolved).",
        );
      }
      const decision = evaluateDelegatedChatAdmission(identity, admissionSnapshot);
      if (!decision.allowed) {
        throw new Error(
          `[extension-self-mcp] "${primitiveName}" is not available to delegated chat MCP ` +
            `requests: ${decision.reason}.`,
        );
      }
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
