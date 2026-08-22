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

// GENERATION-KEYED CACHE (#310). The host's `name → handler` map is memoised,
// keyed by the extension CONTROL-PLANE generation — the one thing it actually
// depends on. A lifecycle transition (activate / hot-update / rollback /
// teardown) bumps the generation; this cache compares and REBUILDS iff they
// differ, so a newly-activated extension's primitives appear (and a torn-down
// one's disappear) on the next call.
//
// WHY ADMISSION IS NOT A SECOND AXIS (cinatra#2817 slice 3). This map is the
// UNRESTRICTED union — it holds every primitive, and it caches no authorization
// decision. Since the perimeter swap, whether a delegated-restricted caller may
// reach one of them is decided PER CALL by the shared evaluator against that
// request's own immutable snapshot. So a revocation takes effect on the very
// next call whether or not this map was rebuilt, which is strictly stronger
// than invalidating a cache and would be the guarantee even if the map never
// changed. Keying on the snapshot as well would rebuild the whole map on every
// review and force an admission-store read onto unrestricted callers, who have
// no use for one.
//
// A Promise so concurrent first-callers share one build; the
// `{ generation, promise }` pairing lets a concurrent caller that started a
// build for an OLD generation be superseded.
let cached: { generation: number; promise: Promise<Map<string, CapturedHostPrimitive>> } | null =
  null;

async function getHandlers(): Promise<Map<string, CapturedHostPrimitive>> {
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
  const servingVersion = decision.kind === "versioned" ? decision.version : null;

  // THE DECLARATION TRAVELS WITH THE VERSION, SO THE VERSION MAY NOT MOVE ALONE
  // (codex round-1 #3). The captured entry carries ONE registration's declared
  // class and malformed state — the union winner's. Re-pinning only the version
  // would build a primitive that never existed: version B's identity wearing
  // version A's declaration, digested into a tuple no review ever approved, or
  // worse, one that another review did.
  //
  // The union is keyed by NAME, so the losing version's own planned entry is not
  // reachable from here to substitute. Rather than synthesize, this REFUSES: an
  // edge-pinned caller whose pin names a version the captured entry does not
  // describe gets `identity_unresolved`, and the transport — which plans
  // per-request and therefore holds the RIGHT entry — remains the way to reach
  // it. Narrowing, deliberately, and only in the case where the alternative is
  // deciding against a declaration that belongs to something else.
  if (target.kind === "extension-versioned") {
    // A retained-only union entry: it serves ONLY under a pin naming its own
    // version. `none` / `default` means this caller's edges do not pin it, and
    // the strict versioned-only dispatch would refuse anyway.
    return servingVersion === target.version ? planned : null;
  }
  // A default union entry serves ONLY while the caller resolves to the default.
  // A pin to any version — including one that happens to equal the default's
  // resolved version string — is a different registration with its own
  // declaration, so it is not this entry's to authorize.
  if (servingVersion !== null) return null;
  return planned;
}

/**
 * Test/back-compat helper — drop the memoised map so the next call rebuilds it.
 * Production invalidation flows through the control-plane generation above (a
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
  const { mcpRequestContextStorage } = await import("@cinatra-ai/mcp-server");
  const handlers = await getHandlers();
  const captured = handlers.get(primitiveName);
  if (!captured) {
    throw new Error(
      `[extension-self-mcp] ctx.mcp.callPrimitive("${primitiveName}") — no host primitive is ` +
        `registered under that name. Known primitives are the host's MCP tool set; check the name.`,
    );
  }
  // The captured wrapper. A delegated-restricted extension call REPLACES it
  // below with a version-pinned dispatch; everything else runs it as before.
  let handler = captured.handler;

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
      // THE REQUEST'S SNAPSHOT, INHERITED WHERE THERE IS ONE (codex round-1 #2,
      // round-2 #2). The transport writes the snapshot it decided against onto
      // the frame it re-enters around the handler, so a self-invocation nested
      // in a live request reuses it rather than loading a fresher one — two
      // snapshots inside one request is exactly the disagreement the immutable
      // snapshot exists to end.
      //
      // Loaded LAZILY and only here. An unrestricted caller has no admission
      // question to answer, so it must not acquire an admission-store
      // dependency (and must not start failing when that store is down).
      // Off the transport there is nothing to inherit, so one is loaded — and an
      // unreadable store denies, as everywhere else.
      const admissionSnapshot =
        ctx.delegatedChatAdmissionSnapshot ??
        (await (
          await import("@/lib/delegated-chat-admission-store")
        ).loadDelegatedChatAdmissionSnapshot());
      // THE SAME CANONICAL-NAME RULE THE TRANSPORT APPLIES (codex whole-diff
      // round #2). The live delegated perimeter refuses a registration whose
      // served name differs from the normalized one it reasoned about; the
      // self-capture keeps mixed-case registrations, so without this a reviewed
      // `Acme_Thing_List` would be absent from the catalog and absent from the
      // live server, yet reachable in-process — the evaluator case-folds, so the
      // admission key would match. Parity here is the whole point of this path.
      if (captured.planned.registeredName !== captured.planned.name) {
        throw new Error(
          `[extension-self-mcp] "${primitiveName}" is not available to delegated chat MCP ` +
            "requests: non_canonical_primitive_name.",
        );
      }
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
      // (a2) PIN THE DISPATCH TO THE IDENTITY THAT WAS AUTHORIZED (codex
      // round-1 #1). The captured wrapper re-resolves the caller's edge and is
      // drift-TOLERANT by design, so an activation landing between the decision
      // above and the call below could execute a version this admission never
      // covered. The pinned dispatch resolves once and REFUSES on any mismatch.
      //
      // Host primitives are unaffected: they have no edges, so there is nothing
      // to drift and the captured handler is already the only thing that runs.
      const pinned = identity.dispatchTarget;
      if (pinned && pinned.kind !== "host") {
        const { dispatchAuthorizedExtensionPrimitive } = await import(
          "@/lib/extension-authorized-dispatch"
        );
        handler = (pinnedInput: unknown) =>
          dispatchAuthorizedExtensionPrimitive(pinned, pinnedInput);
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
