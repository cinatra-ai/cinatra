import "server-only";

// ---------------------------------------------------------------------------
// Memory row promotion — the REQUEST-surface service (cinatra#1381, epic
// #1373). The ONE actor-gated wrapper BOTH request affordances share — the
// `memory_promote_request` MCP tool (src/lib/memory/mcp.ts) and the
// `requestMemoryPromotionAction` server action
// (src/app/memory/promotion-actions.ts) — so the read gate can never drift
// between them:
//
//   1. resolve the row through the ACTOR-gated object read: the same SQL
//      ownership/visibility filter `objects_get` / `objects_list` splice, THEN
//      the canonical `object.read` kernel decision. The promotion data layer's
//      own `readObject` is deliberately actor-UNfiltered (the decide path runs
//      as a vetted org admin over a row the requester themselves nominated), so
//      this gate is what keeps a member from opening requests against rows they
//      cannot see. A non-visible row, a row of another type and an absent row
//      all read as `not_found` — indistinguishable, so there is no probe
//      oracle;
//   2. open the pending request via the CAS-anchored data layer
//      (`createMemoryRowPromotionRequest`: the three-move transition matrix
//      enforced at request time, `objects.version` captured as the CAS anchor,
//      the one-pending constraint surfacing a second in-flight request as
//      `conflict`).
//
// The pending request then flows through the shared promotion ApprovalSource
// (subject type "memory", cinatra#1560) to the unified /notifications surface;
// ONLY an admin approve there widens the row. This module NEVER writes the
// object row — promotion is via approvals, not direct writes.
// ---------------------------------------------------------------------------

import { z } from "zod";

import type { ActorContext } from "@/lib/authz/actor-context";
import { decideResourceAccessForActorContext } from "@/lib/authz/enforce-resource-access";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";
import { getObjectById } from "@/lib/objects-store";
import {
  createMemoryRowPromotionRequest,
  MEMORY_CONCEPT_TYPE_ID,
  type CreateMemoryPromotionResult,
  type MemoryPromotionVisibility,
} from "@/lib/objects/memory-row-promotion";

export type { MemoryPromotionVisibility, CreateMemoryPromotionResult };

/**
 * An identifier a caller supplies: NON-BLANK after trimming, and BOUNDED.
 *
 * `.min(1)` alone accepted `"   "` and a 1 MiB string on both request surfaces
 * (cinatra#1381 review, finding 9). Each value reaches the store as a lookup
 * key, and the 1 MiB one was echoed back inside the `not_found` message. Every
 * refusal was still correct and nothing leaked, so this is hardening: a blank
 * id is a client bug worth naming, and no real object or team id is anywhere
 * near the cap.
 */
const identifierField = z
  .string()
  .trim()
  .min(1)
  .max(200);

/**
 * The request payload BOTH surfaces validate: the `memory_promote_request` MCP
 * tool and the `requestMemoryPromotionAction` server action. It lives with the
 * service they already share so the two cannot drift: two hand-kept twins is
 * exactly how one surface ends up accepting what the other refuses.
 */
export const memoryPromotionRequestPayloadSchema = z.object({
  memoryId: identifierField,
  toVisibility: z.enum(["team", "organization"]),
  /** Required for a team target (the team that will own the widened row). */
  targetTeamId: identifierField.optional(),
});

export type MemoryPromotionRequestPayload = z.infer<typeof memoryPromotionRequestPayloadSchema>;

export interface RequestMemoryPromotionInput {
  orgId: string;
  /** The memory object id. */
  memoryId: string;
  /** The attributable requesting principal (session user / A2A user id). The
   *  request keys the requester's "Your requests" listing, and the reviewer
   *  inbox EXCLUDES the requester's own rows — so it must name a real user. */
  requestedBy: string;
  toVisibility: MemoryPromotionVisibility;
  /** Required for a team target (the team that will own the widened row);
   *  ignored for an organization target. */
  targetTeamId?: string;
  /** The caller's ActorContext — REQUIRED. The underlying read treats an ABSENT
   *  actor as unfiltered (internal-caller semantics), so this surface refuses a
   *  missing actor instead of silently widening the gate. */
  actor: ActorContext;
}

/**
 * Open a pending row-scope promotion request for a memory row the caller can
 * see. Business refusals are VALUES (`not_found` | `narrowing` |
 * `invalid_state` | `conflict` | `not_authorized`), never throws — only infra
 * errors escape.
 */
export async function requestMemoryPromotion(
  input: RequestMemoryPromotionInput,
): Promise<CreateMemoryPromotionResult> {
  const notFound: CreateMemoryPromotionResult = {
    ok: false,
    code: "not_found",
    message: `No memory row '${input.memoryId}' in this organization.`,
  };

  // Fail-closed runtime guard (the type already requires `actor`): an absent
  // actor would make the read skip the ownership/visibility filter entirely.
  if (!input.actor) {
    return {
      ok: false,
      code: "not_authorized",
      message: "A promotion request requires the caller's actor context.",
    };
  }
  // Defence in depth: the surfaces derive `requestedBy` from the authenticated
  // principal, but the service re-asserts it so no future caller can attribute
  // a request to someone else.
  if (input.actor.principalId !== input.requestedBy) {
    return {
      ok: false,
      code: "not_authorized",
      message: "A promotion request must be attributed to the acting principal.",
    };
  }

  const visible = getObjectById(input.memoryId, { orgId: input.orgId }, input.actor);
  if (!visible || visible.type !== MEMORY_CONCEPT_TYPE_ID) return notFound;

  // The canonical kernel `object.read` decision ON TOP of the SQL ownership
  // filter — the same pairing `getArtifact` uses for the artifact surface, so
  // neither surface returns a row the other would deny. A denial collapses to
  // the SAME `not_found`, so "you may not read it" and "it is not there" stay
  // indistinguishable. `projectId` is passed so the sealed-room / OBO ceiling
  // facets are decided on the row's real project axis.
  const denial = decideResourceAccessForActorContext(
    {
      resourceType: "object",
      resourceId: visible.id,
      organizationId: visible.orgId ?? null,
      ownerLevel: normalizeOwnerLevel(visible.ownerLevel),
      ownerId: visible.ownerId,
      visibility: visible.visibility,
      projectId: visible.projectId,
    },
    input.actor,
    "object.read",
  );
  if (denial !== null) return notFound;

  return createMemoryRowPromotionRequest({
    orgId: input.orgId,
    objectId: input.memoryId,
    requestedBy: input.requestedBy,
    toVisibility: input.toVisibility,
    ...(input.targetTeamId ? { targetTeamId: input.targetTeamId } : {}),
  });
}
