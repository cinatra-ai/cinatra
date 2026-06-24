import { appRouter } from "@queuedash/api";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { randomUUID } from "node:crypto";
import { getQueueDashContext } from "@/lib/background-jobs";
import { getActorContext } from "@/lib/auth-session";
import { rejectCrossOrigin } from "@/lib/admin-origin-guard";
import {
  authorizeOperatorRequest,
  OPERATIONS_JOBS_ENDPOINT,
  type ProcedureType,
} from "./gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Drift-proof procedure classification: read the type straight off the live
// tRPC router. A procedure name not present in the router resolves to
// `undefined` -> the gate treats it as unknown and denies (fail-closed).
//
// Fail-closed on the type itself, too: only an exact `query` / `mutation`
// classifies. Any other runtime shape (e.g. a future `subscription`, or a
// drifted/absent `_def.type`) resolves to `undefined` -> the gate denies it,
// rather than silently defaulting a non-mutation to the cheaper `operations.read`.
function lookupProcedureType(procedurePath: string): ProcedureType | undefined {
  const proc = (
    appRouter._def.procedures as Record<string, { _def?: { type?: string } }>
  )[procedurePath];
  const type = proc?._def?.type;
  return type === "query" || type === "mutation" ? type : undefined;
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queueDashHandler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: OPERATIONS_JOBS_ENDPOINT,
    req,
    router: appRouter,
    allowBatching: true,
    createContext: async () => getQueueDashContext(),
  });
}

async function guardedHandler(request: Request): Promise<Response> {
  // 1. Same-origin enforcement (CSRF defense-in-depth for cookie-backed route).
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  // 2. Authenticate the caller. No session -> 401 (do NOT redirect an API call).
  const actor = await getActorContext();
  if (!actor) return jsonError(401, "Authentication required.");

  // 3. Authorize + strict-pre-forward-audit each procedure in the (batched)
  //    request. Any denial / unknown procedure / audit failure rejects the
  //    WHOLE request — nothing is forwarded to QueueDash.
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const decision = await authorizeOperatorRequest({
    req: request,
    actor,
    lookupProcedureType,
    requestId,
  });
  if (decision.kind === "deny") {
    return jsonError(decision.status, decision.reason);
  }

  // 4. Authorized + audited — forward to QueueDash. The gate only read the
  //    request URL + headers (never its body), so the body is intact.
  return queueDashHandler(request);
}

export async function GET(request: Request): Promise<Response> {
  return guardedHandler(request);
}

export async function POST(request: Request): Promise<Response> {
  return guardedHandler(request);
}
