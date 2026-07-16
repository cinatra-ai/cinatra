import "server-only";

// ---------------------------------------------------------------------------
// E2E-only degraded-source seam for the /notifications v2 conformance suite
// (cinatra#1561, E11).
//
// The §VI "some approvals are currently unavailable" degraded line fires when an
// approval source THROWS (E5 `collectPendingApprovals` → `complete: false` →
// `degraded: true`, no next cursor). On a bare CI instance no source throws
// naturally — the marketplace sources are `not_configured` (filtered out) and
// the local sources are healthy — so there is NO browser-reachable way to
// exercise the degraded line + its retry on the real production build without
// this seam. Rather than assert the degraded path only at the component/unit
// tier, this injects ONE always-throwing approval source into the INITIAL server
// render, exclusively when:
//   • `CINATRA_E2E_SETUP_BYPASS === "true"` (the SAME documented, prod-unreachable
//     e2e switch that gates the fixture routes — see src/lib/auth-route-guard.ts;
//     it is never set in production), AND
//   • the request carries `?e2e=degrade-approvals`.
//
// It reuses E5's public `deps.sources` injection seam — the data layer's own
// merge/degrade logic is untouched. Only the INITIAL page render honors the
// param; the `loadMoreUnifiedFeed` retry action does NOT (it re-resolves the
// REAL sources), so clicking Retry re-requests the same (first-page) cursor and
// REPLACES the partial tail with a healthy, non-degraded page — exactly the
// §VI degrade → retry → recover round-trip, proven on the production build.
// ---------------------------------------------------------------------------

import type {
  ApprovalEnvelope,
  ApprovalSource,
} from "@/app/configuration/approvals/sources/types";

/** True when this request should force a degraded approval half (e2e only). */
export function isE2EDegradeApprovalsRequested(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): boolean {
  if (process.env.CINATRA_E2E_SETUP_BYPASS !== "true") return false;
  const raw = searchParams?.e2e;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "degrade-approvals";
}

/** An approval source whose Inbox/Mine fetch always throws, so the collection
 *  pass records `complete: false` and the page degrades. The render/decide/count
 *  surface is never reached on the feed path (only `appliesTo`/`fetchInbox`/
 *  `fetchMine` are), so those are inert stubs. */
function e2eThrowingApprovalSource(): ApprovalSource {
  const fail = (): Promise<ApprovalEnvelope> => {
    throw new Error("e2e forced degrade — approval source unavailable");
  };
  return {
    id: "e2e-degrade",
    title: "E2E forced-degrade source",
    availability: () => "ready",
    appliesTo: () => true,
    counts: async () => ({ inbox: 0, mine: 0 }),
    fetchInbox: fail,
    fetchMine: fail,
    rowRenderer: () => null,
    actions: {
      decide: async () => ({
        ok: false,
        code: "e2e_degrade",
        kind: "transient",
        message: "e2e forced-degrade source cannot decide",
      }),
    },
  };
}

/** The `deps.sources` list that forces a degraded initial page (e2e only). */
export function e2eDegradedApprovalSources(): ApprovalSource[] {
  return [e2eThrowingApprovalSource()];
}
