// Shared fetch-with-timeout helper for worker-path and connector-facing
// outbound HTTP.
//
// A hung remote must never pin a scarce BullMQ worker slot (or a Next.js
// request) indefinitely. This helper bounds every outbound request with an
// `AbortSignal.timeout(...)` so a stalled upstream fails fast instead of
// hanging forever. It formalizes the `AbortSignal.any([signal, timeout])`
// pattern already used elsewhere in the app (e.g. src/app/api/chat/runner.ts).
//
// Behavior is otherwise identical to the global `fetch`: it returns the raw
// `Response` and callers read the body exactly as before. The added behavior is
// the bounded wait. Because the timeout signal stays attached to the returned
// `Response`, it also bounds a slow-trickle body read (`.text()`/`.json()`),
// not just the connect/headers phase. A request that exceeds `timeoutMs`
// rejects with a typed `FetchTimeoutError` (an `Error`, so existing
// `catch`/backoff logic keeps working) when the timeout fires before the
// `Response` resolves; a timeout that fires DURING a later body read surfaces
// as the runtime's abort error at the read call site (callers that map fetch
// errors should read the body inside the same error-handling scope). A
// caller-supplied `signal` is preserved and composed with the timeout:
// aborting it propagates unchanged (never re-mapped to a timeout error).

/**
 * Default outbound-request ceiling. Generous enough for a publish/upload
 * against a slow-but-healthy remote, bounded enough to never pin a worker
 * indefinitely. Individual call sites may pass a larger bound where a longer
 * legitimate wait is expected (e.g. proxying an external MCP tool call).
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Raised when the helper's own timeout fires before the response resolves. A
 * caller-supplied abort is NOT mapped to this — it propagates as the original
 * abort error.
 */
export class FetchTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`, options);
    this.name = "FetchTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export interface FetchWithTimeoutOptions {
  /** Abort the request after this many ms. Defaults to DEFAULT_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

function describeRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// An aborted fetch rejects with a DOMException named "AbortError"
// (AbortController) or "TimeoutError" (AbortSignal.timeout). Match on the name
// so the check survives realms that don't share the DOMException class identity.
function isAbortLike(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  if (typeof err === "object" && err !== null && "name" in err) {
    const name = (err as { name?: unknown }).name;
    return name === "AbortError" || name === "TimeoutError";
  }
  return false;
}

// `fetch` rejects with the aborting signal's `reason` (by reference), and
// `AbortSignal.any` adopts the reason of whichever source signal aborted first
// — so object identity tells us which bound fired, with no dependence on the
// order the two signals settle in. A caller-supplied abort carries the caller's
// reason and must propagate unchanged.
function isTimeoutAbort(
  err: unknown,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): boolean {
  if (err === timeoutSignal.reason) return true;
  if (callerSignal && err === callerSignal.reason) return false;
  // Fallback for runtimes that reject with a fresh abort error rather than the
  // reason object: our timeout fired and the caller's signal did not.
  return timeoutSignal.aborted && !callerSignal?.aborted && isAbortLike(err);
}

/**
 * `fetch` with a bounded wait. Drop-in replacement for the global `fetch`
 * across worker paths and outbound API clients.
 *
 * @param input - request target, same as `fetch`.
 * @param init - request init, same as `fetch`. Any `init.signal` is preserved
 *   and composed with the timeout. (A `signal` embedded in a `Request` object
 *   passed as `input` is not extracted — supply it via `init.signal`.)
 * @param options - `timeoutMs` override; defaults to DEFAULT_FETCH_TIMEOUT_MS.
 * @throws {FetchTimeoutError} when the request exceeds `timeoutMs` before the
 *   response resolves.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = init.signal ?? undefined;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  try {
    return await fetch(input, { ...init, signal });
  } catch (err) {
    // Map ONLY our own timeout-driven abort to a typed error. A caller-supplied
    // abort (or a genuine network error) propagates unchanged so existing
    // catch/backoff semantics are preserved.
    if (isTimeoutAbort(err, timeoutSignal, callerSignal)) {
      throw new FetchTimeoutError(describeRequestUrl(input), timeoutMs, {
        cause: err,
      });
    }
    throw err;
  }
}
