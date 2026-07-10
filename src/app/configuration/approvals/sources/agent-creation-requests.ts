import "server-only";

import { createElement } from "react";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  listAgentCreationRequests,
  type AgentCreationRequestRow,
  type AgentCreationRequestStatus,
} from "@/lib/agent-creation-requests-store";

import { decideAgentCreationRequest } from "../decision-helpers";
import { AGENT_SOURCE_ID } from "../resolve-active-view";
import { AgentDecisionActions } from "../agent-decision-actions";
import {
  agentCreationRequestsContract,
  viewerMayApproveOwn,
} from "./agent-creation-requests.contract";
import type {
  ApprovalEnvelope,
  ApprovalRow,
  ApprovalSource,
  Direction,
  FetchOpts,
} from "./types";

// ---------------------------------------------------------------------------
// v1 source #1 — agent creation requests.
//
//   Inbox  — admin only: proposals awaiting a decision. A proposal the viewer
//            authored is normally Mine-only, but appears in Inbox flagged
//            "your own request" in the single-admin self-approval case (the
//            viewer is the sole eligible approver), mirroring the decide
//            primitive's own guard EXACTLY so the Inbox never shows a row the
//            viewer could not actually clear.
//   Mine   — any author: the viewer's own requests. Default window = in-flight
//            (proposed) + decided in the last 30 days; full history behind
//            `?status=`.
//
// Every empty state uses the design-system `Empty` family (rendered by the
// section), retiring the old plain-text agents-tab empty.
// ---------------------------------------------------------------------------

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Adapter-private row payload (only this source's rowRenderer reads it). */
interface AgentRowRaw {
  /** CAS token captured at render — fed back on an inline decision. */
  snapshotHash: string;
  rejectionReason: string | null;
}

function toRow(r: AgentCreationRequestRow, isOwnRequest: boolean): ApprovalRow {
  const raw: AgentRowRaw = { snapshotHash: r.snapshotHash, rejectionReason: r.rejectionReason };
  return {
    id: r.id,
    sourceId: AGENT_SOURCE_ID,
    title: `${r.packageName}@${r.packageVersion}`,
    subtitle: r.packageSlug,
    status: r.status,
    createdAt: r.createdAt,
    href: `/configuration/agents/approvals/${r.id}`,
    ...(isOwnRequest ? { isOwnRequest: true } : {}),
    // PUBLIC CAS token — mirrors the adapter-private raw.snapshotHash so the
    // MCP get/decide round-trip preserves the edit-after-view guard exactly as
    // the inline UI does by capturing raw.snapshotHash at render.
    version: r.snapshotHash,
    raw,
  };
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "approved":
    case "published":
      return "default";
    case "rejected":
      return "destructive";
    case "proposed":
      return "secondary";
    default:
      return "outline";
  }
}

const KNOWN_STATUSES: AgentCreationRequestStatus[] = [
  "draft",
  "proposed",
  "approved",
  "rejected",
  "published",
];

/** Select the "Your requests" rows for the requested history window. Default
 *  ("pending"/unset) = in-flight (proposed) + decided in the last 30 days. A
 *  whitelisted explicit status narrows to that status; `all` = full history. */
function selectMineRows(rows: AgentCreationRequestRow[], status: string | undefined): AgentCreationRequestRow[] {
  if (status === "all") return rows;
  if (status && KNOWN_STATUSES.includes(status as AgentCreationRequestStatus)) {
    return rows.filter((r) => r.status === status);
  }
  // Default window.
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  return rows.filter((r) => {
    if (r.status === "proposed") return true;
    if (!r.decidedAt) return false;
    const decided = Date.parse(r.decidedAt);
    return Number.isFinite(decided) && decided >= cutoff;
  });
}

function readyEnvelope(rows: ApprovalRow[]): ApprovalEnvelope {
  return {
    availability: "ready",
    rows,
    actions: [
      { id: "approve", label: "Approve", enforcement: "local" },
      { id: "reject", label: "Reject", intent: "destructive", enforcement: "local", requiresReason: true },
    ],
  };
}

export const agentCreationRequestsSource: ApprovalSource = {
  // Light nav contract (id / availability / appliesTo / counts) — the SAME
  // function references the nav registry consumes, so the sidebar badge and this
  // page can never disagree (registry-parity.test.ts).
  ...agentCreationRequestsContract,
  title: "Agent creation requests",

  async fetchInbox(viewer): Promise<ApprovalEnvelope> {
    if (!viewer.isAdmin) return readyEnvelope([]);
    const proposed = listAgentCreationRequests({ orgId: viewer.orgId, status: "proposed" });
    let includeOwn = false;
    if (proposed.some((r) => r.authorId === viewer.userId)) {
      includeOwn = await viewerMayApproveOwn(viewer);
    }
    const rows: ApprovalRow[] = [];
    for (const r of proposed) {
      const own = r.authorId === viewer.userId;
      if (own && !includeOwn) continue; // own proposal is Mine-only unless self-approvable
      rows.push(toRow(r, own));
    }
    return readyEnvelope(rows);
  },

  async fetchMine(viewer, opts?: FetchOpts): Promise<ApprovalEnvelope> {
    const all = listAgentCreationRequests({ orgId: viewer.orgId, authorId: viewer.userId, status: "all" });
    const selected = selectMineRows(all, opts?.status);
    return readyEnvelope(selected.map((r) => toRow(r, false)));
  },

  rowRenderer(row: ApprovalRow, ctx: { direction: Direction }) {
    const raw = (row.raw ?? {}) as AgentRowRaw;
    const requested = formatDistanceToNow(new Date(row.createdAt), { addSuffix: true });

    const titleLine = createElement(
      "div",
      { className: "flex flex-wrap items-center gap-2 min-w-0" },
      createElement(
        Link,
        { href: row.href ?? "#", className: "font-medium text-foreground hover:text-primary truncate" },
        row.title,
      ),
      createElement(Badge, { variant: statusVariant(row.status), className: "capitalize" }, row.status),
      row.isOwnRequest
        ? createElement(Badge, { variant: "outline", className: "text-xs" }, "your own request")
        : null,
    );

    const meta = createElement(
      "p",
      { className: "mt-0.5 text-xs text-muted-foreground" },
      `Requested ${requested}`,
      raw.rejectionReason ? ` · ${raw.rejectionReason}` : "",
    );

    const right =
      ctx.direction === "inbox"
        ? createElement(AgentDecisionActions, {
            sourceId: row.sourceId,
            rowId: row.id,
            expectedVersion: raw.snapshotHash ?? "",
            detailsHref: row.href ?? "#",
          })
        : createElement(
            Link,
            {
              href: row.href ?? "#",
              className: "text-xs text-muted-foreground underline hover:text-foreground",
            },
            "Details",
          );

    return createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3 px-4 py-3" },
      createElement("div", { className: "min-w-0" }, titleLine, meta),
      createElement("div", { className: "flex shrink-0 items-center gap-3" }, right),
    );
  },

  actions: { decide: decideAgentCreationRequest },
};
