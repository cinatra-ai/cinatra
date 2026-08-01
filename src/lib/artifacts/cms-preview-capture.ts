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

/** The same tuple for Drupal (`connect-provisioning.ts` DRUPAL_WEBHOOK_BINDING).
 * A Drupal site's shared secret is provisioned under the DRUPAL connector's
 * binding, so looking a preview credential up under the WordPress tuple would
 * find nothing and degrade every Drupal gate as `no-preview-credential`. */
export const DRUPAL_PREVIEW_BINDING = {
  vendor: "cinatra-ai",
  slug: "drupal-mcp-connector",
  hook: "node-published",
} as const;

/** The preview-credential binding for a connect client kind. A client with no
 * entry has no preview adapter either (the addressing policy refuses it first),
 * so this map never has to guess. */
const PREVIEW_BINDINGS: ReadonlyMap<
  string,
  { readonly vendor: string; readonly slug: string; readonly hook: string }
> = new Map<string, { readonly vendor: string; readonly slug: string; readonly hook: string }>([
  ["wordpress", WORDPRESS_PREVIEW_BINDING],
  ["drupal", DRUPAL_PREVIEW_BINDING],
]);

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

/** The injected host seams — real in `capturePinnedPreviewWithHostDeps`, stubbed
 * in unit tests, so the whole allow/deny/degrade matrix is provable without a
 * site, a browser, or a database. */
export interface PreviewCaptureDeps {
  /** The org's ACTIVE connect-registered sites (host-read, never adapter input). */
  listRegisteredSites: (orgId: string) => Promise<readonly RegisteredCaptureSite[]>;
  /** Candidate shared secrets for a site's preview credential, in priority
   * order (current, then a non-expired previous during a rotation window). The
   * CLIENT kind is required, not optional: each CMS's secret lives under its own
   * connector's webhook binding, so the lookup is per-platform. */
  resolvePreviewSecrets: (input: {
    siteId: string;
    client: string;
  }) => Promise<readonly string[]>;
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
  const secrets = await deps.resolvePreviewSecrets({
    siteId: target.siteId,
    client: target.client,
  });
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

/** Sum two removal-count maps (base page + composed values). */
function mergeCounts(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + (Number(v) || 0);
  return out;
}

/**
 * The identity every capture write shares: WHICH gate target the picture is
 * pinned to, and the provenance stamped on the record. Every capture input
 * (`CapturePinnedPreviewInput`, `CapturePinnedPreviewPairInput`,
 * `CaptureRepairedPreviewInput`) structurally satisfies it, so the write helpers
 * below take this narrow shape rather than a union that has to grow with every
 * new capture entry point.
 */
interface PinnedCaptureBinding {
  orgId: string;
  boundArtifactId: string;
  boundSnapshotRevisionId: string;
  createdBy?: string | null;
  producerRunId?: string | null;
}

/**
 * Report the record that is actually PINNED, not what this attempt intended.
 *
 * `writePinnedPreviewCapture` is immutable — a retry against an already-pinned
 * (target, role) returns the FIRST record untouched — and the repair drain is
 * retried whenever its completion did not land, so second attempts are
 * reachable in production. Reporting this attempt's own intent would then lie in
 * BOTH directions: a successful re-render would claim `captured` while the gate
 * still renders the first attempt's stated gap, and a degrade after a good
 * capture would raise a missing-picture alarm for a picture that is right there.
 * Callers act on these outcomes (cinatra#2044's drain counts and escalates
 * them), so every outcome must describe the STORE, never the attempt.
 */
function reportStored(
  stored: StoredPreviewCapture,
  intended: CaptureDegradeReason | null,
): CapturePinnedPreviewOutcome {
  if (stored.data.status === "captured") return { status: "captured", capture: stored };
  return {
    status: "degraded",
    // A degraded record always carries its reason; `intended` only covers a
    // record shape that predates the field.
    reason: (stored.data.degradedReason as CaptureDegradeReason | null) ?? intended ?? "render-failed",
    capture: stored,
  };
}

/** Write ONE degraded capture record for a role. Never throws. */
async function writeDegraded(
  role: CmsPreviewCaptureRole,
  reason: CaptureDegradeReason,
  ctx: {
    input: PinnedCaptureBinding;
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
    return reportStored(capture, reason);
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
    input: PinnedCaptureBinding;
    capturedAt: string;
    title: string;
    composition: { substitutedRegions: string[]; unplacedFields: string[] } | null;
    /** Sanitizer removals introduced by composition, merged into the record's
     * own `sanitization` counts. */
    extraSanitization?: Record<string, number>;
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
      sanitization: mergeCounts(page.removed, ctx.extraSanitization),
      network: rendered.network,
      // The digest is of the document THIS capture rendered — so a composed
      // proposal and the base page it was composed from are distinguishable by
      // provenance, not only by role.
      captureDigest: createHash("sha256").update(html).digest("hex"),
      title: ctx.title,
      composition: ctx.composition,
    },
  });
  return reportStored(capture, null);
}

/**
 * Compose a proposal into the fetched page's OWN adapter-marked regions and pin
 * the result under `role`, degrading with a NAMED reason at every step that
 * cannot honestly produce the picture.
 *
 * Shared by the two composed pictures the review surface shows — the stage-time
 * `current` half of the L-D pair and cinatra#2286's repair-time `repaired`
 * capture — so the reviewer's "reviewed proposal" and "the producer's fix" can
 * never be produced by two subtly different pipelines (the comparison is only
 * meaningful because both sides are composed the same way).
 */
async function composeAndPin(
  role: CmsPreviewCaptureRole,
  proposedFields: Readonly<Record<string, string>> | null,
  page: FetchedBasePage,
  ctx: { input: PinnedCaptureBinding; capturedAt: string; title: string },
  deps: PreviewCaptureDeps,
): Promise<CapturePinnedPreviewOutcome> {
  const degrade = (reason: CaptureDegradeReason) =>
    writeDegraded(
      role,
      reason,
      {
        input: ctx.input,
        capturedAt: ctx.capturedAt,
        title: ctx.title,
        sourceOrigin: page.target.origin,
        postId: page.target.postId,
      },
      deps,
    );

  if (!proposedFields || Object.keys(proposedFields).length === 0) {
    return await degrade("no-proposed-fields");
  }
  const composed = composeProposedRegions(page.html, proposedFields);
  if (composed.substitutedRegions.length === 0) {
    // Nothing of the proposal reached the picture. Showing the base page a
    // second time would imply the proposal looks identical, which is not known
    // — so the proposal half states the gap, with the reason DISTINGUISHED:
    // the site marked none of the changed fields, or it marked them and their
    // elements could not be delimited.
    return await degrade(composed.noMatchingAnchors ? "no-owned-regions" : "regions-unplaceable");
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
    return await degrade("composition-not-inert");
  }

  return await renderAndPin(
    role,
    composed.html,
    page,
    {
      input: ctx.input,
      capturedAt: ctx.capturedAt,
      title: ctx.title,
      composition: {
        substitutedRegions: composed.substitutedRegions,
        unplacedFields: composed.unplacedFields,
      },
      // The sanitizer's removals from the SUBSTITUTED VALUES are added to the
      // base page's own, so the picture's caption reports everything that was
      // stripped — not only what the site's markup carried (a codex finding).
      extraSanitization: composed.removedFromValues,
    },
    deps,
  );
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
    const current = await composeAndPin(
      "current",
      input.proposedFields,
      page,
      { input, capturedAt, title },
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
// cinatra#2286 S10 — the REPAIRED picture (the repair pair's right-hand side).
// ---------------------------------------------------------------------------

/**
 * Recover the site coordinates a target was ALREADY captured against — the
 * origin + post id the capture-time SSRF policy resolved and the pinned record
 * stored. Never re-derives an address from connector input, so a later capture
 * of the same target can only ever photograph the same page the gate itself
 * already resolved (the `capturePostApplyPreview` posture, factored out so the
 * repair capture inherits it rather than re-deciding it).
 *
 * `excludeRole` skips the role being captured now, so a previously pinned
 * DEGRADED record of that same role (which carries no coordinates) can never
 * stand in for a real one.
 */
async function resolvePinnedTargetCoordinates(
  target: { orgId: string; boundArtifactId: string; boundSnapshotRevisionId: string },
  excludeRole: CmsPreviewCaptureRole,
  deps: PreviewCaptureDeps,
): Promise<{ sourceUrl: string | null; externalId: string | null }> {
  try {
    const pinned = await deps.readPinnedCaptures(target);
    const withTarget = pinned.find(
      (c) => c.data.sourceOrigin !== null && c.data.postId !== null && c.data.role !== excludeRole,
    );
    if (withTarget) {
      return {
        sourceUrl: withTarget.data.sourceOrigin,
        externalId: withTarget.data.postId === null ? null : String(withTarget.data.postId),
      };
    }
  } catch (err) {
    console.warn(
      "[cms-preview-capture] could not read a target's pinned captures for its site coordinates:",
      err instanceof Error ? err.message : err,
    );
  }
  return { sourceUrl: null, externalId: null };
}

export interface CaptureRepairedPreviewInput {
  orgId: string;
  /** The repair SUCCESSOR target — the re-staged snapshot the successor gate
   * pins, and the target this picture is bound to. */
  boundArtifactId: string;
  boundSnapshotRevisionId: string;
  /** The repair's BASE target — the reviewed proposal the successor replaces.
   * Used ONLY as the fallback source of the already-resolved site coordinates
   * (both targets are, by the repair's own resource matching, the same CMS
   * resource); nothing about the picture itself comes from it. */
  baseArtifactId: string;
  baseSnapshotRevisionId: string;
  /** The REPAIRED proposal's canonical field map — the same serialization the
   * successor gate pinned. `null` degrades the picture with a named reason
   * instead of showing the live page and calling it the fix. */
  proposedFields: Readonly<Record<string, string>> | null;
  title?: string;
  createdBy?: string | null;
  producerRunId?: string | null;
}

/**
 * Capture (or honestly degrade) the `repaired` picture — the third render of
 * cinatra#2044's repair round trip, and the right-hand side of #2287's `repair`
 * pair ("Reviewed — what you approved" vs "Repaired — the producer's fix").
 *
 * It is the SAME composed-proposal picture the stage-time `current` half is
 * (`composeAndPin`): at repair-response time the producer's fix is a STAGED
 * write whose external effect is still held by the successor gate, so the site
 * does not carry it yet — the honest picture is the repaired proposal placed
 * into the live page's own chrome, never a photograph of the site.
 *
 * NEVER throws, and never blocks the repair: every failure class becomes a
 * stored DEGRADED `repaired` record with a named reason, so the successor gate
 * states what is missing instead of rendering a silently one-sided pair.
 */
export async function captureRepairedPreview(
  input: CaptureRepairedPreviewInput,
  deps: PreviewCaptureDeps,
): Promise<CapturePinnedPreviewOutcome> {
  const capturedAt = deps.now().toISOString();
  const title = input.title ?? "Repaired proposal";
  try {
    // The successor's own re-stage captures first; the base target's second
    // (a re-stage whose capture pair degraded before it resolved a target
    // still leaves the base's coordinates, which name the same CMS resource).
    let coords = await resolvePinnedTargetCoordinates(
      {
        orgId: input.orgId,
        boundArtifactId: input.boundArtifactId,
        boundSnapshotRevisionId: input.boundSnapshotRevisionId,
      },
      "repaired",
      deps,
    );
    if (coords.sourceUrl === null || coords.externalId === null) {
      coords = await resolvePinnedTargetCoordinates(
        {
          orgId: input.orgId,
          boundArtifactId: input.baseArtifactId,
          boundSnapshotRevisionId: input.baseSnapshotRevisionId,
        },
        "repaired",
        deps,
      );
    }

    // A null selector resolves to the policy's `unusable-source-url` denial —
    // the same closed, named degrade every other missing-target case takes.
    const base = await fetchSanitizedBasePage(
      { orgId: input.orgId, sourceUrl: coords.sourceUrl, externalId: coords.externalId },
      deps,
    );
    if (!base.ok) {
      return await writeDegraded(
        "repaired",
        base.reason,
        { input, capturedAt, title, sourceOrigin: base.sourceOrigin, postId: base.postId },
        deps,
      );
    }
    return await composeAndPin(
      "repaired",
      input.proposedFields,
      base.page,
      { input, capturedAt, title },
      deps,
    );
  } catch (err) {
    console.warn(
      "[cms-preview-capture] repaired capture failed:",
      err instanceof Error ? err.message : err,
    );
    return await writeDegraded(
      "repaired",
      "render-failed",
      { input, capturedAt, title, sourceOrigin: null, postId: null },
      deps,
    );
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
    resolvePreviewSecrets: async ({ siteId, client }) => {
      const binding = PREVIEW_BINDINGS.get(client);
      // Unreachable through the capture path (the addressing policy refuses an
      // unknown client first), but a missing binding must never fall back to
      // ANOTHER platform's credential — that would send one site's secret to a
      // different site. No binding => no candidate secrets => a named degrade.
      if (!binding) return [];
      const { resolvePreviewSharedSecrets } = await import("@/lib/webhook-secret-service");
      return resolvePreviewSharedSecrets({ ...binding, siteId });
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
  const { sourceUrl, externalId } = await resolvePinnedTargetCoordinates(
    {
      orgId: input.orgId,
      boundArtifactId: input.boundArtifactId,
      boundSnapshotRevisionId: input.boundSnapshotRevisionId,
    },
    "applied",
    deps,
  );
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

/**
 * The entry point the repair-completion drain reaches (through the boot-bound
 * `@cinatra-ai/host:cms-repaired-capture` port) when a producer's repair lands —
 * cinatra#2286's third picture, pinned against the SUCCESSOR target the repair
 * row itself recorded.
 *
 * The repaired proposal's field map is read HERE from the successor snapshot's
 * own stored serialization (`readCmsSnapshotProposedFields`) rather than taken
 * from the caller: the picture may only ever show what the successor gate
 * actually pins. That read is INSIDE the ceiling below — the repair drain awaits
 * this call before it submits the repair response, so work outside the ceiling
 * would delay a repair by exactly the amount the ceiling exists to bound (a
 * codex convergence finding).
 *
 * CEILING CAVEAT, stated rather than implied: `readCmsSnapshotProposedFields`
 * reaches the store through `runPostgresQueriesSync`, which parks the event loop
 * on `Atomics.wait`. No timer-based ceiling can preempt that — while it blocks,
 * the `setTimeout` below cannot fire. Its bound is the sync helper's OWN query
 * timeout, not this one. The ceiling still bounds every asynchronous phase (the
 * signed fetch, the headless render, the pinned write), which is where a capture
 * actually spends its time.
 *
 * Swallows every failure — the repair completes either way.
 */
export async function captureRepairedPreviewForGate(input: {
  orgId: string;
  successorArtifactId: string;
  successorSnapshotRevisionId: string;
  baseArtifactId: string;
  baseSnapshotRevisionId: string;
  title?: string;
  createdBy?: string | null;
  producerRunId?: string | null;
}): Promise<CapturePinnedPreviewOutcome> {
  const work = (async (): Promise<CapturePinnedPreviewOutcome> => {
    let proposedFields: Record<string, string> | null = null;
    try {
      const { readCmsSnapshotProposedFields } = await import("./cms-content-snapshot-capture");
      proposedFields = await readCmsSnapshotProposedFields(
        input.orgId,
        input.successorSnapshotRevisionId,
      );
    } catch (err) {
      // Unreadable ⇒ `no-proposed-fields`, a NAMED degrade recorded below —
      // never a silent skip, and never the live page passed off as the fix.
      console.warn(
        "[cms-preview-capture] could not read the repaired proposal's fields:",
        err instanceof Error ? err.message : err,
      );
    }
    return await captureRepairedPreview(
      {
        orgId: input.orgId,
        boundArtifactId: input.successorArtifactId,
        boundSnapshotRevisionId: input.successorSnapshotRevisionId,
        baseArtifactId: input.baseArtifactId,
        baseSnapshotRevisionId: input.baseSnapshotRevisionId,
        proposedFields,
        title: input.title,
        createdBy: input.createdBy,
        producerRunId: input.producerRunId,
      },
      createPreviewCaptureDeps(),
    );
  })();
  return withCeiling(
    work,
    // A ceiling hit records NOTHING (the capture is still in flight, and a
    // pinned record is immutable — writing a timeout record here would
    // permanently displace the real picture it may be about to land). So the
    // outcome is UNCONFIRMED rather than known-missing, and the drain reports it
    // with that distinction intact.
    () => ({ status: "degraded", reason: "capture-timeout", capture: null }),
    CAPTURE_TOTAL_TIMEOUT_MS,
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
