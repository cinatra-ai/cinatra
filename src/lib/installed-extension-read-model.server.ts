import "server-only";

// Installed-extension READ-MODEL (cinatra#657, Phase-A keystone).
//
// The issue enumerates per-record metadata an installed extension should expose:
// actor visibility, trust/signature verdict, source package-store record,
// activation generation, and teardown state. These are DERIVED / COMPUTED at
// query time — NOT new `installed_extension` columns and NOT a schema migration.
// This module assembles them on demand by JOINING the canonical row + the live
// trust verdict + the package-store record + the process control-plane generation.
//
// LIFECYCLE VOCABULARY (no schema change; the live model keeps the 3 statuses
// `[active, archived, locked]` — `packages/extensions/src/canonical-types.ts`).
// The issue's 5-state vocabulary is reconciled to the 3-status model + "no row":
//   - active   : a live, addressable row (running).
//   - locked   : a platform-required, host-trusted row (a system extension).
//   - archived ≈ disabled-but-recoverable : an addressable row whose status is
//                archived (the surface is hidden but the row + its data persist,
//                so a restore reactivates it). We DO NOT add a `disabled` status.
//   - absent   ≈ uninstalled : NO addressable row for this actor (never installed,
//                or hard-uninstalled — the canonical row is gone for this scope).
//
// CROSS-WORKER PROPAGATION — DECISION (cinatra#657): the activation generation +
// in-process capability teardown are PROCESS-LOCAL by design
// (`extension-activation-generation.ts`). This read-model surfaces this process's
// `activationGeneration` truthfully (a per-worker value), and the canonical
// row/status/trust fields are GLOBAL (read from the shared DB + package store) so
// the source-of-truth READ is correct on every web/worker/route handler NOW.
// Cross-worker LIVE-UNINSTALL propagation (an in-process teardown on worker A
// invalidating an already-warm in-process cache on worker B) is DEFERRED to a
// named follow-up — it spans Phase B/F (a DB-backed generation the per-request
// path compares against + lazy per-worker re-sync, OR a pub/sub teardown signal).
// PR-2 delivers the per-process runtime-sourced predicate + this read-model ONLY;
// it does NOT attempt cross-worker live-uninstall.

import {
  readInstalledExtensionsByPackageName,
} from "@cinatra-ai/extensions/canonical-store";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import {
  discoverPackageStoreRecords,
  DEFAULT_PACKAGE_STORE_PATH,
  type PackageStoreFs,
  type PackageStoreRecord,
} from "@cinatra-ai/sdk-extensions";
import { readFile, readdir, stat } from "node:fs/promises";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  isInstallRowAddressableByActor,
  type ActorScopeForPick,
} from "@/lib/extension-install-resolution";
import {
  verifyMaterializedPackageIntegrity,
  type InstallTrustAnchor,
} from "@/lib/extension-package-store";
import { classifyExtensionTrust, type TrustVerdict } from "@/lib/extension-trust";
import { resolveSignatureVerdict } from "@/lib/extension-signature";
import {
  trustedActivationHosts,
  allowMarketplaceBootstrapTrust,
} from "@/lib/extension-trust-config";
import { getActivationGeneration } from "@/lib/extension-activation-generation";

/**
 * The actor-scoped lifecycle status of an installed extension, reconciled to the
 * 3-status canonical model + "no row" (see the module docstring).
 *   - `active` | `locked` : a live, addressable row (running).
 *   - `archived`          : an addressable row, archived (hidden-but-recoverable).
 *   - `absent`            : no addressable row for this actor (uninstalled).
 */
export type ReadModelStatus = "active" | "locked" | "archived" | "absent";

/**
 * The teardown state of the extension's in-process capability registrations, as
 * known to THIS process. Process-local (see the cross-worker decision above):
 *   - `live`     : an addressable live row exists (the surface is active here).
 *   - `torn-down`: no addressable live row (archived/absent) — the in-process
 *                  capability-teardown hook removes its registrations on
 *                  archive/uninstall, so a non-live row means torn down here.
 */
export type ReadModelTeardownState = "live" | "torn-down";

/** The query-time per-record read-model the issue enumerates (cinatra#657). */
export type InstalledExtensionReadModel = {
  packageName: string;
  /** Whether the actor can see/address ANY row for this package (live or archived). */
  actorVisible: boolean;
  /** Actor-scoped lifecycle status (3-status model + absent). */
  status: ReadModelStatus;
  /** The package KIND from the addressable row, or null when absent. */
  kind: InstalledExtension["kind"] | null;
  /** The owner scope of the addressable row, or null when absent. */
  ownerScope: {
    ownerLevel: InstalledExtension["ownerLevel"];
    ownerId: string | null;
    organizationId: string | null;
  } | null;
  /** The in-process import-trust verdict (anchor → integrity → signature → classify), or null when not resolvable. */
  trust: TrustVerdict | null;
  /** Whether a cryptographic signature verified against a host-trusted key (derived; null when unknown). */
  signatureVerified: boolean | null;
  /** Whether a materialized package-store record is present for this package. */
  sourcePackageStoreRecordPresent: boolean;
  /** This PROCESS's control-plane (activation) generation at read time. */
  activationGeneration: number;
  /** Process-local teardown state of the extension's in-process registrations. */
  teardownState: ReadModelTeardownState;
};

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

export type InstalledExtensionReadModelDeps = {
  /** Read all canonical rows for a package (override for tests). */
  readRows?: (packageName: string) => Promise<InstalledExtension[]>;
  /** Discover store records (override for tests); defaults to the real `/data` store. */
  discoverRecords?: (storeRoot: string) => Promise<readonly PackageStoreRecord[]>;
  /** Resolve the trusted install anchor (override for tests); null when no real-pipeline install. */
  resolveTrustAnchor?: (packageName: string) => Promise<InstallTrustAnchor | null>;
  /** Re-verify the materialized package against the anchor (override for tests). */
  verifyIntegrity?: (
    record: PackageStoreRecord,
    anchor: InstallTrustAnchor,
  ) => Promise<boolean>;
  /** Classify trust (override for tests); defaults to the host classifier. */
  classifyTrust?: typeof classifyExtensionTrust;
  /** Package store root (override for tests). */
  storeRoot?: string;
  /** Read this process's control-plane generation (override for tests). */
  getActivationGeneration?: () => number;
};

const defaultVerifyIntegrity = (
  record: PackageStoreRecord,
  anchor: InstallTrustAnchor,
): Promise<boolean> =>
  verifyMaterializedPackageIntegrity(record, {
    trustedIntegrity: anchor.integrity,
    trustedContentHash: anchor.contentHash,
  });

function actorScopeForPick(actor: ActorContext): ActorScopeForPick {
  return {
    organizationId: actor.organizationId ?? null,
    ownerId: actor.principalId ?? null,
    teamIds: actor.teamIds ?? [],
  };
}

/**
 * Pick the most-relevant addressable row for the actor: prefer a LIVE row
 * (active|locked) over an archived one (a live install wins the actor-visible
 * status), and within live prefer `active` over `locked`. Returns null when NO
 * row is addressable for the actor (status `absent`).
 */
function pickAddressableRowForActor(
  rows: readonly InstalledExtension[],
  scope: ActorScopeForPick,
): InstalledExtension | null {
  const addressable = rows.filter((r) => isInstallRowAddressableByActor(r, scope));
  if (addressable.length === 0) return null;
  const rank = (s: InstalledExtension["status"]): number =>
    s === "active" ? 0 : s === "locked" ? 1 : 2; // archived last
  return [...addressable].sort((a, b) => rank(a.status) - rank(b.status))[0];
}

/**
 * Assemble the query-time read-model for `packageName` + `actor`. All fields are
 * DERIVED — no new DB columns. Fail-safe: a store/anchor/trust read that throws
 * degrades that FIELD to null (the canonical status fields stay authoritative);
 * a null actor yields an `absent`, not-visible record.
 *
 * NOTE: the trust verdict here is DESCRIPTIVE (a read-model field for operators/
 * UIs). It is NOT a render/execute authorization — rendering a runtime
 * schema-config surface still passes the live trust gate in
 * `resolveRuntimeConnectorUiRecord`, and action endpoints keep their own gates.
 */
export async function buildInstalledExtensionReadModel(
  packageName: string,
  actor: ActorContext | undefined | null,
  deps: InstalledExtensionReadModelDeps = {},
): Promise<InstalledExtensionReadModel> {
  const readActivationGeneration = deps.getActivationGeneration ?? getActivationGeneration;
  const activationGeneration = readActivationGeneration();

  const absent: InstalledExtensionReadModel = {
    packageName,
    actorVisible: false,
    status: "absent",
    kind: null,
    ownerScope: null,
    trust: null,
    signatureVerified: null,
    sourcePackageStoreRecordPresent: false,
    activationGeneration,
    teardownState: "torn-down",
  };

  if (!actor) return absent;

  const readRows = deps.readRows ?? readInstalledExtensionsByPackageName;
  let rows: InstalledExtension[];
  try {
    rows = await readRows(packageName);
  } catch {
    // Canonical-store outage: we cannot prove visibility — fail safe to absent
    // (never fabricate a row). This mirrors the predicate's outage handling.
    return absent;
  }

  const scope = actorScopeForPick(actor);
  const row = pickAddressableRowForActor(rows, scope);
  if (!row) return absent;

  const isLive = row.status === "active" || row.status === "locked";
  const status: ReadModelStatus = row.status; // active | locked | archived (addressable)

  // Source package-store record presence + the trust verdict are best-effort
  // descriptive fields — a failure degrades the field, never the whole record.
  let sourcePackageStoreRecordPresent = false;
  let trust: TrustVerdict | null = null;
  let signatureVerified: boolean | null = null;
  try {
    const storeRoot = deps.storeRoot ?? DEFAULT_PACKAGE_STORE_PATH;
    const discover =
      deps.discoverRecords ?? ((root: string) => discoverPackageStoreRecords(root, realStoreFs));
    const records = await discover(storeRoot);
    const record = records.find((r) => r.packageName === packageName) ?? null;
    sourcePackageStoreRecordPresent = record !== null;

    const resolveTrustAnchor =
      deps.resolveTrustAnchor ??
      (await (async () => {
        const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
        return makeDefaultInstallAnchorResolver(actor.organizationId ?? null);
      })());
    const anchor = await resolveTrustAnchor(packageName);

    if (record && anchor) {
      const verifyIntegrity = deps.verifyIntegrity ?? defaultVerifyIntegrity;
      const classifyTrust = deps.classifyTrust ?? classifyExtensionTrust;
      const integrityVerified = await verifyIntegrity(record, anchor);
      const sigVerdict = resolveSignatureVerdict({
        packageName,
        version: anchor.version ?? "",
        integrity: anchor.integrity,
        signature: anchor.signature,
        closureHash: anchor.closureHash ?? null,
      });
      // `resolveSignatureVerdict` returns `undefined` when no signature is present
      // / no signing is configured — normalize that to `null` (unknown) so the
      // read-model field stays `boolean | null`.
      signatureVerified = sigVerdict ?? null;
      trust = classifyTrust({
        packageName,
        registryUrl: anchor.registryUrl,
        integrityVerified,
        persistedTrustDecision: anchor.trustDecision,
        signatureVerified: sigVerdict,
        trustedActivationHosts: trustedActivationHosts(),
        allowMarketplaceBootstrapTrust: allowMarketplaceBootstrapTrust(),
      });
    }
  } catch {
    // Best-effort: leave trust/signature/store-presence at their safe defaults.
  }

  return {
    packageName,
    actorVisible: true,
    status,
    kind: row.kind,
    ownerScope: {
      ownerLevel: row.ownerLevel,
      ownerId: row.ownerId,
      organizationId: row.organizationId,
    },
    trust,
    signatureVerified,
    sourcePackageStoreRecordPresent,
    activationGeneration,
    teardownState: isLive ? "live" : "torn-down",
  };
}
