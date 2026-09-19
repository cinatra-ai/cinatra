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
  /** Append a NEW crumb AFTER the crumb whose path equals this prefix
   *  (cinatra#3068 fix leg 2 -- the run page names the step the run detail is
   *  showing, which has no path segment of its own). The mirror of
   *  `insertBefore` in every respect: it targets a POSITION rather than a crumb
   *  identity, so it is exempt from the per-prefix dedupe, and it is applied
   *  only while the publishing route is the current route -- a step synthesized
   *  for one route must never leak into another. */
  readonly appendAfter?: string;
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
    if (!entry.insertBefore && !entry.appendAfter) {
      const existing = deduped.findIndex(
        (e) => !e.insertBefore && !e.appendAfter && e.prefix === entry.prefix,
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

/**
 * ONE TRAIL SHAPE FOR A RUN'S PAGES (cinatra#3446).
 *
 * A run's own page and its review page drew two different trails. The run page
 * read "Agents > Blog Draft Writer Agent (4)" — the agent and the run folded
 * into one crumb, with no crumb for the agent — while the review page of the
 * same run read "Agents > 00220c95... > Review": that page published nothing
 * here and broadcast only its leaf title, so the collapsed agents trail fell
 * through to the run id's abbreviation and named the agent nowhere.
 *
 * The issue's Expected is one shape for both pages: the agent's name, then the
 * run, then the step or surface. So the entries a run's pages publish are
 * composed HERE, once, and every page of a run publishes exactly these — the
 * run page's layout and the review route's publisher island call this same
 * function, which is what makes the two trails read the same words. A page that
 * adds a surface below the run (the review page) still takes that surface's own
 * crumb from its path segment, as it always did.
 *
 * THE AGENT'S CRUMB IS AN INSERTION, not a new mechanism: `insertBefore` is the
 * ancestry channel this bus has carried since cinatra#1738. Its level
 * (`<base>/agents/<vendor>/<package>`) has no page of its own — the route
 * resolves at the instance below it — so the crumb is a plain label rather than
 * a link to a 404.
 *
 * THE AGENT IS NAMED ONCE. A run with no title of its own is named by its
 * agent (`runName || templateName`), and so is a system run, whose label IS the
 * template's name. A trail that then drew that name twice would name the run
 * nowhere, so the agent's crumb is composed only where the run's own label
 * differs from it — and the test that the composer applies is the LABEL it just
 * composed, never the raw title, so the two pages of one run agree on the level
 * count whichever of them resolved the title.
 */
export function agentRunCrumbEntries(input: {
  /** The scope base this run is read at (cinatra#2809), or none. */
  readonly scopeBase?: string | null;
  /** `<vendor>/<package>` exactly as the run's address carries it. */
  readonly agentId: string;
  /** The run's own path segment, exactly as the run's address carries it. */
  readonly instanceId: string;
  /** The AGENT's name — the template's, as the run page's header names it. */
  readonly templateName: string;
  /** The RUN's own title, empty while it has none. */
  readonly runName: string;
}): CrumbContribution[] {
  const base = input.scopeBase ?? "";
  const agentPath = `${base}/agents/${input.agentId}`;
  const instancePath = `${agentPath}/${input.instanceId}`;
  const runLabel =
    input.runName || input.templateName || `${input.instanceId.slice(0, 8)}\u2026`;
  const entries: CrumbContribution[] = [];
  if (input.templateName && runLabel !== input.templateName) {
    entries.push({
      prefix: agentPath,
      label: input.templateName,
      insertBefore: instancePath,
      nonNavigable: true,
    });
  }
  entries.push({ prefix: instancePath, label: runLabel });
  return entries;
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
    if (entry.insertBefore || entry.appendAfter) return samePath;
    return pathname === entry.prefix || pathname.startsWith(entry.prefix + "/");
  });
}
