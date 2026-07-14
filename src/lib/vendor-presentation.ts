/**
 * The single vendor-presentation resolver for the extension "{Type} by {Vendor}"
 * byline (cinatra#1528).
 *
 * Every byline surface — the marketplace listing card, the detail modal, the
 * installed-extension card, and the /agents card — resolves its vendor label
 * through THIS function and renders ONLY the discriminated result. No surface
 * builds a vendor label itself, and none may substitute a machine identifier
 * (an npm package scope, a vendor slug, a connector host slug) when the real
 * human display name is absent.
 *
 * Architectural guarantee (why the class of bug is unrepresentable here): the
 * resolver's render input {@link VendorNameInput} carries ONLY a `name`
 * display-name candidate + an optional `storeUrl`. It has no `slug` /
 * `packageName` / `scope` / `host` field, so — because callers construct an
 * object literal, which TypeScript excess-property-checks — a slug or package
 * scope cannot be threaded in as the display name through the type. The
 * diagnostic identifier (see below) is a SEPARATE, non-rendering parameter that
 * never influences the returned label. A focused lint/AST gate
 * (scripts/audit/vendor-byline-scan.mjs) additionally forbids the retired
 * substitution constructs inside the byline rendering paths.
 *
 * Missing-data contract: a null / empty / whitespace-only display name resolves
 * to the explicit `missing` state, which the surfaces render as a localized
 * placeholder ({@link VENDOR_MISSING_LABEL}) — never a slug, never a package
 * scope, never a silent omission, never a hard failure. `missing` is a STATE,
 * not a placeholder string masquerading as a name, so a surface can withhold
 * the VERIFIED mark and never link the placeholder.
 *
 * Localization: this app carries no i18n framework, so "the existing
 * localization mechanism" is realized as the centralized string constants
 * below — a single definition of the "by" connective and the missing-vendor
 * placeholder, ready to be swapped for a message catalog. Surfaces never
 * hard-code these strings inline.
 */

/**
 * The resolved vendor byline state. `known` carries the human display name (and
 * the optional store URL, scheme-guarded AT RENDER, not here); `missing` is the
 * explicit no-display-name state the surfaces render as the localized
 * placeholder. There is deliberately no `slug` / `packageName` on either arm —
 * a machine identifier can never reach a byline through this type.
 */
export type VendorPresentation =
  | { readonly kind: "known"; readonly displayName: string; readonly storeUrl: string | null }
  | { readonly kind: "missing" };

/**
 * The ONLY render input the resolver accepts: a display-name candidate and an
 * optional store URL. It has no slug / packageName / scope / host field ON
 * PURPOSE — that is the architectural half of cinatra#1528's AC1. Callers build
 * this as an object literal, so TypeScript's excess-property check rejects
 * threading a slug/scope in as `name`.
 */
export interface VendorNameInput {
  /**
   * The vendor's HUMAN display-name candidate. NEVER a slug, package scope,
   * connector host, or any other machine identifier.
   */
  name: string | null | undefined;
  /**
   * The vendor's marketplace store URL, or null. Passed through UNVALIDATED —
   * the render side owns the http(s) scheme guard (`safeHttpUrl`). Only ever
   * carried on a `known` result; a `missing` result is never linked.
   */
  storeUrl?: string | null;
}

/**
 * Non-rendering context for the structured missing-vendor diagnostic. `ref` is
 * a diagnostic-only identifier (e.g. the package name / agent key) used solely
 * to key deduplication and to make the data defect locatable in logs — it is
 * NEVER read as, or promoted to, the vendor label. Kept as a SEPARATE parameter
 * from {@link VendorNameInput} so the render input stays free of any package
 * identifier.
 */
export interface VendorDiagnosticContext {
  /** The byline surface emitting the diagnostic (e.g. "marketplace-listing-card"). */
  surface: string;
  /** Diagnostic-only locator (package name / agent key); never rendered. */
  ref?: string | null;
}

/** The localized "{Type} by {Vendor}" connective (centralized, single source). */
export const VENDOR_BY_CONNECTIVE = "by";

/**
 * The localized placeholder rendered for the `missing` state. Reads as
 * "the vendor's display name is unavailable", NOT as an unverified vendor.
 */
export const VENDOR_MISSING_LABEL = "Unknown vendor";

/** Deduplicates the missing-vendor diagnostic so one data defect logs once. */
const emittedMissingKeys = new Set<string>();
// Bound the dedup memory: keys are `surface ref` (ref ~ package name), so the
// live set is bounded by the catalog cardinality, but a long-lived process must
// never accrete unboundedly. On overflow the set resets — a diagnostic may then
// re-log once, which is harmless for a detectability signal (codex round-1).
const MAX_DEDUP_KEYS = 2048;

function emitMissingVendorDiagnostic(context: VendorDiagnosticContext): void {
  const key = `${context.surface} ${context.ref ?? ""}`;
  if (emittedMissingKeys.has(key)) return;
  if (emittedMissingKeys.size >= MAX_DEDUP_KEYS) emittedMissingKeys.clear();
  emittedMissingKeys.add(key);
  // Structured, deduplicated diagnostic so the underlying catalog/manifest data
  // defect (a vendor with no human display name) is detectable without breaking
  // the page. One malformed entry logs once and still renders the placeholder.
  console.warn(
    "[vendor-presentation] missing vendor display name — rendered the localized placeholder",
    { event: "vendor.display_name.missing", surface: context.surface, ref: context.ref ?? null },
  );
}

/**
 * Resolve a vendor byline candidate into its discriminated presentation.
 *
 * A non-empty (after trimming) display name resolves to `known`; a
 * null/undefined/empty/whitespace-only name resolves to `missing`. The slug /
 * package scope / host are structurally absent from the input, so they can
 * never become the label.
 *
 * @param input      The display-name candidate + optional store URL. NEVER a slug.
 * @param diagnostic Optional non-rendering context; when supplied, a `missing`
 *                   resolution emits a deduplicated structured diagnostic. The
 *                   returned value does not depend on it (the resolver is pure
 *                   with respect to its result), so it stays unit-testable.
 */
export function resolveVendorPresentation(
  input: VendorNameInput,
  diagnostic?: VendorDiagnosticContext,
): VendorPresentation {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0) {
    if (diagnostic) emitMissingVendorDiagnostic(diagnostic);
    return { kind: "missing" };
  }
  return { kind: "known", displayName: name, storeUrl: input.storeUrl ?? null };
}
