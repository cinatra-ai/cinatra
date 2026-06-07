// Non-finalized canonical-row detection.
//
// A "non-finalized" row is a live (active|locked) canonical install row that
// the real-integrity pipeline never finalized — a fresh placeholder, a broken
// prior attempt, or a row stuck in the provenance-before-finalize window. Such a
// row is NOT anchorable/activatable: the rollback path must be allowed to drop
// it, and a re-install must RE-RUN the pipeline against it (never short-circuit
// it as a healthy install).
//
// These predicates live in their own module (not index.ts) so BOTH the
// dispatcher (`index.ts`) AND the canonical lifecycle primitive
// (`lifecycle-primitive.ts`) can import them without an import cycle: the
// rollback-only canonical delete in the primitive self-enforces its
// "non-finalized only" contract by consulting the SAME authoritative signal the
// dispatcher uses, rather than trusting the call site.
import "server-only";

// Integrity values that mean "not materialized through the real pipeline" — a
// canonical row carrying one of these has NOT been finalized by the install
// pipeline, so it is NOT anchorable/activatable. Kept in sync with
// `PLACEHOLDER_INTEGRITY` in `@/lib/extension-install-anchor`.
export const DISPATCHER_PLACEHOLDER_INTEGRITY = new Set([
  "",
  "dispatcher-install",
  "pending-resolution",
  "latest",
  "HEAD",
]);

/** True when a live (active|locked) row still carries placeholder integrity —
 *  i.e. the install pipeline never finalized it (a fresh OR a broken prior
 *  attempt). Such a row must RE-RUN the pipeline, never short-circuit. A
 *  non-verdaccio source (github/local) carries no `integrity` field → treated as
 *  finalized (those installs are owned by their handler, not the pipeline). */
export function isNonFinalizedLiveRow(row: { status: string; source: unknown }): boolean {
  if (row.status !== "active" && row.status !== "locked") return false;
  const src = row.source as { integrity?: unknown } | null;
  const integrity = typeof src?.integrity === "string" ? src.integrity : null;
  // No integrity field at all = a non-pipeline source (github/local) — leave it.
  if (integrity === null) return false;
  return DISPATCHER_PLACEHOLDER_INTEGRITY.has(integrity);
}

/**
 * JOURNAL-AWARE non-finalized check — the authoritative signal for the rollback +
 * re-run decisions. The install pipeline records REAL provenance (real integrity)
 * just BEFORE it finalizes the install-op journal, so there is a window where a
 * live row carries REAL integrity yet its `extension_install_ops` row is NOT
 * `finalized` (a finalize that fails, or a crash between the two writes). The
 * placeholder-integrity check (`isNonFinalizedLiveRow`) alone misses that window —
 * it treats the real-integrity row as healthy, so the rollback SKIPS it and a
 * re-install SKIPS it, stranding an active-but-non-anchorable row.
 *
 * Consults the host-injected install-op journal-phase reader: a live row whose
 * journal phase is known and NOT `finalized` is non-finalized regardless of its
 * integrity. This only ever TIGHTENS the decision:
 *   - no reader wired / reader returns `null` (no journal row, store unreachable) →
 *     fall back to the integrity check ALONE (identical to the legacy behavior);
 *   - a github/local row (no integrity field) is NEVER consulted against the
 *     journal — it has no verdaccio pipeline op and its handler owns it.
 *
 * Fail-closed: a non-finalized row (by EITHER signal) is rollbackable AND
 * re-installable.
 */
export async function isNonFinalizedLiveRowAware(row: {
  status: string;
  source: unknown;
  packageName: string;
  organizationId?: string | null;
}): Promise<boolean> {
  if (row.status !== "active" && row.status !== "locked") return false;
  // Integrity signal (the legacy + fallback path).
  if (isNonFinalizedLiveRow(row)) return true;
  // Journal signal (catches the real-integrity-but-unfinalized window). Only a
  // verdaccio pipeline source (carries an `integrity` field) has an install-op
  // journal row to consult; a github/local source is owned by its handler.
  const src = row.source as { integrity?: unknown } | null;
  if (typeof src?.integrity !== "string") return false;
  const { readExtensionInstallOpPhase } = await import("./install-op-phase-hook");
  const phase = await readExtensionInstallOpPhase(row.packageName, row.organizationId ?? null);
  // null = no journal row / no reader wired → trust the (already-false) integrity
  // check. A known phase that is NOT `finalized` ⇒ non-finalized.
  return phase !== null && phase !== "finalized";
}
