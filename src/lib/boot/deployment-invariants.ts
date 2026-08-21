// MEASURED DEPLOYMENT INVARIANTS (cinatra#2754, the maintainer's 2026-08-21
// hardening ruling, requirement 3).
//
// A deployment requirement written in prose is a requirement nobody checks. The
// required-env preflight next door is where this app already CHECKS its
// deployment's configuration before it agrees to serve — one aggregated, loud,
// fail-closed report at the earliest point a production process can produce one
// — so a requirement that must be machine-checked belongs beside it, and this
// module is that list.
//
// EVERY ENTRY IS EXECUTED, NEVER DECLARED. An invariant here does not assert
// that somebody remembered something; it MEASURES the shipped code, on this
// boot, and returns an actionable sentence when the measurement disagrees with
// the requirement. A prod boot with a failed invariant refuses, exactly as a
// missing hard env var does: an instance that cannot satisfy a security
// requirement must not come up quietly satisfying it in name only.
//
// Deliberately NOT importing "server-only": the preflight that runs this list
// is unit-tested, and so is this.

import { redactSensitive } from "@/lib/redact-sensitive";

/** One machine-checked deployment requirement. */
export type DeploymentInvariant = {
  /** Stable id, used in the abort message. */
  name: string;
  /** What breaks if it does not hold, in one line an operator can act on. */
  why: string;
  /** MEASURE it. `null` when it holds; an actionable failure string when it does not. */
  measure: () => string | null;
};

// ---------------------------------------------------------------------------
// review-island-query-redaction
//
// `/lifecycle/review-island` is the one route in this app whose QUERY is a
// bearer. An `<iframe src>` GET carries no Authorization header and, on a
// genuinely cross-site CMS, no cookie either, so the address itself
// authenticates the reader (the ratified position, plan §12). Everything that
// copies a URL therefore copies a credential: an access log, a HAR export, a
// browser history entry, a stringified DOM node.
//
// The other two hardenings bound what a copy is worth — one minute, and one
// paint. This one is about the copy never being made in the first place, on the
// paths this repository owns: the app's shipped log redactor must remove the
// credential from every shape a log line takes, and the island route itself
// must hand its query to no logger at all (pinned directly by
// `src/lib/__tests__/review-island-query-redaction.test.ts`).
//
// SAY EXACTLY WHAT IS MEASURED, AND WHAT IS NOT. This invariant executes the
// SHIPPED REDACTOR against the shapes an island address is known to reach a log
// line in, and fails a prod boot when one survives. It does NOT — and from
// inside this process cannot — read a reverse proxy's or a CDN's own access-log
// configuration: that log line is written before any Cinatra code runs, by
// software this repository does not ship, and the only honest thing to do about
// it is to name it. The invariant's `why` therefore carries the operator-facing
// half of the requirement as well, so an operator reading a boot log is told
// what still has to be true at the edge rather than being left with the
// impression that a green boot settled it (the edge track shipped separately as
// the ops-side redaction work).
//
// THE PROBES ARE SYNTHETIC. The value below is a readable placeholder, not a
// credential and not a credential shape — the measurement is "does the redactor
// remove the value at this position", and a real sealed string would prove
// nothing extra while putting a bearer-shaped literal in the source tree.
// ---------------------------------------------------------------------------

/** The island's own path. Duplicated (not imported) to keep this list a leaf. */
const REVIEW_ISLAND_ROUTE = "/lifecycle/review-island";

/** A readable stand-in for a credential value: long enough and in the character
 *  class the redactor's value pattern is bounded to. */
const PROBE_VALUE = "review-island-redaction-probe-value-not-a-real-credential";

/** Every shape the address is known to reach a log line in. */
function redactionProbes(): unknown[] {
  const address = `${REVIEW_ISLAND_ROUTE}?ref=gate-ref&ic=${PROBE_VALUE}`;
  return [
    // An access-log request line.
    `GET ${address} HTTP/1.1" 200 1234`,
    // The credential as the FIRST query member (no `ref` in front of it).
    `${REVIEW_ISLAND_ROUTE}?ic=${PROBE_VALUE}`,
    // An absolute URL, as a HAR entry or a fetch error carries it.
    `request failed: https://app.example.test${address}`,
    // The query alone, without the path — a `searchParams` dump.
    `?ref=gate-ref&ic=${PROBE_VALUE}`,
    // An ALREADY-SERIALIZED query: the structural pass cannot reach a value that
    // is no longer at a key.
    `island paint: query={"ic":"${PROBE_VALUE}"}`,
    // The address PERCENT-ENCODED inside another URL's query, where the `=` that
    // the value pattern keys on never appears literally.
    `https://app.example.test/x?next=%2Flifecycle%2Freview-island%3Fic%3D${PROBE_VALUE}`,
    // A structured record carrying the address as a field.
    { event: "island_paint", url: address },
    // A structured record carrying the PARSED query.
    { event: "island_paint", query: { ref: "gate-ref", ic: PROBE_VALUE } },
    // An Error whose message embeds the address.
    new Error(`island load failed for ${address}`),
    // Nested one level down, where the deep walk has to reach it.
    { outer: { inner: [address] } },
  ];
}

function measureReviewIslandQueryRedaction(): string | null {
  for (const probe of redactionProbes()) {
    let rendered: string;
    try {
      rendered = JSON.stringify(redactSensitive(probe)) ?? "";
    } catch (error) {
      return `the log redactor threw on a ${typeof probe} probe: ${String(error)}`;
    }
    if (rendered.includes(PROBE_VALUE)) {
      return (
        `the review-island credential SURVIVED the shipped log redactor in this shape: ` +
        `${rendered.slice(0, 160)} — see STRING_PATTERN_SCRUBS in src/lib/redact-sensitive.ts`
      );
    }
  }
  return null;
}

/** THE LIST. One entry per machine-checked deployment requirement. */
export const DEPLOYMENT_INVARIANTS: readonly DeploymentInvariant[] = [
  {
    name: "review-island-query-redaction",
    why:
      "the /lifecycle/review-island query IS a bearer (an iframe src GET carries no header and, cross-site, no cookie), so a copy of the address in a log is a copy of the credential. MEASURED HERE: the shipped log redactor removes it from every shape a log line takes, and the route hands its query to no logger. NOT MEASURABLE HERE, and still required of the deployment: the reverse proxy / CDN in front of this instance must not write the raw request URI to its own access log — that line is written before any Cinatra code runs",
    measure: measureReviewIslandQueryRedaction,
  },
] as const;

export type DeploymentInvariantFailure = { name: string; reason: string };

/**
 * PURE check (no env reads, no throw). Measures every invariant and returns the
 * ones that did not hold. Exported for unit testing.
 */
export function checkDeploymentInvariants(
  invariants: readonly DeploymentInvariant[] = DEPLOYMENT_INVARIANTS,
): DeploymentInvariantFailure[] {
  const failures: DeploymentInvariantFailure[] = [];
  for (const invariant of invariants) {
    let reason: string | null;
    try {
      reason = invariant.measure();
    } catch (error) {
      // A measurement that cannot run is a failed measurement. Fail closed.
      reason = `the measurement threw: ${String(error)}`;
    }
    if (reason) failures.push({ name: invariant.name, reason: `${reason} — ${invariant.why}` });
  }
  return failures;
}

/** The loud multi-line abort message for a failed deployment invariant. */
export function formatDeploymentInvariantFailureMessage(
  failures: readonly DeploymentInvariantFailure[],
): string {
  const lines = failures.map((f) => `  - ${f.name}: ${f.reason}`);
  return (
    `[deployment-invariants] ${failures.length} measured deployment requirement(s) do not hold — ` +
    `refusing to boot:\n${lines.join("\n")}`
  );
}
