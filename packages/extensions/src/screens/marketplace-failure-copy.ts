// ---------------------------------------------------------------------------
// marketplace-failure-copy — actionable, NON-technical end-user copy for a
// marketplace install / update / restore failure (cinatra#685).
//
// WHY THIS EXISTS. Before this module the marketplace surfaced ONE hardcoded
// string for every install/update failure ("Could not install X. The package
// may be unavailable in the connected registry."). That string is a catch-all
// that is frequently WRONG (it fires identically for an authorization failure, a
// transient outage, and a genuinely-missing package), and it leaks operator
// jargon ("registry") that means nothing to an end user.
//
// SOURCE OF TRUTH. marketplace#152 added the single machine-readable
// `InstallFailureTaxonomy` (PHP, verdaccio-core) mapping every PUBLIC coarse
// failure code the gatekept-install contract can return to exactly one of five
// app-facing CATEGORIES. This module is the TypeScript consumer of that
// taxonomy: it classifies a thrown failure into the SAME five categories and
// maps each category to plain-language, ACTIONABLE copy (what the user should do
// next). It deliberately mirrors the PHP code→category table so both sides agree.
//
// SECURITY / NO NEW ORACLE. Classification reads ONLY the PUBLIC coarse error
// code (`cinatra.<code>`) the caller already receives, plus a conservative HTTP
// status fallback. It never surfaces the raw error text, response body, status
// code, dependency identity, or any per-dependency signal to the end user — the
// full technical detail stays operator-side (server logs). An unknown / missing
// code fails SAFE to `unrecoverable`, exactly as the PHP `classify()` does.
// ---------------------------------------------------------------------------

/**
 * The five app-facing install-failure categories. EXACT mirror of
 * `InstallFailureTaxonomy::CATEGORIES` (marketplace verdaccio-core). Keep in
 * sync if the PHP taxonomy grows a category.
 */
export const MARKETPLACE_FAILURE_CATEGORIES = [
  "retryable",
  "missing-creds",
  "denied-entitlement",
  "unavailable-version",
  "unrecoverable",
] as const;

export type MarketplaceFailureCategory = (typeof MARKETPLACE_FAILURE_CATEGORIES)[number];

/** The lifecycle operation whose failure we are describing. */
export type MarketplaceFailureOperation = "install" | "update" | "restore";

/**
 * What a marketplace lifecycle FORM action returns to the client on FAILURE.
 * The success path never returns (it `redirect()`s, which throws a NEXT_REDIRECT
 * sentinel), so a returned value always means failure. The category is the ONLY
 * thing crossing the boundary — never raw error text. A server-action RETURN
 * value is not masked by Next.js production builds (only THROWN errors are), so
 * the category reliably reaches the client where a thrown message would not.
 */
export type MarketplaceInstallActionResult = {
  ok: false;
  category: MarketplaceFailureCategory;
};

/**
 * TS mirror of `InstallFailureTaxonomy::MAP` — public coarse code → category.
 * Keyed WITHOUT the `cinatra.` prefix (we strip it when scanning). Keep this in
 * lockstep with the PHP table; the parity is exercised by
 * marketplace-failure-copy.test.ts and ultimately guaranteed cross-repo by the
 * PHP doc-parity suite (the PHP map is the authority).
 */
const COARSE_CODE_CATEGORY: Record<string, MarketplaceFailureCategory> = {
  // --- extension_install_authorize / InstallGrantAbilityBase ---------------
  invalid_package_name: "unrecoverable",
  invalid_version: "unavailable-version",
  install_not_listed: "unavailable-version",
  install_not_entitled: "denied-entitlement",
  install_closure_unresolved: "unavailable-version",
  install_signing_unavailable: "unrecoverable",
  // --- extension_install_grant_refresh -------------------------------------
  install_refresh_op_expired: "retryable",
  install_refresh_rate_limited: "retryable",
  install_closure_changed: "retryable",
  install_refresh_invalid: "unrecoverable",
  // --- instance_attach_self ------------------------------------------------
  invalid_input: "unrecoverable",
  invalid_instance_id: "unrecoverable",
  db_write_failed: "retryable",
  db_consistency_error: "retryable",
  instance_attach_proof_mismatch: "missing-creds",
  backfill_in_progress: "retryable",
  broker_unavailable: "retryable",
  broker_invariant_violated: "unrecoverable",
  wp_user_lookup_failed: "unrecoverable",
  app_password_mint_failed: "missing-creds",
  app_password_revoke_failed: "missing-creds",
  app_passwords_unavailable: "missing-creds",
  // --- broker install read-proxy (InstallProxyKernel) ----------------------
  install_proxy_unconfigured: "retryable",
  install_method_not_allowed: "unrecoverable",
  install_request_invalid: "unrecoverable",
  install_unauthenticated: "missing-creds",
  install_rate_limited: "retryable",
  install_grant_invalid: "unrecoverable",
  install_not_covered: "retryable",
  install_not_found: "unavailable-version",
  install_upstream_unavailable: "retryable",
  install_member_integrity_mismatch: "unavailable-version",
};

/**
 * Map an HTTP status to a category when no coarse `cinatra.<code>` is present.
 * Conservative on purpose (codex-converged): only transient server statuses and
 * a hard 404 are confidently classifiable; everything else (incl. 401/403,
 * which can mean auth-setup OR entitlement OR a stale grant) falls through to
 * `unrecoverable` so we never assert a specific, possibly-wrong cause.
 */
function categoryFromHttpStatus(status: number): MarketplaceFailureCategory | null {
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return "retryable";
  }
  if (status === 404) {
    return "unavailable-version";
  }
  return null;
}

// Match a public coarse code anywhere in a string: `cinatra.install_not_entitled`.
// Captures the bare code (without the `cinatra.` prefix) for the map lookup.
const COARSE_CODE_RE = /cinatra\.([a-z0-9_]+)/gi;

/**
 * Walk an error and any nested `cause`/`responseBody`/`httpStatus` looking for a
 * public coarse code or a classifiable HTTP status. Returns the FIRST category
 * found, or `null` if nothing classifiable surfaces. Bounded depth so a cyclic
 * cause chain can never loop forever.
 */
// Probe result: a resolved category, `"present-unmapped"` (a `cinatra.<code>`
// token was seen but is not in our map → fail SAFE to unrecoverable, exactly as
// the PHP classify() does — do NOT let an HTTP status override a recognized-shape
// contract code), or `null` (nothing coarse-code-shaped found at all).
type ProbeResult = MarketplaceFailureCategory | "present-unmapped" | null;

function probe(value: unknown, depth: number): ProbeResult {
  if (depth > 6 || value == null) return null;

  // Strings: scan for a coarse code token.
  if (typeof value === "string") {
    COARSE_CODE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let sawCoarseToken = false;
    while ((m = COARSE_CODE_RE.exec(value)) !== null) {
      sawCoarseToken = true;
      const cat = COARSE_CODE_CATEGORY[m[1].toLowerCase()];
      if (cat) return cat;
    }
    // A `cinatra.<code>` was present but unmapped → fail safe, don't fall back
    // to an HTTP-status guess for a recognized-shape contract code.
    return sawCoarseToken ? "present-unmapped" : null;
  }

  if (typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  // `present-unmapped` is remembered but a deeper probe may still find a MAPPED
  // code; a concrete category always wins over the safe default.
  let sawUnmapped = false;
  const consider = (r: ProbeResult): MarketplaceFailureCategory | null => {
    if (r === "present-unmapped") {
      sawUnmapped = true;
      return null;
    }
    return r;
  };

  // Error-like: message + cause.
  if (typeof obj.message === "string") {
    const fromMsg = consider(probe(obj.message, depth + 1));
    if (fromMsg) return fromMsg;
  }
  // MarketplaceMcpError carries the coarse code inside responseBody.
  if (typeof obj.responseBody === "string") {
    const fromBody = consider(probe(obj.responseBody, depth + 1));
    if (fromBody) return fromBody;
  }
  // Some payloads carry an explicit coarse code field.
  for (const key of ["code", "error_code", "errorCode"]) {
    const v = obj[key];
    if (typeof v === "string") {
      const bare = v.toLowerCase().replace(/^cinatra\./, "");
      const cat = COARSE_CODE_CATEGORY[bare];
      if (cat) return cat;
      if (/^cinatra\./i.test(v)) sawUnmapped = true;
    }
  }
  // Chained cause.
  if ("cause" in obj) {
    const fromCause = consider(probe(obj.cause, depth + 1));
    if (fromCause) return fromCause;
  }
  return sawUnmapped ? "present-unmapped" : null;
}

/**
 * Find a classifiable HTTP status anywhere in the error chain (used only as a
 * fallback when no coarse code is present).
 */
function probeHttpStatus(value: unknown, depth: number): MarketplaceFailureCategory | null {
  if (depth > 6 || value == null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const key of ["httpStatus", "status", "statusCode", "http_status"]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      const cat = categoryFromHttpStatus(v);
      if (cat) return cat;
    }
  }
  if ("cause" in obj) {
    const fromCause = probeHttpStatus(obj.cause, depth + 1);
    if (fromCause) return fromCause;
  }
  return null;
}

/**
 * Classify a thrown marketplace failure into one of the five taxonomy
 * categories. Reads ONLY the public coarse code (and a conservative HTTP-status
 * fallback) from the error message, its `cause` chain, an MCP error's
 * `responseBody`, or an explicit code field. An unclassifiable failure fails
 * SAFE to `unrecoverable` — matching `InstallFailureTaxonomy::classify()` so we
 * never proceed as if a clear cause were known.
 */
export function classifyMarketplaceFailure(error: unknown): MarketplaceFailureCategory {
  const byCode = probe(error, 0);
  if (byCode === "present-unmapped") {
    // A recognized-shape `cinatra.<code>` was present but is not in the map →
    // fail SAFE to unrecoverable (matching the PHP classify()). Do NOT let an
    // HTTP-status guess override a contract code we simply do not classify yet.
    return "unrecoverable";
  }
  if (byCode) return byCode;
  // No coarse code at all → an HTTP-status fallback is the best we can do.
  const byStatus = probeHttpStatus(error, 0);
  if (byStatus) return byStatus;
  return "unrecoverable";
}

// Per-operation verb fragments used in the copy.
const OP_LABEL: Record<MarketplaceFailureOperation, { verb: string; gerund: string }> = {
  install: { verb: "install", gerund: "installed" },
  update: { verb: "update", gerund: "updated" },
  restore: { verb: "restore", gerund: "restored" },
};

/**
 * Plain-language, ACTIONABLE end-user copy for a failed install/update/restore,
 * keyed by taxonomy category. NO technical detail — no "registry", "bearer",
 * "MCP", HTTP status, version coordinates, grant/token/closure wording. Every
 * message tells the user what to do next and never asserts a specific cause it
 * cannot be sure of.
 *
 * Restore is a DB-only re-activation (it never touches the marketplace), so its
 * marketplace-shaped categories collapse to the same simple "try again / contact
 * your administrator" guidance.
 */
export function marketplaceFailureCopy(
  category: MarketplaceFailureCategory,
  operation: MarketplaceFailureOperation,
  displayName: string,
): string {
  const name = displayName;
  const { verb, gerund } = OP_LABEL[operation];

  // Restore is a DB-only re-activation that NEVER round-trips the marketplace, so
  // the marketplace-shaped categories (missing-creds / denied-entitlement /
  // unavailable-version) cannot truthfully describe a restore failure. Collapse
  // them to generic, non-cause-asserting restore guidance so we never tell the
  // user (e.g.) "this version is no longer available" for a local re-activation.
  if (operation === "restore") {
    if (category === "retryable") {
      return `Couldn't restore ${name} right now. Please try again in a moment.`;
    }
    return `Couldn't restore ${name}. Please try again, and contact your administrator if it keeps happening.`;
  }

  switch (category) {
    case "retryable":
      return `Couldn't ${verb} ${name} right now. Please try again in a moment.`;
    case "missing-creds":
      return `Couldn't ${verb} ${name} — your workspace isn't connected to the marketplace. Ask your administrator to reconnect it, then try again.`;
    case "denied-entitlement":
      return operation === "update"
        ? `${name} can't be ${gerund} on your workspace. If you need this update, contact your administrator.`
        : `${name} isn't available to ${verb} on your workspace. If you need it, contact your administrator.`;
    case "unavailable-version":
      return `${name} can't be ${gerund} right now — this version is no longer available. Please check back later, or contact your administrator.`;
    case "unrecoverable":
    default:
      return `Couldn't ${verb} ${name}. Please try again, and contact your administrator if it keeps happening.`;
  }
}

/**
 * Build the full per-category copy map for one operation + display name, ready
 * to hand to the client form. The client picks `map[category]` and falls back to
 * the `unrecoverable` entry for any unexpected value.
 */
export function buildMarketplaceFailureCopy(
  operation: MarketplaceFailureOperation,
  displayName: string,
): Record<MarketplaceFailureCategory, string> {
  const out = {} as Record<MarketplaceFailureCategory, string>;
  for (const category of MARKETPLACE_FAILURE_CATEGORIES) {
    out[category] = marketplaceFailureCopy(category, operation, displayName);
  }
  return out;
}
