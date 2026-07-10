import "server-only";

import { MarketplaceMcpError, type MarketplaceRowEligibility } from "@cinatra-ai/marketplace-mcp-client";
import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";

import { readInstanceIdentity } from "@/lib/instance-identity-store";
import {
  resolveMarketplaceAdminToken,
  hasConsumerOrVendorMarketplaceToken,
  resolveConsumerOrVendorMarketplaceToken,
} from "@/lib/marketplace-credentials";

import type {
  ApprovalAction,
  ApprovalEnvelope,
  ApprovalRow,
  ApprovalViewer,
  DecideResult,
  RowEligibility,
} from "./types";

// ---------------------------------------------------------------------------
// Shared plumbing for the four marketplace ApprovalSources (extension-submission
// moderation + my submissions; vendor-application moderation + my status).
//
// Credential presence checks are LOCAL ONLY (env vars + one instance-identity
// read); NONE of them touch the network. That is what lets the page fire ZERO
// remote marketplace calls when nothing is connected — every remote entry point
// (counts(), fetch*) gates on these predicates first.
//
// Per-adapter credential gates mirror the existing drill-down pages EXACTLY (no
// credential migration in this slice):
//   • submission moderation + my submissions → `MARKETPLACE_INSTANCE_TOKEN`
//     (the pages' local `resolveMarketplaceToken()`).
//   • vendor-application moderation           → `resolveMarketplaceAdminToken()`
//     (`MARKETPLACE_ADMIN_TOKEN`).
//   • my vendor-application status            → `resolveConsumerOrVendorMarketplaceToken`
//     (env override → consumer attachment → legacy vendor token).
// ---------------------------------------------------------------------------

/** Stable section ids (legacy `?tab=` anchors + the future sidebar badge key on
 *  them). One per (surface, direction) adapter — see the issue's four adapters. */
export const MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID = "marketplace-submission-moderation";
export const MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID = "marketplace-vendor-app-moderation";
export const MARKETPLACE_MY_SUBMISSIONS_SOURCE_ID = "marketplace-my-submissions";
export const MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID = "marketplace-vendor-app-status";

/** Group tag the page uses to collapse the marketplace sections into ONE
 *  "Marketplace not connected" state and ONE sources footer. */
export const MARKETPLACE_GROUP = "marketplace";

/** Where the group-level "Marketplace not connected" CTA points. */
export const MARKETPLACE_CONNECT_HREF = "/configuration/environment?tab=registries";

/** Drill-down routes the existing standalone pages live at — surfaced as a
 *  section-header "View all" link so the pages remain reachable. */
export const MARKETPLACE_SUBMISSIONS_ADMIN_HREF = "/configuration/marketplace/submissions/admin";
export const MARKETPLACE_SUBMISSIONS_SELF_HREF = "/configuration/marketplace/submissions";
export const MARKETPLACE_VENDOR_APPS_ADMIN_HREF = "/configuration/marketplace/vendor-applications";
export const MARKETPLACE_VENDOR_APP_STATUS_HREF = "/configuration/environment?tab=registries";

/** Remote counts are CAPPED — a moderator only needs "there are items", not an
 *  exact backlog size, and an exact count would need an unbounded list. The list
 *  fetches CAP+1 and the count is min(len, CAP); the UI renders "N+" at the cap. */
export const REMOTE_COUNT_CAP = 9;

// --- Credential presence (no network) --------------------------------------

/** Instance token — the bearer the extension-submission surfaces use. Mirrors
 *  the current pages' local `resolveMarketplaceToken()` EXACTLY (a direct
 *  `MARKETPLACE_INSTANCE_TOKEN` env read; no credential migration in this slice). */
export function resolveInstanceToken(): string | undefined {
  const t = process.env.MARKETPLACE_INSTANCE_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

export function hasInstanceToken(): boolean {
  return resolveInstanceToken() !== undefined;
}

/** Admin/moderator bearer used by the vendor-application moderation queue, or
 *  `undefined` when `MARKETPLACE_ADMIN_TOKEN` is unset (never throws). */
export function resolveAdminToken(): string | undefined {
  try {
    return resolveMarketplaceAdminToken();
  } catch {
    return undefined;
  }
}

export function hasAdminToken(): boolean {
  return resolveAdminToken() !== undefined;
}

/** Consumer/vendor bearer used by the instance's own vendor-application status.
 *  Reads the local identity row (env override → consumer attachment → legacy
 *  vendor token). A corrupted attachment or crypto failure is treated as
 *  "not configured" here — the section then surfaces a discoverable footer hint
 *  rather than crashing the whole approvals page. */
export function hasVendorToken(): boolean {
  try {
    return hasConsumerOrVendorMarketplaceToken(readInstanceIdentity());
  } catch {
    return false;
  }
}

/** Resolve the consumer/vendor bearer for the my-status adapter, or `undefined`
 *  when none is available (mirrors {@link hasVendorToken}, never throws). */
export function resolveVendorToken(): string | undefined {
  try {
    return resolveConsumerOrVendorMarketplaceToken(readInstanceIdentity());
  } catch {
    return undefined;
  }
}

/** True when ANY marketplace credential resolves. When false the whole
 *  marketplace group collapses to one "not connected" state and fires no remote
 *  calls. (An instance token implies a vendor token, but all three are checked
 *  for robustness / independence from resolution order.) */
export function anyMarketplaceCredential(): boolean {
  return hasInstanceToken() || hasAdminToken() || hasVendorToken();
}

// --- Vendored marketplace HTTP client factory ------------------------------
//
// The ONE place the vendored `@cinatra-ai/marketplace-mcp-client/http-client`
// is constructed for the approval sources' counts/fetch. Centralizing it here
// (already the allowlisted vendored-surface file for this feature) keeps the
// import-LIGHT `*.contract.ts` nav halves off a direct vendored-package import
// — they call this factory instead — so the marketplace-mcp-client-banned
// migration guard has ONE fewer call site to swap, and adding a new nav source
// never re-introduces the vendored name. Returns the client for the bearer.
export function createMarketplaceClient(token: string) {
  return createHttpMarketplaceMcpClient({ token });
}

// --- Capped, ~60s server cache for the direction counts --------------------
//
// counts() feeds the direction-tab pills (and, later, the sidebar badge in
// #1047) and runs on every approvals render, so the capped remote list is
// cached ~60s and soft-fails to 0. Invalidation is best-effort same-process
// (cleared by the decide helper after any decision); the robust cross-instance
// layout-level invalidation is #1047. Failures are NOT cached (a transient error
// must not pin a 0 for a full minute).

interface CountCacheEntry {
  value: number;
  expiresAt: number;
}

/** ~60s TTL. Exported so tests can assert the window without a magic literal. */
export const COUNT_TTL_MS = 60_000;
const countCache = new Map<string, CountCacheEntry>();

export async function cachedMarketplaceCount(
  key: string,
  loader: () => Promise<number>,
): Promise<number> {
  const now = Date.now();
  const hit = countCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await loader();
  countCache.set(key, { value, expiresAt: now + COUNT_TTL_MS });
  return value;
}

/** Clears the cached marketplace counts so the next render recomputes them —
 *  called by the inline decide helper after any marketplace decision. */
export function invalidateMarketplaceApprovalCounts(): void {
  countCache.clear();
}

/** Cap a raw list length to the display cap (see {@link REMOTE_COUNT_CAP}). */
export function cappedCount(rawLength: number): number {
  return Math.min(Math.max(rawLength, 0), REMOTE_COUNT_CAP);
}

// --- Shared 4-state fetch / count guards ------------------------------------
//
// Every marketplace adapter shares the same short-circuit ladder, which is what
// enforces the connectivity model AND the "zero remote calls when disconnected"
// guarantee (a doomed call is never fired):
//   • non-admin viewer          → ready+empty (no leak, no call)
//   • NO marketplace credential  → `not_connected` (group-collapse signal)
//   • THIS section's credential absent → `not_configured` (hidden + footer hint)
//   • otherwise                  → the remote load runs; a THROW propagates so
//                                  the safe SourceSection loader renders the
//                                  inline per-section error + retry.

/**
 * Guarded per-direction fetch for a marketplace section. `sectionToken` is the
 * ALREADY-resolved credential for this section (undefined ⇒ not configured); it
 * is resolved by the caller so the credential mapping stays per-adapter. `load`
 * receives the token and returns the rows (it MAY throw — that surfaces as the
 * section's inline error).
 */
export async function guardedFetch(
  viewer: ApprovalViewer,
  sectionToken: string | undefined,
  actions: ApprovalAction[],
  load: (token: string) => Promise<ApprovalRow[]>,
): Promise<ApprovalEnvelope> {
  if (!viewer.isAdmin) return { availability: "ready", rows: [], actions };
  if (!anyMarketplaceCredential()) return { availability: "not_connected", rows: [], actions };
  if (!sectionToken) return { availability: "not_configured", rows: [], actions };
  const rows = await load(sectionToken);
  return { availability: "ready", rows, actions };
}

/**
 * Guarded capped count for a marketplace section. Returns 0 (no remote call)
 * when the viewer is a non-admin, nothing is connected, or this section's
 * credential is absent. Otherwise returns the ~60s-cached capped count, soft-
 * failing to 0 WITHOUT caching the failure. `load` returns the already-capped
 * count for the given token.
 */
export async function guardedCount(
  viewer: ApprovalViewer,
  sectionToken: string | undefined,
  cacheKey: string,
  load: (token: string) => Promise<number>,
): Promise<number> {
  if (!viewer.isAdmin || !anyMarketplaceCredential() || !sectionToken) return 0;
  try {
    return await cachedMarketplaceCount(cacheKey, () => load(sectionToken));
  } catch {
    return 0;
  }
}

/** Coarse marketplace-group availability: `not_connected` when NO credential of
 *  any kind resolves (collapses the whole group to one Empty), else `ready`. A
 *  section's OWN missing credential is `not_configured`, surfaced per-direction
 *  via `sectionConfigured` (a hidden section + footer hint), NOT here — so
 *  `availableSources` never drops a marketplace source. */
export function marketplaceAvailability(): "not_connected" | "ready" {
  return anyMarketplaceCredential() ? "ready" : "not_connected";
}

// --- Optional row-eligibility passthrough (#1045) --------------------------

/**
 * Map the OPTIONAL marketplace `eligibility` hint on a moderation list row to
 * the registry's {@link RowEligibility}. Returns `undefined` when the whole
 * object is absent (the current marketplace) so the UI stays optimistic and
 * degrades gracefully — action-time enforcement at the source is authoritative
 * either way. Additive + speculative: the fields are all optional.
 */
export function toRowEligibility(
  e: MarketplaceRowEligibility | undefined,
): RowEligibility | undefined {
  if (!e) return undefined;
  const out: RowEligibility = {};
  if (typeof e.can_approve === "boolean") out.can_approve = e.can_approve;
  if (typeof e.can_reject === "boolean") out.can_reject = e.can_reject;
  if (typeof e.reason === "string" && e.reason.length > 0) out.reason = e.reason;
  return Object.keys(out).length > 0 ? out : undefined;
}

// --- #1046 structured decision-error classification ------------------------

type DecideRefusal = Extract<DecideResult, { ok: false }>;

/**
 * The marketplace's machine-readable separation-of-duties refusal code (409):
 * the submitter / submission-vendor owner / namespace owner may NOT approve
 * their own request. Parsed from the preserved error body so we can render the
 * canonical human explanation instead of a raw WP error string.
 */
const SOD_CODE_FRAGMENT = "approver_separation";

/**
 * Best-effort extract of the marketplace machine-readable error code from a
 * preserved `MarketplaceMcpError.responseBody` (a JSON WP-error envelope) or,
 * failing that, the message. Pure (strings in → code|null out) so it is unit
 * tested without a live marketplace. Never throws on malformed JSON.
 */
export function parseMarketplaceErrorCode(responseBody: string, message: string): string | null {
  const fromJson = (() => {
    if (!responseBody) return null;
    try {
      const parsed = JSON.parse(responseBody) as unknown;
      const scan = (o: unknown, depth: number): string | null => {
        if (depth > 4 || o === null || typeof o !== "object") return null;
        const rec = o as Record<string, unknown>;
        for (const k of ["code", "error_code", "errorCode"]) {
          const v = rec[k];
          if (typeof v === "string" && v.length > 0) return v;
        }
        for (const nestKey of ["data", "error", "errors"]) {
          const found = scan(rec[nestKey], depth + 1);
          if (found) return found;
        }
        return null;
      };
      return scan(parsed, 0);
    } catch {
      return null;
    }
  })();
  if (fromJson) return fromJson;
  // Fall back to a code-shaped token inside the human message.
  const m = message.match(
    /\b([a-z][a-z0-9_.]*(?:separation|self_approval|forbidden|conflict)[a-z0-9_.]*)\b/i,
  );
  return m ? m[1] : null;
}

/**
 * Map a thrown marketplace decision error to a structured, NON-throwing
 * `DecideResult` refusal.
 *
 * The decide client methods opt into #1046 status preservation
 * (`DECISION_REFUSAL_STATUSES = [403,404,409,429,503]`), so a DETERMINISTIC
 * refusal — most importantly a 409 separation-of-duties rejection — arrives as
 * `MarketplaceMcpError.httpStatus` (not a generic 502) with the marketplace's
 * machine-readable code + message in `.responseBody` / `.message`. We surface a
 * READABLE explanation and mark only the genuinely transient classes retryable.
 *
 *   401/403 → forbidden (not authorized / missing WP capability)
 *   409     → refused   (SoD self-approval, or state conflict) — readable text
 *   404     → refused   (the row is gone / already decided elsewhere)
 *   400/422 → refused   (validation)
 *   429/502/503/other → transient (retryable transport/unavailability)
 */
export function classifyMarketplaceDecideError(err: unknown): DecideRefusal {
  const status = err instanceof MarketplaceMcpError ? err.httpStatus : undefined;
  const responseBody = err instanceof MarketplaceMcpError ? err.responseBody : "";
  const rawMessage =
    err instanceof Error && err.message ? err.message : "The marketplace rejected the decision.";

  switch (status) {
    case 401:
    case 403:
      return {
        ok: false,
        kind: "forbidden",
        code: "not_authorized",
        message:
          "The marketplace refused this action for your instance's credential " +
          "(the moderation capability may be missing on the token). " +
          rawMessage,
        httpStatus: status,
      };
    case 409: {
      const code = parseMarketplaceErrorCode(responseBody, rawMessage);
      const isSod =
        (code ?? "").toLowerCase().includes(SOD_CODE_FRAGMENT) ||
        rawMessage.toLowerCase().includes("separation") ||
        rawMessage.toLowerCase().includes("approve your own");
      return {
        ok: false,
        kind: "refused",
        code: code ?? (isSod ? "approver_separation_violation" : "conflict"),
        message: isSod
          ? "Someone else must review this — the marketplace does not allow the " +
            "submitter or namespace owner to approve their own request."
          : `The marketplace could not apply this decision (state conflict). ${rawMessage}`,
        httpStatus: 409,
      };
    }
    case 404:
      return {
        ok: false,
        kind: "refused",
        code: parseMarketplaceErrorCode(responseBody, rawMessage) ?? "not_found",
        message: `This item is no longer available to decide (it may have already been decided). ${rawMessage}`,
        httpStatus: 404,
      };
    case 400:
    case 422:
      return {
        ok: false,
        kind: "refused",
        code: parseMarketplaceErrorCode(responseBody, rawMessage) ?? "invalid",
        message: rawMessage,
        httpStatus: status,
      };
    case 429:
    case 502:
    case 503:
      return {
        ok: false,
        kind: "transient",
        code: "unavailable",
        message: `The marketplace is temporarily unavailable. Try again in a moment. ${rawMessage}`,
        httpStatus: status,
      };
    default:
      return { ok: false, kind: "transient", code: "unknown", message: rawMessage };
  }
}
