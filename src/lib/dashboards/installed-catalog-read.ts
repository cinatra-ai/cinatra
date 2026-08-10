import "server-only";
/**
 * Concept B's SERVER READ — "what installed dashboard-capable extensions offer
 * this surface" (cinatra#2474 PR4, work item 4 of six).
 *
 * ── THERE IS NO CLIENT SEAM ────────────────────────────────────────────────
 * This read is taken during the entity landing's SERVER render, and its result
 * is rendered server-side into the node the landing hands the popup through
 * `ScopeAddSourcesProvider`'s `catalog` slot. PR4 exposes NO server action, so
 * there is no client-callable entry point to this read at all — the only way to
 * reach it is to render a landing whose own membership gate has already
 * admitted the actor. PR5's instantiate action is the first client-reachable
 * surface concept B gets, and it must re-authorize from scratch.
 *
 * ── THE GATES, IN ORDER ────────────────────────────────────────────────────
 *   1. Tenant fence      — the actor's active org IS the surface's org, and the
 *                          actor is a human principal.
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
 * that is a reconciler change, out of this slice; PR5's re-resolution must
 * therefore re-check the CURRENT manifest declaration, not merely a live package
 * and a published row.
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
  // ── 1. Tenant fence ──────────────────────────────────────────────────────
  const orgId = surface.orgId;
  if (!orgId) return [];
  if (actor.organizationId !== orgId) return [];
  // The acting principal must be a HUMAN USER with an id: the destination is
  // that user's own collection, and a non-human principal (worker / agent /
  // service) has no personal collection to be the single reader of. Anything
  // else is refused rather than attributed to whatever id the descriptor holds.
  const actorUserId =
    actor.principalType === "HumanUser" ? actor.principalId : null;
  if (!actorUserId) return [];

  // ── 2. Destination fence ─────────────────────────────────────────────────
  // Derived from the surface + the ACTOR'S id, then re-asserted. The descriptor
  // cannot name someone else's collection: `destinationRefForSurface` refuses a
  // `surface.userId` that is not the acting user, and the assertion below is the
  // belt to that braces (codex convergence r1).
  const ref = destinationRefForSurface(surface, actorUserId);
  if (!ref || !destinationIsActorOwned(ref, actorUserId)) return [];

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
  const eligible: CatalogTemplateView[] = [];
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

    eligible.push({
      templateId: row.id,
      name: row.name,
      packageName: install.packageName,
    });
  }
  if (eligible.length === 0) return [];

  // ── 8. Name collision against the destination collection ─────────────────
  const existingNames = await readDestinationNames(ref, orgId);
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
async function readDestinationNames(
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
