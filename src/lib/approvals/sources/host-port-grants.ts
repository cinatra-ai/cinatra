import "server-only";

import { createElement } from "react";
import { formatDistanceToNow } from "date-fns";

import { Badge } from "@/components/ui/badge";
import {
  approveHostPortGrantUnion,
  listHostPortGrantReviewRows,
  type HostPortGrantReviewRow,
} from "@/lib/extension-host-port-grant-review";

import { HostPortGrantDecisionActions } from "../host-port-grant-decision-actions";
import {
  hostPortGrantsContract,
  HOST_PORT_GRANTS_SOURCE_ID,
} from "./host-port-grants.contract";
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
// Approval source — extension host-port grant UNION re-approval (cinatra#1391).
//
// The side-by-side grant-union choreography records a grown per-(package, org)
// PORT UNION through the real `recordRequestedGrant`, resetting the SHARED grant
// to `pending` (fail-closed: no runtime port is conveyed until re-approved).
// Previously INOPERABLE — no surface could re-approve a union that no single
// manifest requests. This source is that surface: it federates the pending grant
// rows into the unified `/configuration/approvals` Inbox (UI page) AND, via the
// shared `approvalSourceRegistry`, the `approvals_*` MCP tools — one backend
// (`extension-host-port-grant-review`), two arms.
//
//   Inbox — platform-admin only (host-port grants convey host capability;
//           platform-scoped org-less rows are visible here). Each row carries
//           the LIVE recomputed per-scope union + the per-version declaration
//           evidence, and an APPROVE-only affordance: an unapproved grant stays
//           pending, so "reject" is simply not deciding (withdraw = uninstall the
//           declaring version).
//   Your requests — NONE. Grants are requested by the install machinery, never
//           by a user (`appliesTo` returns false for `mine`); `fetchMine` is an
//           empty envelope for defense in depth.
//
// The `version` token a row carries is the grant's `requestedPortsHash` captured
// at render — echoed back on decide as `expectedVersion` so an edit-after-view
// (a sibling install/teardown between view and decide) is caught: the backend
// refuses `stale_snapshot`/`stale_request` rather than approve blind.
// ---------------------------------------------------------------------------

/** Adapter-private row payload (only this source's rowRenderer reads it). */
interface HostPortRowRaw {
  currentUnion: string[];
  perVersion: { version: string; isDefault: boolean; ports: string[] }[];
  stale: boolean;
}

/**
 * Stable, opaque row id encoding the grant's exact scope — a base64url JSON
 * `[packageName, orgId]` pair. Opaque both to the UI (captured at render, posted
 * back on decide) and to an MCP client (`approvals_get` → `approvals_decide`
 * round-trip). The `orgId` null (platform scope) round-trips faithfully.
 */
export function encodeHostPortGrantRowId(packageName: string, orgId: string | null): string {
  return Buffer.from(JSON.stringify([packageName, orgId]), "utf8").toString("base64url");
}

/** Inverse of {@link encodeHostPortGrantRowId}; malformed input → null (never a throw). */
export function decodeHostPortGrantRowId(
  rowId: string,
): { packageName: string; orgId: string | null } | null {
  try {
    const parsed = JSON.parse(Buffer.from(rowId, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [packageName, orgId] = parsed;
    if (typeof packageName !== "string" || packageName.length === 0) return null;
    if (orgId !== null && typeof orgId !== "string") return null;
    return { packageName, orgId };
  } catch {
    return null;
  }
}

function toRow(r: HostPortGrantReviewRow): ApprovalRow {
  const raw: HostPortRowRaw = {
    currentUnion: r.currentUnion,
    perVersion: r.perVersion,
    stale: r.stale,
  };
  return {
    id: encodeHostPortGrantRowId(r.packageName, r.orgId),
    sourceId: HOST_PORT_GRANTS_SOURCE_ID,
    title: r.packageName,
    subtitle: r.orgId ? `Org ${r.orgId}` : "Platform (all organizations)",
    status: r.status,
    createdAt: r.createdAt,
    // PUBLIC edit-after-view token — the grant's request hash captured at render;
    // round-tripped into decide's `expectedVersion` so a sibling install/teardown
    // between view and decide is caught (backend refuses stale_* rather than
    // approve blind), exactly as the inline UI does by capturing it at render.
    version: r.requestedPortsHash,
    raw,
  };
}

function readyEnvelope(rows: ApprovalRow[]): ApprovalEnvelope {
  return {
    availability: "ready",
    rows,
    // APPROVE-only: an unapproved union stays pending (no port conveyed), so
    // there is no "reject" — withdrawing means uninstalling the declaring
    // version. Local enforcement: the Inbox is admin-only up front.
    actions: [{ id: "approve", label: "Approve ports", enforcement: "local" }],
  };
}

/**
 * Map the review backend's structured refusal codes onto the approval decide
 * result kinds. Every business refusal is a VALUE (never a throw); an infra
 * error would throw out of the backend and be classified by the caller.
 */
function refuse(
  code: Awaited<ReturnType<typeof approveHostPortGrantUnion>> & { ok: false },
): Extract<DecideResult, { ok: false }> {
  switch (code.code) {
    case "not_authorized":
      return { ok: false, kind: "forbidden", code: "not_authorized", message: code.message };
    case "not_found":
      return { ok: false, kind: "refused", code: "not_found", message: code.message };
    case "not_pending":
      return { ok: false, kind: "refused", code: "invalid_state", message: code.message };
    case "version_required":
      return { ok: false, kind: "refused", code: "version_required", message: code.message };
    case "stale_snapshot":
      return { ok: false, kind: "refused", code: "stale_snapshot", message: code.message };
    case "stale_request":
      return { ok: false, kind: "refused", code: "stale_request", message: code.message };
    default:
      return { ok: false, kind: "transient", code: "unknown", message: code.message };
  }
}

/**
 * Non-redirecting decide for the host-port-grant source. APPROVE-only. Re-checks
 * the platform-admin gate here (never widens authority — the same gate
 * `appliesTo` uses for section visibility) and confines the decision to a scope
 * the viewer may act on (`[viewer.orgId, null]`), then delegates to the
 * union-aware backend under its own install lock. Shared by the UI server action
 * and the `approvals_*` MCP tools.
 */
async function decideHostPortGrant(input: DecideInput, viewer: ApprovalViewer): Promise<DecideResult> {
  if (!viewer.isAdmin) {
    return {
      ok: false,
      kind: "forbidden",
      code: "not_admin",
      message: "Only a platform admin can re-approve extension host-port grants.",
    };
  }
  if (input.action !== "approve") {
    return {
      ok: false,
      kind: "refused",
      code: "unknown_action",
      message: `unknown action '${input.action}' — host-port grants are approve-only (withdraw = uninstall the declaring version).`,
    };
  }
  const decoded = decodeHostPortGrantRowId(input.rowId);
  if (!decoded) {
    return { ok: false, kind: "refused", code: "not_found", message: "Unknown host-port grant row." };
  }
  // Scope confinement: a platform admin reviews their own org's rows + the
  // platform (org-less) rows. A row id naming a DIFFERENT org's scope is refused
  // (defense in depth — the Inbox never surfaces one, but a hand-crafted MCP
  // decide could).
  if (decoded.orgId !== null && decoded.orgId !== viewer.orgId) {
    return {
      ok: false,
      kind: "forbidden",
      code: "not_authorized",
      message: "You cannot re-approve a host-port grant for another organization's scope.",
    };
  }
  const res = await approveHostPortGrantUnion({
    packageName: decoded.packageName,
    orgId: decoded.orgId,
    approvedBy: viewer.userId,
    expectedRequestedPortsHash: input.expectedVersion?.trim() || undefined,
  });
  return res.ok ? { ok: true } : refuse(res);
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "approved":
      return "default";
    case "revoked":
      return "destructive";
    case "pending":
      return "secondary";
    default:
      return "outline";
  }
}

export const hostPortGrantsSource: ApprovalSource = {
  // Light nav contract (id / availability / appliesTo / counts) — the SAME
  // function references the nav registry consumes, so the sidebar badge and this
  // page can never disagree (registry-parity.test.ts).
  ...hostPortGrantsContract,
  title: "Extension host-port grants",

  async fetchInbox(viewer): Promise<ApprovalEnvelope> {
    if (!viewer.isAdmin) return readyEnvelope([]);
    const rows = await listHostPortGrantReviewRows({ orgIds: [viewer.orgId, null] });
    return readyEnvelope(rows.map(toRow));
  },

  // No "Your requests" view — grants are requested by the install machinery,
  // never by a user (`appliesTo` returns false for `mine`). Empty for defense in
  // depth so a direct fetch never leaks a row into the wrong direction.
  async fetchMine(): Promise<ApprovalEnvelope> {
    return readyEnvelope([]);
  },

  rowRenderer(row: ApprovalRow, ctx: { direction: Direction }) {
    const raw = (row.raw ?? {}) as HostPortRowRaw;
    const requested = formatDistanceToNow(new Date(row.createdAt), { addSuffix: true });
    const union = raw.currentUnion ?? [];

    const titleLine = createElement(
      "div",
      { className: "flex flex-wrap items-center gap-2 min-w-0" },
      createElement("span", { className: "font-medium text-foreground truncate" }, row.title),
      createElement(Badge, { variant: statusVariant(row.status), className: "capitalize" }, row.status),
      raw.stale
        ? createElement(Badge, { variant: "outline", className: "text-amber-600" }, "changed since viewed")
        : null,
    );

    const scopeMeta = createElement(
      "p",
      { className: "mt-0.5 text-xs text-muted-foreground" },
      `${row.subtitle ?? ""} · requested ${requested}`,
    );

    const unionMeta = createElement(
      "p",
      { className: "mt-1 text-xs text-foreground" },
      union.length > 0
        ? `Requested port union: ${union.join(", ")}`
        : "Requested port union: (none)",
    );

    const perVersionMeta =
      raw.perVersion && raw.perVersion.length > 0
        ? createElement(
            "ul",
            { className: "mt-0.5 space-y-0.5 text-xs text-muted-foreground" },
            ...raw.perVersion.map((v) =>
              createElement(
                "li",
                { key: v.version },
                `${v.version}${v.isDefault ? " (default)" : ""}: ${
                  v.ports.length > 0 ? v.ports.join(", ") : "(no ports)"
                }`,
              ),
            ),
          )
        : null;

    // Approve only in the Inbox (the only direction this source renders); a
    // "mine" direction never reaches here (appliesTo = false for mine).
    const right =
      ctx.direction === "inbox"
        ? createElement(HostPortGrantDecisionActions, {
            sourceId: row.sourceId,
            rowId: row.id,
            expectedVersion: row.version ?? "",
          })
        : null;

    return createElement(
      "div",
      { className: "flex flex-wrap items-start justify-between gap-3 px-4 py-3" },
      createElement("div", { className: "min-w-0" }, titleLine, scopeMeta, unionMeta, perVersionMeta),
      createElement("div", { className: "flex shrink-0 items-center gap-3" }, right),
    );
  },

  actions: { decide: decideHostPortGrant },
};
