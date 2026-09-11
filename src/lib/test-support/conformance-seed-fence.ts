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
