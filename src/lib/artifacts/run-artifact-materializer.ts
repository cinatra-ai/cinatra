import "server-only";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  collectArtifactBindingsFromOasDocument,
  type CollectedArtifactBinding,
} from "@cinatra-ai/agents/artifact-binding";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { getPooledDb } from "@/lib/db/pooled";
import {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { createSemanticArtifact } from "./artifact-creation";
import {
  MAX_AUTHORED_CONTENT_BYTES,
  TEXT_AUTHORING_COMPATIBLE_MIMES,
} from "./artifact-authoring";
import { isArtifactExtensionWriteAllowed } from "./artifact-extension-access";
import {
  claimMaterialization,
  buildFinalizeMaterializationQuery,
  isMaterializationFinalizeConflict,
  readFinalizedMaterialization,
} from "./materialization-ledger";

// ---------------------------------------------------------------------------
// Run-completion artifact materializer (cinatra#923).
//
// Called from the WayFlow terminal-success branch
// (`packages/agents/src/execution.ts:handleWayflowTaskState`) BEFORE the one
// `transitionRunStatus(..., "completed")` call, so the per-output refs (or
// failures) splice into the SAME `stepResults` payload — no second
// transition, no second write path.
//
// For every `outputs[].cinatra.artifact` binding the run's template package
// declares (grammar: @cinatra-ai/agents/artifact-binding), resolve
// content/title/mime from the EndNode-declared outputs the WayFlow sentinel
// surfaced, validate against the artifact extension's accepts, and write
// through `createSemanticArtifact` — the ONLY artifact write path — under
// the idempotency ledger (claim → write+finalize atomically → re-drives
// return the finalized refs).
//
// Failure posture: `materializeRunArtifacts` NEVER throws. Every failure is
// a per-output outcome the caller records into stepResults (visible, not
// fatal) — a materialization problem must never flip a completed run to
// failed nor block the terminal transition.
//
// The declarative path requires NO `skills.authoring` on the extension
// (`authorArtifact` stays the LLM-judgment path); title and MIME come from
// the binding — never prompt-invented.
// ---------------------------------------------------------------------------

export type RunArtifactMaterializationOutcome =
  | {
      ok: true;
      outputId: string;
      nodeId: string;
      extension: string;
      artifactId: string;
      representationRevisionId: string;
      /** true when the idempotency ledger already held finalized refs. */
      deduped: boolean;
    }
  | {
      ok: false;
      outputId: string;
      nodeId: string | null;
      extension: string | null;
      error: string;
    };

const ARTIFACT_TYPE_SUFFIX = ":artifact";

function pool(): Pool {
  return getPooledDb({
    name: "run-artifact-materializer",
    connectionString: () => getPostgresConnectionString(),
  });
}

// Published package versions are immutable, so bindings for a PINNED
// (packageName, packageVersion) pair are cacheable for the process lifetime.
// Unpinned lookups (null version → dist-tag default, which can move) are
// never cached.
const pinnedBindingsCache = new Map<
  string,
  { bindings: CollectedArtifactBinding[]; errors: string[] }
>();

async function loadRunPackageBindings(input: {
  packageName: string;
  packageVersion: string | null;
}): Promise<{ bindings: CollectedArtifactBinding[]; errors: string[] }> {
  const cacheKey =
    input.packageVersion !== null
      ? `${input.packageName}@${input.packageVersion}`
      : null;
  if (cacheKey !== null) {
    const cached = pinnedBindingsCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  // Dynamic imports keep the registries surface out of this module's static
  // graph (same posture as resolveProducerAssertionPlan).
  const [{ getAgentPackage }, producesReader] = await Promise.all([
    import("@cinatra-ai/registries"),
    import("@cinatra-ai/extensions/agent-produces-reader"),
  ]);
  const pkg = await getAgentPackage({
    packageName: input.packageName,
    packageVersion: input.packageVersion ?? undefined,
  });
  const payload = pkg.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const empty = { bindings: [], errors: [] as string[] };
    if (cacheKey !== null) pinnedBindingsCache.set(cacheKey, empty);
    return empty;
  }
  // Defensive re-validation of binding↔produces parity at run time (the
  // compile/install gate already enforced it for fresh publishes). The
  // reader's quietly-[] result for an absent/malformed manifest block is
  // passed through AS the (empty) parity set — FAIL-CLOSED: a binding whose
  // package declares no produces yields a visible per-output failure, never
  // a skipped check (codex round 0).
  const produces = producesReader
    .readAgentProducesFromPackageManifest(pkg.manifest)
    .map((r) => r.extension);
  const result = collectArtifactBindingsFromOasDocument(
    payload as Record<string, unknown>,
    { produces },
  );
  if (cacheKey !== null) pinnedBindingsCache.set(cacheKey, result);
  return result;
}

/** @visibleForTesting */
export function __resetRunPackageBindingsCacheForTests(): void {
  pinnedBindingsCache.clear();
}

async function resolveTemplatePackageName(
  templateId: string,
): Promise<string | null> {
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

async function* asUtf8Stream(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

/**
 * Materialize every declared artifact binding of a terminally-successful
 * run. Never throws; returns one outcome per binding (plus one synthetic
 * failed outcome per binding-collection error). Empty array when the run's
 * package declares no bindings.
 */
export async function materializeRunArtifacts(input: {
  runId: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  /** The run's runBy principal — persisted as the artifact's createdBy. */
  createdBy: string | null;
  /** Sentinel-surfaced EndNode declared output values (null: no sentinel). */
  endNodeOutputs: Record<string, unknown> | null;
}): Promise<RunArtifactMaterializationOutcome[]> {
  let bindings: CollectedArtifactBinding[];
  const outcomes: RunArtifactMaterializationOutcome[] = [];
  try {
    const packageName = await resolveTemplatePackageName(input.templateId);
    if (packageName === null) return [];
    const loaded = await loadRunPackageBindings({
      packageName,
      packageVersion: input.packageVersion,
    });
    bindings = loaded.bindings;
    for (const error of loaded.errors) {
      outcomes.push({
        ok: false,
        outputId: "(binding-validation)",
        nodeId: null,
        extension: null,
        error,
      });
    }
  } catch (err) {
    // Package/binding resolution failed wholesale (registry unreachable,
    // template gone). Visible-not-fatal: one synthetic failure outcome.
    return [
      {
        ok: false,
        outputId: "(binding-resolution)",
        nodeId: null,
        extension: null,
        error: `failed to load the run package's artifact bindings: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    ];
  }
  if (bindings.length === 0) return outcomes;

  // Warm the registry once for the accepts checks below.
  registerAllObjectTypes();
  const artifactDefs = objectTypeRegistry.listArtifacts();

  for (const { nodeId, outputId, binding } of bindings) {
    const fail = (error: string): void => {
      outcomes.push({
        ok: false,
        outputId,
        nodeId,
        extension: binding.extension,
        error,
      });
    };
    try {
      // ------------------------------------------------------------------
      // Resolve content / title / mime from the sentinel-declared outputs.
      // ------------------------------------------------------------------
      const outputs = input.endNodeOutputs;
      if (outputs === null) {
        fail(
          "run surfaced no EndNode declared outputs (WayFlow sentinel absent) — cannot resolve the binding",
        );
        continue;
      }
      const titleRaw = outputs[binding.titleFrom];
      if (typeof titleRaw !== "string" || titleRaw.trim().length === 0) {
        fail(
          `titleFrom output "${binding.titleFrom}" did not resolve to a non-empty string`,
        );
        continue;
      }
      const title = titleRaw.trim();

      let mime: string;
      if (binding.declaredMime !== undefined) {
        mime = binding.declaredMime;
      } else {
        const mimeRaw = outputs[binding.mimeFrom as string];
        if (typeof mimeRaw !== "string" || mimeRaw.length === 0) {
          fail(
            `mimeFrom output "${binding.mimeFrom}" did not resolve to a non-empty string`,
          );
          continue;
        }
        mime = mimeRaw;
      }
      if (!TEXT_AUTHORING_COMPATIBLE_MIMES.has(mime)) {
        fail(
          `resolved MIME "${mime}" is not text-authorable — declarative bindings are v1-scoped to ${[...TEXT_AUTHORING_COMPATIBLE_MIMES].join(", ")}`,
        );
        continue;
      }

      const contentRaw = outputs[binding.contentFrom];
      let content: string;
      if (typeof contentRaw === "string") {
        content = contentRaw;
      } else if (
        contentRaw !== undefined &&
        contentRaw !== null &&
        mime === "application/json"
      ) {
        // Structured EndNode output bound as application/json — serialize
        // deterministically. Never applied to non-JSON MIMEs (no value
        // invention).
        content = JSON.stringify(contentRaw);
      } else {
        fail(
          `contentFrom output "${binding.contentFrom}" did not resolve to a string` +
            (contentRaw === undefined || contentRaw === null
              ? " (output missing from the run's declared outputs)"
              : ` (got ${Array.isArray(contentRaw) ? "array" : typeof contentRaw}; structured values are only accepted for application/json bindings)`),
        );
        continue;
      }
      const contentBytes = new TextEncoder().encode(content).byteLength;
      if (contentBytes > MAX_AUTHORED_CONTENT_BYTES) {
        fail(
          `resolved content (${contentBytes} bytes) exceeds the ${MAX_AUTHORED_CONTENT_BYTES}-byte cap`,
        );
        continue;
      }

      // ------------------------------------------------------------------
      // Validate against the artifact extension (installed + accepts +
      // install-active write gate). Fail-closed per output.
      // ------------------------------------------------------------------
      const def = artifactDefs.find(
        (d) => d.type === `${binding.extension}${ARTIFACT_TYPE_SUFFIX}`,
      );
      const manifest = def?.isArtifact;
      if (!manifest) {
        fail(
          `artifact extension "${binding.extension}" is not installed/registered on this host`,
        );
        continue;
      }
      const acceptedMimes = manifest.accepts?.file?.mimeTypes ?? [];
      if (!acceptedMimes.includes(mime)) {
        fail(
          `extension "${binding.extension}" accepts [${acceptedMimes.join(", ")}]; the binding resolved MIME "${mime}"`,
        );
        continue;
      }
      if (!(await isArtifactExtensionWriteAllowed(binding.extension, input.orgId))) {
        fail(
          `artifact extension "${binding.extension}" is not write-allowed for this org (archived/ungoverned-denied install state)`,
        );
        continue;
      }

      // ------------------------------------------------------------------
      // Ledger claim → write-through (finalize atomic with the write).
      // ------------------------------------------------------------------
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      const claim = await claimMaterialization({
        orgId: input.orgId,
        runId: input.runId,
        outputId,
        nodeId,
        path: "end_node_binding",
        extension: binding.extension,
        contentHash,
      });
      if (claim.kind === "finalized") {
        outcomes.push({
          ok: true,
          outputId,
          nodeId,
          extension: binding.extension,
          artifactId: claim.artifactId,
          representationRevisionId: claim.representationRevisionId,
          deduped: true,
        });
        continue;
      }

      let created: { artifactId: string; representationRevisionId: string };
      try {
        created = await createSemanticArtifact({
          orgId: input.orgId,
          createdBy: input.createdBy,
          ownerLevel: "organization",
          ownerId: input.orgId,
          title,
          declaredMime: mime,
          originKind: "agent_generated",
          stream: asUtf8Stream(content),
          // Server-side provenance: the actually-executing run id. The
          // existing cross-org validation inside the creation path yields
          // validatedRunId:null on any mismatch — never a caller-smuggled id.
          createdByRunId: input.runId,
          // The producer assertion is the deterministic classification;
          // scoped to THIS binding's extension (multi-produce agents must
          // not stamp every declared type onto every output).
          producerAssertionExtension: binding.extension,
          skipFallbackClassification: true,
          additionalTx2Queries: (ids) => [
            buildFinalizeMaterializationQuery({
              ledgerId: claim.ledgerId,
              orgId: input.orgId,
              artifactId: ids.artifactId,
              representationRevisionId: ids.representationRevisionId,
            }),
          ],
        });
      } catch (err) {
        // Concurrent-double-drive loser (codex round 0): a parallel drive
        // finalized this claim first; OUR Tx2 (artifact included) rolled
        // back atomically. Recover the winner's refs — the output IS
        // materialized, exactly once.
        if (isMaterializationFinalizeConflict(err)) {
          const winner = await readFinalizedMaterialization({
            orgId: input.orgId,
            ledgerId: claim.ledgerId,
          });
          if (winner) {
            outcomes.push({
              ok: true,
              outputId,
              nodeId,
              extension: binding.extension,
              artifactId: winner.artifactId,
              representationRevisionId: winner.representationRevisionId,
              deduped: true,
            });
            continue;
          }
        }
        throw err;
      }
      outcomes.push({
        ok: true,
        outputId,
        nodeId,
        extension: binding.extension,
        artifactId: created.artifactId,
        representationRevisionId: created.representationRevisionId,
        deduped: false,
      });
    } catch (err) {
      fail(
        `materialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return outcomes;
}
