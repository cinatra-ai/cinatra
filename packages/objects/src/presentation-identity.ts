import type { EffectiveIdentity } from "./effective-identity";

// ---------------------------------------------------------------------------
// Presentation-identity resolver (epic #1883 slice A6, design D1).
//
// A DEDICATED, presentation-ONLY identity — the answer to "what should the
// renderer / the library Type facet / the row label show this row AS". It is
// deliberately DISTINCT from the shared effective-identity resolver
// (`resolveEffectiveIdentity`, this same package) that context selection
// (#1430), replay pinning, and Graphiti projection consume: effective identity
// stays a pure function of `objects.type`; presentation identity layers the
// row's meaning assertions ON TOP. The two diverge BY DESIGN — a row filed as
// "Marketing strategy" presents as that without changing what agents consume as
// context. The `presentation-identity.conformance` test pins that this resolver
// never feeds back into the shared path.
//
// Tier order (D1; strict — a higher tier that resolves stops the search):
//   1. The highest-ranked ELIGIBLE CLASSIC assertion (user > authoring_skill >
//      agent) whose extension is installed+live. Binding-basis assertions NEVER
//      compete here — they are tier 3.
//   2. A MATCHER DRAFT at/above its pack's confidence threshold — highest
//      confidence wins; a tie at the top confidence ⇒ NO auto-surface (the tied
//      drafts stay suggestion chips only). The org-level auto-surface toggle
//      (Ruling 2 escape hatch) disables this whole tier when set.
//   3. The row's CLAIM-BACKED identity — the system-minted
//      `assertion_basis='binding'` ELIGIBLE assertion where present (#1868),
//      whose extension is installed+live — else the type-namespace owner (the
//      shared effective identity passed in as `baseIdentity`).
//
// Behavior-preserving: a row with NO assertions falls straight through to
// `baseIdentity` (today's identity).
//
// PURE — zero React / DB / server-only imports. All environment signals
// (install/live status, per-pack thresholds, the org toggle) are injected as a
// `policy`, so the whole tier machine is unit-testable without a database. The
// host seam (`src/lib/objects/presentation-identity.ts`) binds the policy to the
// object-type registry, the semantic-manifest thresholds, and the toggle store.
// ---------------------------------------------------------------------------

/** The `semantic_assertion.asserted_by` vocabulary this resolver reasons over
 * (mirrors `AssertionSource` in the host store plus the `system` binding
 * principal). */
export type PresentationAssertionSource =
  | "user"
  | "authoring_skill"
  | "agent"
  | "matcher"
  | "system";

export type PresentationEligibility = "eligible" | "draft" | "archived";
export type PresentationAssertionBasis = "binding" | "classic";

/** The projection of one `semantic_assertion` row this resolver needs. A
 * caller may pass archived rows harmlessly — they are filtered out first. */
export interface PresentationAssertion {
  extension: string;
  assertedBy: PresentationAssertionSource;
  eligibility: PresentationEligibility;
  assertionBasis: PresentationAssertionBasis;
  /** matcher confidence in [0,1]; null for non-matcher rows. */
  confidence: number | null;
  /** ISO timestamp — the same-rank tie-break axis (newest wins), mirroring the
   * store's `primaryExtensionFor`. */
  assertedAt: string;
}

/** The injected environment the resolver reads (the host binds it to real
 * signals; tests supply pure fakes). */
export interface PresentationIdentityPolicy {
  /** Is the extension package installed AND live? The host binds this to
   * object-type-registry membership (an uninstalled extension's types are
   * removed on teardown), the same "installed" signal `resolveEffectiveIdentity`
   * uses. An assertion whose extension is not live NEVER wins any tier. */
  isExtensionLive: (extension: string) => boolean;
  /** The extension pack's matcher confidence threshold in [0,1], or null when
   * the pack declares no matcher machinery / is not live. A draft auto-surfaces
   * only at/above this value. */
  matcherThreshold: (extension: string) => number | null;
  /** Ruling 2 escape hatch: when true, tier 2 is disabled entirely — matcher
   * drafts never auto-surface (they remain suggestion chips). Default false
   * (auto-surface ON). */
  autoSurfaceDisabled?: boolean;
}

export type PresentationTier = "classic" | "matcher" | "claim-backed";

export interface PresentationIdentity {
  /** The identity the renderer / facet / label should present. */
  identity: EffectiveIdentity;
  /** Which tier produced `identity` — `claim-backed` is the tier-3 fallback
   * (binding assertion or the type-namespace owner / no-primary). */
  tier: PresentationTier;
  /** Matcher-draft extensions offered as suggestion chips (the A4 confirmation
   * UI consumes this): every live matcher draft that did NOT auto-surface —
   * sub-threshold drafts, tie-blocked threshold drafts, and (when a higher tier
   * won) all drafts. Deterministic: deduped, lexicographically sorted. */
  suggestions: string[];
}

const CLASSIC_RANK: Record<string, number> = {
  user: 3,
  authoring_skill: 2,
  agent: 1,
};

/** Deterministic winner among same-tier classic assertions: highest rank, then
 * newest `assertedAt`, then lexicographic extension — identical ordering to the
 * store's `primaryExtensionFor`, so presentation stays consistent with the raw
 * assertion-precedence contract. */
function pickClassicWinner(
  candidates: readonly PresentationAssertion[],
): PresentationAssertion | null {
  let best: PresentationAssertion | null = null;
  for (const c of candidates) {
    if (best === null) {
      best = c;
      continue;
    }
    const r = (CLASSIC_RANK[c.assertedBy] ?? 0) - (CLASSIC_RANK[best.assertedBy] ?? 0);
    if (r > 0) {
      best = c;
    } else if (r === 0) {
      if (c.assertedAt > best.assertedAt) best = c;
      else if (c.assertedAt === best.assertedAt && c.extension < best.extension) best = c;
    }
  }
  return best;
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

/**
 * Resolve the presentation identity of one row. Total: every input lands on
 * exactly one identity across the three tiers; never throws.
 *
 * @param baseIdentity the row's SHARED effective identity (the tier-3
 *   type-namespace-owner fallback). Passing it in — rather than re-deriving it —
 *   is what keeps the shared resolver the single source of the type-driven
 *   answer and guarantees behavior-preserving output for assertion-free rows.
 */
export function resolvePresentationIdentity(input: {
  baseIdentity: EffectiveIdentity;
  assertions: readonly PresentationAssertion[];
  policy: PresentationIdentityPolicy;
}): PresentationIdentity {
  const { baseIdentity, assertions, policy } = input;
  // Archived rows never participate (an archived assertion is retired identity).
  const active = assertions.filter((a) => a.eligibility !== "archived");

  // Live matcher drafts — the suggestion-chip universe, computed up front so
  // every tier returns the correct chip set. Uninstalled extensions are dropped
  // (they can neither win nor be a useful chip).
  const liveDrafts = active.filter(
    (a) =>
      a.assertedBy === "matcher" &&
      a.eligibility === "draft" &&
      policy.isExtensionLive(a.extension),
  );
  const allDraftExtensions = liveDrafts.map((d) => d.extension);

  // --- Tier 1: highest-ranked eligible CLASSIC assertion, extension live. ----
  // Binding basis is excluded (it is tier 3), matcher is excluded (drafts, not
  // eligible + not classic), `system` is excluded (only ever the binding
  // principal).
  const classicEligible = active.filter(
    (a) =>
      a.assertionBasis === "classic" &&
      a.eligibility === "eligible" &&
      (a.assertedBy === "user" ||
        a.assertedBy === "authoring_skill" ||
        a.assertedBy === "agent") &&
      policy.isExtensionLive(a.extension),
  );
  const classicWinner = pickClassicWinner(classicEligible);
  if (classicWinner) {
    return {
      identity: { kind: "extension", extension: classicWinner.extension },
      tier: "classic",
      suggestions: sortedUnique(allDraftExtensions),
    };
  }

  // --- Tier 2: matcher draft at/above its pack threshold. --------------------
  // Highest confidence wins; a tie at the top confidence ⇒ no auto-surface.
  if (!policy.autoSurfaceDisabled) {
    let topConfidence = -1;
    const passers: PresentationAssertion[] = [];
    for (const d of liveDrafts) {
      const threshold = policy.matcherThreshold(d.extension);
      if (d.confidence == null || threshold == null) continue;
      if (d.confidence < threshold) continue;
      passers.push(d);
      if (d.confidence > topConfidence) topConfidence = d.confidence;
    }
    const atTop = passers.filter((p) => p.confidence === topConfidence);
    if (atTop.length === 1) {
      const surfaced = atTop[0]!;
      return {
        identity: { kind: "extension", extension: surfaced.extension },
        tier: "matcher",
        // Every OTHER live draft stays a suggestion chip.
        suggestions: sortedUnique(
          allDraftExtensions.filter((e) => e !== surfaced.extension),
        ),
      };
    }
    // atTop.length === 0 (no threshold-passers) OR >= 2 (tie): no auto-surface.
    // Fall through to tier 3; all live drafts remain suggestion chips.
  }

  // --- Tier 3: claim-backed identity, else the type-namespace owner. ---------
  // The eligible binding assertion (#1868) — the store guarantees at most one
  // active binding per artifact (`sa_one_active_binding_idx`) — resolves as the
  // presentation identity when its extension is live; otherwise the shared
  // effective identity stands.
  const binding = active.find(
    (a) =>
      a.assertionBasis === "binding" &&
      a.eligibility === "eligible" &&
      policy.isExtensionLive(a.extension),
  );
  return {
    identity: binding
      ? { kind: "extension", extension: binding.extension }
      : baseIdentity,
    tier: "claim-backed",
    suggestions: sortedUnique(allDraftExtensions),
  };
}
