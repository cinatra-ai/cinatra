import "server-only";

import {
  createPreviewCaptureDeps,
  type CaptureDegradeReason,
  type PreviewCaptureDeps,
} from "./cms-preview-capture";
import { normalizeOrigin } from "./cms-preview-capture-policy";
import { findInertnessViolations, sanitizeCapturedHtml } from "./cms-preview-inertness";

// ---------------------------------------------------------------------------
// REGISTERED-PAGE CAPTURE (cinatra#4223): one page of a site the org has
// registered, rendered to a PNG. Type-agnostic: it files nothing and names no
// artifact type; the caller decides what the picture becomes.
//
// The org's registered-site list is the egress allowlist: a page url is
// captured only when its origin equals a registered site's origin exactly. The
// fetch is the existing guarded GET (egress policy, no redirects, size cap),
// sent with NO credential headers; the page is sanitized and re-checked for
// inertness; the render is the existing isolated subprocess, pinned to the
// guard-validated addresses.
// ---------------------------------------------------------------------------

/** The fetch budget of one capture, in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;
/** The render budget of one capture, in milliseconds. */
const RENDER_TIMEOUT_MS = 15_000;

/** The host seams `captureRegisteredPage` reads: no credential, no store. */
export type CaptureRegisteredPageDeps = Pick<
  PreviewCaptureDeps,
  "listRegisteredSites" | "fetchPreview" | "renderIsolated" | "now"
>;

export type CaptureRegisteredPageOutcome =
  | {
      ok: true;
      png: Buffer;
      viewport: { width: number; height: number };
      capturedAt: string;
    }
  | { ok: false; reason: CaptureDegradeReason };

/**
 * Capture ONE page of an org's ACTIVE registered site.
 *
 * The page url's origin must match a registered site's origin exactly
 * (`normalizeOrigin`), so a caller can only photograph a site the org already
 * registered. Every refusal is a named `CaptureDegradeReason`, and every early
 * return sends no further byte.
 *
 * `capturedAt` is read AFTER the renderer returns. Nothing is stored here: the
 * caller files the picture. Never throws: an unexpected failure is
 * `render-failed`.
 */
export async function captureRegisteredPage(input: {
  orgId: string;
  url: string;
  deps?: CaptureRegisteredPageDeps;
}): Promise<CaptureRegisteredPageOutcome> {
  const deps = input.deps ?? createPreviewCaptureDeps();
  try {
    // 1. TARGET — the org's registered sites, then an exact origin match.
    const sites = await deps.listRegisteredSites(input.orgId);
    if (sites.length === 0) return { ok: false, reason: "no-registered-site" };
    const want = normalizeOrigin(input.url);
    const matched =
      want === null ? undefined : sites.find((site) => normalizeOrigin(site.origin) === want);
    if (want === null || matched === undefined) {
      return { ok: false, reason: "origin-not-registered" };
    }

    // 2. EGRESS — the guarded GET, with no credential headers.
    const fetched = await deps.fetchPreview({
      url: input.url,
      headers: {},
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!fetched.ok) return { ok: false, reason: fetched.reason };

    // 3. INERTNESS — sanitize, then verify.
    const sanitized = sanitizeCapturedHtml(fetched.html);
    if (findInertnessViolations(sanitized.html).length > 0) {
      return { ok: false, reason: "sanitization-failed" };
    }

    // 4. ISOLATION — render in the subprocess, pinned to the validated addresses.
    const rendered = await deps.renderIsolated({
      html: sanitized.html,
      documentUrl: input.url,
      allowedOrigin: want,
      pinnedAddresses: fetched.pinnedAddresses,
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    if (!rendered.ok) return { ok: false, reason: rendered.reason };

    // The ISO time at which the renderer returned.
    const capturedAt = deps.now().toISOString();
    return {
      ok: true,
      // The PNG field of the existing renderer seam's result.
      png: Buffer.from(rendered.screenshot),
      viewport: rendered.geometry.viewport,
      capturedAt,
    };
  } catch {
    return { ok: false, reason: "render-failed" };
  }
}
