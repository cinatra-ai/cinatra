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
