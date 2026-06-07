import "server-only";

import { z } from "zod";

import { verifyA2AAccessToken } from "@/lib/a2a-auth";
import { corsHeaders } from "@/lib/a2a-cors";
import { approveReviewTaskInternal } from "@cinatra-ai/agents";

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
  // Capture the verified ActorContext, including tokenScopes from the JWT scope
  // claim intersected with the service-account ceiling. approveReviewTaskInternal
  // does not yet accept an ActorContext parameter; once it does, this captured
  // value can flow through to enforceRunAccess for run.approveHitl unchanged.
  // Without the capture site, the propagation chain has no local home and a
  // future refactor would need to reverify the token. Reading authed.actorContext
  // here also typechecks that the field exists on successful authentication.
  void authed.actorContext;

  try {
    // Pass `values` through so structured reviewer decisions are stored in the
    // audit event payload for auditability.
    await approveReviewTaskInternal(reviewTaskId, actorId, values);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...cors },
    });
  } catch (err) {
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
