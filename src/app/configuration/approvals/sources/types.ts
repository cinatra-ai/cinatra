/**
 * `ApprovalSource` adapter contract for the unified `/configuration/approvals`
 * surface (Inbox / "Your requests"). A source federates one approval family at
 * READ time — there is no unified table; every source stays authoritative and
 * every decision executes at its own source through a non-redirecting decision
 * helper that BOTH the UI server-action wrappers and the future MCP tools reuse.
 *
 * The data types here are framework-free so a non-React caller (e.g. the future
 * `approvals_*` MCP tools) can import the envelope / row / action / decide
 * shapes without pulling a UI runtime. Only `ApprovalSource.rowRenderer`
 * touches React, via a TYPE-ONLY `ReactNode` import that erases at build.
 *
 * The envelope / row / action / decide shapes are a deliberate SUPERSET for the
 * later slices (4-state connectivity, capped counts, remote row eligibility,
 * MCP list/get/decide) so those land as pure additions, not page rewrites.
 */
import type { ReactNode } from "react";

/**
 * Coarse "can this source EXIST for this viewer/org" state — NOT a per-direction
 * or per-row permission. The per-direction gate lives in {@link ApprovalSource.appliesTo}
 * and the fetch, so "Your requests" is never hidden merely because Inbox is
 * admin-only. `not_connected` / `not_configured` / `error` are exercised by the
 * marketplace sources in a later slice; the v1 local sources are always `ready`.
 */
export type Availability = "ready" | "not_connected" | "not_configured" | "error";

/** Which direction of the surface a section is being rendered for. */
export type Direction = "inbox" | "mine";

/** The authenticated viewer, resolved once by the page and passed to every source. */
export interface ApprovalViewer {
  userId: string;
  orgId: string;
  isAdmin: boolean;
}

/**
 * `local`  — eligibility is fully knowable up front (e.g. an admin-only action),
 *            so the UI can enable/disable it without a round-trip.
 * `action-time` — only the source can decide at action time (e.g. a remote
 *            separation-of-duties check); the UI shows the action optimistically
 *            and surfaces the source's refusal.
 */
export type ActionEnforcement = "local" | "action-time";

export interface ApprovalAction {
  /** STABLE machine action key ('approve' | 'reject' | …). Equals
   *  {@link DecideInput.action} and the future `approvals_decide` `action` param. */
  id: string;
  label: string;
  intent?: "default" | "destructive";
  enforcement: ActionEnforcement;
  requiresReason?: boolean;
}

/** OPTIONAL remote hint. When present the UI renders disabled/annotated
 *  actions; action-time enforcement at the source stays authoritative. */
export interface RowEligibility {
  can_approve?: boolean;
  can_reject?: boolean;
  reason?: string;
}

export interface ApprovalRow {
  id: string;
  sourceId: string;
  title: string;
  subtitle?: string;
  /** Source-native status token → rendered to a pill by the owning rowRenderer. */
  status: string;
  /** ISO timestamp. */
  createdAt: string;
  href?: string;
  eligibility?: RowEligibility;
  /** OPTIONAL PUBLIC optimistic-concurrency token — the source-opaque value a
   *  decision must echo back (e.g. the agent source's CAS snapshot hash). Unlike
   *  {@link raw} it is a PUBLIC string a non-owning caller MAY read/serialize:
   *  `approvals_get` returns it so an MCP client round-trips it into
   *  `approvals_decide`'s `expectedVersion`, preserving the same "captured at
   *  view" edit-after-view guard the UI gets by capturing it at render. A source
   *  needing no concurrency token omits it. */
  version?: string;
  /** ADAPTER-PRIVATE: only the owning source's rowRenderer may read it; nothing
   *  else may depend on its shape (e.g. the agent source stashes the CAS token). */
  raw?: unknown;
}

export interface ApprovalEnvelope {
  availability: Availability;
  rows: ApprovalRow[];
  actions: ApprovalAction[];
  error?: { message: string; retryable?: boolean };
}

/** Per-direction actionable counts. `counts()` reports the DEFAULT actionable
 *  window (it ignores any history filter) so it can feed the smart default
 *  direction and, later, the sidebar badge without a second round-trip. */
export interface SourceCounts {
  inbox: number;
  mine: number;
}

/** Optional per-source read options. `status` is a source-interpreted history
 *  filter (v1: the agent "Your requests" window). Marketplace / MCP callers
 *  ignore it. */
export interface FetchOpts {
  status?: string;
}

/** Non-redirecting decide input. `expectedVersion` is a source-interpreted
 *  optimistic-concurrency token captured at render (the agent source maps it to
 *  its snapshot hash); a source that needs it REFUSES when it is absent rather
 *  than reading a fresh value, so the "captured at render" guard is preserved. */
export type DecideInput = {
  rowId: string;
  action: string;
  reason?: string;
  expectedVersion?: string;
  /** Approval-time access scope — who can access the resource once approved
   *  (cinatra#1327). Consumed by the agent-creation source, whose approve is the
   *  install-equivalent moment and REQUIRES it (a publish is unreachable
   *  without it); other sources (e.g. vendor catalog moderation) ignore it —
   *  moderation admits a listing, it grants no access. */
  accessTarget?: { level: "organization" | "team" | "project"; id: string };
};

export type DecideKind = "refused" | "transient" | "forbidden";

/**
 * A business refusal is a VALUE, never a throw: separation-of-duties,
 * state-conflict and not-authorized are all `{ ok: false, kind }`. Throwing is
 * reserved for infra/programmer errors, which the caller (server-action wrapper
 * or MCP handler) classifies.
 */
export type DecideResult =
  | { ok: true; row?: ApprovalRow }
  | {
      ok: false;
      code: string;
      message: string;
      httpStatus?: number;
      kind: DecideKind;
    };

/**
 * The IMPORT-LIGHT half of {@link ApprovalSource} — everything the sidebar
 * Approvals nav badge needs and NOTHING that pulls a heavy runtime.
 *
 * The root layout (on every route's build graph) resolves the badge
 * `{ total, visible }` from this contract via `nav-registry.ts` +
 * `summarizeApprovalsNav`, so it must be derivable WITHOUT importing the
 * source's `rowRenderer` / decide `actions` — those drag `decision-helpers`
 * (→ `@cinatra-ai/agents/mcp-handlers`, the agents runtime) and the React
 * client decision-action components into the layout graph, OOMing `next build`
 * (cinatra#1283). Each source therefore exposes a `*.contract.ts` module
 * implementing THIS interface (`satisfies ApprovalNavSource`), consumed by the
 * light nav registry; the heavy `*.ts` source SPREADS its contract so the
 * count/visibility functions are the SAME references (no drift) while the
 * render/decide surface stays wired only to the `/configuration/approvals`
 * page. `ApprovalSource extends ApprovalNavSource`, so a full source is always
 * a valid nav source.
 */
export interface ApprovalNavSource {
  id: string;
  /**
   * Whether this source's Inbox is ACTIONABLE (a viewer it applies to can
   * decide a row) versus a read-only mirror whose rows are decided elsewhere.
   * OMITTED / `true` — actionable (the default; e.g. inline approve/reject).
   * `false` — read-only passthrough (e.g. the workflow legacy source, decided
   *   on the workflow detail page): it still renders as a section, but does NOT
   *   on its own light the sidebar Approvals nav item. This is what keeps nav
   *   visibility availability-driven yet admin-only in v1, and lets a future
   *   source that grants a non-admin an actionable Inbox surface the nav with
   *   no sidebar edit. It does NOT affect row rendering, counts, or decide.
   */
  inboxActionable?: boolean;
  /** Coarse existence gate — see {@link Availability}. */
  availability(viewer: ApprovalViewer): Availability | Promise<Availability>;
  /** Cheap per-direction section-visibility gate — decided WITHOUT a privileged
   *  fetch so a section the viewer can't participate in is never rendered (e.g.
   *  the agent Inbox is admin-only; the workflow passthrough has no "Your
   *  requests" view in v1). Distinct from "applicable but empty" (renders the
   *  `Empty` family). */
  appliesTo(viewer: ApprovalViewer, direction: Direction): boolean;
  /** Per-direction actionable counts feeding the sidebar badge and the
   *  direction-tab pills. Viewer-self-gating: reports 0 for a direction the
   *  viewer cannot act on / a section that is not configured, so the light nav
   *  reducer never leaks a count the page would not show. */
  counts(viewer: ApprovalViewer): Promise<SourceCounts>;
}

export interface ApprovalSource extends ApprovalNavSource {
  title: string;
  /** Optional section-header "View all" link target for a direction. Returns
   *  `undefined` for a direction that has no drill-down (e.g. a single-direction
   *  marketplace source in its OFF direction); the section renders no link then. */
  viewAllHref?: (dir: Direction) => string | undefined;
  /** OPTIONAL group tag. Sources sharing a group (e.g. the marketplace sources)
   *  collapse into ONE group-level "not connected" `Empty` + a single sources
   *  footer, instead of each rendering an independent section. Ungrouped (the v1
   *  local sources) render standalone as before. */
  group?: string;
  /** OPTIONAL per-direction credential gate, distinct from {@link appliesTo}
   *  (which is about whether the VIEWER can participate). A grouped source whose
   *  own per-direction credential is absent returns `false` here so the page
   *  HIDES that section and surfaces a one-line footer hint instead of firing a
   *  doomed remote call — "misconfiguration is never silently masked". A LOCAL
   *  read only (env / identity); it must not touch the network. Absent ⇒ the
   *  section is always considered configured. */
  sectionConfigured?(viewer: ApprovalViewer, direction: Direction): boolean;
  fetchInbox(viewer: ApprovalViewer, opts?: FetchOpts): Promise<ApprovalEnvelope>;
  fetchMine(viewer: ApprovalViewer, opts?: FetchOpts): Promise<ApprovalEnvelope>;
  rowRenderer(row: ApprovalRow, ctx: { direction: Direction }): ReactNode;
  actions: {
    decide(input: DecideInput, viewer: ApprovalViewer): Promise<DecideResult>;
  };
}
