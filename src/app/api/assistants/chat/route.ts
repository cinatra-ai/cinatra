import "server-only";

import { z } from "zod";
import { getAuthSession, requireActorContext, isPlatformAdmin } from "@/lib/auth-session";
import { hasConfiguredLlmRuntime, runChatTurn, type ChatRequestMessage } from "@/app/api/chat/runner";
import {
  authorizeThreadForTurn,
  streamAgUiChatTurn,
} from "@/lib/assistant-runtime/ag-ui-stream-route";
import { runAssistantTurn } from "@/lib/assistant-runtime/runtime";
import { resolveAssistantRuntimeConfigByPrincipal } from "@/lib/assistant-runtime/resolve-runtime-config";
import { resolveAssistantHandles } from "@/lib/better-auth-db";

// ---------------------------------------------------------------------------
// POST /api/assistants/chat — the Cinatra assistant AG-UI endpoint
// (cinatra#1218, epic #1216 S2; realizes #1037 P3's wire half).
//
// One /chat turn on the ONE wire: the caller's messages drive the assistant
// runtime (`runChatTurn` — the #1037 P2 producer) through the shared AG-UI
// streaming harness (`streamAgUiChatTurn`) — the durable Redis-Streams log
// substrate, turn linkage, TOCTOU-safe thread binding, abort lifecycle, and
// resume window all live in the harness so the @chatgpt bridge endpoint reuses
// them verbatim (cinatra#1218 predecessor 3). This route owns exactly the
// producer choice + the validation/auth posture; behavior is byte-identical to
// before the extraction (the harness is the same code).
//
// AUTH + THREAD BINDING. Cookie session (same posture as POST /api/chat), and
// the caller-supplied threadId is authorized against the PERSISTED ownership
// axes — never against request-body claims (the exact POST /api/chat/save
// matrix): personal → owner-or-admin; team → member-of-owning-org-or-admin;
// legacy unowned → allowed; absent → claimed for the caller.
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

const assistantChatBodySchema = z.object({
  threadId: z.string().min(1).max(200),
  messages: z.array(chatMessageSchema),
  // OPTIONAL assistant selector (cinatra#1823, epic #1037 P4.1): the mention
  // handle of the registered assistant to drive this turn (e.g. "wordpress",
  // "drupal", "cinatra"). ABSENT = the built-in @cinatra binding (backward
  // compatible — the historical single-assistant behaviour). When present, the
  // turn is driven by that assistant's OWN persisted `assistant_config` resolved
  // through its `assistant_user_id` link — never the hardcoded Cinatra fallback.
  assistant: z.string().min(1).max(200).optional(),
});

export async function POST(request: Request) {
  const raw = (await request.json().catch(() => null)) as unknown;
  const parsed = assistantChatBodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid assistant chat request shape", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { threadId } = parsed.data;
  const messages: ChatRequestMessage[] = parsed.data.messages;

  const hasProvider = await hasConfiguredLlmRuntime();
  if (!hasProvider) {
    return Response.json({ error: "No LLM provider configured." }, { status: 400 });
  }

  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const actorContext = await requireActorContext();
  const isAdmin = isPlatformAdmin(session);
  const platformRole: "platform_admin" | "member" = isAdmin ? "platform_admin" : "member";
  const sessionOrgId =
    (session?.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;

  const authz = authorizeThreadForTurn({
    threadId,
    callerId: userId,
    isAdmin,
    sessionOrgId,
  });
  if (!authz.ok) {
    return Response.json({ error: authz.error }, { status: authz.status });
  }

  // Producer selection (cinatra#1823, epic #1037 P4.1). ABSENT `assistant` keeps
  // the historical @cinatra binding (`runChatTurn`, byte-identical). A selector
  // resolves the target assistant's OWN runtime config from its PERSISTED sidecar
  // via the `assistant_user_id` link (the generalized resolution ladder) and
  // drives the SAME extracted runtime — so WordPress/Drupal (or any registered
  // assistant) are reachable here under the SAME authorization policy as @cinatra
  // (the thread-binding authz above is unchanged). An unknown handle or an
  // unresolvable/corrupt config fails CLOSED (404) — never a Cinatra fallback for
  // a non-built-in principal.
  let runProducer: Parameters<typeof streamAgUiChatTurn>[0]["runProducer"];
  if (parsed.data.assistant === undefined) {
    runProducer = (send, signal) =>
      runChatTurn({ messages, actorContext, userId, platformRole, sessionOrgId, send, signal });
  } else {
    const handle = parsed.data.assistant.trim().toLowerCase();
    const resolvedHandles = await resolveAssistantHandles([handle]);
    const assistantUserId = resolvedHandles.get(handle);
    if (!assistantUserId) {
      return Response.json({ error: "Assistant not found" }, { status: 404 });
    }
    const resolved = await resolveAssistantRuntimeConfigByPrincipal({ assistantUserId, handle });
    if (!resolved.ok) {
      return Response.json({ error: "Assistant not found" }, { status: 404 });
    }
    const runtimeConfig = resolved.runtimeConfig;
    runProducer = (send, signal) =>
      runAssistantTurn(runtimeConfig, {
        messages,
        actorContext,
        userId,
        platformRole,
        sessionOrgId,
        send,
        signal,
      });
  }

  return streamAgUiChatTurn({
    request,
    threadId,
    mirrorOrgId: authz.mirrorOrgId,
    needsStructuredRow: authz.needsStructuredRow,
    userId,
    isAdmin,
    runProducer,
  });
}
