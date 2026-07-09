/**
 * Pure active-view resolver for the unified `/configuration/approvals` page.
 *
 * Supersedes `resolve-active-tab.ts`: the page moved from source tabs
 * (Workflows / Agents) to DIRECTION tabs (Inbox / "Your requests"), while
 * keeping the legacy `?tab=agents|workflows` deep links working (the config
 * cards and `next.config.ts` redirects still emit them).
 *
 * Explicit precedence (no side effects, import-light so it is unit-testable in
 * isolation — the page's full server module graph cannot be imported here):
 *   1. a valid explicit `?direction=inbox|mine` wins;
 *   2. else a legacy `?tab=` maps in — both legacy tabs were Inbox-type views,
 *      so each maps to `inbox`, anchored to the matching source section
 *      (a non-admin simply has no agent section — the direction still renders);
 *   3. else the smart default: land on the POPULATED direction (generalising
 *      the old "land on the populated tab"), preferring Inbox.
 *
 * Counts are caller-supplied and auth-aware (a non-admin's inbox count is 0), so
 * a non-admin is never defaulted to an Inbox that holds nothing for them.
 */

export type ApprovalsDirection = "inbox" | "mine";

/** Stable section ids the legacy `?tab=` values anchor to (match the source ids). */
export const AGENT_SOURCE_ID = "agent-creation-requests";
export const WORKFLOW_SOURCE_ID = "workflow-legacy";

export interface ResolvedApprovalsView {
  direction: ApprovalsDirection;
  /** Optional section id a legacy `?tab=` deep link anchors to. */
  anchor?: string;
}

export function resolveApprovalsActiveView(input: {
  explicitDirection?: string | undefined;
  legacyTab?: string | undefined;
  inboxCount: number;
  mineCount: number;
}): ResolvedApprovalsView {
  const { explicitDirection, legacyTab, inboxCount, mineCount } = input;

  if (explicitDirection === "inbox" || explicitDirection === "mine") {
    return { direction: explicitDirection };
  }

  if (legacyTab === "workflows") {
    return { direction: "inbox", anchor: WORKFLOW_SOURCE_ID };
  }
  if (legacyTab === "agents") {
    return { direction: "inbox", anchor: AGENT_SOURCE_ID };
  }

  // Smart default — land on the populated direction, preferring Inbox.
  if (inboxCount === 0 && mineCount > 0) {
    return { direction: "mine" };
  }
  return { direction: "inbox" };
}
