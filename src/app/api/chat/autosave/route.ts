import { randomUUID } from "node:crypto";
import { readSkillAutosaveConfig, writeSkillAutosaveConfig } from "@/lib/skill-autosave";
import { getActorContext } from "@/lib/auth-session";
import { rejectCrossOrigin } from "@/lib/admin-origin-guard";
import { can } from "@/lib/authz";
import type { ResourceRef } from "@/lib/authz/resource-ref";
import { logAuditEventStrict } from "@/lib/authz/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The skill-autosave config is GLOBAL (app-wide), so its write power is a
// platform-level setting. We authorize against an ORG-LESS `administration`
// resource: with no `organizationId`, only `platform_admin` resolves the
// `settings.update` grant (org_admin/member require a matching org), so a
// non-platform actor can never flip the app-wide switch. Same fail-closed
// shape as the QueueDash operator gate.
const ADMINISTRATION_RESOURCE: ResourceRef = {
  resourceType: "administration",
  resourceId: "*",
};

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// GET: requires an authenticated session (the config drives admin/user UI).
// No session -> 401 (do NOT redirect an API call).
export async function GET() {
  const actor = await getActorContext();
  if (!actor) return jsonError(401, "Authentication required.");
  return Response.json(readSkillAutosaveConfig());
}

// PATCH: mutates the app-wide config. Same-origin + platform-admin only +
// strict pre-write audit.
export async function PATCH(request: Request) {
  // 1. Same-origin enforcement (CSRF defense-in-depth for this cookie-backed,
  //    global-settings-mutating route).
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  // 2. Authenticate.
  const actor = await getActorContext();
  if (!actor) return jsonError(401, "Authentication required.");

  // 3. Authorize — platform-admin only (org-less administration resource).
  if (!can(actor, "settings.update", ADMINISTRATION_RESOURCE)) {
    return jsonError(403, "Administrator authorization required.");
  }

  const body = (await request.json()) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    // Nothing to write — return current config without an audit/mutation.
    return Response.json(readSkillAutosaveConfig());
  }

  // 4. Strict pre-write audit — a write failure aborts before the mutation.
  try {
    await logAuditEventStrict({
      actorPrincipalId: actor.principalId,
      actorPrincipalType: "human",
      authSource: "route",
      organizationId: actor.organizationId,
      resourceType: "administration",
      resourceId: "skill_autosave",
      operation: "settings.skill_autosave.update",
      decision: "allowed",
      policyVersion: actor.policyVersion,
      requestId: request.headers.get("x-request-id") ?? randomUUID(),
      metadata: { enabled: body.enabled },
    });
  } catch {
    return jsonError(503, "audit write failed");
  }

  writeSkillAutosaveConfig({ enabled: body.enabled });
  return Response.json(readSkillAutosaveConfig());
}
