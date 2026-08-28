import "server-only";

// ---------------------------------------------------------------------------
// Memory row promotion — the PromotionBackend for subject type "memory"
// (cinatra#1381, epic #1373). Plugs into the shared promotion ApprovalSource
// seam (#1560): the source owns the row envelope, decide routing, counts, the
// unified /notifications feed row + inline approve/reject and the approvals_*
// MCP surface; THIS backend owns the subject-specific authorization + CAS +
// transition matrix + fail-closed credential scan + the ATOMIC apply, all in
// the `@/lib/objects/memory-row-promotion` data layer.
//
// IMPORT-LIGHT: this module is reached from the light promotion contract (via
// `promotion-subjects.ts`, which the sidebar-badge nav graph imports), so it
// imports ONLY the data layer and TYPE-ONLY seam shapes — never a
// decision-helper or a React decision component
// (nav-registry-import-purity.test.ts).
// ---------------------------------------------------------------------------

import {
  countMemoryPromotionInbox,
  countMemoryPromotionMine,
  decideMemoryPromotion,
  listMemoryPromotionInbox,
  listMemoryPromotionMine,
  type MemoryPromotionReviewRow,
} from "@/lib/objects/memory-row-promotion";

import type {
  PromotionBackend,
  PromotionBackendRow,
  PromotionDecideArgs,
  PromotionDecideOutcome,
} from "./promotion-subjects";
import type { ApprovalViewer } from "./types";

/** Human scope labels for the generic renderer's "from -> to" line (raw tokens
 *  stay out of the UI). */
const SCOPE_LABEL: Readonly<Record<string, string>> = {
  private: "Private",
  team: "Team",
  organization: "Organization",
  public: "Public",
};

function scopeLabel(scope: string): string {
  return SCOPE_LABEL[scope] ?? scope;
}

/**
 * Map a subject-native review row onto the seam row.
 *
 * `subtitle` IS the memory-specific advisory duplicate signal, and it is the
 * ONLY extra thing this subject puts in front of an approver. It carries a
 * COUNT and nothing else — no title, no owner, no excerpt — and the count is
 * computed only over memory ALREADY visible to the requested target audience,
 * with every private row excluded in the SQL itself. So the line can tell an
 * approver "this audience already holds something with this identity" without
 * telling them anything about anyone's private memory.
 */
function toBackendRow(r: MemoryPromotionReviewRow, subtitle?: string | null): PromotionBackendRow {
  return {
    subjectId: r.requestId,
    title: r.title,
    ...(subtitle ? { subtitle } : {}),
    status: r.status,
    createdAt: r.createdAt,
    version: r.version,
    detail: {
      fromScope: scopeLabel(r.fromScope),
      // Reviewers must see the ACTUAL destination: a team target shows the
      // display-only name snapshot AND the IMMUTABLE team id, because names are
      // mutable and non-unique while the id is exactly what an approve writes
      // as the row's owner.
      toScope:
        r.toScope === "team"
          ? `${scopeLabel(r.toScope)}: ${r.toOwnerLabel ?? "(unnamed)"} [${r.toOwnerId}]`
          : scopeLabel(r.toScope),
      requestedBy: r.requestedBy,
    },
  };
}

/**
 * The memory promotion backend. `canReview` is admin-only (the cheap gate the
 * shared source uses for inbox visibility/counts); the real per-row authority —
 * including the membership-grounded org-write authority over the TARGET scope —
 * plus the CAS / matrix / scan ladder are re-checked in `decide`. `canRequest`
 * is any member (a requester awaits an admin's decision).
 */
export const memoryPromotionBackend: PromotionBackend = {
  canReview(viewer: ApprovalViewer): boolean {
    return viewer.isAdmin;
  },

  canRequest(): boolean {
    return true;
  },

  async listInbox(viewer: ApprovalViewer): Promise<PromotionBackendRow[]> {
    // The advisory duplicate hint rides the inbox read itself (the data layer
    // attaches it) — it exists to inform a DECISION, so it is never computed
    // for the requester's own list.
    const rows = await listMemoryPromotionInbox({ orgId: viewer.orgId, reviewerId: viewer.userId });
    return rows.map((r) => toBackendRow(r, r.duplicateHint));
  },

  async listMine(viewer: ApprovalViewer, opts?: { status?: string }): Promise<PromotionBackendRow[]> {
    const rows = await listMemoryPromotionMine({
      orgId: viewer.orgId,
      requesterId: viewer.userId,
      ...(opts?.status ? { status: opts.status } : {}),
    });
    return rows.map((r) => toBackendRow(r));
  },

  async countInbox(viewer: ApprovalViewer): Promise<number> {
    return countMemoryPromotionInbox({ orgId: viewer.orgId, reviewerId: viewer.userId });
  },

  async countMine(viewer: ApprovalViewer): Promise<number> {
    return countMemoryPromotionMine({ orgId: viewer.orgId, requesterId: viewer.userId });
  },

  async decide(args: PromotionDecideArgs): Promise<PromotionDecideOutcome> {
    // The data-layer decide codes are identical strings to PromotionDecideCode,
    // so the outcome maps 1:1.
    return decideMemoryPromotion({
      requestId: args.subjectId,
      action: args.action,
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.expectedVersion ? { expectedVersion: args.expectedVersion } : {}),
      viewer: args.viewer,
    });
  },
};
