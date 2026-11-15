import "server-only";

import {
  createPreviewCaptureDeps,
  type CaptureDegradeReason,
  type PreviewCaptureDeps,
} from "./registered-page-render";
import { normalizeOrigin } from "./cms-preview-capture-policy";
import { findInertnessViolations, sanitizeCapturedHtml } from "./cms-preview-inertness";

// ---------------------------------------------------------------------------
// REGISTERED-PAGE CAPTURE (cinatra#4223): one page of a site the organisation
// registered, rendered to a PNG. It files nothing and names no artifact type.
//
// The organisation's active connect-registered sites are the egress allowlist:
// a page is captured only when its origin equals a registered site's origin
// (`normalizeOrigin`) and the url's own origin (`new URL(url).origin`) equals
// it too. The fetch is the existing guarded GET (egress policy, no redirects,
// size cap) with NO credential headers; the page is sanitized and re-checked
// for inertness; the render is the existing isolated subprocess, pinned to the
// addresses the guard validated.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10_000;
const RENDER_TIMEOUT_MS = 15_000;

/** The host seams the capture reads: no credential, no store. */
export type CaptureRegisteredPageDeps = Pick<
  PreviewCaptureDeps,
  "listRegisteredSites" | "fetchPreview" | "renderIsolated" | "now"
>;

export type CaptureRegisteredPageOutcome =
  | { ok: true; png: Buffer; viewport: { width: number; height: number }; capturedAt: string }
  | { ok: false; reason: CaptureDegradeReason };

/**
 * Capture ONE page of one of the organisation's active registered sites. Every
 * refusal is a named `CaptureDegradeReason` of the existing capture steps, and
 * the two target refusals send no request. `capturedAt` is read after the
 * renderer returns. Never throws: an unexpected failure is `render-failed`.
 */
export async function captureRegisteredPage(input: {
  orgId: string;
  url: string;
  deps?: CaptureRegisteredPageDeps;
}): Promise<CaptureRegisteredPageOutcome> {
  try {
    const deps = input.deps ?? createPreviewCaptureDeps();
    // 1. TARGET: the organisation's registered sites, then an exact origin match.
    const sites = await deps.listRegisteredSites(input.orgId);
    if (sites.length === 0) return { ok: false, reason: "no-registered-site" };
    const want = normalizeOrigin(input.url);
    // The url's own origin must BE the normalised one. A host with a trailing dot
    // (`blog.example.com.`) normalises to the registered origin, but its request
    // carries another Host and its page has an origin that is not the renderer's
    // allowed origin; it is refused.
    if (
      want === null ||
      new URL(input.url).origin !== want ||
      !sites.some((site) => normalizeOrigin(site.origin) === want)
    ) {
      return { ok: false, reason: "origin-not-registered" };
    }
    // 2. EGRESS: the guarded GET, with no credential headers.
    const fetched = await deps.fetchPreview({ url: input.url, headers: {}, timeoutMs: FETCH_TIMEOUT_MS });
    if (!fetched.ok) return { ok: false, reason: fetched.reason };
    // 3. INERTNESS: sanitize, then verify.
    const sanitized = sanitizeCapturedHtml(fetched.html);
    if (findInertnessViolations(sanitized.html).length > 0) {
      return { ok: false, reason: "sanitization-failed" };
    }
    // 4. ISOLATION: render in the subprocess, pinned to the validated addresses.
    const rendered = await deps.renderIsolated({
      html: sanitized.html,
      documentUrl: input.url,
      allowedOrigin: want,
      pinnedAddresses: fetched.pinnedAddresses,
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    if (!rendered.ok) return { ok: false, reason: rendered.reason };
    const capturedAt = deps.now().toISOString();
    return {
      ok: true,
      png: Buffer.from(rendered.screenshot),
      viewport: { width: rendered.geometry.viewport.width, height: rendered.geometry.viewport.height },
      capturedAt,
    };
  } catch {
    return { ok: false, reason: "render-failed" };
  }
}
