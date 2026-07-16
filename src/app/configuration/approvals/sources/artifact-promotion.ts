import "server-only";

// ---------------------------------------------------------------------------
// Artifact row-scope promotion — the PromotionBackend for subject type
// "artifact" (cinatra#1437, epic #1424). Plugs into the shared promotion
// ApprovalSource seam (#1560): the source owns the row envelope, decide
// routing, counts, the unified /notifications feed row + inline approve/reject
// and the approvals_* MCP surface; THIS backend owns the subject-specific
// authorization + CAS + never-narrow + fail-closed secret/PII scan + atomic
// row-widen/re-projection/audit, all in the `@/lib/objects/artifact-row-promotion`
// data layer.
//
// IMPORT-LIGHT: this module is reached from the light promotion contract (via
// `promotion-subjects.ts`, which the sidebar-badge nav graph imports), so it
// imports ONLY the data layer (whose heavy readers/writers are themselves
// lazy-imported) and TYPE-ONLY seam shapes — never a decision-helper or a React
// decision component (nav-registry-import-purity.test.ts).
// ---------------------------------------------------------------------------

import {
  countArtifactPromotionInbox,
  countArtifactPromotionMine,
  decideArtifactPromotion,
  listArtifactPromotionInbox,
  listArtifactPromotionMine,
  type ArtifactPromotionReviewRow,
} from "@/lib/objects/artifact-row-promotion";

import type {
  PromotionBackend,
  PromotionBackendRow,
  PromotionDecideArgs,
  PromotionDecideOutcome,
} from "./promotion-subjects";
import type { ApprovalViewer } from "./types";

/** Human scope labels for the generic renderer's "from → to" line (raw tokens
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

function toBackendRow(r: ArtifactPromotionReviewRow): PromotionBackendRow {
  return {
    subjectId: r.requestId,
    title: r.title,
    status: r.status,
    createdAt: r.createdAt,
    version: r.version,
    detail: {
      fromScope: scopeLabel(r.fromScope),
      toScope: scopeLabel(r.toScope),
      requestedBy: r.requestedBy,
    },
  };
}

/**
 * The artifact promotion backend. `canReview` is admin-only (the cheap gate the
 * shared source uses for inbox visibility/counts); the real per-row authority +
 * the CAS/never-narrow/scan ladder are re-checked in `decide`. `canRequest` is
 * any member (a requester awaits an admin's decision).
 */
export const artifactPromotionBackend: PromotionBackend = {
  canReview(viewer: ApprovalViewer): boolean {
    return viewer.isAdmin;
  },

  canRequest(): boolean {
    return true;
  },

  async listInbox(viewer: ApprovalViewer): Promise<PromotionBackendRow[]> {
    const rows = await listArtifactPromotionInbox({ orgId: viewer.orgId, reviewerId: viewer.userId });
    return rows.map(toBackendRow);
  },

  async listMine(viewer: ApprovalViewer, opts?: { status?: string }): Promise<PromotionBackendRow[]> {
    const rows = await listArtifactPromotionMine({
      orgId: viewer.orgId,
      requesterId: viewer.userId,
      ...(opts?.status ? { status: opts.status } : {}),
    });
    return rows.map(toBackendRow);
  },

  async countInbox(viewer: ApprovalViewer): Promise<number> {
    return countArtifactPromotionInbox({ orgId: viewer.orgId, reviewerId: viewer.userId });
  },

  async countMine(viewer: ApprovalViewer): Promise<number> {
    return countArtifactPromotionMine({ orgId: viewer.orgId, requesterId: viewer.userId });
  },

  async decide(args: PromotionDecideArgs): Promise<PromotionDecideOutcome> {
    // The data-layer decide codes are identical strings to PromotionDecideCode,
    // so the outcome maps 1:1.
    return decideArtifactPromotion({
      requestId: args.subjectId,
      action: args.action,
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.expectedVersion ? { expectedVersion: args.expectedVersion } : {}),
      viewer: args.viewer,
    });
  },
};
