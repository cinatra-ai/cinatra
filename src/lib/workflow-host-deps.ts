import "server-only";

// The ONE place the workflows host deps are built. Both the MCP
// server registration (`src/lib/mcp-server.ts`) and the workflow-launcher portlet
// action (`src/lib/dashboards/portlet-actions.ts`) consume this so the project
// write-grant gate, agent-existence, and approver-scope probes never drift. The
// `assertProjectWriteAccess` closure resolves the actor's projectGrants app-side
// (the workflows package can't import `@/lib`) then delegates to the live
// actor-aware `assertProjectWritable`, which reads `actor.projectGrants`.
import type { WorkflowHandlerDeps } from "@cinatra-ai/workflows/mcp-client";
import { assertProjectWritableSync, assertProjectWritable } from "@/lib/project-writable";
import { readProjectGrantsForUser } from "@/lib/better-auth-db";
import { workflowAgentRefAvailable } from "@/lib/workflow-agent-executor";
import { approverResolvable, type ApprovalScope } from "@/lib/workflow-approvers";
import { resolveOrgRoleForUser } from "@/lib/auth-session";
import type { ActorContext } from "@/lib/authz/actor-context";
import { POLICY_VERSION } from "@/lib/authz/actor-context";
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import { enforceExtensionAccess } from "@cinatra-ai/extensions/enforce-extension-access";

export function buildWorkflowHandlerDeps(): WorkflowHandlerDeps {
  return {
    assertProjectWritable: (projectId: string) => assertProjectWritableSync(projectId),
    // Actor write-grant gate. Resolve the actor's projectGrants app-side then
    // delegate to the live actor-aware assertProjectWritable.
    assertProjectWriteAccess: async (actor, projectId, mode) => {
      if (!actor.userId || !actor.orgId) {
        throw new Error("Active organization + user required for project write access.");
      }
      const orgRole =
        actor.orgRole === "org_owner" || actor.orgRole === "org_admin" || actor.orgRole === "member"
          ? actor.orgRole
          : undefined;
      const grants = await readProjectGrantsForUser(actor.userId, actor.orgId, {
        teamIds: actor.teamIds ? [...actor.teamIds] : [],
        ...(orgRole ? { orgRole } : {}),
      });
      await assertProjectWritable({ userId: actor.userId, projectGrants: grants } as never, projectId, mode);
    },
    agentExists: (agentRef: unknown, orgId: string) => workflowAgentRefAvailable(agentRef, orgId),
    approverResolvable: (scope: unknown, orgId: string) => approverResolvable(scope as ApprovalScope, orgId),
    // Uniform extension-access gate for extension-origin workflow
    // templates. Resolves the canonical workflow installed_extension for the
    // actor's org and delegates to enforceExtensionAccess (throws on deny). A
    // template whose package has no installed workflow row is ungoverned
    // (operator/dev) and allowed.
    assertExtensionAccess: async (actor, sourcePackage, op) => {
      const rows = (await readInstalledExtensionsByPackageName(sourcePackage)).filter(
        (r) => r.kind === "workflow",
      );
      if (rows.length === 0) return; // ungoverned (no install row) → allow.
      // Only LIVE installs (active|locked) govern. If an install row exists but
      // none are live (archived/removed), DENY even if a template row lingers.
      const live = rows.filter((r) => r.status === "active" || r.status === "locked");
      if (live.length === 0) {
        const { AuthzError } = await import("@/lib/authz");
        throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Workflow extension is not active." });
      }
      const orgId = actor.orgId ?? undefined;
      const row =
        (orgId && live.find((r) => r.organizationId === orgId)) ||
        live.find((r) => r.organizationId == null) ||
        live[0];
      // MCP-path actors carry platformRole but not orgRole — resolve it from
      // (orgId, userId) so the owner-aware "admin" tier recognizes org admins.
      let orgRole: "org_owner" | "org_admin" | "member" | undefined =
        actor.orgRole === "org_owner" || actor.orgRole === "org_admin" || actor.orgRole === "member"
          ? actor.orgRole
          : undefined;
      if (!orgRole && actor.userId && actor.orgId) {
        const resolved = await resolveOrgRoleForUser(actor.orgId, actor.userId);
        if (resolved === "org_owner" || resolved === "org_admin" || resolved === "member") {
          orgRole = resolved;
        }
      }
      const actorCtx: ActorContext = {
        principalType: "HumanUser",
        principalId: actor.userId ?? "",
        organizationId: actor.orgId ?? undefined,
        teamIds: actor.teamIds ? [...actor.teamIds] : undefined,
        ...(orgRole ? { orgRole } : {}),
        platformRole: actor.platformRole === "platform_admin" ? "platform_admin" : "member",
        authSource: "mcp",
        policyVersion: POLICY_VERSION,
      };
      await enforceExtensionAccess(
        {
          kind: "workflow",
          resourceId: row.id,
          owner: {
            ownerLevel: row.ownerLevel,
            ownerId: row.ownerId,
            organizationId: row.organizationId,
          },
        },
        actorCtx,
        op,
      );
    },
  };
}
