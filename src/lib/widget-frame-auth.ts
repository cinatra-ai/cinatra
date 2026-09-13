import "server-only";

// ---------------------------------------------------------------------------
// SERVER-SIDE RE-DERIVATION for the first-party widget frame (cinatra#2674,
// epic #2564 S8e).
//
// THE PROBLEM. Until this slice, the authority behind a widget sign-in was a
// credential the CMS BACKEND presented: the site held a `cnx_`, called
// `/api/widget-auth/init` with it, and the server resolved {site, org, origin,
// client} from that credential. That is why the credential then came back to the
// site — it was the site's transaction. Making the sign-in the FRAME's means the
// frame starts it, and the frame holds no credential and must hold none: it is a
// public document that any visitor to the CMS page loads.
//
// SO AUTHORITY COMES FROM THE SERVER'S OWN ROWS, NOT FROM THE REQUEST. Every
// value a caller supplies here is a SELECTOR: it may narrow, disambiguate, or be
// refused, and it can never select something the server did not already
// establish. The derivation runs strictly one way:
//
//   assistant (?assistant)  --closed host table-->  agentSlug + instancesConfigKey
//   instanceId (?instanceId) --connector config-->  the instance's registered origin
//   {client, that origin}    --connect_sites  -->  EXACTLY ONE active site row
//   site.widgetOrigin        --strict resolver-->  the canonical instanceId
//
// and then the LOOP MUST CLOSE: the canonical instance re-derived from the site's
// own origin must be the instance the caller named. Zero matches, several
// matches, a site whose origin is not the instance's, an instance that does not
// round-trip — every one of them is a DENY, never a "pick the first" and never a
// fallback to something adjacent. That closure is what makes a parent-supplied
// selector unable to reach another site's data: naming site B's instance from
// site A's page produces a denial, because site A's page cannot frame an
// instance whose registered origin is not site A (`frame-ancestors`), and the
// re-derivation would refuse it here even if it could.
//
// THE AGENT IS NOT A CALLER INPUT AT ALL (codex round 0, finding 1). An earlier
// draft accepted an `agentSlug` and merely checked that its connector key matched
// the assistant's — which would have let a caller name a DIFFERENT approved agent
// in the same connector family, and (because the embed page's `?assistant` is a
// handle, not a slug) also broke every real sign-in. The slug now comes from the
// same CLOSED host-side table the chat route resolves it from, so there is one
// definition of "which agent does this assistant mean" and no request field that
// can reach it.
//
// WHAT THE CALLER MAY OFFER, AND WHAT IT BUYS THEM. A claimed `siteId` and a
// claimed `origin` are accepted and CHECKED — they must equal what was derived —
// because a mismatch is a signal worth failing on rather than ignoring. They
// never select: dropping them changes nothing about the answer.
//
// THE SAME-ORIGIN GATE IS DEFENSE IN DEPTH, NOT THE BOUNDARY. `resolveFrameRequestOrigin`
// refuses a request that is not the Cinatra frame's own. Headers are forgeable
// outside a browser, so this is not what stops a CMS backend from running the
// flow itself. What stops that is in the ceremony, not here: the hosted sign-in
// returns its authorization code by `postMessage` to the CINATRA ORIGIN ONLY, and
// no amount of header forgery makes a browser deliver that message to a CMS
// page. This gate exists so a BROWSER-driven cross-origin call fails early and
// visibly.
//
// AND THE ORIGIN IT EXPECTS IS THE OPERATOR'S, NOT THE REQUEST'S (cinatra#3330).
// The gate used to compare `Origin` with `new URL(request.url).origin`. That is
// the framework's own derivation — the forwarded protocol, the configured server
// hostname and the listen port — so on a boot whose public address differs from
// its bind address it is a bind-address origin the frame's `Origin` can never
// equal, and every legitimate frame sign-in was refused. `Host` and the
// `X-Forwarded-*` headers are no sounder an authority: they are caller-supplied
// unless a trusted proxy is guaranteed to overwrite them, and this module has
// already said off-browser headers are forgeable. So the expected origin comes
// from the operator-controlled CANONICAL ORIGIN ALLOWLIST — the configured
// auth/local origin and the saved configured public base origin, the same set
// `getTrustedTokenOrigins()` already governs token verification and OAuth CSRF
// with — matched EXACTLY on scheme, host and port. The matcher hands the matched
// member back, and both frame routes build their public URLs (the init route's
// `authorizeUrl`, the token route's `issuerBaseUrl`) from THAT, because a 200
// carrying an authorize URL on an origin that is not the frame's own is a
// refusal the client performs instead of the server.
// ---------------------------------------------------------------------------

import { getTrustedTokenOrigins } from "@cinatra-ai/mcp-server/credentials";

import { listActiveConnectSitesForClientOrigin } from "@/lib/connect-sites-store";
import { resolveAssistantWidgetBinding } from "@/lib/assistant-widget-handles";
import { resolveInstanceFrameAncestor } from "@/lib/embed/frame-ancestors.server";
import { normalizeOriginStrict } from "@/lib/widget-token-broker";
import {
  resolveCanonicalInstanceForOrigin,
  type VerifiedSiteContext,
} from "@/lib/widget-user-auth";

/** Why a frame binding could not be derived. For the AUDIT TRAIL only — every
 *  route answers the browser with one generic shape (no oracle). */
export type FrameBindingDenial =
  /** `?assistant` is not one of the closed host-side widget bindings. */
  | "unknown_assistant"
  /** The agent slug does not resolve, or is not this assistant's agent. */
  | "unknown_agent"
  /** `?instanceId` names zero or several rows in the connector config. */
  | "instance_unresolved"
  /** No ACTIVE connect site is bound to {client, the instance's origin}. */
  | "site_unresolved"
  /** Several active sites share {client, origin} — the server cannot choose. */
  | "site_ambiguous"
  /** The site row cannot anchor authorization (no org, no normalizable origin). */
  | "site_unbound"
  /** The canonical instance re-derived from the site's origin is not the one
   *  named — the loop did not close. */
  | "instance_mismatch"
  /** A caller-supplied selector disagrees with what the server derived. */
  | "selector_mismatch";

export type FrameBinding = {
  /** The verified site — the SAME shape the `cnx_` path produced, derived
   *  without a credential. */
  site: VerifiedSiteContext;
  /** The canonical instance, re-derived from the site's own verified origin. */
  instanceId: string;
  /** The widget agent slug, from the CLOSED host-side table — never a caller
   *  value. The route consumes THIS to resolve the agent entry. */
  agentSlug: string;
  /** The connector config key / CMS client ("wordpress" | "drupal"). */
  instancesConfigKey: string;
};

export type FrameBindingResult =
  | { ok: true; binding: FrameBinding }
  | { ok: false; reason: FrameBindingDenial };

export type FrameOriginResult =
  /** The `Origin` is an exact member of the canonical allowlist; this is the
   *  member it matched, and it is what the routes build public URLs from. */
  | { ok: true; canonicalOrigin: string }
  | { ok: false };

/**
 * The operator-controlled allowlist of canonical origins, `new URL(...).origin`
 * normalised so the comparison is exactly scheme + host + port and nothing else
 * (a trailing slash, a default port or a path on a configured value cannot make
 * a member unmatchable, and cannot make a non-member match). A malformed entry
 * is skipped rather than trusted as an opaque string.
 */
function canonicalFrameOrigins(): string[] {
  const out = new Set<string>();
  for (const entry of getTrustedTokenOrigins()) {
    try {
      out.add(new URL(entry).origin);
    } catch {
      /* an unparseable configured value is not an origin — skip it */
    }
  }
  return Array.from(out);
}

/**
 * Is this request the Cinatra frame's own first-party call, and if so, on WHICH
 * canonical origin?
 *
 * A same-origin `fetch` POST always carries `Origin` (the Fetch standard omits it
 * only for same-origin GET/HEAD), so a missing `Origin` on a POST is not a
 * browser we serve. The `Origin` must then be an exact member of the canonical
 * allowlist — never `new URL(request.url).origin`, never `Host`, never a
 * forwarded header (see the module header, cinatra#3330). `Sec-Fetch-Site` is
 * checked when present and must say `same-origin`; it is not REQUIRED, because a
 * browser that does not send it is still bound by the `Origin` comparison and by
 * the absence of any CORS response header — it could never read the answer
 * cross-origin regardless.
 *
 * Defense in depth. See the module header for what the actual boundary is.
 */
export function resolveFrameRequestOrigin(request: Request): FrameOriginResult {
  const header = request.headers.get("Origin");
  if (!header) return { ok: false };
  let claimed: string;
  try {
    claimed = new URL(header).origin;
  } catch {
    return { ok: false };
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin") return { ok: false };
  const matched = canonicalFrameOrigins().find((origin) => origin === claimed);
  if (!matched) return { ok: false };
  return { ok: true, canonicalOrigin: matched };
}

/**
 * Derive the authoritative widget binding for a frame from PUBLIC SELECTORS.
 *
 * `assistant` and `instanceId` are the frame's own URL disambiguators — the same
 * two values the `frame-ancestors` wall is computed from, so a frame that is
 * allowed to be on the page at all is describing the instance whose registered
 * origin is that page. `claimedSiteId` / `claimedOrigin` are optional
 * cross-checks. The AGENT is not an input: it is derived from the assistant.
 *
 * Returns the verified site context, the canonical instance and the agent — or a
 * typed denial. There is no partially-derived answer: a binding that could not
 * close every step is not a narrower binding, it is a wrong one.
 */
export function deriveFrameBinding(input: {
  assistant: string;
  instanceId: string;
  claimedSiteId?: string | null;
  claimedOrigin?: string | null;
}): FrameBindingResult {
  const assistant = String(input.assistant ?? "").trim();
  const instanceId = String(input.instanceId ?? "").trim();

  // 1. THE ASSISTANT → its agent slug AND its client, through the CLOSED
  //    host-side binding table. Never caller-derived: an unknown/forged
  //    `?assistant` stops here, and no request field names the agent.
  const binding = resolveAssistantWidgetBinding(assistant);
  if (!binding) return { ok: false, reason: "unknown_assistant" };
  const agentSlug = binding.agentSlug;
  const instancesConfigKey = binding.instancesConfigKey;

  // 2. THE INSTANCE → its registered origin. This resolver is deliberately the
  //    authorization-UNUSABLE direction (instance → origin); it is used here only
  //    to LEARN which origin to look a site up by, and step 4 re-derives the
  //    instance the authoritative way (origin → instance) and requires the two to
  //    agree. Zero / duplicate instance rows fail closed inside the resolver.
  const instanceOrigin = resolveInstanceFrameAncestor({
    instancesConfigKey,
    instanceId,
  });
  if (!instanceOrigin) return { ok: false, reason: "instance_unresolved" };

  // 3. THE SITE → EXACTLY ONE active connect-site bound to {client, that origin}.
  //    Zero means the CMS is not connected; several means the server cannot say
  //    which tenant this page belongs to. Both refuse.
  const sites = listActiveConnectSitesForClientOrigin({
    client: instancesConfigKey,
    widgetOrigin: instanceOrigin,
  });
  if (sites.length === 0) return { ok: false, reason: "site_unresolved" };
  if (sites.length > 1) return { ok: false, reason: "site_ambiguous" };
  const row = sites[0];

  const orgId = typeof row.orgId === "string" ? row.orgId.trim() : "";
  const siteOrigin = normalizeOriginStrict(row.widgetOrigin);
  const credentialVersion = Number(row.credentialVersion);
  // A site with no bound org, no normalizable origin or no usable credential
  // generation cannot anchor a per-user authorization — the same three
  // preconditions the `cnx_` path enforces in `siteContextFromBinding`.
  if (!orgId || !siteOrigin || !Number.isFinite(credentialVersion)) {
    return { ok: false, reason: "site_unbound" };
  }
  const site: VerifiedSiteContext = {
    siteId: row.siteId,
    client: row.client,
    orgId,
    siteOrigin,
    credentialVersion,
  };

  // 4. THE LOOP CLOSES. Re-derive the canonical instance the AUTHORITATIVE way —
  //    from the site's own verified origin, with the strict resolver that denies
  //    on zero or multiple matches — and require it to be the instance named. A
  //    claimed instance that does not round-trip is refused, not silently
  //    replaced by whatever the origin resolves to.
  const canonicalInstanceId = resolveCanonicalInstanceForOrigin({
    instancesConfigKey,
    origin: site.siteOrigin,
    claimedInstanceId: instanceId,
  });
  if (!canonicalInstanceId || canonicalInstanceId !== instanceId) {
    return { ok: false, reason: "instance_mismatch" };
  }

  // 5. THE OPTIONAL CROSS-CHECKS. A caller that names a site id or an origin must
  //    name the derived ones. These never widen anything — omitting them yields
  //    the identical binding — so their only effect is to turn a disagreement
  //    into a refusal instead of a silent acceptance.
  const claimedSiteId =
    typeof input.claimedSiteId === "string" ? input.claimedSiteId.trim() : "";
  if (claimedSiteId && claimedSiteId !== site.siteId) {
    return { ok: false, reason: "selector_mismatch" };
  }
  const claimedOrigin = normalizeOriginStrict(input.claimedOrigin ?? "");
  if (
    typeof input.claimedOrigin === "string" &&
    input.claimedOrigin.trim().length > 0 &&
    claimedOrigin !== site.siteOrigin
  ) {
    return { ok: false, reason: "selector_mismatch" };
  }

  return {
    ok: true,
    binding: { site, instanceId: canonicalInstanceId, agentSlug, instancesConfigKey },
  };
}
