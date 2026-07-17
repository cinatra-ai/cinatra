// Client-only bus carrying server-authorized breadcrumb CONTRIBUTIONS from a
// route's publisher island to the AppShell (cinatra#1737). Generalizes the
// chat-shell-bus parked-value pattern: the value is held in module state so a
// consumer that mounts AFTER the producer emitted still reads the last value,
// and a live CustomEvent keeps an already-mounted consumer current.
//
// SNAPSHOT SEMANTICS (ratified on the issue):
//   - The bus holds ONE replaceable, route-scoped snapshot keyed to
//     (pathname, epoch) — NOT an immortal merge map. Every publish REPLACES
//     the snapshot wholesale; entries never accumulate across routes.
//   - epoch identifies (session user, active org). A publish under a new
//     epoch replaces the old snapshot entirely; consumers additionally pass
//     their own current epoch to `selectCrumbContributions` so entries from a
//     stale session/org are never applied even before the next publish.
//   - Soft-nav seeding: while navigating within the same epoch, REPLACEMENT
//     entries whose prefix matches the new pathname still apply (so
//     /teams/X → /teams/X/settings renders the intermediate immediately).
//     INSERTION entries (`insertBefore`) apply only while the snapshot's own
//     pathname is current — ancestry synthesized for one route must never
//     leak into another.
//   - Negative clearing: the 404 / not-authorized surfaces render a clearing
//     island (`<CrumbContributionsClear/>`), so a previously-authorized label
//     can never survive into a later unauthorized visit.
//
// All functions are SSR-safe (window-guarded dispatch; plain module state).

export const CRUMB_CONTRIBUTIONS_EVENT = "cinatra:crumbs:changed";

export type CrumbContribution = {
  /** Full crumb path this entry targets, e.g. "/teams/<id>". */
  readonly prefix: string;
  readonly label: string;
  /** Optional href override (defaults to the crumb's own path). */
  readonly href?: string;
  readonly nonNavigable?: boolean;
  /** Insert a NEW crumb before the crumb whose path equals this prefix
   *  (cinatra#1738 ancestry). Applied only while the publishing route is the
   *  current route. */
  readonly insertBefore?: string;
};

export type CrumbSnapshot = {
  readonly pathname: string;
  readonly epoch: string;
  /** Publisher declaration order preserved; for duplicate prefixes the LAST
   *  entry wins (enforced at publish). */
  readonly entries: readonly CrumbContribution[];
};

let snapshot: CrumbSnapshot | null = null;

/** Replace the snapshot wholesale (route-scoped — never a merge) + notify. */
export function publishCrumbContributions(
  pathname: string,
  epoch: string,
  entries: readonly CrumbContribution[],
): void {
  // Last-per-prefix wins while preserving the order of the LAST occurrence
  // (insertion entries are exempt from the dedupe — each targets a position,
  // not a crumb identity).
  const deduped: CrumbContribution[] = [];
  for (const entry of entries) {
    if (!entry.insertBefore) {
      const existing = deduped.findIndex(
        (e) => !e.insertBefore && e.prefix === entry.prefix,
      );
      if (existing !== -1) deduped.splice(existing, 1);
    }
    deduped.push(entry);
  }
  snapshot = { pathname, epoch, entries: deduped };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CRUMB_CONTRIBUTIONS_EVENT));
  }
}

/** The current snapshot (parked value for late-mounting consumers). */
export function getCrumbSnapshot(): CrumbSnapshot | null {
  return snapshot;
}

/** Full reset — negative clearing (404 / not-authorized) and epoch teardown. */
export function clearCrumbContributions(): void {
  snapshot = null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CRUMB_CONTRIBUTIONS_EVENT));
  }
}

/**
 * The entries applicable to `pathname` under `currentEpoch`, per the snapshot
 * semantics above. Pure — the AppShell calls this with its own session/org
 * epoch so a stale snapshot is never applied.
 */
export function selectCrumbContributions(
  pathname: string,
  currentEpoch: string,
): CrumbContribution[] {
  if (!snapshot || snapshot.epoch !== currentEpoch) return [];
  const samePath = snapshot.pathname === pathname;
  return snapshot.entries.filter((entry) => {
    if (entry.insertBefore) return samePath;
    return pathname === entry.prefix || pathname.startsWith(entry.prefix + "/");
  });
}
