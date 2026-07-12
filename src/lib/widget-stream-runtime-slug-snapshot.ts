/**
 * Widget-stream runtime-slug snapshot (widget-stream runtime trust, slice 4 —
 * design surface 3: the guard's public-path liveness layer).
 *
 * WHAT THIS IS. The sign-in wall (`guardAppRoute` in `auth-route-guard.ts`,
 * invoked by `src/proxy.ts`) decides, per request, whether a path SKIPS the
 * unauthenticated → /sign-in redirect. For widget-stream routes it already
 * unions a BUILD-TIME exact-slug set (`GENERATED_WIDGET_STREAM_PUBLIC_PATHS`).
 * A widget-stream connector approved at RUNTIME (an admin approves its metadata
 * grant after build) has a slug that the build-time set does not know, so its
 * `/api/agents/<slug>/{stream,token,capabilities}` routes would be 307'd to
 * /sign-in before their own in-handler auth runs. This module maintains a
 * per-replica, in-memory snapshot of the APPROVED runtime slugs' exact paths
 * that the guard unions in, so those routes reach their handlers.
 *
 * PURE LIVENESS — NOT AN AUTHORIZATION BOUNDARY. The snapshot only ever decides
 * "redirect vs reach-the-handler". Each widget route self-authenticates in its
 * handler (stream: CORS + Bearer; token: server-to-server key; capabilities:
 * auth-free static contract), and the REAL wall is the fail-closed in-handler
 * runtime resolver (slice 2), which re-asserts approval, the on-disk canon
 * re-hash, trust classification, and the credential-store-owner conjunction at
 * every point of use. This module NEVER performs a DB read on the request path;
 * the membership test is a synchronous EXACT-match against an in-memory Set that
 * a background refresher swaps out-of-band.
 *
 * THE FAIL-CLOSED FLOOR (asymmetric, encoded in the tests). A missing / cold /
 * stale snapshot must never OPEN a route — the only tolerated failure direction
 * is a legitimate widget route briefly redirecting to /sign-in until the next
 * refresh (a self-healing liveness blip, no security loss). Concretely:
 *   - the snapshot only ever ADDS the three exact paths of a validated,
 *     runtime-approved slug — it can never make a non-widget protected route
 *     public, and it defers to the build-time set absolutely (a slug that
 *     collides with a build-time widget is dropped from the runtime set);
 *   - an empty / cold snapshot → a runtime-approved widget request 307s until
 *     the first successful refresh (safe);
 *   - a stale-INCLUSIVE snapshot (a just-revoked slug still present) → the
 *     request reaches the handler, which 404s because the resolver arm already
 *     dropped the grant (safe — the snapshot is not the authz boundary);
 *   - a refresher FAILURE → the last good snapshot is kept FROZEN (never
 *     cleared, never widened) so a transient DB blip cannot flap legit routes
 *     to /sign-in, and can certainly never open anything.
 *
 * REVOCATION LINEARIZATION. The SECURITY linearization point of a revocation is
 * the in-handler resolver (slice 2): the instant the grant flips to `revoked`
 * the handler fails closed (404), regardless of this snapshot. Removal of the
 * slug from THIS snapshot is best-effort liveness hygiene, bounded above by the
 * refresher cadence (and expedited by `signalWidgetStreamRuntimeSlugRefresh()`
 * on approve/revoke). Between a revocation and the next successful refresh the
 * slug's paths merely stay redirect-skipped; the handler still 404s.
 *
 * WHY A PER-REPLICA IN-MEMORY SNAPSHOT IS VALID HERE. In Next.js 16 the proxy
 * (`src/proxy.ts`) always runs on the Node.js runtime — a `runtime` override is
 * a build error (E1031, "Proxy always runs on Node.js runtime"). So the guard
 * executes in the same Node process as `instrumentation.node` boot, and the
 * state below — anchored on `globalThis` so it is shared even if the proxy and
 * the boot code are emitted as separate chunks — is visible to both. Each
 * replica refreshes independently; the design requires no cross-replica
 * coherence precisely because the snapshot is pure liveness.
 */

// Exact-slug shape (defense in depth — the record-time canon validator already
// enforces this; a malformed slug reaching the enumerator is dropped rather than
// turned into a path, so it simply keeps redirecting).
const WIDGET_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// STRUCTURAL read-path floor. The ONLY path shapes the runtime union may ever
// answer `true` for: the three exact widget verbs under an exact kebab slug.
// The request-path reader gates on this BEFORE consulting the in-memory set, so
// that even a poisoned / malformed / mis-populated snapshot can structurally
// never make a non-widget protected route public — the fail-closed floor holds
// regardless of the set's contents, not merely because install-time filters it.
const WIDGET_PUBLIC_PATH_RE =
  /^\/api\/agents\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:stream|token|capabilities)$/;

// 32-bit signed max. `setInterval` coerces any delay above this to ~1ms (a hot
// loop), so the refresher clamps its cadence to this ceiling as a hard backstop.
const MAX_SAFE_INTERVAL_MS = 2_147_483_647;
// Module-level fallback cadence for a non-finite / non-positive intervalMs
// passed DIRECTLY to the starter (bypassing the boot parser). Chosen so garbage
// input can neither hammer the DB (a ~1ms `setInterval(NaN)` hot loop) nor make
// the refresher inert.
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

/**
 * Clamp an interval to a safe range for the real `setInterval`. A non-finite or
 * non-positive value falls back to the module default (NEVER passed raw to
 * `setInterval`, which treats `NaN` / `Infinity` as ~1ms); a finite value is
 * floored at 1ms and capped at the 32-bit ceiling.
 */
function clampRefreshIntervalMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_REFRESH_INTERVAL_MS;
  return Math.min(Math.max(1, Math.floor(ms)), MAX_SAFE_INTERVAL_MS);
}

/**
 * The enumeration seam. Returns the set of currently-APPROVED runtime
 * widget-stream agent slugs. Injected so the refresher is fully unit-testable
 * without a DB, and so the production wiring can swap its narrow local
 * enumerator for slice-2's `listApprovedWidgetStreamMetadataGrants` in one line.
 */
export type ApprovedWidgetStreamSlugEnumerator = () => Promise<readonly string[]>;

export type WidgetStreamRuntimeSlugSnapshotState = {
  /** The exact redirect-skip paths (three per approved runtime slug). */
  paths: ReadonlySet<string>;
  /** The approved runtime slugs currently reflected in `paths`. */
  slugs: ReadonlySet<string>;
  /** Monotonic counter — bumped on every successful install (observability). */
  generation: number;
  /** `Date.now()` of the last SUCCESSFUL refresh, or null if never. */
  lastRefreshOkAt: number | null;
  /** The last refresh error message, or null after a success. */
  lastError: string | null;
};

type SnapshotInternals = WidgetStreamRuntimeSlugSnapshotState & {
  /** Single-flight guard: the in-flight refresh, coalesced. */
  inFlight: Promise<RefreshResult> | null;
  /** The running refresher, if started (idempotent double-start guard). */
  refresher: RunningRefresher | null;
};

type RunningRefresher = {
  stop: () => void;
  enumerate: ApprovedWidgetStreamSlugEnumerator;
  buildTimeSlugs: ReadonlySet<string>;
  onError?: (err: unknown) => void;
};

export type RefreshResult = { ok: boolean; error: string | null; generation: number };

declare global {
  var __cinatraWidgetStreamRuntimeSlugSnapshot: SnapshotInternals | undefined;
}

function emptyState(): SnapshotInternals {
  return {
    paths: new Set<string>(),
    slugs: new Set<string>(),
    generation: 0,
    lastRefreshOkAt: null,
    lastError: null,
    inFlight: null,
    refresher: null,
  };
}

function state(): SnapshotInternals {
  const existing = globalThis.__cinatraWidgetStreamRuntimeSlugSnapshot;
  // Structurally validate the global slot before trusting it. A malformed /
  // poisoned slot (e.g. `paths` swapped for a fake `{ has: () => true }`, or a
  // non-Set) is replaced with an empty snapshot — fail closed: an empty snapshot
  // redirects every runtime widget route, it can never open one.
  if (existing && existing.paths instanceof Set && existing.slugs instanceof Set) {
    return existing;
  }
  return (globalThis.__cinatraWidgetStreamRuntimeSlugSnapshot = emptyState());
}

/**
 * Derive the build-time widget-stream slugs from the generated exact stream
 * paths (`/api/agents/<slug>/stream`). Bundle-safe: the guard already imports
 * `GENERATED_WIDGET_STREAM_PUBLIC_PATHS`, so no `.server.ts` module is pulled
 * into the proxy graph. Used to enforce build-time precedence in the snapshot.
 */
export function deriveBuildTimeWidgetSlugs(
  streamPaths: readonly string[],
): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const p of streamPaths) {
    const m = /^\/api\/agents\/([a-z0-9]+(?:-[a-z0-9]+)*)\/stream$/.exec(p);
    if (m) slugs.add(m[1]!);
  }
  return slugs;
}

/**
 * The pure, synchronous, request-path membership test the guard unions in.
 * EXACT-match only — never a prefix / wildcard. Returns false for every path
 * that is not one of the three exact paths of a currently-approved runtime
 * slug, so it can only ever ADD redirect-skips, never open a protected route.
 */
export function isRuntimeApprovedWidgetStreamPublicPath(pathname: string): boolean {
  // Structural floor first: only a well-formed widget path can EVER be public
  // via the runtime union, whatever the snapshot happens to hold. This makes
  // "the runtime layer can never open a non-widget route" an invariant of the
  // READER, not just of the writer.
  if (!WIDGET_PUBLIC_PATH_RE.test(pathname)) return false;
  try {
    return state().paths.has(pathname);
  } catch {
    // Fail closed on any anomaly (a poisoned Set whose `.has` throws, etc.).
    return false;
  }
}

/**
 * Atomically swap in a new snapshot derived from `slugs`. Applies the two
 * fail-closed filters: a slug that is not a well-formed kebab slug is DROPPED
 * (never turned into a path), and a slug that collides with a build-time widget
 * slug is DROPPED (build wins, absolutely — the build-time set already covers
 * it; the runtime layer must never shadow or alter build-time behavior). The
 * swap is a single synchronous assignment, so a concurrent guard read sees
 * either the whole old set or the whole new set, never a partial one.
 */
export function installWidgetStreamRuntimeSlugSnapshot(
  slugs: readonly string[],
  opts: { buildTimeSlugs: ReadonlySet<string> },
): void {
  const validSlugs = new Set<string>();
  const paths = new Set<string>();
  for (const raw of slugs) {
    const slug = typeof raw === "string" ? raw.normalize("NFC") : "";
    if (!WIDGET_SLUG_RE.test(slug)) continue; // malformed → fail closed (drop)
    if (opts.buildTimeSlugs.has(slug)) continue; // defer to build-time (build wins)
    if (validSlugs.has(slug)) continue; // dedup
    validSlugs.add(slug);
    paths.add(`/api/agents/${slug}/stream`);
    paths.add(`/api/agents/${slug}/token`);
    paths.add(`/api/agents/${slug}/capabilities`);
  }
  const s = state();
  s.slugs = validSlugs;
  s.paths = paths;
  s.generation += 1;
}

/**
 * Read the approved slugs from the enumerator and install them. SINGLE-FLIGHT:
 * an overlapping call coalesces onto the in-flight refresh rather than stacking
 * a second DB read. FROZEN-ON-FAILURE: if the enumerator throws, the last good
 * snapshot is left untouched (never cleared, never widened) and the error is
 * recorded — the failure can only ever cost liveness, never open a route.
 */
async function performRefreshOnce(
  s: SnapshotInternals,
  enumerate: ApprovedWidgetStreamSlugEnumerator,
  opts: { buildTimeSlugs: ReadonlySet<string> },
): Promise<RefreshResult> {
  try {
    const slugs = await enumerate();
    installWidgetStreamRuntimeSlugSnapshot(slugs, opts);
    s.lastRefreshOkAt = Date.now();
    s.lastError = null;
    return { ok: true, error: null, generation: s.generation };
  } catch (err) {
    // FROZEN, NOT OPEN: keep the last good snapshot; only record the error.
    s.lastError = err instanceof Error ? err.message : String(err);
    return { ok: false, error: s.lastError, generation: s.generation };
  }
}

export function refreshWidgetStreamRuntimeSlugSnapshot(
  enumerate: ApprovedWidgetStreamSlugEnumerator,
  opts: { buildTimeSlugs: ReadonlySet<string> },
): Promise<RefreshResult> {
  const s = state();
  if (s.inFlight) return s.inFlight;
  const run = performRefreshOnce(s, enumerate, opts);
  s.inFlight = run;
  // Clear the single-flight slot AFTER the assignment above, on a later
  // microtask. A `.finally()` callback NEVER runs synchronously — even when
  // `enumerate` throws SYNCHRONOUSLY (which would make `run` settle before we
  // return) — so `s.inFlight` is always the assigned `run` by the time this
  // fires. (The old in-IIFE `finally` cleared the slot during the synchronous
  // prefix, i.e. BEFORE the assignment, permanently wedging the refresher on a
  // sync throw.) The identity guard tolerates a slot already replaced by a
  // newer refresh.
  void run.finally(() => {
    if (s.inFlight === run) s.inFlight = null;
  });
  return run;
}

export type StartWidgetStreamRuntimeSlugRefresherOptions = {
  enumerate: ApprovedWidgetStreamSlugEnumerator;
  buildTimeSlugs: ReadonlySet<string>;
  /** Poll cadence in ms. The design's upper bound on revocation propagation. */
  intervalMs: number;
  /** Injectable timer seam (unit tests drive the interval deterministically). */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called with each refresh error (default: console.warn). */
  onError?: (err: unknown) => void;
  /** Kick an immediate (detached) refresh at start. Default true. */
  runInitialRefresh?: boolean;
};

/**
 * Start the per-replica background refresher: an initial (detached) refresh
 * plus an interval poll. Idempotent — a second call while one is running is a
 * no-op that returns the existing handle. The default interval timer is
 * `.unref()`'d so it never keeps the process alive or blocks shutdown.
 */
export function startWidgetStreamRuntimeSlugRefresher(
  opts: StartWidgetStreamRuntimeSlugRefresherOptions,
): { stop: () => void } {
  const s = state();
  if (s.refresher) return { stop: s.refresher.stop };

  const setTimer =
    opts.setTimer ??
    ((cb: () => void, ms: number) => {
      // Clamp to a safe range: setInterval coerces a delay above the 32-bit
      // ceiling — or NaN / Infinity — to ~1ms (a DB-hammering hot loop).
      const h = setInterval(cb, clampRefreshIntervalMs(ms));
      (h as { unref?: () => void }).unref?.();
      return h;
    });
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const onError =
    opts.onError ??
    ((err: unknown) => {
      console.warn(
        `[widget-stream-runtime-slug-snapshot] refresh failed (snapshot frozen, not opened): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

  const tick = () => {
    void refreshWidgetStreamRuntimeSlugSnapshot(opts.enumerate, {
      buildTimeSlugs: opts.buildTimeSlugs,
    }).then((r) => {
      if (!r.ok && r.error) onError(r.error);
    });
  };

  const handle = setTimer(tick, opts.intervalMs);
  const running: RunningRefresher = {
    stop: () => {
      clearTimer(handle);
      if (s.refresher === running) s.refresher = null;
    },
    enumerate: opts.enumerate,
    buildTimeSlugs: opts.buildTimeSlugs,
    onError,
  };
  s.refresher = running;

  if (opts.runInitialRefresh !== false) tick();

  return { stop: running.stop };
}

/** Stop the running refresher, if any (idempotent). */
export function stopWidgetStreamRuntimeSlugRefresher(): void {
  state().refresher?.stop();
}

/**
 * Coalesced immediate-refresh hook. Approve / revoke actions may call this to
 * expedite propagation ahead of the interval; single-flight makes a burst of
 * calls collapse to one read. A no-op if the refresher has not started (nothing
 * is inert-opened by an early call). Wiring this into the approve/revoke code
 * paths is deferred (those live in the grant module / slice-2 surface); until
 * then revocation still propagates on the interval cadence, and the handler is
 * the real wall meanwhile.
 */
export function signalWidgetStreamRuntimeSlugRefresh(): Promise<RefreshResult> | null {
  const r = state().refresher;
  if (!r) return null;
  return refreshWidgetStreamRuntimeSlugSnapshot(r.enumerate, {
    buildTimeSlugs: r.buildTimeSlugs,
  });
}

/** Observability snapshot of the current state (never mutated by the reader). */
export function getWidgetStreamRuntimeSlugSnapshotState(): WidgetStreamRuntimeSlugSnapshotState & {
  pathCount: number;
  running: boolean;
} {
  const s = state();
  // Return COPIES: the observability getter must never hand out the live
  // internal Sets (a caller could `.add()` a slug to bypass approval at the
  // redirect layer, or `.clear()` them to break liveness).
  return {
    paths: new Set(s.paths),
    slugs: new Set(s.slugs),
    generation: s.generation,
    lastRefreshOkAt: s.lastRefreshOkAt,
    lastError: s.lastError,
    pathCount: s.paths.size,
    running: s.refresher !== null,
  };
}

/** Test-only: stop any refresher and reset the global snapshot to empty. */
export function __resetWidgetStreamRuntimeSlugSnapshotForTests(): void {
  globalThis.__cinatraWidgetStreamRuntimeSlugSnapshot?.refresher?.stop();
  globalThis.__cinatraWidgetStreamRuntimeSlugSnapshot = emptyState();
}
