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
import {
  enqueueBackgroundJob,
  BACKGROUND_JOB_NAMES,
} from "@/lib/background-jobs";

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

/** Encode an MCP error message for inclusion in a redirect query string. */
function encodeError(message: string): string {
  return encodeURIComponent(message.slice(0, 300));
}

/**
 * Build the admin-list redirect URL preserving the caller's status filter.
 * The forms post a `return_status` hidden input (the filter the admin was
 * viewing) so a retry from `?status=approved` doesn't drop the user back to
 * the default `pending` page after the action returns.
 */
function adminRedirect(
  formData: FormData,
  query: { ok?: string; id?: string; error?: string },
): string {
  const params = new URLSearchParams();
  const returnStatus = String(formData.get("return_status") ?? "").trim();
  if (returnStatus !== "" && ADMIN_FILTER_STATUSES.has(returnStatus)) {
    params.set("status", returnStatus);
  }
  if (query.ok)    params.set("ok",    query.ok);
  if (query.id)    params.set("id",    query.id);
  if (query.error) params.set("error", query.error);
  const qs = params.toString();
  return qs === "" ? ADMIN_LIST_PATH : `${ADMIN_LIST_PATH}?${qs}`;
}

/** Vendor withdraws their own pending submission. */
export async function withdrawSubmissionAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const submissionId = String(formData.get("submission_id") ?? "").trim();
  if (submissionId === "") {
    redirect(`${VENDOR_LIST_PATH}?error=${encodeError("Missing submission_id.")}`);
  }
  const token = resolveMarketplaceToken();
  if (!token) {
    redirect(`${VENDOR_LIST_PATH}?error=${encodeError("Marketplace token not configured.")}`);
  }
  const client = createHttpMarketplaceMcpClient({ token });
  try {
    await client.extensionSubmissionWithdraw({ submission_id: submissionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Withdraw failed.";
    redirect(`${VENDOR_LIST_PATH}?error=${encodeError(msg)}`);
  }
  revalidatePath(VENDOR_LIST_PATH);
  redirect(`${VENDOR_LIST_PATH}?ok=withdraw&id=${encodeURIComponent(submissionId)}`);
}

/** Admin approves a pending submission. Starts the promotion saga. */
export async function approveSubmissionAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const submissionId = String(formData.get("submission_id") ?? "").trim();
  if (submissionId === "") {
    redirect(adminRedirect(formData, { error: encodeError("Missing submission_id.") }));
  }
  const token = resolveMarketplaceToken();
  if (!token) {
    redirect(adminRedirect(formData, { error: encodeError("Marketplace token not configured.") }));
  }
  const client = createHttpMarketplaceMcpClient({ token });
  let approveResult: Awaited<ReturnType<typeof client.extensionSubmissionApprove>>;
  try {
    approveResult = await client.extensionSubmissionApprove({ submission_id: submissionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Approve failed.";
    redirect(adminRedirect(formData, { error: encodeError(msg) }));
  }

  // Fast-freshness catalog reconcile: enqueue a single-package
  // MARKETPLACE_CATALOG_SYNC job for the just-approved target so the
  // marketplace catalog table picks up the new package without waiting
  // for the next hourly full-sweep tick.
  //
  // Enqueue regardless of `promotion_state` because the saga is async —
  // even a `complete`-on-approve result can flip to `failed` after the
  // round-trip verify, and an `in_flight` result eventually settles. The
  // job uses attempts/backoff so it retries if the package isn't in
  // Verdaccio yet by the time it runs (the saga is still finishing on
  // the marketplace side). A small initial delay gives the saga
  // breathing room before the first attempt.
  //
  // Skip only on terminal-failure states where there's no package to
  // sync (rejected / withdrawn / approved+failed-with-no-retry-yet).
  // Best-effort: a failed enqueue doesn't roll back the approval.
  // Enqueue only on EXPLICIT on-track states. The terminal failure case
  // (`approved + failed`) is a row stuck mid-saga; the operator must
  // hit "Retry promotion" before there's anything in Verdaccio to sync.
  // Enqueuing on a failed row would just thrash the retry budget for no
  // benefit.
  const isOnTrack =
    approveResult.target_final_identity !== "" &&
    (approveResult.status === "promoted" ||
      approveResult.promotion_state === "complete" ||
      (approveResult.status === "approved" &&
        approveResult.promotion_state === "in_flight"));
  if (isOnTrack) {
    const parsed = parseTargetFinalIdentity(approveResult.target_final_identity);
    if (parsed !== null) {
      try {
        await enqueueBackgroundJob(
          BACKGROUND_JOB_NAMES.MARKETPLACE_CATALOG_SYNC,
          { packageName: parsed.packageName, packageVersion: parsed.version },
          {
            // Per-package job id so it doesn't collide with the recurring loop.
            jobId: `marketplace-catalog-sync:${parsed.packageName}@${parsed.version}`,
            // 30s initial delay gives the marketplace's 9-step saga time
            // to land the package in Verdaccio before the sync worker
            // tries to fetch it. attempts=4 yields the canonical retry
            // window: initial + ~30s + ~60s + ~120s ≈ 3.5min total before
            // the periodic full-sweep takes over.
            delay: 30_000,
            attempts: 4,
            backoff: { type: "exponential", delay: 30_000 },
            overwriteIfStale: true,
          },
        );
      } catch (enqueueErr) {
        // Non-fatal — log and let the periodic sweep handle it.
        console.warn(
          "[marketplace-catalog-sync] post-approve single-package enqueue failed:",
          enqueueErr instanceof Error ? enqueueErr.message : enqueueErr,
        );
      }
    }
  }

  revalidatePath(ADMIN_LIST_PATH);
  redirect(adminRedirect(formData, { ok: "approve", id: encodeURIComponent(submissionId) }));
}

/**
 * Parse `@<scope>/<name>@<version>` into the marketplace-catalog-sync
 * payload shape. Returns null on malformed input — the enqueue is best-
 * effort and a malformed identity just means the periodic sweep handles
 * the package on its next tick.
 */
function parseTargetFinalIdentity(
  identity: string,
): { packageName: string; version: string } | null {
  // Find the LAST "@" — the version separator. The first "@" belongs to
  // the scope (`@<scope>/...`).
  const at = identity.lastIndexOf("@");
  if (at <= 0) return null;
  const packageName = identity.slice(0, at);
  const version = identity.slice(at + 1);
  if (!packageName.startsWith("@") || !packageName.includes("/") || version === "") {
    return null;
  }
  return { packageName, version };
}

/** Admin rejects a pending submission with a non-empty reason. */
export async function rejectSubmissionAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const submissionId = String(formData.get("submission_id") ?? "").trim();
  const reason       = String(formData.get("reason") ?? "").trim();
  if (submissionId === "") {
    redirect(adminRedirect(formData, { error: encodeError("Missing submission_id.") }));
  }
  if (reason === "") {
    redirect(adminRedirect(formData, { error: encodeError("Reject reason is required.") }));
  }
  if (reason.length > REJECT_REASON_MAX) {
    redirect(adminRedirect(formData, {
      error: encodeError(`Reject reason exceeds ${REJECT_REASON_MAX}-char cap.`),
    }));
  }
  const token = resolveMarketplaceToken();
  if (!token) {
    redirect(adminRedirect(formData, { error: encodeError("Marketplace token not configured.") }));
  }
  const client = createHttpMarketplaceMcpClient({ token });
  try {
    await client.extensionSubmissionReject({ submission_id: submissionId, reason });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Reject failed.";
    redirect(adminRedirect(formData, { error: encodeError(msg) }));
  }
  revalidatePath(ADMIN_LIST_PATH);
  redirect(adminRedirect(formData, { ok: "reject", id: encodeURIComponent(submissionId) }));
}

/** Admin retries the promotion saga on a row stuck at approved+failed. */
export async function retryPromotionAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const submissionId = String(formData.get("submission_id") ?? "").trim();
  if (submissionId === "") {
    redirect(adminRedirect(formData, { error: encodeError("Missing submission_id.") }));
  }
  const token = resolveMarketplaceToken();
  if (!token) {
    redirect(adminRedirect(formData, { error: encodeError("Marketplace token not configured.") }));
  }
  const client = createHttpMarketplaceMcpClient({ token });
  try {
    await client.extensionSubmissionPromotionRetry({ submission_id: submissionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Retry failed.";
    redirect(adminRedirect(formData, { error: encodeError(msg) }));
  }
  revalidatePath(ADMIN_LIST_PATH);
  redirect(adminRedirect(formData, { ok: "retry", id: encodeURIComponent(submissionId) }));
}

// NOTE: the REJECT_REASON_MAX value above is mirrored in the textarea's
// `maxLength` on admin-action-buttons.tsx as the literal 2000. Keep both in
// sync.
