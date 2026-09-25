import "server-only";
/**
 * Concept B's INSTANTIATE core — "copy this installed dashboard template into my
 * collection on this page" (cinatra#2474 PR5, work item 5 of six).
 *
 * This is the issue's ONE sanctioned inner-workings addition:
 *
 * > **PR5 — B instantiate action** *(inner-workings — owner-approved)*: a
 * > confined, re-authorized action that resolves actor + target entity ref +
 * > extension liveness/access + source template, then calls the existing
 * > entity-dashboard writer with `seedConfig`. **The created row is an ordinary
 * > per-user/per-entity dashboard — no migration, no ownership change, no union
 * > read, no `dashboard_entity_links` row, no canonical-home change.**
 *
 * The action wrapper (`installed-catalog-actions.ts`) is a thin `"use server"`
 * shell over `addInstalledCatalogDashboard` below; everything decidable lives
 * here, with every store/manifest touch behind an injected seam, so each gate is
 * driven in a unit test with the REAL evaluators in play.
 *
 * ── WHAT THE CLIENT MAY SAY, AND WHAT IT MAY NOT ───────────────────────────
 * ONE opaque template handle. Nothing else crosses inbound. The `CatalogSurface`
 * is BOUND server-side by `buildScopeCatalogNode` (Next encrypts bound args), so
 * the browser never authors it — and even if a bound reference were replayed by
 * a different authenticated user, gate 2 refuses it, because the destination is
 * derived from the LIVE session's own principal and the descriptor must agree.
 *
 * ── THE GATES ──────────────────────────────────────────────────────────────
 * 1-2. Tenant + SCOPE REACH + destination fences — `resolveCatalogDestination`,
 *      PR4's own (extended by PR5 with the reach arm). The destination is
 *      `ownerLevel:"user", ownerId:<the acting user>`, DERIVED, never supplied.
 *      This is the fence the permissive personal vantage rests on, so the write
 *      re-takes it rather than trusting that the render took it — and the reach
 *      arm re-proves the membership/grant the landing proved, because a bound
 *      action outlives the render that produced it.
 * 3-7. Pool / liveness / install identity / both policy arms / template scope —
 *      `resolveAdmittedTemplates`, PR4's own, RE-RUN at write time. Not a
 *      restatement: the same functions, in the same order, against the store as
 *      it is NOW. Eligibility at render time proves nothing here.
 *   8. Name collision — the same rule the read applies, but with a
 *      DISTINGUISHABLE verdict: the read silently omits a colliding row, while
 *      the user pressing Add is owed "that name is taken" (including by an
 *      ARCHIVED dashboard, which still owns its name under
 *      `dashboards_entity_name_uniq`). Advisory only — the DB constraint is the
 *      real arbiter and a lost race still surfaces as `name-taken`.
 *   9. Currentness — the gate PR4 explicitly deferred here: the package must
 *      still DECLARE this dashboard in its CURRENT manifest, and the declaration
 *      must still be THIS row's (the name the reconcile would write must equal
 *      the row's). A published row alone is not evidence; the reconcile never
 *      retires — or renames — one. Because the seed then comes from that
 *      declaration, gate 7's template-scope rule is RE-TAKEN against it: the
 *      eligibility pass judged the row, and the row is not what gets copied.
 *
 * GATE ORDER, deliberately: 8 before 9. Gate 9 reads the filesystem and, for a
 * marketplace-installed package, the runtime package store; gate 8 is one indexed
 * query. Putting the cheap, most-likely refusal first means a replayed add for an
 * already-copied template is answered by a single query rather than a store walk
 * (codex convergence r0/MEDIUM-3).
 *
 * ── THE WRITE ITSELF ───────────────────────────────────────────────────────
 * `createEntityDashboard` — the platform's existing entity-dashboard writer,
 * reached through the narrow `@cinatra-ai/dashboards/entity-dashboard-writer`
 * subpath. Not a new write path: it re-asserts owner-axis `canWrite` on the row
 * it is about to insert, applies the reserved-name rule, runs inside the
 * org-write kernel guard, writes its audit row in the same transaction and pairs
 * the twin. This module supplies exactly two things it did not have before — a
 * name and a `seedConfig` — and nothing else.
 *
 * The result is an ORDINARY dashboard: `extension_id` null, `contribution_id`
 * null, `is_template` false, `is_default` false, owned by the acting user for
 * this entity. It carries no provenance back to the template BY THE ISSUE'S
 * CONSTRAINT, which is also why gate 8 is a name rule and not an
 * "already instantiated" rule.
 *
 * ── THE SEED IS THE CURRENT DECLARATION, NOT THE CACHED ROW ────────────────
 * Once gate 9 has pinned that the row IS the pack's current declaration, the
 * pack's own `cinatra/dashboard.json` — read on this request — is the truthful
 * source, and the stored row is merely the eligibility record the access gates
 * hang on. Seeding from the declaration also closes the narrower window gate 9's
 * name pin leaves open: a release that changed the BODY but kept the name would
 * otherwise copy the cached body (codex convergence r0/HIGH-2).
 *
 * It is an apiVersion 1.2 envelope (the materializer validates it as one before
 * any row can exist), and the writer's `normalizeConfigForWrite` passes an
 * envelope through as-is, so every portlet survives the copy. Two consequences,
 * stated rather than glossed:
 *
 *   - the copy KEEPS the template's own `scopeLevel`. The writer's
 *     `fallbackScopeOwnerLevel` only stamps a FRESH wrap of a bare body, so it
 *     does not rewrite an envelope — a `scopeLevel:"organization"` template
 *     copied onto a personal page stays `organization`. That is the truthful
 *     record of what the copy was made from, and no read path re-derives access
 *     from `scopeLevel` (the ROW's owner axis is the gate). Changing it would be
 *     a config rewrite this slice is not authorized to make.
 *   - the config is validated by the writer on the way in — the SAME
 *     `evaluateConfigV12` the materializer runs, including the render-only-portlet
 *     and unsafe-link rejections — so a declaration that does not validate
 *     refuses with `invalid-config` rather than persisting a broken row. The
 *     sidecar is never trusted merely because it is on disk.
 */
import type { ActorContext } from "@/lib/authz/actor-context";
import type { EntityDashboardSummary } from "@cinatra-ai/dashboards/entity-dashboards-contract";
import type { DashboardEntityRef } from "@cinatra-ai/dashboards/entity-identity";
import { isWorkspaceDashboardRef } from "@cinatra-ai/dashboards/entity-identity";
import type { DashboardActor } from "@cinatra-ai/dashboards/require-dashboard-access";

import type {
  CatalogAddResult,
  CatalogSurface,
} from "./installed-catalog-contract";
import type { CurrentTemplateDeclaration } from "./installed-catalog-currentness";
import {
  prospectiveCopyName,
  templateScopeAdmitsSurface,
} from "./installed-catalog-eligibility";
import {
  readDestinationNames,
  resolveAdmittedTemplates,
  resolveCatalogDestination,
  resolveWorkspaceAdmitted,
  type AdmittedCatalogTemplate,
  type CatalogDestination,
  type ListWorkspaceCatalogInput,
} from "./installed-catalog-read";

function warn(message: string, cause?: unknown): void {
  console.warn(
    `[dashboards/installed-catalog-write] ${message}`,
    cause instanceof Error ? cause.message : cause,
  );
}

/**
 * The write's injected seams. Defaulted to the real implementations; a test
 * substitutes them to drive one gate at a time. Deliberately NOT a seam for the
 * eligibility gates themselves — those are re-run through PR4's real functions,
 * which are themselves seam-driven in their own tests.
 */
export type CatalogWriteDeps = {
  readonly resolveDestination?: typeof resolveCatalogDestination;
  readonly resolveAdmitted?: typeof resolveAdmittedTemplates;
  /** The workspace federation's gates 1-7, per membership (cinatra#2811). */
  readonly resolveWorkspaceLegs?: typeof resolveWorkspaceAdmitted;
  readonly readNames?: typeof readDestinationNames;
  readonly readDeclaration?: (args: {
    readonly organizationId: string;
    readonly packageName: string;
  }) => Promise<CurrentTemplateDeclaration | null>;
  readonly write?: (args: {
    readonly ref: DashboardEntityRef;
    readonly name: string;
    readonly seedConfig: unknown;
    readonly organizationId: string;
  }) => Promise<CatalogAddResult>;
};

export type AddInstalledCatalogInput = {
  readonly actor: ActorContext;
  readonly surface: CatalogSurface;
  readonly templateId: string;
};

/**
 * Copy ONE installed-catalog template into the acting user's own collection for
 * `surface`. Never throws into the action: an unexpected failure is logged and
 * returned as `failed`.
 */
export async function addInstalledCatalogDashboard(
  input: AddInstalledCatalogInput,
  deps: CatalogWriteDeps = {},
): Promise<CatalogAddResult> {
  try {
    return await runAdd(input, deps);
  } catch (e) {
    warn("catalog add failed", e);
    return { ok: false, reason: "failed" };
  }
}

async function runAdd(
  { actor, surface, templateId }: AddInstalledCatalogInput,
  deps: CatalogWriteDeps,
): Promise<CatalogAddResult> {
  const resolveDestination = deps.resolveDestination ?? resolveCatalogDestination;
  const resolveAdmitted = deps.resolveAdmitted ?? resolveAdmittedTemplates;
  const readNames = deps.readNames ?? readDestinationNames;
  const readDeclaration = deps.readDeclaration ?? defaultReadDeclaration;
  const write = deps.write ?? defaultWrite;

  // An empty / non-string handle is not a lookup, it is a malformed call.
  if (typeof templateId !== "string" || templateId.length === 0) {
    return { ok: false, reason: "ineligible" };
  }

  // ── 1-2. Tenant + destination fences (PR4's own) ─────────────────────────
  const destination = resolveDestination(actor, surface);
  if (!destination) return { ok: false, reason: "ineligible" };

  // ── 3-7. Re-run every eligibility gate at WRITE time ─────────────────────
  const admitted = await resolveAdmitted(actor, surface, destination);
  const target: AdmittedCatalogTemplate | undefined = admitted.find(
    (a) => a.row.id === templateId,
  );
  // Indistinguishable from "no such template": a refusal must not tell the
  // caller WHICH gate it tripped, or which template ids exist.
  if (!target) return { ok: false, reason: "ineligible" };

  // The name the copy would actually persist, computed with the WRITER'S OWN
  // rule — a template whose name is blank or the reserved "Overview" is not
  // creatable at all, and the read already withholds it.
  const name = prospectiveCopyName(target.row.name);
  if (name === null) return { ok: false, reason: "ineligible" };

  // ── 8. Name collision, with a verdict the user can act on ────────────────
  // Taken BEFORE gate 9: one indexed query, and the likeliest refusal for a
  // replayed add. Gate 9 walks the filesystem.
  const existingNames = await readNames(destination.ref, destination.collectionOrgId);
  // Fail closed: an unreadable destination is not permission to write into it.
  if (existingNames === null) return { ok: false, reason: "failed" };
  if (existingNames.has(name)) return { ok: false, reason: "name-taken" };

  // ── 9. CURRENTNESS — and, with it, the seed ──────────────────────────────
  const declaration = await readDeclaration({
    organizationId: destination.orgId,
    packageName: target.packageName,
  });
  if (!declaration) return { ok: false, reason: "no-longer-declared" };
  // IDENTITY PIN: the row must BE the pack's current declaration. A release that
  // dropped this dashboard and shipped a different one still "declares a
  // dashboard", so the package-level answer alone is not enough — the name the
  // reconcile WOULD write must equal the row's own (codex convergence r0/HIGH-2).
  if (declaration.rowName !== target.row.name) {
    return { ok: false, reason: "no-longer-declared" };
  }
  // GATE 7, RE-TAKEN AGAINST WHAT IS ACTUALLY BEING COPIED. The eligibility pass
  // judged the STORED row's `template_scope`; the seed is the CURRENT
  // declaration, and a release that kept the name while switching to
  // `scopeLevel:"project"` would otherwise slip a project-scope template past a
  // rule that only ever saw the old row (codex convergence r1/HIGH). An
  // unvalidatable declaration reports a null scope and is refused here too.
  if (!templateScopeAdmitsSurface(declaration.templateScope, surface)) {
    return { ok: false, reason: "ineligible" };
  }

  // ── THE WRITE ────────────────────────────────────────────────────────────
  return write({
    ref: destination.ref,
    name,
    // What the pack declares NOW — see the header.
    seedConfig: declaration.config,
    organizationId: destination.orgId,
  });
}

/**
 * THE WORKSPACE ADD (cinatra#2811, item 4): the federated twin of
 * `addInstalledCatalogDashboard`.
 *
 * It differs from the tenant write in exactly one way, and reuses everything
 * else: there is no single organization to authorize under, so gates 1 to 7 are
 * re-run ONCE PER MEMBER ORGANIZATION through the read's own
 * `resolveWorkspaceAdmitted`, and the template must be admitted by one of them.
 * The organization that admitted it is then the one gate 9 reads the pack's
 * current declaration under, because that is the tenant whose install and
 * template row the earlier gates actually judged.
 *
 * Everything the tenant write proves, this proves the same way:
 *   - eligibility at RENDER time proves nothing, so every gate runs again here;
 *   - the destination is DERIVED (the acting user's own organization-free
 *     workspace collection), never supplied, and gate 2 refuses a membership
 *     whose actor is not of that organization, so the write can no more cross a
 *     tenant fence than the read can;
 *   - gate 8 asks the organization-free collection, which is where the row
 *     actually lands, so a name already taken there refuses with `name-taken`
 *     while a name taken in some tenant collection is irrelevant and ignored;
 *   - the write goes through the SAME `createEntityDashboard` call the tenant
 *     write uses, so one writer still covers the whole catalog.
 */
export type AddWorkspaceCatalogInput = ListWorkspaceCatalogInput & {
  readonly templateId: string;
};

export async function addWorkspaceCatalogDashboard(
  input: AddWorkspaceCatalogInput,
  deps: CatalogWriteDeps = {},
): Promise<CatalogAddResult> {
  try {
    return await runWorkspaceAdd(input, deps);
  } catch (e) {
    warn("workspace catalog add failed", e);
    return { ok: false, reason: "failed" };
  }
}

async function runWorkspaceAdd(
  { userId, memberships, templateId }: AddWorkspaceCatalogInput,
  deps: CatalogWriteDeps,
): Promise<CatalogAddResult> {
  const resolveLegs = deps.resolveWorkspaceLegs ?? resolveWorkspaceAdmitted;
  const readNames = deps.readNames ?? readDestinationNames;
  const readDeclaration = deps.readDeclaration ?? defaultReadDeclaration;
  const write = deps.write ?? defaultWrite;

  // An empty / non-string handle is not a lookup, it is a malformed call.
  if (typeof templateId !== "string" || templateId.length === 0) {
    return { ok: false, reason: "ineligible" };
  }

  // GATES 1-7, per membership, AT WRITE TIME.
  const legs = await resolveLegs({ userId, memberships });
  let found:
    | { readonly destination: CatalogDestination; readonly target: AdmittedCatalogTemplate }
    | null = null;
  for (const leg of legs) {
    const target = leg.admitted.find((a) => a.row.id === templateId);
    if (target) {
      found = { destination: leg.destination, target };
      break;
    }
  }
  // Indistinguishable from "no such template": a refusal must not tell the
  // caller WHICH gate it tripped, which organizations they are in, or which
  // template ids exist.
  if (!found) return { ok: false, reason: "ineligible" };
  const { destination, target } = found;

  const name = prospectiveCopyName(target.row.name);
  if (name === null) return { ok: false, reason: "ineligible" };

  // GATE 8, against the ORGANIZATION-FREE collection the row lands in.
  const existingNames = await readNames(destination.ref, destination.collectionOrgId);
  if (existingNames === null) return { ok: false, reason: "failed" };
  if (existingNames.has(name)) return { ok: false, reason: "name-taken" };

  // GATE 9, currentness, under the organization whose install and template row
  // the earlier gates judged.
  const declaration = await readDeclaration({
    organizationId: destination.orgId,
    packageName: target.packageName,
  });
  if (!declaration) return { ok: false, reason: "no-longer-declared" };
  if (declaration.rowName !== target.row.name) {
    return { ok: false, reason: "no-longer-declared" };
  }
  // Gate 7, re-taken against what is actually being copied.
  if (
    !templateScopeAdmitsSurface(declaration.templateScope, {
      kind: "workspace",
      orgId: destination.orgId,
      userId,
    })
  ) {
    return { ok: false, reason: "ineligible" };
  }

  return write({
    ref: destination.ref,
    name,
    seedConfig: declaration.config,
    organizationId: destination.orgId,
  });
}

/** Gate 9's real implementation. */
async function defaultReadDeclaration(args: {
  readonly organizationId: string;
  readonly packageName: string;
}): Promise<CurrentTemplateDeclaration | null> {
  const { readCurrentTemplateDeclaration } = await import(
    "./installed-catalog-currentness"
  );
  return readCurrentTemplateDeclaration(args);
}

/**
 * The real write: the platform's own entity-dashboard create writer, with the
 * session-minted actor it requires.
 *
 * The actor is rebuilt from the LIVE session here rather than threaded from the
 * render — the org-write authority a writer demands must be minted for the
 * session making THIS call, and an org switch between render and click must
 * change the answer.
 */
async function defaultWrite(args: {
  readonly ref: DashboardEntityRef;
  readonly name: string;
  readonly seedConfig: unknown;
  readonly organizationId: string;
}): Promise<CatalogAddResult> {
  const { buildDashboardActorFromSession } = await import(
    "@/lib/dashboards/dashboard-actor"
  );

  const { actor: authz, orgId, userId, authority } =
    await buildDashboardActorFromSession();
  // The acting principal must still BE the owner of the destination, on every
  // surface. This is the invariant the permissive vantage arms rest on.
  if (!userId || userId !== args.ref.ownerId) {
    return { ok: false, reason: "ineligible" };
  }
  if (isWorkspaceDashboardRef(args.ref)) {
    // THE WORKSPACE ARM (cinatra#2811). A workspace row is organization-free
    // and reads the same under every active organization, so the active-org
    // equality below would be the wrong question here: the gates ran under one
    // MEMBER organization of the viewer's vantage, which need not be the one
    // the session happens to have active. Requiring them to match would refuse
    // a legitimate add for the arbitrary reason that the user was looking at
    // another organization.
    //
    // Nothing is given up by skipping it. The membership that admitted the
    // template was re-resolved on THIS request (the write re-runs the whole
    // federation), the destination is this very user's own collection, and the
    // actor below is the workspace actor `requireEntityDashboardActor` builds
    // for the same ref, so the writer sees exactly what the tab's own Create
    // gives it.
    return writeThrough(
      { userId, organizationId: orgId ?? null, teamIds: [] },
      args,
    );
  }
  // Every other surface: the session must still be the tenant the gates were
  // taken for. A mid-flight org switch or a replayed bound action lands here.
  if (!orgId || orgId !== args.organizationId) {
    return { ok: false, reason: "ineligible" };
  }

  const orgRole =
    authz.orgRole === "owner" || authz.orgRole === "org_owner"
      ? ("owner" as const)
      : authz.orgRole === "admin" || authz.orgRole === "org_admin"
        ? ("admin" as const)
        : authz.orgRole === "member"
          ? ("member" as const)
          : undefined;
  return writeThrough(
    {
      userId,
      organizationId: orgId ?? null,
      teamIds: [...(authz.teamIds ?? [])],
      ...(orgRole ? { orgRole } : {}),
      ...(authority ? { authority } : {}),
    },
    args,
  );
}

/**
 * THE ONE WRITER, for every surface including the workspace. Both arms above
 * reach it, so the twin-pairing exception and the AST gate that names writers
 * by function still see a single `createEntityDashboard` call site for the
 * installed catalog.
 */
async function writeThrough(
  dashboardActor: DashboardActor,
  args: {
    readonly ref: DashboardEntityRef;
    readonly name: string;
    readonly seedConfig: unknown;
    readonly organizationId: string;
  },
): Promise<CatalogAddResult> {
  const {
    createEntityDashboard,
    resolveDashboardAccess,
    DashboardNameConflictError,
    DashboardForbiddenError,
    DashboardInvalidEntityError,
    DashboardConfigInvalidError,
    DashboardOrgWriteAuthorityError,
    isOrgWriteRefusal,
  } = await import("@cinatra-ai/dashboards/entity-dashboard-writer");

  try {
    const row = await createEntityDashboard(
      { ref: args.ref, name: args.name, seedConfig: args.seedConfig },
      dashboardActor,
    );
    const dashboard: EntityDashboardSummary = {
      id: row.id,
      name: row.name,
      isDefault: row.isDefault,
      // Server-derived from the persisted row, never assumed.
      canWrite: resolveDashboardAccess(row, dashboardActor).canWrite,
    };
    return { ok: true, dashboard };
  } catch (e) {
    // The DB's unique index is the real arbiter of the name — a create that
    // loses the race between gate 8 and the insert lands here, and says the same
    // thing gate 8 would have.
    if (e instanceof DashboardNameConflictError) {
      return { ok: false, reason: "name-taken" };
    }
    // Every authorization outcome — the writer's own owner-axis refusal, the
    // missing/mismatched org-write authority, and the kernel's lifecycle ruling
    // — is one answer, exactly as `classifyMutationError` treats them.
    if (
      e instanceof DashboardForbiddenError ||
      e instanceof DashboardOrgWriteAuthorityError ||
      // The kernel's own lifecycle ruling, asked through the dashboards seam
      // that owns the kernel edge — this module never reaches the kernel root,
      // because opaque access to it reaches every kernel writer.
      isOrgWriteRefusal(e)
    ) {
      return { ok: false, reason: "denied" };
    }
    if (e instanceof DashboardConfigInvalidError) {
      return { ok: false, reason: "invalid-config" };
    }
    if (e instanceof DashboardInvalidEntityError) {
      // A reserved / empty name, or a structurally invalid ref — both are
      // eligibility statements about the template, not server faults.
      return { ok: false, reason: "ineligible" };
    }
    throw e;
  }
}
