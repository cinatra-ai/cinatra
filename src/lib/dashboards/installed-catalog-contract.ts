/**
 * Client/server seam types for concept B — "add from the installed catalog"
 * (cinatra#2474 PR4; issue work item 4 of six).
 *
 * Provider-neutral (no `"use client"` / `"use server"` / `server-only`): the
 * server read builds these view models, the section renders them, and the pure
 * eligibility core speaks the same vocabulary.
 *
 * ── THE TWO HALVES ─────────────────────────────────────────────────────────
 * PR4 supplied the READ: which installed dashboard templates this surface may
 * offer, as safe display metadata plus an opaque handle. PR5 ("B instantiate
 * action — owner-approved inner-workings") supplies the WRITE: the confined,
 * fully re-authorized copy of one of those templates into the acting user's own
 * collection.
 *
 * The write's client seam is `ScopeCatalogSource` below — ONE bound server
 * action taking ONE opaque handle. The scope, the tenant and the destination
 * collection never cross to the browser in either direction: the action is bound
 * server-side to the landing's own `CatalogSurface` and re-derives everything
 * else from the live session (see `installed-catalog-write.ts`).
 */
import type { EntityDashboardSummary } from "@cinatra-ai/dashboards/entity-dashboards-contract";

/**
 * The SURFACE a catalog read is taken for: the entity landing the popup is
 * mounted on. ONE server-derived descriptor, from which both the access vantage
 * and the destination collection ref are derived — so the two can never
 * disagree (codex convergence r0: "make a single server-derived target
 * descriptor produce the ref").
 *
 * `userId` is the ACTING user. The destination is always that user's own
 * per-entity collection: every entity landing binds its shell with
 * `ownerLevel:"user", ownerId:userId` (personal, team, project and organization
 * alike), so a catalog copy is the actor's own dashboard on that page and is
 * visible to nobody else.
 */
export type CatalogSurface =
  | {
      readonly kind: "personal";
      readonly orgId: string;
      readonly userId: string;
    }
  | {
      readonly kind: "team";
      readonly orgId: string;
      readonly scopeId: string;
      readonly userId: string;
    }
  | {
      readonly kind: "organization";
      readonly orgId: string;
      readonly scopeId: string;
      readonly userId: string;
    }
  | {
      readonly kind: "project";
      readonly orgId: string;
      readonly scopeId: string;
      readonly userId: string;
    };

/**
 * One catalog row — SAFE DISPLAY METADATA plus an opaque handle, and nothing
 * else. Deliberately carries no config, no owner axis, no policy, no extension
 * id beyond the package's own public name (which every member already sees on
 * the marketplace and extension surfaces).
 */
export type CatalogTemplateView = {
  /**
   * The materialized template row's id — an opaque handle, a `randomUUID` with
   * no derivable meaning.
   *
   * PR5 MUST treat it as untrusted input: re-read the row by id, re-assert the
   * org / template / published / live-package properties, re-run the actor and
   * vantage arms, re-derive the destination ref server-side, and re-validate the
   * seed config. A handle that was eligible when this list was rendered proves
   * nothing at the time of the write.
   */
  readonly templateId: string;
  /** The template's display name — the name the copy takes. */
  readonly name: string;
  /** The providing package's public name, e.g. `@cinatra-ai/foo-artifact`. */
  readonly packageName: string;
};

/**
 * Why an add was REFUSED (cinatra#2474 PR5). Returned as DATA, never thrown, so
 * the reason survives the RSC boundary intact (Next sanitizes thrown
 * server-action errors in production) — the same posture every other
 * entity-dashboard mutation takes.
 *
 * The vocabulary is deliberately coarse on the authorization side and precise on
 * the two RECOVERABLE sides. A refusal must never become an oracle: "ineligible"
 * covers every access, liveness, tenant, install-ambiguity and template-scope
 * verdict with ONE indistinguishable answer, so a caller cannot probe which gate
 * it tripped. `name-taken` and `no-longer-declared`, by contrast, are states the
 * user can actually act on, and both are things the list read itself already
 * discloses by omission — so naming them leaks nothing new.
 */
export type CatalogAddRefusal =
  /** Not (or no longer) an offerable template for this actor on this surface —
   *  every access/liveness/tenant/scope verdict collapses here. */
  | "ineligible"
  /** The providing package no longer DECLARES a dashboard template. The
   *  materialized row outlives the declaration indefinitely (the reconcile has no
   *  retirement pass), so this is re-checked at write time and refused. */
  | "no-longer-declared"
  /** The name is already taken in the destination collection — INCLUDING by an
   *  archived dashboard, which still owns its name. Recoverable: rename or
   *  remove the other dashboard. */
  | "name-taken"
  /** The writer refused the create for this actor (owner-axis / org-write
   *  authority). */
  | "denied"
  /** The stored template config no longer validates. */
  | "invalid-config"
  /** An unexpected failure — logged server-side, opaque to the caller. */
  | "failed";

/** A typed, non-throwing add outcome. On success it carries the SAME summary
 *  shape every other create returns, so the shell adopts it exactly as it adopts
 *  a "Create new" dashboard. */
export type CatalogAddResult =
  | { readonly ok: true; readonly dashboard: EntityDashboardSummary }
  | { readonly ok: false; readonly reason: CatalogAddRefusal };

/** Human copy per refusal (toast text). */
export const CATALOG_ADD_REASON_COPY: Readonly<
  Record<CatalogAddRefusal, string>
> = {
  ineligible: "That dashboard isn’t available to add here any more.",
  "no-longer-declared":
    "The extension no longer provides that dashboard.",
  "name-taken":
    "You already have a dashboard with that name here — rename it first.",
  denied: "You don’t have permission to add a dashboard here.",
  "invalid-config": "That dashboard’s configuration is no longer valid.",
  failed: "Couldn’t add that dashboard. Try again.",
};

/**
 * The catalog's WRITE seam (cinatra#2474 PR5) — the one server action the
 * section may drive, already bound server-side to the landing's own
 * `CatalogSurface`.
 *
 * The client passes ONE opaque template handle and nothing else. It cannot name
 * a destination, a scope, a tenant or a config: the action re-derives the
 * destination from the LIVE session's own principal and re-runs every eligibility
 * gate from scratch (a handle that was eligible when the list rendered proves
 * nothing at the time of the write).
 */
export type ScopeCatalogSource = {
  readonly add: (templateId: string) => Promise<CatalogAddResult>;
};
