"use server";

import { requireAuthSession, resolveOrgRoleForSession } from "@/lib/auth-session";
import {
  approveMergeProposal,
  readMergeProposalById,
  rejectMergeProposal,
  type HistoryActor,
} from "@/lib/object-history";
import { actorFromSession } from "@/lib/authz/build-actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { AuthzError } from "@/lib/authz/errors";
import { getObjectById } from "@/lib/objects-store";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";

// Server action: approve the merge proposal. Requires actor.object.update
// on the target object. Reads the current object data fresh from the
// canonical store so we don't trust caller-provided state.
export async function approveMergeProposalAction(input: {
  proposalId: string;
}): Promise<
  | { ok: true; changeEventId: string; resultVersion: number }
  | { ok: false; reason: string }
> {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    return { ok: false, reason: "no active organization on session" };
  }
  const proposal = readMergeProposalById(input.proposalId, { orgId });
  if (!proposal) {
    return { ok: false, reason: "proposal not found" };
  }
  const target = getObjectById(proposal.objectId, { orgId });
  if (!target) {
    return { ok: false, reason: "target object not found in this org" };
  }
  // Authz: require object.update on the target.
  try {
    await enforceResourceAccess(
      {
        resourceType: "object",
        resourceId: target.id,
        organizationId: target.orgId,
        ownerLevel: normalizeOwnerLevel(target.ownerLevel ?? "organization"),
        ownerId: target.ownerId ?? "",
        visibility:
          (target.visibility as "private" | "team" | "organization" | "public") ??
          "organization",
      },
      actorFromSession(session),
      "object.update",
      (await resolveOrgRoleForSession(session))
        ? { orgRole: (await resolveOrgRoleForSession(session))! }
        : undefined,
    );
  } catch (e) {
    if (e instanceof AuthzError) {
      return { ok: false, reason: `authz denied: ${e.message}` };
    }
    throw e;
  }

  const actor: HistoryActor = {
    actorId: session.user.id,
    actorKind: "user",
    orgId,
  };
  try {
    const result = approveMergeProposal({
      proposalId: input.proposalId,
      actor,
      currentData: (target.data as Record<string, unknown>) ?? {},
    });
    return {
      ok: true,
      changeEventId: result.changeEventId,
      resultVersion: result.resultVersion,
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export async function rejectMergeProposalAction(input: {
  proposalId: string;
  reason?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const session = await requireAuthSession();
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    return { ok: false, reason: "no active organization on session" };
  }
  // Reject MUST enforce object.update on the target — otherwise any
  // active-org user can deny review work for objects they have no write
  // authority on. Mirror the approve action's authz loop.
  const proposal = readMergeProposalById(input.proposalId, { orgId });
  if (!proposal) {
    return { ok: false, reason: "proposal not found" };
  }
  const target = getObjectById(proposal.objectId, { orgId });
  if (!target) {
    return { ok: false, reason: "target object not found in this org" };
  }
  try {
    await enforceResourceAccess(
      {
        resourceType: "object",
        resourceId: target.id,
        organizationId: target.orgId,
        ownerLevel: normalizeOwnerLevel(target.ownerLevel ?? "organization"),
        ownerId: target.ownerId ?? "",
        visibility:
          (target.visibility as "private" | "team" | "organization" | "public") ??
          "organization",
      },
      actorFromSession(session),
      "object.update",
      (await resolveOrgRoleForSession(session))
        ? { orgRole: (await resolveOrgRoleForSession(session))! }
        : undefined,
    );
  } catch (e) {
    if (e instanceof AuthzError) {
      return { ok: false, reason: `authz denied: ${e.message}` };
    }
    throw e;
  }
  const actor: HistoryActor = {
    actorId: session.user.id,
    actorKind: "user",
    orgId,
  };
  try {
    rejectMergeProposal({
      proposalId: input.proposalId,
      actor,
      reviewNotes: input.reason,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
