import "server-only";

import { createElement } from "react";
import { formatDistanceToNow } from "date-fns";

import { Badge } from "@/components/ui/badge";
import {
  approvalAwaitsDecision,
  approveDynamicTypeArtifactVisibility,
  listDynamicTypeVisibilityReviewRows,
  type DynamicTypeVisibilityReviewRow,
} from "@/lib/objects/artifact-visibility-approval";

import { DynamicTypeVisibilityDecisionActions } from "../dynamic-type-visibility-decision-actions";
import {
  dynamicTypeArtifactVisibilityContract,
  DYNAMIC_TYPE_VISIBILITY_SOURCE_ID,
} from "./dynamic-type-artifact-visibility.contract";
import type {
  ApprovalEnvelope,
  ApprovalRow,
  ApprovalSource,
  ApprovalViewer,
  DecideInput,
  DecideResult,
  Direction,
} from "./types";

// ---------------------------------------------------------------------------
// Approval source — org-scoped dynamic-type ARTIFACT COVERAGE (cinatra#1433).
//
// Dynamic object types are minted globally (`dynamic_object_types`, PK=type)
// and MCP/install paths mint them `status='active'` without any admin
// decision, so 'active' cannot mean "surface these rows as artifacts here".
// This source is the org's decision surface: approving a row writes the
// org-scoped DEFAULT `artifact_type_claims` record (the default-artifact floor
// extension) through `approveDynamicTypeArtifactVisibility` — from then on the
// type's rows resolve to the default artifact (truth-table rows 7–8), yield to
// a dedicated claimant, and fall back on its retirement with NO re-approval.
//
//   Inbox — admin only. One row per ACTIVE dynamic type that has no approval
//           record for the viewer's org, with an APPROVE-only affordance: an
//           undecided type's rows simply stay plain objects (fail-closed), so
//           "reject" is not deciding.
//   Your requests — NONE. Dynamic types are minted by the classifier / MCP /
//           install machinery, never requested by a user (`appliesTo` returns
//           false for `mine`); `fetchMine` is an empty envelope for defense in
//           depth.
//
// No edit-after-view token: the decide re-checks the type's live status and
// the existing-approval state at its source (a type archived or approved
// between view and decide refuses), and approval carries no viewed-content
// payload an edit could invalidate.
// ---------------------------------------------------------------------------

/** Adapter-private row payload (only this source's rowRenderer reads it). */
interface DynamicTypeRowRaw {
  category: string;
  mintedBy: string | null;
}

function toRow(r: DynamicTypeVisibilityReviewRow): ApprovalRow {
  const raw: DynamicTypeRowRaw = { category: r.category, mintedBy: r.mintedBy };
  return {
    // The namespaced type id IS the row id (opaque round-trip for MCP decide;
    // the org scope is NEVER carried in the id — decide always confines to the
    // authenticated viewer's org).
    id: r.objectTypeId,
    sourceId: DYNAMIC_TYPE_VISIBILITY_SOURCE_ID,
    title: r.displayName,
    subtitle: r.objectTypeId,
    status: r.approval == null ? "unapproved" : r.approval.status,
    createdAt: r.createdAt,
    raw,
  };
}

function readyEnvelope(rows: ApprovalRow[]): ApprovalEnvelope {
  return {
    availability: "ready",
    rows,
    // APPROVE-only: an undecided dynamic type's rows stay plain objects (no
    // coverage conveyed), so there is no "reject". Local enforcement: the
    // Inbox is admin-only up front.
    actions: [{ id: "approve", label: "Approve coverage", enforcement: "local" }],
  };
}

/**
 * Non-redirecting decide. APPROVE-only. Re-checks the admin gate here (never
 * widens authority — the same gate `appliesTo` uses for section visibility)
 * and always targets the AUTHENTICATED viewer's org (the row id carries only
 * the type id, so a hand-crafted MCP decide can never name another org's
 * scope). Shared by the UI server action and the `approvals_*` MCP tools.
 */
async function decideDynamicTypeVisibility(
  input: DecideInput,
  viewer: ApprovalViewer,
): Promise<DecideResult> {
  if (!viewer.isAdmin) {
    return {
      ok: false,
      kind: "forbidden",
      code: "not_admin",
      message: "Only an admin can approve artifact coverage for a dynamic type.",
    };
  }
  if (input.action !== "approve") {
    return {
      ok: false,
      kind: "refused",
      code: "unknown_action",
      message: `unknown action '${input.action}' — dynamic-type artifact coverage is approve-only (an undecided type's rows stay plain objects).`,
    };
  }
  const objectTypeId = input.rowId.trim();
  if (!objectTypeId) {
    return { ok: false, kind: "refused", code: "not_found", message: "Unknown dynamic-type row." };
  }
  const res = await approveDynamicTypeArtifactVisibility({
    orgId: viewer.orgId,
    objectTypeId,
    approvedBy: viewer.userId,
  });
  if (res.ok) return { ok: true };
  switch (res.code) {
    case "not_found":
      return { ok: false, kind: "refused", code: "not_found", message: res.message };
    case "not_active":
      return { ok: false, kind: "refused", code: "invalid_state", message: res.message };
    case "already_approved":
      return { ok: false, kind: "refused", code: "invalid_state", message: res.message };
    case "claim_conflict":
      return { ok: false, kind: "refused", code: "conflict", message: res.message };
    default:
      return { ok: false, kind: "transient", code: "unknown", message: res.message };
  }
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active":
      return "default";
    case "unapproved":
      return "secondary";
    default:
      return "outline";
  }
}

export const dynamicTypeArtifactVisibilitySource: ApprovalSource = {
  // Light nav contract (id / availability / appliesTo / counts) — the SAME
  // function references the nav registry consumes, so the sidebar badge and
  // this page can never disagree (registry-parity.test.ts).
  ...dynamicTypeArtifactVisibilityContract,
  title: "Dynamic-type artifact coverage",

  async fetchInbox(viewer): Promise<ApprovalEnvelope> {
    if (!viewer.isAdmin) return readyEnvelope([]);
    const rows = await listDynamicTypeVisibilityReviewRows({ orgId: viewer.orgId });
    // Inbox = awaiting the org decision (no record, OR a stranded 'reserved'
    // record whose activation is owed — re-deciding it runs the approve
    // self-heal). Activated approvals are records, not pending work (their
    // lifecycle continues in the claim registry).
    return readyEnvelope(rows.filter((r) => approvalAwaitsDecision(r.approval)).map(toRow));
  },

  // No "Your requests" view — dynamic types are minted by the classifier /
  // MCP / install machinery, never by a user (`appliesTo` returns false for
  // `mine`). Empty for defense in depth so a direct fetch never leaks a row
  // into the wrong direction.
  async fetchMine(): Promise<ApprovalEnvelope> {
    return readyEnvelope([]);
  },

  rowRenderer(row: ApprovalRow, ctx: { direction: Direction }) {
    const raw = (row.raw ?? {}) as DynamicTypeRowRaw;
    const minted = formatDistanceToNow(new Date(row.createdAt), { addSuffix: true });

    const titleLine = createElement(
      "div",
      { className: "flex flex-wrap items-center gap-2 min-w-0" },
      createElement("span", { className: "font-medium text-foreground truncate" }, row.title),
      createElement(Badge, { variant: statusVariant(row.status), className: "capitalize" }, row.status),
    );

    const typeMeta = createElement(
      "p",
      { className: "mt-0.5 text-xs text-muted-foreground" },
      `${row.subtitle ?? ""} · ${raw.category ?? "uncategorized"}` +
        `${raw.mintedBy ? ` · minted by ${raw.mintedBy}` : ""} · registered ${minted}`,
    );

    const coverageMeta = createElement(
      "p",
      { className: "mt-1 text-xs text-foreground" },
      "Approving surfaces rows of this type as default artifacts for your organization (conservative dispositions; yields to a dedicated artifact extension).",
    );

    // Approve only in the Inbox (the only direction this source renders); a
    // "mine" direction never reaches here (appliesTo = false for mine).
    const right =
      ctx.direction === "inbox"
        ? createElement(DynamicTypeVisibilityDecisionActions, {
            sourceId: row.sourceId,
            rowId: row.id,
          })
        : null;

    return createElement(
      "div",
      { className: "flex flex-wrap items-start justify-between gap-3 px-4 py-3" },
      createElement("div", { className: "min-w-0" }, titleLine, typeMeta, coverageMeta),
      createElement("div", { className: "flex shrink-0 items-center gap-3" }, right),
    );
  },

  actions: { decide: decideDynamicTypeVisibility },
};
