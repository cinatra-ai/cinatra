"use server";

import { redirect } from "next/navigation";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { createAgentBuilderPrimitiveHandlers } from "@cinatra-ai/agents/mcp-handlers";
import {
  decideAgentCreationRequest,
  coerceApprovalAccessTarget,
} from "@/lib/approvals/decision-helpers";
import type { DecideInput } from "@/lib/approvals/sources/types";

// Codes-only flash protocol: decisions redirect with `?status=<code>` (success)
// or `?error=<code>` (failure). The <SearchParamToast> island in the detail
// screen maps each code to a STATIC message — the raw MCP error is logged
// server-side, never reflected into the redirect URL.
const APPROVAL_BASE = "/configuration/agents/approvals";

type DecisionResult = { ok: true } | { ok: false; code: string };

/**
 * Refusal `code` (the shared decision helper's stable machine code) → flash
 * code (this page's codes-only protocol, mapped to a static message in
 * ./approval-decision-flash).
 *
 * cinatra#2597: every refusal used to collapse into the single opaque
 * `decision-failed` ("See server logs for details"), so the #1327 access-scope
 * requirement — the ONE refusal the reviewer can actually resolve themselves —
 * was a dead end. Each SELF-RESOLVABLE refusal now gets its own stable code and
 * its own actionable static message. The protocol is unchanged: the raw
 * primitive message is still only logged, never reflected into the URL.
 */
const FLASH_CODE_BY_REFUSAL: Record<string, string> = {
  access_scope_required: "scope-required",
  target_forbidden: "scope-forbidden",
  // Both land AFTER a successful publish: the agent exists but its access scope
  // was not written, so it stays at its restrictive default (fail-closed).
  template_unresolved: "scope-not-applied",
  access_persist_failed: "scope-not-applied",
  stale_snapshot: "stale-snapshot",
  // NOT stale-snapshot: a missing CAS token means the submission carried no
  // snapshot hash, which does not prove the proposal changed. Claiming it did
  // would be a guess dressed as a fact.
  version_required: "snapshot-missing",
  // The request left `proposed` between the render and the submit (someone else
  // decided it, or it already published) — resolved by reloading, not by
  // retrying the same decision.
  invalid_state: "already-decided",
  not_found: "not-found",
  name_collision: "name-collision",
  self_approval_forbidden: "self-approval",
  reason_required: "reason-required",
  not_admin: "unauthorized",
};

/**
 * Delegate to the SHARED, non-redirecting agent-creation decide helper — the
 * same one the inbox row dialog reaches through the approvals source registry —
 * and translate its structured refusal into a flash code.
 *
 * cinatra#2597: this action used to call the `agent_creation_request_decide`
 * primitive DIRECTLY, which forked the approve contract in two ways. It never
 * sent the #1327 `accessTarget` (so every approve hit the primitive's
 * fail-closed scope gate and could not succeed at all), and even with a scope
 * it would have skipped the two steps that live in the app layer around the
 * primitive: authorizing the chosen target with the same gates install uses,
 * and persisting the scope through `setExtensionInstallAccess`. Going through
 * the helper means the detail page and the inbox now approve through ONE code
 * path with ONE contract.
 */
async function decide(input: {
  id: string;
  decision: "approve" | "reject";
  expectedSnapshotHash: string;
  reason?: string;
  accessTarget?: DecideInput["accessTarget"];
}): Promise<DecisionResult> {
  const session = await getAuthSession();
  if (!session || !isPlatformAdmin(session)) {
    return { ok: false, code: "unauthorized" };
  }
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) return { ok: false, code: "no-active-org" };

  const result = await decideAgentCreationRequest(
    {
      rowId: input.id,
      action: input.decision,
      expectedVersion: input.expectedSnapshotHash,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.accessTarget ? { accessTarget: input.accessTarget } : {}),
    },
    // isAdmin is true by the gate above; the primitive re-checks the actor's
    // platformRole at its own boundary, so this never widens authority.
    { userId: session.user.id, orgId, isAdmin: true },
  );

  if (!result.ok) {
    console.error(
      "[agent-approval decide] refused:",
      result.kind,
      result.code,
      result.message,
    );
    return { ok: false, code: FLASH_CODE_BY_REFUSAL[result.code] ?? "decision-failed" };
  }
  return { ok: true };
}

export async function approveAgentCreationRequest(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const snapshotHash = String(formData.get("snapshotHash") ?? "");
  // cinatra#1327 — the reviewer's access scope, carried by the picker on the
  // decision form. Absent/malformed → no accessTarget → the shared helper
  // refuses with `access_scope_required` BEFORE the primitive runs, so a
  // scope-less approve leaves the request untouched at `proposed` (nothing is
  // half-approved) and the reviewer gets an actionable message.
  const accessTarget = coerceApprovalAccessTarget(
    String(formData.get("accessTargetLevel") ?? ""),
    String(formData.get("accessTargetId") ?? ""),
  );
  const result = await decide({
    id,
    decision: "approve",
    expectedSnapshotHash: snapshotHash,
    ...(accessTarget ? { accessTarget } : {}),
  });
  if (!result.ok) {
    redirect(`${APPROVAL_BASE}/${id}?error=${result.code}`);
  }
  redirect(`${APPROVAL_BASE}/${id}?status=approved`);
}

export async function retryPublishAgentCreationRequest(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const session = await getAuthSession();
  if (!session || !isPlatformAdmin(session)) {
    redirect(`${APPROVAL_BASE}/${id}?error=unauthorized`);
  }
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    redirect(`${APPROVAL_BASE}/${id}?error=no-active-org`);
  }
  const handlers = createAgentBuilderPrimitiveHandlers() as Record<
    string,
    (req: { primitiveName: string; input: Record<string, unknown>; actor: Record<string, unknown>; mode: string }) => Promise<unknown>
  >;
  const result = (await handlers["agent_creation_request_retry_publish"]({
    primitiveName: "agent_creation_request_retry_publish",
    input: { id },
    actor: {
      actorType: "human",
      source: "ui",
      userId: session.user.id,
      organizationId: orgId,
      platformRole: "platform_admin",
    },
    mode: "deterministic",
  })) as { error?: string };
  if (result.error) {
    console.error("[agent-approval retry-publish] primitive returned error:", result.error);
    redirect(`${APPROVAL_BASE}/${id}?error=publish-failed`);
  }
  redirect(`${APPROVAL_BASE}/${id}?status=published`);
}

export async function rejectAgentCreationRequest(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const snapshotHash = String(formData.get("snapshotHash") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) {
    redirect(`${APPROVAL_BASE}/${id}?error=reason-required`);
  }
  const result = await decide({
    id,
    decision: "reject",
    expectedSnapshotHash: snapshotHash,
    reason,
  });
  if (!result.ok) {
    redirect(`${APPROVAL_BASE}/${id}?error=${result.code}`);
  }
  redirect(`${APPROVAL_BASE}/${id}?status=rejected`);
}
