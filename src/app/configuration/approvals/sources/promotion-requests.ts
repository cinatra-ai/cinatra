import "server-only";

import { createElement } from "react";
import { formatDistanceToNow } from "date-fns";

import { Badge } from "@/components/ui/badge";

import { PROMOTION_SOURCE_ID } from "./source-ids";
import { promotionRequestsContract } from "./promotion-requests.contract";
import {
  formatPromotionRowId,
  parsePromotionRowId,
  promotionSubjectAdapters,
  type PromotionBackendRow,
  type PromotionDecideOutcome,
  type PromotionRowDetail,
  type PromotionSubjectAdapter,
} from "./promotion-subjects";
import type {
  ApprovalEnvelope,
  ApprovalNavSource,
  ApprovalRow,
  ApprovalSource,
  ApprovalViewer,
  DecideInput,
  DecideResult,
  FetchOpts,
} from "./types";

// ---------------------------------------------------------------------------
// Shared promotion ApprovalSource (cinatra#1560, E10 of #1549).
//
// ONE source, N flows. It federates the registered `PromotionSubjectAdapter`s
// (`promotion-subjects.ts`) behind a subject-type discriminator carried in the
// row id (`<subjectType>:<subjectId>`), and owns every ApprovalSource-contract
// mechanic so a new promotion flow is a descriptor + a backend — never a new
// source, route, MCP tool, or feed change:
//
//   Inbox — promotion requests awaiting THIS viewer's review, federated across
//           every configured subject whose cheap `canReview` gate the viewer
//           passes. Each subject's backend re-checks per-row authority + the CAS
//           version at decide.
//   Mine  — the viewer's OWN pending promotion requests, federated across every
//           configured subject whose `canRequest` gate the viewer passes. Read-
//           only on the feed (a requester awaits others; the feed makes `mine`
//           rows non-actionable), so no self-decide affordance is surfaced here.
//
// Authorization + CAS are SUBJECT-SPECIFIC, behind each subject's backend; this
// source only routes. Decide dispatches by parsing the subject type off the row
// id (the UI action + `approvals_*` MCP tools carry only `{ sourceId, rowId }`).
//
// FAILURE SEMANTICS: `fetchInbox`/`fetchMine` do NOT swallow a subject backend
// failure — a throw PROPAGATES so the unified feed records the whole source as
// incomplete (`degraded`, no forward cursor). A partial "ready" envelope over a
// merged single-`sourceKey` stream would make keyset pagination unsound (the
// failed subject's above-cursor rows would be filtered out of later pages once
// it recovers), so failing the source's whole contribution for the pass is the
// sound, conservative choice.
//
// While every subject backend is unplugged the source is DORMANT (contract
// `availability` = `not_configured`); it produces no rows and is dropped by the
// `availableSources` / `availableNavSources` filters until #1381 / #1437 plug a
// backend into their descriptor.
// ---------------------------------------------------------------------------

/** Adapter-private row payload (only this source's rowRenderer reads it). Carries
 *  NO concurrency token — the CAS value is the PUBLIC {@link ApprovalRow.version}
 *  (so the MCP get/decide round-trip preserves the edit-after-view guard); `raw`
 *  holds only the subject discriminator + display-only detail. */
interface PromotionRowRaw {
  subjectType: string;
  kindLabel: string;
  detail?: PromotionRowDetail;
}

const PROMOTION_ACTIONS: ApprovalEnvelope["actions"] = [
  { id: "approve", label: "Approve", enforcement: "local" },
  {
    id: "reject",
    label: "Reject",
    intent: "destructive",
    enforcement: "local",
    requiresReason: true,
  },
];

function toApprovalRow(adapter: PromotionSubjectAdapter, r: PromotionBackendRow): ApprovalRow {
  const raw: PromotionRowRaw = {
    subjectType: adapter.subjectType,
    kindLabel: adapter.kindLabel,
    ...(r.detail ? { detail: r.detail } : {}),
  };
  return {
    // Subject-type-prefixed id — the discriminator for decide routing AND the
    // unique dedup/tie-break key under the single promotion `sourceKey`.
    id: formatPromotionRowId(adapter.subjectType, r.subjectId),
    sourceId: PROMOTION_SOURCE_ID,
    title: r.title,
    ...(r.subtitle !== undefined ? { subtitle: r.subtitle } : {}),
    status: r.status,
    createdAt: r.createdAt,
    ...(r.version !== undefined ? { version: r.version } : {}),
    raw,
  };
}

function readyEnvelope(rows: ApprovalRow[]): ApprovalEnvelope {
  return { availability: "ready", rows, actions: PROMOTION_ACTIONS };
}

/** Adapters whose backend is present (configured). */
function configuredAdapters(
  adapters: readonly PromotionSubjectAdapter[],
): (PromotionSubjectAdapter & { backend: NonNullable<PromotionSubjectAdapter["backend"]> })[] {
  return adapters.filter(
    (a): a is PromotionSubjectAdapter & { backend: NonNullable<PromotionSubjectAdapter["backend"]> } =>
      a.backend != null,
  );
}

function mapDecideOutcome(outcome: PromotionDecideOutcome): DecideResult {
  if (outcome.ok) return { ok: true };
  switch (outcome.code) {
    case "not_authorized":
    case "secret_scan":
      // Fail-closed authorization / content refusals.
      return { ok: false, kind: "forbidden", code: outcome.code, message: outcome.message };
    case "transient":
      return { ok: false, kind: "transient", code: outcome.code, message: outcome.message };
    default:
      // not_found / stale_snapshot / version_required / narrowing / invalid_state /
      // conflict — business refusals surfaced in place.
      return { ok: false, kind: "refused", code: outcome.code, message: outcome.message };
  }
}

// ── generic row renderer (contract-required; feed uses the VM path post-E8) ──

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "approved":
      return "default";
    case "rejected":
      return "destructive";
    case "pending":
    case "proposed":
      return "secondary";
    default:
      return "outline";
  }
}

function renderPromotionRow(row: ApprovalRow): ReturnType<typeof createElement> {
  const raw = (row.raw ?? {}) as PromotionRowRaw;
  const requested = formatDistanceToNow(new Date(row.createdAt), { addSuffix: true });
  const detail = raw.detail;
  const scopeLine =
    detail?.fromScope && detail?.toScope ? `${detail.fromScope} → ${detail.toScope}` : undefined;

  const titleLine = createElement(
    "div",
    { className: "flex flex-wrap items-center gap-2 min-w-0" },
    createElement("span", { className: "font-medium text-foreground truncate" }, row.title),
    createElement(Badge, { variant: "outline" }, raw.kindLabel ?? raw.subjectType ?? "Promotion"),
    createElement(Badge, { variant: statusVariant(row.status), className: "capitalize" }, row.status),
  );

  const meta = createElement(
    "p",
    { className: "mt-0.5 text-xs text-muted-foreground" },
    `Requested ${requested}` +
      (scopeLine ? ` · ${scopeLine}` : "") +
      (detail?.requestedBy ? ` · by ${detail.requestedBy}` : ""),
  );

  return createElement(
    "div",
    { className: "flex flex-wrap items-start justify-between gap-3 px-4 py-3" },
    createElement("div", { className: "min-w-0" }, titleLine, meta),
  );
}

// ── source builder (DI — tests build a fixture-backed source over this path) ──

/**
 * Build the shared promotion `ApprovalSource` over an adapter list, SPREADING
 * the supplied light contract so the nav (badge) and page/feed use the SAME
 * `availability`/`appliesTo`/`counts` references (registry-parity). Exposed so a
 * test can construct a fixture-backed source/contract via the same code path
 * (never by mutating the module registry).
 */
export function buildPromotionSource(
  contract: ApprovalNavSource,
  adapters: readonly PromotionSubjectAdapter[],
): ApprovalSource {
  return {
    ...contract,
    title: "Promotion requests",

    async fetchInbox(viewer): Promise<ApprovalEnvelope> {
      const rows: ApprovalRow[] = [];
      // Promise.all so a subject backend THROW propagates (→ feed `degraded`,
      // no unsound partial cursor) rather than yielding a partial ready page.
      await Promise.all(
        configuredAdapters(adapters).map(async (a) => {
          if (!a.backend.canReview(viewer)) return;
          const backendRows = await a.backend.listInbox(viewer);
          for (const r of backendRows) rows.push(toApprovalRow(a, r));
        }),
      );
      return readyEnvelope(rows);
    },

    async fetchMine(viewer, opts?: FetchOpts): Promise<ApprovalEnvelope> {
      const rows: ApprovalRow[] = [];
      await Promise.all(
        configuredAdapters(adapters).map(async (a) => {
          if (!a.backend.canRequest(viewer)) return;
          const backendRows = await a.backend.listMine(viewer, opts?.status ? { status: opts.status } : undefined);
          for (const r of backendRows) rows.push(toApprovalRow(a, r));
        }),
      );
      return readyEnvelope(rows);
    },

    rowRenderer(row: ApprovalRow) {
      return renderPromotionRow(row);
    },

    actions: {
      async decide(input: DecideInput, viewer: ApprovalViewer): Promise<DecideResult> {
        const parsed = parsePromotionRowId(input.rowId);
        if (!parsed) {
          return {
            ok: false,
            kind: "refused",
            code: "not_found",
            message: "Malformed promotion row id (expected '<subjectType>:<subjectId>').",
          };
        }
        const adapter = adapters.find((a) => a.subjectType === parsed.subjectType);
        if (!adapter || adapter.backend == null) {
          return {
            ok: false,
            kind: "refused",
            code: "not_found",
            message: `Unknown promotion subject type '${parsed.subjectType}'.`,
          };
        }
        if (input.action !== "approve" && input.action !== "reject") {
          return {
            ok: false,
            kind: "refused",
            code: "unknown_action",
            message: `unknown action '${input.action}' — promotion decisions are approve|reject.`,
          };
        }
        // A rejection REQUIRES a reason (the action advertises `requiresReason`).
        // Enforce it at the shared source BEFORE touching a backend so the
        // guarantee holds for a handcrafted server-action / MCP call, not just
        // the UI's `required` field — and so every subject backend inherits it
        // without re-implementing it.
        const reason = input.reason?.trim();
        if (input.action === "reject" && !reason) {
          return {
            ok: false,
            kind: "refused",
            code: "reason_required",
            message: "A rejection requires a reason.",
          };
        }
        const outcome = await adapter.backend.decide({
          subjectId: parsed.subjectId,
          action: input.action,
          ...(reason ? { reason } : {}),
          ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
          viewer,
        });
        return mapDecideOutcome(outcome);
      },
    },
  } satisfies ApprovalSource;
}

/** The registered shared promotion source (dormant until a subject backend is
 *  plugged in). Built over the SAME exported contract instance so the badge and
 *  the feed share function references (registry-parity.test.ts). */
export const promotionRequestsSource: ApprovalSource = buildPromotionSource(
  promotionRequestsContract,
  promotionSubjectAdapters,
);
