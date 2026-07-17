"use server";

// ---------------------------------------------------------------------------
// Server-action surface for artifact row-scope promotion REQUESTS
// (cinatra#1437, epic #1424).
//
// `requestArtifactPromotionAction` opens a pending promotion request for an
// artifact row the caller can SEE (the actor-gated read + the CAS-anchored
// create both live in the shared `@/lib/artifacts/artifact-promotion-request`
// service — byte-identical gates to the `artifact_promote_request` MCP tool).
// It NEVER widens the row: the widen happens only when an admin approves the
// request on the unified /notifications approvals surface (the admin-gated
// PromotionBackend decide ladder: CAS version guard + never-narrow +
// fail-closed secret/PII scan + atomic widen/re-projection/audit).
//
// Non-redirecting: business refusals are returned in place as VALUES (the
// caller renders them inline), mirroring the approvals decide action idiom.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requestArtifactPromotion } from "@/lib/artifacts/artifact-promotion-request";
import { getActorContext, getAuthSession } from "@/lib/auth-session";

const inputSchema = z.object({
  artifactId: z.string().min(1),
  toVisibility: z.enum(["team", "organization"]),
  /** Required for a team target (the team that will own the widened row). */
  targetTeamId: z.string().min(1).optional(),
});

export type RequestArtifactPromotionActionResult =
  | { ok: true; requestId: string }
  | { ok: false; code: string; message: string };

export async function requestArtifactPromotionAction(
  rawInput: unknown,
): Promise<RequestArtifactPromotionActionResult> {
  // Server actions are a public endpoint — validate the payload first.
  const parsedInput = inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return {
      ok: false,
      code: "invalid_state",
      message: "Invalid promotion request payload.",
    };
  }
  const input = parsedInput.data;

  const session = await getAuthSession();
  const userId = session?.user?.id ?? null;
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!userId || !orgId) {
    return { ok: false, code: "not_authorized", message: "No active session." };
  }
  // The full ActorContext (org role, team grants, project grants) drives the
  // ownership/visibility read gate; fail closed when it cannot be built.
  const actor = await getActorContext();
  if (!actor) {
    return { ok: false, code: "not_authorized", message: "No active session." };
  }

  const result = await requestArtifactPromotion({
    orgId,
    artifactId: input.artifactId,
    requestedBy: userId,
    toVisibility: input.toVisibility,
    ...(input.targetTeamId ? { targetTeamId: input.targetTeamId } : {}),
    actor,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  // The new pending request appears in the requester's "Your requests" on
  // /notifications and bumps reviewers' inbox counts (bell badge) — refresh
  // the feed page and the root-layout segment that server-resolves the badge.
  revalidatePath("/notifications");
  revalidatePath("/", "layout");
  return { ok: true, requestId: result.request.id };
}
