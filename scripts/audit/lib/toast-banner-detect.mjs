// Toast-banner detector — the single source of truth for the "searchParams-flash
// -driven transient banner" heuristic shared by:
//   - the core vitest guard  (src/lib/__tests__/toast-banner-guard.test.ts),
//     wired into the REQUIRED "Perpetual system loops invariants" check; and
//   - the standalone connector scanner (scripts/audit/toast-banner-scan.mjs),
//     run by the reusable `toast-banner-gate-reusable.yml` workflow that the
//     S3–S12 connector repos adopt (cinatra#1213 AC3).
//
// Extracting the detectors here (they used to live inline in the vitest file)
// keeps ONE definition of the rule so the connector gate can never drift from
// the core gate — the same single-source-of-truth shape the extension
// conformance gate uses (scripts/extensions/lib/conformance-rules.mjs).
//
// The rule (file-level heuristic, deliberately conservative): a file BOTH
//   (a) reads a transient-OUTCOME searchParam (a post-action redirect flash),
//   AND
//   (b) renders a status <Alert> (success/destructive) or a flash-palette
//       colored <div>,
// is a non-canonical transient banner. Comments are stripped first (via the
// shared lexical stripper) so a doc-comment mention neither trips nor masks the
// guard. The full rationale, accepted limits (opaque-variable evasion, per-file
// granularity) and the RED/GREEN unit fixtures live with the core vitest guard.

import { stripComments } from "./strip-comments.mjs";

/**
 * Transient-OUTCOME query-param codes. Deliberately specific (a post-action
 * redirect flash), NOT generic tokens like `status`/`page` that route/pagination
 * code reads — this is what keeps the heuristic off persistent surfaces.
 */
const OUTCOME =
  "(?:saved|ok|error|errors|deleted|added|removed|invalid|invalidUrl|logsCleared|reconnected|disconnected)";

/**
 * A read of a transient-outcome value FROM searchParams. Covers (incl. optional
 * chaining `?.`):
 *   - `searchParams.get("saved")` / `searchParams?.get("saved")`
 *   - `resolvedSearchParams.ok` / `searchParams.error` / `params.error` /
 *     `sp.deleted` (the resolved-searchParams object is conventionally named
 *     one of these; the OUTCOME token set makes a route-`params` collision
 *     effectively impossible — route params are path segments, never `ok`/`error`)
 *   - `pick(sp.error)` / `pickSearchParam(resolvedSearchParams.ok)`
 */
export const FLASH_OUTCOME_READ = new RegExp(
  "(?:" +
    `searchParams\\??\\.get\\(\\s*["']${OUTCOME}["']` +
    "|" +
    `(?:resolvedSearchParams|searchParams|params|sp)\\??\\.${OUTCOME}\\b` +
    "|" +
    `pick\\w*\\(\\s*\\w+\\??\\.${OUTCOME}\\b` +
    ")",
  "i",
);

/**
 * A status-carrying `<Alert>` — the transient-banner variants. Matches both a
 * string-literal variant (`variant="destructive"`) and an inline-expression
 * variant that names the code (`variant={x ? "destructive" : "default"}`). A
 * plain `<Alert>` / `variant="default"` (persistent/informational) does NOT
 * match. A variant supplied through an opaque variable is a known residual (see
 * the core guard header's accepted-limits note).
 */
export const ALERT_STATUS_BANNER =
  /<Alert\b[^>]*\bvariant\s*=\s*(?:["'](?:success|destructive)["']|\{[^}>]*\b(?:success|destructive)\b)/;

/** A raw colored-`<div>` banner in the flash palette (bg-/border- status
 * colors). `text-`-only destructive copy (in-dialog inline errors) does NOT
 * match — only a filled/bordered banner surface. `className={cn("bg-…")}` and
 * template-literal class strings are caught; a class built from a variable is
 * a known residual. */
export const FLASH_COLORED_DIV =
  /<div\b[^>]*className=[^>]*(?:bg-destructive|bg-red-|bg-amber-|bg-yellow-|bg-emerald-|bg-green-|border-destructive)\b/;

/** True when the file renders a transient banner primitive. */
export function rendersTransientBanner(strippedText) {
  return ALERT_STATUS_BANNER.test(strippedText) || FLASH_COLORED_DIV.test(strippedText);
}

/** True when the file reads a transient-outcome searchParam. */
export function readsFlashOutcomeParam(strippedText) {
  return FLASH_OUTCOME_READ.test(strippedText);
}

/**
 * The guard's file-level match: a searchParams-flash-driven transient banner.
 * Comments are stripped first so a doc-comment mention neither trips nor masks
 * the guard. A file both reads a transient-outcome param AND renders a status
 * banner.
 */
export function isBannerFile(text) {
  const stripped = stripComments(text);
  return readsFlashOutcomeParam(stripped) && rendersTransientBanner(stripped);
}

/**
 * Repo-relative paths that are NEVER scanned: test/fixture files (they hold the
 * RED-behaviour fixtures) and the canonical flash island itself (the sanctioned
 * consumer of a flash param). Shared by both the core vitest guard and the
 * connector scanner so the exclusion set can never drift between them.
 */
export function isExcludedFromScan(rel) {
  return (
    /(^|\/)__tests__\//.test(rel) ||
    /\.test\.tsx?$/.test(rel) ||
    /(^|\/)search-param-toast\.tsx$/.test(rel)
  );
}

/** The canonical-layer guidance printed when the guard bites (the baseline-path
 * sentence is appended by each caller, since core and each connector keep the
 * baseline at a different path). */
export const CANONICAL_LAYER_HINT =
  "Route this transient notification through the canonical toast layer instead of an ad-hoc banner: " +
  "imperative feedback → `cinatraToast` / `useNotify`; a URL flash outcome → the codes-only " +
  "`<SearchParamToast>` island (@cinatra-ai/sdk-ui).";
