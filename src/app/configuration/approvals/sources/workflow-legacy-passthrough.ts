import "server-only";

import { createElement } from "react";
import { format } from "date-fns";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  listPendingApprovalsForOrg,
  countPendingWorkflowApprovalsForOrg,
  type PendingApprovalSummary,
} from "@cinatra-ai/workflows/store";

import { WORKFLOW_SOURCE_ID } from "../resolve-active-view";
import type {
  ApprovalEnvelope,
  ApprovalRow,
  ApprovalSource,
  Direction,
  SourceCounts,
} from "./types";

// ---------------------------------------------------------------------------
// v1 source #2 — workflow legacy passthrough.
//
// Wraps the EXISTING org-scoped pending-approvals read with NO new workflow
// store functions (epic guard — #1035 drops the workflow tables this milestone).
// Removability is an acceptance requirement: deleting THIS ONE FILE + its
// registry line removes the source with zero page rework — the check that #1035
// needs no page changes. So this adapter depends on nothing under this route
// other than the shared contract.
//
// Non-regression guard: available to ANY actor with an active org (NOT
// admin-gated) — the passthrough must not be stricter than today's direct
// Workflows tab; those actors already decide from the workflow detail page,
// which is where each row links.
// ---------------------------------------------------------------------------

function toRow(r: PendingApprovalSummary): ApprovalRow {
  return {
    id: r.approvalId,
    sourceId: WORKFLOW_SOURCE_ID,
    title: r.workflowName,
    subtitle: `${r.taskTitle} (${r.taskKey})`,
    status: "pending",
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
    href: `/workflows/${r.workflowId}`,
    raw: {
      taskTitle: r.taskTitle,
      taskKey: r.taskKey,
      scopeLevel: (r.requiredScope as { level?: string } | null)?.level ?? null,
      deadlineUtc: r.deadlineUtc ? new Date(r.deadlineUtc).toISOString() : null,
    },
  };
}

interface WorkflowRowRaw {
  taskTitle: string;
  taskKey: string;
  scopeLevel: string | null;
  deadlineUtc: string | null;
}

export const workflowLegacyPassthroughSource: ApprovalSource = {
  id: WORKFLOW_SOURCE_ID,
  title: "Workflow approvals",

  // Read-only mirror: rows are decided on the workflow detail page (no inline
  // action; the decide() below benign-refuses). So this source renders as an
  // Inbox section for any org member but does NOT light the sidebar Approvals
  // nav on its own — keeping v1 nav admin-only (only the actionable agent
  // source lights it, for admins). Removed whole by #1035.
  inboxActionable: false,

  availability() {
    return "ready";
  },

  appliesTo(_viewer, direction: Direction) {
    // Inbox only — a workflow "Your requests" view is out of v1.
    return direction === "inbox";
  },

  async fetchInbox(viewer): Promise<ApprovalEnvelope> {
    const rows = viewer.orgId ? await listPendingApprovalsForOrg(viewer.orgId) : [];
    return { availability: "ready", rows: rows.map(toRow), actions: [] };
  },

  async fetchMine(): Promise<ApprovalEnvelope> {
    return { availability: "ready", rows: [], actions: [] };
  },

  async counts(viewer): Promise<SourceCounts> {
    const inbox = viewer.orgId ? await countPendingWorkflowApprovalsForOrg(viewer.orgId) : 0;
    return { inbox, mine: 0 };
  },

  rowRenderer(row: ApprovalRow) {
    const raw = (row.raw ?? {}) as WorkflowRowRaw;
    const titleLine = createElement(
      "div",
      { className: "flex flex-wrap items-center gap-2 min-w-0" },
      createElement(
        Link,
        { href: row.href ?? "#", className: "font-medium text-foreground hover:text-primary truncate" },
        row.title,
      ),
      createElement(
        Badge,
        { variant: "secondary", className: "font-mono text-xs" },
        raw.taskKey,
      ),
      raw.scopeLevel
        ? createElement(Badge, { variant: "outline", className: "text-xs" }, raw.scopeLevel)
        : null,
    );
    const meta = createElement(
      "p",
      { className: "mt-0.5 text-xs text-muted-foreground" },
      raw.taskTitle,
      raw.deadlineUtc ? ` · due ${format(new Date(raw.deadlineUtc), "MMM d, yyyy")}` : "",
      ` · waiting since ${format(new Date(row.createdAt), "MMM d, yyyy")}`,
    );
    const right = createElement(
      Link,
      { href: row.href ?? "#", className: "text-xs text-muted-foreground underline hover:text-foreground" },
      "Open workflow",
    );
    return createElement(
      "div",
      { className: "flex flex-wrap items-center justify-between gap-3 px-4 py-3" },
      createElement("div", { className: "min-w-0" }, titleLine, meta),
      createElement("div", { className: "flex shrink-0 items-center gap-3" }, right),
    );
  },

  actions: {
    // Workflow decisions happen on the workflow detail page in v1 (no inline
    // action, no new store fn). A decide call is a benign refusal.
    async decide() {
      return {
        ok: false,
        kind: "refused",
        code: "not_supported",
        message: "Workflow approvals are decided from the workflow page.",
      };
    },
  },
};
