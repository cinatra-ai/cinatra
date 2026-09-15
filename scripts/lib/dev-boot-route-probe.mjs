// WHAT A JUST-BOOTED DEVELOPMENT RUNTIME'S ANSWER MEANS (cinatra#3194).
//
// `tests/e2e/chat-hitl-held-turn/route-readiness.ts` already holds this rule for
// the Playwright tier: a 404 counts as "this route is not prepared yet" only
// while it is the development runtime's own page-tree fall-back — an HTML
// not-found DOCUMENT, or a 404 that declares no media type at all — because a 404
// carrying the handler's own media type was produced BY the handler and therefore
// already proves the route compiled and ran.
//
// THIS MODULE IS THE SAME RULE FOR THE NODE TIER, and it exists because two
// consumers outside Playwright need it:
//
//   * `scripts/ci/dev-boot-route-gate.mjs` — the boot gate that stands in front of
//     the held-turn suite's development server and refuses to report the server
//     ready until the routes the flow depends on actually route;
//   * `scripts/ci/dev-boot-route-race-repro.mjs` — the constrained cold-boot loop
//     that measures how often a boot fails to register them at all.
//
// It is a SEPARATE FILE rather than an import of the Playwright module because
// that module is TypeScript compiled by Playwright/vitest and these two are plain
// node scripts a workflow runs directly. The duplication is therefore deliberate
// and it is PINNED: `scripts/__tests__/dev-boot-route-probe.test.mjs` imports both
// this module and `route-readiness.ts` and asserts they agree, answer for answer,
// so the two can never drift apart silently.
//
// NO IO, NO NETWORK, NO PROCESS WORK — the decisions live here so both consumers
// can be tested without booting anything.

/** The development runtime's "this route is not prepared yet" answer. */
export const ROUTE_NOT_COMPILED_STATUS = 404;

/**
 * What the runtime's OWN not-found answer is made of.
 *
 * A development runtime that cannot route a path resolves it in the page tree and
 * renders the application's not-found PAGE, so its 404 is a DOCUMENT. A route
 * handler's own 404 is whatever that handler serves — JSON here, and nothing in
 * this repository answers a 404 as HTML from a handler.
 */
export const RUNTIME_NOT_FOUND_MEDIA_TYPES = Object.freeze([
  "text/html",
  "application/xhtml+xml",
]);

/** The bare media type, lower-cased, without parameters — "" when undeclared. */
export function mediaTypeOf(contentType) {
  if (typeof contentType !== "string") return "";
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** True when this 404 is the runtime's own not-found DOCUMENT. */
export function isRuntimeNotFoundDocument(contentType) {
  return RUNTIME_NOT_FOUND_MEDIA_TYPES.includes(mediaTypeOf(contentType));
}

/**
 * True when a 404 was produced BY the handler — it declares a media type, and one
 * the runtime's not-found page never uses.
 *
 * AN UNDECLARED MEDIA TYPE IS NOT A HANDLER ANSWER: unknown may only ever fall to
 * the not-ready side, exactly as the Playwright tier decides it.
 */
export function handlerAnswered404(contentType) {
  const media = mediaTypeOf(contentType);
  return media !== "" && !RUNTIME_NOT_FOUND_MEDIA_TYPES.includes(media);
}

/** READY = the route answered something other than the runtime's own 404. */
export function routeAnswered(status, contentType) {
  if (status === null || status === undefined) return false;
  if (status !== ROUTE_NOT_COMPILED_STATUS) return true;
  return handlerAnswered404(contentType);
}

/**
 * THE BOUND, and why it is this number — the SAME 120 s the Playwright readiness
 * probe spends, quoted rather than re-derived (the pinning test asserts they are
 * one number).
 *
 * cinatra#3194 records why it may not be widened: in every observed red the
 * failing answers arrive in 110-400 ms and are the runtime's not-found document,
 * and the measured cold compile of the route off CI is 11.7-21.3 s. The route was
 * ABSENT for the whole boot, not slow, so a wider bound would not have turned one
 * red green and would hide the exact signal the bound exists to surface.
 */
export const ROUTE_READY_BOUND_MS = 120_000;

/** The back-off shape, also quoted from the Playwright tier. */
export const BOOT_WINDOW_BACKOFF_BASE_MS = 250;
export const BOOT_WINDOW_BACKOFF_CAP_MS = 4_000;

/** The delay before attempt `attempt + 1`, 0-based. */
export function bootWindowBackoffMs(
  attempt,
  { baseMs = BOOT_WINDOW_BACKOFF_BASE_MS, capMs = BOOT_WINDOW_BACKOFF_CAP_MS } = {},
) {
  const step = Math.max(0, Math.floor(attempt));
  return Math.min(capMs, baseMs * 2 ** step);
}

/**
 * ONE ANSWER, NAMED. Four outcomes rather than two, because the whole lesson of
 * cinatra#3056 and #3194 is that "404" is not one fact:
 *
 *   answered           the route compiled and ran — anything but the runtime's 404
 *   runtime-not-found  the runtime's own not-found DOCUMENT: NOT ROUTABLE
 *   unknown-404        a 404 declaring no media type — indistinguishable from the
 *                      above, so it is read as the same
 *   no-response        no answer at all (refused connection, socket hang-up)
 */
export function classifyBootAnswer({ status = null, contentType = null } = {}) {
  if (status === null || status === undefined) return "no-response";
  if (status !== ROUTE_NOT_COMPILED_STATUS) return "answered";
  if (isRuntimeNotFoundDocument(contentType)) return "runtime-not-found";
  if (handlerAnswered404(contentType)) return "answered";
  return "unknown-404";
}

/**
 * THE BOOT'S VERDICT, from what a whole bounded probe saw.
 *
 * `ready`     the route answered inside the bound — this boot is usable.
 * `unrouted`  the bound was spent and every answer was the runtime's own
 *             not-found document (or an unreadable 404): the failure #3194 is
 *             about. THIS is the verdict that earns a fresh boot.
 * `silent`    the bound was spent with no answer at all — the server is not
 *             serving. A different fault, reported as itself.
 */
export function bootVerdict({ answered, classifications = [] } = {}) {
  if (answered) return "ready";
  const sawAnyResponse = classifications.some((c) => c !== "no-response");
  return sawAnyResponse ? "unrouted" : "silent";
}

/**
 * MAY THIS BOOT BE REPLACED BY A FRESH ONE?
 *
 * ONLY the `unrouted` verdict, and only while a boot budget is left. A `silent`
 * verdict is not retried here: nothing answered, so a second boot would be
 * guessing at a fault that has not been diagnosed, and the honest report is the
 * one that names it. `ready` obviously never reboots.
 */
export function shouldRebootAfter(verdict, { bootIndex, maxBoots }) {
  if (verdict !== "unrouted") return false;
  return bootIndex + 1 < maxBoots;
}

/** The message a spent bound produces — NAMING THE ROUTE and what was seen. */
export function bootProbeFailure(route, boundMs, result) {
  const { attempts = 0, elapsedMs = 0, status = null, contentType = null, lastError = null } =
    result ?? {};
  const last =
    status === null
      ? `the route produced no response at all${lastError ? ` — last error: ${lastError}` : ""}`
      : `last status: ${status}` +
        (contentType ? `, served as ${contentType}` : ", with no media type declared");
  const diagnosis =
    status === null
      ? "The development runtime never answered this route at all"
      : isRuntimeNotFoundDocument(contentType)
        ? "Every answer was the development runtime's own not-found DOCUMENT — the page tree " +
          "rendered because no handler was routable at this path — so this route's handler never ran"
        : "The answers declared no media type, so they cannot be told apart from the development " +
          "runtime's own not-found page and are read as a route that was never prepared";
  return (
    `${route} never answered anything but ${ROUTE_NOT_COMPILED_STATUS} within its ${boundMs}ms ` +
    `readiness bound (${attempts} attempts over ${elapsedMs}ms; ${last}). ${diagnosis}.`
  );
}

/** `POST:/api/x` -> `{ method: "POST", path: "/api/x" }`; a bare path is a POST. */
export function parseRouteSpec(spec) {
  const text = String(spec ?? "").trim();
  const separator = text.indexOf(":");
  if (separator > 0 && !text.startsWith("/")) {
    const method = text.slice(0, separator).trim().toUpperCase();
    const path = text.slice(separator + 1).trim();
    if (!path.startsWith("/")) throw new Error(`route spec must name an absolute path: ${spec}`);
    return { method, path };
  }
  if (!text.startsWith("/")) throw new Error(`route spec must name an absolute path: ${spec}`);
  return { method: "POST", path: text };
}

/**
 * THE BOUNDED PROBE ITSELF — the same loop the Playwright tier runs, expressed
 * once for the node tier.
 *
 * Every collaborator is INJECTED (the request, the clock, the sleeper), so the
 * loop's schedule and its verdicts are asserted in the unit tier without a socket
 * anywhere. `request(remainingMs)` must resolve `{ status, contentType }` or
 * throw; a throw is recorded as `no-response` and retried, because before a route
 * has ever answered a refused connection genuinely is "not up yet".
 *
 * THE BOUND IS HANDED TO THE REQUEST, not merely checked after it: a call begun a
 * moment before the deadline would otherwise run for its own transport timeout on
 * top of the bound.
 */
export async function probeRouteUntilAnswered(
  request,
  {
    boundMs = ROUTE_READY_BOUND_MS,
    baseMs = BOOT_WINDOW_BACKOFF_BASE_MS,
    capMs = BOOT_WINDOW_BACKOFF_CAP_MS,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onAttempt,
  } = {},
) {
  const started = now();
  const deadline = started + boundMs;
  const classifications = [];
  let attempts = 0;
  let status = null;
  let contentType = null;
  let lastError = null;

  for (;;) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0 && attempts > 0) break;
    attempts += 1;
    try {
      const outcome = await request(Math.max(1, remainingMs));
      status = outcome?.status ?? null;
      contentType = outcome?.contentType ?? null;
      lastError = null;
    } catch (err) {
      status = null;
      contentType = null;
      lastError = err instanceof Error ? err.message : String(err);
    }
    const classification = classifyBootAnswer({ status, contentType });
    classifications.push(classification);
    onAttempt?.({ attempts, status, contentType, classification, lastError, elapsedMs: now() - started });
    if (classification === "answered") {
      return {
        answered: true,
        status,
        contentType,
        attempts,
        elapsedMs: now() - started,
        lastError,
        classifications,
        verdict: "ready",
      };
    }
    const delayMs = bootWindowBackoffMs(attempts - 1, { baseMs, capMs });
    if (now() + delayMs >= deadline) break;
    await sleep(delayMs);
  }

  const result = {
    answered: false,
    status,
    contentType,
    attempts,
    elapsedMs: now() - started,
    lastError,
    classifications,
  };
  return { ...result, verdict: bootVerdict({ answered: false, classifications }) };
}
