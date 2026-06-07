/**
 * Typed `CarveOut` records for authorized boundary-enforcement exceptions.
 *
 * Every authorized bypass of deny-by-default boundary enforcement declares a
 * typed CarveOut entry here. The coverage check is bidirectional:
 *   (a) enforcement bypass without a registered CarveOut → CI fails.
 *   (b) registered CarveOut without a matching bypass → CI fails (stale).
 *
 * The delegated-chat exception for `workflow_draft_create` and
 * `workflow_draft_update` is represented here so the token-policy bypass has
 * a single typed source of truth.
 */

import type { Action } from "./registry";
import type { ResourceType } from "./resource-ref";

/**
 * Seven boundary perimeters where access must be checked:
 * MCP handler dispatch, server actions, RSC loaders, deterministic clients,
 * delegated chat tokens, route handlers, and BullMQ run-start triggers.
 */
export type BoundaryPerimeter =
  | "mcp_handler_dispatch"
  | "server_action"
  | "rsc_loader"
  | "deterministic_client"
  | "delegated_chat_token"
  | "route_handler"
  | "bullmq_trigger";

export type CarveOutRisk = "low" | "medium" | "high";

export type CarveOut = {
  primitiveName: string;
  resourceType: ResourceType;
  action: Action;
  boundary: BoundaryPerimeter;
  reason: string;
  risk: CarveOutRisk;
  /** Optional explicit replacement target. Coverage checks flag stale entries. */
  replacementPhase?: string;
  expiresAt?: string;
  reviewBy?: string;
  owningTeam: string;
  reviewedAt: string;
  reviewerId: string;
};

export type CarveOutRef = Pick<CarveOut, "primitiveName" | "boundary">;

// ---------------------------------------------------------------------------
// CARVE_OUTS — current list. Each entry is reviewed and signed off. Adding
// or removing entries flips the authorization coverage test.
// ---------------------------------------------------------------------------

export const CARVE_OUTS: readonly CarveOut[] = [
  // Delegated-chat exception. The chat-bridge token policy grants the
  // delegated assistant a write capability to author proposal drafts inside a
  // project context the user can write. The MCP boundary (perimeter 1) still
  // enforces the per-handler authorization that the token resolves to; this
  // carve-out gates ONLY the token policy (perimeter 5).
  {
    primitiveName: "workflow_draft_create",
    resourceType: "workflow_draft",
    action: "write",
    boundary: "delegated_chat_token",
    reason:
      "Delegated chat assistant authors proposal drafts in user-writable project context. Token-policy gate; MCP dispatch (perimeter 1) re-checks per-handler authz.",
    risk: "medium",
    replacementPhase: "Migrate token-policy gate to typed CarveOut consumer",
    owningTeam: "platform-authz",
    reviewedAt: "2026-05-20",
    reviewerId: "platform-authz-reviewer",
  },
  {
    primitiveName: "workflow_draft_update",
    resourceType: "workflow_draft",
    action: "update",
    boundary: "delegated_chat_token",
    reason:
      "Same as workflow_draft_create — CAS-guarded update authored by delegated chat under user-writable project context. Token-policy gate only.",
    risk: "medium",
    replacementPhase: "Migrate token-policy gate to typed CarveOut consumer",
    owningTeam: "platform-authz",
    reviewedAt: "2026-05-20",
    reviewerId: "platform-authz-reviewer",
  },
  {
    primitiveName: "dashboards_create",
    resourceType: "dashboard",
    action: "create",
    boundary: "delegated_chat_token",
    reason:
      "Delegated chat assistant authors dashboard drafts in user-writable scope. The dashboards_create handler enforces actor + canWrite + config validation + audit row in one transaction (mutation-service.ts:154-214). Token-policy gate only; MCP dispatch re-checks per-handler authz.",
    risk: "medium",
    owningTeam: "platform-authz",
    reviewedAt: "2026-05-23",
    reviewerId: "platform-authz-reviewer",
  },
  {
    primitiveName: "dashboards_update",
    resourceType: "dashboard",
    action: "update",
    boundary: "delegated_chat_token",
    reason:
      "Same as dashboards_create — config-validated update authored by delegated chat under user-writable scope. Token-policy gate only.",
    risk: "medium",
    owningTeam: "platform-authz",
    reviewedAt: "2026-05-23",
    reviewerId: "platform-authz-reviewer",
  },
  {
    primitiveName: "agent_run_stop",
    resourceType: "agent_run",
    action: "cancel",
    boundary: "delegated_chat_token",
    reason:
      "User-directed run cancellation from chat ('cancel that run'). 'stop' is a denied verb token, so this carve-out gates the token policy (perimeter 5) only; the agent_run_stop handler re-checks run access via enforceRunAccess (perimeter 1). Low blast radius: halts processing of a run the caller can already access; no data deletion, no external side effect. agent_run_resume is intentionally NOT carved out — resume is often HITL approval and must stay on the rendered approval surface so a prompt-injected chat cannot auto-approve a gate.",
    risk: "low",
    owningTeam: "platform-authz",
    reviewedAt: "2026-05-23",
    reviewerId: "platform-authz-reviewer",
  },
  // Agent-Creation Approval Workflow — non-admin proposal path. The 4
  // primitives below write into the ISOLATED agent_creation_request store
  // (NEVER the live agent_source_* tree); list/get are author-or-admin reads
  // of their own requests. agent_creation_request_decide + retry_publish are
  // admin-only and INTENTIONALLY not in this carve-out (admin acts via the
  // /configuration/agents/approvals UI; a prompt-injected chat must not
  // auto-approve — mirrors the agent_run_resume rule).
  {
    primitiveName: "agent_creation_request_propose",
    resourceType: "agent",
    action: "create",
    boundary: "delegated_chat_token",
    reason:
      "Non-admin proposal entry. Writes into the isolated agent_creation_request store at status 'proposed' and runs agent_creation_review for the report. NEVER touches agent_source_* or agent_templates. The 'create' verb token is denied at the policy boundary; this carve-out gates the token policy only — the handler enforces actor + author binding internally.",
    risk: "low",
    owningTeam: "platform-authz",
    reviewedAt: "2026-05-24",
    reviewerId: "platform-authz-reviewer",
  },
  {
    primitiveName: "agent_creation_request_edit",
    resourceType: "agent",
    action: "update",
    boundary: "delegated_chat_token",
    reason:
      "Author re-snapshot of a REJECTED request. Reruns review and transitions back to 'proposed'. Author-bound at the handler. Token-policy gate only.",
    risk: "low",
    owningTeam: "platform-authz",
    reviewedAt: "2026-05-24",
    reviewerId: "platform-authz-reviewer",
  },
  {
    primitiveName: "agent_creation_request_list",
    resourceType: "agent",
    action: "list",
    boundary: "delegated_chat_token",
    reason:
      "Read of own proposal queue (non-admin) or all org requests (admin). Token-policy gate only; the handler scopes by org + filters non-admin to their own author_id.",
    risk: "low",
    owningTeam: "platform-authz",
    reviewedAt: "2026-05-24",
    reviewerId: "platform-authz-reviewer",
  },
  {
    primitiveName: "agent_creation_request_get",
    resourceType: "agent",
    action: "read",
    boundary: "delegated_chat_token",
    reason:
      "Read of one proposal — author OR admin. Token-policy gate only; the handler refuses if the actor is neither admin nor author.",
    risk: "low",
    owningTeam: "platform-authz",
    reviewedAt: "2026-05-24",
    reviewerId: "platform-authz-reviewer",
  },
];

const CARVE_OUT_INDEX = (() => {
  const idx = new Map<string, CarveOut>();
  for (const c of CARVE_OUTS) {
    const key = `${c.primitiveName}::${c.boundary}`;
    if (idx.has(key)) {
      throw new Error(`Duplicate CarveOut entry for ${key}`);
    }
    idx.set(key, c);
  }
  return idx;
})();

export function findCarveOut(ref: CarveOutRef): CarveOut | undefined {
  return CARVE_OUT_INDEX.get(`${ref.primitiveName}::${ref.boundary}`);
}

export function listCarveOuts(): readonly CarveOut[] {
  return CARVE_OUTS;
}
