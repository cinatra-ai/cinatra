import "server-only";

import { createAgentBuilderPrimitiveHandlers } from "@cinatra-ai/agents/mcp-handlers";
import { agentApprovalAccessPolicy } from "@cinatra-ai/agents/auth-policy-types";

import type { ApprovalViewer, DecideInput, DecideResult } from "./sources/types";

// ---------------------------------------------------------------------------
// Non-redirecting per-source decision helpers.
//
// A helper performs the source's OWN authorization + separation-of-duties and
// returns a structured `DecideResult`. It never calls `redirect()` /
// `revalidatePath()` — the UI keeps thin `"use server"` wrappers that call a
// helper and THEN redirect/revalidate, and the future `approvals_*` MCP handlers
// call the SAME helper with no redirect. A helper is a plain async fn with no
// Next runtime dependency, so it is unit-testable in isolation.
//
// A business refusal (not-authorized / separation-of-duties / state conflict)
// is returned as `{ ok: false, kind }` — it is NEVER thrown. A helper throws
// only for a genuine infra/programmer error.
// ---------------------------------------------------------------------------

type Refusal = Extract<DecideResult, { ok: false }>;

/**
 * Pure classifier for the agent-creation-request decide primitive, which
 * flattens every outcome to a `{ error: string }` message. Each KNOWN refusal
 * maps to a stable `code` + `kind`; an UNRECOGNISED message is treated as
 * `transient` (retryable) rather than a hard business `refused`, so a caller
 * never presents an infra hiccup as a policy denial.
 *
 * Kept pure (string in, result out) so every branch is unit-tested without a DB.
 */
export function classifyAgentDecideError(message: string): Refusal {
  const m = message.toLowerCase();
  if (m.includes("unauthorized") || m.includes("admin session required")) {
    return { ok: false, kind: "forbidden", code: "not_admin", message };
  }
  if (m.includes("self-approval is disallowed")) {
    return { ok: false, kind: "refused", code: "self_approval_forbidden", message };
  }
  if (m.includes("access scope is required")) {
    // cinatra#1327 — approve reached the primitive without an access scope.
    // The UI requires the selection client-side, so this is a defense-in-depth
    // refusal for any caller that bypassed the picker.
    return { ok: false, kind: "refused", code: "access_scope_required", message };
  }
  if (m.includes("snapshot changed") || m.includes("no longer represents") || m.includes("refresh and try again")) {
    return { ok: false, kind: "refused", code: "stale_snapshot", message };
  }
  if (m.includes("invalid transition") || m.includes("is in status")) {
    return { ok: false, kind: "refused", code: "invalid_state", message };
  }
  if (m.includes("not found")) {
    return { ok: false, kind: "refused", code: "not_found", message };
  }
  if (m.includes("collision")) {
    return { ok: false, kind: "refused", code: "name_collision", message };
  }
  // Unrecognised → transient (retryable), NOT a business refusal.
  return { ok: false, kind: "transient", code: "unknown", message };
}

type PrimitiveHandler = (r: {
  primitiveName: string;
  input: Record<string, unknown>;
  actor: Record<string, unknown>;
  mode: string;
}) => Promise<unknown>;

/**
 * Non-redirecting decide for the agent-creation-request source.
 *
 * It delegates to the audited `agent_creation_request_decide` MCP primitive —
 * NOT the raw `decideAgentCreationRequestCas` store fn — so it can never be
 * less-authorized than the primitive: the admin gate, the separation-of-duties
 * self-approval guard (with the single-admin exception + connector_config
 * override), the approve→gated-publish pipeline, the audit log and the author
 * notification are ALL preserved. The raw CAS performs none of those.
 *
 * The CAS token (`expectedVersion`) MUST be supplied by the caller — captured at
 * the render that showed the reviewer the proposal — so an edit-after-view is
 * still caught. The helper does NOT read a fresh hash (that would defeat the
 * guard).
 */
export async function decideAgentCreationRequest(
  input: DecideInput,
  viewer: ApprovalViewer,
): Promise<DecideResult> {
  const action = input.action;
  if (action !== "approve" && action !== "reject") {
    return { ok: false, kind: "refused", code: "unknown_action", message: `unknown action '${action}'` };
  }
  const reason = input.reason?.trim();
  if (action === "reject" && !reason) {
    return { ok: false, kind: "refused", code: "reason_required", message: "A rejection reason is required." };
  }
  const expectedSnapshotHash = input.expectedVersion?.trim();
  if (!expectedSnapshotHash) {
    return {
      ok: false,
      kind: "refused",
      code: "version_required",
      message: "A snapshot version token is required to decide (refresh and try again).",
    };
  }
  // cinatra#1327 — an approve is the install-equivalent moment: it REQUIRES an
  // access scope (who can access the agent once published). Fail-closed: refuse
  // before touching the primitive if it is absent. (The primitive re-checks
  // server-side; the approvals UI requires the selection client-side too.)
  if (action === "approve" && !input.accessTarget) {
    return {
      ok: false,
      kind: "refused",
      code: "access_scope_required",
      message: "Choose who can access this agent (organization, team, or project) before approving.",
    };
  }
  // cinatra#1327 — authorize the chosen access target with the SAME gates the
  // install flow uses (install-target-authz), BEFORE publishing: tenant
  // membership (rejects a cross-org / forged team/project id — a cross-tenant
  // access grant) + install authorization for the actor. Fail-fast so a bad
  // target never publishes; fail-closed so a denial refuses the whole approve.
  // Runs for both the UI action and the MCP surface (both call this helper).
  if (action === "approve" && input.accessTarget) {
    const targetActor = {
      principalId: viewer.userId,
      organizationId: viewer.orgId,
      platformRole: (viewer.isAdmin ? "platform_admin" : "member") as
        | "platform_admin"
        | "member",
    };
    try {
      const { assertTargetBelongsToActiveOrg, assertCanInstallAtTarget } =
        await import("@cinatra-ai/agents/install-target-authz");
      const { projectOwnership } = await assertTargetBelongsToActiveOrg(
        targetActor,
        input.accessTarget,
        viewer.orgId,
      );
      await assertCanInstallAtTarget(targetActor, input.accessTarget, projectOwnership);
    } catch (err) {
      return {
        ok: false,
        kind: "forbidden",
        code: "target_forbidden",
        message:
          err instanceof Error
            ? err.message
            : "You cannot grant access at the selected scope.",
      };
    }
  }

  const handlers = createAgentBuilderPrimitiveHandlers() as Record<string, PrimitiveHandler>;
  const decideHandler = handlers["agent_creation_request_decide"];
  const result = (await decideHandler({
    primitiveName: "agent_creation_request_decide",
    input: {
      id: input.rowId,
      decision: action,
      expectedSnapshotHash,
      ...(reason ? { reason } : {}),
      // Threaded to the primitive so it records the scope in the audit AND
      // re-enforces the required-ness server-side (cinatra#1327).
      ...(input.accessTarget ? { accessTarget: input.accessTarget } : {}),
    },
    actor: {
      actorType: "human",
      source: "ui",
      userId: viewer.userId,
      organizationId: viewer.orgId,
      // Claim platform_admin ONLY for an admin viewer. The primitive
      // independently re-checks the platformRole at its boundary and denies a
      // non-admin actor, so this never widens authority.
      platformRole: viewer.isAdmin ? "platform_admin" : "member",
    },
    mode: "deterministic",
  })) as
    | { error?: string; structuredContent?: { agentTemplateId?: string | null } }
    | null
    | undefined;

  if (result?.error) {
    return classifyAgentDecideError(result.error);
  }

  // cinatra#1327 — persist the chosen access scope through the SAME install path
  // the marketplace uses: setExtensionInstallAccess(kind "agent_template")
  // writes the canonical extension_access_policy AND (via the agent_template
  // hook's afterPolicyWrite) mirrors to agent_templates.agent_auth_policy — the
  // column run enforcement actually reads. This runs in the APP layer because
  // @cinatra-ai/agents cannot import @cinatra-ai/extensions (a package cycle).
  // Ordering is publish-then-scope (the template row must exist first); until
  // this write lands the agent stays at its restrictive default — FAIL-CLOSED
  // (never over-broad). A failure is surfaced as a retryable refusal so the
  // admin re-applies the scope (retry, or the extension's Permissions surface);
  // it never leaves the agent broadly accessible.
  if (action === "approve" && input.accessTarget) {
    const agentTemplateId = result?.structuredContent?.agentTemplateId ?? null;
    if (!agentTemplateId) {
      return {
        ok: false,
        kind: "transient",
        code: "template_unresolved",
        message:
          "The agent was published, but its record could not be resolved to apply the access scope. Retry, or set access on the extension's Permissions.",
      };
    }
    try {
      // Lazy import — the server-only extensions access-contract graph loads
      // only when an approve actually succeeds, keeping the approvals nav/source
      // static import graph light.
      const { setExtensionInstallAccess } = await import(
        "@cinatra-ai/extensions/install-access-contract"
      );
      await setExtensionInstallAccess({
        kind: "agent_template",
        resourceId: agentTemplateId,
        policy: agentApprovalAccessPolicy(input.accessTarget),
        installedByUserId: viewer.userId,
      });
    } catch {
      return {
        ok: false,
        kind: "transient",
        code: "access_persist_failed",
        message:
          "The agent was published, but applying the access scope failed. It stays restricted — retry, or set access on the extension's Permissions.",
      };
    }
  }

  return { ok: true };
}
