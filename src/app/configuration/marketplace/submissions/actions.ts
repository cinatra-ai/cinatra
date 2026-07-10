"use server";

/**
 * Server Actions for the extension-submission moderator surface.
 *
 * Each action:
 *   1. requireAdminSession() — cinatra-instance side gate (a cinatra user
 *      who is NOT an admin can never even reach the route that calls this).
 *   2. Build a marketplace MCP client with this instance's marketplace
 *      token. Authority on the marketplace side is enforced separately:
 *      the WP cap `CAP_VENDOR_APPROVE` on the admin actions, vendor
 *      ownership on `extension_submission_withdraw`. If the marketplace
 *      refuses (cap missing, ownership mismatch, etc.), the call returns
 *      an MCP error which we surface via redirect with `?error=`.
 *   3. Call the MCP. On success, revalidate the page and redirect with
 *      `?ok=<op>&id=<submission_id>` so the user sees a result chip.
 *
 * No client-side caching, no SWR, no live polling — each mutation
 * revalidatePath()s the page; the user re-renders the queue with fresh
 * data from the marketplace.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminSession } from "@/lib/auth-session";
import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import { enqueueCatalogSyncForApprovedSubmission } from "./catalog-sync-enqueue";

const VENDOR_LIST_PATH = "/configuration/marketplace/submissions";
const ADMIN_LIST_PATH  = "/configuration/marketplace/submissions/admin";

/** Hard cap on user-supplied reject reasons; matches the textarea maxLength. */
const REJECT_REASON_MAX = 2000;

/** Valid status filter values for the admin list — kept in sync with the UI's <Select>. */
const ADMIN_FILTER_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "promoted",
  "superseded",
]);

function resolveMarketplaceToken(): string | undefined {
  return process.env.MARKETPLACE_INSTANCE_TOKEN;
}

/**
 * Build the admin-list redirect URL preserving the caller's status filter.
 * The forms post a `return_status` hidden input (the filter the admin was
 * viewing) so a retry from `?status=approved` doesn't drop the user back to
 * the default `pending` page after the action returns.
 *
 * Codes-only flash protocol: `ok`/`error` carry a STABLE code (mapped to a
 * static toast at the mount site); the raw MCP error is logged server-side,
 * never reflected into the redirect URL.
 */
function adminRedirect(
  formData: FormData,
  query: { ok?: string; error?: string },
): string {
  const params = new URLSearchParams();
  const returnStatus = String(formData.get("return_status") ?? "").trim();
  if (returnStatus !== "" && ADMIN_FILTER_STATUSES.has(returnStatus)) {
    params.set("status", returnStatus);
  }
  if (query.ok)    params.set("ok",    query.ok);
  if (query.error) params.set("error", query.error);
  const qs = params.toString();
  return qs === "" ? ADMIN_LIST_PATH : `${ADMIN_LIST_PATH}?${qs}`;
}

/** Vendor withdraws their own pending submission. */
export async function withdrawSubmissionAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const submissionId = String(formData.get("submission_id") ?? "").trim();
  if (submissionId === "") {
    redirect(`${VENDOR_LIST_PATH}?error=missing-id`);
  }
  const token = resolveMarketplaceToken();
  if (!token) {
    redirect(`${VENDOR_LIST_PATH}?error=token-missing`);
  }
  const client = createHttpMarketplaceMcpClient({ token });
  try {
    await client.extensionSubmissionWithdraw({ submission_id: submissionId });
  } catch (err) {
    console.error("[withdrawSubmissionAction] withdraw failed:", err);
    redirect(`${VENDOR_LIST_PATH}?error=withdraw-failed`);
  }
  revalidatePath(VENDOR_LIST_PATH);
  redirect(`${VENDOR_LIST_PATH}?ok=withdraw`);
}

/** Admin approves a pending submission. Starts the promotion saga. */
export async function approveSubmissionAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const submissionId = String(formData.get("submission_id") ?? "").trim();
  if (submissionId === "") {
    redirect(adminRedirect(formData, { error: "missing-id" }));
  }
  const token = resolveMarketplaceToken();
  if (!token) {
    redirect(adminRedirect(formData, { error: "token-missing" }));
  }
  const client = createHttpMarketplaceMcpClient({ token });
  let approveResult: Awaited<ReturnType<typeof client.extensionSubmissionApprove>>;
  try {
    approveResult = await client.extensionSubmissionApprove({ submission_id: submissionId });
  } catch (err) {
    console.error("[approveSubmissionAction] approve failed:", err);
    redirect(adminRedirect(formData, { error: "approve-failed" }));
  }

  // Fast-freshness catalog reconcile: enqueue a single-package
  // MARKETPLACE_CATALOG_SYNC for the just-approved target so the marketplace
  // catalog table picks up the new package without waiting for the next hourly
  // full-sweep tick. Shared with the unified-inbox decision helper so both
  // approve paths reconcile identically. Best-effort (never rolls back approval).
  await enqueueCatalogSyncForApprovedSubmission(approveResult);

  revalidatePath(ADMIN_LIST_PATH);
  redirect(adminRedirect(formData, { ok: "approve" }));
}

/** Admin rejects a pending submission with a non-empty reason. */
export async function rejectSubmissionAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const submissionId = String(formData.get("submission_id") ?? "").trim();
  const reason       = String(formData.get("reason") ?? "").trim();
  if (submissionId === "") {
    redirect(adminRedirect(formData, { error: "missing-id" }));
  }
  if (reason === "") {
    redirect(adminRedirect(formData, { error: "reason-required" }));
  }
  if (reason.length > REJECT_REASON_MAX) {
    redirect(adminRedirect(formData, { error: "reason-too-long" }));
  }
  const token = resolveMarketplaceToken();
  if (!token) {
    redirect(adminRedirect(formData, { error: "token-missing" }));
  }
  const client = createHttpMarketplaceMcpClient({ token });
  try {
    await client.extensionSubmissionReject({ submission_id: submissionId, reason });
  } catch (err) {
    console.error("[rejectSubmissionAction] reject failed:", err);
    redirect(adminRedirect(formData, { error: "reject-failed" }));
  }
  revalidatePath(ADMIN_LIST_PATH);
  redirect(adminRedirect(formData, { ok: "reject" }));
}

/** Admin retries the promotion saga on a row stuck at approved+failed. */
export async function retryPromotionAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const submissionId = String(formData.get("submission_id") ?? "").trim();
  if (submissionId === "") {
    redirect(adminRedirect(formData, { error: "missing-id" }));
  }
  const token = resolveMarketplaceToken();
  if (!token) {
    redirect(adminRedirect(formData, { error: "token-missing" }));
  }
  const client = createHttpMarketplaceMcpClient({ token });
  try {
    await client.extensionSubmissionPromotionRetry({ submission_id: submissionId });
  } catch (err) {
    console.error("[retryPromotionAction] retry failed:", err);
    redirect(adminRedirect(formData, { error: "retry-failed" }));
  }
  revalidatePath(ADMIN_LIST_PATH);
  redirect(adminRedirect(formData, { ok: "retry" }));
}

// NOTE: the REJECT_REASON_MAX value above is mirrored in the textarea's
// `maxLength` on admin-action-buttons.tsx as the literal 2000. Keep both in
// sync.
