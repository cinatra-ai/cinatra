import "server-only";

// Resolve the `installId` (the `installed_extension.id`) of the ACTIVE install
// row a connector setup surface should drive its named actions against.
//
// The schema-config renderer POSTs to `/api/extensions/{installId}/actions/...`.
// Without an install row there is no addressable id, and an action POST would
// 404 opaquely — so the dispatch route resolves the install id here and, when
// none exists, renders an explicit Install / Activate CTA instead (never a
// silent 404, never a silent auto-install).
//
// The PICK is pure + dependency-injected (`pickActiveInstallId`) so it is
// unit-testable without a DB; `resolveActiveInstallIdForActor` is the thin IO
// wrapper around the canonical install store.

import {
  discoverPackageStoreRecords,
  DEFAULT_PACKAGE_STORE_PATH,
  type PackageStoreFs,
  type PackageStoreRecord,
} from "@cinatra-ai/sdk-extensions";
import { readFile, readdir, stat } from "node:fs/promises";
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ConnectorUiManifest } from "@/lib/connector-ui-render";
import {
  verifyMaterializedPackageIntegrity,
  type InstallTrustAnchor,
} from "@/lib/extension-package-store";
import { classifyExtensionTrust } from "@/lib/extension-trust";
import { resolveSignatureVerdict } from "@/lib/extension-signature";
import {
  trustedActivationHosts,
  allowMarketplaceBootstrapTrust,
} from "@/lib/extension-trust-config";

/** A live install row is `active` or `locked` — never `archived`. */
const LIVE_STATUSES = new Set(["active", "locked"]);

/** The minimal install-row + actor fields the pick needs (DI-friendly). */
export type InstallRowForPick = Pick<
  InstalledExtension,
  "id" | "status" | "organizationId" | "ownerId" | "ownerLevel"
>;

export type ActorScopeForPick = {
  organizationId: string | null;
  ownerId: string | null;
  /** The team ids the actor is a member of (a team-owned row is addressable iff its ownerId is in here). */
  teamIds: readonly string[];
};

/**
 * Pure pick: from all install rows for a package, choose the id of the live row
 * the actor can address. A row matches when its org equals the actor's active
 * org (cross-org rows are never addressable). Workspace/org-owned rows match any
 * member of the org. A USER-owned row requires the actor to be that user
 * (a non-null `ownerId === actor.ownerId`). A TEAM-owned row requires the actor
 * to be a member of that team (a non-null `ownerId ∈ actor.teamIds`) — a team
 * install must surface to every team member, not only whoever happens to share
 * the actor's principalId. Owner-scoped rows FAIL CLOSED on a null `ownerId`:
 * the DB invariant is that a user/team row always carries an owner, but the pure
 * auth predicate never trusts that invariant — a malformed owner-less user/team
 * row is never surfaced. Returns the first matching live row's id, or null when
 * none exists.
 */
export function pickActiveInstallId(
  rows: readonly InstallRowForPick[],
  actor: ActorScopeForPick,
): string | null {
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    // Org scoping: a row with an org must match the actor's active org; a row
    // with no org (workspace-level) is addressable by any authenticated actor.
    if (row.organizationId !== null && row.organizationId !== actor.organizationId) {
      continue;
    }
    // Owner scoping. user → only the owning user; team → any member of the
    // owning team; organization/workspace → already org-gated above (open).
    // Fail closed on a malformed owner-less user/team row regardless of the DB
    // invariant: a null owner can never be authorized against a concrete actor.
    if (row.ownerLevel === "user") {
      if (row.ownerId === null || row.ownerId !== actor.ownerId) continue;
    } else if (row.ownerLevel === "team") {
      if (row.ownerId === null || !actor.teamIds.includes(row.ownerId)) continue;
    }
    return row.id;
  }
  return null;
}

/**
 * Resolve the active `installId` for `packageName` and `actor`, or null when the
 * connector is not installed/active for the actor's scope (the caller renders an
 * Install / Activate CTA). Reads the canonical install store.
 */
export async function resolveActiveInstallIdForActor(
  packageName: string,
  actor: ActorContext | undefined | null,
): Promise<string | null> {
  if (!actor) return null;
  const rows = await readInstalledExtensionsByPackageName(packageName);
  return pickActiveInstallId(rows, {
    organizationId: actor.organizationId ?? null,
    ownerId: actor.principalId ?? null,
    // The actor's team memberships — a team-owned install surfaces to every team
    // member. `ActorContext.teamIds` is the resolved membership the rest of the
    // app authorizes against; `[]` when the actor is in no team / unresolved.
    teamIds: actor.teamIds ?? [],
  });
}

// ---------------------------------------------------------------------------
// Runtime (marketplace-installed) connector-UI record resolution
// ---------------------------------------------------------------------------
//
// A MARKETPLACE-INSTALLED `schema-config` connector ships its setup surface as
// DATA in its `package.json` (`cinatra.uiSurface` + `cinatra.configSchema`), not
// in the host's static `STATIC_EXTENSION_MANIFEST` (which only covers the
// base-image bundle). The dispatch route must therefore consult the on-disk
// package store the runtime installer materializes into, OR a schema-config
// connector installed at runtime 404s / falls into the bundled-react path.
//
// Trust is non-negotiable: a store record is consumed ONLY when (a) the actor
// has an ACTIVE install for the package in the canonical store (reuses
// `resolveActiveInstallIdForActor` — never package-supplied scope), AND (b) the
// package resolves a TRUSTED install anchor sourced OUTSIDE the writable store
// AND the selected store record PASSES the SAME boot-loader trust gate
// (`verifyMaterializedPackageIntegrity` against the anchor + `classifyExtensionTrust`
// → `verdict.trusted`). A non-null anchor alone is NOT sufficient: the anchor can
// be pending / revoked / non-allowlisted, and the materialized files can be
// tampered. Without the full gate the runtime surface is ignored and the static
// manifest remains the only source (the route renders the Install/Activate CTA).

/**
 * A trusted-anchor resolver: returns the `InstallTrustAnchor` (the integrity +
 * content hash + registry + persisted trust decision the gate consumes), or null
 * when the package has no real-pipeline active install for the actor's org.
 */
export type RuntimeAnchorResolver = (
  packageName: string,
) => Promise<InstallTrustAnchor | null>;

export type RuntimeConnectorUiDeps = {
  /** Discover store records (override for tests); defaults to the real `/data` store. */
  discoverRecords?: (storeRoot: string) => Promise<readonly PackageStoreRecord[]>;
  /** Resolve the trusted install anchor (override for tests); defaults to the canonical resolver. */
  resolveTrustAnchor?: RuntimeAnchorResolver;
  /**
   * Re-verify the materialized package against the trusted anchor (override for
   * tests); defaults to the real on-disk integrity check the boot loader uses.
   */
  verifyIntegrity?: (
    record: PackageStoreRecord,
    anchor: InstallTrustAnchor,
  ) => Promise<boolean>;
  /** Classify trust (override for tests); defaults to the host trust classifier. */
  classifyTrust?: typeof classifyExtensionTrust;
  /** Package store root (override for tests); defaults to the container `/data` store. */
  storeRoot?: string;
};

/** The boot-loader trust gate, applied to ONE selected store record + its anchor. */
const defaultVerifyIntegrity = (
  record: PackageStoreRecord,
  anchor: InstallTrustAnchor,
): Promise<boolean> =>
  verifyMaterializedPackageIntegrity(record, {
    trustedIntegrity: anchor.integrity,
    trustedContentHash: anchor.contentHash,
  });

/**
 * Pure pick: from discovered store records, return the `ConnectorUiManifest`
 * (just `uiSurface` + `configSchema`) for `packageName`, or null when the store
 * holds no record for it. Only the two UI-render fields cross into the route —
 * the rest of the record (serverEntry, ports, digest) is never exposed here.
 */
export function pickRuntimeConnectorUiRecord(
  records: readonly PackageStoreRecord[],
  packageName: string,
): ConnectorUiManifest | null {
  const rec = records.find((r) => r.packageName === packageName);
  if (!rec) return null;
  return {
    uiSurface: rec.uiSurface ?? null,
    configSchema: rec.configSchema ?? null,
  };
}

/** Real filesystem surface for store discovery (mirrors the runtime loader's). */
const realStoreFs: PackageStoreFs = {
  exists: async (p) => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: async (p) => {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: (p) => readdir(p),
  readFile: (p) => readFile(p, "utf8"),
};

/**
 * Resolve the runtime (marketplace-installed) connector-UI record for
 * `@${vendor}/${slug}` and `actor`, or null when there is no TRUSTED active
 * runtime install for it (the route then falls back to the static manifest /
 * renders the Install/Activate CTA).
 *
 * Gate order (fail-closed, mirrors the boot loader's trust gate exactly):
 *   (a) active canonical install for the actor's scope;
 *   (b) a non-null TRUSTED install anchor (sourced OUTSIDE the writable store);
 *   (c) a discovered store record for the package;
 *   (d) `verifyMaterializedPackageIntegrity(record, anchor)` — the on-disk files
 *       must match the anchor's integrity + content hash (tamper detection);
 *   (e) `classifyExtensionTrust(...).trusted === true` (vendor-agnostic) —
 *       integrity verified + a persisted (non-revoked) trust decision + the
 *       resolved host ∈ trustedActivationHosts + a verified signature OR
 *       marketplace-bootstrap. Rendering the connector UI is import-trust only, so
 *       `trusted-signed` OR `trusted-bootstrap` may render; scope is never read.
 * Any miss returns null. A non-null anchor is NEVER sufficient on its own: a
 * pending / revoked / non-allowlisted / tampered package fails (d)/(e) and the
 * route renders the Install/Activate CTA, never a package-store schema-config
 * form. The resolver is fully DI'd so it is unit-testable without a DB, a real
 * `/data` store, or on-disk tarballs.
 */
export async function resolveRuntimeConnectorUiRecord(
  packageName: string,
  actor: ActorContext | undefined | null,
  deps: RuntimeConnectorUiDeps = {},
): Promise<ConnectorUiManifest | null> {
  if (!actor) return null;

  // (a) the actor must have an active install for this package (canonical store;
  // the SAME scoping the action endpoint addresses — never package-supplied).
  const installId = await resolveActiveInstallIdForActor(packageName, actor);
  if (!installId) return null;

  // (b) the package must resolve a non-null TRUSTED install anchor (sourced
  // OUTSIDE the writable store). Scope the anchor to the actor's active org so a
  // multi-org package never reads one org's record against another org's trust
  // decision. A null anchor = no real-pipeline install → refuse.
  const resolveTrustAnchor =
    deps.resolveTrustAnchor ??
    (await (async () => {
      const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
      return makeDefaultInstallAnchorResolver(actor.organizationId ?? null);
    })());
  const anchor = await resolveTrustAnchor(packageName);
  if (!anchor) return null;

  // (c) discover the materialized store record for this package.
  const storeRoot = deps.storeRoot ?? DEFAULT_PACKAGE_STORE_PATH;
  const discover =
    deps.discoverRecords ?? ((root: string) => discoverPackageStoreRecords(root, realStoreFs));
  const records = await discover(storeRoot);
  const record = records.find((r) => r.packageName === packageName);
  if (!record) return null;

  // (d) + (e) apply the SAME trust gate the boot loader applies before importing
  // a package: re-verify the materialized files against the trusted anchor, then
  // classify (vendor-agnostic: verified integrity + persisted trust decision
  // + resolved host ∈ trustedActivationHosts + verified signature OR bootstrap).
  // A revoked/non-trusted-host/tampered/unsigned-when-required package → not
  // trusted → null. We never render its schema-config surface.
  const verifyIntegrity = deps.verifyIntegrity ?? defaultVerifyIntegrity;
  const classifyTrust = deps.classifyTrust ?? classifyExtensionTrust;
  const integrityVerified = await verifyIntegrity(record, anchor);
  const verdict = classifyTrust({
    packageName,
    registryUrl: anchor.registryUrl,
    integrityVerified,
    persistedTrustDecision: anchor.trustDecision,
    // Same signature gate as the boot loader — a require-signatures host
    // (or a present-but-invalid signature) must not render the package's
    // schema-config/uiSurface either.
    signatureVerified: resolveSignatureVerdict({
      packageName,
      version: anchor.version ?? "",
      integrity: anchor.integrity,
      signature: anchor.signature,
      // cinatra#181: same closure downgrade-refusal as the boot loader.
      closureHash: anchor.closureHash ?? null,
    }),
    // Vendor-agnostic trust: same host allowlist + bootstrap lever the boot
    // loader uses. Rendering the connector UI is import-trust only (no privileged
    // capability), so `trusted-signed` OR `trusted-bootstrap` may render.
    trustedActivationHosts: trustedActivationHosts(),
    allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
  });
  if (!verdict.trusted) return null;

  // Only the two UI-render fields cross back to the route.
  return pickRuntimeConnectorUiRecord([record], packageName);
}
