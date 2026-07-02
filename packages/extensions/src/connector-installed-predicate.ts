// Pure connector-"installed" predicate (cinatra#657, Phase-A keystone).
//
// This is the DECISION half of the runtime-sourced connector-installed predicate
// — no IO, no DB, no filesystem. The host wraps it (see
// `src/lib/connectors-registry.server.ts` `isConnectorInstalledForActor`) by
// reading the canonical `installed_extension` rows (`pickActiveInstallId`) + the
// bundled static manifest, then handing the two booleans here.
//
// WHY a separate pure module: the `installed_extension` runtime store is now the
// AUTHORITATIVE source of truth for "is this connector installed for this actor";
// the generated `STATIC_EXTENSION_MANIFEST` is DEMOTED from the installed
// predicate to a BUNDLED FALLBACK. The decision rule is small but load-bearing,
// so it is unit-tested directly in `packages/extensions` (whose `test:invariants`
// CI job runs an EXPLICIT file list) rather than only in a host test that no CI
// job executes.
//
// CG-1 (the load-bearing invariant — verified at origin/main): the boot seeder
// (`src/lib/static-bundle-lifecycle.ts`) anchors a canonical row ONLY for bundled
// packages WITH a serverEntry OR required-in-prod (plus their transitive required
// closure). A bundled schema-config connector with NO serverEntry that is NOT
// required-in-prod therefore has NO canonical row on a fresh instance. A naive
// fail-CLOSED flip ("installed iff a live row") would BLANK such bundled built-ins
// on a fresh instance. So fail-CLOSED applies ONLY to RUNTIME-installed rows
// (an archived/absent runtime row → not installed) and to a canonical-store
// OUTAGE — NEVER to a bundled built-in that legitimately has no row. The static
// manifest stays the bundled fallback.

/**
 * Decide whether a connector is "installed" for the visibility predicate
 * (card/list visibility), from already-read inputs.
 *
 * Rule:
 *   1. an addressable LIVE row              → installed (runtime source of truth);
 *   2. an addressable row that is NOT live  → NOT installed (an operator
 *      archived/disabled it — the bundled fallback must NOT resurrect it);
 *   3. NO addressable row at all + bundled  → installed (the bundled fallback,
 *      for a bundled built-in that legitimately has no canonical row — CG-1);
 *   4. NO addressable row at all + not bundled → NOT installed (fail-closed).
 *
 *  - `hasAddressableLiveCanonicalRowForActor`: TRUE iff the canonical store holds
 *    an `active|locked` `installed_extension` row addressable in this actor's
 *    scope (the host derives this from `pickActiveInstallId(rows, actor) !== null`,
 *    which already fail-closes on archived rows, cross-org rows, and malformed
 *    owner-less user/team rows). This is the RUNTIME source of truth.
 *  - `hasAddressableCanonicalRowForActor` (status-AGNOSTIC): TRUE iff ANY row
 *    (live OR archived) addressable in this actor's scope exists. This is what
 *    lets us tell "legitimately no row" (the CG-1 fallback case) APART from
 *    "explicitly archived/disabled" — only the FORMER falls back to bundled. The
 *    host derives it from `isInstallRowAddressableByActor` over all rows.
 *  - `bundledInStaticManifest`: TRUE iff the package is bundled in the running
 *    image (own-key membership in `STATIC_EXTENSION_MANIFEST`). This is the
 *    BUNDLED FALLBACK — but ONLY when there is NO addressable row at all.
 *
 * CG-1 precision: the bundled fallback applies for a bundled built-in that
 * legitimately has NO row (a bundled schema-config connector the boot seeder
 * never anchored) and for a canonical-store OUTAGE (the host passes both
 * addressable flags false). It must NOT apply when a bundled connector has an
 * addressable ARCHIVED row — that is an explicit operator disable, and falling
 * back to bundled there would resurrect a torn-down surface, breaking the runtime
 * source-of-truth/lifecycle intent.
 *
 * Store-availability is NOT an input: it is an IO concern the host wrapper owns.
 * On a canonical-store read failure the wrapper passes BOTH addressable flags
 * `false`; a bundled connector stays visible (case 3), while a purely
 * RUNTIME-installed connector (no bundled entry) correctly fails CLOSED (case 4)
 * — its installed-ness cannot be proven, and we never invent a row.
 *
 * This predicate authorizes only LIST/CARD VISIBILITY. It is NOT render or write
 * authorization: rendering a runtime schema-config surface still passes the full
 * trust gate (`resolveRuntimeConnectorUiRecord`, anchor → integrity → signature →
 * trust classification), and action endpoints keep their own install/action
 * policy gates. Do not treat a `true` here as permission to render/execute.
 */
export function isConnectorInstalledFromRuntime(input: {
  hasAddressableLiveCanonicalRowForActor: boolean;
  hasAddressableCanonicalRowForActor: boolean;
  bundledInStaticManifest: boolean;
}): boolean {
  // (1) a live row is the runtime source of truth — installed.
  if (input.hasAddressableLiveCanonicalRowForActor) return true;
  // (2) an addressable-but-non-live row = an explicit operator archive/disable;
  // the bundled fallback must NOT resurrect it.
  if (input.hasAddressableCanonicalRowForActor) return false;
  // (3)/(4) NO addressable row at all (or a store outage): the bundled static
  // manifest is the fallback for a bundled built-in with no row (CG-1); a
  // runtime-only connector fails closed.
  return input.bundledInStaticManifest;
}
