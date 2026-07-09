import "server-only";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";

import { resolveMarketplaceAdminToken } from "@/lib/marketplace-credentials";
import { enqueueCatalogSyncForApprovedSubmission } from "@/app/configuration/marketplace/submissions/catalog-sync-enqueue";

import {
  classifyMarketplaceDecideError,
  invalidateMarketplaceApprovalCounts,
  resolveInstanceToken,
} from "./sources/marketplace-shared";
import type { ApprovalViewer, DecideInput, DecideResult } from "./sources/types";

// ---------------------------------------------------------------------------
// Non-redirecting per-source decision helpers for the marketplace ApprovalSources.
//
// Same contract as the agent-creation-request helper (#1044): the helper does
// its OWN authorization, calls the existing marketplace client method, and
// returns a structured `DecideResult`. It NEVER redirect()s / revalidatePath()s
// — the UI keeps a thin `decideApprovalRow` server-action wrapper (from #1044)
// that dispatches here and then revalidates; the future `approvals_*` MCP
// handlers (#1048) reuse the SAME helper with no redirect.
//
// A business refusal (SoD / not-authorized / gone / conflict) is a VALUE
// (`{ ok:false, kind }` via {@link classifyMarketplaceDecideError}), never a
// throw. The marketplace decide methods opt into #1046 status preservation so
// the 409 separation-of-duties refusal is distinguishable from a transient
// transport error and renders a readable explanation.
//
// cinatra-side gate: every marketplace surface is admin-only today
// (`requireAdminSession()` on all four drill-down pages), so each helper refuses
// a non-admin viewer up front — the marketplace WP capability check on the token
// remains the authoritative second gate either way.
// ---------------------------------------------------------------------------

const NOT_ADMIN: Extract<DecideResult, { ok: false }> = {
  ok: false,
  kind: "forbidden",
  code: "not_admin",
  message: "Admin access is required to decide marketplace approvals.",
};

function notConfigured(what: string): Extract<DecideResult, { ok: false }> {
  return {
    ok: false,
    kind: "forbidden",
    code: "not_configured",
    message: `${what} is not configured on this instance.`,
  };
}

function unknownAction(action: string): Extract<DecideResult, { ok: false }> {
  return { ok: false, kind: "refused", code: "unknown_action", message: `Unknown action '${action}'.` };
}

/**
 * Decide (approve / reject) an extension-submission moderation row.
 * Credential: `MARKETPLACE_INSTANCE_TOKEN` (mirrors the admin queue page).
 * On approve, enqueues the SAME single-package catalog reconcile the drill-down
 * approve action does (shared helper) so the two approve paths never diverge.
 */
export async function decideMarketplaceSubmission(
  input: DecideInput,
  viewer: ApprovalViewer,
): Promise<DecideResult> {
  if (!viewer.isAdmin) return NOT_ADMIN;
  const action = input.action;
  if (action !== "approve" && action !== "reject") return unknownAction(action);

  const reason = input.reason?.trim();
  if (action === "reject" && !reason) {
    return { ok: false, kind: "refused", code: "reason_required", message: "A rejection reason is required." };
  }

  const token = resolveInstanceToken();
  if (!token) return notConfigured("The marketplace instance token");

  const client = createHttpMarketplaceMcpClient({ token });
  try {
    if (action === "approve") {
      const result = await client.extensionSubmissionApprove({ submission_id: input.rowId });
      // Best-effort fast-freshness catalog reconcile (never rolls back approval).
      await enqueueCatalogSyncForApprovedSubmission(result);
    } else {
      // reject — `reason` validated non-empty above.
      await client.extensionSubmissionReject({ submission_id: input.rowId, reason: reason ?? "" });
    }
    return { ok: true };
  } catch (err) {
    return classifyMarketplaceDecideError(err);
  } finally {
    // Invalidate on ANY attempt that reached the marketplace, not just success:
    // a 404 (already decided by another actor) or 409 (state conflict) refusal
    // ALSO means the remote pending set changed, so the capped count must not
    // lag a real change by up to ~60s ("invalidated after any decide/withdraw").
    invalidateMarketplaceApprovalCounts();
  }
}

/**
 * Withdraw the instance's OWN pending extension submission ("Your requests").
 * Credential: `MARKETPLACE_INSTANCE_TOKEN` (mirrors the my-submissions page).
 */
export async function withdrawMarketplaceSubmission(
  input: DecideInput,
  viewer: ApprovalViewer,
): Promise<DecideResult> {
  if (!viewer.isAdmin) return NOT_ADMIN;
  if (input.action !== "withdraw") return unknownAction(input.action);

  const token = resolveInstanceToken();
  if (!token) return notConfigured("The marketplace instance token");

  const client = createHttpMarketplaceMcpClient({ token });
  try {
    await client.extensionSubmissionWithdraw({ submission_id: input.rowId });
    return { ok: true };
  } catch (err) {
    return classifyMarketplaceDecideError(err);
  } finally {
    // See decideMarketplaceSubmission: refresh the capped count on any attempt.
    invalidateMarketplaceApprovalCounts();
  }
}

/**
 * Decide (approve / reject) a vendor-application moderation row.
 * Credential: `resolveMarketplaceAdminToken()` (`MARKETPLACE_ADMIN_TOKEN`) —
 * mirrors the vendor-applications moderation page and its server actions.
 */
export async function decideMarketplaceVendorApplication(
  input: DecideInput,
  viewer: ApprovalViewer,
): Promise<DecideResult> {
  if (!viewer.isAdmin) return NOT_ADMIN;
  const action = input.action;
  if (action !== "approve" && action !== "reject") return unknownAction(action);

  const reason = input.reason?.trim();
  if (action === "reject" && !reason) {
    return { ok: false, kind: "refused", code: "reason_required", message: "A rejection reason is required." };
  }

  let token: string;
  try {
    token = resolveMarketplaceAdminToken();
  } catch {
    return notConfigured("The marketplace admin token");
  }

  const client = createHttpMarketplaceMcpClient({ token });
  try {
    if (action === "approve") {
      await client.vendorApplicationApprove({ application_id: input.rowId });
    } else {
      // reject — `reason` validated non-empty above.
      await client.vendorApplicationReject({ application_id: input.rowId, decision_reason: reason ?? "" });
    }
    return { ok: true };
  } catch (err) {
    return classifyMarketplaceDecideError(err);
  } finally {
    // See decideMarketplaceSubmission: refresh the capped count on any attempt.
    invalidateMarketplaceApprovalCounts();
  }
}
