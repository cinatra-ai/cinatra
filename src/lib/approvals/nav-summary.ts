/**
 * Registry-driven summary that feeds the sidebar Approvals nav item: the
 * pending-count pill total AND availability-driven visibility. Supersedes the
 * hard-wired `pendingApprovalsCount()` — the sidebar no longer knows which
 * approval families exist; it consumes `{ total, visible }` derived from the
 * #1044 `ApprovalSource` registry, so a new source (marketplace #1045, the
 * project-agent gate #1032, …) changes the badge and the nav WITHOUT any
 * sidebar edit.
 *
 * Import-light + framework-free (types only) so it is unit-testable in
 * isolation with mock sources — the page's / registry's full server module
 * graph is never pulled in here (mirrors `resolve-active-view.ts`). The
 * session→viewer→`availableNavSources()` resolution stays in the server layout
 * that owns the session; this module only reduces a source LIST + viewer.
 *
 * Takes the LIGHT {@link ApprovalNavSource} (id / inboxActionable / appliesTo /
 * counts) — never the heavy full `ApprovalSource` — so the root layout that
 * calls it can resolve the badge off `nav-registry` without dragging the
 * decide/render graph into every route's build (cinatra#1283). A full source is
 * a valid nav source (`ApprovalSource extends ApprovalNavSource`), so the page
 * may reuse this reducer too.
 */
import type { ApprovalNavSource, ApprovalViewer, SourceCounts } from "./sources/types";

export interface ApprovalsNavSummary {
  /**
   * Sum of every source's Inbox-actionable count for the viewer (each
   * `counts()` is viewer-self-gating and reports its default actionable
   * window). Uses the SAME per-source count functions as the unified page's
   * Inbox tab (registry parity), so it agrees with that total in the steady
   * state — but it is an INDEPENDENT pass, so a per-source soft-fail or a stale
   * ~60s marketplace count-cache snapshot can make them differ instant-to-
   * instant (not equal by construction). The pill caps the DISPLAY at "99+";
   * remote sources cap their own count.
   */
  total: number;
  /**
   * Nav visibility. TWO ways in (owner review #1302 ask 5, option-b):
   *   • the viewer has an available source whose Inbox is ACTIONABLE for them
   *     (admins — count-independent, so the item shows at zero pending, exactly
   *     as before; the read-only workflow passthrough (`inboxActionable:false`)
   *     does NOT count); OR
   *   • the viewer has at least one OWN request in flight (`mine > 0`). This is
   *     the non-admin path: a member who proposed an agent via `/chat` gets the
   *     Approvals surface to find and track their own request, even though no
   *     Inbox source is actionable for them. Admin behavior is unchanged.
   */
  visible: boolean;
}

const EMPTY: ApprovalsNavSummary = { total: 0, visible: false };

/**
 * Reduce the viewer's AVAILABLE sources (caller passes `availableSources()`,
 * NOT the raw registry — a `not_configured` source must not affect the nav)
 * into the sidebar summary.
 *
 * - `visible` — lit when EITHER the viewer has an actionable Inbox source
 *   (`appliesTo(inbox) && inboxActionable !== false` — admins, count-independent,
 *   so the nav shows at zero pending exactly as before) OR the viewer has any
 *   own request in flight (`mine > 0` summed across sources — the non-admin
 *   option-b path, owner review #1302 ask 5). The `mine` counts are already
 *   fetched for `total`, so this adds no work.
 * - `total`   — the summed Inbox counts, soft-failing PER SOURCE so one slow /
 *   failing (e.g. remote) source can never blank the pill or zero the others.
 */
export async function summarizeApprovalsNav(
  sources: ApprovalNavSource[],
  viewer: ApprovalViewer,
): Promise<ApprovalsNavSummary> {
  if (sources.length === 0) return EMPTY;

  const inboxActionableForViewer = sources.some(
    (s) => s.appliesTo(viewer, "inbox") && s.inboxActionable !== false,
  );

  const counts = await Promise.all(
    sources.map((s) =>
      Promise.resolve()
        .then(() => s.counts(viewer))
        .catch(() => ({ inbox: 0, mine: 0 }) as SourceCounts),
    ),
  );
  const total = counts.reduce((sum, c) => sum + c.inbox, 0);
  const mineTotal = counts.reduce((sum, c) => sum + c.mine, 0);

  // Non-admins reach the surface through their OWN in-flight requests (option-b);
  // admins keep the count-independent actionable-Inbox path.
  const visible = inboxActionableForViewer || mineTotal > 0;

  return { total, visible };
}
