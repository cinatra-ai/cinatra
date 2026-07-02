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
 * Pure SCOPE predicate (status-agnostic): whether `row` is addressable in the
 * actor's scope, IGNORING lifecycle status. A row matches when its org equals the
 * actor's active org (cross-org rows are never addressable; a workspace-level row
 * with no org is addressable by any authenticated actor). A USER-owned row
 * requires the actor to be that user (a non-null `ownerId === actor.ownerId`);
 * a TEAM-owned row requires the actor to be a member of that team (a non-null
 * `ownerId ∈ actor.teamIds`) — a team install must surface to every team member.
 * Owner-scoped rows FAIL CLOSED on a null `ownerId`: the DB invariant is that a
 * user/team row always carries an owner, but this pure auth predicate never
 * trusts that invariant — a malformed owner-less user/team row is never
 * addressable.
 *
 * Factored out of `pickActiveInstallId` (cinatra#657) so a status-aware
 * read-model can distinguish `archived` (an addressable-but-not-live row) from
 * `absent` (no addressable row at all) WITHOUT re-implementing the scope rules;
 * `pickActiveInstallId` layers the live-status filter on top of this.
 */
export function isInstallRowAddressableByActor(
  row: InstallRowForPick,
  actor: ActorScopeForPick,
): boolean {
  // Org scoping: a row with an org must match the actor's active org; a row
  // with no org (workspace-level) is addressable by any authenticated actor.
  if (row.organizationId !== null && row.organizationId !== actor.organizationId) {
    return false;
  }
  // Owner scoping. user → only the owning user; team → any member of the
  // owning team; organization/workspace → already org-gated above (open).
  // Fail closed on a malformed owner-less user/team row regardless of the DB
  // invariant: a null owner can never be authorized against a concrete actor.
  if (row.ownerLevel === "user") {
    if (row.ownerId === null || row.ownerId !== actor.ownerId) return false;
  } else if (row.ownerLevel === "team") {
    if (row.ownerId === null || !actor.teamIds.includes(row.ownerId)) return false;
  }
  return true;
}

/**
 * Pure pick: from all install rows for a package, choose the id of the LIVE
 * (active|locked) row the actor can address. Layers the live-status filter on top
 * of `isInstallRowAddressableByActor` (the shared scope predicate). Returns the
 * first matching live row's id, or null when none exists.
 */
export function pickActiveInstallId(
  rows: readonly InstallRowForPick[],
  actor: ActorScopeForPick,
): string | null {
  for (const row of rows) {
    if (!LIVE_STATUSES.has(row.status)) continue;
    if (!isInstallRowAddressableByActor(row, actor)) continue;
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
  const record = await resolveTrustedRuntimeStoreRecord(packageName, actor, deps);
  if (!record) return null;
  // Only the two UI-render fields cross back to the route.
  return pickRuntimeConnectorUiRecord([record], packageName);
}

/**
 * The shared trust gate, returning the VERIFIED `PackageStoreRecord` (or null) so
 * BOTH the UI-render projection (`resolveRuntimeConnectorUiRecord`) and the
 * card/descriptor projection (`resolveRuntimeConnectorCardRecord`) consume the
 * exact same anchor → integrity → signature → trust-classification gate — no
 * second, weaker path can exist. Gate order (fail-closed, mirrors the boot
 * loader): (a) active canonical install for the actor's scope; (b) a non-null
 * TRUSTED install anchor sourced OUTSIDE the writable store; (c) a discovered
 * store record for the package; (d) integrity re-verification against the anchor;
 * (e) `classifyExtensionTrust(...).trusted`.
 *
 * Codex finding 5 (digest selection): the store may hold MULTIPLE digest snapshots
 * for one package name. Rather than `find()` the first (which might be a stale
 * digest that fails integrity while the current one would pass), we scan EVERY
 * candidate record for the package and return the FIRST that passes the full gate.
 * A package whose every candidate fails → null (fail-closed, never rendered).
 */
async function resolveTrustedRuntimeStoreRecord(
  packageName: string,
  actor: ActorContext | undefined | null,
  deps: RuntimeConnectorUiDeps = {},
): Promise<PackageStoreRecord | null> {
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

  // (c) discover the materialized store records for this package (ALL candidate
  // digests, not just the first).
  const storeRoot = deps.storeRoot ?? DEFAULT_PACKAGE_STORE_PATH;
  const discover =
    deps.discoverRecords ?? ((root: string) => discoverPackageStoreRecords(root, realStoreFs));
  const records = await discover(storeRoot);
  const candidates = records.filter((r) => r.packageName === packageName);
  if (candidates.length === 0) return null;

  const verifyIntegrity = deps.verifyIntegrity ?? defaultVerifyIntegrity;
  const classifyTrust = deps.classifyTrust ?? classifyExtensionTrust;

  // (d) + (e) apply the SAME trust gate the boot loader applies before importing
  // a package, scanning candidates until ONE passes (codex finding 5). A
  // revoked/non-trusted-host/tampered/unsigned-when-required package → not
  // trusted → skipped; if none passes → null.
  for (const record of candidates) {
    const integrityVerified = await verifyIntegrity(record, anchor);
    const verdict = classifyTrust({
      packageName,
      registryUrl: anchor.registryUrl,
      integrityVerified,
      persistedTrustDecision: anchor.trustDecision,
      // Same signature gate as the boot loader — a require-signatures host
      // (or a present-but-invalid signature) must not render the package either.
      signatureVerified: resolveSignatureVerdict({
        packageName,
        version: anchor.version ?? "",
        integrity: anchor.integrity,
        signature: anchor.signature,
        // cinatra#181: same closure downgrade-refusal as the boot loader.
        closureHash: anchor.closureHash ?? null,
      }),
      // Vendor-agnostic trust: same host allowlist + bootstrap lever the boot
      // loader uses. Rendering the connector UI is import-trust only (no
      // privileged capability), so `trusted-signed` OR `trusted-bootstrap` may
      // render.
      trustedActivationHosts: trustedActivationHosts(),
      allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
    });
    if (verdict.trusted) return record;
  }
  return null;
}

/**
 * A sanitized RUNTIME connector card/descriptor projection — the trusted store
 * record's identity needed to render a card + reach its setup route for a
 * connector that has NO build-time catalog descriptor (a purely runtime-installed
 * connector). Behind the SAME trust gate as the UI-render projection.
 *
 * codex finding 3: the route `vendor`/`slug` are DERIVED FROM THE PACKAGE NAME
 * (`@<vendor>/<slug>`), NEVER from self-described manifest metadata, so a
 * connector cannot spoof another connector's route. Only the DISPLAY-only fields
 * (displayName, logo) come from the manifest — and only AFTER the trust gate
 * passes — and the logo is sanitized to a safe data-URI (host-side, the same
 * allowlist the static path applies).
 */
export type RuntimeConnectorCardRecord = {
  packageName: string;
  /** Derived from the package name scope (`@<vendor>/…`). */
  vendor: string;
  /** Derived from the package name path (`@…/<slug>`). */
  slug: string;
  /** Trusted manifest display name, or the slug as a safe fallback. */
  displayName: string;
  /** Sanitized data-URI logo, or null. */
  logo: string | null;
  /** The connector's declared UI surface (schema-config / bundled-react / null). */
  uiSurface: ConnectorUiManifest["uiSurface"];
};

/** A self-describing logo is rendered as an <img src>; accept ONLY a small,
 *  raster `data:` URI (no `svg`, no remote URL, no `javascript:`) — identical
 *  posture to the static card path's logo handling. */
function sanitizeSelfDescribedLogo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) {
    return null;
  }
  // Cap the size so a card payload can't be abused as a multi-MB blob.
  return value.length <= 64_000 ? value : null;
}

/** Derive `{ vendor, slug }` from a scoped package name `@<vendor>/<slug>`. */
export function deriveVendorSlugFromPackageName(
  packageName: string,
): { vendor: string; slug: string } | null {
  const m = /^@([^/]+)\/([^/]+)$/.exec(packageName);
  if (!m) return null;
  return { vendor: m[1], slug: m[2] };
}

export async function resolveRuntimeConnectorCardRecord(
  packageName: string,
  actor: ActorContext | undefined | null,
  deps: RuntimeConnectorUiDeps & {
    /** Read a materialized package's manifest JSON (override for tests). */
    readManifest?: (storeDir: string) => Promise<Record<string, unknown> | null>;
  } = {},
): Promise<RuntimeConnectorCardRecord | null> {
  const record = await resolveTrustedRuntimeStoreRecord(packageName, actor, deps);
  if (!record) return null;
  const derived = deriveVendorSlugFromPackageName(packageName);
  if (!derived) return null;

  // Display-only metadata from the TRUSTED materialized manifest (read only AFTER
  // the gate passed). On any read failure, fall back to the derived slug — never
  // fail the card over missing cosmetic metadata.
  const readManifest =
    deps.readManifest ??
    (async (storeDir: string) => {
      try {
        const txt = await readFile(`${storeDir}/package.json`, "utf8");
        const parsed = JSON.parse(txt) as Record<string, unknown>;
        return parsed;
      } catch {
        return null;
      }
    });
  const manifest = await readManifest(record.storeDir);
  const cinatra = (manifest?.cinatra ?? null) as Record<string, unknown> | null;
  const displayName =
    typeof cinatra?.displayName === "string" && cinatra.displayName.trim()
      ? cinatra.displayName
      : derived.slug;
  const logo = sanitizeSelfDescribedLogo(cinatra?.logo);

  return {
    packageName,
    vendor: derived.vendor,
    slug: derived.slug,
    displayName,
    logo,
    uiSurface: record.uiSurface ?? null,
  };
}
