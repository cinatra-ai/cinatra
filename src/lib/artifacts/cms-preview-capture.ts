import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { assertEgressAllowed, buildPinnedAgent, signOutboundRaw } from "@cinatra-ai/webhooks";

import {
  captureDenialCopy,
  resolveCaptureTarget,
  type CaptureTargetDenial,
  type RegisteredCaptureSite,
} from "./cms-preview-capture-policy";
import { findInertnessViolations, sanitizeCapturedHtml } from "./cms-preview-inertness";
import { composeProposedRegions } from "./cms-preview-region-composition";
import {
  writePinnedPreviewCapture,
  type CmsPreviewCaptureGeometry,
  type CmsPreviewCaptureRole,
  type StoredPreviewCapture,
} from "./cms-preview-capture-store";

// ---------------------------------------------------------------------------
// The fetched-render CAPTURE pipeline (cinatra#2044 S6, sub-lane L-B).
//
// At gate creation — the S5 capture path, right after the CMS content snapshot
// the gate pins is written — this fetches the adapter's AUTHENTICATED preview of
// the staged post, renders it in an isolated headless browser, and PINS the
// resulting screenshot + the adapter's region geometry as an immutable artifact
// bound to the gate's pinned target. The review surface then shows that pinned
// picture forever; it never fetches the site again (#2044: "never a live fetch
// at view time").
//
// THE FIVE STEPS, and what each one is defended against:
//
//  1. TARGET (SSRF). `resolveCaptureTarget` — a pure leaf — picks the URL from
//     the org's CONNECT-REGISTERED site origins. Adapter input is a selector,
//     never an address. See `cms-preview-capture-policy.ts`.
//  2. CREDENTIAL. The request is signed with the site's connect-provisioned
//     webhook secret through the EXISTING host signer (`signOutboundRaw`, the
//     exact-bytes twin of the outbound webhook signer). The secret never leaves
//     this process, never enters the renderer subprocess, never enters the
//     stored capture, and is never logged. The plugin recomputes the signature
//     over `preview.<id>` and constant-time compares (wordpress-plugin#94).
//  3. EGRESS. The URL passes the shared egress guard (scheme / credentials /
//     internal-alias / IP-range / DNS-rebind pinning) before a byte is sent, and
//     redirects are NOT followed (`redirect: "manual"`), so an open redirect on
//     the site cannot walk the signed request somewhere else. The one carve-out
//     is a LOOPBACK http origin on a non-production instance — precisely the
//     origin class `validateWidgetOrigin` already accepts at connect time under
//     the same `NODE_ENV !== "production"` rule, so the capture honours the
//     registration decision rather than inventing a second policy.
//  4. INERTNESS. The fetched page is sanitized (`cms-preview-inertness.ts`) and
//     RE-CHECKED before anything is stored or rendered; a page that still
//     carries an executable construct is refused, not stored.
//  5. ISOLATION. The render happens in a separate process
//     (`scripts/preview-capture/isolated-render.mjs`) with JavaScript disabled
//     and a same-origin-only subresource policy. The app's own server graph
//     never imports a browser.
//
// FAILURE HONESTY — the load-bearing behaviour: NOTHING here can fail the gate.
// `capturePinnedPreview` never throws. Every failure class becomes a stored
// DEGRADED capture record carrying a named reason, so the data-plane review
// still works and the reviewer is TOLD what is missing (#2044's honest-fallback
// rule) instead of being shown a silent gap.
// ---------------------------------------------------------------------------

/** Wall-clock ceiling for the whole capture (fetch + render). The staged-write
 * path awaits this, so it is bounded well under a request budget. */
const CAPTURE_TOTAL_TIMEOUT_MS = 25_000;
/** The PAIR shares one fetch but runs two isolated renders, so its ceiling is
 * one render longer than a single capture's — still bounded, still awaited. */
const CAPTURE_PAIR_TOTAL_TIMEOUT_MS = 40_000;
const FETCH_TIMEOUT_MS = 10_000;
const RENDER_TIMEOUT_MS = 15_000;
/** Cap on the fetched preview page. A site that returns more is degraded, not
 * buffered. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const VIEWPORT = { width: 1280, height: 900 } as const;

/** The connect webhook-binding tuple the WordPress adapter is provisioned under
 * (`connect-provisioning.ts` WORDPRESS_WEBHOOK_BINDING). The preview credential
 * IS that shared secret — the one credential both ends already hold. */
export const WORDPRESS_PREVIEW_BINDING = {
  vendor: "cinatra-ai",
  slug: "wordpress-mcp-connector",
  hook: "post-published",
} as const;

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
    case "composition-not-inert":
      return "the composed proposal page could not be made inert and was refused";
    default:
      return captureDenialCopy(reason as CaptureTargetDenial);
  }
}

/** The injected host seams — real in `capturePinnedPreviewWithHostDeps`, stubbed
 * in unit tests, so the whole allow/deny/degrade matrix is provable without a
 * site, a browser, or a database. */
export interface PreviewCaptureDeps {
  /** The org's ACTIVE connect-registered sites (host-read, never adapter input). */
  listRegisteredSites: (orgId: string) => Promise<readonly RegisteredCaptureSite[]>;
  /** Candidate shared secrets for a site's preview credential, in priority
   * order (current, then a non-expired previous during a rotation window). */
  resolvePreviewSecrets: (siteId: string) => Promise<readonly string[]>;
  /** Guarded HTTP GET of the signed preview request. */
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
  /** Persist the pinned capture record. */
  writeCapture: typeof writePinnedPreviewCapture;
  /** Read back the captures already pinned for a gate target. L-D's post-apply
   * render uses it to recover the SITE the gate was captured against, so the
   * read-back never re-derives an address from anything but what the gate itself
   * already resolved through the SSRF policy. */
  readPinnedCaptures: (input: {
    orgId: string;
    boundArtifactId: string;
    boundSnapshotRevisionId: string;
  }) => Promise<readonly StoredPreviewCapture[]>;
  now: () => Date;
}

export interface CapturePinnedPreviewInput {
  orgId: string;
  /** The gate's pinned target — the CMS snapshot artifact + its revision. */
  boundArtifactId: string;
  boundSnapshotRevisionId: string;
  role: CmsPreviewCaptureRole;
  /** The adapter's correlation url for the staged post — a SELECTOR only. */
  sourceUrl: string | null;
  /** The adapter's external id for the staged post. */
  externalId: string | null;
  title?: string;
  createdBy?: string | null;
  producerRunId?: string | null;
}

export type CapturePinnedPreviewOutcome =
  | { status: "captured"; capture: StoredPreviewCapture }
  | { status: "degraded"; reason: CaptureDegradeReason; capture: StoredPreviewCapture | null };

/** The fetched, sanitized base page — the ONE network round-trip both halves of
 * the L-D pair are produced from. */
interface FetchedBasePage {
  readonly target: Extract<ReturnType<typeof resolveCaptureTarget>, { ok: true }>;
  readonly html: string;
  readonly removed: Record<string, number>;
  readonly pinnedAddresses: readonly string[];
}

type FetchBaseResult =
  | { ok: true; page: FetchedBasePage }
  | {
      ok: false;
      reason: CaptureDegradeReason;
      sourceOrigin: string | null;
      postId: number | null;
    };

/**
 * Steps 1–4 of the pipeline (target → credential → guarded fetch → inertness),
 * factored out because L-D produces TWO pinned pictures from ONE fetch: the live
 * page as it stands, and the proposal composed into that same page's chrome. A
 * second fetch would double the signed round-trips, double the latency budget,
 * and — worse — could observe a DIFFERENT site state for the two halves, which
 * would make the before/after pair incomparable.
 */
async function fetchSanitizedBasePage(
  input: { orgId: string; sourceUrl: string | null; externalId: string | null },
  deps: PreviewCaptureDeps,
): Promise<FetchBaseResult> {
  // 1. TARGET — the SSRF boundary.
  const sites = await deps.listRegisteredSites(input.orgId);
  const target = resolveCaptureTarget({
    registeredSites: sites,
    sourceUrl: input.sourceUrl,
    externalId: input.externalId,
  });
  if (!target.ok) return { ok: false, reason: target.reason, sourceOrigin: null, postId: null };

  // 2. CREDENTIAL — the connect-provisioned shared secret, via the existing host
  // signer. A fresh `webhook-id` per attempt (the plugin consumes it single-use),
  // so a legitimate retry is never a replay.
  const secrets = await deps.resolvePreviewSecrets(target.siteId);
  if (secrets.length === 0) {
    return {
      ok: false,
      reason: "no-preview-credential",
      sourceOrigin: target.origin,
      postId: target.postId,
    };
  }

  let fetched:
    | { ok: true; html: string; pinnedAddresses: readonly string[] }
    | { ok: false; reason: CaptureDegradeReason }
    | null = null;
  for (const secret of secrets.slice(0, 2)) {
    const signed = signOutboundRaw(secret, randomUUID(), deps.now(), target.signedContent);
    const res = await deps.fetchPreview({
      url: target.url,
      headers: { ...signed.headers, accept: "text/html" },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (res.ok) {
      fetched = res;
      break;
    }
    fetched = res;
    // Only an AUTH refusal is worth retrying under the next candidate secret
    // (the rotation window); anything else is the same under any secret.
    if (res.reason !== "preview-unauthorized") break;
  }
  if (!fetched || !fetched.ok) {
    return {
      ok: false,
      reason: fetched?.reason ?? "preview-unreachable",
      sourceOrigin: target.origin,
      postId: target.postId,
    };
  }

  // 4. INERTNESS — sanitize, then VERIFY. A page that cannot be made inert is
  // refused rather than stored.
  const sanitized = sanitizeCapturedHtml(fetched.html);
  const violations = findInertnessViolations(sanitized.html);
  if (violations.length > 0) {
    console.warn(
      `[cms-preview-capture] refusing a page that is still live after sanitization: ${violations
        .map((v) => v.kind)
        .join(", ")}`,
    );
    return {
      ok: false,
      reason: "sanitization-failed",
      sourceOrigin: target.origin,
      postId: target.postId,
    };
  }

  return {
    ok: true,
    page: {
      target,
      html: sanitized.html,
      removed: { ...sanitized.removed },
      pinnedAddresses: fetched.pinnedAddresses,
    },
  };
}

/** Write ONE degraded capture record for a role. Never throws. */
async function writeDegraded(
  role: CmsPreviewCaptureRole,
  reason: CaptureDegradeReason,
  ctx: {
    input: CapturePinnedPreviewInput | CapturePinnedPreviewPairInput;
    capturedAt: string;
    title: string;
    sourceOrigin: string | null;
    postId: number | null;
  },
  deps: PreviewCaptureDeps,
): Promise<CapturePinnedPreviewOutcome> {
  try {
    const capture = await deps.writeCapture({
      orgId: ctx.input.orgId,
      createdBy: ctx.input.createdBy ?? null,
      producerRunId: ctx.input.producerRunId ?? null,
      data: {
        role,
        status: "degraded",
        degradedReason: reason,
        boundArtifactId: ctx.input.boundArtifactId,
        boundSnapshotRevisionId: ctx.input.boundSnapshotRevisionId,
        sourceOrigin: ctx.sourceOrigin,
        postId: ctx.postId,
        capturedAt: ctx.capturedAt,
        geometry: null,
        sanitization: null,
        network: null,
        captureDigest: null,
        title: ctx.title,
        composition: null,
      },
    });
    return { status: "degraded", reason, capture };
  } catch (err) {
    // Even the degrade record failing must not surface to the gate.
    console.warn(
      `[cms-preview-capture] could not record the degraded capture (${reason}):`,
      err instanceof Error ? err.message : err,
    );
    return { status: "degraded", reason, capture: null };
  }
}

/** Step 5 (isolated render) + the pinned write, for ONE role's document. */
async function renderAndPin(
  role: CmsPreviewCaptureRole,
  html: string,
  page: FetchedBasePage,
  ctx: {
    input: CapturePinnedPreviewInput | CapturePinnedPreviewPairInput;
    capturedAt: string;
    title: string;
    composition: { substitutedRegions: string[]; unmatchedFields: string[] } | null;
  },
  deps: PreviewCaptureDeps,
): Promise<CapturePinnedPreviewOutcome> {
  const degradeCtx = {
    input: ctx.input,
    capturedAt: ctx.capturedAt,
    title: ctx.title,
    sourceOrigin: page.target.origin,
    postId: page.target.postId,
  };
  // 5. ISOLATION — render in the subprocess.
  const rendered = await deps.renderIsolated({
    html,
    documentUrl: page.target.url,
    allowedOrigin: page.target.origin,
    // The renderer's browser resolves DNS ITSELF. Handing it only an origin
    // string would leave a DNS-rebind hole the parent's guard already closed for
    // its own request (a codex convergence finding): the name could re-resolve to
    // an internal address between the signed fetch and the subresource load. So
    // the guard-validated addresses travel with the page, and the renderer pins
    // its resolver to exactly them.
    pinnedAddresses: page.pinnedAddresses,
    timeoutMs: RENDER_TIMEOUT_MS,
  });
  if (!rendered.ok) return await writeDegraded(role, rendered.reason, degradeCtx, deps);

  const capture = await deps.writeCapture({
    orgId: ctx.input.orgId,
    createdBy: ctx.input.createdBy ?? null,
    producerRunId: ctx.input.producerRunId ?? null,
    screenshot: rendered.screenshot,
    data: {
      role,
      status: "captured",
      degradedReason: null,
      boundArtifactId: ctx.input.boundArtifactId,
      boundSnapshotRevisionId: ctx.input.boundSnapshotRevisionId,
      sourceOrigin: page.target.origin,
      postId: page.target.postId,
      capturedAt: ctx.capturedAt,
      geometry: rendered.geometry,
      sanitization: { ...page.removed },
      network: rendered.network,
      // The digest is of the document THIS capture rendered — so a composed
      // proposal and the base page it was composed from are distinguishable by
      // provenance, not only by role.
      captureDigest: createHash("sha256").update(html).digest("hex"),
      title: ctx.title,
      composition: ctx.composition,
    },
  });
  return { status: "captured", capture };
}

/**
 * Capture (or honestly degrade) the pinned preview for one gate target, in ONE
 * role, from a straight fetched render. This is the `applied` read-back path
 * (and the L-B single-capture contract, unchanged).
 * NEVER throws — a capture failure must not block the gate.
 */
export async function capturePinnedPreview(
  input: CapturePinnedPreviewInput,
  deps: PreviewCaptureDeps,
): Promise<CapturePinnedPreviewOutcome> {
  const capturedAt = deps.now().toISOString();
  const title = input.title ?? "Page capture";
  try {
    const base = await fetchSanitizedBasePage(input, deps);
    if (!base.ok) {
      return await writeDegraded(
        input.role,
        base.reason,
        { input, capturedAt, title, sourceOrigin: base.sourceOrigin, postId: base.postId },
        deps,
      );
    }
    return await renderAndPin(
      input.role,
      base.page.html,
      base.page,
      { input, capturedAt, title, composition: null },
      deps,
    );
  } catch (err) {
    console.warn(
      "[cms-preview-capture] capture failed:",
      err instanceof Error ? err.message : err,
    );
    return await writeDegraded(
      input.role,
      "render-failed",
      { input, capturedAt, title, sourceOrigin: null, postId: null },
      deps,
    );
  }
}

// ---------------------------------------------------------------------------
// L-D — the BEFORE/AFTER PAIR.
// ---------------------------------------------------------------------------

export interface CapturePinnedPreviewPairInput {
  orgId: string;
  boundArtifactId: string;
  boundSnapshotRevisionId: string;
  sourceUrl: string | null;
  externalId: string | null;
  /** The reviewed proposal's canonical field map — the SAME serialization the
   * gate pinned and the S4 read-back verifies against. `null` when it could not
   * be read, which degrades the proposal half with a named reason instead of
   * showing the base page twice. */
  proposedFields: Readonly<Record<string, string>> | null;
  title?: string;
  createdBy?: string | null;
  producerRunId?: string | null;
}

export interface CapturePinnedPairOutcome {
  before: CapturePinnedPreviewOutcome;
  current: CapturePinnedPreviewOutcome;
}

/**
 * Pin BOTH halves of #2044's visual before/after at gate creation, from ONE
 * signed fetch:
 *
 *   `before`  — the live page exactly as fetched (the site still holds the base
 *               content; the effect is held).
 *   `current` — the proposal placed into that page's OWN adapter-marked regions
 *               and re-rendered, so the reviewer sees the proposed content in the
 *               site's real theme chrome.
 *
 * Each half degrades INDEPENDENTLY with its own named reason: a failure of the
 * composition never costs the reviewer the base picture, and neither can ever
 * fail the gate.
 */
export async function capturePinnedPreviewPair(
  input: CapturePinnedPreviewPairInput,
  deps: PreviewCaptureDeps,
): Promise<CapturePinnedPairOutcome> {
  const capturedAt = deps.now().toISOString();
  const title = input.title ?? "Page capture";
  const bothDegraded = async (
    reason: CaptureDegradeReason,
    sourceOrigin: string | null,
    postId: number | null,
  ): Promise<CapturePinnedPairOutcome> => ({
    before: await writeDegraded(
      "before",
      reason,
      { input, capturedAt, title, sourceOrigin, postId },
      deps,
    ),
    current: await writeDegraded(
      "current",
      reason,
      { input, capturedAt, title, sourceOrigin, postId },
      deps,
    ),
  });

  try {
    const base = await fetchSanitizedBasePage(input, deps);
    if (!base.ok) return await bothDegraded(base.reason, base.sourceOrigin, base.postId);
    const page = base.page;

    // The live page, as it stands.
    const before = await renderAndPin(
      "before",
      page.html,
      page,
      { input, capturedAt, title, composition: null },
      deps,
    );

    // The proposal, composed into that page's adapter-marked regions.
    const degradeCurrent = (reason: CaptureDegradeReason) =>
      writeDegraded(
        "current",
        reason,
        {
          input,
          capturedAt,
          title,
          sourceOrigin: page.target.origin,
          postId: page.target.postId,
        },
        deps,
      );

    if (!input.proposedFields || Object.keys(input.proposedFields).length === 0) {
      return { before, current: await degradeCurrent("no-proposed-fields") };
    }
    const composed = composeProposedRegions(page.html, input.proposedFields);
    if (composed.substitutedRegions.length === 0) {
      // The adapter marked no region for anything that changed. Showing the base
      // page a second time would imply the proposal looks identical, which is not
      // known — so the proposal half states the gap instead.
      return { before, current: await degradeCurrent("no-owned-regions") };
    }
    // The proposed values are remote-authored content too: re-verify the WHOLE
    // composed document before it is rendered or stored (the base page was
    // already proven inert; this checks what composition introduced).
    const violations = findInertnessViolations(composed.html);
    if (violations.length > 0) {
      console.warn(
        `[cms-preview-capture] refusing a composed proposal page that is still live: ${violations
          .map((v) => v.kind)
          .join(", ")}`,
      );
      return { before, current: await degradeCurrent("composition-not-inert") };
    }

    const current = await renderAndPin(
      "current",
      composed.html,
      page,
      {
        input,
        capturedAt,
        title,
        composition: {
          substitutedRegions: composed.substitutedRegions,
          unmatchedFields: composed.unmatchedFields,
        },
      },
      deps,
    );
    return { before, current };
  } catch (err) {
    console.warn(
      "[cms-preview-capture] pair capture failed:",
      err instanceof Error ? err.message : err,
    );
    return await bothDegraded("render-failed", null, null);
  }
}

// ---------------------------------------------------------------------------
// The REAL host deps.
// ---------------------------------------------------------------------------

/** Loopback hosts a NON-PRODUCTION instance may capture — the exact class
 * `validateWidgetOrigin` already accepts as a connect origin under the same
 * `NODE_ENV !== "production"` rule. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

function isDevLoopbackOrigin(url: URL): boolean {
  if (process.env.NODE_ENV === "production") return false;
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
      // An open redirect on the site must never walk the SIGNED request to
      // another address.
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
 * constructing this does no I/O and drags no store onto any route graph
 * (the `register-cms-review-host-seam-runtime` posture).
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
    resolvePreviewSecrets: async (siteId) => {
      const { resolvePreviewSharedSecrets } = await import("@/lib/webhook-secret-service");
      return resolvePreviewSharedSecrets({ ...WORDPRESS_PREVIEW_BINDING, siteId });
    },
    fetchPreview: fetchPreviewGuarded,
    renderIsolated: renderIsolatedSubprocess,
    writeCapture: async (i) =>
      (await import("./cms-preview-capture-store")).writePinnedPreviewCapture(i),
    readPinnedCaptures: async (i) =>
      (await import("./cms-preview-capture-store")).readPinnedPreviewCaptures(i),
    now: () => new Date(),
  };
}

/**
 * L-D — the POST-APPLY read-back render (#2044: S4 verification gets "reviewed
 * vs applied read-back render"). Captured AFTER an approved apply lands, so this
 * one is a straight fetch: the site now really carries the applied content.
 *
 * The site it targets is recovered from the captures the GATE already pinned —
 * never re-derived from connector input at read-back time — so the read-back can
 * only ever photograph the same origin + post the capture-time SSRF policy
 * already resolved. No pinned capture ⇒ no target ⇒ a named degrade.
 */
export async function capturePostApplyPreview(
  input: {
    orgId: string;
    boundArtifactId: string;
    boundSnapshotRevisionId: string;
    title?: string;
    createdBy?: string | null;
    producerRunId?: string | null;
  },
  deps: PreviewCaptureDeps,
): Promise<CapturePinnedPreviewOutcome> {
  let sourceUrl: string | null = null;
  let externalId: string | null = null;
  try {
    const pinned = await deps.readPinnedCaptures({
      orgId: input.orgId,
      boundArtifactId: input.boundArtifactId,
      boundSnapshotRevisionId: input.boundSnapshotRevisionId,
    });
    const withTarget = pinned.find(
      (c) => c.data.sourceOrigin !== null && c.data.postId !== null && c.data.role !== "applied",
    );
    if (withTarget) {
      sourceUrl = withTarget.data.sourceOrigin;
      externalId = withTarget.data.postId === null ? null : String(withTarget.data.postId);
    }
  } catch (err) {
    console.warn(
      "[cms-preview-capture] could not read the gate's pinned captures for the read-back render:",
      err instanceof Error ? err.message : err,
    );
  }
  // A null selector resolves to the policy's `unusable-source-url` denial — the
  // same closed, named degrade every other missing-target case takes.
  return capturePinnedPreview({ ...input, role: "applied", sourceUrl, externalId }, deps);
}

/** Race any capture against the hard wall-clock ceiling. */
async function withCeiling<T>(work: Promise<T>, onTimeout: () => T, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, ceiling]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Capture ONE role for a gate target (the post-apply read-back render). Bounded
 * by a hard wall-clock ceiling and swallowing every failure.
 */
export async function capturePinnedPreviewForGate(
  input: CapturePinnedPreviewInput,
): Promise<CapturePinnedPreviewOutcome> {
  return withCeiling(
    capturePinnedPreview(input, createPreviewCaptureDeps()),
    () => ({ status: "degraded", reason: "capture-timeout", capture: null }),
    CAPTURE_TOTAL_TIMEOUT_MS,
  );
}

/**
 * The entry point the CMS-review host seam calls at gate creation: BOTH halves
 * of the visual before/after, from one signed fetch. Bounded by the same hard
 * ceiling (the two renders share it — the staged write awaits this) and
 * swallowing every failure: the staged write and its gate proceed regardless of
 * what the captures do.
 */
export async function capturePinnedPreviewPairForGate(
  input: CapturePinnedPreviewPairInput,
): Promise<CapturePinnedPairOutcome> {
  const timedOut: CapturePinnedPreviewOutcome = {
    status: "degraded",
    reason: "capture-timeout",
    capture: null,
  };
  return withCeiling(
    capturePinnedPreviewPair(input, createPreviewCaptureDeps()),
    () => ({ before: timedOut, current: timedOut }),
    CAPTURE_PAIR_TOTAL_TIMEOUT_MS,
  );
}

/** The entry point the CMS-review host seam calls after an approved apply lands
 * — the `applied` half of #2044's "reviewed vs applied read-back render". */
export async function capturePostApplyPreviewForGate(input: {
  orgId: string;
  boundArtifactId: string;
  boundSnapshotRevisionId: string;
  title?: string;
  createdBy?: string | null;
  producerRunId?: string | null;
}): Promise<CapturePinnedPreviewOutcome> {
  return withCeiling(
    capturePostApplyPreview(input, createPreviewCaptureDeps()),
    () => ({ status: "degraded", reason: "capture-timeout", capture: null }),
    CAPTURE_TOTAL_TIMEOUT_MS,
  );
}
