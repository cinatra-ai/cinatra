// ---------------------------------------------------------------------------
// The REPAIRED-capture PORT (cinatra#2044 / #2046, epic #2286 S10 follow-up).
//
// WHY A PORT AND NOT AN IMPORT: the picture is written by the host's pinned
// preview-capture pipeline (`src/lib/artifacts/cms-preview-capture.ts`), which
// reaches the connect-site store, the webhook secret service and — through a
// SPAWNED subprocess — a headless browser. The repair-completion drain that
// knows WHEN to take that picture is this leaf agents package
// (`lifecycle-repair-cms-production-bridge.ts`), reached from the review
// orchestration sweep. A literal dynamic `import()` of the host capture module
// from here would count as an edge in `scripts/route-graph.mjs` exactly like a
// static one and drag that whole graph onto every locked route — the same
// ratchet posture that put `register-cms-review-host-seam-runtime` (the boot-only
// binder) between the seam and its stores. So the app PUBLISHES the capture
// entry point on a `globalThis` `Symbol.for` singleton at boot and this leaf
// reads it with NO import edge (the `owner-containment-port` pattern).
//
// HONESTY CONTRACT — the whole reason this exists. The repair-successor gate
// renders #2287's `repair` pair: the reviewed proposal on the left, the
// producer's fix on the right. Until this port is called by production code the
// right half reads "This side was never captured" for every repair, forever.
// So every outcome is REPORTED, never swallowed:
//   captured    — the picture is pinned; the pair renders both halves.
//   degraded    — the capture failed for a NAMED reason AND the host recorded a
//                 degraded record carrying it, so the gate states the gap.
//   degraded    — `recorded: false`: the failure could not even be recorded (the
//   (unrecorded)  wall-clock ceiling, or the record write itself failing). The
//                 gate will show an uncaptured side; the drain says so loudly.
//   unavailable — no port bound in this process (a boot misconfiguration).
//   failed      — the port threw.
// A capture NEVER blocks the repair: withholding the successor gate would leave
// a completed repair with no way for a reviewer to act on it, which is strictly
// worse than a stated missing picture. The failure is carried by the drain's
// counters + logs instead.
// ---------------------------------------------------------------------------

const CMS_REPAIRED_CAPTURE_PORT_KEY = Symbol.for(
  "@cinatra-ai/host:cms-repaired-capture/v1",
);

/** The repair-successor coordinates the picture is taken for. Both targets come
 * off the repair row itself — never a caller-named target. */
export interface CmsRepairedCaptureRequest {
  orgId: string;
  /** The re-staged snapshot the successor gate pins — what the picture binds to. */
  successorTarget: { artifactId: string; representationRevisionId: string };
  /** The reviewed base target — the fallback source of the site coordinates the
   * capture-time SSRF policy already resolved. */
  baseTarget: { artifactId: string; representationRevisionId: string };
  title?: string;
  /** The accountable human the repair was re-authorized against. */
  createdBy?: string | null;
  /** The repair run that produced the fix. */
  producerRunId?: string | null;
}

export type CmsRepairedCaptureResult =
  | { status: "captured" }
  | {
      status: "degraded";
      reason: string;
      /** Whether a degraded record carrying `reason` was actually pinned — i.e.
       * whether the gate can state the gap instead of showing a blank side. */
      recorded: boolean;
    };

/** The host-published capture entry point. Never throws in the host binding;
 * `attemptRepairedCapture` still guards against it. */
export type CmsRepairedCapturePort = (
  request: CmsRepairedCaptureRequest,
) => Promise<CmsRepairedCaptureResult>;

type Holder = { [k: symbol]: CmsRepairedCapturePort | undefined };

/** Read the globalThis-published port (or `undefined` when its publisher never
 * loaded — reported as `unavailable`, never silently skipped). */
export function readCmsRepairedCapturePort(): CmsRepairedCapturePort | undefined {
  return (globalThis as unknown as Holder)[CMS_REPAIRED_CAPTURE_PORT_KEY];
}

/** Publish the port. The app boot seam calls this (`bind-cms-review-host-seam`);
 * tests install a stub and reset with `undefined`. Idempotent, last write wins. */
export function publishCmsRepairedCapturePort(
  port: CmsRepairedCapturePort | undefined,
): void {
  (globalThis as unknown as Holder)[CMS_REPAIRED_CAPTURE_PORT_KEY] = port;
}

export type CmsRepairedCaptureAttempt =
  | { outcome: "captured" }
  | { outcome: "degraded"; reason: string; recorded: boolean }
  | { outcome: "unavailable" }
  | { outcome: "failed"; error: string };

/**
 * Take the repaired picture through the published port, reporting every outcome
 * and NEVER throwing. The caller decides what to do with the report; it must
 * never let the report decide whether the repair itself completes.
 */
export async function attemptRepairedCapture(
  request: CmsRepairedCaptureRequest,
): Promise<CmsRepairedCaptureAttempt> {
  const port = readCmsRepairedCapturePort();
  if (!port) return { outcome: "unavailable" };
  try {
    const result = await port(request);
    return result.status === "captured"
      ? { outcome: "captured" }
      : { outcome: "degraded", reason: result.reason, recorded: result.recorded };
  } catch (err) {
    return { outcome: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether an attempt leaves the successor gate with NO right-hand picture and
 * no stated reason on it — the one outcome class that must be loud.
 *
 * Deliberately NOT a type predicate: `false` does not imply `captured` (a
 * degrade that WAS recorded also answers false), so a predicate's implied
 * false-branch narrowing would be unsound. Callers that need the cause narrow
 * on `outcome` themselves.
 */
export function leavesUncapturedSide(attempt: CmsRepairedCaptureAttempt): boolean {
  return (
    attempt.outcome === "unavailable" ||
    attempt.outcome === "failed" ||
    (attempt.outcome === "degraded" && !attempt.recorded)
  );
}
