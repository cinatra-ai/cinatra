import "server-only";
// The floor type's package name comes from the generated manifest data
// (the single "artifact-default-floor" role claimant) via the PURE-DATA
// @cinatra-ai/objects/artifact-floor subpath — no heavy objects barrel in
// the import graph (the old leaf-mirror rationale holds; the mirror
// itself is retired, cinatra#151 Stage 6).
import { DEFAULT_ARTIFACT_EXTENSION } from "@cinatra-ai/objects/artifact-floor";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";

// ---------------------------------------------------------------------------
// Deterministic producer assertions.
//
// When a deterministic agent run produced an artifact, the agent's
// `produces: SemanticArtifactRef[]` OAS declaration is the
// highest-confidence classification signal -- no LLM matcher needed.
// This module resolves + VALIDATES that signal BEFORE the
// artifact-creation Tx2, returning the assertion plan the creation
// path splices into Tx2 (via `buildAssertSemanticTypeQueries`,
// `assertedBy:"agent"`).
//
// Security: the run's org is the persisted `agent_runs.org_id`.
// Schema setup guarantees this column is present and non-null. A
// `createdByRunId` whose run is missing OR belongs to a different org
// is NEVER trusted: `validatedRunId` comes back `null` so the creation
// path does NOT persist a cross-org run id into
// `representation.created_by_run_id`, and `produces` is empty.
//
// Producer chain: packageVersion = `agent_runs.package_version`
// (pinned at request time); packageName =
// `agent_templates.package_name` keyed by `agent_runs.template_id`;
// then `getAgentPackage({packageName, packageVersion}).manifest` ->
// `readAgentProducesFromPackageManifest` (quietly-`[]` on any
// malformed/absent manifest). Any missing link => structured log +
// empty produces (the artifact still persists; the LLM matcher still
// runs as the fallback).
// ---------------------------------------------------------------------------

export type ProducerAssertionPlan = {
  /** The run id to persist into `representation.created_by_run_id`.
   *  `null` when the run is missing or cross-org -- never persist an
   *  unvalidated / cross-tenant run id. */
  validatedRunId: string | null;
  /** Distinct, default-floor-filtered semantic extension ids the
   *  producing agent declared. Empty when no trusted producer. */
  produces: string[];
};



const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

/**
 * Resolve the trusted producer-assertion plan for an artifact being
 * created by a deterministic agent run. Pure-ish: one or two scoped
 * SELECTs + a registry manifest read. Never throws -- every failure
 * path degrades to `{ validatedRunId: <validated|null>, produces: [] }`
 * so artifact creation is never blocked by producer resolution.
 */
export async function resolveProducerAssertionPlan(input: {
  createdByRunId?: string | null;
  orgId: string;
}): Promise<ProducerAssertionPlan> {
  const empty: ProducerAssertionPlan = {
    validatedRunId: null,
    produces: [],
  };
  if (!input.createdByRunId) return empty;
  ensurePostgresSchema();
  const schema = q();

  // 1) Org-validate the run. `agent_runs.org_id` is NOT NULL; a row
  //    whose org differs from the creating org is a cross-tenant
  //    smuggle attempt -- refuse to trust OR persist it.
  let runRow:
    | { org_id: string; package_version: string | null; template_id: string }
    | undefined;
  try {
    const [res] = runPostgresQueriesSync({
      connectionString: conn(),
      queries: [
        {
          text: `SELECT org_id, package_version, template_id
FROM "${schema}"."agent_runs" WHERE id = $1 LIMIT 1`,
          values: [input.createdByRunId],
        },
      ],
    });
    runRow = res?.rows?.[0] as typeof runRow;
  } catch (err) {
    console.warn(
      "[producer-assertions] agent_runs lookup failed:",
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
  if (!runRow) {
    console.warn(
      `[producer-assertions] createdByRunId ${input.createdByRunId} not found -- no producer assertions`,
    );
    return empty;
  }
  if (runRow.org_id !== input.orgId) {
    // Cross-org: never persist the run id, never assert. Provenance
    // scope must be enforced before producer assertions are trusted.
    console.warn(
      `[producer-assertions] createdByRunId ${input.createdByRunId} org mismatch (run org != creating org) -- dropping provenance + producer assertions`,
    );
    return empty;
  }

  // From here the run is SAME-ORG and trustable -- its id is safe to
  // persist even if producer resolution below yields nothing.
  const validatedRunId = input.createdByRunId;

  // 2) Resolve the pinned package identity.
  let packageName: string | undefined;
  try {
    const [res] = runPostgresQueriesSync({
      connectionString: conn(),
      queries: [
        {
          text: `SELECT package_name
FROM "${schema}"."agent_templates" WHERE id = $1 LIMIT 1`,
          values: [runRow.template_id],
        },
      ],
    });
    const row = res?.rows?.[0] as { package_name?: string | null } | undefined;
    packageName = row?.package_name ?? undefined;
  } catch (err) {
    console.warn(
      "[producer-assertions] agent_templates lookup failed:",
      err instanceof Error ? err.message : err,
    );
    return { validatedRunId, produces: [] };
  }
  if (!packageName) {
    console.warn(
      `[producer-assertions] template ${runRow.template_id} has no package_name -- no producer assertions (provenance still recorded)`,
    );
    return { validatedRunId, produces: [] };
  }

  // 3) Read the pinned package manifest + extract `produces`.
  try {
    const [{ getAgentPackage }, producesReader] = await Promise.all([
      import("@cinatra-ai/registries"),
      import("@cinatra-ai/extensions/agent-produces-reader"),
    ]);
    const pkg = await getAgentPackage({
      packageName,
      // package_version is nullable (a draft run may not pin one);
      // getAgentPackage resolves the dist-tag default when undefined.
      packageVersion: runRow.package_version ?? undefined,
    });
    const refs = producesReader.readAgentProducesFromPackageManifest(
      pkg.manifest,
    );
    // De-dupe + drop the default-floor type (the floor is owned by the
    // rebalance). `buildAssertSemanticTypeQueries` throws synchronously
    // on it, which must NEVER fail artifact creation.
    const seen = new Set<string>();
    const produces: string[] = [];
    for (const r of refs) {
      const ext = r.extension;
      if (!ext || seen.has(ext)) continue;
      if (ext === DEFAULT_ARTIFACT_EXTENSION) continue;
      seen.add(ext);
      produces.push(ext);
    }
    return { validatedRunId, produces };
  } catch (err) {
    console.warn(
      `[producer-assertions] manifest read failed for ${packageName}@${runRow.package_version ?? "(default)"}:`,
      err instanceof Error ? err.message : err,
    );
    return { validatedRunId, produces: [] };
  }
}
