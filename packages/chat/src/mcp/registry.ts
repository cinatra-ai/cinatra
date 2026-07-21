import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { createChatPrimitiveHandlers } from "./handlers";

// cinatra#1037 P5.6 PR2 CUTOVER final teardown (owner ruling 2026-07-21): the
// broad chat_thread_* primitives (list/get/send/update, pause/resume) are
// RETIRED. Only the two narrow external-assistant reply primitives remain, and
// they read/write the AUTHORITATIVE structured store — no chat_thread_update
// project-move surface survives, so the projectGrants resolution the update
// primitive needed is gone with it.
const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "chat_mentions_poll": {
    description:
      "Poll for pending @mentions directed at the calling assistant. " +
      "Returns user messages where this assistant was @mentioned and mentionState is 'pending' " +
      "(each item carries threadId + messageId). " +
      "Reply with chat_mention_reply(threadId, messageId, message) — it appends your reply into the " +
      "mentioned thread and marks that mention handled. " +
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
  // Narrow mention-reply primitive (cinatra#1037 P5.6 PR2 CUTOVER). Replies into
  // the MENTIONED thread ONLY; authorized SOLELY by the pending mention's
  // audience (the assistant must have a 'pending' mention on this exact
  // threadId+messageId). NO assistantClientId self-assertion — a real
  // client_credentials assistant identity is required (see registry wiring: this
  // tool is NOT in the self-assertion set).
  "chat_mention_reply": {
    description:
      "Reply to a pending @mention. Appends your reply into the mentioned thread and marks that " +
      "mention handled. You must have been @mentioned in this exact message (threadId + messageId " +
      "come from chat_mentions_poll) and be authenticated with client_credentials.",
    inputSchema: z.object({
      threadId: z.string().describe("The thread of the mention (from chat_mentions_poll)."),
      messageId: z.string().describe("The user message id that @mentioned you (from chat_mentions_poll)."),
      message: z.string().describe("Your reply text."),
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

        // For chat_mentions_poll: allow an assistant to self-identify via
        // assistantClientId when their session token doesn't carry client_credentials.
        // TODO: replace with proper OAuth client_credentials when assistant secrets are stored.
        const selfAssertedClientId =
          name === "chat_mentions_poll" &&
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

        const result = await handler({
          primitiveName: name,
          input,
          actor: {
            actorType: "model",
            source: "agent",
            ...(effectiveClientId ? { clientId: effectiveClientId } : {}),
            // Propagate the transport-verified human userId / orgId /
            // platformRole so the mention handlers resolve identity without
            // re-parsing the Bearer token in the handler.
            //
            // BUT: when the caller has explicitly self-asserted an assistant
            // identity via `assistantClientId`, suppress userId so
            // `resolveActorFromRequest` routes through the clientId branch
            // (assistant identity wins — this is the documented override path).
            ...(actorUserId && !selfAssertedClientId ? { userId: actorUserId } : {}),
            ...(actorOrgId ? { orgId: actorOrgId } : {}),
            ...(actorPlatformRole ? { platformRole: actorPlatformRole } : {}),
            // Transport-resolved org-membership role. Only stamped when the
            // transport userId is stamped too (i.e. NOT under the
            // self-asserted assistant identity override) — the role belongs
            // to the human caller's (userId, orgId) pair, and pairing it
            // with an assistant identity would cross identities.
            ...(actorUserId && !selfAssertedClientId && requestCtx?.orgRole
              ? { orgRole: requestCtx.orgRole }
              : {}),
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
