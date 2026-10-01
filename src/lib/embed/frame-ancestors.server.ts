import "server-only";

import { isConcreteOrigin, normalizeConcreteOrigin } from "@cinatra-ai/streams/origin-policy";

import { readConnectorConfigFromDatabase } from "@/lib/database";
import { resolveAssistantWidgetBinding } from "@/lib/assistant-widget-handles";
import { listActiveConnectSiteOrigins } from "@/lib/connect-sites-store";
import { readInstanceIdentityRequiringInstanceId } from "@/lib/instance-identity-store";

// ---------------------------------------------------------------------------
// S5 (cinatra#1221) Lane B §7 — the `/embed/assistant` frame-ancestors resolver.
//
// Goal: the embed page declares `Content-Security-Policy: frame-ancestors <the
// verified instance origin>` so the browser refuses to frame it anywhere but the
// instance's registered site — a clickjacking / rogue-embed wall. The directive
// is computed HERE (read-only) and applied in `proxy.ts` for the one exact path
// (an RSC cannot set a per-request header).
//
// FAIL-CLOSED to `'none'` on EVERY failure mode (unknown assistant, missing /
// non-normalizable siteUrl, DUPLICATE matching instanceId rows, or ANY thrown
// DB/read/normalize exception — the resolver is exception-wrapped so a throw
// NEVER produces an unprotected error response). A `'none'` page
// still renders the shell but cannot be framed — a safe, debuggable failure.
//
// NOT AN AUTHORIZATION BOUNDARY. This resolver only NARROWS framing; it maps
// instanceId -> origin (the OPPOSITE direction from the authoritative
// origin -> instance `resolveCanonicalInstanceForOrigin`, widget-user-auth.ts).
// It CANNOT select a write target and MUST NEVER be used for authorization
// The server still re-derives the write instance from the tokens.
// ---------------------------------------------------------------------------

/** The CSP `frame-ancestors` value for a page that must NOT be framed anywhere. */
export const FRAME_ANCESTORS_NONE = "'none'" as const;

// THE ONE ORIGIN RESOLVER, AND A SEAL AT THE POLICY BOUNDARY.
//
// A stored `siteUrl` is operator-supplied data that ends up INSIDE a browser
// policy, so it is judged by the shared resolver
// (`@cinatra-ai/streams/origin-policy`) rather than by "the URL parser did not
// throw" — the parser accepts a host that is a shape rather than a place, and
// such a value reads as a WILDCARD once it is interpolated into
// `frame-ancestors`. The resolver refuses it, and `sealPolicyOrigin` re-asserts
// the same verdict on the way out, at the last point before the value becomes
// a directive. The second reading is deliberate: this is the boundary where a
// wrong answer stops being a bad string and becomes a widened wall, and the
// seal costs one function call to make that impossible by construction rather
// than by trusting an upstream caller to have been careful.
function sealPolicyOrigin(origin: string): string | null {
  return isConcreteOrigin(origin) ? origin : null;
}

type StoredInstanceRow = { id?: unknown; siteUrl?: unknown };

// ---------------------------------------------------------------------------
// cinatra#3328 — THE SITE'S OWN STORED IDENTITY IS ALSO AN ANSWER.
//
// A site is connected in two steps that mint two different ids. The handshake
// (`provisionFromGrant`) writes the site's row in `connect_sites` and hands the
// site THIS APPLICATION'S OWN instance identity, which the site stores and puts
// into the widget's embed address. "Connect site" later writes a row in the
// connector's instances table under an id the connector mints for itself.
// Nothing copies the second id back to the site, so the gate — which only ever
// read the connector's instances — answered 'none' for the identity the site
// actually holds, and the widget framed nowhere until someone edited the site's
// stored value by hand.
//
// So when the connector's instances table has NO row for the presented id, the
// gate reads the row the handshake itself wrote. Two narrow conditions, both
// required, both fail-closed:
//
//   1. THE PRESENTED ID IS OUR OWN. The id must equal this application's single
//      instance identity — the value the handshake hands out and nothing else.
//      An arbitrary or forged selector never reaches the site table at all.
//   2. EXACTLY ONE ACTIVE SITE ORIGIN for that connect client. Zero means no
//      site is connected; several distinct origins mean the server cannot say
//      which site this page belongs to. Both refuse — the SAME ambiguity
//      discipline the instances road above already keeps, and the reason an
//      ambiguous DUPLICATE instance match is never rescued by this road.
//
// The host reads its OWN tables by the connect client NAME it already holds in
// the closed binding table; it learns nothing about, and special-cases nothing
// in, any particular connector package.
// ---------------------------------------------------------------------------
function resolveConnectSiteFrameAncestor(input: {
  connectClient: string;
  instanceId: string;
}): string | null {
  const connectClient = input.connectClient.trim();
  if (!connectClient || !input.instanceId) return null;

  // Condition 1 — the presented id is this application's own instance identity.
  const identity = readInstanceIdentityRequiringInstanceId();
  const ownInstanceId =
    identity && typeof identity.instanceId === "string" ? identity.instanceId.trim() : "";
  if (!ownInstanceId || ownInstanceId !== input.instanceId) return null;

  // Condition 2 — exactly one active site origin for this connect client, read
  // through the same fail-closed accessor the widget-stream allowlist uses.
  const origins = listActiveConnectSiteOrigins(connectClient);
  const distinct = Array.from(
    new Set(
      (Array.isArray(origins) ? origins : [])
        .map((value) => normalizeConcreteOrigin(typeof value === "string" ? value : ""))
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );
  if (distinct.length !== 1) return null;

  // The seal re-asserts the verdict at the boundary that produces a policy
  // value, exactly as the instances road does.
  return sealPolicyOrigin(distinct[0]);
}

/**
 * Read-only: resolve the single registered origin for `{instancesConfigKey,
 * instanceId}`, or `null` on ANY failure (missing / duplicate / non-normalizable
 * / thrown). Exception-wrapped: a DB/read/normalize throw becomes `null`, never
 * an escape. This is the authorization-UNUSABLE narrower — do NOT call it to
 * choose a write target.
 *
 * `connectSiteFallbackClient` (cinatra#3328) OPTS THE CALLER IN to the second
 * road described above: when the connector's instances table has no row for the
 * presented id, the site's own `connect_sites` row answers instead — but only
 * for the id the handshake hands out, and only when that client has exactly one
 * active site origin. A caller that omits the field behaves exactly as before.
 */
export function resolveInstanceFrameAncestor(input: {
  instancesConfigKey: string;
  instanceId: string;
  connectSiteFallbackClient?: string | null;
}): string | null {
  try {
    const instancesConfigKey = String(input.instancesConfigKey ?? "").trim();
    const instanceId = String(input.instanceId ?? "").trim();
    if (!instancesConfigKey || !instanceId) return null;

    const config = readConnectorConfigFromDatabase<{ instances?: unknown }>(
      instancesConfigKey,
      { instances: [] },
    );
    const instances: StoredInstanceRow[] = Array.isArray(config?.instances)
      ? (config.instances.filter((r) => r && typeof r === "object") as StoredInstanceRow[])
      : [];

    const matches = instances.filter(
      (r) => typeof r.id === "string" && r.id.trim() === instanceId,
    );
    // DUPLICATE matches → ambiguous: fail closed, NEVER select the first of
    // several rows, and NEVER let the second road rescue the ambiguity.
    if (matches.length > 1) return null;
    // Zero matches → the connector holds no row for this id. That is the filed
    // state of cinatra#3328 for a site that was connected through the handshake
    // and then added under the connector: ask the site's own row (opt-in, and
    // fail-closed inside the helper).
    if (matches.length === 0) {
      const connectClient = String(input.connectSiteFallbackClient ?? "").trim();
      if (!connectClient) return null;
      return resolveConnectSiteFrameAncestor({ connectClient, instanceId });
    }

    const siteUrl = typeof matches[0].siteUrl === "string" ? matches[0].siteUrl : "";
    // The shared resolver returns "" for a missing / non-http(s) /
    // wildcard-shaped / otherwise non-concrete siteUrl; the seal re-asserts the
    // same verdict at the boundary that produces a policy value.
    const origin = normalizeConcreteOrigin(siteUrl);
    return origin ? sealPolicyOrigin(origin) : null;
  } catch {
    // Any thrown DB/read/normalize exception → treat as unresolved (→ 'none').
    return null;
  }
}

/**
 * Read-only: the REGISTERED SITE URL for `{assistant, instanceId}` — the stored
 * value, not the origin the CSP is built from (cinatra#2683, codex round 1,
 * finding 4).
 *
 * The composer's "Remote chat" jump-out is built by the first-party destination
 * builder, which APPENDS a ratified path to the recorded `siteUrl` and so
 * preserves a subdirectory install (`https://example.com/blog/` →
 * `…/blog/wp-admin/`). Feeding it the CSP's origin-only value silently dropped
 * that path and pointed the widget's row somewhere `/chat`'s row does not.
 *
 * SAME NARROWING, SAME FAIL-CLOSED as the frame-ancestor resolver above: the
 * assistant maps through the CLOSED binding table, zero or duplicate matching
 * rows resolve to null, a non-http(s) or wildcard-shaped value resolves to null,
 * and any throw resolves to null. It is authorization-UNUSABLE — it selects a
 * link's destination, never a write target — and it reads no session and no user
 * data, so the embed shell stays dataless.
 */
export function resolveRegisteredInstanceSiteUrl(input: {
  assistant: string | null | undefined;
  instanceId: string | null | undefined;
}): string | null {
  try {
    const binding = resolveAssistantWidgetBinding(String(input.assistant ?? ""));
    if (!binding) return null;
    const instanceId = String(input.instanceId ?? "").trim();
    if (!instanceId) return null;
    const config = readConnectorConfigFromDatabase<{ instances?: unknown }>(
      binding.instancesConfigKey,
      { instances: [] },
    );
    const instances: StoredInstanceRow[] = Array.isArray(config?.instances)
      ? (config.instances.filter((r) => r && typeof r === "object") as StoredInstanceRow[])
      : [];
    const matches = instances.filter(
      (r) => typeof r.id === "string" && r.id.trim() === instanceId,
    );
    if (matches.length !== 1) return null;
    const siteUrl = typeof matches[0].siteUrl === "string" ? matches[0].siteUrl.trim() : "";
    // The stored value is operator-supplied, so it is re-validated here: the
    // ORIGIN must normalize concretely (no wildcard, no non-http(s)) before the
    // full URL — path included — is handed on.
    if (!normalizeConcreteOrigin(siteUrl)) return null;
    return siteUrl;
  } catch {
    return null;
  }
}

/**
 * The full CSP `frame-ancestors` directive VALUE for `/embed/assistant?assistant
 * =…&instanceId=…`. Returns `'none'` on every failure; on success returns the
 * single registered origin with NO `'self'` (the policy is "ONLY the registered
 * site" — `'self'` would additionally permit the Cinatra origin to frame it,
 * contradicting the scope). `assistant` is mapped to its
 * instances-config key via the CLOSED host-side binding table (NEVER
 * caller-derived); an unknown/forged assistant → `'none'`.
 */
export function frameAncestorsDirectiveFor(input: {
  assistant: string | null | undefined;
  instanceId: string | null | undefined;
}): string {
  const binding = resolveAssistantWidgetBinding(String(input.assistant ?? ""));
  if (!binding) return FRAME_ANCESTORS_NONE;

  const origin = resolveInstanceFrameAncestor({
    instancesConfigKey: binding.instancesConfigKey,
    instanceId: String(input.instanceId ?? ""),
    // The connect client name is the binding's OWN instances-config key — the
    // same value `widget-frame-auth` already looks `connect_sites` up by. It
    // comes from the CLOSED host-side table, never from the caller.
    connectSiteFallbackClient: binding.instancesConfigKey,
  });
  return origin ?? FRAME_ANCESTORS_NONE;
}

/**
 * The ONE answer to "is this request a VERIFIED widget frame, and which origin
 * is it?" — the resolved registered origin, or `null` (cinatra#2577).
 *
 * WHY IT IS SEPARATE FROM THE DIRECTIVE ABOVE. Two callers need the same
 * decision for two different purposes: the middleware writes it into the
 * island's `frame-ancestors`, and the island PAGE keys on it to draw the empty
 * island instead of redirecting a nested widget frame to an interactive
 * sign-in. One resolution, so the header and the page can never disagree about
 * whether a frame is a widget.
 *
 * A SECOND VALIDATION, ON PURPOSE (codex round 1, finding 1). The URL parser
 * normalizes `https://*` and `https://%2A.example.com` to an ORIGIN that STILL
 * contains `*`. Interpolated into `frame-ancestors` that is a wildcard letting
 * every HTTPS origin frame an authenticated reader's review target, off ONE
 * stored `siteUrl`. So the value is re-checked HERE, at the boundary that
 * writes policy — by the SAME shared resolver (`isConcreteOrigin`,
 * `@cinatra-ai/streams/origin-policy`, cinatra#2680) the directive resolver
 * already seals with, never by a second local reading of "what is an origin".
 * The resolver round-trips the value to its own canonical serialization and
 * refuses every wildcard spelling, credentials, an opaque origin and any host
 * that is not a real place — so a policy metacharacter cannot survive it.
 */
export function resolveVerifiedWidgetFrameOrigin(input: {
  assistant: string | null | undefined;
  instanceId: string | null | undefined;
}): string | null {
  const assistant = input.assistant;
  const instanceId = input.instanceId;
  // BOTH selectors are required: a half-declared frame is not a frame.
  if (!assistant || !instanceId) return null;
  const directive = frameAncestorsDirectiveFor({ assistant, instanceId });
  if (directive === FRAME_ANCESTORS_NONE) return null;
  return isConcreteOrigin(directive) ? directive : null;
}

