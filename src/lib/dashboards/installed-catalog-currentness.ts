import "server-only";
/**
 * The CURRENTNESS gate for concept B's instantiate action (cinatra#2474 PR5,
 * gate 9) — "is this stored template row still the pack's CURRENT declaration,
 * and what does the pack declare RIGHT NOW?"
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A materialized template row proves the package shipped a dashboard AT SOME
 * POINT, not that it still does. The boot reconcile
 * (`reconcile-template-materializations.ts`) UPSERTS what it currently discovers
 * and has NO retirement pass, so a package that drops — or REPLACES — its
 * dashboard declaration leaves its `published` row behind INDEFINITELY, across
 * every later reconcile. PR4 recorded that gap in its module headers and handed
 * it here.
 *
 * A read that merely LISTS a stale template is cosmetically stale. A WRITE that
 * copies one mints a durable, user-owned dashboard from a declaration that no
 * longer exists — the copy carries no extension provenance (the issue's own
 * constraint), so nothing downstream will ever reconcile it away. That asymmetry
 * is the whole reason this gate is on the write and not on the four landings'
 * server render.
 *
 * ── WHY IT RETURNS THE DECLARATION, NOT A BOOLEAN ──────────────────────────
 * A package-level yes/no is too weak (codex convergence r0/HIGH-2): a pack that
 * drops dashboard A and ships dashboard B in the same release still "declares a
 * dashboard", so a boolean would happily let the stale A row be copied until the
 * next reconcile replaces it. Returning the declaration lets the caller do two
 * strictly stronger things:
 *
 *   - PIN THE IDENTITY — compare the name the reconcile WOULD write
 *     (`extensionTemplateRowName`, factored out of the materializer so the rule
 *     cannot drift) against the row's own name. A replaced declaration fails it.
 *   - SEED FROM THE DECLARATION — copy what the pack ships NOW, not what the row
 *     cached. Once the identity is pinned, this is the only truthful source; it
 *     also closes the narrower window where the body changed but the name did
 *     not.
 *
 * ── HOW, WITHOUT RESTATING ANYTHING ────────────────────────────────────────
 * It asks the RECONCILER'S OWN resolver
 * (`resolveLiveDashboardTemplateForPackage`) — the single authority that decides
 * what materializes — so this gate inherits, rather than re-implements:
 *
 *   - STATIC PRESENCE IS AUTHORITATIVE — a package the trusted static manifest
 *     claims is served ONLY from static, never overridden by untrusted
 *     runtime-store bytes, with no fall-through on a failed read;
 *   - the UNTRUSTED runtime path's fail-closed `parseDashboardContribution`
 *     claim gate;
 *   - the `form:"dashboard"` template-entry selection and the pack-dir traversal
 *     guard;
 *   - the live/org-addressable install filter.
 *
 * PACKAGE granularity is the right UNIT of declaration, not an approximation:
 * `materializeExtensionTemplate` upserts ONE template row per
 * `(extensionId, organizationId)`, so a package declares at most one row's worth
 * of dashboard. The identity pin above is what turns that unit into a statement
 * about THIS row.
 *
 * ── COST, AND THE SIDE EFFECT, STATED ──────────────────────────────────────
 * The single-package resolver reads the manifest and sidecar of ONE package. For
 * a statically-claimed package (every pack in the dev/required lock) it touches
 * the runtime package store not at all. Only a genuinely marketplace-installed
 * package reaches the store-discovery arm, which calls
 * `rescanArtifactBridgeFromStore` and therefore REGISTERS artifact object types
 * — replace-by-id and idempotent (the same call boot makes), but a side effect on
 * a write path, and named here rather than left to be discovered.
 *
 * ── FAIL-CLOSED ────────────────────────────────────────────────────────────
 * Any failure returns `null` (refuse). An unverifiable declaration is not a
 * declaration; the user sees a clean refusal and nothing is written.
 */

/** The pack's CURRENT dashboard declaration: the name a materialized row would
 *  carry, the `template_scope` it would be stamped with, and the config it would
 *  store. */
export type CurrentTemplateDeclaration = {
  /** The row name the reconcile would write — the materializer's own rule. */
  readonly rowName: string;
  /**
   * The `template_scope` the reconcile would stamp — the config's own validated
   * `scopeLevel`, read exactly as `materializeExtensionTemplate` reads it.
   *
   * Load-bearing (codex convergence r1/HIGH): the eligibility gates run against
   * the STORED row's `template_scope`, but the copy is seeded from the CURRENT
   * declaration. A release that kept the dashboard's name while switching it to
   * `scopeLevel:"project"` would otherwise slip a project-scope template past a
   * gate that only ever saw the old organization-scope row. The caller re-runs
   * the template-scope rule against THIS value before writing.
   */
  readonly templateScope: string | null;
  /** The pack's `cinatra/dashboard.json` as it is on disk today. Validated again
   *  by the writer on the way in, exactly as the materializer validates it. */
  readonly config: unknown;
};

/**
 * The dashboard template `packageName` declares for `organizationId` right now,
 * or `null` when it declares none (or cannot be verified).
 */
export async function readCurrentTemplateDeclaration(args: {
  readonly organizationId: string;
  readonly packageName: string;
}): Promise<CurrentTemplateDeclaration | null> {
  const { organizationId, packageName } = args;
  if (!organizationId || !packageName) return null;
  try {
    const [
      { resolveLiveDashboardTemplateForPackage },
      { extensionTemplateRowName, extensionTemplateScope },
    ] = await Promise.all([
      import("@/lib/dashboards/reconcile-template-materializations"),
      // The PURE config-contract module, deliberately NOT the
      // extension-materialization barrel: that barrel re-exports org-write
      // writers, and an opaque import of it reaches every one of them without
      // naming one — which the org-write boundary gate refuses, correctly. Both
      // rules are defined there and imported FROM there by the materializer, so
      // there is one definition and no route-graph edge is added.
      import("@cinatra-ai/dashboards/dashboard-config-v12"),
    ]);
    const live = await resolveLiveDashboardTemplateForPackage(
      organizationId,
      packageName,
    );
    if (!live) return null;
    // Both rules are the MATERIALIZER'S own, so the name the reconcile would
    // write and the `template_scope` it would stamp are read exactly as it reads
    // them. A declaration that does not validate reports a `null` scope, which
    // the caller refuses — the writer would reject it anyway, and refusing before
    // the write keeps the scope rule from being skipped.
    return {
      rowName: extensionTemplateRowName(packageName, live.name),
      templateScope: extensionTemplateScope(live.config),
      config: live.config,
    };
  } catch (e) {
    console.warn(
      `[dashboards/installed-catalog] currentness probe failed for ${packageName} ` +
        `(org ${organizationId}); refusing the add:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
