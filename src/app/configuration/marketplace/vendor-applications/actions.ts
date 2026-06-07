// SPDX-License-Identifier: LicenseRef-Cinatra-Proprietary
"use server";

/**
 * Server Actions for the vendor-application moderator surface
 * (`/configuration/marketplace/vendor-applications`).
 *
 * Mirrors the shape of the extension-submission admin actions:
 *
 *   1. requireAdminSession() — cinatra-instance side gate so a
 *      cinatra user who is NOT an admin can never reach this surface.
 *   2. Resolve a PRINCIPAL_ADMIN marketplace bearer via the new C1
 *      resolver `resolveMarketplaceAdminToken()`. Authority on the
 *      marketplace side is enforced separately: the WP cap
 *      `CAP_VENDOR_APPROVE` on the admin abilities.
 *   3. Call the C1 wrapper. On success, revalidate + redirect with
 *      `?ok=<op>&id=<application_id>` so the user sees a result chip.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminSession } from "@/lib/auth-session";
import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import { resolveMarketplaceAdminToken } from "@/lib/marketplace-credentials";

const ADMIN_LIST_PATH = "/configuration/marketplace/vendor-applications";

/** Hard cap on user-supplied reject reasons; matches the textarea maxLength. */
const REJECT_REASON_MAX = 2000;

/** Valid status-filter values for the admin list — kept in sync with the UI. */
const ADMIN_FILTER_STATUSES = new Set([
  "applied",
  "approved",
  "rejected",
  "cancelled",
  "reset",
]);

function encodeError(message: string): string {
  return encodeURIComponent(message.slice(0, 300));
}

/**
 * Build the admin-list redirect URL preserving the caller's status filter.
 * Forms post a `return_status` hidden input so a retry from `?status=approved`
 * doesn't drop the user back to the default `applied` page after the action.
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
  if (query.ok) params.set("ok", query.ok);
  if (query.id) params.set("id", query.id);
  if (query.error) params.set("error", query.error);
  const qs = params.toString();
  return qs === "" ? ADMIN_LIST_PATH : `${ADMIN_LIST_PATH}?${qs}`;
}

/** Admin approves a vendor application. */
export async function approveVendorApplicationAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const applicationId = String(formData.get("application_id") ?? "").trim();
  if (applicationId === "") {
    redirect(adminRedirect(formData, { error: encodeError("Missing application_id.") }));
  }
  let token: string;
  try {
    token = resolveMarketplaceAdminToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Marketplace admin token not configured.";
    redirect(adminRedirect(formData, { error: encodeError(msg) }));
  }
  const client = createHttpMarketplaceMcpClient({ token });
  try {
    await client.vendorApplicationApprove({ application_id: applicationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Approve failed.";
    redirect(adminRedirect(formData, { error: encodeError(msg) }));
  }
  revalidatePath(ADMIN_LIST_PATH);
  redirect(
    adminRedirect(formData, {
      ok: "approve",
      id: encodeURIComponent(applicationId),
    }),
  );
}

/** Admin rejects a vendor application with a REQUIRED non-empty reason. */
export async function rejectVendorApplicationAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  const applicationId = String(formData.get("application_id") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (applicationId === "") {
    redirect(adminRedirect(formData, { error: encodeError("Missing application_id.") }));
  }
  if (reason === "") {
    redirect(adminRedirect(formData, { error: encodeError("Reject reason is required.") }));
  }
  if (reason.length > REJECT_REASON_MAX) {
    redirect(
      adminRedirect(formData, {
        error: encodeError(`Reject reason exceeds ${REJECT_REASON_MAX}-char cap.`),
      }),
    );
  }
  let token: string;
  try {
    token = resolveMarketplaceAdminToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Marketplace admin token not configured.";
    redirect(adminRedirect(formData, { error: encodeError(msg) }));
  }
  const client = createHttpMarketplaceMcpClient({ token });
  try {
    await client.vendorApplicationReject({
      application_id: applicationId,
      decision_reason: reason,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Reject failed.";
    redirect(adminRedirect(formData, { error: encodeError(msg) }));
  }
  revalidatePath(ADMIN_LIST_PATH);
  redirect(
    adminRedirect(formData, {
      ok: "reject",
      id: encodeURIComponent(applicationId),
    }),
  );
}
