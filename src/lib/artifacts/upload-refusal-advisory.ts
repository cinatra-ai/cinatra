import "server-only";

// ---------------------------------------------------------------------------
// Upload-refusal advisory channel (cinatra#1890, epic #1883 slice A2 / design
// D6).
//
// When an upload's MIME maps to NO installed required-base artifact type the
// route returns 415 and — instead of the failure disappearing silently (the
// epic's named "chat silent-drop failure") — this module emits ONE occurrence-
// deduped `info` notification to the UPLOADER carrying the marketplace deep link
// for the refused MIME. That is the "install a type that accepts this" recourse;
// the full in-app picker is slice A4 (NOT built here — only the honest refusal
// surface + notification + deep link).
//
// Occurrence granularity: the advisory dedupes per (user, refused-MIME). A user
// who repeatedly uploads the same unsupported MIME is told ONCE (the notifications
// layer's partial unique index on `(user_id, dedupe_key)` collapses the retries
// to a single bell row) — an advisory, not a per-attempt alarm. A DIFFERENT
// refused MIME is a distinct occurrence and notifies again. The dedupe key is
// keyed on the SAME normalized MIME the resolver refused on.
//
// REUSE, don't reinvent: the occurrence-dedup + recipient fan-out + bell/SSE
// plumbing already exist in the notifications layer. This module only composes a
// `NotificationInput` and calls the existing `createNotificationForRecipient`.
// ---------------------------------------------------------------------------

import type {
  NotificationInput,
  NotificationRecipient,
} from "@cinatra-ai/notifications/types";

/** Shared dedupe-key prefix for every upload-refusal advisory (occurrence
 *  family). Kept as a stable literal so a future reconciler could read the
 *  whole family by prefix if needed. */
export const UPLOAD_REFUSAL_DEDUPE_PREFIX = "upload-refusal:";

/** The advisory `metadata.category` marker — lets a consumer recognize an
 *  upload-refusal advisory without string-matching the title. */
export const UPLOAD_REFUSAL_CATEGORY = "upload-refusal";

/**
 * Marketplace deep link for the refused MIME — the "install a type that accepts
 * this" recourse pointer. Same-origin, relative path; the MIME rides an
 * `accepts` query param (URL-encoded) that the A4 picker will consume to
 * pre-filter kind:"artifact" packs. Until A4 lands the link still lands the user
 * on the marketplace — an honest recourse, never a dead end. The MIME is bounded
 * before encoding so a pathological Content-Type cannot bloat the href.
 */
export function buildUploadRefusalMarketplaceHref(normalizedMime: string): string {
  const bounded = normalizedMime.slice(0, 255);
  return `/configuration/marketplace?accepts=${encodeURIComponent(bounded)}`;
}

/** Stable per-(user,MIME) occurrence key. The user axis is added by the
 *  notifications layer (the unique index is `(user_id, dedupe_key)`), so this
 *  key carries only the MIME. */
export function uploadRefusalDedupeKey(normalizedMime: string): string {
  return `${UPLOAD_REFUSAL_DEDUPE_PREFIX}${normalizedMime.slice(0, 255)}`;
}

/**
 * PURE: compose the advisory notification input for a refused-MIME upload.
 * `info` kind (advisory, not an error/warning alarm); the marketplace deep link
 * is the `href`; the dedupe key makes it occurrence-deduped.
 */
export function buildUploadRefusalNotificationInput(args: {
  normalizedMime: string;
  filename?: string;
}): NotificationInput {
  const { normalizedMime, filename } = args;
  const named = filename ? `"${filename}"` : "an uploaded file";
  return {
    title: "Upload not filed — no installed type accepts it",
    body:
      `${named} is a ${normalizedMime} file, and no installed artifact type accepts that format. ` +
      `Install a type that accepts it from the marketplace (or ask an admin to), then upload again.`,
    kind: "info",
    href: buildUploadRefusalMarketplaceHref(normalizedMime),
    dedupeKey: uploadRefusalDedupeKey(normalizedMime),
    metadata: {
      category: UPLOAD_REFUSAL_CATEGORY,
      mime: normalizedMime,
      ...(filename ? { filename } : {}),
    },
  };
}

/**
 * Emit the upload-refusal advisory to the uploading user. Best-effort: a
 * notification-write failure is swallowed (the caller still returns its 415);
 * an empty/blank MIME is a no-op (the "no_mime" refusal class has no recourse to
 * point at). The `@/lib/notifications` facade registers the notifications host
 * adapters as a side effect on import.
 */
export async function notifyUploadRefusal(args: {
  userId: string;
  normalizedMime: string;
  filename?: string;
}): Promise<void> {
  const { userId, normalizedMime, filename } = args;
  if (!userId || !normalizedMime) return;
  try {
    const { createNotificationForRecipient } = await import("@/lib/notifications");
    await createNotificationForRecipient(
      { kind: "user", userId } satisfies NotificationRecipient,
      buildUploadRefusalNotificationInput({ normalizedMime, filename }),
    );
  } catch (err) {
    // Advisory only — never let a bell-write failure turn a 415 into a 500.
    console.warn(
      "[artifacts:upload] refusal advisory notification failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
