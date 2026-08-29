import "server-only";

// The RUN's own extension identity, and the manifest that says what it may
// reach (cinatra#3031, epic #3023 W7; plan (C) 0.25/0.26).
//
// Both W7 tool roads derive the CALLER from the run, never from the request:
// "with the caller derived from the run's extension identity" (0.25) and "only
// for types the calling extension declares as artifact dependencies — an
// admission bound to the declaration and the version" (0.26). A request-carried
// package name would let any bridge-token holder name someone else's extension,
// which is the whole perimeter.
//
// The road is the one the materializer already uses: the run's template row
// carries the package name, and the run's PINNED `packageVersion` selects the
// manifest — an admission is bound to the version, so a floating read of
// "whatever is published now" would let a republish widen a running flow's
// reach.

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { getPooledDb } from "@/lib/db/pooled";

export type RunExtensionContext = {
  packageName: string;
  /** The run's PINNED version. A context never resolves without one. */
  packageVersion: string;
  /** The package's `cinatra` manifest block. */
  cinatra: Record<string, unknown>;
};

function pool() {
  return getPooledDb({
    name: "extension-run-package",
    connectionString: () => getPostgresConnectionString(),
  });
}

/** The package name on the run's template row. */
export async function resolveRunTemplatePackageName(templateId: string): Promise<string | null> {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const res = await pool().query(
    `SELECT package_name FROM "${s}"."agent_templates" WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  const row = res.rows[0] as { package_name?: string | null } | undefined;
  return typeof row?.package_name === "string" && row.package_name.length > 0
    ? row.package_name
    : null;
}

type ManifestLoader = (input: {
  packageName: string;
  packageVersion: string | null;
}) => Promise<Record<string, unknown> | null>;

/** The registry read, dynamically imported so this module's static graph stays small. */
const defaultManifestLoader: ManifestLoader = async ({ packageName, packageVersion }) => {
  const [{ getAgentPackage }, { loadVerdaccioConfigForReads }] = await Promise.all([
    import("@cinatra-ai/registries"),
    import("@/lib/verdaccio-config"),
  ]);
  const config = await loadVerdaccioConfigForReads();
  const pkg = await getAgentPackage(
    { packageName, ...(packageVersion ? { packageVersion } : {}) },
    config,
  );
  const manifest = pkg.manifest as Record<string, unknown> | undefined;
  return manifest ?? null;
};

/**
 * Resolve the calling extension for a run. Fail-closed: a run whose template
 * carries no package, or whose manifest cannot be read, resolves to `null` and
 * every W7 tool then refuses — an unresolved caller is never "allow".
 */
export async function resolveRunExtensionContext(
  input: { templateId: string; packageVersion: string | null },
  deps: { loadManifest?: ManifestLoader } = {},
): Promise<RunExtensionContext | null> {
  const packageName = await resolveRunTemplatePackageName(input.templateId);
  if (packageName === null) return null;
  // UNPINNED IS UNRESOLVED. Without a version there is no ONE declaration to
  // bind the admission to, and reading "whatever is published now" is exactly
  // the floating read this module refuses: a republish would widen a running
  // flow's reach with no restart and no rebinding. So an unpinned run resolves
  // to null and every W7 tool refuses, rather than silently admitting the
  // registry's latest manifest.
  if (input.packageVersion === null || input.packageVersion.trim() === "") return null;
  const load = deps.loadManifest ?? defaultManifestLoader;
  let manifest: Record<string, unknown> | null;
  try {
    manifest = await load({ packageName, packageVersion: input.packageVersion });
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== "object") return null;
  const cinatra = manifest.cinatra;
  return {
    packageName,
    packageVersion: input.packageVersion,
    cinatra:
      cinatra && typeof cinatra === "object" && !Array.isArray(cinatra)
        ? (cinatra as Record<string, unknown>)
        : {},
  };
}
