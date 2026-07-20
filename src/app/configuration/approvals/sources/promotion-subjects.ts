import "server-only";

// ---------------------------------------------------------------------------
// Shared promotion source — the SUBJECT-TYPE seam (cinatra#1560, E10 of #1549).
//
// The three planned promotion approvals — memory row promotion (#1381),
// artifact row-scope promotion (#1437), and any future row-scope promotion —
// are near-identical: an authorized principal requests widening a PRIVATE row's
// visibility (user→team→org), a reviewer approves/rejects, the approval is
// CAS-bound to the exact reviewed row version (a concurrent edit supersedes),
// content is secret/PII-scanned fail-closed, and widening is never-narrow. Only
// the subject differs (which store, which authorization, which re-projection).
//
// So instead of N near-duplicate ApprovalSource adapters, there is ONE source
// (`promotion-requests`) that federates over a registry of thin
// `PromotionSubjectAdapter`s keyed by a `subjectType` DISCRIMINATOR. Each flow
// implements a narrow {@link PromotionBackend} (list / count / cheap-gate /
// CAS-decide) and registers a descriptor here; the shared source
// (`promotion-requests.ts`) owns all the ApprovalSource-contract mechanics
// (row envelope, the unified-feed row shape, decide routing, counts,
// rendering) so a new subject type is a descriptor + a backend, never a new
// source, route, or MCP change.
//
// IMPORT-LIGHT: this module + the adapters + their backends must stay off the
// heavy decide/render graph (`../decision-helpers`, any `*decision-actions`
// React client, the agents runtime) so the sidebar-badge nav graph that reaches
// the light `promotion-requests.contract.ts` → here stays pure
// (nav-registry-import-purity.test.ts). A subject BACKEND is a plain data-layer
// module (DB read/CAS-write helpers) — NEVER a decision component. (The former
// dynamic-type `artifact-visibility-approval` backend that once modeled this
// pattern was removed with the engine teardown — epic #1785 entry 95, #1793.)
// ---------------------------------------------------------------------------

import { artifactPromotionBackend } from "./artifact-promotion";
import { PROMOTION_SOURCE_ID } from "./source-ids";
import type {
  ApprovalNavSource,
  ApprovalViewer,
  Direction,
  SourceCounts,
} from "./types";

// ── Subject-type discriminator & canonical row id ──────────────────────────
//
// The UI server action and the `approvals_*` MCP tools dispatch a decision by
// `{ sourceId, rowId }` ONLY (they are source-agnostic). This source has ONE
// `sourceId`, so the subject-type discriminator MUST ride the row id. It is also
// the sole tie-break + dedup key on the unified feed (all rows share ONE
// `sourceKey = canonicalSourceKey("promotion-requests")`), so a
// subject-type-prefixed id is what keeps cursor pagination stable and collision-
// free across subject types. Format: `<subjectType>:<subjectId>`, split at the
// FIRST colon so a subjectId may itself contain colons (memory/artifact object
// ids can, e.g. `@cinatra-ai/dynamic:foo`).

export type PromotionSubjectType = string;

export interface ParsedPromotionRowId {
  subjectType: PromotionSubjectType;
  subjectId: string;
}

/** Canonical row-id formatter — the ONE place a promotion row id is built. */
export function formatPromotionRowId(subjectType: PromotionSubjectType, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

/** Parse a promotion row id back to its subject type + subject id. Splits at the
 *  FIRST colon (subjectIds may contain colons). Returns null for a malformed id
 *  (no colon, empty subjectType, or empty subjectId) so decide fails closed
 *  rather than routing to a wrong/undefined adapter. */
export function parsePromotionRowId(rowId: string): ParsedPromotionRowId | null {
  const idx = rowId.indexOf(":");
  if (idx <= 0) return null; // no colon, or empty subjectType
  const subjectType = rowId.slice(0, idx);
  const subjectId = rowId.slice(idx + 1);
  if (!subjectId) return null;
  return { subjectType, subjectId };
}

// ── Backend seam (implemented per flow: #1381 memory, #1437 artifact, …) ────

/** A pending/decided promotion request row as the subject's own store sees it —
 *  the SUBJECT-NATIVE shape the shared source maps onto an `ApprovalRow`. */
export interface PromotionBackendRow {
  /** Subject-native id (NOT prefixed — the shared source prefixes it). */
  subjectId: string;
  /** Human title of the row being promoted (never a raw internal id). */
  title: string;
  subtitle?: string;
  /** Subject-native status token (e.g. `pending`), rendered to a pill. */
  status: string;
  /** ISO timestamp the request was created. */
  createdAt: string;
  /** PUBLIC optimistic-concurrency token — the CAS value captured at review
   *  (e.g. the row-version hash the approval binds to). Surfaced as the public
   *  `ApprovalRow.version` and required back on decide so an edit-after-view
   *  supersedes. A backend with no concurrency guard omits it. */
  version?: string;
  /** OPTIONAL display-only detail (source→target scope, requester, …) shown by
   *  the generic renderer. Display-safe strings only; never a private payload. */
  detail?: PromotionRowDetail;
}

/** Display-only promotion detail carried in the (adapter-private) row `raw`. */
export interface PromotionRowDetail {
  fromScope?: string;
  toScope?: string;
  requestedBy?: string;
  note?: string;
}

export type PromotionDecideCode =
  | "not_found"
  | "not_authorized"
  | "stale_snapshot"
  | "version_required"
  | "narrowing"
  | "secret_scan"
  | "invalid_state"
  | "conflict"
  | "transient";

export type PromotionDecideOutcome =
  | { ok: true }
  | { ok: false; code: PromotionDecideCode; message: string };

export interface PromotionDecideArgs {
  subjectId: string;
  /** `approve` | `reject`. A reject carries `reason`. */
  action: string;
  reason?: string;
  /** The CAS token from the reviewed row (`ApprovalRow.version`). */
  expectedVersion?: string;
  viewer: ApprovalViewer;
}

/**
 * The narrow contract each promotion flow implements. Every method is
 * data-layer only — NO decide-helper / React import — so the light nav graph
 * stays pure. Authorization + CAS live HERE (subject-specific), behind the
 * shared adapter, exactly as the issue specifies.
 */
export interface PromotionBackend {
  /** CHEAP synchronous gate — may this viewer review (approve/reject) inbound
   *  promotion requests for this subject? Decided WITHOUT a privileged fetch
   *  (e.g. `viewer.isAdmin` / a role bit already on the viewer). The real
   *  per-row authority is re-checked in {@link decide}. */
  canReview(viewer: ApprovalViewer): boolean;
  /** CHEAP synchronous gate — may this viewer have OWN promotion requests
   *  ("Your requests")? Usually any member. */
  canRequest(viewer: ApprovalViewer): boolean;
  /** Pending requests THIS viewer must decide (someone else's requests). */
  listInbox(viewer: ApprovalViewer): Promise<PromotionBackendRow[]>;
  /** The viewer's OWN requests for the requested history window. */
  listMine(viewer: ApprovalViewer, opts?: { status?: string }): Promise<PromotionBackendRow[]>;
  countInbox(viewer: ApprovalViewer): Promise<number>;
  countMine(viewer: ApprovalViewer): Promise<number>;
  /** Non-redirecting CAS decide — authorization + version guard + never-narrow +
   *  fail-closed secret scan + atomic apply live here. */
  decide(args: PromotionDecideArgs): Promise<PromotionDecideOutcome>;
}

/** A registered promotion subject type. `backend: null` = the flow's backend is
 *  not built yet — the descriptor is a live PLUG POINT (the source stays dormant
 *  for it, contributing no rows/counts and no availability) until the owning
 *  flow lands its backend. */
export interface PromotionSubjectAdapter {
  /** The discriminator — the row-id prefix AND the subject-type key. Must not
   *  contain a colon. */
  subjectType: PromotionSubjectType;
  /** Human label for the subject kind (e.g. "Memory", "Artifact"), shown as a
   *  badge by the generic renderer. */
  kindLabel: string;
  /** The subject's data-layer implementation, or null until the flow builds it. */
  backend: PromotionBackend | null;
}

// ── The registry (compile-time / immutable — DI for tests, no global mutation) ──
//
// TWO subject types are registered structurally, proving the discriminator
// carries ≥2 flows through ONE source. Both ship `backend: null` — the source is
// DORMANT (availability `not_configured`) until #1381 / #1437 each plug their
// backend into the descriptor below. Tests exercise the exact seam with a
// fixture backend via the exported builders (never by mutating this array).

/** Memory row promotion (#1381). Backend lands with that flow. */
export const memoryPromotionAdapter: PromotionSubjectAdapter = {
  subjectType: "memory",
  kindLabel: "Memory",
  // TODO(cinatra#1381): plug the memory-promotion backend here.
  backend: null,
};

/** Artifact row-scope promotion (#1437). Widens an individual artifact row's
 *  visibility (private → team | organization) through this shared source; the
 *  backend owns authorization + CAS + never-narrow + fail-closed secret/PII scan
 *  + atomic row-widen/re-projection/audit. */
export const artifactPromotionAdapter: PromotionSubjectAdapter = {
  subjectType: "artifact",
  kindLabel: "Artifact",
  backend: artifactPromotionBackend,
};

export const promotionSubjectAdapters: readonly PromotionSubjectAdapter[] = [
  memoryPromotionAdapter,
  artifactPromotionAdapter,
];

// ── Light contract builder (availability / appliesTo / counts) ──────────────
//
// Pure over the adapter list — the ONLY thing the import-light
// `promotion-requests.contract.ts` (and the nav registry) needs. Built once and
// SPREAD into the heavy source so the sidebar badge and the feed can never
// disagree (registry-parity.test.ts: same function references). Exposed as a
// builder so tests can construct a fixture-backed contract/source over the same
// code path (DI — never global mutation).

/** A registered subject whose backend is present (configured). */
type ConfiguredAdapter = PromotionSubjectAdapter & { backend: PromotionBackend };

/** Adapters whose backend is present (configured). The return type PRESERVES the
 *  non-null `backend` narrowing so callers don't re-check. */
function configured(adapters: readonly PromotionSubjectAdapter[]): ConfiguredAdapter[] {
  return adapters.filter((a): a is ConfiguredAdapter => a.backend != null);
}

export function buildPromotionContract(
  adapters: readonly PromotionSubjectAdapter[],
): ApprovalNavSource {
  return {
    id: PROMOTION_SOURCE_ID,

    availability(): "ready" | "not_configured" {
      // Ready once ANY subject backend is plugged in; dormant otherwise so the
      // page/feed AND the sidebar badge (byte-identical `not_configured` filter)
      // both drop the source until a flow lands.
      return configured(adapters).length > 0 ? "ready" : "not_configured";
    },

    appliesTo(viewer: ApprovalViewer, direction: Direction): boolean {
      // Cheap, fetch-free: the viewer participates in a direction iff SOME
      // configured subject lets them (review for inbox, request for mine).
      return configured(adapters).some((a) =>
        direction === "inbox" ? a.backend.canReview(viewer) : a.backend.canRequest(viewer),
      );
    },

    async counts(viewer: ApprovalViewer): Promise<SourceCounts> {
      // Self-gating per subject: a subject the viewer can't review/request
      // contributes 0, so the badge never leaks a count the page won't show.
      // Collect-then-sum (NOT `+= await` in the map) — a read-modify-write over a
      // shared accumulator across concurrent async closures loses updates.
      const perSubject = await Promise.all(
        configured(adapters).map(async (a) => ({
          inbox: a.backend.canReview(viewer) ? await a.backend.countInbox(viewer) : 0,
          mine: a.backend.canRequest(viewer) ? await a.backend.countMine(viewer) : 0,
        })),
      );
      return {
        inbox: perSubject.reduce((s, c) => s + c.inbox, 0),
        mine: perSubject.reduce((s, c) => s + c.mine, 0),
      };
    },
  } satisfies ApprovalNavSource;
}
