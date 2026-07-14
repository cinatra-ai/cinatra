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
import { readAgentsForSkillMatching } from "@/lib/agents-store";
import {
  hasProjectBindAuthority,
  toBindableTemplates,
  type BindableAgentTemplate,
} from "./bindable-templates";

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

/**
 * Installed agent templates the bind picker can offer for this project
 * (cinatra#1503, design cinatra#1509 §4.4): the canonical installed-agents
 * catalog (`readAgentsForSkillMatching` — DB-installed templates unioned with
 * provider-declared on-disk agents; the enumeration honors the operator's own
 * vendor dir per cinatra#538) minus the templates the project already binds.
 *
 * Authority: gated on the SAME authority as the bind action —
 * `project_agent_template_bindings_create` requires a `write`-rank project
 * grant (platform_admin bypass), so the candidate enumeration pre-gates on
 * that via `hasProjectBindAuthority`. The list handler call before it re-runs
 * the existence (404 hidden) + read gate server-side and yields the bound-id
 * set from the single authoritative source. The create handler stays the
 * final authority on any actual bind.
 */
export async function listBindableAgentTemplatesAction(
  projectId: string,
): Promise<
  | { ok: true; items: BindableAgentTemplate[] }
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

    if (
      !hasProjectBindAuthority({
        platformAdmin: actor.platformRole === "platform_admin",
        projectGrants: (actor.projectGrants as ProjectGrant[] | undefined) ?? [],
        projectId,
      })
    ) {
      return { ok: false, error: "forbidden" };
    }

    const installed = await readAgentsForSkillMatching();
    return {
      ok: true,
      items: toBindableTemplates(
        installed,
        result.items.map((b) => b.agentTemplateId),
      ),
    };
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
