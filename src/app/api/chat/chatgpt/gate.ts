import "server-only";

import { can } from "@/lib/authz";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ResourceRef } from "@/lib/authz/resource-ref";
import { logAuditEventStrict } from "@/lib/authz/audit";

// ---------------------------------------------------------------------------
// Authorization + audit gate for the server-side Codex bridge
// (/api/chat/chatgpt). The POST handler spawns `codex exec --sandbox
// read-only` with caller-supplied prompt text (120s child per call). The
// read-only sandbox blocks writes but NOT source/config disclosure via the
// command output, and the spawn is a real server-side resource cost. So this
// is treated as a platform OPERATOR power, not an ordinary authenticated
// action.
//
// Gate (mirrors the QueueDash operator gate in
// src/app/api/admin/operations/jobs/[...trpc]/gate.ts):
//   - Authenticate -> 401 on no session.
//   - Authorize against the org-less `operations` platform resource with
//     `operations.execute` -> only platform_admin passes (fail-closed).
//   - Strict pre-spawn audit row; an audit-write failure aborts (503) BEFORE
//     anything is spawned.
//   - Body/prompt size cap so a single call cannot pass an unbounded prompt
//     to the child process.
// ---------------------------------------------------------------------------

/** Org-less platform resource — forces a platform-only authority check. */
const OPERATIONS_RESOURCE: ResourceRef = {
  resourceType: "operations",
  resourceId: "*",
};

/**
 * Maximum total size of the inbound chat body, in bytes, measured on the raw
 * request text BEFORE JSON parse. Caps the prompt that can be handed to the
 * spawned Codex child and bounds parse cost. The Codex bridge itself only uses
 * the last 10 messages, so this is a generous-but-finite ceiling.
 */
export const MAX_CHAT_BODY_BYTES = 32 * 1024; // 32 KiB

export type CodexGateDecision =
  | { kind: "allow" }
  | { kind: "deny"; status: number; reason: string };

/**
 * Authorize a Codex-bridge invocation: authenticate, enforce the platform
 * operator power, and write a strict audit row BEFORE the child is spawned.
 * Returns allow/deny; any failure denies and nothing is spawned.
 */
export async function authorizeCodexBridgeRequest(args: {
  actor: ActorContext | undefined;
  requestId?: string;
}): Promise<CodexGateDecision> {
  const { actor, requestId } = args;

  // 1. Authenticate. No session -> 401 (do NOT redirect an API call).
  if (!actor) {
    return { kind: "deny", status: 401, reason: "Authentication required." };
  }

  // 2. Authorize. Platform operator power only.
  if (!can(actor, "operations.execute", OPERATIONS_RESOURCE)) {
    return { kind: "deny", status: 403, reason: "Operator authorization required." };
  }

  // 3. Strict pre-spawn audit. A write failure aborts before any spawn.
  try {
    await logAuditEventStrict({
      actorPrincipalId: actor.principalId,
      actorPrincipalType: "human",
      authSource: "route",
      organizationId: actor.organizationId,
      resourceType: "operations",
      resourceId: "chat:codex-bridge",
      operation: "chat.codex.invoke",
      decision: "allowed",
      policyVersion: actor.policyVersion,
      metadata: {
        ...(requestId ? { requestId } : {}),
      },
    });
  } catch {
    return { kind: "deny", status: 503, reason: "audit write failed" };
  }

  return { kind: "allow" };
}

// ---------------------------------------------------------------------------
// In-process chat bridge gate (engineering#339)
//
// The `@chatgpt` / `@gemini` chat-mention path in
// packages/chat/src/mcp/handlers.ts spawns the SAME host Codex / Gemini CLI
// child as the /api/chat/chatgpt route, on the host's provider credentials,
// but is reachable by an ordinary authenticated org member via direct MCP
// (chat_thread_send is classified `object.create`, NOT operator-only). That is
// a privilege mismatch: the route treats host CLI invocation as platform
// OPERATOR power; the chat path admitted org members — an authenticated
// credit-drain / host-context disclosure vector.
//
// This helper applies the IDENTICAL gate (operator authz + strict pre-spawn
// audit) plus the equivalent prompt-byte bound to that in-process call site,
// BEFORE the child is spawned. Bounds alone are insufficient (the primary gap
// is privilege), so authz runs first and a denial never spawns anything.
// ---------------------------------------------------------------------------

export type ChatBridgeGateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

/**
 * Authorize an in-process chat-mention bridge invocation (`@chatgpt` /
 * `@gemini`). Enforces the same platform-operator power and strict pre-spawn
 * audit as {@link authorizeCodexBridgeRequest}, plus a prompt-byte bound
 * equivalent to {@link MAX_CHAT_BODY_BYTES}, before any host CLI child is
 * spawned. Returns allow/deny; any failure denies and nothing is spawned.
 *
 * @param bridge   Bridge label (e.g. "chatgpt" / "gemini") — audit metadata
 *                 + reason text only; the authority required is identical.
 * @param actor    Caller's resolved ActorContext (undefined => unauthenticated).
 * @param prompt   The raw user message that would be handed to the child.
 */
export async function authorizeChatBridgeMention(args: {
  bridge: string;
  actor: ActorContext | undefined;
  prompt: string;
  requestId?: string;
}): Promise<ChatBridgeGateDecision> {
  const { bridge, actor, prompt, requestId } = args;

  // 1. Authenticate.
  if (!actor) {
    return { kind: "deny", reason: `@${bridge} failed: authentication required.` };
  }

  // 2. Authorize — platform operator power only. An ordinary org member fails
  //    closed here (this is the core fix for engineering#339).
  if (!can(actor, "operations.execute", OPERATIONS_RESOURCE)) {
    return {
      kind: "deny",
      reason: `@${bridge} failed: operator authorization required.`,
    };
  }

  // 3. Prompt-byte bound — equivalent to the route's raw-body cap so a single
  //    mention cannot hand an unbounded prompt to the spawned child.
  if (Buffer.byteLength(prompt, "utf8") > MAX_CHAT_BODY_BYTES) {
    return { kind: "deny", reason: `@${bridge} failed: prompt too large.` };
  }

  // 4. Strict pre-spawn audit. A write failure aborts before any spawn.
  try {
    await logAuditEventStrict({
      actorPrincipalId: actor.principalId,
      actorPrincipalType: "human",
      authSource: "mcp",
      organizationId: actor.organizationId,
      resourceType: "operations",
      resourceId: "chat:codex-bridge",
      operation: "chat.codex.invoke",
      decision: "allowed",
      policyVersion: actor.policyVersion,
      metadata: {
        bridge,
        ...(requestId ? { requestId } : {}),
      },
    });
  } catch {
    return { kind: "deny", reason: `@${bridge} failed: audit write failed.` };
  }

  return { kind: "allow" };
}
