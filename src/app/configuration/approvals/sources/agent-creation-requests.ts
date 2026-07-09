import "server-only";

import { createElement } from "react";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { readConnectorConfigFromDatabase } from "@/lib/database";
import { countOtherPlatformAdmins } from "@/lib/better-auth-db";
import {
  listAgentCreationRequests,
  type AgentCreationRequestRow,
  type AgentCreationRequestStatus,
} from "@/lib/agent-creation-requests-store";

import { decideAgentCreationRequest } from "../decision-helpers";
import { AGENT_SOURCE_ID } from "../resolve-active-view";
import { AgentDecisionActions } from "../agent-decision-actions";
import type {
  ApprovalEnvelope,
  ApprovalRow,
  ApprovalSource,
  ApprovalViewer,
  Direction,
  FetchOpts,
  SourceCounts,
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

/** Mirror of the decide primitive's `connector_config.agent_creation.allowSelfApproval`
 *  read (canonical owner: the agent-creation-request MCP handler) so the Inbox
 *  self-inclusion matches when a self-approval would actually be permitted. */
function isSelfApprovalAllowed(): boolean {
  try {
    const cfg = readConnectorConfigFromDatabase<{ allowSelfApproval?: boolean }>("agent_creation", {});
    return cfg.allowSelfApproval === true;
  } catch {
    return false;
  }
}

/** Whether `viewer` may clear their OWN proposal (single-admin exception, or the
 *  connector_config override). Matches the decide primitive's SoD guard. */
async function viewerMayApproveOwn(viewer: ApprovalViewer): Promise<boolean> {
  if (isSelfApprovalAllowed()) return true;
  const otherAdmins = await countOtherPlatformAdmins(viewer.userId);
  return otherAdmins === 0;
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
    // PUBLIC CAS token — the non-private mirror of `raw.snapshotHash` an MCP
    // caller round-trips into approvals_decide (`expectedVersion`). The decide
    // helper still refuses when it is absent/stale (captured, never read fresh).
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
  id: AGENT_SOURCE_ID,
  title: "Agent creation requests",

  availability() {
    // Local source — always exists for an org'd viewer (admins see Inbox+Mine,
    // any author sees Mine). Per-direction visibility is handled by appliesTo.
    return "ready";
  },

  appliesTo(viewer, direction) {
    // Mine is available to any author; Inbox is admin-only (no admin fetch, no
    // leak, for a non-admin) — decided WITHOUT a privileged fetch.
    return direction === "mine" ? true : viewer.isAdmin;
  },

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

  async counts(viewer): Promise<SourceCounts> {
    // Ignores any history filter — always the actionable/in-flight count.
    let inbox = 0;
    if (viewer.isAdmin) {
      const proposed = listAgentCreationRequests({ orgId: viewer.orgId, status: "proposed" });
      const includeOwn =
        proposed.some((r) => r.authorId === viewer.userId) && (await viewerMayApproveOwn(viewer));
      inbox = proposed.filter((r) => r.authorId !== viewer.userId || includeOwn).length;
    }
    const mine = listAgentCreationRequests({
      orgId: viewer.orgId,
      authorId: viewer.userId,
      status: "proposed",
    }).length;
    return { inbox, mine };
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
