// ---------------------------------------------------------------------------
// The `cwu_` SCOPE + AUDIENCE vocabulary (cinatra#2574, epic #2564 S8a).
//
// cinatra#407 minted the per-user widget token with exactly one scope
// (`<agentSlug>.user`) and exactly one audience (the unified assistant chat
// route). Both were single values compared for EQUALITY at consume. That was
// sufficient while a widget session could only do one thing: take a chat turn.
//
// Reading LIFECYCLE work (a review gate, a verification record) is a second,
// materially different thing to consent to — it exposes org work the site
// itself has no standing to see — so it needs its own grant, and a session that
// consented before this grant existed must not silently acquire it.
//
// THE VOCABULARY IS A SET, NOT A VALUE. Scope and audience are now
// space-delimited sets (RFC 6749 §3.3 for scope; the same encoding for `aud` so
// one parser serves both). The single-value rows minted before this slice parse
// as one-element sets, so they keep working at the chat route unchanged and
// carry NO lifecycle grant — which is precisely AC-1: consent that predates the
// extension cannot read lifecycle data until the user consents again.
//
// TWO INDEPENDENT GATES, BOTH FAIL-CLOSED. A lifecycle read requires the
// `lifecycle.read` SCOPE *and* the lifecycle route in the token's AUDIENCE. The
// mint only ever adds the audience alongside the scope, so the two can never
// disagree in a token this codebase produced — and a token altered so they do
// disagree is refused by whichever gate is missing.
//
// UNKNOWN TOKENS GRANT NOTHING. A scope or audience entry this build does not
// recognize is inert: it can never widen authority, and it never invalidates the
// entries around it. That keeps a rolling deploy honest in both directions — an
// older node serving a newer token refuses the grant it cannot evaluate instead
// of either honouring it blindly or killing the whole session.
// ---------------------------------------------------------------------------

import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";

/**
 * The lifecycle READ grant. Named for the capability, not the surface: the same
 * grant governs every widget lifecycle read (card refetch, pull primitive,
 * capture metadata), so a future read surface joins it rather than minting a
 * parallel scope nobody re-checks.
 */
export const WIDGET_LIFECYCLE_READ_SCOPE = "lifecycle.read";

/**
 * The audience a widget lifecycle READ is served at — S1's authoritative
 * refetch endpoint (`src/app/api/lifecycle-views/resolve/route.ts`). That route
 * is COOKIE-SESSION-ONLY today by S1's explicit decision; S8d (#2577) opens the
 * broker-authenticated branch. The audience is minted now so the token a user
 * consents to already carries the binding, and so the binding has exactly one
 * definition when S8d consumes it.
 */
export const WIDGET_LIFECYCLE_READ_ROUTE_PATH = "/api/lifecycle-views/resolve";

/**
 * The grammar of a single set member. Deliberately strict and whitespace-free:
 * the set encoding IS the whitespace, so a value carrying any is not one member
 * but several, and a member assembled from an attacker-influenced string could
 * otherwise smuggle a capability in beside itself (an agent slug of
 * `"x lifecycle.read y"` would mint a base scope whose SECOND member is the
 * lifecycle grant). Validated at the mint, which refuses rather than encodes.
 */
const SCOPE_ATOM_RE = /^[A-Za-z0-9._:/-]+$/;

export function isValidTokenSetAtom(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && SCOPE_ATOM_RE.test(value);
}

/**
 * The base scope every `cwu_` carries — cinatra#407's, unchanged in shape.
 * Returns null for an agent slug that cannot be expressed as ONE set member;
 * the caller refuses the mint rather than writing a scope column that says
 * something other than what it means.
 */
export function widgetUserBaseScope(agentSlug: string): string | null {
  // The SLUG is validated, not just the assembled atom: an empty slug would
  // assemble the perfectly well-formed `.user`, which is a scope belonging to no
  // agent and must never be minted.
  if (!isValidTokenSetAtom(agentSlug)) return null;
  const atom = `${agentSlug}.user`;
  return isValidTokenSetAtom(atom) ? atom : null;
}

/**
 * The opaque consent request id the hosted page's CSRF token is bound to.
 *
 * cinatra#2574 (codex round 0, finding 1): the page and the action reading the
 * same constant is NOT a binding — an already-rendered consent screen submitted
 * against a newer build would record a grant whose sentence was never displayed
 * (an open tab across a deploy, or a rolling deploy serving old page + new
 * action). Folding the DISPLAYED scope set into the request id the single-use
 * CSRF token is signed over makes the two agree or the consent fail: an old
 * screen's token verifies against the old id and nothing else. This is the same
 * device the connect flow uses to stop a consent POST smuggling parameters the
 * GET never showed.
 */
export function widgetConsentRequestId(
  txnId: string,
  displayedScopes: readonly string[],
): string {
  // SORTED, because this is a set: two builds that ask for the same grants in a
  // different order are asking for the same thing, and invalidating every
  // in-flight consent screen over a reordered constant would be a needless
  // failure (codex round 1). Only a CHANGE OF MEMBERSHIP moves the id.
  const canonical = [...displayedScopes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${txnId}#consent-scopes:${formatTokenSet(canonical)}`;
}

/**
 * Every extension scope this build understands, with the audiences it adds.
 * The map is the SINGLE definition of "what does this grant let the token
 * reach": mint, consume and the consent copy all read it, so a grant cannot
 * gain a surface without gaining consent copy at the same time.
 */
export const WIDGET_EXTENSION_SCOPES = {
  [WIDGET_LIFECYCLE_READ_SCOPE]: {
    audiences: [WIDGET_LIFECYCLE_READ_ROUTE_PATH] as readonly string[],
    /**
     * The consent sentence shown on the hosted login. It states what is read
     * and by whose permission — the grant carries the USER's standing, never a
     * widened one (the site cannot see more through the widget than the person
     * signed into it can see in Cinatra).
     */
    consentCopy:
      "Show you work items that are waiting on you — reviews and their outcomes — using the same permissions you have in Cinatra.",
  },
} as const satisfies Record<
  string,
  { audiences: readonly string[]; consentCopy: string }
>;

export type WidgetExtensionScope = keyof typeof WIDGET_EXTENSION_SCOPES;

/**
 * The extension scopes the CURRENT hosted consent copy asks for. The consent
 * server action reads this constant — it never reads a scope list off the
 * submitted form — so what the page displayed is exactly what the code records.
 */
export const WIDGET_CONSENT_GRANTED_SCOPES: readonly WidgetExtensionScope[] = [
  WIDGET_LIFECYCLE_READ_SCOPE,
];

export function isKnownWidgetExtensionScope(
  value: unknown,
): value is WidgetExtensionScope {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(WIDGET_EXTENSION_SCOPES, value)
  );
}

// ---------------------------------------------------------------------------
// The set codec. One parser for scope and audience alike.
// ---------------------------------------------------------------------------

/**
 * Parse a space-delimited token set. Tolerates any run of whitespace and an
 * empty/absent value (→ `[]`). Never throws: a malformed column yields an empty
 * set, which grants nothing.
 */
export function parseTokenSet(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw.split(/\s+/).filter((t) => t.length > 0);
}

/** Format a token set for storage — deduplicated, order-stable. */
export function formatTokenSet(values: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = String(v ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.join(" ");
}

/** Exact membership. The ONLY admission test — no prefix, no substring. */
export function tokenSetHas(raw: unknown, value: string): boolean {
  if (!value) return false;
  return parseTokenSet(raw).includes(value);
}

/**
 * Narrow an arbitrary list to the extension scopes this build knows, sorted and
 * deduplicated. Applied at BOTH ends of the code→token hop: an unknown entry can
 * never be stored, and a stored entry that stopped being known (a rollback, a
 * tampered row) can never be honoured.
 */
export function normalizeExtensionScopes(
  values: readonly unknown[] | null | undefined,
): WidgetExtensionScope[] {
  if (!Array.isArray(values)) return [];
  const kept = new Set<WidgetExtensionScope>();
  for (const v of values) {
    if (isKnownWidgetExtensionScope(v)) kept.add(v);
  }
  return [...kept].sort();
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/**
 * The `scope` column for a freshly minted token: the base scope plus every
 * consented extension scope this build knows. Returns null when the agent slug
 * cannot be expressed as one set member — the caller refuses the whole mint.
 */
export function mintWidgetTokenScope(
  agentSlug: string,
  grantedExtensionScopes: readonly unknown[] | null | undefined,
): string | null {
  const base = widgetUserBaseScope(agentSlug);
  if (!base) return null;
  return formatTokenSet([base, ...normalizeExtensionScopes(grantedExtensionScopes)]);
}

/**
 * The `aud` column for a freshly minted token: the chat route (always — every
 * widget session takes turns) plus the audiences each consented scope unlocks.
 * A scope with no audience of its own adds none.
 */
export function mintWidgetTokenAudience(
  grantedExtensionScopes: readonly unknown[] | null | undefined,
): string {
  const audiences: string[] = [WIDGET_BROKER_ROUTE_PATH];
  for (const scope of normalizeExtensionScopes(grantedExtensionScopes)) {
    audiences.push(...WIDGET_EXTENSION_SCOPES[scope].audiences);
  }
  return formatTokenSet(audiences);
}

// ---------------------------------------------------------------------------
// Read back
// ---------------------------------------------------------------------------

/**
 * The extension scopes a stored `scope` column actually grants — known entries
 * only. Used for the token's claims (audit) and by the lifecycle gate.
 */
export function grantedExtensionScopesFromScopeColumn(
  raw: unknown,
): WidgetExtensionScope[] {
  return normalizeExtensionScopes(parseTokenSet(raw));
}

/**
 * Does this token's stored (scope, aud) pair admit a request AT `routePath`?
 *
 * cinatra#2574 (codex round 0, finding 4): membership in the raw `aud` column
 * alone is not enough. Trusting an arbitrary audience string would let a
 * newer issuer's — or a tampered row's — audience confer a surface this build
 * cannot reason about, and it would make the two gates one gate. So the
 * audience is RE-DERIVED here from what the token demonstrably carries:
 *
 *   • the chat route is always admissible (it is every `cwu_`'s reason to
 *     exist, and pre-#2574 tokens hold nothing else);
 *   • any other route is admissible only if it is DECLARED by a KNOWN extension
 *     scope that this token's own scope column also carries.
 *
 * An audience that survives that derivation must additionally be present in the
 * stored column, so the check is the INTERSECTION of what was minted and what
 * this build recognizes — never the union.
 */
export function tokenAudienceAdmits(
  scopeRaw: unknown,
  audRaw: unknown,
  routePath: string,
): boolean {
  if (!routePath || !tokenSetHas(audRaw, routePath)) return false;
  if (routePath === WIDGET_BROKER_ROUTE_PATH) return true;
  for (const scope of grantedExtensionScopesFromScopeColumn(scopeRaw)) {
    if (WIDGET_EXTENSION_SCOPES[scope].audiences.includes(routePath)) return true;
  }
  return false;
}
