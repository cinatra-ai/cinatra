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
// THE ROAD IS ONE TEMPLATE ROW, READ WHOLE. The run's template row carries the
// package binding — its name AND the version this installation materialized the
// template from — and a run that pinned a version of its own at request time
// carries that instead. An admission is bound to a version, so a floating read
// of "whatever is published now" would let a republish widen a running flow's
// reach.

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { getPooledDb } from "@/lib/db/pooled";

export type RunExtensionContext = {
  packageName: string;
  /** The version the admission is bound to. A context never resolves without one. */
  packageVersion: string;
  /** The package's `cinatra` manifest block. */
  cinatra: Record<string, unknown>;
};

/** The package binding recorded on a template row: both halves, or neither. */
export type RunTemplatePackageBinding = {
  packageName: string | null;
  packageVersion: string | null;
};

function pool() {
  return getPooledDb({
    name: "extension-run-package",
    connectionString: () => getPostgresConnectionString(),
  });
}

/** A blank column is not a binding — it names nothing an admission can be bound to. */
function named(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The package binding on the run's template row — the name and the bound version. */
export async function resolveRunTemplatePackageBinding(
  templateId: string,
): Promise<RunTemplatePackageBinding> {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const res = await pool().query(
    `SELECT package_name, package_version FROM "${s}"."agent_templates" WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  const row = res.rows[0] as
    | { package_name?: string | null; package_version?: string | null }
    | undefined;
  return { packageName: named(row?.package_name), packageVersion: named(row?.package_version) };
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
 * carries no package, whose package binding names no version, or whose manifest
 * cannot be read, resolves to `null` and every W7 tool then refuses — an
 * unresolved caller is never "allow".
 */
export async function resolveRunExtensionContext(
  input: { templateId: string; packageVersion: string | null },
  deps: { loadManifest?: ManifestLoader } = {},
): Promise<RunExtensionContext | null> {
  const binding = await resolveRunTemplatePackageBinding(input.templateId);
  const packageName = binding.packageName;
  if (packageName === null) return null;
  // UNPINNED IS UNRESOLVED. Without a version there is no ONE declaration to
  // bind the admission to, and reading "whatever is published now" is exactly
  // the floating read this module refuses: a republish would widen a running
  // flow's reach with no restart and no rebinding.
  //
  // WHICH VERSION, THEN. The run's own pin when it carries one — the
  // request-time road pins the version a peer asked for, and a reinstall that
  // has since moved the template on must not move a running flow with it.
  // Otherwise the template row's own binding, which is not a floating read: it
  // records the exact version this installation materialized the template from,
  // and it is the SAME row the package name above already comes from — the
  // admission reads both halves of one binding, or neither. Neither present
  // resolves to null, and every W7 tool refuses.
  //
  // NOT WRITTEN ONTO THE RUN AT CREATION, deliberately. `agent_runs` encodes a
  // REQUIRED version pin as `version_id` AND `package_version` both set
  // (packages/agents execution, cinatra#1040 S7), and the roads that create a
  // run already pin `version_id` from a different table than the one the
  // required-pin resolver reads. Stamping the package version beside it forges
  // a required pin no snapshot can serve, and the run is refused before its
  // first step. The creation primitives keep the encoding they own; the caller
  // an admission is granted to is resolved here, where it is used.
  const packageVersion = named(input.packageVersion) ?? binding.packageVersion;
  if (packageVersion === null) return null;
  const load = deps.loadManifest ?? defaultManifestLoader;
  let manifest: Record<string, unknown> | null;
  try {
    manifest = await load({ packageName, packageVersion });
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== "object") return null;
  const cinatra = manifest.cinatra;
  return {
    packageName,
    packageVersion,
    cinatra:
      cinatra && typeof cinatra === "object" && !Array.isArray(cinatra)
        ? (cinatra as Record<string, unknown>)
        : {},
  };
}
