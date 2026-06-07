import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import {
  createPermissionsPrimitiveHandlers,
  inviteMemberSchema,
  updateMemberRoleSchema,
  updateUserPlatformRoleSchema,
  cancelInvitationSchema,
  removeMemberSchema,
  // role_grant CRUD primitives.
  roleGrantGrantSchema,
  roleGrantRevokeSchema,
  roleGrantListSchema,
} from "./handlers";

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "permissions_members_invite": {
    description: "Invite a new member to an organization by email, assigning them a role.",
    inputSchema: inviteMemberSchema,
  },
  "permissions_members_update_role": {
    description: "Change the role of an existing organization member.",
    inputSchema: updateMemberRoleSchema,
  },
  "permissions_members_remove": {
    description: "Remove a member from an organization.",
    inputSchema: removeMemberSchema,
  },
  "permissions_users_update_platform_role": {
    description: "Update a user's platform-level role (user or admin).",
    inputSchema: updateUserPlatformRoleSchema,
  },
  "permissions_invitations_cancel": {
    description: "Cancel a pending organization membership invitation.",
    inputSchema: cancelInvitationSchema,
  },
  // Per-scope role_grant CRUD.
  "role_grant_grant": {
    description: "Grant a role (developer | release_manager | customer) to a user at a specific scope (user/team/organization/workspace/project). Idempotent; re-granting refreshes granted_by + granted_at.",
    inputSchema: roleGrantGrantSchema,
  },
  "role_grant_revoke": {
    description: "Revoke an existing role grant at a specific scope.",
    inputSchema: roleGrantRevokeSchema,
  },
  "role_grant_list": {
    description: "List role grants — by user, by scope, or whole-org (admin only).",
    inputSchema: roleGrantListSchema,
  },
};

export function registerPermissionsPrimitives(server: McpRuntimeToolServer) {
  const handlers = createPermissionsPrimitiveHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? { description: name, inputSchema: z.object({}).passthrough() };
    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      async (input) => {
        const result = await handler({
          primitiveName: name,
          input,
          actor: { actorType: "model", source: "agent" },
          mode: "agentic",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: Array.isArray(result) ? { items: result } : typeof result === "object" && result !== null ? (result as Record<string, unknown>) : { result },
        };
      },
    );
  }
}
