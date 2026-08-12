// ---------------------------------------------------------------------------
// THE FENCE around the in-process lifecycle SEED path (cinatra#2683, epic #2564
// S8f — the two parity views that no out-of-process driver can produce).
// ---------------------------------------------------------------------------
//
// WHY A ROUTE EXISTS AT ALL. Two of the parity views need rows that only the
// shipped writers can produce: an `artifact_verification_records` row (minted at
// the END of the repair pipeline) and a CLOSED, restorable `change_set` with real
// member events (the undo chip's §VI gate reads both the set and its events).
// Every one of those writers is `server-only`, and past that `src/lib/auth.ts`
// carries a top-level `await` that tsx's CJS output rejects — so they load in the
// Next process and nowhere else. The alternatives were both refused earlier in
// this slice: a raw table write is not a proof that the writers work, and an
// event-less `change_set` row would have drawn the chip (`bool_and` over zero
// rows is not `false`) over the restore of nothing.
//
// A TEST-ONLY ROUTE ON AN APP IS A SECURITY SURFACE, so it is fenced FOUR times
// and each fence is independent — no single mis-set variable opens it:
//
//   1. RUNTIME MODE. `CINATRA_RUNTIME_MODE === "development"` AND
//      `NODE_ENV !== "production"`. An allow-list, not a deny-list: unset,
//      misspelled and production all refuse. The production check is separate
//      from the runtime-mode check on purpose — a deployment that mis-sets the
//      runtime mode is still walled by the build's own NODE_ENV.
//   2. THE SCRIPTED-PROVIDER GATE. The SAME
//      `assertScriptedProviderNotProduction` fence the deterministic LLM
//      provider uses, plus the requirement that the flag actually be ON. The
//      seed exists to stage the scripted UAT stack; a host that is not running
//      one has no business reaching it, and reusing the provider's own gate
//      means these two test-only surfaces can never disagree about what
//      "development" means.
//   3. A PRESENTED CAPABILITY. A high-entropy per-launch secret
//      (`CINATRA_LIFECYCLE_SEED_TOKEN`, >= 32 chars), presented as a bearer and
//      compared in constant time. UNSET MEANS THE ROUTE IS OFF — the default
//      state of every stack that did not deliberately arm it.
//   4. THE REQUEST SHAPE. `application/json` only, no cross-site `Origin` or
//      `Sec-Fetch-Site`, a loopback host, and no `x-forwarded-*`/`Forwarded`
//      chain at all.
//
// FENCE 3 IS THE LOad-BEARING ONE, AND FENCE 4 IS DEFENCE IN DEPTH — say why,
// because the natural reading is the other way round (codex round 0, findings 1
// and 2). `new URL(request.url).hostname` reflects the HTTP authority, i.e. the
// `Host` HEADER, not the socket's peer address: a dev server listening on a LAN
// or container interface answers `Host: localhost` from anywhere, with no
// forwarded chain to give it away. And the route is deliberately exempt from the
// sign-in redirect, so a hostile page in the operator's own browser could
// otherwise drive it cross-origin with a CORS-simple POST. The capability closes
// both — a remote caller does not have the secret, and a browser cannot attach an
// `Authorization` header to a simple request without a preflight this route
// answers for nobody. The host and forwarded checks stay because they are cheap
// and they narrow the blast radius if the secret ever leaks into a shell history.
//
// The route's own module keeps every writer behind a LAZY import taken only
// AFTER this fence answers `ok`, so a build that never runs a seed never
// evaluates the seeding graph at all.
//
// This module is deliberately dependency-light (the env fence + the request
// shape, nothing else) so the negative controls can drive it directly under a
// PRODUCTION-SHAPED environment without loading a single server module.
// ---------------------------------------------------------------------------

import { timingSafeEqual } from "node:crypto";

import {
  SCRIPTED_TEST_PROVIDER_ENV,
  SCRIPTED_TEST_PROVIDER_VALUE,
  assertScriptedProviderNotProduction,
  isScriptedTestProviderEnabled,
  // THE LEAF, never the barrel. `@cinatra-ai/llm/scripted-test-provider` is the
  // dependency-light module the runtime and the widget relay already import for
  // the same reason: the bare `@cinatra-ai/llm` entry drags the whole provider
  // graph behind a fence that must stay cheap enough to evaluate on every call.
} from "@cinatra-ai/llm/scripted-test-provider";

export type SeedFenceEnv = Record<string, string | undefined>;

export type SeedFenceVerdict =
  | { ok: true }
  | { ok: false; status: 403 | 404; reason: string };

/** The env var carrying the per-launch capability. UNSET = the route is OFF. */
export const SEED_CAPABILITY_ENV = "CINATRA_LIFECYCLE_SEED_TOKEN";

/** Minimum capability length. 32 characters of a `randomBytes` hex/base64url is
 *  the shortest thing worth calling high-entropy; a short one is refused rather
 *  than accepted weakly. */
export const SEED_CAPABILITY_MIN_LENGTH = 32;

/** The largest body the seed will read. Every fixture parameter is an id, so
 *  this is generous by an order of magnitude and still bounds the buffer a
 *  caller can make the process hold. */
export const SEED_MAX_BODY_BYTES = 4096;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * THE FORWARDED CHAIN MUST BE LOCAL — not absent.
 *
 * The first draft disqualified on PRESENCE, copying `/api/skills/reset-repo`.
 * Measured on the live stack, that refuses every request there is: Next's own dev
 * server synthesises `x-forwarded-for` / `-host` / `-proto` on the way into a
 * route handler, so the chain is always there and the header says nothing about a
 * proxy the operator installed. The check that was actually MEANT is "no hop from
 * off this machine", so that is what it now asks.
 *
 * IT IS A NARROWING SIGNAL, NEVER A PROOF, and the distinction matters because a
 * caller can also just send these headers. It is deliberately one-directional: a
 * chain that names a REMOTE hop refuses; a chain that names only loopback does
 * not thereby prove anything. The capability (fence 3) is the proof.
 */
function isLoopbackAddress(raw: string): boolean {
  let value = raw.trim().toLowerCase();
  if (value.length === 0) return false;
  // Strip RFC 7239 quoting and IPv6 brackets, and a trailing :port on either.
  value = value.replace(/^"|"$/g, "");
  if (value.startsWith("[")) {
    value = value.slice(1, value.indexOf("]") === -1 ? undefined : value.indexOf("]"));
  } else if ((value.match(/:/g)?.length ?? 0) === 1) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  return LOOPBACK_HOSTS.has(value);
}

/** True when every hop the request advertises is on this machine. An UNPARSEABLE
 *  or empty entry counts as remote — fail closed. */
export function forwardedChainIsLocal(headers: {
  get(name: string): string | null;
}): boolean {
  const xff = headers.get("x-forwarded-for");
  if (xff !== null) {
    const hops = xff.split(",").map((h) => h.trim());
    if (hops.length === 0 || !hops.every(isLoopbackAddress)) return false;
  }
  const xfh = headers.get("x-forwarded-host");
  if (xfh !== null && !isLoopbackAddress(xfh)) return false;
  const fwd = headers.get("forwarded");
  if (fwd !== null) {
    const fors = [...fwd.matchAll(/for=([^;,\s]+)/gi)].map((m) => m[1]);
    if (fors.length === 0 || !fors.every(isLoopbackAddress)) return false;
  }
  return true;
}

/** Constant-time compare of two secrets of possibly different length. */
function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length; compare fixed-width digests of equal size instead by padding to the
  // longer of the two and folding the length difference into the result.
  const width = Math.max(a.length, b.length);
  const pa = Buffer.alloc(width);
  const pb = Buffer.alloc(width);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

/**
 * FENCES 1 + 2 — the environment. Split out so a caller can refuse before it
 * looks at the request at all, and so the negative control can assert the
 * refusal without constructing one.
 *
 * `assertScriptedProviderNotProduction` THROWS on the one state it owns (the
 * scripted flag set outside an explicit development runtime); that throw is
 * converted here rather than propagated, because a fence that answers 404 and a
 * fence that 500s are the same refusal to a caller and only one of them is
 * quiet about which host it is.
 */
export function lifecycleSeedEnvVerdict(env: SeedFenceEnv): SeedFenceVerdict {
  // FENCE 1a — the build. Independent of every configuration variable below.
  if (env.NODE_ENV === "production") {
    return { ok: false, status: 404, reason: "production-build" };
  }
  // FENCE 1b — the runtime mode, as an explicit allow-list.
  if (env.CINATRA_RUNTIME_MODE !== "development") {
    return { ok: false, status: 404, reason: "not-development-runtime" };
  }
  // FENCE 2 — the scripted provider's OWN gate, called first for its throw and
  // then asserted positively: the seed serves a scripted UAT stack or nobody.
  try {
    assertScriptedProviderNotProduction(env);
  } catch {
    return { ok: false, status: 404, reason: "scripted-provider-gate-refused" };
  }
  if (!isScriptedTestProviderEnabled(env)) {
    return {
      ok: false,
      status: 404,
      reason: `${SCRIPTED_TEST_PROVIDER_ENV} is not ${SCRIPTED_TEST_PROVIDER_VALUE}`,
    };
  }
  // FENCE 3a — the capability must be ARMED. A stack that did not deliberately
  // set it has the route switched off, which is the default everywhere.
  const secret = env[SEED_CAPABILITY_ENV];
  if (typeof secret !== "string" || secret.length < SEED_CAPABILITY_MIN_LENGTH) {
    return { ok: false, status: 404, reason: `${SEED_CAPABILITY_ENV} is not armed` };
  }
  return { ok: true };
}

/**
 * FENCES 3b + 4 — the caller. The capability first (it is the real gate), then
 * the request shape.
 */
export function lifecycleSeedRequestVerdict(
  request: { url: string; headers: { get(name: string): string | null } },
  env: SeedFenceEnv = process.env,
): SeedFenceVerdict {
  // FENCE 3b — the presented capability.
  const secret = env[SEED_CAPABILITY_ENV];
  if (typeof secret !== "string" || secret.length < SEED_CAPABILITY_MIN_LENGTH) {
    return { ok: false, status: 404, reason: `${SEED_CAPABILITY_ENV} is not armed` };
  }
  const authorization = request.headers.get("authorization") ?? "";
  const presented = /^Bearer (.+)$/i.exec(authorization)?.[1] ?? "";
  if (presented.length === 0 || !secretEquals(presented, secret)) {
    return { ok: false, status: 403, reason: "capability-not-presented" };
  }

  // FENCE 4a — the content type. A CORS-simple POST can only carry
  // `text/plain`, `application/x-www-form-urlencoded` or `multipart/form-data`,
  // so requiring JSON forces a preflight that this route answers for nobody.
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return { ok: false, status: 403, reason: "non-json-content-type" };
  }

  // FENCE 4b — no cross-site caller. `Sec-Fetch-Site` is set by the browser and
  // cannot be forged from script; a non-browser caller sends neither header.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { ok: false, status: 403, reason: "cross-site-request" };
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return { ok: false, status: 403, reason: "unparseable-origin" };
    }
    if (!LOOPBACK_HOSTS.has(originHost)) {
      return { ok: false, status: 403, reason: "cross-origin-request" };
    }
  }

  // FENCE 4c — every advertised hop is on this machine.
  if (!forwardedChainIsLocal(request.headers)) {
    return { ok: false, status: 403, reason: "forwarded-from-off-host" };
  }

  // FENCE 4d — a loopback authority. Defence in depth: `Host` is caller-supplied,
  // so this narrows rather than proves (see the module header).
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname.toLowerCase();
  } catch {
    return { ok: false, status: 403, reason: "unparseable-request-url" };
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return { ok: false, status: 403, reason: "non-loopback-authority" };
  }

  return { ok: true };
}

/** All four fences, in order. The environment answers before the request is
 *  inspected, so a production host never reveals which caller shapes it would
 *  otherwise have accepted. */
export function lifecycleSeedVerdict(
  request: { url: string; headers: { get(name: string): string | null } },
  env: SeedFenceEnv = process.env,
): SeedFenceVerdict {
  const envVerdict = lifecycleSeedEnvVerdict(env);
  if (!envVerdict.ok) return envVerdict;
  return lifecycleSeedRequestVerdict(request, env);
}
