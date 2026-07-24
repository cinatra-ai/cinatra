import "server-only";

// ---------------------------------------------------------------------------
// The credential-store ownership resolver for the widget-stream SESSION MINT
// surface (owner ruling 2026-07-23 — the widget-auth delivery fix, path B,
// slice 2). This is the ownership-conjunction axis of the runtime widget-stream
// resolver + its point-of-use re-asserts: "the metadata-grant package IS the
// currently-approved credential-store owner of the canon's declared
// `tokenConfigKey`".
//
// THE GAP THIS CLOSES. slice 1 fixed the credential-store OWNER resolver
// (`widget-auth-provider.ts` — POST /api/connect/token, the wordpress webhook,
// connector-readiness) so a released-image marketplace rider becomes the store
// owner via sanctioned install provenance (arm (c)). The widget-stream session
// mint (`POST /api/widget-auth/token` → `resolveWidgetStreamAgentUnion` →
// `resolveRuntimeWidgetStreamAgent`) fails the SAME root cause one axis over:
// its ownership conjunction reads ONLY the approved ownership GRANT
// (`resolveOwnershipOwner`), which the auto-staged rider never gets — so an
// admin-approved widget-stream METADATA grant alone still 404s the agent (and,
// downstream, never mints the visitor session/user token). This module
// substitutes install provenance for the OWNERSHIP-GRANT arm ONLY (arm (b) →
// arm (b) ∪ fallback arm (c)); the METADATA-grant gate (the deliberately-
// never-auto-approved admin approval of the widget agent's metadata) is
// UNTOUCHED — the metadata grant must still be admin-approved for the agent to
// resolve. Provenance never mints a metadata grant.
//
// WHY THIS IS NOT A CONTAINED REUSE OF `widget-auth-install-provenance.ts`. The
// provenance primitive needs a `(capability, providerGuard)` pair to enumerate
// its P1 candidates (the live registered capability providers the loader
// activated). `widget-auth-provider.ts` hands it a FIXED pair (the wordpress
// widget-auth capability + guard). The widget-stream resolver, by contrast, is
// GENERIC per-agent: its ownership conjunction runs against whatever
// `tokenConfigKey` the connector's canon declares, and core holds no capability/
// guard for an arbitrary key. Naively handing the primitive the on-disk-declared
// key with no capability/guard would be a WILDCARD trust of a key an attacker's
// canon could name. Instead this module names its P1 candidates HONESTLY: a
// small, reviewed registry (`WIDGET_AUTH_STORE_PROVENANCE_CANDIDATES`) maps each
// widget-auth store type the host has reviewed to its CONCRETE capability id +
// structural provider guard. A `tokenConfigKey` with NO registry entry has no
// honest P1 enumeration → the provenance fallback resolves NOTHING for it → the
// conjunction stays grant-only (fail-closed for a rider on an unknown store, and
// never a wildcard-trust of an on-disk-declared key). `wordpress_widget_auth` is
// the pilot entry; a new store type joins ONLY by a reviewed addition here.
//
// FALLBACK ORDERING (fail-closed, grant-authoritative; AUTHORITY-EQUIVALENT with
// the credential-store surface). The approved ownership GRANT is authoritative
// and consulted FIRST; the install-provenance fallback is consulted ONLY in the
// genuine released-image rider gap — the grant arm resolves NO owner AND NO baked
// package declares the store. The BAKED-declarer suppression is load-bearing
// (codex security round): the credential-store surface resolves build ∪ grant
// BEFORE provenance, so if a baked package owns the store, provenance there is
// never reached; this resolver mirrors that gate so a runtime rider can never
// satisfy the ownership conjunction for a store a DIFFERENT baked package owns.
// A present admin grant is therefore never overridden, and a legitimate
// granted/baked owner can never be DoS'd into ambiguity by a rogue
// install-provenance declarer. The fallback is itself unique-or-fail-closed
// (rule P1–P6 in `widget-auth-install-provenance.ts`) and is VETOED by any
// explicit non-`approved` ownership decision (revoked/pending) at the install's
// derived org AND global scope — only the no-row case (the auto-staged rider
// that never had a grant recorded) is honored. Any infrastructure error in the
// provenance fallback fails CLOSED to null (logged once), never throw-through;
// the grant-arm call is left un-wrapped so its own errors propagate to the
// caller's existing fail-closed try/catch (preserving the pre-slice behavior).
// ---------------------------------------------------------------------------

import {
  resolveOwnershipOwner,
  readOwnershipGrant,
  type OwnershipGrantDeps,
} from "@/lib/extension-capability-ownership-grants";
import {
  resolveInstallProvenanceOwner,
  type InstallProvenanceDeps,
} from "@/lib/widget-auth-install-provenance";
import {
  WORDPRESS_WIDGET_AUTH_CAPABILITY,
  WORDPRESS_WIDGET_AUTH_TOKEN_CONFIG_KEY,
  isWordPressWidgetAuthProvider,
} from "@/lib/widget-auth-provider";
import { GENERATED_WIDGET_STREAM_AGENTS } from "@/lib/generated/extensions.server";

/**
 * A widget-auth credential store whose install PROVENANCE the host can resolve
 * HONESTLY: the store's `tokenConfigKey` paired with the CONCRETE capability id
 * and structural provider guard that name its P1 candidates. The provenance
 * primitive REQUIRES both to enumerate the live registered providers the loader
 * activated; the widget-stream resolver is generic per-agent and has neither for
 * an arbitrary key — so only a store key with an EXPLICIT, reviewed entry here is
 * eligible for the provenance fallback.
 */
export type WidgetAuthStoreProvenanceCandidate = {
  tokenConfigKey: string;
  capability: string;
  providerGuard: (impl: unknown) => boolean;
};

/**
 * The honest P1-candidate registry for the widget-stream ownership surface — one
 * reviewed entry per widget-auth store type. Reuses the SINGLE canonical
 * wordpress widget-auth `(capability, tokenConfigKey, guard)` triple exported by
 * `widget-auth-provider.ts` (never a drift-prone second copy). A store type joins
 * this surface's provenance trust ONLY by a reviewed addition here — never
 * inferred from a canon's declared key.
 */
export const WIDGET_AUTH_STORE_PROVENANCE_CANDIDATES: readonly WidgetAuthStoreProvenanceCandidate[] =
  [
    {
      tokenConfigKey: WORDPRESS_WIDGET_AUTH_TOKEN_CONFIG_KEY,
      capability: WORDPRESS_WIDGET_AUTH_CAPABILITY,
      providerGuard: isWordPressWidgetAuthProvider,
    },
  ];

/** The reviewed (capability, guard) pairing for `tokenConfigKey`, or null when
 * the store type has no honest P1 enumeration on this surface (→ no provenance
 * fallback; fail closed, never a wildcard-trust). */
function provenanceCandidateFor(
  tokenConfigKey: string,
): WidgetAuthStoreProvenanceCandidate | null {
  return (
    WIDGET_AUTH_STORE_PROVENANCE_CANDIDATES.find((c) => c.tokenConfigKey === tokenConfigKey) ?? null
  );
}

/**
 * Whether a BAKED (build-time) package declares `tokenConfigKey`'s store in the
 * generated widget-stream tree — i.e. the credential-store surface's arm (a)
 * (`resolveBuildTimeWidgetAuthOwner`) would resolve a host-trusted owner. A
 * declaration by ANY generated entry means the store is baked-associated (a
 * DUPLICATE/ambiguous baked declaration fails the store surface CLOSED too). Own
 * property scan (never the prototype chain).
 */
function defaultHasBuildTimeStoreOwner(tokenConfigKey: string): boolean {
  for (const entry of Object.values(GENERATED_WIDGET_STREAM_AGENTS)) {
    if (entry.auth.tokenConfigKey === tokenConfigKey) return true;
  }
  return false;
}

/** Injectable authorities for the widget-stream ownership resolver — unit-
 * testable without a pg pool / on-disk store. Production callers pass nothing;
 * every default resolves the real authority lazily. */
export type WidgetStreamOwnershipDeps = {
  /** Threaded into the approved-ownership-GRANT arm AND the fallback's org+global
   * grant-decision veto. */
  ownershipGrantDeps?: OwnershipGrantDeps;
  /** Threaded into the marketplace-install-PROVENANCE fallback so the
   * unauthenticated resolver is unit-testable without a pool / store. */
  installProvenanceDeps?: InstallProvenanceDeps;
  /** The build-time (baked) store-owner presence check (default: the generated
   * widget-stream tree scan). Injected in tests; production reads the real tree. */
  hasBuildTimeOwner?: (tokenConfigKey: string) => boolean;
};

/**
 * Resolve the credential-store owner package for `tokenConfigKey` for the
 * widget-stream ownership conjunction: the approved ownership GRANT owner if one
 * resolves, else — ONLY in the genuine released-image RIDER gap (no admin grant
 * AND no BAKED declarer) and ONLY for a store key with a reviewed provenance
 * candidate — the UNIQUE sanctioned marketplace-install-PROVENANCE owner (rule
 * P1–P6), vetoed by any explicit revoked/pending ownership decision at the
 * install's derived org AND global scope. Returns the owning package name, or
 * null (fail closed) when no arm resolves a unique, non-vetoed owner.
 *
 * AUTHORITY EQUIVALENCE WITH THE CREDENTIAL-STORE SURFACE (codex security round).
 * The credential-store owner resolver (`widget-auth-provider.ts`) consults the
 * BUILD (baked) ∪ GRANT union FIRST and falls to provenance ONLY when that union
 * is EMPTY. This resolver mirrors that GATE so it can never trust a provenance
 * owner the store surface would not: a BAKED declarer means the store is
 * host-trusted to a baked package, so provenance is SUPPRESSED entirely
 * (returns null — a runtime widget riding a baked store still requires an
 * explicit ownership grant, unchanged fail-closed behavior). Without this gate a
 * runtime rider could satisfy the conjunction for a store a DIFFERENT baked
 * package owns. The PROVENANCE PATH this slice adds is therefore no-wider than
 * the store surface's provenance arm (same gate, same P1–P6, same veto); the
 * grant-first arm is the pre-existing, unchanged ownership-grant behavior (this
 * resolver never returns a bare build-time owner for a runtime widget — only a
 * grant owner or a released-image-gap provenance owner).
 *
 * The grant-arm call is intentionally NOT wrapped in try/catch: a DB error there
 * propagates to the caller's existing fail-closed try/catch (the runtime
 * resolver arm / the point-of-use re-assert), exactly as before this slice. The
 * provenance fallback catches its OWN infra errors and fails closed to null.
 */
export async function resolveWidgetStreamStoreOwner(
  input: { tokenConfigKey: string; orgId: string | null },
  deps?: WidgetStreamOwnershipDeps,
): Promise<string | null> {
  const granted = await resolveOwnershipOwner(
    { tokenConfigKey: input.tokenConfigKey, orgId: input.orgId },
    deps?.ownershipGrantDeps,
  );
  if (granted) return granted;
  // Grant arm empty. Provenance is the released-image rider gap ONLY — a baked
  // declarer means the store is host-trusted to a baked package, so provenance
  // must never override or shadow it (authority equivalence with the store
  // surface, which consults build ∪ grant BEFORE provenance).
  const hasBuildTimeOwner = deps?.hasBuildTimeOwner ?? defaultHasBuildTimeStoreOwner;
  if (hasBuildTimeOwner(input.tokenConfigKey)) return null;
  // No baked declarer AND no admin grant → the genuine released-image gap:
  // consult the install-provenance fallback (only for a reviewed store key),
  // unique-or-fail-closed.
  return resolveProvenanceStoreOwner(input.tokenConfigKey, deps);
}

async function resolveProvenanceStoreOwner(
  tokenConfigKey: string,
  deps?: WidgetStreamOwnershipDeps,
): Promise<string | null> {
  const candidate = provenanceCandidateFor(tokenConfigKey);
  // No reviewed (capability, guard) pairing for this key → no honest P1
  // enumeration → fail closed (never a wildcard-trust of the declared key).
  if (!candidate) return null;
  try {
    const resolved = await resolveInstallProvenanceOwner(
      {
        capability: candidate.capability,
        tokenConfigKey: candidate.tokenConfigKey,
        providerGuard: candidate.providerGuard,
      },
      deps?.installProvenanceDeps,
    );
    if (!resolved) return null;
    const { packageName: owner, orgId: ownerOrgId } = resolved;
    // GRANT-DECISION VETO (org + global — owner ruling 2026-07-23). An explicit
    // non-`approved` ownership decision (an admin revoked or has not yet approved
    // this package's store ownership) is NEVER overridden by provenance. An
    // org-anchored install writes its grant at its org, so veto at BOTH the
    // anchor's derived org AND global — a global-only veto would miss an
    // org-scoped decision. Only the no-row-at-either-scope case (the auto-staged
    // rider that never had a grant recorded) is honored.
    const vetoScopes: (string | null)[] = ownerOrgId != null ? [ownerOrgId, null] : [null];
    for (const scope of vetoScopes) {
      const grant = await readOwnershipGrant(
        { packageName: owner, orgId: scope, tokenConfigKey },
        deps?.ownershipGrantDeps,
      );
      if (grant && grant.status !== "approved") return null;
    }
    return owner;
  } catch (err) {
    console.error(
      "[widget-stream-ownership] marketplace-install-provenance fallback failed (failing closed " +
        "on the provenance arm; the ownership-grant arm is unaffected):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
