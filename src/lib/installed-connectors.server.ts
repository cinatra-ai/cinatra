import "server-only";

// The cinatra#658 (PR-4) runtime-sourced connector card index.
//
// #657 made `installed_extension` the runtime source of truth and shipped the
// async actor-scoped predicate `isConnectorInstalledForActor`. This module is the
// PR-4 consumer: it resolves, for the connector CARD list, BOTH
//   (1) which CATALOG connectors are installed for the actor (the F1 migration:
//       the card filter moves off the sync static-only `isConnectorInstalled`
//       onto the runtime predicate), batched into ONE canonical read; and
//   (2) the RUNTIME-ONLY connectors — installed at runtime with NO build-time
//       catalog descriptor — sourced behind the SAME trust gate the setup route
//       uses, so a marketplace-installed connector with no bundled descriptor
//       appears on the card list without a rebuild.
//
// SECURITY: card VISIBILITY is gated on canonical-row membership in the actor's
// scope (fail-closed for runtime rows + store outage; bundled fallback only for a
// bundled built-in that legitimately has no row — CG-1). Runtime-only card
// metadata is sourced ONLY after the full anchor → integrity → signature → trust
// gate passes; the route vendor/slug are derived from the package NAME, never
// from self-described metadata. A `true` here is list visibility ONLY — never
// render/write authorization (the setup route keeps the full trust gate).

import {
  pickActiveInstallId,
  isInstallRowAddressableByActor,
  buildActorScopeForPick,
  resolveRuntimeConnectorCardRecord,
  type RuntimeConnectorCardRecord,
} from "@/lib/extension-install-resolution";
import { isConnectorInstalledFromRuntime } from "@cinatra-ai/extensions/connector-installed-predicate";
import { isWorkspaceAnchoredRow } from "@cinatra-ai/extensions/workspace-connector-anchor";
import {
  readInstalledExtensionsByPackageNames,
  listInstalledExtensions,
} from "@cinatra-ai/extensions/canonical-store";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import { getConnectorDescriptorByPackageId } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import type { ActorContext } from "@/lib/authz/actor-context";

/**
 * Batched actor-scoped installed predicate for a SET of catalog package ids.
 * Reads every candidate's canonical rows in ONE query (vs. one read per card),
 * then applies the SAME pure decision the per-package `isConnectorInstalledForActor`
 * uses. Returns the subset that is "installed" for the actor.
 *
 * On a canonical-store OUTAGE the read throws — caught here and treated as "no
 * addressable rows" for every package (we never invent a row): bundled connectors
 * stay visible via the static-manifest fallback, runtime-only connectors fail
 * closed. EXACTLY the per-package wrapper's outage posture, applied in bulk.
 */
export async function resolveInstalledCatalogConnectorIds(
  packageIds: readonly string[],
  actor: ActorContext | undefined | null,
): Promise<Set<string>> {
  const installed = new Set<string>();
  if (packageIds.length === 0) return installed;

  // A null actor addresses no scoped row → only the bundled fallback can apply.
  if (!actor) {
    for (const packageId of packageIds) {
      if (
        isConnectorInstalledFromRuntime({
          hasAddressableLiveCanonicalRowForActor: false,
          hasAddressableCanonicalRowForActor: false,
          bundledInStaticManifest: Object.hasOwn(STATIC_EXTENSION_MANIFEST, packageId),
        })
      ) {
        installed.add(packageId);
      }
    }
    return installed;
  }

  const scope = buildActorScopeForPick(actor);

  let rowsByPackage: Map<string, Awaited<ReturnType<typeof readInstalledExtensionsByPackageNames>> extends Map<string, infer V> ? V : never> | null = null;
  try {
    rowsByPackage = await readInstalledExtensionsByPackageNames(packageIds);
  } catch (err) {
    // Canonical-store OUTAGE: treat as no addressable rows anywhere (never invent
    // a row). Bundled connectors survive via the static fallback below.
    console.warn(
      "[installed-connectors] batched canonical install-row read failed " +
        "(treating as no addressable rows; bundled fallback still applies):",
      err instanceof Error ? err.message : err,
    );
    rowsByPackage = null;
  }

  for (const packageId of packageIds) {
    const rows = rowsByPackage?.get(packageId) ?? [];
    const hasAddressableCanonicalRowForActor = rows.some((r) =>
      isInstallRowAddressableByActor(r, scope),
    );
    const hasAddressableLiveCanonicalRowForActor =
      pickActiveInstallId(rows, scope) !== null;
    if (
      isConnectorInstalledFromRuntime({
        hasAddressableLiveCanonicalRowForActor,
        hasAddressableCanonicalRowForActor,
        bundledInStaticManifest: Object.hasOwn(STATIC_EXTENSION_MANIFEST, packageId),
      })
    ) {
      installed.add(packageId);
    }
  }
  return installed;
}

/**
 * The RUNTIME-ONLY connector card descriptors: connectors installed at runtime
 * (a live, addressable `installed_extension` row of kind `connector`) whose
 * package has NO build-time catalog descriptor, each resolved behind the full
 * trust gate (`resolveRuntimeConnectorCardRecord`). A connector that fails the
 * trust gate, or whose package name doesn't parse to `@vendor/slug`, is omitted.
 *
 * The union of these with the catalog cards is the complete runtime-sourced card
 * set. Discovery of candidate rows is scoped to the actor's org PLUS the
 * org-NULL workspace-anchored rows (see below) and re-checked per-row with
 * `pickActiveInstallId` (fail-closed: archived/cross-org/owner-less rows are not
 * addressable). On a canonical-store outage, returns [] (bundled/catalog cards
 * still render; a runtime-only card cannot be proven during the outage → fail
 * closed).
 *
 * cinatra#2694 / S3 #2697 — THE RUNTIME QUERY FILTER WAS THE SOLE GAP. The rest
 * of this path already admitted a workspace-anchored ("Workspace: All") install:
 * the addressability predicate treats an org-less row as addressable by any
 * authenticated actor (`isInstallRowAddressableByActor`,
 * src/lib/extension-install-resolution.ts lines 136-139: `if
 * (row.organizationId !== null && row.organizationId !== actor.organizationId)
 * return false`), and the catalog path above reads BY PACKAGE NAME with no org
 * filter at all (`readInstalledExtensionsByPackageNames(packageIds)`,
 * resolveInstalledCatalogConnectorIds). Only THIS discovery read pinned
 * `organization_id = <actor org>` exactly, so an org-NULL row was never even a
 * candidate. Verified on this branch — both citations re-read, not inherited.
 *
 * The org-NULL arm is narrowed to the WORKSPACE anchor (`isWorkspaceAnchoredRow`
 * — owner_level='workspace', organization_id NULL, owner_id='__platform__'), so
 * bundled/system `platform`-anchored rows keep exactly the path they had.
 */
export async function listRuntimeOnlyConnectorCards(
  actor: ActorContext | undefined | null,
): Promise<RuntimeConnectorCardRecord[]> {
  if (!actor) return [];

  const actorOrgId = actor.organizationId ?? null;
  let rows: Awaited<ReturnType<typeof listInstalledExtensions>>;
  try {
    // An org actor needs BOTH reads; an org-LESS actor's single org-NULL read
    // already covers the workspace tier, so it stays exactly one query.
    const [orgRows, workspaceRows] = await Promise.all([
      listInstalledExtensions({ kind: "connector", organizationId: actorOrgId }),
      actorOrgId === null
        ? Promise.resolve([])
        : listInstalledExtensions({ kind: "connector", organizationId: null }),
    ]);
    rows = [...orgRows, ...workspaceRows.filter((r) => isWorkspaceAnchoredRow(r))];
  } catch (err) {
    console.warn(
      "[installed-connectors] runtime-only connector discovery read failed " +
        "(no runtime-only cards this request):",
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  const scope = buildActorScopeForPick(actor);

  // Candidate package names: a connector with NO catalog descriptor that has a
  // LIVE addressable row for the actor. Deduplicate (multiple rows per package).
  const candidates = new Set<string>();
  // Group rows by package name so we can pick a live addressable one per package.
  const byPackage = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byPackage.get(row.packageName);
    if (bucket) bucket.push(row);
    else byPackage.set(row.packageName, [row]);
  }
  for (const [packageName, packageRows] of byPackage) {
    if (getConnectorDescriptorByPackageId(packageName)) continue; // catalog → not runtime-only
    if (pickActiveInstallId(packageRows, scope) === null) continue; // not live+addressable
    candidates.add(packageName);
  }

  const cards: RuntimeConnectorCardRecord[] = [];
  for (const packageName of candidates) {
    const card = await resolveRuntimeConnectorCardRecord(packageName, actor);
    if (card) cards.push(card);
  }
  return cards;
}
