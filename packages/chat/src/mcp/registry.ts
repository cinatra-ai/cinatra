import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { createChatPrimitiveHandlers } from "./handlers";
// `chat_thread_update.projectId` needs the actor's project grants axis
// to gate `assertProjectWritable`. We resolve grants for the
// chat_thread_update primitive only (the other chat primitives intentionally
// fail-closed without grants — see the sealed-room 404-hide contract).
import { readTeamsForUser, readProjectGrantsForUser } from "@/lib/better-auth-db";

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "chat_thread_list": {
    description: "List all chat threads with metadata only (id, title, createdAt, updatedAt). Uses cursor-based pagination. If nextCursor is present, call again with cursor=<nextCursor> to retrieve the next page. Pass projectId to restrict to a single project (the actor must have a read+ grant; otherwise the call 404-hides).",
    inputSchema: z.object({
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      // Sealed-room read filter. When set, the handler 404-hides if the
      // actor has no read+ grant on the supplied projectId; the SQL filters
      // by `chat_threads.project_id = $projectId` over the typed project
      // column. Subject to CINATRA_SEALED_ROOM_CHAT_THREADS feature flag.
      projectId: z.string().nullish(),
    }),
  },
  "chat_thread_get": {
    description: "Get the full message history of a chat thread by ID.",
    inputSchema: z.object({
      threadId: z.string().describe("ID of the thread to retrieve."),
    }),
  },
  "chat_thread_send": {
    description:
      "Send a message to a chat thread and receive the assistant's full response. " +
      "The assistant has access to all Cinatra MCP tools (agent_*, agents_list, crm_*, etc.). " +
      "Pass newThread: true to start a fresh conversation instead of continuing an existing one. " +
      "If you are an assistant replying to an @mention and your session is not authenticated with " +
      "client_credentials, pass your assistantClientId so the reply is attributed to your assistant identity.",
    inputSchema: z.object({
      threadId: z.string().optional().describe("Existing thread ID to continue. Omit or combine with newThread: true to start fresh."),
      message: z.string().describe("The user message to send to the chat assistant."),
      newThread: z.coerce.boolean().optional().describe("Set to true to create a new thread rather than continuing an existing one."),
      assistantClientId: z.string().optional().describe("Your assistant client_id. Only set this if you are an assistant replying and your session token does not carry your client_credentials identity."),
    }),
  },
  // chat_thread_update is the project-move primitive for chat threads.
  // Only the `projectId` field is mutable today (move the thread between
  // projects or in/out of ambient).
  "chat_thread_update": {
    description:
      "Update a chat thread's mutable fields. The only currently-mutable field is `projectId` — move the thread between projects (and into/out of ambient). Caller must be the thread owner or platform_admin (source authz) AND hold write+ on the target project (assertProjectWritable, when targetProjectId is non-null). The typed `chat_threads.project_id` column is updated in lockstep with the payload's `projectId` field.",
    inputSchema: z.object({
      threadId: z.string(),
      projectId: z.string().nullable().optional().describe(
        "Target project_id. Pass null to move OUT of any project (back to ambient).",
      ),
      reason: z.string().min(1).max(500).optional(),
    }),
  },
  "chat_mentions_poll": {
    description:
      "Poll for pending @mentions directed at the calling assistant. " +
      "Returns user messages where this assistant was @mentioned and mentionState is 'pending'. " +
      "Use chat_thread_send to reply; replying automatically marks the mention as handled. " +
      "Pass assistantClientId if your session token does not carry client_credentials identity.",
    inputSchema: z.object({
      since: z.string().optional().describe("ISO timestamp; only return mentions newer than this."),
      limit: z.number().int().min(1).max(100).optional().default(20),
      // NOTE: self-assertion is a convenience for single-assistant deployments where
      // client_credentials secrets are not stored. In multi-assistant deployments,
      // replace this with proper OAuth client_credentials authentication.
      assistantClientId: z.string().optional().describe("Your assistant client_id. Only set this if your session token does not carry your client_credentials identity."),
    }),
  },
};

export function registerChatPrimitives(server: McpRuntimeToolServer): void {
  const handlers = createChatPrimitiveHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? {
      description: name,
      inputSchema: z.object({}).passthrough(),
    };

    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      (async (input: unknown) => {
        // Resolve identity from AsyncLocalStorage (populated by the MCP
        // transport handler in packages/mcp-server/src/index.tsx after the
        // OAuth Bearer / cookie session has been verified).
        const requestCtx = mcpRequestContextStorage.getStore();
        const actorClientId = requestCtx?.clientId;
        const actorUserId = requestCtx?.userId ?? undefined;
        const actorOrgId = requestCtx?.orgId ?? undefined;
        const actorPlatformRole = requestCtx?.platformRole ?? undefined;

        // For chat_thread_send and chat_mentions_poll: allow an assistant to self-identify
        // via assistantClientId when their session token doesn't carry client_credentials.
        // TODO: replace with proper OAuth client_credentials when assistant secrets are stored.
        const selfAssertedClientId =
          (name === "chat_thread_send" || name === "chat_mentions_poll") &&
          input !== null &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          "assistantClientId" in input &&
          typeof (input as Record<string, unknown>).assistantClientId === "string"
            ? (input as Record<string, unknown>).assistantClientId as string
            : undefined;

        // selfAssertedClientId wins when explicitly provided — it's an intentional
        // identity override (e.g. Claude Code replying as @claude-code from a human
        // session). actorClientId is the passive OAuth identity; selfAsserted is active.
        const effectiveClientId = selfAssertedClientId ?? actorClientId;

        // Resolve projectGrants for the chat_thread_update primitive ONLY.
        // The other chat primitives intentionally don't carry grants (the
        // sealed-room list path 404-hides without them, per the established
        // contract). Failure to resolve => empty grants array
        // (assertProjectWritable fails closed for non-admins, which is the
        // correct sealed-room behavior).
        let projectGrantsAxis:
          | Awaited<ReturnType<typeof readProjectGrantsForUser>>
          | undefined;
        if (name === "chat_thread_update" && actorUserId && actorOrgId) {
          try {
            const teamIds = (
              await readTeamsForUser(actorUserId, actorOrgId)
            ).map((t) => t.id);
            projectGrantsAxis = await readProjectGrantsForUser(
              actorUserId,
              actorOrgId,
              { teamIds },
            );
          } catch {
            projectGrantsAxis = [];
          }
        }

        const result = await handler({
          primitiveName: name,
          input,
          actor: {
            actorType: "model",
            source: "agent",
            ...(effectiveClientId ? { clientId: effectiveClientId } : {}),
            // Propagate the transport-verified human userId / orgId /
            // platformRole so chat_thread_send can drive chat orchestration
            // in-process without re-parsing the Bearer token in the handler.
            //
            // BUT: when the caller has explicitly self-asserted an assistant
            // identity via `assistantClientId`, suppress userId so
            // `resolveActorFromRequest` routes through the clientId branch
            // (assistant identity wins — this is the documented override path).
            ...(actorUserId && !selfAssertedClientId ? { userId: actorUserId } : {}),
            ...(actorOrgId ? { orgId: actorOrgId } : {}),
            ...(actorPlatformRole ? { platformRole: actorPlatformRole } : {}),
            ...(projectGrantsAxis ? { projectGrants: projectGrantsAxis } : {}),
          },
          mode: "agentic",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: Array.isArray(result)
            ? { items: result }
            : (result as Record<string, unknown>),
        };
      }) as any,
    );
  }
}
