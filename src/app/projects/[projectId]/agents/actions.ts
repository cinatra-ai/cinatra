"use server";

// ---------------------------------------------------------------------------
// Server-action wrappers around the `project_agent_template_bindings_*` MCP
// primitives. Same in-process invocation pattern as the project_access_*
// wrappers in ../permissions/actions.ts: synthesize a PrimitiveActorContext
// with `projectGrants` stamped so `assertProjectGrantRole` /
// `assertProjectWritable` inside each handler can authorize.
// ---------------------------------------------------------------------------

import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import {
  readProjectGrantsForUser,
  readTeamsForUser,
} from "@/lib/better-auth-db";
import { AuthzError } from "@/lib/authz/errors";
import type { ProjectGrant } from "@/lib/authz/actor-context";
import { handlers as projectsHandlers } from "@cinatra-ai/projects";

type BindingVisibility = "visible" | "hidden" | "project-private";

export type ProjectAgentTemplateBinding = {
  projectId: string;
  agentTemplateId: string;
  visibility: BindingVisibility;
  pinnedVersion: string | null;
  defaultContextOverrides: Record<string, unknown> | null;
  createdBy: string;
  createdAt: Date;
};

async function buildBindingsActor(): Promise<{ actor: Record<string, unknown> }> {
  const session = await requireAuthSession();
  const userId = session.user.id;
  const orgId =
    (session.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;
  const platformAdmin = isPlatformAdmin(session);
  const teamRows = userId && orgId ? await readTeamsForUser(userId, orgId) : [];
  const teamIds = teamRows.map((t) => t.id);
  const orgRole = userId && orgId ? await resolveOrgRoleForSession(session) : null;
  const grants: ProjectGrant[] =
    userId && orgId
      ? await readProjectGrantsForUser(userId, orgId, {
          teamIds,
          ...(orgRole ? { orgRole } : {}),
        })
      : [];

  const actor: Record<string, unknown> = {
    actorType: "human",
    source: "ui",
    userId,
  };
  if (orgId) {
    actor.orgId = orgId;
    actor.organizationId = orgId;
  }
  if (platformAdmin) {
    actor.platformRole = "platform_admin";
    actor.roles = ["platform_admin"];
  }
  if (teamIds.length > 0) actor.teamIds = teamIds;
  actor.projectGrants = grants;
  actor.projectIds = grants.map((g) => g.projectId);
  return { actor };
}

export async function listProjectAgentTemplateBindingsAction(
  projectId: string,
): Promise<
  | { ok: true; items: ProjectAgentTemplateBinding[] }
  | { ok: false; error: string }
> {
  try {
    const { actor } = await buildBindingsActor();
    const result = (await projectsHandlers[
      "project_agent_template_bindings_list"
    ]({
      primitiveName: "project_agent_template_bindings_list",
      input: { projectId },
      actor: actor as unknown as Parameters<
        typeof projectsHandlers["project_agent_template_bindings_list"]
      >[0]["actor"],
      mode: "deterministic",
    })) as { items: ProjectAgentTemplateBinding[] };
    return { ok: true, items: result.items };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

export async function createProjectAgentTemplateBindingAction(
  projectId: string,
  agentTemplateId: string,
  visibility: BindingVisibility,
  pinnedVersion: string | null,
  defaultContextOverrides: Record<string, unknown> | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { actor } = await buildBindingsActor();
    const input: Record<string, unknown> = {
      projectId,
      agentTemplateId,
      visibility,
    };
    if (pinnedVersion !== null) input.pinnedVersion = pinnedVersion;
    if (defaultContextOverrides !== null)
      input.defaultContextOverrides = defaultContextOverrides;
    await projectsHandlers["project_agent_template_bindings_create"]({
      primitiveName: "project_agent_template_bindings_create",
      input,
      actor: actor as unknown as Parameters<
        typeof projectsHandlers["project_agent_template_bindings_create"]
      >[0]["actor"],
      mode: "deterministic",
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

export async function updateProjectAgentTemplateBindingAction(
  projectId: string,
  agentTemplateId: string,
  patch: {
    visibility?: BindingVisibility;
    pinnedVersion?: string | null;
    defaultContextOverrides?: Record<string, unknown> | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { actor } = await buildBindingsActor();
    const input: Record<string, unknown> = {
      projectId,
      agentTemplateId,
      ...patch,
    };
    await projectsHandlers["project_agent_template_bindings_update"]({
      primitiveName: "project_agent_template_bindings_update",
      input,
      actor: actor as unknown as Parameters<
        typeof projectsHandlers["project_agent_template_bindings_update"]
      >[0]["actor"],
      mode: "deterministic",
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

export async function deleteProjectAgentTemplateBindingAction(
  projectId: string,
  agentTemplateId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { actor } = await buildBindingsActor();
    await projectsHandlers["project_agent_template_bindings_delete"]({
      primitiveName: "project_agent_template_bindings_delete",
      input: { projectId, agentTemplateId },
      actor: actor as unknown as Parameters<
        typeof projectsHandlers["project_agent_template_bindings_delete"]
      >[0]["actor"],
      mode: "deterministic",
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}
