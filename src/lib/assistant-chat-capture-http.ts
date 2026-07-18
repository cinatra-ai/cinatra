import "server-only";

import { randomUUID } from "node:crypto";
import {
  readSkillAutosaveConfig,
  writeSkillAutosaveConfig,
  readSkillAutosaveUserPref,
  writeSkillAutosaveUserPref,
} from "@/lib/skill-autosave";
import { getActorContext } from "@/lib/auth-session";
import { rejectCrossOrigin } from "@/lib/admin-origin-guard";
import { can } from "@/lib/authz";
import type { ResourceRef } from "@/lib/authz/resource-ref";
import { logAuditEventStrict } from "@/lib/authz/audit";

// ---------------------------------------------------------------------------
// Chat-capture ("autosave") config handlers on the ASSISTANTS surface
// (cinatra#1218). Reproduces the deleted legacy GET/PATCH /api/chat/autosave
// subroute VERBATIM so the AG-UI /chat client kept identical authz/audit
// semantics across the migration; the legacy route was removed in the #1218
// delete stage.
//
// The skill-autosave config is GLOBAL (app-wide), so its write power is a
// platform-level setting. We authorize against an ORG-LESS `administration`
// resource: with no organizationId, only platform_admin resolves the
// settings.update grant, so a non-platform actor can never flip the app-wide
// switch. Same fail-closed shape as the QueueDash operator gate.
// ---------------------------------------------------------------------------

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
// No session -> 401 (do NOT redirect an API call). The response carries the
// caller's OWN per-user chat-capture preference (cinatra#1367) alongside the
// global config — additive, so existing consumers are unaffected.
export async function handleGetChatCaptureConfig(): Promise<Response> {
  const actor = await getActorContext();
  if (!actor) return jsonError(401, "Authentication required.");
  const config = readSkillAutosaveConfig();
  const userPref = readSkillAutosaveUserPref(actor.principalId);
  return Response.json({
    ...config,
    userChatCaptureEnabled: userPref.chatCaptureEnabled,
  });
}

// PATCH: two arms.
//   - `enabled` (app-wide master switch): same-origin + platform-admin only +
//     strict pre-write audit.
//   - `userChatCaptureEnabled` (cinatra#1367, SELF-scoped per-user preference,
//     boolean | null where null = follow the admin default): same-origin +
//     authenticated; allowed for platform admins always, for other users only
//     while the admin `userCanConfigure` flag is on. Writes ONLY the caller's
//     own preference — there is deliberately no path to another user's row.
export async function handlePatchChatCaptureConfig(request: Request): Promise<Response> {
  // 1. Same-origin enforcement (CSRF defense-in-depth for this cookie-backed,
  //    settings-mutating route).
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  // 2. Authenticate.
  const actor = await getActorContext();
  if (!actor) return jsonError(401, "Authentication required.");

  const body = (await request.json()) as {
    enabled?: boolean;
    userChatCaptureEnabled?: boolean | null;
  };
  const isPlatformAdminActor = can(actor, "settings.update", ADMINISTRATION_RESOURCE);
  const hasAdminArm = typeof body.enabled === "boolean";
  const hasUserArm =
    typeof body.userChatCaptureEnabled === "boolean" || body.userChatCaptureEnabled === null;

  // 3a. Admin arm — platform-admin only (org-less administration resource).
  if (hasAdminArm) {
    if (!isPlatformAdminActor) {
      return jsonError(403, "Administrator authorization required.");
    }

    // Strict pre-write audit — a write failure aborts before the mutation.
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
  }

  // 3b. Self arm — the caller's own chat-capture preference. Gated by the admin
  // `userCanConfigure` flag for non-admins. Toggling off stops FUTURE captures
  // only; captured skills are never touched from here.
  if (hasUserArm) {
    const config = readSkillAutosaveConfig();
    if (!isPlatformAdminActor && !config.userCanConfigure) {
      return jsonError(403, "User configuration of autosave is disabled.");
    }

    try {
      await logAuditEventStrict({
        actorPrincipalId: actor.principalId,
        actorPrincipalType: "human",
        authSource: "route",
        organizationId: actor.organizationId,
        resourceType: "administration",
        resourceId: "skill_autosave_user",
        operation: "settings.skill_autosave.user_chat_capture.update",
        decision: "allowed",
        policyVersion: actor.policyVersion,
        requestId: request.headers.get("x-request-id") ?? randomUUID(),
        metadata: { userChatCaptureEnabled: body.userChatCaptureEnabled },
      });
    } catch {
      return jsonError(503, "audit write failed");
    }

    writeSkillAutosaveUserPref(actor.principalId, {
      chatCaptureEnabled: body.userChatCaptureEnabled ?? null,
    });
  }

  // Response mirrors GET so callers can re-sync rendered state.
  const config = readSkillAutosaveConfig();
  const userPref = readSkillAutosaveUserPref(actor.principalId);
  return Response.json({
    ...config,
    userChatCaptureEnabled: userPref.chatCaptureEnabled,
  });
}
