/**
 * Client/server seam types for concept B — "add from the installed catalog"
 * (cinatra#2474 PR4; issue work item 4 of six).
 *
 * Provider-neutral (no `"use client"` / `"use server"` / `server-only`): the
 * server read builds these view models, the section renders them, and the pure
 * eligibility core speaks the same vocabulary.
 *
 * ── WHAT PR4 IS, AND IS NOT ────────────────────────────────────────────────
 * PR4 is the READ. The instantiate action is PR5 ("B instantiate action —
 * owner-approved inner-workings"), so nothing here carries a mutation, and the
 * section that renders these rows offers no create control. The row is display
 * metadata plus a handle PR5 will re-resolve.
 */

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
  /** The template's display name — the name a PR5 copy would take. */
  readonly name: string;
  /** The providing package's public name, e.g. `@cinatra-ai/foo-artifact`. */
  readonly packageName: string;
};
