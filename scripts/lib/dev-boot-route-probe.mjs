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
 * THIS BOUND IS NOT WIDENED, AND THE `unrouted` VERDICT STILL FALLS AT IT.
 * cinatra#3194 records why: in every red it observed, the failing answers arrive
 * in 110-400 ms and are the runtime's not-found document, and the measured cold
 * compile of the route off CI is 11.7-21.3 s. The route was ABSENT for the whole
 * boot, not slow, so a wider bound would not have turned one of those reds green
 * and would hide the exact signal the bound exists to surface. Nothing below
 * changes that: a boot whose probed route is never announced as compiling spends
 * exactly this bound, reaches exactly the `unrouted` verdict, and is replaced.
 *
 * WHAT cinatra#3553 ADDS IS NOT A WIDER BOUND — it is a BOUNDED EXTENSION that
 * only a route the runtime itself announced it is compiling can draw, and only
 * once. The readings that separate the two cases come from one job's own logs:
 * on a green boot the probed capabilities route announced its compile and
 * answered `401 in 37.6s` on the first attempt; on the red boot the same route
 * announced its compile and its first request was ended at exactly 60.0 s by the
 * caller's transport cap, after which that path served the not-found document
 * for the rest of the process; and in the #3194-shaped reds the probed route was
 * NEVER announced at all — the only announcements were `instrumentation Node.js`
 * and `/_not-found/page`, the page tree rendering because nothing was routable
 * there. An announcement for the probed path is therefore evidence the route
 * exists; its absence is the #3194 signature, and it buys nothing.
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

/** The escape sequences a colour-capable log wraps the runtime's glyph in. */
const ANSI_ESCAPE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * THE ONE DECORATION A RUNTIME LINE MAY CARRY BEFORE ITS FIRST WORD: a single
 * status glyph followed by whitespace, from the small set the runtime actually
 * prints. It is a CLOSED set on purpose — stripping "anything that is not a
 * letter" would swallow a quote, a bracket or a timestamp and let an ordinary
 * diagnostic that merely mentions a compile be read as an announcement.
 */
const LEADING_GLYPH = /^[\u25a0-\u25ff\u2713\u2714\u2717\u26a0\u25b2\u2022\u00b7]\s+/;

/**
 * THE PATH A `Compiling ... ` LINE ANNOUNCES, or null (cinatra#3553).
 *
 * The development runtime prints one of these the moment it begins compiling a
 * path, on the same stdout the boot gate already forwards to the job log, so the
 * evidence that a route EXISTS is available before that route has answered
 * anything. This reads the path back out of the line and nothing else:
 *
 *   `\u25cb Compiling /api/assistants/chat/capabilities ...` -> the path
 *   `Compiling /_not-found/page ...`                  -> the path (a DIFFERENT
 *                                                       path, which is exactly
 *                                                       why the caller compares)
 *   `\u25cb Compiling instrumentation Node.js ...`         -> null: it names no route
 *
 * A leading glyph and the escapes around it are tolerated because both shapes
 * appear in the recorded logs. Anything that is not a compile announcement of an
 * ABSOLUTE path is null, so nothing else in the runtime's output can ever be
 * read as one.
 */
export function parseRuntimeCompileAnnouncement(line) {
  if (typeof line !== "string") return null;
  const plain = line.replace(ANSI_ESCAPE, "").trim().replace(LEADING_GLYPH, "");
  // THE WHOLE LINE MUST BE THE ANNOUNCEMENT, terminator included: a line that
  // merely CONTAINS `Compiling /api/...` — a quoted message, or a sentence that
  // goes on to say something else about the path — is not the runtime announcing
  // a compile, and must not buy a boot the extension (cinatra#3553).
  const match = /^Compiling\s+(\/\S*?)\s*(?:\.\.\.|\u2026)?$/.exec(plain);
  if (!match) return null;
  const path = match[1];
  return path.length > 1 || path === "/" ? path : null;
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
 * top of the bound — and a caller that narrows it further is imposing a second,
 * undeclared bound (cinatra#3553 removed exactly that from the boot gate).
 *
 * THE ONE EXTENSION, AND WHAT MAY DRAW IT (cinatra#3553). `compileAnnounced()` is
 * a predicate over what the runtime has announced it is compiling FOR THIS
 * ROUTE'S OWN PATH. When the bound is spent, the route has not answered, and that
 * predicate is true, the loop draws `extensionMs` ONCE and keeps probing; it can
 * never draw a second one, so a compile that is announced and never finishes
 * still ends at `boundMs + extensionMs` with today's verdict rather than hanging
 * the boot. `extensionMs` defaults to 0, which is this loop exactly as it was —
 * so a caller that asks for nothing gets the pre-#3553 behaviour byte for byte,
 * and a boot whose probed path was never announced gets it too.
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
    compileAnnounced = () => false,
    extensionMs = 0,
  } = {},
) {
  const started = now();
  let deadline = started + boundMs;
  let compileExtensionMs = 0;
  /** Draw the one extension, if one is on offer and this route has earned it. */
  const drawCompileExtension = () => {
    if (compileExtensionMs > 0 || !(extensionMs > 0) || !compileAnnounced()) return false;
    compileExtensionMs = extensionMs;
    deadline += extensionMs;
    return true;
  };
  const classifications = [];
  let attempts = 0;
  let status = null;
  let contentType = null;
  let lastError = null;

  for (;;) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0 && attempts > 0) {
      if (drawCompileExtension()) continue;
      break;
    }
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
        compileExtensionMs,
        verdict: "ready",
      };
    }
    const delayMs = bootWindowBackoffMs(attempts - 1, { baseMs, capMs });
    if (now() + delayMs >= deadline && !drawCompileExtension()) break;
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
    compileExtensionMs,
  };
  return { ...result, verdict: bootVerdict({ answered: false, classifications }) };
}
