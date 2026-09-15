"use server";

// ---------------------------------------------------------------------------
// Server-action surface for memory row promotion REQUESTS (cinatra#1381,
// epic #1373).
//
// `requestMemoryPromotionAction` opens a pending promotion request for a memory
// row the caller can SEE. The actor-gated read and the CAS-anchored create both
// live in the shared `@/lib/memory/memory-promotion-request` service —
// byte-identical gates to the `memory_promote_request` MCP tool, which is the
// point of routing both through one service.
//
// It NEVER widens the row: the widen happens only when an admin approves the
// request on the unified /notifications surface (the admin-gated
// PromotionBackend decide ladder: CAS version guard + the transition matrix +
// the fail-closed credential scan + the ATOMIC apply).
//
// Non-redirecting: business refusals are returned in place as VALUES, mirroring
// the approvals decide action idiom.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";

import { getActorContext, getAuthSession } from "@/lib/auth-session";
import {
  memoryPromotionRequestPayloadSchema,
  requestMemoryPromotion,
} from "@/lib/memory/memory-promotion-request";

// The SHARED payload schema, imported from the service both request surfaces
// route through (cinatra#1381 review, finding 9). It is the same object the
// `memory_promote_request` MCP tool validates against, so a value one surface
// accepts is a value the other accepts.
const inputSchema = memoryPromotionRequestPayloadSchema;

export type RequestMemoryPromotionActionResult =
  | { ok: true; requestId: string }
  | { ok: false; code: string; message: string };

export async function requestMemoryPromotionAction(
  rawInput: unknown,
): Promise<RequestMemoryPromotionActionResult> {
  // Server actions are a public endpoint — validate the payload first.
  const parsedInput = inputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return { ok: false, code: "invalid_state", message: "Invalid promotion request payload." };
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

  const result = await requestMemoryPromotion({
    orgId,
    memoryId: input.memoryId,
    requestedBy: userId,
    toVisibility: input.toVisibility,
    ...(input.targetTeamId ? { targetTeamId: input.targetTeamId } : {}),
    actor,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  // The new pending request appears in the requester's "Your requests" on
  // /notifications and bumps reviewers' inbox counts (the bell badge) — refresh
  // the feed page and the root-layout segment that server-resolves the badge.
  revalidatePath("/notifications");
  revalidatePath("/", "layout");
  return { ok: true, requestId: result.request.id };
}
