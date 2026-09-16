// THE BOOT-WINDOW ROUTE RULES (chat-hitl S9k, cinatra#3056).
//
// The flow boots its own development server and starts driving it the moment the
// server answers. `/api/health` answering is NOT the same claim as "the route this
// flow is about to call is prepared": the development runtime compiles a route on
// its FIRST hit, and until that compile finishes the route answers **404**. Two
// runs died of exactly that — a `POST /api/auth/sign-up/email` answered 404 while
// the same request took 41 s server-side once it did compile, and a chat stream
// handshake answered 404 about two minutes after boot, after which the card probe
// waited out its whole fifteen-minute budget for a card that could no longer come.
//
// So this module holds the three decisions that turn that class of failure into a
// bounded wait and a legible message, and it holds them WHERE THEY CAN BE TESTED:
//
//   * `routeAnswered` — WHAT COUNTS AS READY. THE RULE: a 404 counts as "not
//     ready" only while it is the development runtime's own page-tree fall-back —
//     an HTML not-found DOCUMENT, or a 404 that declares no media type at all —
//     because a 404 carrying the handler's own media type was produced BY the
//     handler and therefore already proves the route compiled and ran. Every other
//     status is ready as before. A status and one response HEADER are read, never a
//     body, and the probe request is one the route rejects WITHOUT SIDE EFFECTS —
//     so readiness never creates the state the flow is about to assert on.
//
//     THE RUN THAT FORCED THE HEADER (run 33244751481, job "Chat-HITL held-turn
//     dev-runtime e2e"): the capabilities probe read 404 fourteen times over
//     117 016 ms and the bound failed the job. Every one of those fourteen carried
//     `content-type: text/html; charset=utf-8` and a ~205 KB body that was the
//     application's own not-found page — the path was resolved in the PAGE tree and
//     the handler never ran, which is why the first hit spent 3.7 s in application
//     code rendering that page instead of the 40 ms the handler takes. The same
//     probe read 401 on its first attempt seventeen minutes earlier (run
//     33244071398) and 200 on the trunk (run 33245807460), so the compiled handler
//     cannot answer 404 to this shape at all. Reading the status alone, those two
//     404s are one fact; reading the media type, they are the two different facts
//     they always were.
//   * `retryWhileRouteMissing` — the bounded back-off. Only a 404 (and a request
//     that produced no response at all) is retried; EVERY OTHER STATUS IS RETURNED
//     UNTOUCHED, so each call site keeps its own handling of every real answer.
//   * `handshakeFailureFrom` — the fail-fast predicate. A failed stream handshake
//     is logged to the browser CONSOLE and never reaches the transcript, so the
//     card probe cannot see it and can only report a timeout. Given the console
//     lines it says, in the failure's own words, that no turn was ever dispatched.
//
// NO DATABASE, NO `server-only`, NO PLAYWRIGHT IMPORT — deliberately, and for the
// same reason `state-rules.ts` has none: these arms run in the ordinary node unit
// tier (`tests/e2e/chat-hitl-held-turn/__tests__/**` is in the root vitest
// include), and `probes.ts` cannot be imported there because it opens Postgres and
// Redis and refuses a missing variable at MODULE LOAD.

/** The development runtime's "this route is not prepared yet" answer. */
export const ROUTE_NOT_COMPILED_STATUS = 404;

/**
 * What the runtime's OWN not-found answer is made of.
 *
 * A development runtime that cannot route a path resolves it in the page tree and
 * renders the application's not-found PAGE, so its 404 is a DOCUMENT. A route
 * handler's own 404 is whatever that handler serves — JSON here, and nothing in
 * this repository answers a 404 as HTML from a handler. So the media type is the
 * one cheap, header-only discriminant between "not routable" and "answered".
 */
const RUNTIME_NOT_FOUND_MEDIA_TYPES: readonly string[] = ["text/html", "application/xhtml+xml"];

/** The bare media type, lower-cased, without parameters — "" when undeclared. */
function mediaTypeOf(contentType: string | null | undefined): string {
  if (typeof contentType !== "string") return "";
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** True when this 404 is the runtime's own not-found DOCUMENT. */
export function isRuntimeNotFoundDocument(contentType: string | null | undefined): boolean {
  return RUNTIME_NOT_FOUND_MEDIA_TYPES.includes(mediaTypeOf(contentType));
}

/**
 * True when a 404 was produced BY the handler — it declares a media type, and one
 * the runtime's not-found page never uses.
 *
 * AN UNDECLARED MEDIA TYPE IS NOT A HANDLER ANSWER. Every existing caller passes
 * no media type at all, and each must keep meaning exactly what it meant before:
 * not ready. Unknown may only ever fall to the retrying side.
 */
export function handlerAnswered404(contentType: string | null | undefined): boolean {
  const media = mediaTypeOf(contentType);
  return media !== "" && !RUNTIME_NOT_FOUND_MEDIA_TYPES.includes(media);
}

/**
 * THE BOUND, and why it is this number.
 *
 * The measured cold compile of the sign-up route on a contended runner was 41 s
 * (35.1 s of it Turbopack). 120 s is the issue's own example and roughly three
 * times the worst compile actually seen, which is the point: long enough that a
 * slow-but-working boot is waited out rather than failed, short enough that a
 * route which is genuinely absent is reported in two minutes instead of consuming
 * the job's twenty-minute budget. It is deliberately far below the sibling
 * `/api/mcp` warm deadline (180 s), which measures something harder — a LATENCY
 * budget, not mere existence.
 */
export const ROUTE_READY_BOUND_MS = 120_000;

/**
 * The bound for a 404 retried IN FLIGHT (a call the flow was making anyway, after
 * the readiness probe has already passed). Shorter on purpose: readiness has
 * already been established once, so a 404 here is a straggler, not a cold boot —
 * and a call site that keeps retrying for two more minutes buys nothing the probe
 * did not already buy.
 */
export const BOOT_WINDOW_RETRY_BOUND_MS = 60_000;

/**
 * THE BACK-OFF SHAPE: exponential from 250 ms, doubling, capped at 4 s.
 *
 * Doubling because the first 404s are the likeliest to clear immediately (a route
 * mid-compile answers within a second or two once it lands) and a fixed 1 s poll
 * would spend the whole first second not asking. Capped because past a few seconds
 * the extra patience is free and the extra requests are not — each probe request
 * competes with the very compile it is waiting for, on the same constrained
 * runner. Deterministic, with no jitter: one client is polling one server here, so
 * jitter would buy nothing and would cost the ability to assert the schedule.
 */
export const BOOT_WINDOW_BACKOFF_BASE_MS = 250;
export const BOOT_WINDOW_BACKOFF_CAP_MS = 4_000;

/**
 * READY = the route answered something other than 404.
 *
 * `null` — no response at all (connection refused, a socket hang-up) — is NOT
 * ready, for the reason the `/api/mcp` warm-up already states at its own call
 * site: a request that fails instantly also "returns quickly", and grading that as
 * ready turns the whole measurement into "it failed fast".
 */
export function routeAnswered(status: number | null, contentType?: string | null): boolean {
  if (status === null) return false;
  if (status !== ROUTE_NOT_COMPILED_STATUS) return true;
  // A 404 the handler itself produced is an ANSWER: the route compiled and ran,
  // which is the whole of what readiness asks. Only the runtime's own not-found
  // document — and an undeclared media type, which cannot be told apart from one —
  // still means "not yet".
  return handlerAnswered404(contentType);
}

/** The delay before attempt `attempt + 1`, 0-based. */
export function bootWindowBackoffMs(
  attempt: number,
  {
    baseMs = BOOT_WINDOW_BACKOFF_BASE_MS,
    capMs = BOOT_WINDOW_BACKOFF_CAP_MS,
  }: { baseMs?: number; capMs?: number } = {},
): number {
  const step = Math.max(0, Math.floor(attempt));
  // `2 ** step` overflows into Infinity long before the bound could allow that
  // many attempts; `Math.min` with the cap makes that harmless rather than clever.
  return Math.min(capMs, baseMs * 2 ** step);
}

/**
 * THE BOOT WINDOW ITSELF, as a clock rather than as a per-request allowance.
 *
 * A retry loop that starts a FRESH bound on every call is not a boot window: the
 * second turn of a fifteen-minute flow would get the same patience as the first,
 * and a genuine late 404 — the very fault item 3 exists to report — would be
 * delayed by the whole bound before it was reported. So an interceptor installed
 * once measures from ITS INSTALL, and past the window a 404 is served straight
 * through to the caller, unretried, exactly as it was before this change.
 */
export function bootWindowRemainingMs(
  installedAtMs: number,
  nowMs: number,
  windowMs: number = BOOT_WINDOW_RETRY_BOUND_MS,
): number {
  return Math.max(0, installedAtMs + windowMs - nowMs);
}

/** One attempt's outcome: the status the route produced, plus whatever the caller
 *  wants carried out of the successful attempt (a response object, typically). */
export interface RouteAttempt<T> {
  status: number | null;
  /**
   * The `content-type` the answer declared, when the call site can read one.
   * OPTIONAL, and its absence is read as "unknown" rather than as "handler" — a
   * call site that does not pass it keeps precisely the behaviour it had.
   */
  contentType?: string | null;
  value?: T;
}

export interface BootWindowOptions {
  /** The whole bound, measured from the first attempt. */
  timeoutMs?: number;
  /**
   * Whether a THROWN attempt (no response at all — connection refused, a socket
   * hang-up) is retried as a not-yet.
   *
   * FALSE BY DEFAULT, and that default is the acceptance item's own wording: "any
   * other status keeps its current handling". A transport fault is not a 404, and
   * a call site that used to fail instantly on a dead socket must keep failing
   * instantly. Only the READINESS PROBE turns this on, because before the first
   * successful request a refused connection genuinely is "not up yet".
   */
  retryOnError?: boolean;
  baseMs?: number;
  capMs?: number;
  /** Injected clock + sleeper — the seam the unit tier drives. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, so a call site can print what it is waiting on. */
  onRetry?: (info: {
    attempts: number;
    status: number | null;
    contentType: string | null;
    delayMs: number;
    lastError: string | null;
  }) => void;
}

export interface BootWindowResult<T> {
  /** True when the route ANSWERED within the bound — see `routeAnswered`. */
  answered: boolean;
  status: number | null;
  /** The last answer's declared media type, when the call site read one. */
  contentType?: string | null;
  value?: T;
  attempts: number;
  elapsedMs: number;
  lastError: string | null;
}

/**
 * Call `attempt` until the route answers something other than 404, or the bound
 * is spent. Returns the LAST outcome either way — this function never throws on a
 * status, because deciding what a status means belongs to the call site.
 *
 * A thrown attempt is RE-THROWN unless `retryOnError` is set: a transport fault is
 * not a 404, and every call site's existing handling of one must survive.
 */
export async function retryWhileRouteMissing<T>(
  attempt: (attemptIndex: number, remainingMs: number) => Promise<RouteAttempt<T>>,
  options: BootWindowOptions = {},
): Promise<BootWindowResult<T>> {
  const timeoutMs = options.timeoutMs ?? BOOT_WINDOW_RETRY_BOUND_MS;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const deadline = started + timeoutMs;

  let attempts = 0;
  let status: number | null = null;
  let contentType: string | null = null;
  let value: T | undefined;
  let lastError: string | null = null;

  for (;;) {
    // THE BOUND IS HANDED TO THE ATTEMPT, not merely checked after it. Checking a
    // deadline only once the request has returned bounds the loop and not the wait:
    // a call begun a moment before the deadline can run for its own transport
    // timeout on top. So each attempt is told how much of the bound is left and is
    // expected to cap its own request with it — and an attempt with nothing left to
    // spend is not started at all, because it could only overrun.
    const remainingMs = deadline - now();
    if (remainingMs <= 0 && attempts > 0) break;
    attempts += 1;
    try {
      const outcome = await attempt(attempts - 1, Math.max(1, remainingMs));
      status = outcome.status;
      contentType = outcome.contentType ?? null;
      value = outcome.value;
      lastError = null;
    } catch (err) {
      if (options.retryOnError !== true) throw err;
      status = null;
      contentType = null;
      value = undefined;
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (routeAnswered(status, contentType)) {
      return {
        answered: true,
        status,
        contentType,
        value,
        attempts,
        elapsedMs: now() - started,
        lastError,
      };
    }
    const delayMs = bootWindowBackoffMs(attempts - 1, {
      baseMs: options.baseMs,
      capMs: options.capMs,
    });
    // The NEXT attempt has to fit inside the bound to be worth making; a wait that
    // ends after the deadline would only delay the same report.
    if (now() + delayMs >= deadline) break;
    options.onRetry?.({ attempts, status, contentType, delayMs, lastError });
    await sleep(delayMs);
  }

  return {
    answered: false,
    status,
    contentType,
    value,
    attempts,
    elapsedMs: now() - started,
    lastError,
  };
}

/** The message a spent bound produces — NAMING THE ROUTE, which is the whole
 *  difference between this failure and the four-word timeout it replaces. */
export function routeReadinessFailure<T>(
  route: string,
  timeoutMs: number,
  result: BootWindowResult<T>,
): string {
  const last =
    result.status === null
      ? `the route produced no response at all${result.lastError ? ` — last error: ${result.lastError}` : ""}`
      : `last status: ${result.status}` +
        (result.contentType ? `, served as ${result.contentType}` : ", with no media type declared");
  // WHAT THE PROBE ACTUALLY SAW, rather than one assertion covering both cases.
  // "The runtime had not prepared this route" is TRUE of the not-found document
  // and unproven of a 404 whose media type was never read, and the difference is
  // the whole distance between a diagnosis and a guess.
  const diagnosis =
    result.status === null
      ? "The development runtime never answered this route at all"
      : isRuntimeNotFoundDocument(result.contentType)
        ? "Every answer was the development runtime's own not-found DOCUMENT — the page tree " +
          "rendered because no handler was routable at this path — so this route's handler never ran"
        : "The answers declared no media type, so they cannot be told apart from the development " +
          "runtime's own not-found page and are read as a route that was never prepared";
  return (
    `${route} never answered anything but ${ROUTE_NOT_COMPILED_STATUS} within its ${timeoutMs}ms ` +
    `readiness bound (${result.attempts} attempts over ${result.elapsedMs}ms; ${last}). ` +
    `${diagnosis}, so every request the flow makes against it would fail for a reason that has ` +
    "nothing to do with what the flow is testing."
  );
}

/**
 * The readiness probe: the same bounded loop, but a spent bound is a FAILURE that
 * names the route. Use it before the first real request; use
 * `retryWhileRouteMissing` for a real request whose own handling must survive.
 */
export async function waitForRouteReady<T>(
  route: string,
  attempt: (attemptIndex: number, remainingMs: number) => Promise<RouteAttempt<T>>,
  options: BootWindowOptions = {},
): Promise<BootWindowResult<T>> {
  const timeoutMs = options.timeoutMs ?? ROUTE_READY_BOUND_MS;
  const result = await retryWhileRouteMissing(attempt, {
    retryOnError: true,
    ...options,
    timeoutMs,
  });
  if (!result.answered) throw new Error(routeReadinessFailure(route, timeoutMs, result));
  return result;
}

/**
 * THE HANDSHAKE FAILURE, AS THE BROWSER REPORTS IT.
 *
 * `ensureAssistantChatWireNegotiated` fails CLOSED and reports through
 * `console.error` — there is no legacy wire to fall back to, and nothing about the
 * failure reaches the transcript. So the transcript-reading card probe is blind to
 * it and can only ever report "no card in 900 000 ms", which is true, useless and
 * points at the card.
 */
export const HANDSHAKE_FAILURE_MARKERS = [
  // The request itself failed — this is the 404 signature from the failing run.
  "[chat] AG-UI stream handshake request failed",
  // The request succeeded and the negotiation was refused; equally terminal.
  "[chat] AG-UI stream handshake failed (fail-closed)",
] as const;

/** The first console line that reports a failed handshake, trimmed — or `null`. */
export function handshakeFailureFrom(lines: readonly string[]): string | null {
  for (const line of lines) {
    for (const marker of HANDSHAKE_FAILURE_MARKERS) {
      if (line.includes(marker)) return line.trim();
    }
  }
  return null;
}
