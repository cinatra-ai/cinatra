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
  /**
   * Opaque diagnostic reference (cinatra#1539) for a classified install/update
   * failure — e.g. "REF-1A2B3C4D". Correlates the user-visible failure with the
   * SANITIZED operator log emitted at the classification chokepoint (which
   * carries the raw contract code + HTTP status). Shown to the admin so they can
   * cite it; it is opaque and carries NO technical detail itself. Absent for
   * failures that are not an install-classification result (e.g. an access-stage
   * failure, whose own log is the operator signal).
   */
  reference?: string;
  /**
   * WHERE the failure happened, for callers that need to distinguish (added
   * with the pre-install access selector, cinatra#805). Absent / "install" =
   * the install itself failed. "access" = the install SUCCEEDED but applying
   * the selected access policy failed AND the fresh install was rolled back
   * (uninstalled), so a narrower-than-default selection never silently fails
   * open to workspace access. "access-partial" = the access write failed AND
   * the compensating uninstall ALSO failed — the extension is installed with
   * the per-kind DEFAULT (workspace) access; the operator log carries the
   * details. "access-required" = the install SUCCEEDED for an access-target
   * kind (connector/artifact/workflow) but NO access target was supplied, so
   * the action REFUSED to persist the broadest per-kind default (a silent
   * workspace-wide grant) and made no net change — the fresh install was rolled
   * back, or a pre-existing install was left untouched (cinatra#1602,
   * defense-in-depth follow-up of #1541). The caller must supply an access
   * target and retry.
   */
  stage?: "install" | "access" | "access-partial" | "access-required";
};

/**
 * TS mirror of `InstallFailureTaxonomy::MAP` — public coarse code → the PHP
 * CONTRACT category. Keyed WITHOUT the `cinatra.` prefix (we strip it when
 * scanning). This stays a FAITHFUL mirror of the PHP table; keep it in lockstep
 * with the PHP map (the authority) — the parity is exercised by
 * marketplace-failure-copy.test.ts and ultimately guaranteed cross-repo by the
 * PHP doc-parity suite (the PHP map is the authority).
 *
 * The app's END-USER COPY category may differ from this CONTRACT category for a
 * documented set of codes; that presentation policy lives SEPARATELY in
 * `COPY_CATEGORY_OVERRIDES` (cinatra#1539), so this mirror is NEVER mutated for
 * a copy decision. `classifyMarketplaceFailure` returns the copy category (this
 * map with the overrides applied); the raw contract code stays available to
 * operators via `extractContractCode`.
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
 * App-side END-USER COPY overrides (cinatra#1539) — a PRESENTATION policy that
 * is intentionally SEPARATE from the PHP contract mirror above. Each of these
 * codes' PHP CONTRACT category is `unavailable-version`, but its USER COPY must
 * NOT assert "this version is no longer available": a bad input, an unresolved
 * dependency closure, and an artifact-integrity mismatch are NOT a gone version.
 * They re-bucket to `unrecoverable` (generic, non-cause-asserting copy). This
 * changes ONLY the user message — the contract category (COARSE_CODE_CATEGORY)
 * and the raw contract code (extractContractCode, logged for operators) are
 * untouched, so PHP/operator fidelity is intact. After this, `unavailable-version`
 * copy survives ONLY for codes that affirmatively support "not available to
 * install at this version" (`install_not_listed`, `install_not_found`).
 */
const COPY_CATEGORY_OVERRIDES: Record<string, MarketplaceFailureCategory> = {
  invalid_version: "unrecoverable",
  install_closure_unresolved: "unrecoverable",
  install_member_integrity_mismatch: "unrecoverable",
};

/**
 * The end-user COPY category for a bare coarse code: the PHP contract category
 * with the #1539 copy overrides applied. `undefined` when the code is unmapped.
 */
function copyCategoryForCode(code: string): MarketplaceFailureCategory | undefined {
  return COPY_CATEGORY_OVERRIDES[code] ?? COARSE_CODE_CATEGORY[code];
}

/**
 * Map an HTTP status to a category when no coarse `cinatra.<code>` is present.
 * Conservative on purpose: only transient server statuses are confidently
 * classifiable from a bare status. Everything else — INCLUDING a bare 404 —
 * falls through to `null` so `classifyMarketplaceFailure` fails SAFE to
 * `unrecoverable` rather than assert a specific, possibly-wrong cause.
 *
 * #1539: a status-only 404 with NO recognized contract code is NOT evidence
 * that "this version is no longer available" — the contract carries a real
 * gone/not-found condition as `cinatra.install_not_found` (a mapped code), so a
 * bare 404 (a misrouted request, a wrong endpoint, a gateway) must NOT be
 * reported as a gone version. It is deliberately unclassifiable here. (401/403
 * stay unclassifiable too: auth-setup OR entitlement OR a stale grant.)
 */
function categoryFromHttpStatus(status: number): MarketplaceFailureCategory | null {
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return "retryable";
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
      const cat = copyCategoryForCode(m[1].toLowerCase());
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
      const cat = copyCategoryForCode(bare);
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
 * Classify a thrown marketplace failure into the app END-USER COPY category
 * (one of the five taxonomy categories, with the #1539 `COPY_CATEGORY_OVERRIDES`
 * applied — see that map). Reads ONLY the public coarse code (and a conservative
 * HTTP-status fallback) from the error message, its `cause` chain, an MCP
 * error's `responseBody`, or an explicit code field. An unclassifiable failure
 * fails SAFE to `unrecoverable` — matching `InstallFailureTaxonomy::classify()`
 * so we never proceed as if a clear cause were known. The RAW contract code (for
 * operator diagnostics) is available separately via `extractContractCode`.
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

// ---------------------------------------------------------------------------
// Operator diagnostics (cinatra#1539). The end user only ever sees the
// category-derived, NON-technical copy; the operator needs the RAW public
// coarse contract code and HTTP status to correlate a reported failure with its
// true cause. These extractors return that raw signal for the SANITIZED
// operator log ONLY — they read the SAME public coarse code / status the
// classifier already sees (no new oracle), and they never surface a response
// body, secret, or per-dependency detail.
//
// `extractContractCode` returns the contract code that EXPLAINS the logged
// category, so an operator reading a `code=… category=…` line never sees a
// mismatch:
//  - if the classifier resolved a concrete category, it returns the FIRST
//    MAPPED code in the classifier's own walk order — i.e. the exact code that
//    produced that category, SKIPPING an earlier as-yet-UNMAPPED token exactly
//    as `classifyMarketplaceFailure`'s `probe` does (so a new PHP-taxonomy code
//    the TS map has not caught up with, sitting ahead of a mapped code in the
//    same error, can never be logged as the cause of a category it did not
//    produce);
//  - only when NO code in the chain maps to a category (the classifier fell
//    SAFE to `unrecoverable`) does it return the first RECOGNIZED-SHAPE
//    (`cinatra.`-prefixed) coarse code SEEN — the unmapped contract code the app
//    fell safe on, which is precisely what the operator needs to see to notice
//    the drift. A BARE, unprefixed code field is deliberately NOT reported in
//    this fallback: the classifier does not treat a bare unmapped field as a
//    contract signal (it classifies from the HTTP status instead — its
//    `sawUnmapped` gate fires only for a `cinatra.`-prefixed field), so logging
//    it would read `code=<bare> category=<from status>`, the exact misleading
//    `code=X category=<from a different signal>` diagnostic #1539 eliminates;
//  - `null` when no coarse code is present at all.
// Codes are returned WITHOUT the `cinatra.` prefix and length-bounded.
// ---------------------------------------------------------------------------

// A contract code is a bounded token; cap the extracted length so an adversarial
// giant token can never bloat an operator log line (real codes are < 64 chars).
const MAX_CONTRACT_CODE_LEN = 64;

// Single walk over the error chain (message → responseBody → explicit code
// field → cause — the SAME order `probe` / `classifyMarketplaceFailure` uses),
// returning the first coarse code that satisfies `accept`. `accept` also receives
// whether the code was RECOGNIZED-SHAPE (a `cinatra.`-prefixed token — the same
// gate the classifier's `probe` uses to treat an UNMAPPED code as a contract
// signal). Bounded depth so a cyclic cause chain can never loop forever.
// `extractContractCode` runs it twice — first demanding a MAPPED code, then (only
// if none) accepting the first RECOGNIZED-SHAPE code — so the extracted code
// always agrees with the classifier's category decision.
function walkContractCode(
  error: unknown,
  depth: number,
  accept: (bareCode: string, recognizedShape: boolean) => boolean,
): string | null {
  if (depth > 6 || error == null) return null;
  if (typeof error === "string") {
    COARSE_CODE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COARSE_CODE_RE.exec(error)) !== null) {
      const bare = m[1].toLowerCase();
      // A string token is matched ONLY via the `cinatra.`-prefixed regex, so it
      // is always a recognized-shape contract code.
      if (accept(bare, true)) return bare.slice(0, MAX_CONTRACT_CODE_LEN);
    }
    return null;
  }
  if (typeof error !== "object") return null;
  const obj = error as Record<string, unknown>;
  if (typeof obj.message === "string") {
    const c = walkContractCode(obj.message, depth + 1, accept);
    if (c) return c;
  }
  if (typeof obj.responseBody === "string") {
    const c = walkContractCode(obj.responseBody, depth + 1, accept);
    if (c) return c;
  }
  for (const key of ["code", "error_code", "errorCode"]) {
    const v = obj[key];
    if (typeof v === "string") {
      // Parse the field EXACTLY as the classifier's `probe` does — lower-case and
      // strip a LEADING `cinatra.`, WITHOUT trimming (probe does not trim, and the
      // map is keyed on untrimmed tokens). Trimming ONLY here would let a
      // whitespace-padded token (e.g. `"install_not_found "`) MAP in the extractor
      // while the classifier leaves it unmapped and classifies from the HTTP
      // status — logging `code=install_not_found category=retryable`, the exact
      // provenance bug #1539 forbids. `recognizedShape` is the classifier's
      // `sawUnmapped` gate byte-for-byte (`/^cinatra\./i.test(v)`): a bare field is
      // a contract signal ONLY when it maps (first pass); an UNMAPPED bare field is
      // not reported by the fallback. The extra `[a-z0-9_]+` guard only bounds the
      // LOGGED value — a malformed prefixed token still forces the classifier SAFE
      // to `unrecoverable`, and reporting `code=null` for it never misattributes a
      // code to a category.
      const recognizedShape = /^cinatra\./i.test(v);
      const bare = v.toLowerCase().replace(/^cinatra\./, "");
      if (/^[a-z0-9_]+$/.test(bare) && accept(bare, recognizedShape)) {
        return bare.slice(0, MAX_CONTRACT_CODE_LEN);
      }
    }
  }
  if ("cause" in obj) {
    const c = walkContractCode(obj.cause, depth + 1, accept);
    if (c) return c;
  }
  return null;
}

/**
 * Walk the error chain for the contract code that explains the classifier's
 * category (see the header above). First pass demands a MAPPED code (the exact
 * code the classifier resolved on); the fallback pass returns the first
 * RECOGNIZED-SHAPE (`cinatra.`-prefixed) code the classifier fell safe on — never
 * a bare, unprefixed field the classifier classified AROUND (via the HTTP status),
 * which would log `code=<bare> category=<from status>`. Bare, unprefixed, bounded.
 */
export function extractContractCode(error: unknown): string | null {
  return (
    walkContractCode(error, 0, (code) => copyCategoryForCode(code) !== undefined) ??
    walkContractCode(error, 0, (_code, recognizedShape) => recognizedShape)
  );
}

/** Walk the error chain for the first HTTP status number (raw, any status). */
export function extractHttpStatus(error: unknown, depth = 0): number | null {
  if (depth > 6 || error == null || typeof error !== "object") return null;
  const obj = error as Record<string, unknown>;
  for (const key of ["httpStatus", "status", "statusCode", "http_status"]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  if ("cause" in obj) return extractHttpStatus(obj.cause, depth + 1);
  return null;
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
      // #1539: reachable ONLY via a code that affirmatively means "not
      // installable at this version" (install_not_listed / install_not_found).
      // Do NOT assert the version WAS available and is now GONE ("no longer
      // available") — a claim the coarse code does not support; state only the
      // supported fact (not available to install right now).
      return `${name} can't be ${gerund} right now — this version isn't available to install. Please check back later, or contact your administrator.`;
    case "unrecoverable":
    default:
      return `Couldn't ${verb} ${name}. Please try again, and contact your administrator if it keeps happening.`;
  }
}

/**
 * Copy for an install-access failure (cinatra#805) — the install itself
 * succeeded but applying the selected pre-install access failed. Three shapes:
 *  - "access": the fresh install was ROLLED BACK (fail-closed) — nothing is
 *    installed; retrying is safe.
 *  - "access-partial": the rollback was impossible (pre-existing install) or
 *    itself failed — the extension IS installed, with its default access.
 *  - "access-required": an access-target kind was installed with NO access
 *    target, so the action refused to default to the broadest grant and made no
 *    net change (cinatra#1602); the admin must choose an access scope and retry.
 * Same copy rules as marketplaceFailureCopy: plain language, no jargon, never
 * asserts a cause it cannot be sure of.
 */
export function installAccessStageFailureCopy(
  stage: "access" | "access-partial" | "access-required",
  displayName: string,
): string {
  if (stage === "access") {
    return `Couldn't apply the selected access for ${displayName}, so nothing was installed. Please try again.`;
  }
  if (stage === "access-required") {
    return `${displayName} can't be installed without choosing who can access it. Select an access scope and try again.`;
  }
  return `${displayName} was installed, but the selected access couldn't be applied — it currently uses the default access for everyone in your workspace. Contact your administrator if that's not what you want.`;
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

/**
 * Append the opaque diagnostic reference (cinatra#1539) to a user-visible
 * failure message, when one is present. Single source of the "(Ref: …)" suffix
 * so EVERY client failure path (the marketplace toast, the access-scope dialog,
 * the update-plan Failed tile) surfaces it identically. The reference is opaque
 * and non-technical; a message with no reference is returned unchanged.
 */
export function appendDiagnosticReference(message: string, reference?: string): string {
  return reference ? `${message} (Ref: ${reference})` : message;
}
