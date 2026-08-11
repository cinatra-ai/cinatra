import "server-only";
/**
 * Concept B's SERVER READ — "what installed dashboard-capable extensions offer
 * this surface" (cinatra#2474 PR4, work item 4 of six).
 *
 * ── WHO REACHES THIS, AND HOW (updated by cinatra#2474 PR5) ────────────────
 * The LIST read is still taken only during the entity landing's SERVER render,
 * and its result is rendered server-side into the node the landing hands the
 * popup through `ScopeAddSourcesProvider`'s `catalog` slot. It has no
 * client-callable entry point.
 *
 * PR5's instantiate action IS client-reachable, and it re-authorizes from
 * scratch by re-running THESE GATES — not a restatement of them. That is what
 * `resolveCatalogDestination` and `resolveAdmittedTemplates` are exported for:
 * the write calls the same functions the list calls, in the same order, at write
 * time. A handle that was eligible when the list rendered proves nothing later.
 *
 * The write additionally applies TWO gates the list does not need, both in
 * `installed-catalog-write.ts`: the CURRENTNESS re-check (gate 9 below, which
 * this module cannot take because it has no manifest access) and the
 * distinguishable name-collision refusal.
 *
 * ── THE GATES, IN ORDER ────────────────────────────────────────────────────
 *   1. Tenant fence      — the actor's active org IS the surface's org, the
 *                          actor is a human principal, and the actor may be on
 *                          this surface AT ALL (each landing's own view gate,
 *                          re-taken; see `actorMayReachSurface`).
 *   2. Destination fence — the collection a copy would land in is DERIVED from
 *                          the surface plus the ACTOR'S OWN principal id. The
 *                          descriptor's `userId` must equal it; there is no
 *                          independent ref input that could disagree.
 *   3. Template pool     — the org's published, boot-materialized template rows
 *                          (`listOrgExtensionTemplateRows`).
 *   4. Liveness gate     — the CANONICAL reader gate
 *                          (`filterRenderableDashboards` + the app's
 *                          `resolveLiveExtensionPredicate`): the owning package
 *                          is installed and active/locked for this org, and the
 *                          row is not archived. Fail-closed by construction — a
 *                          canonical-store failure yields a deny-all predicate.
 *   5. Install identity  — exactly ONE live `kind:"artifact"` canonical install
 *                          row for the package. More than one (side-by-side
 *                          versions) SKIPS the package rather than attributing
 *                          one row's policy to another's template.
 *   6. ONE POLICY SNAPSHOT, TWO ARMS — the stored access policy is read ONCE and
 *                          both arms are evaluated from that same value, so a
 *                          concurrent policy edit can never combine an old
 *                          actor-allow with a new vantage-allow (codex
 *                          convergence r0):
 *                            ACTOR  — `evaluateExtensionAccess(..., op:"use")`,
 *                                     the platform's own evaluator, given the
 *                                     snapshot;
 *                            VANTAGE— `policyFieldAdmitsScopeVantage` over the
 *                                     SAME field that op reads
 *                                     (`runDataVisibility`).
 *   7. Template scope    — `templateScopeAdmitsSurface` (project-scope templates
 *                          are the extension's own per-project mechanism).
 *   8. Name collision    — the template is currently addable without colliding
 *                          in the destination collection, read across EVERY
 *                          status (an archived row still owns its name).
 *   9. Currentness       — WRITE ONLY (cinatra#2474 PR5): the providing package
 *                          still DECLARES a dashboard template in its current
 *                          manifest. Taken in `installed-catalog-write.ts`,
 *                          because this module has no manifest access.
 *
 * `op:"use"` and not `"read"`: the catalog means "eligible to instantiate", and
 * `use` is that op. For `kind:"artifact"` the two are the same policy field
 * today, which the accompanying test pins so the choice cannot silently change
 * meaning.
 *
 * ── WHAT THIS PROVES, AND WHAT IT DOES NOT ─────────────────────────────────
 * It proves the package is live NOW, and that its template materialized at some
 * point and is still published. It does NOT re-read the pack's manifest, so it
 * cannot prove the package still SHIPS that dashboard today.
 *
 * Be precise about how long that gap can last: the boot reconcile UPSERTS the
 * templates it currently discovers and has NO retirement pass for one that has
 * gone away, so a package that drops its dashboard declaration leaves its
 * published row behind INDEFINITELY — not "until the next reconcile". Closing
 * that is a reconciler change, still out of scope.
 *
 * WHAT PR5 DID ABOUT IT (the honest half-fix). The WRITE now re-checks the
 * CURRENT manifest declaration before copying anything
 * (`installed-catalog-currentness.ts`), so a dropped dashboard can no longer be
 * instantiated. The LIST is deliberately NOT gated on it: the currentness probe
 * touches the filesystem and the runtime package store, which is the wrong cost
 * to pay on four entity landings' server render, and a stale ROW that is merely
 * LISTED is a cosmetic staleness while a stale row that is COPIED is a durable
 * one. So a retired template can still appear in the popup for as long as its row
 * survives, and pressing Add on it refuses with `no-longer-declared`. That is a
 * real, visible seam and it is stated rather than hidden.
 *
 * ── FAILURE POSTURE ────────────────────────────────────────────────────────
 * NEVER throws into the landing: any failure logs and yields an EMPTY catalog,
 * which renders no section at all. "Fail-closed" here means "never more
 * permissive than `canExtensionAccess` would be for the same actor" — where no
 * policy row exists this applies the platform's OWN
 * `DEFAULT_EXTENSION_ACCESS_POLICY`, exactly as the canonical evaluator does, so
 * the catalog can never show an extension the platform would deny. The converse
 * is NOT claimed: the vantage, template-scope and name-collision arms all
 * deliberately withhold templates the platform WOULD allow the actor to read.
 * The eligible set is a strict subset of the accessible one.
 */
import type { DashboardEntityRef } from "@cinatra-ai/dashboards/entity-identity";
import {
  filterRenderableDashboards,
  listEntityCollectionNames,
  listOrgExtensionTemplateRows,
} from "@cinatra-ai/dashboards/extension-dashboard-reads";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy-types";
import type { ExtensionOwnerLevel } from "@cinatra-ai/extensions/canonical-types";

import type { ActorContext } from "@/lib/authz/actor-context";
import { resolveLiveExtensionPredicate } from "@/lib/dashboards/live-extension-oracle";
import type {
  CatalogSurface,
  CatalogTemplateView,
} from "./installed-catalog-contract";
import {
  actorMayReachSurface,
  compareCatalogRows,
  destinationIsActorOwned,
  destinationRefForSurface,
  isAddableWithoutNameCollision,
  templateScopeAdmitsSurface,
  vantageForSurface,
} from "./installed-catalog-eligibility";

/** A safety bound: the popup is a bounded panel, not an inventory. */
const MAX_CATALOG_ROWS = 50;

/** The canonical statuses that count as LIVE (mirrors the reader-gate oracle). */
const LIVE_STATUSES = new Set(["active", "locked"]);

function warn(message: string, cause?: unknown): void {
  // Suppressing the section must not also suppress the DIAGNOSTIC — a silent
  // empty catalog and a silent operational failure must be distinguishable in
  // the logs (codex convergence r0/Q5).
  console.warn(
    `[dashboards/installed-catalog] ${message}`,
    cause instanceof Error ? cause.message : cause,
  );
}

export type ListInstalledCatalogInput = {
  readonly actor: ActorContext;
  readonly surface: CatalogSurface;
};

/** One materialized template row, as `listOrgExtensionTemplateRows` returns it.
 *  Derived from the read itself so the app never restates the row's shape. */
export type CatalogTemplateRow = Awaited<
  ReturnType<typeof listOrgExtensionTemplateRows>
>[number];

/**
 * A template that PASSED every gate except the name-collision filter, with the
 * install row whose access policy governed it. The list read projects these down
 * to display metadata; the write needs the row itself (for the seed config) and
 * the package name (for the currentness re-check), so the admitted set — not its
 * projection — is what both share.
 */
export type AdmittedCatalogTemplate = {
  readonly row: CatalogTemplateRow;
  readonly packageName: string;
};

/** The tenant + destination fences (gates 1-2), resolved together because the
 *  destination IS derived from the actor the tenant fence just checked. */
export type CatalogDestination = {
  readonly orgId: string;
  readonly actorUserId: string;
  readonly ref: DashboardEntityRef;
};

/**
 * GATES 1-2 — the tenant fence, the SCOPE-REACH gate and the destination fence,
 * as ONE step.
 *
 * `null` on any refusal: no active org, an org that is not the surface's, a
 * non-human principal, an actor who may not be on this surface at all, a
 * descriptor naming someone else's collection, or a structurally invalid
 * surface. Pure apart from reading the actor it is handed — no I/O, so both
 * callers pay the same (zero) cost for the same verdict.
 *
 * The scope-reach arm is a no-op for the LIST (the landing's own gate already
 * admitted the actor) and load-bearing for the WRITE, whose bound action
 * outlives that render (codex convergence r0/HIGH-1). It lives here, in the step
 * both callers take, precisely so it cannot be forgotten on one of them.
 */
export function resolveCatalogDestination(
  actor: ActorContext,
  surface: CatalogSurface,
): CatalogDestination | null {
  const orgId = surface.orgId;
  if (!orgId) return null;
  if (actor.organizationId !== orgId) return null;
  if (!actorMayReachSurface(actor, surface)) return null;
  // The acting principal must be a HUMAN USER with an id: the destination is
  // that user's own collection, and a non-human principal (worker / agent /
  // service) has no personal collection to be the single reader of. Anything
  // else is refused rather than attributed to whatever id the descriptor holds.
  const actorUserId =
    actor.principalType === "HumanUser" ? actor.principalId : null;
  if (!actorUserId) return null;

  // Derived from the surface + the ACTOR'S id, then re-asserted. The descriptor
  // cannot name someone else's collection: `destinationRefForSurface` refuses a
  // `surface.userId` that is not the acting user, and the assertion below is the
  // belt to that braces (codex convergence r1).
  const ref = destinationRefForSurface(surface, actorUserId);
  if (!ref || !destinationIsActorOwned(ref, actorUserId)) return null;
  return { orgId, actorUserId, ref };
}

/**
 * GATES 3-7 — the template pool, the canonical liveness gate, the install-identity
 * fence, the two policy arms off ONE snapshot, and the template-scope allowlist.
 *
 * Everything up to but NOT including the name-collision filter, because that is
 * the one gate whose verdict the two callers must treat differently: the list
 * silently omits a colliding row, while the write must say `name-taken` so the
 * user can act on it.
 *
 * Exported so cinatra#2474 PR5's instantiate action re-authorizes by RUNNING
 * these gates rather than restating them.
 */
export async function resolveAdmittedTemplates(
  actor: ActorContext,
  surface: CatalogSurface,
  destination: CatalogDestination,
): Promise<readonly AdmittedCatalogTemplate[]> {
  const { orgId } = destination;

  // ── 3. The org's materialized template rows ──────────────────────────────
  const templates = await listOrgExtensionTemplateRows(orgId);
  if (templates.length === 0) return [];

  // ── 4. The canonical liveness/status reader gate ─────────────────────────
  const isPackageLive = await resolveLiveExtensionPredicate(orgId);
  const live = filterRenderableDashboards(templates, isPackageLive);
  if (live.length === 0) return [];

  // ── 5. Resolve ONE live artifact install row per package ─────────────────
  const installsByPackage = await resolveLiveArtifactInstalls(orgId);

  // ── 6-7. Scope compat, then the two arms off ONE policy snapshot ─────────
  //
  // The pure narrowings run FIRST so no store read is spent on a candidate that
  // is already out, and the policy snapshot for every survivor is taken in ONE
  // batch. Both arms then read that single snapshot, so a concurrent policy edit
  // can never combine an old actor-allow with a new vantage-allow.
  const candidates = live
    .filter(
      (row) =>
        row.extensionId != null &&
        templateScopeAdmitsSurface(row.templateScope, surface) &&
        // Absent → not a live `kind:"artifact"` install, or AMBIGUOUS (several
        // live rows for one package). Both deny.
        installsByPackage.has(row.extensionId),
    )
    .map((row) => ({ row, install: installsByPackage.get(row.extensionId!)! }));
  if (candidates.length === 0) return [];

  // Imported HERE rather than at module scope: this module sits in the render
  // graph of four entity landings, and the extensions access modules reach the
  // permissions store and its Postgres connection. Nothing pays for that until a
  // candidate actually needs authorizing.
  const [
    { readExtensionAccessPolicies },
    { DEFAULT_EXTENSION_ACCESS_POLICY },
    { policyFieldAdmitsScopeVantage },
  ] = await Promise.all([
    import("@cinatra-ai/extensions/permissions-store"),
    import("@cinatra-ai/extensions/enforce-extension-access"),
    import("@cinatra-ai/extensions/access-scope-vantage"),
  ]);
  // ONE batch read for every survivor — the list-surface reader, not N singles.
  const policies = await readExtensionAccessPolicies(
    "artifact",
    candidates.map((c) => c.install.id),
  );

  const vantage = vantageForSurface(surface);
  const admitted: AdmittedCatalogTemplate[] = [];
  for (const { row, install } of candidates) {
    // THE ONE SNAPSHOT. Where no policy row exists, the platform's own default
    // applies — the identical fallback `canExtensionAccess` uses, so this can be
    // neither more nor less permissive than the platform's own access decision.
    const policy = policies.get(install.id) ?? DEFAULT_EXTENSION_ACCESS_POLICY;

    // VANTAGE ARM first: pure, so it costs nothing and spares the two remaining
    // per-candidate store reads for a template the scope could not reach anyway.
    if (!policyFieldAdmitsScopeVantage(policy.runDataVisibility, vantage)) {
      continue;
    }
    // ACTOR ARM — the platform's evaluator over that SAME policy value.
    if (!(await actorMayUseExtension({ actor, policy, install }))) continue;

    admitted.push({ row, packageName: install.packageName });
  }
  return admitted;
}

/**
 * The eligible installed-catalog templates for `surface`, as safe display
 * metadata plus an opaque handle. Empty on any refusal or failure.
 */
export async function listInstalledCatalogTemplates(
  input: ListInstalledCatalogInput,
): Promise<readonly CatalogTemplateView[]> {
  try {
    return await readCatalog(input);
  } catch (e) {
    warn("catalog read failed; rendering no catalog", e);
    return [];
  }
}

async function readCatalog({
  actor,
  surface,
}: ListInstalledCatalogInput): Promise<readonly CatalogTemplateView[]> {
  // ── 1-2. Tenant + destination fences ─────────────────────────────────────
  const destination = resolveCatalogDestination(actor, surface);
  if (!destination) return [];

  // ── 3-7. The pool, liveness, install identity, both policy arms, scope ───
  const admitted = await resolveAdmittedTemplates(actor, surface, destination);
  if (admitted.length === 0) return [];

  const eligible: CatalogTemplateView[] = admitted.map((a) => ({
    templateId: a.row.id,
    name: a.row.name,
    packageName: a.packageName,
  }));

  // ── 8. Name collision against the destination collection ─────────────────
  const existingNames = await readDestinationNames(
    destination.ref,
    destination.orgId,
  );
  if (existingNames === null) {
    warn("destination collection unreadable; rendering no catalog");
    return [];
  }
  const addable = eligible.filter((t) =>
    isAddableWithoutNameCollision(t.name, existingNames),
  );

  return addable.sort(compareCatalogRows).slice(0, MAX_CATALOG_ROWS);
}

type LiveInstall = {
  readonly id: string;
  readonly packageName: string;
  readonly ownerLevel: ExtensionOwnerLevel;
  readonly ownerId: string | null;
  readonly organizationId: string | null;
};

/**
 * Live `kind:"artifact"` canonical install rows, keyed by package name.
 *
 * A package with MORE THAN ONE live row is deliberately ABSENT from the map
 * (the version-ambiguity fence, modelled on merged #2614's "a package carried by
 * several templates at different versions skips the dependency arm entirely
 * rather than attributing one build's edges to another"): a template row carries
 * no version, so there is no truthful way to pick which install's access policy
 * governs it.
 */
async function resolveLiveArtifactInstalls(
  orgId: string,
): Promise<Map<string, LiveInstall>> {
  const single = new Map<string, LiveInstall>();
  const ambiguous = new Set<string>();
  const { listInstalledExtensions } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const rows = await listInstalledExtensions({ kind: "artifact" });
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    // Addressable to this org: a system row is org-null; a per-org install must
    // match (the same org-coarse rule the reader-gate oracle applies).
    if (row.organizationId !== null && row.organizationId !== orgId) continue;
    if (ambiguous.has(row.packageName)) continue;
    if (single.has(row.packageName)) {
      single.delete(row.packageName);
      ambiguous.add(row.packageName);
      continue;
    }
    single.set(row.packageName, {
      id: row.id,
      packageName: row.packageName,
      ownerLevel: row.ownerLevel,
      ownerId: row.ownerId,
      organizationId: row.organizationId,
    });
  }
  return single;
}

/**
 * The ACTOR ARM, over an ALREADY-RESOLVED policy value. Deliberately takes the
 * policy rather than reading it: the vantage arm has already been evaluated
 * against that same value, and the two must never see different snapshots.
 *
 * The decision itself is the platform's own `evaluateExtensionAccess` — never a
 * restatement of it — with `op:"use"` ("eligible to instantiate") rather than
 * `"read"`. For `kind:"artifact"` the two map to the same policy field today,
 * which the extensions-side conformance test pins.
 */
async function actorMayUseExtension(args: {
  readonly actor: ActorContext;
  readonly policy: AgentAuthPolicy;
  readonly install: LiveInstall;
}): Promise<boolean> {
  const [
    { readExtensionCoOwners, readExtensionInstalledBy },
    { evaluateExtensionAccess },
  ] = await Promise.all([
    import("@cinatra-ai/extensions/permissions-store"),
    import("@cinatra-ai/extensions/enforce-extension-access"),
  ]);
  const [coOwners, installedBy] = await Promise.all([
    readExtensionCoOwners("artifact", args.install.id),
    readExtensionInstalledBy("artifact", args.install.id),
  ]);
  return evaluateExtensionAccess({
    kind: "artifact",
    policy: args.policy,
    coOwnerUserIds: coOwners.map((c) => c.userId),
    installedByUserId: installedBy,
    owner: {
      ownerLevel: args.install.ownerLevel,
      ownerId: args.install.ownerId,
      organizationId: args.install.organizationId,
    },
    actor: args.actor,
    op: "use",
  }).allowed;
}

/**
 * The names already present in the destination `(entity, owner)` collection, or
 * `null` when it could not be read (fail-closed: an unreadable destination
 * yields no catalog rather than a list of adds that may all collide).
 *
 * Reads EVERY status, not the per-entity dropdown's list: an ARCHIVED dashboard
 * is hidden from that list but still owns its name under
 * `dashboards_entity_name_uniq`, so listing through the dropdown read would
 * advertise a template whose create is guaranteed to hit the constraint (codex
 * convergence r2).
 */
export async function readDestinationNames(
  ref: DashboardEntityRef,
  organizationId: string,
): Promise<ReadonlySet<string> | null> {
  if (!ref.entityType || !ref.entityId) return null;
  try {
    const names = await listEntityCollectionNames({
      organizationId,
      entityType: ref.entityType,
      entityId: ref.entityId,
      ownerLevel: ref.ownerLevel,
      ownerId: ref.ownerId,
    });
    return new Set(names);
  } catch (e) {
    warn("destination collection read failed", e);
    return null;
  }
}
