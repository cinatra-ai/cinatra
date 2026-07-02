import "server-only";

// Boot-time rematerialization sweep (cinatra#790/#791) — the concrete mechanism
// behind "the runtime store is a REBUILDABLE CACHE derived from the locked
// source": a cutover instance (new data root) or a wiped/replaced volume
// self-heals by re-materializing every live, real-pipeline install whose
// digest dir is missing from the V2 store.
//
// BEST-EFFORT + NON-FATAL by design: this runs inside the `extension-activation`
// boot phase BEFORE the RuntimePackageLoader pass. A per-package failure
// (registry unreachable, gatekept-only registry, closure package needing its
// signed plan) logs + skips — boot must never gain a hard registry dependency,
// and the loader's fail-closed trust gate downstream is unchanged (a package
// that could not re-materialize simply is not on disk to activate).
//
// Scope (deliberately narrow):
//   - rows with status active|locked and a REAL-pipeline verdaccio source
//     (a recorded non-placeholder `integrity`) — the only provenance shape the
//     default fetch seam can re-fetch;
//   - only when the install-op journal has a FINALIZED digest for the row (the
//     same anchor the loader binds to) AND that digest dir is absent on disk;
//   - closure packages (a recorded `closureHash`) are SKIPPED: re-executing a
//     signed materialization plan requires the plan transport, which is an
//     install-pipeline concern — a skipped closure package surfaces in the
//     result for the operator to re-install.
//
// cinatra#792 NOTE: when the DB-authoritative `source.activeDigest` lands, this
// sweep re-bases onto the SAME validated selector the loader uses
// (journal-gated activeDigest > journal > skip), so the sweep and the loader
// can never rebuild/select different digests.

import { isExtensionStoreKind, storeDigestDirV2 } from "@/lib/extension-package-store-core";

/** Integrity values that mean "not materialized through the real pipeline". */
const PLACEHOLDER_INTEGRITY = new Set(["", "dispatcher-install", "pending-resolution", "latest", "HEAD"]);

export type RematerializeResult = {
  /** Packages whose digest dir was rebuilt into the store. */
  rebuilt: string[];
  /** Packages skipped (already on disk / not re-buildable from this sweep). */
  skipped: string[];
  /** Packages whose re-materialize attempt failed (non-fatal, logged). */
  failed: { packageName: string; error: string }[];
};

type SweepRow = {
  packageName: string;
  organizationId: string | null;
  status: string;
  kind: string;
  source: {
    type?: string;
    integrity?: string;
    registryUrl?: string;
    version?: string;
    closureHash?: string;
  } | null;
};

export type RematerializeDeps = {
  /** Live canonical rows (default: the canonical store). */
  listRows?: () => Promise<SweepRow[]>;
  /** The finalized journal digest for a row (default: extension-install-ops). */
  readJournalDigest?: (packageName: string, orgId: string | null) => Promise<string | null>;
  /** Does the digest dir exist on disk? (default: real fs stat). */
  digestDirExists?: (dir: string) => Promise<boolean>;
  /** Materialize the package (default: the real materializer). */
  materialize?: (input: {
    packageName: string;
    version: string;
    expectedIntegrity: string;
    registryUrl: string;
    expectedKind: import("@/lib/extension-package-store-core").ExtensionStoreKind;
    storeRoot: string;
  }) => Promise<unknown>;
  /** Override the data root (default: resolveExtensionDataRoot()). */
  dataRoot?: string;
};

/**
 * Re-materialize every live install whose store digest dir is missing.
 * Never throws for per-package failures; returns the sweep summary.
 */
export async function rematerializeMissingInstalls(
  deps: RematerializeDeps = {},
): Promise<RematerializeResult> {
  const result: RematerializeResult = { rebuilt: [], skipped: [], failed: [] };

  const dataRoot =
    deps.dataRoot ?? (await import("@/lib/extension-data-root")).resolveExtensionDataRoot();
  const listRows =
    deps.listRows ??
    (async () => {
      const { listInstalledExtensions } = await import("@cinatra-ai/extensions/canonical-store");
      const rows = await listInstalledExtensions({});
      return rows.map((r) => ({
        packageName: r.packageName,
        organizationId: r.organizationId ?? null,
        status: r.status,
        kind: r.kind,
        source: (r.source ?? null) as SweepRow["source"],
      }));
    });
  const readJournalDigest =
    deps.readJournalDigest ??
    (async (packageName: string, orgId: string | null) => {
      const { readInstallOp } = await import("@/lib/extension-install-ops");
      const op = await readInstallOp(packageName, orgId);
      return op && op.phase === "finalized" ? (op.digest ?? null) : null;
    });
  const digestDirExists =
    deps.digestDirExists ??
    (async (dir: string) => {
      const { stat } = await import("node:fs/promises");
      try {
        return (await stat(dir)).isDirectory();
      } catch {
        return false;
      }
    });
  const materialize =
    deps.materialize ??
    (async (input) => {
      const { materializePackageToStore } = await import("@/lib/extension-package-store");
      return materializePackageToStore(input);
    });

  let rows: SweepRow[];
  try {
    rows = await listRows();
  } catch (err) {
    // No canonical store reachable → nothing to sweep (boot must not fail here).
    console.warn(
      "[extension-store-rematerialize] canonical rows unreadable — skipping sweep:",
      err instanceof Error ? err.message : err,
    );
    return result;
  }

  // De-dup by (packageName, org): one attempt per install identity.
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.packageName}::${row.organizationId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (row.status !== "active" && row.status !== "locked") continue;
    const src = row.source;
    if (!src || src.type !== "verdaccio") continue; // only re-fetchable provenance
    const integrity = src.integrity ?? "";
    if (PLACEHOLDER_INTEGRITY.has(integrity)) continue; // legacy/dispatcher rows
    if (!src.registryUrl || !src.version) {
      result.skipped.push(row.packageName);
      continue;
    }
    if (!isExtensionStoreKind(row.kind)) {
      result.skipped.push(row.packageName);
      continue;
    }
    if (src.closureHash) {
      // Closure packages need their signed plan (install-pipeline concern).
      result.skipped.push(row.packageName);
      continue;
    }

    let digest: string | null;
    try {
      digest = await readJournalDigest(row.packageName, row.organizationId);
    } catch {
      digest = null;
    }
    if (!digest) continue; // no finalized anchor digest → nothing bindable to rebuild

    let dir: string;
    try {
      dir = storeDigestDirV2(dataRoot, row.kind, row.packageName, digest);
    } catch {
      result.skipped.push(row.packageName);
      continue;
    }
    if (await digestDirExists(dir)) continue; // already materialized

    try {
      await materialize({
        packageName: row.packageName,
        version: src.version,
        expectedIntegrity: integrity,
        registryUrl: src.registryUrl,
        expectedKind: row.kind,
        storeRoot: dataRoot,
      });
      result.rebuilt.push(row.packageName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[extension-store-rematerialize] could not re-materialize ${row.packageName} (non-fatal): ${message}`,
      );
      result.failed.push({ packageName: row.packageName, error: message });
    }
  }
  return result;
}
