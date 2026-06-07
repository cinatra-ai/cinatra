import "server-only";

import { z } from "zod";
import { getAuthSession, requireActorContext, isPlatformAdmin } from "@/lib/auth-session";
import { hasConfiguredLlmRuntime, runChatTurn, type ChatRequestMessage } from "./runner";

// ---------------------------------------------------------------------------
// POST /api/chat — browser entry point. Cookie-authenticated. SSE response.
// MCP callers go through chat_thread_send, which invokes runChatTurn directly
// in-process (no HTTP, no cookie required).
//
// Runtime attachment-ref validation.
// The request body is parsed with the same strict attachment schema as the
// bridge route. A plain cast would let clients submit `attachments[].versionId`,
// which leaves `ref.representationRevisionId === undefined` and forces the
// resolver to degrade the attachment as unreadable. Every attachment MUST carry
// `representationRevisionId`; otherwise the request is rejected with 400
// fail-loud.
// ---------------------------------------------------------------------------

const attachmentRefSchema = z
  .object({
    artifactId: z.string().min(1),
    representationRevisionId: z.string().min(1),
    digest: z.string().min(1),
    mime: z.string().min(1),
    originKind: z.enum([
      "upload",
      "email_attachment",
      "agent_generated",
      "external_link",
      "live_generator",
    ]),
    title: z.string().optional(),
    filename: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();

const chatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    attachments: z.array(attachmentRefSchema).max(20).optional(),
  })
  .strict();

const chatBodySchema = z.object({
  messages: z.array(chatMessageSchema),
});

export async function POST(request: Request) {
  const raw = (await request.json()) as unknown;
  const parsed = chatBodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid chat request shape", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body: { messages: ChatRequestMessage[] } = parsed.data;

  const hasProvider = await hasConfiguredLlmRuntime();
  if (!hasProvider) {
    return Response.json({ error: "No LLM provider configured." }, { status: 400 });
  }

  const session = await getAuthSession();
  const userId = session?.user?.id;
  const actorContext = await requireActorContext();
  const platformRole: "platform_admin" | "member" = isPlatformAdmin(session)
    ? "platform_admin"
    : "member";
  const sessionOrgId =
    (session?.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      try {
        await runChatTurn({
          messages: body.messages,
          actorContext,
          userId,
          platformRole,
          sessionOrgId,
          send,
        });
      } catch (err) {
        // Any throw from runChatTurn (e.g. fail-loud `buildSkillTools` guard,
        // preflight failures) must reach the client as a structured SSE error,
        // not a silent stream close.
        const message =
          err instanceof Error ? err.message : "Chat request failed.";
        try {
          send("error", { message });
        } catch {
          // Controller may already be torn down; swallow.
        }
        console.error("[chat] runChatTurn threw:", err);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
