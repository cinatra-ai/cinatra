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
 * Defense in depth — the types are ONE layer, deliberately not the sole one, so
 * a machine identifier does not become a byline label:
 *   1. INPUT: the render input {@link VendorNameInput} carries ONLY a `name`
 *      display-name candidate + an optional `storeUrl`. It has no `slug` /
 *      `packageName` / `scope` / `host` field, so a machine identifier cannot ride
 *      in through a DEDICATED field — TypeScript's excess-property check rejects an
 *      unknown `slug`/`scope` key on the object literal. It does NOT stop a caller
 *      passing a slug's string VALUE as `name` (a string is a string); that path
 *      is not a type guarantee — it is covered by layer 3 below.
 *   2. OUTPUT: {@link VendorPresentation} is a BRANDED type (a phantom
 *      compile-time tag, erased at runtime). {@link resolveVendorPresentation}
 *      is the only INTENDED minting site, and the brand blocks the direct
 *      reintroduction vector the review flagged: a caller cannot hand-construct a
 *      fresh `{ kind: "known", displayName: someSlug }` object literal and pass it
 *      to a byline surface — that literal is missing the brand, so it is not
 *      assignable. The brand is a STRUCTURAL tag, NOT a nominal/opaque type, so it
 *      is honest about its limit: it does not make forgery type-impossible in
 *      every case. Laundering paths that carry the brand forward — spreading a
 *      resolved value and overriding a field (`{ ...resolved, displayName: slug }`),
 *      or an explicit `as` cast — still type-check. Those residual paths are the
 *      SAME class as a caller passing a slug AS the `name`, and are held off by
 *      layer 3, not by the type.
 *   3. CONVENTION + regression gate: the single-resolver boundary (a byline label
 *      is only ever derived from `input.name` inside this function) is the actual
 *      invariant; it rests on caller discipline + code review. The focused lint/AST
 *      gate (scripts/audit/vendor-byline-scan.mjs) does NOT prove the general
 *      absence of laundering — it FORBIDS the specific retired substitution
 *      constructs (`scopeFromPackageName`, a `vendor.slug`/`raw.slug` read) inside
 *      the guarded byline paths, which is the concrete way the old bug was written;
 *      and the per-surface behavioural tests assert that the current data paths,
 *      fed raw catalog input with distinct name/slug/scope sentinels, render no
 *      machine identifier. A brand-new laundering expression the gate does not
 *      pattern-match would pass the gate — the gate catches the known regression
 *      shapes, not every conceivable one. The diagnostic identifier (see below) is
 *      a SEPARATE, non-rendering parameter that never influences the returned label.
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
 * Phantom brand for {@link VendorPresentation}. Declared as a `unique symbol`
 * with NO runtime value, so a resolved presentation is a plain `{ kind, … }`
 * object at runtime. The brand makes a fresh object literal non-assignable — it
 * blocks the direct forge (constructing a `known` presentation with a slug as
 * `displayName` out of thin air) and marks {@link resolveVendorPresentation} as
 * the sole INTENDED minting site. It is a structural tag, not a nominal type, so
 * it does not stop spread/cast laundering of an already-resolved value; that
 * residual is covered by the AST gate + behavioural tests (see the module doc).
 */
declare const VENDOR_PRESENTATION_BRAND: unique symbol;

/**
 * The resolved vendor byline state, WITHOUT the brand. Not exported: callers
 * never name this — they receive the branded {@link VendorPresentation} from the
 * resolver. `known` carries the human display name (and the optional store URL,
 * scheme-guarded AT RENDER, not here); `missing` is the explicit no-display-name
 * state the surfaces render as the localized placeholder. There is deliberately
 * no `slug` / `packageName` on either arm.
 */
type UnbrandedVendorPresentation =
  | { readonly kind: "known"; readonly displayName: string; readonly storeUrl: string | null }
  | { readonly kind: "missing" };

/**
 * The resolved vendor byline state — a BRANDED discriminated union. `known`
 * carries the human display name; `missing` is the explicit no-display-name
 * state. Neither arm has a `slug` / `packageName` field, and the brand blocks the
 * direct forge — a fresh `{ kind: "known", displayName: <slug> }` literal is not
 * assignable, so a machine identifier cannot be introduced as a byline label out
 * of thin air. The brand is a structural tag, not an opaque type: it does not
 * make forgery type-impossible in every case (spread/cast laundering of a
 * resolved value still type-checks) — that residual is covered by the AST gate +
 * behavioural tests, the same layers that cover passing a slug AS the `name`.
 */
export type VendorPresentation = UnbrandedVendorPresentation & {
  readonly [VENDOR_PRESENTATION_BRAND]: true;
};

/**
 * The ONLY render input the resolver accepts: a display-name candidate and an
 * optional store URL. It has no slug / packageName / scope / host field ON
 * PURPOSE — that is the architectural half of cinatra#1528's AC1. Because callers
 * build this as an object literal, TypeScript's excess-property check rejects a
 * stray `slug`/`scope` KEY, so a machine identifier cannot ride in through a
 * dedicated field. It does not (and a plain-string type cannot) reject a slug's
 * VALUE passed as `name`; that path is guarded by the AST gate + tests, not here.
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
 * package scope / host are absent as INPUT FIELDS, so they cannot ride in through
 * a dedicated field; the label is only ever `input.name`, so a machine identifier
 * becomes the label only if a caller passes it AS `input.name` — the path layer 3
 * (the AST gate + behavioural tests) guards, not the type.
 *
 * @param input      The display-name candidate + optional store URL. NEVER a slug.
 * @param diagnostic REQUIRED non-rendering context. Every `missing` resolution
 *                   THROUGH THIS RESOLVER emits a deduplicated structured
 *                   diagnostic — no silent-omission path (AC2): a caller cannot
 *                   resolve a missing vendor here without the data defect being
 *                   logged. (The parameter being required is what closes the
 *                   omission; a spread/cast-forged `missing` object never went
 *                   through the resolver and is out of this contract's scope — it
 *                   is covered by the AST gate + tests, like any forged output.)
 *                   The returned value does not depend on it, so the resolver
 *                   stays pure with respect to its RESULT.
 */
export function resolveVendorPresentation(
  input: VendorNameInput,
  diagnostic: VendorDiagnosticContext,
): VendorPresentation {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0) {
    emitMissingVendorDiagnostic(diagnostic);
    return mint({ kind: "missing" });
  }
  return mint({ kind: "known", displayName: name, storeUrl: input.storeUrl ?? null });
}

/**
 * The SOLE INTENDED minting site for the branded {@link VendorPresentation}. The
 * cast is safe (the branded type is assignable to the unbranded shape, so the two
 * are comparable) and confined here — no other code mints a presentation from a
 * fresh literal, which is what blocks the direct literal forge everywhere else.
 * This does not make the value unforgeable against spread/cast laundering of an
 * already-resolved presentation (see the module doc, layer 2); it makes THIS the
 * only place a presentation is legitimately built from scratch.
 */
function mint(value: UnbrandedVendorPresentation): VendorPresentation {
  return value as VendorPresentation;
}
