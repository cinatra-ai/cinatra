import "server-only";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { assertEgressAllowed, buildPinnedAgent } from "@cinatra-ai/webhooks";

import {
  captureDenialCopy,
  type CaptureTargetDenial,
  type RegisteredCaptureSite,
} from "./cms-preview-capture-policy";
import { allowsLoopbackHttp } from "../loopback-http-policy";
import type { CmsPreviewCaptureGeometry } from "./cms-preview-capture-store";

// ---------------------------------------------------------------------------
// The page-render primitives of the REGISTERED-PAGE CAPTURE (cinatra#4223,
// `registered-page-capture.ts`): the organisation's registered sites, the
// guarded GET and the isolated subprocess render. The gate capture pipeline
// these came from left with cinatra#3862 leg 8.
//
//  - EGRESS. The URL passes the shared egress guard (scheme / credentials /
//    internal-alias / IP-range / DNS-rebind pinning) before a byte is sent, and
//    redirects are NOT followed (`redirect: "manual"`). The one carve-out is a
//    LOOPBACK http origin while the instance runs in development mode
//    (`allowsLoopbackHttp`, the runtime-mode rule) — precisely the origin class
//    `validateWidgetOrigin` accepts as a connect origin.
//  - ISOLATION. The render happens in a separate process
//    (`scripts/preview-capture/isolated-render.mjs`) with JavaScript disabled
//    and a same-origin-only subresource policy, pinned to the addresses the
//    guard validated. The app's own server graph never imports a browser.
// ---------------------------------------------------------------------------

/** Cap on the fetched preview page. A site that returns more is degraded, not
 * buffered. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const VIEWPORT = { width: 1280, height: 900 } as const;

/** Every named way a capture can degrade. A closed set: the reviewer is always
 * told which one, and a new failure mode has to be named to ship. */
export type CaptureDegradeReason =
  | CaptureTargetDenial
  | "no-preview-credential"
  | "egress-blocked"
  | "preview-unauthorized"
  | "preview-unreachable"
  | "preview-bad-response"
  | "preview-too-large"
  | "sanitization-failed"
  | "renderer-unavailable"
  | "render-failed"
  | "capture-timeout"
  // L-D — the COMPOSED (proposal) render's own failure classes.
  | "no-proposed-fields"
  | "no-owned-regions"
  | "regions-unplaceable"
  | "composition-not-inert";

export function captureDegradeCopy(reason: CaptureDegradeReason): string {
  switch (reason) {
    case "no-preview-credential":
      return "the connected site has no active preview credential";
    case "egress-blocked":
      return "the connected site's address is not reachable under the host egress policy";
    case "preview-unauthorized":
      return "the connected site rejected the host's signed preview request";
    case "preview-unreachable":
      return "the connected site could not be reached";
    case "preview-bad-response":
      return "the connected site did not return a preview page";
    case "preview-too-large":
      return "the connected site's preview page exceeded the capture size limit";
    case "sanitization-failed":
      return "the preview page could not be made inert and was refused";
    case "renderer-unavailable":
      return "no isolated page renderer is available on this instance";
    case "render-failed":
      return "the isolated renderer could not produce a page image";
    case "capture-timeout":
      return "the capture did not finish within its time limit";
    case "no-proposed-fields":
      return "the reviewed proposal could not be read back, so the proposed page could not be composed";
    case "no-owned-regions":
      return "the connected site marked none of the changed fields as an owned region on its page";
    case "regions-unplaceable":
      return "the connected site's marked regions could not be delimited on its page, so the proposal could not be placed";
    case "composition-not-inert":
      return "the composed proposal page could not be made inert and was refused";
    default:
      return captureDenialCopy(reason as CaptureTargetDenial);
  }
}

/** The injected host seams — real in `createPreviewCaptureDeps`, stubbed in unit
 * tests, so the allow/deny/degrade matrix is provable without a site or a
 * browser. No credential and no store: the page capture needs neither. */
export interface PreviewCaptureDeps {
  /** The org's ACTIVE connect-registered sites (host-read, never adapter input). */
  listRegisteredSites: (orgId: string) => Promise<readonly RegisteredCaptureSite[]>;
  /** Guarded HTTP GET of the page. */
  fetchPreview: (input: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
  }) => Promise<
    | {
        ok: true;
        html: string;
        /** The addresses the egress guard VALIDATED for this host, so the
         * renderer can be pinned to exactly them (see `renderIsolated`). */
        pinnedAddresses: readonly string[];
      }
    | { ok: false; reason: CaptureDegradeReason; status?: number }
  >;
  /** Render the sanitized page in the isolated subprocess. */
  renderIsolated: (input: {
    html: string;
    documentUrl: string;
    allowedOrigin: string;
    /** The guard-validated addresses the renderer's browser may connect to.
     * EMPTY ⇒ the renderer refuses to run (fail closed). */
    pinnedAddresses: readonly string[];
    timeoutMs: number;
  }) => Promise<
    | {
        ok: true;
        screenshot: Uint8Array;
        geometry: CmsPreviewCaptureGeometry;
        network: { blockedRequests: number; allowedRequests: number };
      }
    | { ok: false; reason: CaptureDegradeReason }
  >;
  now: () => Date;
}

// ---------------------------------------------------------------------------
// The REAL host deps.
// ---------------------------------------------------------------------------

/** Loopback hosts an instance in DEVELOPMENT MODE may capture — the exact class
 * `validateWidgetOrigin` accepts as a connect origin; whether the mode allows
 * the exception at all is `allowsLoopbackHttp`'s runtime-mode rule. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

function isDevLoopbackOrigin(url: URL): boolean {
  if (!allowsLoopbackHttp()) return false;
  if (url.protocol !== "http:") return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/** Guarded GET: egress policy first, then a redirect-free, size-capped,
 * content-type-checked read. */
export async function fetchPreviewGuarded(input: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<
  | { ok: true; html: string; pinnedAddresses: readonly string[] }
  | { ok: false; reason: CaptureDegradeReason; status?: number }
> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, reason: "egress-blocked" };
  }

  let dispatcher: unknown;
  // The addresses the guard validated for this host — carried to the renderer
  // so its browser cannot re-resolve the name to somewhere else.
  let pinnedAddresses: readonly string[];
  if (isDevLoopbackOrigin(parsed)) {
    // The registered dev origin is loopback by construction; pin the renderer
    // to the loopback address rather than leaving it unpinned.
    pinnedAddresses = [parsed.hostname === "::1" ? "::1" : "127.0.0.1"];
  } else {
    try {
      const validated = await assertEgressAllowed(input.url);
      dispatcher = buildPinnedAgent(validated);
      pinnedAddresses = validated.map((a) => a.address);
    } catch {
      return { ok: false, reason: "egress-blocked" };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const res = await fetch(input.url, {
      method: "GET",
      headers: input.headers,
      // An open redirect on the site must never walk the request to another
      // address.
      redirect: "manual",
      signal: controller.signal,
      ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "preview-unauthorized", status: res.status };
    }
    if (res.status !== 200) {
      return { ok: false, reason: "preview-bad-response", status: res.status };
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("text/html")) {
      return { ok: false, reason: "preview-bad-response", status: res.status };
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) {
      return { ok: false, reason: "preview-too-large" };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_PREVIEW_BYTES) {
      return { ok: false, reason: "preview-too-large" };
    }
    return { ok: true, html: new TextDecoder("utf-8").decode(buf), pinnedAddresses };
  } catch {
    return { ok: false, reason: "preview-unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Absolute path to the isolated renderer. Resolved from the process cwd (the
 * app root) — the script is repo content, not a module import, so nothing about
 * it enters the app's bundle or route graph. */
function isolatedRendererPath(): string {
  return path.join(process.cwd(), "scripts", "preview-capture", "isolated-render.mjs");
}

/** Spawn the isolated renderer, pipe the sanitized HTML in, read the capture
 * out. A missing script / missing browser driver is a NAMED degrade. */
export async function renderIsolatedSubprocess(input: {
  html: string;
  documentUrl: string;
  allowedOrigin: string;
  pinnedAddresses: readonly string[];
  timeoutMs: number;
}): Promise<
  | {
      ok: true;
      screenshot: Uint8Array;
      geometry: CmsPreviewCaptureGeometry;
      network: { blockedRequests: number; allowedRequests: number };
    }
  | { ok: false; reason: CaptureDegradeReason }
> {
  const script = isolatedRendererPath();
  if (!existsSync(script)) return { ok: false, reason: "renderer-unavailable" };

  const payload = JSON.stringify({
    html: input.html,
    documentUrl: input.documentUrl,
    allowedOrigin: input.allowedOrigin,
    pinnedAddresses: [...input.pinnedAddresses],
    viewport: VIEWPORT,
    timeoutMs: input.timeoutMs,
  });

  const stdout = await new Promise<{ out: string; failed: boolean }>((resolve) => {
    const child = execFile(
      process.execPath,
      [script],
      {
        // A scrubbed environment: the renderer needs a PATH and a browser cache
        // location, never the host's secrets.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...(process.env.PLAYWRIGHT_BROWSERS_PATH
            ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
            : {}),
        } as unknown as NodeJS.ProcessEnv,
        maxBuffer: 64 * 1024 * 1024,
        timeout: input.timeoutMs + 5_000,
        cwd: process.cwd(),
      },
      (err, out) => resolve({ out: String(out ?? ""), failed: Boolean(err) }),
    );
    child.stdin?.end(payload);
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout.out) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: stdout.failed ? "render-failed" : "render-failed" };
  }
  if (parsed.ok !== true) {
    const reason = String(parsed.reason ?? "");
    return {
      ok: false,
      reason: reason === "renderer-unavailable" ? "renderer-unavailable" : "render-failed",
    };
  }
  const screenshot = Uint8Array.from(Buffer.from(String(parsed.screenshotBase64 ?? ""), "base64"));
  if (screenshot.byteLength === 0) return { ok: false, reason: "render-failed" };
  const viewport = (parsed.viewport ?? VIEWPORT) as { width: number; height: number };
  return {
    ok: true,
    screenshot,
    geometry: {
      regions: Array.isArray(parsed.regions)
        ? (parsed.regions as CmsPreviewCaptureGeometry["regions"])
        : [],
      contentHeight: Number(parsed.contentHeight ?? 0),
      viewport,
    },
    network: {
      blockedRequests: Number(parsed.blockedRequests ?? 0),
      allowedRequests: Number(parsed.allowedRequests ?? 0),
    },
  };
}

/**
 * Build the REAL deps. Every heavy binding resolves LAZILY at call time so
 * constructing this does no I/O and drags no store onto any route graph.
 */
export function createPreviewCaptureDeps(): PreviewCaptureDeps {
  return {
    listRegisteredSites: async (orgId) => {
      const { listConnectSitesForOrg } = await import("@/lib/connect-sites-store");
      return listConnectSitesForOrg(orgId).map((row) => ({
        siteId: row.siteId,
        client: row.client,
        origin: row.widgetOrigin,
      }));
    },
    fetchPreview: fetchPreviewGuarded,
    renderIsolated: renderIsolatedSubprocess,
    now: () => new Date(),
  };
}
