import "server-only";

// ---------------------------------------------------------------------------
// Artifact row-scope promotion — the REQUEST-surface service (cinatra#1437,
// epic #1424). The one actor-gated wrapper BOTH request affordances share —
// the `artifact_promote_request` MCP tool (src/lib/artifacts/mcp.ts) and the
// `requestArtifactPromotionAction` server action
// (src/app/artifacts/promotion-actions.ts) — so the read gate can never drift
// between them:
//
//   1. resolve the row through the ACTOR-gated artifact read (`getArtifact`:
//      ownership/visibility filter + artifact-type check + canonical
//      `object.read` kernel decision). The promotion data layer's own
//      `readObject` is deliberately actor-UNfiltered (the decide path runs as
//      a vetted admin), so this gate is what keeps a member from opening
//      requests against rows they cannot see — a non-visible row reads as
//      `not_found`, indistinguishable from absent (no probe oracle);
//   2. open the pending request via the CAS-anchored data layer
//      (`createArtifactRowPromotionRequest`: never-narrow enforced at request
//      time, `objects.version` captured as the CAS anchor, the one-pending
//      partial-unique index surfaces a second in-flight request as `conflict`).
//
// The pending request then flows through the shared promotion ApprovalSource
// (subject type "artifact", cinatra#1560) to the unified /notifications
// approvals surface; ONLY an admin approve there widens the row (the decide
// ladder in `@/lib/objects/artifact-row-promotion`). This module never writes
// the object row — promotion is via approvals, not direct writes.
// ---------------------------------------------------------------------------

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactPromotionVisibility } from "@/lib/objects/artifact-promotion-request-store";
import {
  createArtifactRowPromotionRequest,
  type CreateArtifactPromotionResult,
} from "@/lib/objects/artifact-row-promotion";

import { getArtifact } from "./artifact-service";

export type { ArtifactPromotionVisibility, CreateArtifactPromotionResult };

export interface RequestArtifactPromotionInput {
  orgId: string;
  artifactId: string;
  /** The attributable requesting principal (session user / A2A user id). The
   *  request keys the requester's "Your requests" listing, and the reviewer
   *  inbox EXCLUDES the requester's own rows — so it must name a real user. */
  requestedBy: string;
  toVisibility: ArtifactPromotionVisibility;
  /** Required for a team target (the team that will own the widened row);
   *  ignored for an organization target. */
  targetTeamId?: string;
  /** The caller's ActorContext — REQUIRED. The underlying read treats an
   *  ABSENT actor as unfiltered (internal-caller semantics), so this surface
   *  refuses a missing actor instead of silently widening the gate. */
  actor: ActorContext;
}

/**
 * Open a pending row-scope promotion request for an artifact the caller can
 * see. Business refusals are VALUES (`not_found` | `narrowing` |
 * `invalid_state` | `conflict` | `not_authorized`), never throws — only infra
 * errors escape.
 */
export async function requestArtifactPromotion(
  input: RequestArtifactPromotionInput,
): Promise<CreateArtifactPromotionResult> {
  // Fail-closed runtime guard (the type already requires `actor`): an absent
  // actor would make `getArtifact` skip the ownership/visibility filter.
  if (!input.actor) {
    return {
      ok: false,
      code: "not_authorized",
      message: "A promotion request requires the caller's actor context.",
    };
  }
  // Defense in depth (codex A): the surfaces derive `requestedBy` from the
  // authenticated principal, but the service re-asserts it so no future
  // caller can attribute a request to someone else.
  if (input.actor.principalId !== input.requestedBy) {
    return {
      ok: false,
      code: "not_authorized",
      message: "A promotion request must be attributed to the acting principal.",
    };
  }
  const visible = getArtifact({
    artifactId: input.artifactId,
    orgId: input.orgId,
    actor: input.actor,
  });
  if (!visible) {
    return {
      ok: false,
      code: "not_found",
      message: `No artifact '${input.artifactId}' in this organization.`,
    };
  }
  return createArtifactRowPromotionRequest({
    orgId: input.orgId,
    objectId: input.artifactId,
    requestedBy: input.requestedBy,
    toVisibility: input.toVisibility,
    ...(input.targetTeamId ? { targetTeamId: input.targetTeamId } : {}),
  });
}
