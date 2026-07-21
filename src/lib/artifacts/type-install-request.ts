import "server-only";

// ---------------------------------------------------------------------------
// Non-admin "Request install" advisory channel (epic #1883 slice A4, spec
// design@16efd8d2 `specs/app-artifacts.html` §VII — "Non-administrator —
// one-click Request install", ruling 4).
//
// Marketplace installs from the picker stay PLATFORM-ADMIN-only (owner ruling
// 2026-07-20). A non-admin who needs an artifact type gets a FUNCTIONAL one-
// click Request install: it notifies the platform admins — carrying the pack,
// the requester and a marketplace deep link — and COALESCES repeat clicks onto
// one request per occurrence, then the card flips to a muted "Request sent"
// state. The admin completes the install from that notification.
//
// REUSE, don't reinvent (mirrors `upload-refusal-advisory`): the occurrence-
// dedup + admins fan-out + bell/SSE plumbing already exist in the notifications
// layer. This module only composes a `NotificationInput` and the caller passes
// it to the existing `createNotificationForRecipient({ kind: "admins" }, …)`.
//
// Occurrence granularity: one request per (requester, package). The dedupe key
// carries BOTH the requester id and the package, so the notifications layer's
// partial unique index on `(user_id, dedupe_key)` collapses one requester's
// repeat clicks for the same pack to a single admin bell row — while a DIFFERENT
// requester, or a different pack, is a distinct occurrence that notifies again.
// (The recipient axis is each admin's `user_id`; the requester axis lives in the
// key so the same requester never double-notifies the same admin for one pack.)
// ---------------------------------------------------------------------------

import type { NotificationInput } from "@cinatra-ai/notifications/types";

/** Shared dedupe-key prefix for every type-install request (occurrence
 *  family) — kept a stable literal so a reconciler could sweep the family. */
export const TYPE_INSTALL_REQUEST_DEDUPE_PREFIX = "type-install-request:";

/** The advisory `metadata.category` marker — lets a consumer recognize a
 *  type-install request without string-matching the title. */
export const TYPE_INSTALL_REQUEST_CATEGORY = "type-install-request";

/**
 * Marketplace deep link for the requested pack — the admin's "complete the
 * install" pointer. Same-origin, relative path; the package rides a `q` search
 * param (URL-encoded) that lands the admin on the marketplace filtered to the
 * pack. Bounded before encoding so a pathological name cannot bloat the href.
 */
export function buildTypeInstallMarketplaceHref(packageName: string): string {
  const bounded = packageName.slice(0, 255);
  return `/configuration/marketplace?q=${encodeURIComponent(bounded)}`;
}

/** Stable per-(org, requester, package) occurrence key. All three axes are in
 *  the key so one requester's repeat clicks for one pack in one org coalesce,
 *  while a different org, requester or pack is a distinct occurrence — the org
 *  axis matters because the admin installs into a tenant, so a request must not
 *  cross tenants or be deduped forever across orgs. */
export function typeInstallRequestDedupeKey(
  orgId: string,
  requesterId: string,
  packageName: string,
): string {
  return `${TYPE_INSTALL_REQUEST_DEDUPE_PREFIX}${orgId.slice(0, 128)}:${requesterId.slice(0, 128)}:${packageName.slice(0, 255)}`;
}

/**
 * PURE: compose the admin-fanout notification input for a type-install request.
 * `info` kind (an advisory, not an alarm); the marketplace deep link is the
 * `href`; the dedupe key makes it occurrence-deduped per (requester, pack).
 */
export function buildTypeInstallRequestNotificationInput(args: {
  orgId: string;
  requesterId: string;
  packageName: string;
  displayName?: string;
  requesterLabel?: string;
}): NotificationInput {
  const { orgId, requesterId, packageName, displayName, requesterLabel } = args;
  const named = displayName && displayName.trim() ? displayName.trim() : packageName;
  const by =
    requesterLabel && requesterLabel.trim()
      ? ` — requested by ${requesterLabel.trim()}`
      : "";
  return {
    title: "Install requested — an artifact type a user needs",
    body:
      `A user asked to install ${named} (${packageName}) so they can type an uploaded file${by}. ` +
      `Review it in the marketplace and install it if appropriate.`,
    kind: "info",
    href: buildTypeInstallMarketplaceHref(packageName),
    dedupeKey: typeInstallRequestDedupeKey(orgId, requesterId, packageName),
    metadata: {
      category: TYPE_INSTALL_REQUEST_CATEGORY,
      packageName,
      orgId,
      requesterId,
      ...(displayName && displayName.trim() ? { displayName: displayName.trim() } : {}),
    },
  };
}
