import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { xaddRunEvent, readRecentRunEventsReverse, expireRunStream } from "@cinatra-ai/a2a";
import { resolveAssistantHandles, lookupAssistantHandlesByIds } from "@/lib/better-auth-db";
import {
  createAssistantThread,
  getAssistantThread,
  listAssistantThreadsForOrg,
  listAssistantThreadsForOrgVisibleTo,
  appendAssistantTurn,
  updateAssistantTurn,
  listAssistantTurns,
  touchAssistantThread,
  type AssistantThread,
  type AssistantTurn,
} from "@/lib/assistant-thread-store";
import { evaluateAssistantThreadAccess } from "@/lib/assistant-thread-access";
import {
  resolveAssistantMcpPolicy,
  safeParseAssistantConfig,
  type AssistantConfig,
  type AssistantMcpPolicy,
} from "@/lib/assistant-config";
import { readAssistantConfigByPrincipalId } from "@cinatra-ai/agents";
import {
  buildAssistantRuntimeConfig,
  type AssistantRuntimeConfig,
} from "@/lib/assistant-runtime/ports";
import {
  buildCinatraAssistantRuntimeConfig,
  cinatraAssistantConfig,
} from "@/lib/assistant-runtime/cinatra-assistant-config";
import { runAssistantTurn } from "@/lib/assistant-runtime/runtime";
import { resolveUserContextForUserId } from "@/lib/auth-session";
import { isAssistantInCallerAudience } from "@/lib/assistant-audience-closure";

// ---------------------------------------------------------------------------
// Generalized assistant MCP surface (cinatra#1037 P5.5).
//
// The platform-owned, registry-driven successor of the hardcoded chat_thread_*
// registration (packages/chat/src/mcp) — whose teardown is P5.6, so that
// surface stays UNTOUCHED here. Three parameterized tools over the STRUCTURED
// assistant_threads / assistant_turns store (P2.3) and the landed handle
// registry (P5.1, PR #1531):
//
//   assistant_send(handle, threadId?, message, waitMs?)
//     -> { status: 'completed'|'running', runId, threadId, finalMessage?, streamRef }
//     BOUNDED-WAIT (unlike the legacy unbounded chat_thread_send): on timeout
//     the turn keeps running server-side and the caller polls
//     assistant_thread_get; the turn's AG-UI-adjacent event trail is XADD'd to
//     the durable per-run stream (cinatra:a2a:events:{runId} — the SAME log the
//     stream contract owns), which `streamRef` names.
//   assistant_thread_list  — policy-filtered list over assistant_threads.
//   assistant_thread_get   — policy-filtered single-thread read (turns + the
//     recoverable per-turn text from the durable event log).
//
// AUTH — authorizeAssistantMcpTurn generalizes the G2 seam
// (evaluateChatThreadAccess) against the structured store; four components:
//   1. handle -> assistantUserId via the platform-unique handle REGISTRY
//      (resolveAssistantHandles). The registry is global; "org-scoped" applies
//      to the CALLER's authorization context, not handle uniqueness.
//   2. target access policy — the assistant-level `mcp.enabled/restriction`
//      sidecar block (src/lib/assistant-config.ts, new P5.5 ground). A
//      disabled/restricted target 404-hides.
//   3. thread/grant — evaluateAssistantThreadAccess (owner / bound-assistant
//      participant / platform-admin allow; cross-org + cross-user +
//      legacy-ownerless deny-to-non-admin; EVERY deny 404-hides).
//   4. NO self-asserted identity: the caller is resolved EXCLUSIVELY from
//      mcpRequestContextStorage (the transport-verified frame). There is no
//      assistantClientId analog — the legacy self-assertion path is NOT
//      carried forward, and the `.strict()` schemas REFUSE any smuggled
//      identity operand (userId / orgId / assistantClientId / platformRole).
//
// RUNTIME BINDING is handle-generic: handle -> assistantUserId -> the
// template-linked config (P1.3 LANDED — the 1:1 agent_templates.assistant_user_id
// link, resolveTemplateLinkedAssistantConfig) -> else the built-in Cinatra
// reference config for the built-in principal when no link is resolvable yet ->
// otherwise fail CLOSED as the sealed-room NOT_FOUND (a config-less principal is
// not an addressable target, and a distinguishable code would make assistant_send
// a handle-existence oracle over the platform-global registry; the real reason is
// logged server-side). A linked-but-CORRUPT sidecar also fails closed (never a
// silent fallback). Nothing here re-hardcodes Cinatra as "the" assistant — any
// principal with a valid linked assistant template resolves.
//
// AGENT-RUN OBO CEILING: assistant threads carry ORG scoping only, a sent turn
// runs with the target user's FULL server-resolved context, the platform-admin
// thread-access allow fires BEFORE the org seal, and driveTurn drives a NESTED
// turn under a fresh ceiling-less delegation token (the runtime mints
// `delegation:"chat"`). So this surface can honor NEITHER a sub-organization
// bound NOR the org floor itself, and it cannot propagate the ceiling into the
// nested turn. Fail-closed posture: EVERY agent-run OBO delegation (any
// `oboCeiling` on the frame) is denied on the whole surface until the ceiling
// can be expressed AND propagated. The MCP boundary's cannot-express gate
// (src/lib/authz/mcp-boundary.ts, surface "assistant") denies at the coarse
// boundary; resolveCaller() enforces the same handler-side as defense-in-depth.
//
// DELEGATED-CHAT POLICY (the epic's explicitly-open decision, resolved here):
// `assistant_send` keeps its name; its "send" verb token IS on
// DENIED_VERB_TOKENS and that is CORRECT — a prompt-injected delegated chat
// must not open turns with other assistants (recursion/abuse), exactly the
// rationale that keeps chat_thread_send off that perimeter today. NO CarveOut
// is added and NO rename is made; the deny is intentional and pinned by test.
// assistant_thread_list/get are likewise deny-by-default (not allowlisted).
//
// Never throws to the transport: every failure resolves to a structured
// envelope (guarded() backstop), and no raw exception text reaches the model.
// ---------------------------------------------------------------------------

/** The built-in reference assistant's registry handle (packages/chat/src/
 *  mentions.ts resolves the same literal for the default-mention path). */
const CINATRA_BUILTIN_HANDLE = "cinatra";

/** Bounded-wait window for assistant_send. The DEFAULT keeps a normal tool
 *  round-trip synchronous; the MAX keeps the MCP call bounded no matter what
 *  the caller asks for (the turn itself continues server-side after timeout). */
export const ASSISTANT_SEND_DEFAULT_WAIT_MS = 45_000;
export const ASSISTANT_SEND_MIN_WAIT_MS = 1_000;
export const ASSISTANT_SEND_MAX_WAIT_MS = 120_000;

/** How many of a thread's most recent turns get their text recovered from the
 *  durable event log on a get/history read (bounded Redis fan-out). */
const TURN_TEXT_RECOVERY_LIMIT = 10;

/** The ONE 404-hide envelope. An unresolvable handle, a registered handle with
 *  no runnable config, a disabled/restricted target, a missing thread, a
 *  cross-org/cross-user/ownerless-denied thread, and a thread bound to a
 *  different assistant are all BYTE-IDENTICAL — the sealed-room contract
 *  forbids a distinguishing error. */
const NOT_FOUND_CODE = "NOT_FOUND";
const NOT_FOUND_MESSAGE = "assistant thread or handle not found";

// ── agent-suppliable input schemas (`.strict()` refuses trust operands) ──────
// No orgId / userId / assistantClientId / platformRole is declared on ANY
// tool, and `.strict()` rejects them (fail-closed) if a caller supplies one.

const sendSchema = z
  .object({
    handle: z.string().min(1).max(120),
    threadId: z.string().min(1).optional(),
    message: z.string().min(1).max(64_000),
    waitMs: z
      .number()
      .int()
      .min(ASSISTANT_SEND_MIN_WAIT_MS)
      .max(ASSISTANT_SEND_MAX_WAIT_MS)
      .optional(),
  })
  .strict();

const listSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const getSchema = z
  .object({
    threadId: z.string().min(1),
  })
  .strict();

const TOOL_META = {
  assistant_send: {
    description:
      "Send a message to a platform assistant by its registry handle and wait (bounded) for the reply. You supply { handle, threadId?, message, waitMs? }; the host derives your identity and organization from the authenticated request — never pass a user/org/client identity. Omit threadId to start a new thread. Returns { status: 'completed', runId, threadId, finalMessage, streamRef } when the turn finishes within the wait window, or { status: 'running', runId, threadId, streamRef } on timeout — the turn keeps running; poll assistant_thread_get until the turn's status is 'completed' and read its text. An unknown handle or an inaccessible thread returns NOT_FOUND.",
    inputSchema: sendSchema,
  },
  assistant_thread_list: {
    description:
      "List the assistant threads visible to you in your active organization (owner, bound-assistant participant, or platform admin), most recently updated first. You supply { limit? }; the host derives your identity and organization. Returns { status: 'ok', threads: [{ threadId, title, assistantHandle, createdAt, updatedAt }] }. Read-only.",
    inputSchema: listSchema,
  },
  assistant_thread_get: {
    description:
      "Read one assistant thread you can access: its metadata and its turns (one turn per assistant run: { turnId, runId, role, status: 'running'|'completed'|'error', createdAt, text? }). text is recovered from the durable per-run event log for recent turns when still retained. Use this to poll a turn started by assistant_send. An inaccessible or unknown thread returns NOT_FOUND. Read-only.",
    inputSchema: getSchema,
  },
} as const;

// ── envelope helpers (mirrors src/lib/project-seam-mcp.ts) ───────────────────

function envelope(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function rejected(code: string, message: string, extra?: Record<string, unknown>) {
  return envelope({ status: "rejected", code, message, ...(extra ?? {}) });
}

function failed(code: string, message: string, extra?: Record<string, unknown>) {
  return envelope({ status: "failed", code, message, ...(extra ?? {}) });
}

/** The single sealed-room miss — byte-identical across every deny path. */
function notFound() {
  return rejected(NOT_FOUND_CODE, NOT_FOUND_MESSAGE);
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

/** Log a raw fault server-side and return ONLY a generic, display-safe message
 *  to the model — never the underlying exception text (provider internals,
 *  file paths, SQL). Mirrors the project-seam/approvals posture. */
function sanitize(context: string, err: unknown, generic: string): string {
  console.warn(`[assistant-mcp] ${context}:`, err instanceof Error ? err.message : err);
  return generic;
}

/** Never-throw backstop: any unexpected fault resolves to a structured,
 *  sanitized `failed` envelope instead of reaching the MCP transport. */
function guarded(handler: (input: unknown) => Promise<ReturnType<typeof envelope>>) {
  return async (input: unknown) => {
    try {
      return await handler(input);
    } catch (err) {
      return failed(
        "ASSISTANT_MCP_ERROR",
        sanitize("unhandled tool error", err, "the assistant tool encountered an unexpected error"),
      );
    }
  };
}

// ── caller identity (fail-closed; NEVER from tool input) ────────────────────

type ResolvedCaller = {
  userId: string;
  orgId: string;
  platformRole: "platform_admin" | "member";
};

type CallerResolution =
  | { ok: true; caller: ResolvedCaller }
  | { ok: false; code: "AUTH_REQUIRED"; message: string };

/**
 * Resolve the calling identity from the MCP request CONTEXT — the frame the
 * transport stamps after verifying the session cookie / OAuth Bearer / OBO
 * token. There is deliberately NO input-supplied override (the legacy
 * assistantClientId self-assertion path is NOT carried forward). Fail-closed:
 * no verified userId+orgId → refused; the delegated-chat restricted perimeter
 * is refused explicitly too (defense-in-depth — the tool policy already denies
 * these tools there); ANY agent-run OBO caller (an `oboCeiling` on the frame —
 * present iff `delegation === "agent_run"`) is refused likewise, org floor
 * included (defense-in-depth — the boundary's cannot-express "assistant" gate
 * denies it first; this surface can neither express nor propagate the ceiling,
 * see the module header).
 */
function resolveCaller(): CallerResolution {
  const ctx = mcpRequestContextStorage.getStore();
  if (ctx?.delegatedRestricted) {
    return {
      ok: false,
      code: "AUTH_REQUIRED",
      message: "a restricted delegated caller cannot use the assistant tools (fail-closed)",
    };
  }
  if (ctx?.oboCeiling && ctx.oboCeiling.length > 0) {
    return {
      ok: false,
      code: "AUTH_REQUIRED",
      message:
        "an agent-run caller cannot use the assistant tools — this surface cannot honor the OBO scope ceiling (fail-closed)",
    };
  }
  const userId = (ctx?.userId ?? "").trim();
  const orgId = (ctx?.orgId ?? "").trim();
  if (!userId || !orgId) {
    return {
      ok: false,
      code: "AUTH_REQUIRED",
      message:
        "no authenticated user/organization identity in the request context (fail-closed)",
    };
  }
  return {
    ok: true,
    caller: {
      userId,
      orgId,
      platformRole: ctx?.platformRole === "platform_admin" ? "platform_admin" : "member",
    },
  };
}

// ── handle-generic runtime-config resolution ─────────────────────────────────

type ResolvedAssistantTarget = {
  handle: string;
  assistantUserId: string;
  /** The parsed sidecar backing the policy decision (built-in reference config
   *  for the built-in principal; template-linked once P1.3 lands). */
  config: AssistantConfig | null;
};

/**
 * The P1.3 template-linked config lookup (cinatra#1037 P1.3 — LANDED). Resolves a
 * persisted assistant sidecar from a principal id through the 1:1
 * `agent_templates.assistant_user_id` link (readAssistantConfigByPrincipalId).
 * Three outcomes drive the handle-generic binding below:
 *   - `ok`      — a linked assistant template with a VALID sidecar; the surface
 *                 binds it (this is now the forward path for the built-in Cinatra
 *                 principal once its registration link is live);
 *   - `invalid` — a linked row exists but its persisted sidecar is MALFORMED;
 *                 the send fails CLOSED (never silently falls back to the
 *                 hardcoded reference config — that would hide the corruption);
 *   - `none`    — no linked assistant template for this principal (a store fault
 *                 degrades to this too, never a throw / oracle); the built-in
 *                 handle keeps its reference-config fallback, any other principal
 *                 fails closed.
 */
type LinkedConfigResolution =
  | { kind: "ok"; config: AssistantConfig }
  | { kind: "invalid" }
  | { kind: "none" };

async function resolveTemplateLinkedAssistantConfig(
  assistantUserId: string,
): Promise<LinkedConfigResolution> {
  let raw: string | null;
  try {
    raw = await readAssistantConfigByPrincipalId(assistantUserId);
  } catch (err) {
    sanitize(`readAssistantConfigByPrincipalId(${assistantUserId})`, err, "");
    return { kind: "none" };
  }
  if (raw == null) return { kind: "none" };
  const parsed = safeParseAssistantConfig(raw);
  if (!parsed.ok) {
    sanitize(`assistant_config parse(${assistantUserId})`, parsed.error, "");
    return { kind: "invalid" };
  }
  return { kind: "ok", config: parsed.config };
}

/** Resolve the effective MCP target policy for a resolved principal. An
 *  unresolvable config falls back to the built-in default policy ONLY for the
 *  built-in principal; other principals keep their (future) linked config's
 *  policy — today they fail closed at config resolution before policy matters
 *  for send, and list/get do not consult the target policy at all (it gates
 *  ADDRESSABILITY, not a caller's access to their own threads). */
function policyFor(target: ResolvedAssistantTarget): AssistantMcpPolicy {
  return resolveAssistantMcpPolicy(target.config ?? {});
}

type RuntimeConfigResolution =
  | { ok: true; runtimeConfig: AssistantRuntimeConfig }
  | { ok: false; code: "ASSISTANT_CONFIG_UNAVAILABLE" };

/**
 * handle-generic config resolution: attempt the template-linked config first,
 * fall back to the built-in Cinatra reference config for the built-in
 * principal, otherwise fail closed (structured — never a raw exception).
 */
async function resolveRuntimeConfigForTarget(
  target: ResolvedAssistantTarget,
): Promise<RuntimeConfigResolution> {
  const linked = await resolveTemplateLinkedAssistantConfig(target.assistantUserId);
  if (linked.kind === "ok") {
    // P1.3 forward path: build from the persisted sidecar with defaults.
    return { ok: true, runtimeConfig: buildAssistantRuntimeConfig(linked.config) };
  }
  if (linked.kind === "invalid") {
    // A corrupt linked sidecar fails CLOSED — never fall back to the reference
    // config (that would mask corruption). 404-hidden at the call site.
    return { ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" };
  }
  // kind === "none": no linked template. The built-in Cinatra principal keeps the
  // reference config (transitional until its registration link is resolvable);
  // any other principal fails closed.
  if (target.handle === CINATRA_BUILTIN_HANDLE) {
    return { ok: true, runtimeConfig: buildCinatraAssistantRuntimeConfig() };
  }
  return { ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" };
}

// ── authorizeAssistantMcpTurn (the generalized G2 seam) ──────────────────────

type TurnAuthorization =
  | {
      ok: true;
      target: ResolvedAssistantTarget;
      /** The existing thread when threadId was supplied; null = create new. */
      thread: AssistantThread | null;
    }
  | { ok: false; miss: ReturnType<typeof envelope> };

/**
 * Input-time authorization for an assistant_send turn: (1) org-scoped caller
 * (already resolved fail-closed), (2) handle -> assistantUserId via the
 * registry, (3) the assistant-level mcp.enabled/restriction target policy,
 * (4) the thread/grant check against the structured store. EVERY deny returns
 * the ONE byte-identical NOT_FOUND envelope (sealed-room 404-hide).
 */
export async function authorizeAssistantMcpTurn(
  caller: ResolvedCaller,
  handle: string,
  threadId: string | undefined,
): Promise<TurnAuthorization> {
  // (2) handle resolution — registry-only, platform-unique.
  const normalized = handle.trim().toLowerCase();
  const resolvedHandles = await resolveAssistantHandles([normalized]);
  const assistantUserId = resolvedHandles.get(normalized);
  if (!assistantUserId) return { ok: false, miss: notFound() };

  // (2b) AUDIENCE CLOSURE (cinatra#1875 W2, AC#6). The handle registry is
  // platform-GLOBAL, so a resolved handle alone is not authorization to address
  // it: the caller must also be IN THE ASSISTANT'S AUDIENCE. Evaluated ACTOR-SIDE
  // at turn creation through the SAME W1 audience-filtered registry the browser
  // surfaces use (the builtin stays universally visible; every installed
  // assistant is gated by its `assistant_audience` grants). A forged
  // out-of-audience target 404-hides, byte-identical with an unresolvable handle.
  // Because this runs per send, a shrunk audience denies the NEXT turn while any
  // already-queued delivery completes (the revocation contract).
  const inAudience = await isAssistantInCallerAudience(assistantUserId, caller);
  if (!inAudience) return { ok: false, miss: notFound() };

  // (3) target access policy (mcp.enabled/restriction). The config source is
  // the same resolution ladder the runtime binding uses; a principal with no
  // resolvable config carries the platform-default policy at this step (its
  // send still fails closed later at config resolution).
  const linked = await resolveTemplateLinkedAssistantConfig(assistantUserId);
  const config =
    linked.kind === "ok"
      ? linked.config
      : linked.kind === "none" && normalized === CINATRA_BUILTIN_HANDLE
        ? cinatraAssistantConfig
        : null;
  const target: ResolvedAssistantTarget = { handle: normalized, assistantUserId, config };
  const policy = policyFor(target);
  if (!policy.enabled) return { ok: false, miss: notFound() };
  if (policy.restriction === "platform-admins" && caller.platformRole !== "platform_admin") {
    return { ok: false, miss: notFound() };
  }

  // (4) thread/grant — the generalized G2 decision over the structured store.
  if (!threadId) return { ok: true, target, thread: null };
  const thread = getAssistantThread(threadId);
  if (!thread) return { ok: false, miss: notFound() };
  const allowed = evaluateAssistantThreadAccess({
    threadAssistantUserId: thread.assistantUserId,
    threadOwnerUserId: thread.ownerUserId,
    threadOrgId: thread.orgId,
    actorUserId: caller.userId,
    actorOrgId: caller.orgId,
    isPlatformAdmin: caller.platformRole === "platform_admin",
  });
  if (!allowed) return { ok: false, miss: notFound() };
  // A thread bound to a DIFFERENT assistant principal does not exist "for this
  // handle" — 404-hide rather than cross-bind. An unbound thread (null — e.g.
  // a legacy-mirror row) is targetable; the turn rows carry attribution.
  if (thread.assistantUserId && thread.assistantUserId !== assistantUserId) {
    return { ok: false, miss: notFound() };
  }
  return { ok: true, target, thread };
}

// ── durable per-turn event trail ─────────────────────────────────────────────
//
// The structured store persists turn METADATA + the run pointer only (P2.3
// contract — no double persistence); the text rides the durable per-run
// Redis-Streams log the stream contract owns (cinatra:a2a:events:{runId}).
// assistant_send XADDs the user message and the terminal frame under the
// minted runId so a poller (assistant_thread_get) and a future AG-UI
// subscriber read one trail. Recovery is BEST-EFFORT: streams are trimmed +
// TTL'd after terminal, so old turns legitimately return text: null.

const EVENT_CHANNEL = "assistant-mcp";

function streamRefFor(runId: string): string {
  return `cinatra:a2a:events:${runId}`;
}

type RecoveredTerminal = { kind: "final"; text: string } | { kind: "error" } | null;

/** Read the turn's TERMINAL frame from the durable stream, when retained.
 *  Doubles as the read-time reconciliation source: the terminal frame is
 *  authoritative when the turn ROW missed its status update (codex round-1
 *  #2 — a transiently-failed terminalization must not leave a poller on
 *  'running' forever while the stream already carries the outcome). */
async function recoverTurnTerminal(runId: string): Promise<RecoveredTerminal> {
  try {
    const entries = await readRecentRunEventsReverse(runId, 50);
    for (const { event } of entries) {
      if (event.channel !== EVENT_CHANNEL) continue;
      if (event.type === "final_message" && typeof event.content === "string") {
        return { kind: "final", text: event.content };
      }
      if (event.type === "turn_error") {
        return { kind: "error" };
      }
    }
  } catch (err) {
    sanitize(`recoverTurnTerminal(${runId})`, err, "");
  }
  return null;
}

/** Best-effort conversation reconstruction for a continuation send: for each
 *  prior assistant turn (newest-bounded), read its user_message +
 *  final_message frames from the durable log. Turns whose streams have been
 *  trimmed/expired are skipped — degradation is documented tool behavior. */
async function reconstructThreadMessages(
  turns: AssistantTurn[],
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const assistantTurns = turns
    .filter((t) => t.role === "assistant" && t.runId)
    .slice(-TURN_TEXT_RECOVERY_LIMIT);
  for (const turn of assistantTurns) {
    try {
      const entries = await readRecentRunEventsReverse(turn.runId as string, 50);
      let userMessage: string | null = null;
      let finalMessage: string | null = null;
      for (const { event } of entries) {
        if (event.channel !== EVENT_CHANNEL) continue;
        if (finalMessage === null && event.type === "final_message" && typeof event.content === "string") {
          finalMessage = event.content;
        }
        if (userMessage === null && event.type === "user_message" && typeof event.content === "string") {
          userMessage = event.content;
        }
      }
      if (userMessage) messages.push({ role: "user", content: userMessage });
      if (finalMessage) messages.push({ role: "assistant", content: finalMessage });
    } catch (err) {
      sanitize(`reconstructThreadMessages(${turn.id})`, err, "");
    }
  }
  return messages;
}

// ── assistant_send ───────────────────────────────────────────────────────────

async function handleSend(input: unknown) {
  const parsed = sendSchema.safeParse(input ?? {});
  if (!parsed.success) return rejected("INVALID_INPUT", zodMessage(parsed.error));

  const resolution = resolveCaller();
  if (!resolution.ok) return rejected(resolution.code, resolution.message);
  const { caller } = resolution;

  const { handle, threadId, message } = parsed.data;
  const waitMs = parsed.data.waitMs ?? ASSISTANT_SEND_DEFAULT_WAIT_MS;

  const auth = await authorizeAssistantMcpTurn(caller, handle, threadId);
  if (!auth.ok) return auth.miss;
  const { target } = auth;

  // Handle-generic runtime binding (fail-closed for a config-less principal).
  const configRes = await resolveRuntimeConfigForTarget(target);
  if (!configRes.ok) {
    // A registered handle with NO runnable config is not an ADDRESSABLE
    // target — 404-hide it, byte-identical with an unresolvable handle. A
    // distinguishable code here would make assistant_send a platform-global
    // handle-existence oracle (the registry is global; the caller may have no
    // relationship to the owning principal). The real reason is logged
    // server-side for operators.
    sanitize(`config resolution(${target.handle})`, configRes.code, "");
    return notFound();
  }

  // Resolve or create the structured thread (owner = the verified caller).
  let thread = auth.thread;
  let priorTurns: AssistantTurn[] = [];
  if (thread) {
    priorTurns = listAssistantTurns(thread.id);
  } else {
    thread = createAssistantThread({
      assistantUserId: target.assistantUserId,
      ownerUserId: caller.userId,
      orgId: caller.orgId,
      title: message.slice(0, 60),
    });
  }

  // Persist the user turn + the running assistant turn (one AG-UI run).
  const runId = randomUUID();
  appendAssistantTurn({ threadId: thread.id, role: "user", status: "completed" });
  const assistantTurn = appendAssistantTurn({
    threadId: thread.id,
    runId,
    assistantUserId: target.assistantUserId,
    role: "assistant",
    status: "running",
  });

  // From here the turn row exists at status 'running' — NOTHING between here
  // and driveTurn (whose own error handling terminalizes) may strand it. Any
  // pre-drive fault finalizes the row as an error before surfacing the
  // structured failure (codex round-0 #2a).
  let turnPromise: Promise<TurnOutcome>;
  try {
    touchAssistantThread(thread.id);

    // Durable trail: the user message opens the run's event stream.
    try {
      await xaddRunEvent(runId, { channel: EVENT_CHANNEL, type: "user_message", content: message });
    } catch (err) {
      sanitize("xadd user_message", err, ""); // stream is best-effort; the turn proceeds
    }

    // Best-effort history for a continuation (see reconstructThreadMessages doc).
    const history = priorTurns.length > 0 ? await reconstructThreadMessages(priorTurns) : [];

    // Drive the turn. driveTurn OWNS all terminal persistence (turn row + event
    // log) so the bounded-wait race below can time out without dropping it.
    turnPromise = driveTurn({
      runId,
      turnId: assistantTurn.id,
      runtimeConfig: configRes.runtimeConfig,
      caller,
      messages: [...history, { role: "user", content: message }],
    });
  } catch (err) {
    const generic = sanitize(`pre-drive(${runId})`, err, "the assistant turn failed unexpectedly");
    await finalizeTurn(runId, assistantTurn.id, { error: generic });
    return failed("TURN_FAILED", generic, {
      runId,
      threadId: thread.id,
      streamRef: streamRefFor(runId),
    });
  }

  // Bounded wait. The timer is cleared on early completion so a finished call
  // does not retain a timer for the full window (codex round-0 #6).
  let waitTimer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    turnPromise,
    new Promise<"timeout">((resolve) => {
      waitTimer = setTimeout(() => resolve("timeout"), waitMs);
    }),
  ]).finally(() => clearTimeout(waitTimer));

  if (outcome === "timeout") {
    // The turn continues server-side; driveTurn's own error handling keeps the
    // dangling promise from ever rejecting unhandled.
    return envelope({
      status: "running",
      runId,
      threadId: thread.id,
      streamRef: streamRefFor(runId),
      message: `the turn is still running after ${waitMs}ms — poll assistant_thread_get for threadId "${thread.id}" until the turn completes`,
    });
  }

  if (!outcome.ok) {
    return failed(outcome.code, outcome.message, {
      runId,
      threadId: thread.id,
      streamRef: streamRefFor(runId),
    });
  }

  return envelope({
    status: "completed",
    runId,
    threadId: thread.id,
    finalMessage: outcome.text,
    streamRef: streamRefFor(runId),
  });
}

type TurnOutcome =
  | { ok: true; text: string }
  | { ok: false; code: string; message: string };

/** Run one assistant turn to terminal state and persist EVERYTHING (turn-row
 *  status, terminal event frame, stream TTL) regardless of whether the caller
 *  is still waiting. Never rejects. */
async function driveTurn(args: {
  runId: string;
  turnId: string;
  runtimeConfig: AssistantRuntimeConfig;
  caller: ResolvedCaller;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<TurnOutcome> {
  const { runId, turnId, runtimeConfig, caller, messages } = args;
  let text = "";
  let runtimeError: string | null = null;
  const toolResults: Array<{ name: string; resultLabel: string }> = [];
  try {
    // The caller's FULL actor context (teams, project grants) — resolved
    // server-side from the verified identity, exactly like the legacy MCP
    // send path (packages/chat/src/mcp/handlers.ts step 5).
    const userCtx = await resolveUserContextForUserId(caller.userId, {
      activeOrganizationId: caller.orgId,
      platformRole: caller.platformRole,
    });
    await runAssistantTurn(runtimeConfig, {
      messages,
      actorContext: userCtx.actorContext,
      userId: caller.userId,
      platformRole: userCtx.platformRole,
      sessionOrgId: userCtx.sessionOrgId,
      send: (event, data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        if (event === "text") {
          if (typeof d.content === "string" && d.content) text += d.content;
        } else if (event === "tool_result") {
          toolResults.push({
            name: String(d.name ?? ""),
            resultLabel: String(d.resultLabel ?? ""),
          });
        } else if (event === "error") {
          if (typeof d.message === "string" && d.message) runtimeError = d.message;
        }
      },
    });
    if (!text && toolResults.length > 0) {
      text =
        "The assistant completed the following actions:\n" +
        toolResults.map((r) => `- ${r.name}: ${r.resultLabel}`).join("\n");
    }
  } catch (err) {
    const generic = sanitize(`driveTurn(${runId})`, err, "the assistant turn failed unexpectedly");
    await finalizeTurn(runId, turnId, { error: generic });
    return { ok: false, code: "TURN_FAILED", message: generic };
  }

  if (runtimeError) {
    if (!text) {
      // Runtime 'error' events can carry upstream provider/SDK text (the LLM
      // stream error path forwards err.message) — treat them as server-side
      // detail like every other raw fault: log verbatim, surface + persist ONLY
      // the generic message (codex round-0 #3). The structured code is the
      // caller's actionable signal.
      const generic = sanitize(`runtime error(${runId})`, runtimeError, "the assistant turn failed");
      await finalizeTurn(runId, turnId, { error: generic });
      return { ok: false, code: "TURN_FAILED", message: generic };
    }
    // Partial text followed by a runtime error: the turn completes with the
    // streamed text (matching the legacy send path), but the raw error must
    // not vanish — log it server-side like every other raw fault (it is
    // still never surfaced to the caller or the durable log).
    sanitize(`runtime error(${runId}) after partial text`, runtimeError, "");
  }

  await finalizeTurn(runId, turnId, { text });
  return { ok: true, text };
}

/** Terminal persistence for one turn: the turn row's status, the terminal
 *  event frame, and the stream TTL. Best-effort on the stream side; the row
 *  update gets ONE retry (a transiently-failed update would otherwise leave a
 *  timed-out caller polling `running` forever — codex round-0 #2b; a doubly
 *  failed update is logged loudly as the residual gap). */
async function finalizeTurn(
  runId: string,
  turnId: string,
  terminal: { text: string } | { error: string },
): Promise<void> {
  const isError = "error" in terminal;
  const status = isError ? ("error" as const) : ("completed" as const);
  try {
    updateAssistantTurn(turnId, { status });
  } catch (err) {
    sanitize(`finalizeTurn(${turnId}) status`, err, "");
    try {
      updateAssistantTurn(turnId, { status });
    } catch (retryErr) {
      console.error(
        `[assistant-mcp] finalizeTurn(${turnId}): turn row could not be terminalized (status=${status}) — a poller may see 'running' until manual reconciliation:`,
        retryErr instanceof Error ? retryErr.message : retryErr,
      );
    }
  }
  try {
    await xaddRunEvent(
      runId,
      isError
        ? { channel: EVENT_CHANNEL, type: "turn_error", message: terminal.error }
        : { channel: EVENT_CHANNEL, type: "final_message", content: terminal.text },
    );
  } catch (err) {
    sanitize(`finalizeTurn(${turnId}) stream`, err, "");
  }
  // Independent of the terminal XADD: a failed frame write must not leave the
  // stream (which carries the user prompt) unexpired (codex round-0 #4).
  try {
    await expireRunStream(runId);
  } catch (err) {
    sanitize(`finalizeTurn(${turnId}) expire`, err, "");
  }
}

// ── assistant_thread_list ────────────────────────────────────────────────────

async function handleThreadList(input: unknown) {
  const parsed = listSchema.safeParse(input ?? {});
  if (!parsed.success) return rejected("INVALID_INPUT", zodMessage(parsed.error));

  const resolution = resolveCaller();
  if (!resolution.ok) return rejected(resolution.code, resolution.message);
  const { caller } = resolution;
  const limit = parsed.data.limit ?? 50;

  const isAdmin = caller.platformRole === "platform_admin";
  // Non-admins read through the store-side VISIBILITY predicate (owner OR
  // bound-assistant participant, org-sealed) so the page can never be crowded
  // out by newer rows the caller may not see (codex round-1 #1); admins read
  // the org-wide window. The pure decision is re-applied per row as
  // defense-in-depth against predicate drift — never the sole gate.
  const rows = isAdmin
    ? listAssistantThreadsForOrg(caller.orgId, limit)
    : listAssistantThreadsForOrgVisibleTo(caller.orgId, caller.userId, limit);
  const threads = rows.filter((t) =>
    evaluateAssistantThreadAccess({
      threadAssistantUserId: t.assistantUserId,
      threadOwnerUserId: t.ownerUserId,
      threadOrgId: t.orgId,
      actorUserId: caller.userId,
      actorOrgId: caller.orgId,
      isPlatformAdmin: isAdmin,
    }),
  );

  // Reverse handle lookup for display (registry-driven, no per-row query).
  const principalIds = [...new Set(threads.map((t) => t.assistantUserId).filter((v): v is string => !!v))];
  const handles = await lookupAssistantHandlesByIds(principalIds);

  return envelope({
    status: "ok",
    threads: threads.map((t) => ({
      threadId: t.id,
      title: t.title,
      assistantHandle: t.assistantUserId ? (handles.get(t.assistantUserId) ?? null) : null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  });
}

// ── assistant_thread_get ─────────────────────────────────────────────────────

async function handleThreadGet(input: unknown) {
  const parsed = getSchema.safeParse(input ?? {});
  if (!parsed.success) return rejected("INVALID_INPUT", zodMessage(parsed.error));

  const resolution = resolveCaller();
  if (!resolution.ok) return rejected(resolution.code, resolution.message);
  const { caller } = resolution;

  const thread = getAssistantThread(parsed.data.threadId);
  if (!thread) return notFound();
  const allowed = evaluateAssistantThreadAccess({
    threadAssistantUserId: thread.assistantUserId,
    threadOwnerUserId: thread.ownerUserId,
    threadOrgId: thread.orgId,
    actorUserId: caller.userId,
    actorOrgId: caller.orgId,
    isPlatformAdmin: caller.platformRole === "platform_admin",
  });
  if (!allowed) return notFound();

  const turns = listAssistantTurns(thread.id);
  // Bounded terminal-frame recovery for the most recent assistant turns —
  // BOTH already-terminal rows (text recovery) AND rows still marked
  // 'running' (read-time reconciliation, codex round-1 #2: when the stream
  // carries a terminal frame that the row's status update missed, the frame
  // is authoritative — the poller sees the terminal status and the row is
  // best-effort repaired, so a transiently-failed terminalization can never
  // strand a poller on 'running').
  const recoverable = new Set(
    turns
      .filter((t) => t.role === "assistant" && t.runId)
      .slice(-TURN_TEXT_RECOVERY_LIMIT)
      .map((t) => t.id),
  );
  const texts = new Map<string, string | null>();
  const reconciledStatus = new Map<string, "completed" | "error">();
  for (const t of turns) {
    if (!recoverable.has(t.id)) continue;
    const terminal = await recoverTurnTerminal(t.runId as string);
    if (!terminal) continue;
    if (terminal.kind === "final") texts.set(t.id, terminal.text);
    if (t.status === "running") {
      const repaired = terminal.kind === "final" ? ("completed" as const) : ("error" as const);
      reconciledStatus.set(t.id, repaired);
      try {
        updateAssistantTurn(t.id, { status: repaired });
      } catch (err) {
        sanitize(`reconcile(${t.id})`, err, "");
      }
    }
  }

  const handleMap = thread.assistantUserId
    ? await lookupAssistantHandlesByIds([thread.assistantUserId])
    : new Map<string, string>();

  return envelope({
    status: "ok",
    thread: {
      threadId: thread.id,
      title: thread.title,
      assistantHandle: thread.assistantUserId
        ? (handleMap.get(thread.assistantUserId) ?? null)
        : null,
      contextId: thread.contextId,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    },
    turns: turns.map((t) => ({
      turnId: t.id,
      runId: t.runId,
      role: t.role,
      status: reconciledStatus.get(t.id) ?? t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      ...(texts.has(t.id) ? { text: texts.get(t.id) } : {}),
      ...(t.runId ? { streamRef: streamRefFor(t.runId) } : {}),
    })),
  });
}

// ── registration ─────────────────────────────────────────────────────────────

export function registerAssistantMcpPrimitives(server: McpRuntimeToolServer): void {
  server.registerTool(
    "assistant_send",
    { title: "assistant_send", ...TOOL_META.assistant_send },
    guarded(handleSend) as never,
  );
  server.registerTool(
    "assistant_thread_list",
    { title: "assistant_thread_list", ...TOOL_META.assistant_thread_list },
    guarded(handleThreadList) as never,
  );
  server.registerTool(
    "assistant_thread_get",
    { title: "assistant_thread_get", ...TOOL_META.assistant_thread_get },
    guarded(handleThreadGet) as never,
  );
}

export function createAssistantMcpModule() {
  return { registerCapabilities: registerAssistantMcpPrimitives };
}
