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
 * session→viewer→`availableSources()` resolution stays in the server layout
 * that owns the session; this module only reduces a source LIST + viewer.
 */
import type { ApprovalSource, ApprovalViewer, SourceCounts } from "./sources/types";

export interface ApprovalsNavSummary {
  /**
   * Sum of every source's Inbox-actionable count for the viewer (each
   * `counts()` is viewer-self-gating and reports its default actionable
   * window). Equals the unified page's Inbox-tab total by construction. The
   * pill caps the DISPLAY at "99+"; remote sources cap their own count.
   */
  total: number;
  /**
   * Availability-driven nav visibility: the viewer has at least one available
   * source whose Inbox is ACTIONABLE for them. The workflow legacy passthrough
   * is a read-only mirror (`inboxActionable: false`) so — although it applies
   * to every org member's Inbox — it does not, on its own, light the nav; v1
   * stays admin-only (unchanged). A future source that grants a non-admin an
   * actionable Inbox flips this with no sidebar rework.
   */
  visible: boolean;
}

const EMPTY: ApprovalsNavSummary = { total: 0, visible: false };

/**
 * Reduce the viewer's AVAILABLE sources (caller passes `availableSources()`,
 * NOT the raw registry — a `not_configured` source must not affect the nav)
 * into the sidebar summary.
 *
 * - `visible` — a pure, fetch-free predicate: any source that both applies to
 *   the viewer's Inbox and is actionable (`inboxActionable !== false`). No
 *   count is consulted, so an admin still sees the nav at zero pending, exactly
 *   as today.
 * - `total`   — the summed Inbox counts, soft-failing PER SOURCE so one slow /
 *   failing (e.g. remote) source can never blank the pill or zero the others.
 */
export async function summarizeApprovalsNav(
  sources: ApprovalSource[],
  viewer: ApprovalViewer,
): Promise<ApprovalsNavSummary> {
  if (sources.length === 0) return EMPTY;

  const visible = sources.some(
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

  return { total, visible };
}
