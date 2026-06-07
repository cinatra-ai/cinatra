import "server-only";

import { toSseResponse, toMuxSseResponse, type JSONRPCResponse } from "@cinatra-ai/a2a";
import { readAgentRunByTaskId, resolveDefaultOrgId } from "@cinatra-ai/agents";
import { subscribeToAgUiEvents } from "@cinatra-ai/agent-ui-protocol/server";

import { getA2AMount } from "@/lib/a2a-server";
import { verifyA2AAccessToken } from "@/lib/a2a-auth";
import { corsHeaders } from "@/lib/a2a-cors";
import { withActorContext } from "@cinatra-ai/llm/actor-context";
import { resolveA2AActorContext } from "./actor-context-resolver";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";

// ---------------------------------------------------------------------------
// POST /api/a2a handles non-streaming JSON-RPC and streaming A2A calls.
// Streaming calls return AsyncGenerator<JSONRPCResponse> from the SDK, which
// is adapted into a text/event-stream Response via `toSseResponse`. Client
// disconnect (req.signal) terminates the generator and releases the underlying
// Redis subscriber (see packages/a2a/src/streaming-bridge.ts).
//
// Gated by `CINATRA_A2A_HTTP_ENABLED=true`. When the flag is unset the route
// returns 404 - intentional so production deployments have to opt in.
//
// Auth mirrors /api/mcp: Bearer JWT verified against Better Auth's oauth
// provider plugin, canonical origin used for audience/issuer (tunnel-safe).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Extract the A2A task id from a parsed JSON-RPC body.
 * A2A spec locations:
 *   - params.message.taskId (message/send, message/sendStreaming)
 *   - params.id (tasks/resubscribe, tasks/get, tasks/cancel)
 * Returns null if neither is a non-empty string.
 */
function extractA2ATaskId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  const msg = p.message as Record<string, unknown> | undefined;
  const msgTaskId = msg?.taskId;
  if (typeof msgTaskId === "string" && msgTaskId.length > 0) return msgTaskId;
  const id = p.id;
  if (typeof id === "string" && id.length > 0) return id;
  return null;
}

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req),
  });
}

export async function POST(req: Request): Promise<Response> {
  const cors = corsHeaders(req);

  if (process.env.CINATRA_A2A_HTTP_ENABLED !== "true") {
    return new Response("A2A HTTP surface disabled", {
      status: 404,
      headers: cors,
    });
  }

  const authed = await verifyA2AAccessToken(req);
  if (!authed.ok) {
    const orig = authed.response;
    const headers = new Headers(orig.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(orig.body, { status: orig.status, headers });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      },
    );
  }

  // Last-Event-ID enables tasks/resubscribe replay. Fetch's Headers.get is
  // case-insensitive so "last-event-id" matches "Last-Event-ID". We
  // defensively validate the shape: Redis Streams native IDs are
  // "<digits>-<digits>". A forged value containing XRANGE-unsafe characters
  // is treated as absent so downstream XRANGE cannot be crashed via a
  // header-injection attack. No 400 response - missing Last-Event-ID is
  // already the default behavior.
  const rawLastEventId = req.headers.get("last-event-id");
  const lastEventId =
    rawLastEventId && /^\d+-\d+$/.test(rawLastEventId)
      ? rawLastEventId
      : undefined;

  const mount = await getA2AMount();
  // The SDK's ServerCallContext is an opaque interface; Cinatra extends it
  // with a custom lastEventId field read by CinatraResubscribeHandler. Cast
  // is safe because the SDK passes context through unchanged.
  //
  // Forward the verified ActorContext (carrying tokenScopes from the JWT
  // scope claim, intersected with the service-account ceiling) into the SDK
  // context so any downstream handler that constructs a PrimitiveActorContext
  // for the request can read the bound scopes and propagate them through
  // buildActorContextFromPrimitive. Without this, tokenScopes is undefined at
  // the enforceRunAccess boundary and the intersection check short-circuits
  // to allow.
  //
  // Resolve the originating ActorContext and run mount.handle inside
  // withActorContext so any downstream code reachable from this dispatch
  // (MCP handlers, tRPC primitives, BullMQ enqueues) can read the actor
  // without explicit threading. Fail closed when the actor cannot be resolved.
  const resolution = await resolveA2AActorContext({
    authResult: authed,
    body,
    env: { A2A_DEV_BYPASS: process.env.A2A_DEV_BYPASS },
    deps: {
      readAgentRunByTaskId: async (taskId: string) => {
        const run = await readAgentRunByTaskId(taskId);
        // run.orgId is `string` because the column is NOT NULL; the narrow
        // RunForActorContext projection mirrors that contract.
        return run
          ? { id: run.id, runBy: run.runBy, orgId: run.orgId }
          : null;
      },
      buildActorContextFromRun,
      resolveDefaultOrgId,
    },
  });
  if (resolution.kind === "error") {
    return new Response(
      JSON.stringify({ code: "ACTOR_CONTEXT_UNRESOLVABLE", message: resolution.message }),
      {
        status: 401,
        headers: { "Content-Type": "application/json", ...cors },
      },
    );
  }
  const resolvedActorContext = resolution.actorContext;

  // Define a typed extension of the SDK's ServerCallContext that carries
  // Cinatra-specific fields. Use a single typed cast at the mount.handle call
  // so any drift between the SDK shape and our additions surfaces at compile
  // time rather than being hidden by `as unknown as`.
  type CinatraA2ACallContext = Parameters<typeof mount.handle>[1] & {
    lastEventId?: string | null;
    a2aActorContext: typeof resolvedActorContext;
  };
  const ctx: CinatraA2ACallContext = {
    lastEventId,
    a2aActorContext: resolvedActorContext,
  } as CinatraA2ACallContext;
  const result = await withActorContext(resolvedActorContext, () => mount.handle(body, ctx));

  // Streaming path: the SDK returns an AsyncGenerator<JSONRPCResponse> for
  // `message/stream` and `tasks/resubscribe`. Adapt to text/event-stream and
  // emit `id:` frames so EventSource clients can resume via Last-Event-ID on
  // reconnect. The extractor reads the Redis Streams ID that
  // CinatraResubscribeHandler stamps into result.metadata.eventId.
  if (
    result !== null &&
    result !== undefined &&
    typeof (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
      === "function"
  ) {
    const a2aGen = result as AsyncGenerator<JSONRPCResponse>;
    // extractId stamps Redis Streams IDs into SSE `id:` frames so EventSource
    // clients can replay from Last-Event-ID on reconnect.
    const sseOptions = {
      extractId: (chunk: JSONRPCResponse) =>
        (chunk as { result?: { metadata?: { eventId?: string } } }).result
          ?.metadata?.eventId,
    };

    // When the AG-UI external passthrough flag is set, try to multiplex AG-UI
    // execution events into the same SSE response. Additive: any failure falls
    // back to the plain A2A stream so the A2A contract is never broken by
    // AG-UI issues.
    let sseResponse: Response;
    if (process.env.CINATRA_AGUI_EXTERNAL_ENABLED === "true") {
      const taskId = extractA2ATaskId(body);
      let agUiGen: AsyncGenerator<unknown> | null = null;
      if (taskId) {
        try {
          const run = await readAgentRunByTaskId(taskId);
          if (run) {
            agUiGen = subscribeToAgUiEvents(run.id, { signal: req.signal });
          }
        } catch (err) {
          // AG-UI lookup/subscription failures must NOT break the A2A stream.
          console.warn(
            "[a2a route] AG-UI passthrough setup failed; falling back to plain A2A:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      sseResponse = agUiGen
        ? toMuxSseResponse(a2aGen, agUiGen, req.signal)
        : toSseResponse(a2aGen, req.signal, sseOptions);
    } else {
      sseResponse = toSseResponse(a2aGen, req.signal, sseOptions);
    }

    // Re-apply CORS on top of the SSE headers so preflighted browser clients
    // can consume the stream.
    const merged = new Headers(sseResponse.headers);
    for (const [k, v] of Object.entries(cors)) merged.set(k, v);
    return new Response(sseResponse.body, { status: 200, headers: merged });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
