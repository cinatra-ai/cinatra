// ---------------------------------------------------------------------------
// THE FENCE around the DESIGN-CONFORMANCE seed route
// (src/app/design-fixtures/conformance/seed/route.ts).
//
// WHY THE ROUTE NEEDS ONE. The route is not a fixture renderer: it performs REAL
// extension-lifecycle writes — install, lock, archive and force-delete of
// `installed_extension` rows — through the shipped lifecycle primitive, under a
// synthetic actor that carries `platform_admin` so it can unlock a locked
// fixture row. It also sits on the route guard's dev-only public list, so it is
// deliberately exempt from the sign-in redirect. Until this fence existed, the
// only thing standing between a caller and those writes was the build shape:
// any non-production runtime, and — because `CINATRA_E2E_SETUP_BYPASS=true` is
// what makes the fixtures reachable on the production-shaped verify build — that
// build too. A build shape is not an authorization boundary. A PRESENTED
// CAPABILITY is.
//
// THE THREE FENCES, in order:
//
//   1. THE CAPABILITY IS ARMED. `CINATRA_CONFORMANCE_SEED_TOKEN`, at least 32
//      characters. UNSET MEANS THE ROUTE IS OFF — the default state of every
//      stack that did not deliberately arm it, CI included until the workflow
//      mints one per run.
//   2. THE CAPABILITY IS PRESENTED. A bearer, compared in CONSTANT TIME. This is
//      the load-bearing fence: a remote caller does not have the secret, and a
//      browser cannot attach an `Authorization` header to a CORS-simple request
//      without a preflight this route answers for nobody — which is what closes
//      the cross-site path that the sign-in exemption would otherwise leave open
//      in an operator's own browser.
//   3. NO HOP FROM OFF THIS MACHINE. Defence in depth, and cheap: it narrows the
//      blast radius if the capability ever leaks into a shell history or a log.
//      It is a narrowing signal and never a proof — see `forwardedChainIsLocal`.
//
// WHAT THIS FENCE DELIBERATELY DOES NOT OWN. The build/runtime gate stays in the
// route (`seedingEnabled()`), because it is not the same gate as its sibling's:
// the conformance harness MUST work on a production-SHAPED standalone build
// under the documented e2e switch, which is exactly the shape
// `lifecycleSeedEnvVerdict` refuses outright. Keeping the two gates in their own
// modules is what stops one being "simplified" into the other.
//
// EVERY REFUSAL ANSWERS 404 — never 403, and this is a deliberate DIVERGENCE
// from `lifecycle-seed-fence`, which answers 403 once its environment gates have
// passed. That fence can afford to: by the time it inspects a caller, the host is
// already known to be a scripted development stack, so admitting the route
// exists tells an unauthorized caller nothing it could then reach. This route is
// reachable on a production-shaped CI build, so a 403 would confirm to an
// unauthenticated caller that a lifecycle-writing endpoint is mounted on this
// host. The refusals are therefore indistinguishable from "no such route".
//
// The `reason` on a refusal is for the SERVER's own diagnosis (a CI harness that
// forgot to forward the token looks identical to a missing route otherwise); it
// is never put in a response body.
//
// ONE NARROW EXCEPTION, AND ONLY ON A HARNESS SERVER (cinatra#3416). A server
// that armed the documented browser-e2e switch is by construction a test
// harness, never a real deployment, and the design suite that drives it could
// not tell a refusal from a missing route either — a refused seed POST reported
// only as "HTTP 404", with no fence named, cost a whole investigation. On that
// build, and on no other, a refusal additionally carries a header naming the
// fence. The status and the body do not move: a caller anywhere else still
// cannot distinguish a refusal from "no such route".
// ---------------------------------------------------------------------------

import {
  type SeedFenceEnv,
  forwardedChainIsLocal,
  presentedBearer,
  secretEquals,
} from "./seed-capability";

export type { SeedFenceEnv };

export type ConformanceSeedVerdict =
  | { ok: true }
  | { ok: false; status: 404; reason: string };

/** The env var carrying the per-run capability. UNSET = the route is OFF. */
export const CONFORMANCE_SEED_CAPABILITY_ENV = "CINATRA_CONFORMANCE_SEED_TOKEN";

/** Minimum capability length. 32 characters of a `randomBytes` hex/base64url is
 *  the shortest thing worth calling high-entropy; a short one is refused rather
 *  than accepted weakly. */
export const CONFORMANCE_SEED_CAPABILITY_MIN_LENGTH = 32;

/** The header the harness presents the capability in. */
export const CONFORMANCE_SEED_CAPABILITY_HEADER = "authorization";

/**
 * The header a refusal names its fence in — on a harness server only. The
 * design suite's seed helper reads it and puts it in the error it throws, so a
 * red names the fence that refused instead of a bare status code.
 */
export const CONFORMANCE_SEED_REFUSAL_HEADER = "x-conformance-seed-refusal";

/**
 * The documented browser-e2e switch. It is what makes this route reachable on a
 * production-SHAPED verify build in the first place, so a server that has it
 * armed is a harness server — the one place the refusal reason may be spoken
 * aloud.
 */
export const CONFORMANCE_SEED_DIAGNOSTIC_ENV = "CINATRA_E2E_SETUP_BYPASS";

/**
 * The response headers a refusal carries. EMPTY for an admitted caller, and
 * empty on every build that did not arm the harness switch — fail closed, so
 * the outside contract (a bare 404, indistinguishable from a missing route)
 * is unchanged everywhere it matters.
 */
export function refusalDiagnosticHeaders(
  verdict: ConformanceSeedVerdict,
  env: SeedFenceEnv = process.env,
): Record<string, string> {
  if (verdict.ok) return {};
  if (env[CONFORMANCE_SEED_DIAGNOSTIC_ENV] !== "true") return {};
  return { [CONFORMANCE_SEED_REFUSAL_HEADER]: verdict.reason };
}

/**
 * All three fences, in order. Returns `{ ok: true }` only for a caller that
 * presented the armed capability from a chain that names no remote hop.
 */
export function conformanceSeedVerdict(
  request: { headers: { get(name: string): string | null } },
  env: SeedFenceEnv = process.env,
): ConformanceSeedVerdict {
  // FENCE 1 — the capability must be ARMED.
  const secret = env[CONFORMANCE_SEED_CAPABILITY_ENV];
  if (typeof secret !== "string" || secret.length < CONFORMANCE_SEED_CAPABILITY_MIN_LENGTH) {
    return {
      ok: false,
      status: 404,
      reason: `${CONFORMANCE_SEED_CAPABILITY_ENV} is not armed`,
    };
  }

  // FENCE 2 — the capability must be PRESENTED. Constant-time.
  const presented = presentedBearer(request.headers);
  if (presented.length === 0 || !secretEquals(presented, secret)) {
    return { ok: false, status: 404, reason: "capability-not-presented" };
  }

  // FENCE 3 — every advertised hop is on this machine.
  if (!forwardedChainIsLocal(request.headers)) {
    return { ok: false, status: 404, reason: "forwarded-from-off-host" };
  }

  return { ok: true };
}
