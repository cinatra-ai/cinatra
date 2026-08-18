import "server-only";

// ---------------------------------------------------------------------------
// WHICH IMPLEMENTATION OF A PACKAGE IS ACTUALLY IN SERVICE (cinatra#2762).
//
// THE DEFECT THIS EXISTS FOR. A package can hold a live marketplace install row
// that never registered — the bytes are materialized and the row says `active`,
// but activation was refused (an untrusted registry, a missing signing key, a
// module that threw) and the implementation bundled in the image is what serves
// every request. #2762 is named for that state, and the product could not name
// it: the settings page read the VERSION OFF THE ROW and reported
// "Currently on version 0.1.5 — up to date" while 0.1.0 was serving, with
// Activate greyed as "Already active".
//
// The row could not answer the question. `installed_extension.status` is the
// LIFECYCLE fact (did an operator archive it?), not the RUNTIME fact (did it
// register?), and nothing in the process recorded the difference: the
// register-channel registries (mcp tools, capability providers, ctx.ui surfaces,
// object types) are keyed by PACKAGE NAME and hold no provenance, so "is
// something serving this package?" was answerable and "WHAT is serving it?" was
// not. Boot reconciliation knew, but only within its own boot pass
// (`activatedThisBoot`), and a request-time surface cannot read that.
//
// So each activation seam records what it put in service, right where it already
// knows: the StaticBundleLoader records the image's version, the
// RuntimePackageLoader records the installed version. The record is the
// PROVENANCE of the registrations that are live NOW.
//
// IT IS DESCRIPTIVE, NEVER LOAD-BEARING. Nothing gates, resolves, activates or
// refuses on this record — it exists so a surface can TELL AN OPERATOR what is
// happening. Every consumer must treat an absent record as "unknown" and say
// nothing rather than guess, because absence is a legitimate state: a
// metadata-only package registers no server module at all, a record written
// before this module existed is gone after a restart, and a process that never
// ran a loader (a unit test, a build-time render) has nothing to report.
//
// LIFECYCLE. Written on a registration that SUCCEEDED (`registered` /
// `bootstrapped`), cleared by the single in-process capability-teardown
// chokepoint — the same chokepoint that clears the register-channel registries,
// so the record can never outlive the registrations it describes. A re-activate
// fires that teardown defensively first and then records again, so the record
// tracks a replacement rather than stacking.
//
// CROSS-COMPILATION SINGLETON: Next.js builds separate bundler compilations
// (instrumentation / route / RSC), each with its own module cache. The loaders
// write at boot/activation (instrumentation compilation); the settings surface
// reads at request time (RSC compilation) — so this MUST be a true per-process
// singleton anchored on a namespaced+versioned `Symbol.for(...)` key, the same
// pattern as the MCP / capability / ui / version-keyed-serving registries.
// ---------------------------------------------------------------------------

/**
 * WHERE the implementation now serving a package came from.
 *
 * `bundled` — the copy that ships in the image, activated by the
 * StaticBundleLoader (at boot, or by the targeted reactivation seam a rollback
 * and the post-failure compensation use).
 * `install` — a materialized marketplace install, activated by the
 * RuntimePackageLoader (at boot, or by a targeted in-process activation).
 */
export type ServingOrigin = "bundled" | "install";

export type ServingRecord = {
  origin: ServingOrigin;
  /** The version that registered, or null when the seam could not name one. */
  version: string | null;
};

const SERVING_RECORD_KEY = Symbol.for("@cinatra-ai/host:extension-serving-record/v1");
type RecordHolder = { [k: symbol]: Map<string, ServingRecord> | undefined };
const _holder = globalThis as unknown as RecordHolder;
const registry: Map<string, ServingRecord> =
  _holder[SERVING_RECORD_KEY] ??
  (_holder[SERVING_RECORD_KEY] = new Map<string, ServingRecord>());

/**
 * Record that `origin`'s `version` of `packageName` is now in service.
 *
 * Called ONLY after a registration succeeded. Idempotent and last-write-wins,
 * which is the truth: at boot the bundled record activates first and the
 * install's activation then REPLACES it (the loader tears the previous
 * registrations down before it registers), so the last successful writer is
 * whoever owns the package's names right now.
 *
 * A blank / absent version is stored as `null` rather than `""` so a consumer
 * cannot compare an empty string against a real version and call them different.
 */
export function recordServingImplementation(input: {
  packageName: string;
  origin: ServingOrigin;
  version?: string | null;
}): void {
  if (!input.packageName) return;
  const version =
    typeof input.version === "string" && input.version.length > 0 ? input.version : null;
  registry.set(input.packageName, { origin: input.origin, version });
}

/**
 * What is serving `packageName` in THIS process, or null when nothing recorded
 * it. Null means UNKNOWN — never "nothing is serving it".
 */
export function readServingRecord(packageName: string): ServingRecord | null {
  return registry.get(packageName) ?? null;
}

/** Drop the record for a package. Wired into the capability-teardown chokepoint,
 *  so it is cleared in lockstep with the registrations it describes. Returns
 *  whether a record was actually removed (for the teardown's own bookkeeping). */
export function clearServingRecordForPackage(packageName: string): boolean {
  return registry.delete(packageName);
}

/** A read-only snapshot — package name → what is serving it. Diagnostic only. */
export function snapshotServingRecords(): { packageName: string; record: ServingRecord }[] {
  return [...registry].map(([packageName, record]) => ({ packageName, record }));
}

/** Test/teardown helper — clears every record. */
export function __resetServingRecordsForTests(): void {
  registry.clear();
}

// PUBLISHED TEARDOWN SURFACE. `extension-capability-teardown.ts` is reachable
// from the locked dev-perf routes whose static import graph is ratcheted
// shrink-only (cinatra#732), so it reads the clear off this `Symbol.for` surface
// instead of importing this module. If this module never loaded, no record can
// exist, and the lookup is a safe no-op — the same contract
// `extension-version-keyed-serving` publishes its own clear under.
const SERVING_RECORD_TEARDOWN_KEY = Symbol.for(
  "@cinatra-ai/host:extension-serving-record-teardown/v1",
);
(globalThis as unknown as { [k: symbol]: unknown })[SERVING_RECORD_TEARDOWN_KEY] =
  clearServingRecordForPackage;
