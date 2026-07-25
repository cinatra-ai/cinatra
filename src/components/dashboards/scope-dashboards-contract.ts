/**
 * Client/server seam types for the scope Dashboards tab (cinatra#1897 B4; the
 * ratified design spec at design@0ead5d0c5, `specs/app-artifacts.html` §IX).
 *
 * Provider-neutral (no `"use client"` / `"use server"`): the server page derives
 * the row/candidate view models + binds the server-action callbacks, and the
 * client tab consumes them. The client NEVER sees the scope's owner axis or the
 * actor — only these already-authorized view models and thunks — so it can
 * neither read nor forge the write gate.
 */

/** One row on a scope's Dashboards tab — a homed dashboard OR a secondary
 *  listing. Already projected + authorized server-side. */
export type ScopeDashboardTabRow = {
  readonly dashboardId: string;
  readonly name: string;
  /** The muted meta line: "updated 20 minutes ago". The home / listing
   *  distinction is NOT surfaced here (spec §IX — no `home:` provenance). */
  readonly metaLine: string;
  /** 'home' vs 'listed' — not surfaced to the viewer (no relation badge); drives
   *  `canRemove` only (a listing is removable by a manager; a homed row is not).
   *  Also the React list key discriminator. */
  readonly relation: "home" | "listed";
  /** The dashboard's canonical surface (opens there — never rendered inline). */
  readonly canonicalHref: string;
  /** Server-derived: may THIS viewer remove this listing? (listed AND manager).
   *  A Home row is never removable (its home is its identity, §IX). */
  readonly canRemove: boolean;
};

/** The tab's data + whether the viewer manages the scope (§IX.2 write gate). */
export type ScopeDashboardsTabData = {
  /** The scope's entity-named label, e.g. "Team: Growth". */
  readonly scopeLabel: string;
  readonly rows: readonly ScopeDashboardTabRow[];
  /** actorMayWriteScope — gates the Add affordance + every Remove (§IX.2). A
   *  non-manager gets a read-only tab: every row, open-able, but no Add/Remove. */
  readonly canManage: boolean;
};

/** One candidate row in the add-to-scope picker (§IX.1) — already dispositioned
 *  by the collection-add contract server-side. */
export type AddPickerCandidateView = {
  readonly dashboardId: string;
  readonly name: string;
  /** The mono meta note under the name — visibility eligibility ONLY (spec §IX.1
   *  dropped the `home: <entity>` provenance): "the team can already see this"
   *  for an addable row, or the scope-invisible note for a recourse row
   *  ("private — the team can't see it yet"). */
  readonly homeNote: string;
  /**
   *  addable      → a direct Add;
   *  promotion    → the §IX.1 promotion request (never an in-place add);
   *  not-addable  → stated plainly, no offer (a project tab's null recourse).
   */
  readonly disposition: "addable" | "promotion" | "not-addable";
  /** The promotion button label, present only for `disposition:"promotion"`,
   *  naming the exact target visibility — "Request team visibility…" /
   *  "Request organization visibility…". */
  readonly promotionLabel?: string;
};

/** A typed, non-throwing mutation result (survives the RSC boundary intact). */
export type ScopeListingMutation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ScopeListingMutationReason };

export type ScopeListingMutationReason =
  | "denied"
  | "not-visible-to-scope"
  | "not-found"
  | "invalid";

/** Human copy per mutation-failure reason (toast text). */
export const SCOPE_LISTING_REASON_COPY: Readonly<
  Record<ScopeListingMutationReason, string>
> = {
  denied: "You don’t have permission to manage this scope’s dashboards.",
  "not-visible-to-scope":
    "This scope can’t see that dashboard yet — request visibility first.",
  "not-found": "That dashboard no longer exists.",
  invalid: "That dashboard can’t be listed here.",
};

/** The load state of the candidate picker (§IX.1 data-state set). */
export type AddPickerLoadState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "empty" }
  | { readonly status: "ready"; readonly candidates: readonly AddPickerCandidateView[] };

/**
 * The server-action surface the hosting scope page binds (with its server-derived
 * scope + tenant) and hands to the client tab. The client drives these; each
 * re-authorizes server-side (the render gate cannot protect a later invocation).
 */
export type ScopeDashboardsDataSource = {
  /** The add-picker pool (already dispositioned). Returns null on a load error. */
  readonly listCandidates: () => Promise<
    readonly AddPickerCandidateView[] | null
  >;
  /** Add a secondary listing (re-authorizes the three-gate contract). */
  readonly addListing: (dashboardId: string) => Promise<ScopeListingMutation>;
  /** Remove a secondary listing (re-authorizes the scope-write gate). */
  readonly removeListing: (dashboardId: string) => Promise<ScopeListingMutation>;
  /** Offer the #1437 promotion request for a scope-invisible candidate. */
  readonly requestPromotion: (
    dashboardId: string,
  ) => Promise<ScopeListingMutation>;
};
