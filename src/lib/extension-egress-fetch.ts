import "server-only";

// THE EGRESS SCOPE FOR EXTENSION UI ACTIONS.
//
// An extension's named ui action runs IN PROCESS, inside the very server that
// serves the request, so it inherits that server's `globalThis.fetch` — not the
// platform's. Two properties of the server's fetch are wrong for extension
// egress, and one of them was measured wedging a real action forever:
//
//  1. THE RESPONSE IS NOT THE EXTENSION'S OWN. Next.js installs
//     `createDedupeFetch(fetch)` (next/dist/server/lib/dedupe-fetch) over the
//     global, which passes every dedupable GET response through `cloneResponse`
//     (next/dist/server/lib/clone-response): the body is `tee()`d and the
//     SIBLING branch is retained by the runtime. Cancelling one branch of a tee
//     settles only once BOTH branches are cancelled, so an AWAITED
//     `response.body.cancel()` — the standard way to release a body an
//     extension will never read, and what any hop-following fetch loop does on
//     every redirect — NEVER RETURNS. It is not slow; it does not time out; it
//     does not log. It stops, and the person is left with a button that does
//     nothing. Handing the extension's request a signal is that dedupe path's
//     own documented opt-out, so the response the extension gets back is the
//     real one and the release settles.
//
//  2. THE CALL IS UNBOUNDED. An extension's outbound request has no bound of
//     its own unless the extension author wrote one, so one unreachable
//     upstream can hold a person's click open with no answer at all.
//
// So every extension ui action runs inside this scope, and while it is on the
// stack an extension `fetch` that carries NO bound of its own is given one. The
// scope is an async-context value, never a per-call global mutation: concurrent
// requests do not see each other's scope, and code outside a ui action is
// untouched (the wrapper is a straight pass-through).
//
// This is a bound, not a cure for an unexplained hang: the mechanism above is
// measured and named, and the dispatch's own bound
// (`src/lib/extension-action-dispatch.ts`) still answers the person even when a
// handler wedges for a reason this scope cannot reach.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The bound an in-scope extension fetch inherits when it carries none. Chosen
 * BELOW the dispatch's own bound so a stuck upstream surfaces as the
 * extension's own error (which the connector can phrase for the person) rather
 * than as the dispatch's generic give-up.
 */
export const DEFAULT_EXTENSION_EGRESS_TIMEOUT_MS = 20_000;

type EgressScope = { timeoutMs: number };

const egressScope = new AsyncLocalStorage<EgressScope>();

/** Marks the wrapper this module installs, so installing twice is a no-op. */
const INSTALLED = Symbol.for("cinatra.extension-egress-fetch.installed");

type TaggedFetch = typeof fetch & { [INSTALLED]?: true };

/**
 * Install the egress wrapper over the CURRENT `globalThis.fetch`, idempotently.
 *
 * Called lazily from `withExtensionEgressScope` rather than at boot on purpose:
 * the server installs its own fetch patch the first time it renders or serves,
 * and a wrapper installed BEFORE that one would end up INSIDE it — where the
 * response has already been cloned and the injected bound no longer reaches the
 * dedupe path. Installing on first use puts this wrapper outermost, and the
 * re-check below re-wraps if the runtime ever patches over it again.
 */
export function installExtensionEgressFetch(): void {
  const current = globalThis.fetch as TaggedFetch | undefined;
  if (typeof current !== "function") return;
  if (current[INSTALLED]) return;
  const inner = current;
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const scope = egressScope.getStore();
    // Pass straight through outside a ui action and when the caller already
    // bound the call: this wrapper adds a bound where there is none, and never
    // overrides one somebody else chose.
    if (!scope || init?.signal) {
      return inner(input, init);
    }
    if (input instanceof Request) {
      // A Request-input call is the SAME wedge, not an exemption. The runtime's
      // dedupe opt-out reads `options.signal` only — it says so in its own
      // comment, because a Request "always gets initialized with its own signal
      // so we don't know if it's supposed to override". So `fetch(new
      // Request(url))` is still deduped, still teed, and an awaited body
      // release on it still never settles. The bound therefore has to arrive
      // through `init`, composed with the request's own signal so an abort the
      // caller wired up keeps working.
      //
      // Only for the dedupable class (GET/HEAD without a body): every other
      // Request the runtime hands straight to the original fetch, so it never
      // wedges, and re-initialising one that carries a stream body would need a
      // duplex declaration the caller never made.
      if ((input.method === "GET" || input.method === "HEAD") && !input.body) {
        return inner(input, {
          ...init,
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(scope.timeoutMs)]),
        });
      }
      return inner(input, init);
    }
    return inner(input, { ...init, signal: AbortSignal.timeout(scope.timeoutMs) });
  }) as TaggedFetch;
  Object.defineProperty(wrapped, INSTALLED, { value: true });
  globalThis.fetch = wrapped;
}

/**
 * Run an extension ui action's handler inside the egress scope.
 *
 * Returns the handler's own value or rejection untouched — this is a scope, not
 * a policy: it adds a bound to an unbounded call and nothing else.
 */
export async function withExtensionEgressScope<T>(
  run: () => T | Promise<T>,
  timeoutMs: number = DEFAULT_EXTENSION_EGRESS_TIMEOUT_MS,
): Promise<T> {
  installExtensionEgressFetch();
  return egressScope.run({ timeoutMs }, async () => run());
}
