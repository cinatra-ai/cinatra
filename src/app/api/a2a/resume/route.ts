import "server-only";

import { z } from "zod";

import { verifyA2AAccessToken } from "@/lib/a2a-auth";
import { corsHeaders } from "@/lib/a2a-cors";
import { approveReviewTaskInternal } from "@cinatra-ai/agents";
import { AuthzError } from "@/lib/authz/errors";
import {
  primitiveActorFromVerifiedA2A,
  type ActorRoleHints,
} from "@/lib/authz/build-actor-context";

// ---------------------------------------------------------------------------
// POST /api/a2a/resume
//
// External HITL approval gate for AG-UI consumers. Allows a Bearer-JWT caller
// (same credentials as POST /api/a2a) to approve a pending review task, which
// resumes the paused agent run.
//
// Gated by CINATRA_AGUI_EXTERNAL_ENABLED=true — returns 404 when unset so
// production deployments must opt in, matching the CINATRA_A2A_HTTP_ENABLED
// pattern on the sibling /api/a2a route.
//
// Auth: Bearer JWT via verifyA2AAccessToken. `requireAdminSession()` is NOT
// called here — external callers authenticate with client_credentials tokens,
// not browser sessions. The approveReviewTaskInternal helper performs the core
// logic without any session dependency.
//
// Contract:
//   POST  { reviewTaskId: string, values?: unknown }
//   200   { ok: true }
//   400   { error: "Invalid request body" }
//   401   { error: "unauthorized" }
//   404   "Not Found" (flag unset)
//   404   { error: "Review task not found or already resolved" }
//   410   { error: "Review task has expired" }
//   500   { error: "Internal server error" }
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ResumeBodySchema = z.object({
  reviewTaskId: z.string().min(1),
  values: z.unknown().optional(),
});

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req),
  });
}

export async function POST(req: Request): Promise<Response> {
  const cors = corsHeaders(req);

  if (process.env.CINATRA_AGUI_EXTERNAL_ENABLED !== "true") {
    return new Response("Not Found", { status: 404, headers: cors });
  }

  const authed = await verifyA2AAccessToken(req);
  if (!authed.ok) {
    const orig = authed.response;
    const headers = new Headers(orig.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(orig.body, { status: orig.status, headers });
  }

  const rawBody = await req.json().catch(() => null);
  const parsed = ResumeBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }

  const { reviewTaskId, values } = parsed.data;
  const actorId = authed.subject;
  // The A2A Bearer authenticates only the caller CLASS — it does NOT prove this
  // principal may approve THIS reviewTaskId's
  // run. Thread the verified ActorContext into approveReviewTaskInternal, which
  // now resolves reviewTaskId -> run and enforces `run.approveHitl` BEFORE any
  // mutation / sendTask / enqueue. Without a verified actorContext we cannot
  // bind authority, so fail closed (401) rather than reaching the
  // (previously auth-neutral) helper with a caller-chosen task id.
  const verified = authed.actorContext;
  if (!verified) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
  // Narrow adapter preserves the verified principal type (ServiceAccount stays
  // ServiceAccount, not ExternalA2AAgent) and carries tokenScopes + org. The
  // run's access policy — NOT the caller-supplied subject — is the authority.
  const actorContext = primitiveActorFromVerifiedA2A(verified);
  // Pass the verified org as an explicit role hint so enforceRunAccess derives
  // the actor's org from the TOKEN, never from run.orgId (which would weaken the
  // cross-org guard for a foreign caller).
  const roleHints: ActorRoleHints | undefined =
    verified.organizationId !== undefined
      ? { actorOrganizationId: verified.organizationId }
      : undefined;

  try {
    // Pass `values` through so structured reviewer decisions are stored in the
    // audit event payload for auditability. The trailing actorContext + role
    // hints make the helper enforce run-access before any state change.
    await approveReviewTaskInternal(
      reviewTaskId,
      actorId,
      values,
      undefined,
      undefined,
      actorContext,
      roleHints,
    );
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...cors },
    });
  } catch (err) {
    // Run-access denial -> map AuthzError to the route's contract without
    // leaking run existence: a hidden run stays 404 "not found"-shaped; a
    // forbidden run is 403.
    if (err instanceof AuthzError) {
      const status = err.statusCode === 404 ? 404 : 403;
      return new Response(
        JSON.stringify({
          error:
            status === 404
              ? "Review task not found or already resolved"
              : "forbidden",
        }),
        {
          status,
          headers: { "Content-Type": "application/json", ...cors },
        },
      );
    }
    const message = err instanceof Error ? err.message : "Internal server error";

    if (
      message === "Review task not found or already resolved" ||
      message === "Planned action not found"
    ) {
      return new Response(JSON.stringify({ error: message }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    if (message === "Review task has expired") {
      return new Response(JSON.stringify({ error: message }), {
        status: 410,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    console.error("[a2a/resume] approveReviewTaskInternal failed:", message);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
}
