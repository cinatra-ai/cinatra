// Installed-extension SOURCE (provenance) classifier — cinatra#1572.
//
// A PURE mapping from a canonical row's `ExtensionSource` to a neutral,
// INFORMATIONAL provenance label rendered on the §VI installed card's byline.
// Classification uses ONLY real install-record data — the source discriminant
// and, for verdaccio rows, the NORMALIZED `registryUrl` compared against the
// two authoritative configured registry identities (the marketplace / Cinatra
// Network remote slot and the instance's own local registry slot). It NEVER
// infers origin from the vendor name, package name, or npm scope, and it never
// reads the marketplace-attested sha256 (an artifact-integrity signal, not an
// origin classifier).
//
// The label is a NEUTRAL acquisition-channel indicator, NOT a trust signal
// (cinatra#1572 AC1a): "from marketplace" means "classified from the configured
// registry identity", never "safe" / "verified" / "marketplace-approved". A
// stronger trust-bearing badge would require authenticated registry identity +
// verified attestation and is out of scope.
//
// This module is PURE (no `server-only`, no `@/lib` import) so it is unit- and
// client-renderable everywhere: the classifier's identity inputs are resolved
// by the server caller and passed in.

import type { InstalledExtension } from "../canonical-types";

/**
 * The provenance classes an installed extension's source maps to. Deliberately
 * distinct from `ExtensionSourceType` (the storage discriminant): `local-build`
 * (the `local` in-tree dev build) is a SEPARATE concept from `instance` (the
 * instance's own local REGISTRY), and both are distinct from `unknown`.
 */
export type ExtensionSourceLabelKind =
  | "marketplace"
  | "instance"
  | "github"
  | "local-build"
  | "bundled"
  | "unknown";

/**
 * A resolved, render-ready source label. `label` is the semantic text shown on
 * the byline; `tooltip` is the informational, explicitly NON-trust-bearing
 * hover copy. NEVER carries the raw `registryUrl` (cinatra#1572 AC5b) — only the
 * semantic class.
 */
export interface ExtensionSourceLabel {
  readonly kind: ExtensionSourceLabelKind;
  readonly label: string;
  readonly tooltip: string;
}

/**
 * The two authoritative CONFIGURED registry identities a verdaccio row's
 * `registryUrl` is classified against. Both nullable ON PURPOSE: an
 * unconfigured slot means a verdaccio row that would have matched it resolves to
 * `unknown` (a first-class neutral state), NEVER a wrong marketplace/instance
 * claim (cinatra#1572 AC3).
 */
export interface ConfiguredRegistryIdentities {
  /** The configured marketplace (Cinatra Network / remote) registry URL. */
  readonly marketplaceUrl: string | null;
  /** The instance's own configured LOCAL registry URL. */
  readonly instanceUrl: string | null;
}

// Per-class label + tooltip copy. Neutral and informational (cinatra#1572
// AC1a) — no "safe" / "verified" / "approved" / "trusted" wording; the
// `unknown` copy is a QUALIFIED neutral phrase ("Source unknown"), never a bare
// ambiguous "Unknown" (mirrors the 04404f42 "Compatibility unknown" precedent).
// The final wording is settled by the paired design spec (AC7); these are the
// grounded defaults.
const LABELS: Record<ExtensionSourceLabelKind, { label: string; tooltip: string }> = {
  marketplace: {
    label: "from marketplace",
    tooltip:
      "Origin classified from the configured marketplace registry identity — an " +
      "acquisition-channel label, not a safety, verification, or approval signal.",
  },
  instance: {
    label: "from your instance",
    tooltip: "Published to this instance's own local registry.",
  },
  github: {
    label: "from GitHub",
    tooltip:
      "Installed directly from a GitHub source — neither the marketplace nor this " +
      "instance's own registry.",
  },
  "local-build": {
    label: "in-tree build",
    tooltip:
      "A local, in-tree development build (recorded by a dev recompile) — not a " +
      "registry-published install.",
  },
  bundled: {
    label: "shipped with Cinatra",
    tooltip: "A first-party extension shipped with the product.",
  },
  unknown: {
    label: "source unknown",
    tooltip: "This extension's origin could not be determined from its install record.",
  },
};

function labelFor(kind: ExtensionSourceLabelKind): ExtensionSourceLabel {
  return { kind, label: LABELS[kind].label, tooltip: LABELS[kind].tooltip };
}

/**
 * Normalize a registry URL into a canonical comparison key, or `null` when the
 * value is absent / not a parseable http(s) URL (a malformed `registryUrl` is
 * a first-class `unknown`, never a coincidental match). Normalization folds the
 * differences that never change registry identity (cinatra#1572 AC6):
 *   - scheme + host lower-cased,
 *   - default port dropped (`:443` on https, `:80` on http),
 *   - trailing slashes stripped from the path,
 *   - query string + fragment dropped.
 * The scheme itself is PRESERVED (http vs https are distinct identities).
 */
export function normalizeRegistryUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // `URL` already lower-cases protocol + host and drops the default port; strip
  // trailing path slashes and ignore any query/hash so only the registry
  // identity remains.
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}`;
}

/**
 * Resolve the two configured registry identities from the raw instance-identity
 * slots. Pure + structural (does NOT import the InstanceIdentity type) so it
 * stays decoupled and unit-testable. Both identities are the CONFIGURED slots
 * only — there is NO product-default fallback (AC1: "from marketplace" means a
 * verdaccio matching the *configured* marketplace identity):
 *   - marketplaceUrl ← the remote slot URL, else `null`. When no remote slot is
 *     configured there is no marketplace identity to match against, so a would-be
 *     marketplace row resolves to `unknown` rather than being asserted "from
 *     marketplace" on the strength of a hardcoded host guess. The legacy
 *     top-level `registryUrl` is deliberately NOT a fallback: the identity read
 *     shim (deriveRegistriesShim) already routes a legacy REMOTE registry into
 *     `registries.remote.url` and a legacy LOOPBACK registry into
 *     `registries.local.url` (leaving the same loopback in the top-level field),
 *     so reusing it would collapse both identities and mislabel a local-registry
 *     row "from marketplace" — the exact wrong claim AC3 forbids.
 *   - instanceUrl ← the local slot URL only; NO fallback, so an unconfigured
 *     local registry classifies its would-be rows as `unknown`, never a wrong
 *     "from your instance" claim.
 */
export function resolveConfiguredRegistryIdentities(input: {
  remoteUrl?: string | null;
  localUrl?: string | null;
}): ConfiguredRegistryIdentities {
  const nonEmpty = (v: string | null | undefined): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v : null;
  return { marketplaceUrl: nonEmpty(input.remoteUrl), instanceUrl: nonEmpty(input.localUrl) };
}

/**
 * Classify a canonical row into its provenance label using ONLY real install
 * data. A missing canonical row, a malformed `registryUrl`, or a verdaccio row
 * matching neither configured identity all resolve to the neutral `unknown`
 * state (cinatra#1572 AC3). The verdaccio marketplace/instance decision compares
 * NORMALIZED URLs; on the pathological tie where both configured identities
 * normalize EQUAL, the row is ambiguous and resolves to `unknown` (fail-closed —
 * a coincident marketplace/instance URL can never truthfully claim either).
 */
export function classifyExtensionSource(
  canonical: InstalledExtension | null,
  identities: ConfiguredRegistryIdentities,
): ExtensionSourceLabel {
  if (!canonical) return labelFor("unknown");
  const source = canonical.source;
  switch (source.type) {
    case "verdaccio": {
      const normalized = normalizeRegistryUrl(source.registryUrl);
      if (normalized === null) return labelFor("unknown");
      const marketplace = normalizeRegistryUrl(identities.marketplaceUrl);
      const instance = normalizeRegistryUrl(identities.instanceUrl);
      const matchesMarketplace = marketplace !== null && normalized === marketplace;
      const matchesInstance = instance !== null && normalized === instance;
      // Fail-closed disambiguation (codex#1572): when the configured marketplace
      // and instance identities coincide (a misconfiguration, or a legacy row
      // that left the same URL in both slots), a row matching that URL is
      // genuinely ambiguous — claim NEITHER; resolve to the neutral unknown
      // rather than defaulting to a wrong "marketplace" claim.
      if (matchesMarketplace && matchesInstance) return labelFor("unknown");
      if (matchesMarketplace) return labelFor("marketplace");
      if (matchesInstance) return labelFor("instance");
      return labelFor("unknown");
    }
    case "github":
      return labelFor("github");
    case "local":
      return labelFor("local-build");
    case "bundled":
      return labelFor("bundled");
    default:
      // Defensive: a persisted row with an unrecognized source type is treated
      // as a first-class unknown, never a wrong claim.
      return labelFor("unknown");
  }
}
