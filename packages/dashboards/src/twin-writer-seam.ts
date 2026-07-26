import "server-only";
import type { SQL } from "drizzle-orm";

/**
 * The dashboards-artifact TWIN-WRITER SEAM (cinatra#1894, epic #1883 §D7 /
 * decomposition #1944 slice B1b).
 *
 * Every dashboards mutation must land its artifact-substrate twin ATOMICALLY
 * with the dashboards row — inside the SAME Drizzle transaction. The substrate
 * writers live host-side (`src/lib/artifacts` / `src/lib/objects`), and
 * `packages/dashboards` cannot import host `src/lib` (layering). So the host
 * REGISTERS its twin writer through this seam at boot, and each mutation-service
 * writer calls `pairTwin(tx, ctx)` inside its transaction.
 *
 * === FAIL-CLOSED (Q1 CONFIRMED) ===
 * When NO twin writer is registered, `pairTwin` THROWS
 * `DashboardTwinWriterNotRegisteredError` — it never silently no-ops. A no-op
 * default would be fail-OPEN: a dropped boot wiring would silently reintroduce
 * the "zero substrate writers" defect that B1b exists to close. Fail-closed
 * crashes loud at the first mutation instead. The host boot phase registers the
 * real writer in a core-boot phase (alongside the extension-dashboard lifecycle
 * wiring); a host-boot startup assertion verifies registration.
 *
 * === TEST DISCIPLINE (delta D4) ===
 * Because the seam is fail-closed, ANY test path that drives a dashboards writer
 * must register an explicit test twin first — the real host twin, the
 * `NOOP_DASHBOARD_TWIN_WRITER`, or a recording spy — and reset it afterwards via
 * `resetDashboardArtifactTwinWriter()`. Registering a DIFFERENT writer over an
 * existing one throws `DashboardTwinWriterConflictError` (the double-registration
 * guard); re-registering the SAME function reference is idempotent (boot may
 * re-import the wiring module).
 */

/** What the twin needs from a dashboards write to mint/patch the substrate row.
 *  The scope axis (`ownerLevel`/`ownerId`/`projectId`) is copied VERBATIM from
 *  the dashboards row so the substrate `objects` row shares the exact axis
 *  `resolveDashboardAccess` reads (no write-on-one-axis / read-on-another). */
export interface DashboardTwinContext {
  /** `upsert` covers create/update/publish/archive/rename/materialize/adopt/
   *  upgrade (a live objects row); `delete` maps to the soft-delete tombstone. */
  readonly operation: "upsert" | "delete";
  /** The dashboards row id — the substrate `objects.id` (kind/form='dashboard'). */
  readonly dashboardId: string;
  readonly orgId: string;
  /** The dashboards row's owner axis, copied verbatim. */
  readonly ownerLevel: string;
  readonly ownerId: string;
  readonly projectId: string | null;
  /** The acting principal (attributes the substrate audit / change event). */
  readonly actorId: string | null;
  /**
   * The MATERIALIZING extension package name (cinatra#1896 Scope 2), copied
   * verbatim from `dashboards.extension_id`. Present (non-null) ONLY on an
   * extension-materialized row (template / per-project instance / adopt / upgrade
   * / lifecycle archive|restore of an extension-owned dashboard); `null` for every
   * user/operator/agent-authored dashboard. It is the CHANNEL through which the
   * twin names the meaning pack whose claim it asserts: when set on an `upsert`,
   * the host twin mints an eligible `authoring_skill` (classic-basis)
   * `semantic_assertion` for the twin artifact with `extension` = this package
   * (see `dashboard-artifact-twin-writer`). Absent (undefined) on a context built
   * before this field existed ⇒ treated as `null` (no meaning assertion), so the
   * addition is backward-compatible for every existing `pairTwin` call site.
   */
  readonly extensionId?: string | null;
  /**
   * EXPLICIT mint-intent (cinatra#1896 Scope 2 — codex round adoption). The host
   * twin mints the pack's `authoring_skill` meaning assertion ONLY when this is
   * `true` (AND `extensionId` is non-null AND `operation === "upsert"`). Set true
   * by exactly the two MATERIALIZE writers (`materializeExtensionTemplate` /
   * `materializeExtensionInstanceForProject`) — the operations the issue's Scope 2
   * names ("at materialization … lands as an eligible assertion").
   *
   * It is deliberately NOT set by the lifecycle bulk writers even though those
   * rows also carry `extension_id`: an `archive`/`restore` upsert must never
   * RE-MINT an eligible assertion onto an uninstalled/archived dashboard, and
   * `adopt`/`upgrade` re-homing of the meaning assertion (which would also need to
   * archive the predecessor's assertion to avoid two eligible extensions) is a
   * separate lifecycle concern outside this materialize-mint delta. Absent ⇒
   * `false` (no mint), so every non-materialize `pairTwin` call site is unchanged.
   */
  readonly mintMeaningAssertion?: boolean;
}

/** The minimal transaction surface the twin needs: run a spliced host builder
 *  SQL on the SAME connection the dashboards row is being written on. Satisfied
 *  structurally by the Drizzle `PgTransaction` handed to a `db.transaction`
 *  callback. */
export interface TwinTx {
  execute(query: SQL): Promise<unknown>;
}

/** The host-registered twin. Runs the substrate writes on `tx` via
 *  `tx.execute(rawWithParams(text, values))`. */
export type DashboardArtifactTwinWriter = (
  tx: TwinTx,
  ctx: DashboardTwinContext,
) => Promise<void>;

/** Thrown by `pairTwin` when no twin writer is registered (fail-closed). */
export class DashboardTwinWriterNotRegisteredError extends Error {
  readonly code = "dashboard_twin_writer_not_registered";
  constructor() {
    super(
      "No dashboard-artifact twin writer is registered. The host boot phase must " +
        "call setDashboardArtifactTwinWriter(...) before any dashboards mutation " +
        "runs; a test driving a dashboards writer must register an explicit test " +
        "twin (real, NOOP_DASHBOARD_TWIN_WRITER, or a recording spy).",
    );
    this.name = "DashboardTwinWriterNotRegisteredError";
  }
}

/** Thrown when a DIFFERENT twin writer is registered over an existing one (the
 *  double-registration guard). Re-registering the SAME reference is allowed. */
export class DashboardTwinWriterConflictError extends Error {
  readonly code = "dashboard_twin_writer_conflict";
  constructor() {
    super(
      "A different dashboard-artifact twin writer is already registered. Call " +
        "resetDashboardArtifactTwinWriter() before registering a distinct writer.",
    );
    this.name = "DashboardTwinWriterConflictError";
  }
}

let registeredTwinWriter: DashboardArtifactTwinWriter | null = null;

/**
 * Register the host twin writer. Idempotent for the SAME function reference (a
 * re-imported boot wiring module re-registers harmlessly); registering a
 * DIFFERENT writer over an existing one throws `DashboardTwinWriterConflictError`
 * (delta D4).
 */
export function setDashboardArtifactTwinWriter(writer: DashboardArtifactTwinWriter): void {
  if (registeredTwinWriter !== null && registeredTwinWriter !== writer) {
    throw new DashboardTwinWriterConflictError();
  }
  registeredTwinWriter = writer;
}

/** Clear the registered twin writer. For test isolation ONLY (delta D4) — every
 *  test that registers a twin must reset it in teardown. */
export function resetDashboardArtifactTwinWriter(): void {
  registeredTwinWriter = null;
}

/** Whether a twin writer is currently registered — the host-boot startup
 *  assertion reads this to fail loud if the wiring phase did not run. */
export function isDashboardArtifactTwinWriterRegistered(): boolean {
  return registeredTwinWriter !== null;
}

/**
 * Run the registered twin writer inside the caller's dashboards transaction.
 * FAIL-CLOSED: throws `DashboardTwinWriterNotRegisteredError` when none is
 * registered, so a dropped boot wiring aborts the mutation instead of silently
 * skipping the substrate twin. Called by every mutation-service writer.
 */
export async function pairTwin(tx: TwinTx, ctx: DashboardTwinContext): Promise<void> {
  if (registeredTwinWriter === null) {
    throw new DashboardTwinWriterNotRegisteredError();
  }
  await registeredTwinWriter(tx, ctx);
}

/** An EXPLICIT no-op twin for tests / integration harnesses that drive a
 *  dashboards writer without standing up the substrate. It proves nothing about
 *  atomicity (only the substrate-backed kill-tests do) — it exists solely to
 *  satisfy the fail-closed seam in a no-substrate test. */
export const NOOP_DASHBOARD_TWIN_WRITER: DashboardArtifactTwinWriter = async () => {};

// ---------------------------------------------------------------------------
// ROUTE-GRAPH DECOUPLING (cinatra#1894 B1b, route-graph ratchet cinatra#732)
//
// The mutation service reaches `pairTwin` through THIS globalThis dispatch port
// instead of a static value import, so this seam module — boot-registered
// machinery, not a per-request concern — stays OUT of every tracked route's
// first-party dev-compile graph. Without the port, `mutation-service.ts`'s
// value-import of `pairTwin` pulled this module into all five ratchet-tracked
// routes (+1 each); a globalThis port is the same seam-decoupling pattern the
// audit pool (`globalThis.__cinatraAuditPool`) and the owner-containment
// resolver already use.
//
// The seam self-publishes its OWN `pairTwin` here on module load. `pairTwin`
// reads the live `registeredTwinWriter`, so the FAIL-CLOSED disposition is
// unchanged through the port: an unregistered writer still throws
// `DashboardTwinWriterNotRegisteredError`. The host boot phase loads this module
// (via the twin-writer self-register import) BEFORE any mutation can run, and
// the fatal boot assertion proves registration; a mutation that somehow runs
// with the seam never loaded reads an undefined port and fails closed at the
// call site (see `mutation-service.ts`).
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line no-var
  var __cinatraDashboardArtifactTwinPair:
    | ((tx: TwinTx, ctx: DashboardTwinContext) => Promise<void>)
    | undefined;
}

globalThis.__cinatraDashboardArtifactTwinPair = pairTwin;
