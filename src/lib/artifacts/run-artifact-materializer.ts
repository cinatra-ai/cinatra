import "server-only";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  collectArtifactBindingsFromOasDocument,
  producesObjectTypeIdForExtension,
  type CollectedArtifactBinding,
  type SemanticArtifactProducesRef,
} from "@cinatra-ai/agents/artifact-binding";
import {
  deriveScopeOwnership,
  type ScopeDerivedOwnership,
} from "@cinatra-ai/mcp-server/obo-ceiling";
import { resolveBoundArtifactTarget } from "./resolve-bound-artifact-type";
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
//
// The deterministic `artifact_materialize` passthrough tool (cinatra#925,
// `materializeToolArtifact` below) shares the same write core
// (`writeClaimedArtifact`) and the same ledger with `path:'materialize_tool'`
// and the calling node's id as the output identity.
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
  {
    bindings: CollectedArtifactBinding[];
    errors: string[];
    produces: string[];
    producesRefs: SemanticArtifactProducesRef[];
  }
>();

async function loadRunPackageBindings(input: {
  packageName: string;
  packageVersion: string | null;
}): Promise<{
  bindings: CollectedArtifactBinding[];
  errors: string[];
  produces: string[];
  /** The FULL typed produces entries (cinatra#1454) — carries per-entry
   *  objectTypeId so the materializer resolves the declared target type. */
  producesRefs: SemanticArtifactProducesRef[];
}> {
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
  const [{ getAgentPackage }, producesReader, { loadVerdaccioConfigForReads }] =
    await Promise.all([
      import("@cinatra-ai/registries"),
      import("@cinatra-ai/extensions/agent-produces-reader"),
      import("@/lib/verdaccio-config"),
    ]);
  // getAgentPackage's fail-fast DI guard requires an explicit VerdaccioConfig
  // (cinatra#1454). This is a package-manifest READ, so use the READ-side
  // wrapper: it routes the consumer read token on consumer-attached instances
  // (where run completion happens) and falls through to the vendor loader
  // otherwise — the server-write loader would fail-closed on a consumer-only
  // instance lacking publish creds. Loaded only on a cache miss
  // (pinnedBindingsCache wraps the whole resolution above).
  const config = await loadVerdaccioConfigForReads();
  const pkg = await getAgentPackage(
    {
      packageName: input.packageName,
      packageVersion: input.packageVersion ?? undefined,
    },
    config,
  );
  // Defensive re-validation of binding↔produces parity at run time (the
  // compile/install gate already enforced it for fresh publishes). The
  // reader's quietly-[] result for an absent/malformed manifest block is
  // passed through AS the (empty) parity set — FAIL-CLOSED: a binding whose
  // package declares no produces yields a visible per-output failure, never
  // a skipped check (codex round 0). The produces set is also the runtime
  // authority for the `artifact_materialize` tool path (cinatra#925), so it
  // is computed (and cached) even when the OAS payload is absent/malformed.
  const producesRefs = producesReader.readAgentProducesFromPackageManifest(pkg.manifest);
  const produces = producesRefs.map((r) => r.extension);
  const payload = pkg.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const empty = { bindings: [], errors: [] as string[], produces, producesRefs };
    if (cacheKey !== null) pinnedBindingsCache.set(cacheKey, empty);
    return empty;
  }
  const collected = collectArtifactBindingsFromOasDocument(
    payload as Record<string, unknown>,
    { produces, producesRefs },
  );
  const result = { ...collected, produces, producesRefs };
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

// ---------------------------------------------------------------------------
// Write-time scope-derived ownership (#1885 C1 / D10).
//
// The run-completion materializer previously stamped EVERY output
// organization-wide (`ownerLevel: "organization"`), so an agent's outputs were
// visible far wider than the agent's own anchored reach. Now the row ownership
// is derived from the run's LOCKED template anchor + org + (optional) project
// launch, through the single shared derivation (`deriveScopeOwnership`) — the
// sibling projection of the OBO ceiling chain. A run is by definition an
// agent_run delegation, so this seam always derives from the anchor (no
// delegation gate is needed here — unlike objects_save, which serves chat +
// human callers too).
// ---------------------------------------------------------------------------
async function resolveRunScopeOwnership(input: {
  templateId: string;
  runId: string;
  orgId: string;
}): Promise<ScopeDerivedOwnership> {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const [tmplRes, runRes] = await Promise.all([
    pool().query(
      `SELECT owner_level, owner_id FROM "${s}"."agent_templates" WHERE id = $1 LIMIT 1`,
      [input.templateId],
    ),
    pool().query(
      `SELECT project_id FROM "${s}"."agent_runs" WHERE id = $1 LIMIT 1`,
      [input.runId],
    ),
  ]);
  const tmpl = tmplRes.rows[0] as
    | { owner_level?: string | null; owner_id?: string | null }
    | undefined;
  const run = runRes.rows[0] as { project_id?: string | null } | undefined;
  const derived = deriveScopeOwnership({
    ownerLevel: tmpl?.owner_level ?? null,
    ownerId: tmpl?.owner_id ?? null,
    orgId: input.orgId,
    projectId: run?.project_id ?? null,
  });
  // A corrupt partial anchor (known non-org owner tier with a missing id) fails
  // closed at ceiling derivation and never reaches a successful terminal run,
  // so `derived` is non-null here; the org-owned fallback preserves the
  // never-throw materializer contract if a raw-SQL fixture violates that.
  return (
    derived ?? {
      ownerLevel: "organization",
      ownerId: input.orgId,
      visibility: "organization",
      projectId: null,
    }
  );
}

async function* asUtf8Stream(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

/**
 * Shared write core for both materialization paths (cinatra#923 EndNode
 * bindings, cinatra#925 `artifact_materialize` tool): registry/accepts/
 * write-gate validation on an ALREADY-RESOLVED {extension, title, mime,
 * content}, then sha256 → ledger claim → write-through with the tx-composed
 * finalize → concurrent-loser recovery. Throws only on infra failure (both
 * callers wrap); every validation failure is a returned error string.
 */
async function writeClaimedArtifact(input: {
  runId: string;
  orgId: string;
  createdBy: string | null;
  /** Ledger identity: the EndNode output name (bindings) or node id (tool). */
  outputId: string;
  nodeId: string;
  path: "end_node_binding" | "materialize_tool";
  extension: string;
  title: string;
  mime: string;
  content: string;
  /** Scope-derived row ownership (#1885 C1 / D10) — replaces the hard-coded
   *  organization ownership; derived from the run's LOCKED template anchor. */
  ownership: ScopeDerivedOwnership;
  /** The declared object type + its accepted representation forms, ALREADY
   *  resolved by `resolveBoundArtifactTarget` (cinatra#1454) — replaces the
   *  retired `${extension}:artifact` umbrella lookup (#1824). */
  resolvedTarget: { objectTypeId: string; acceptedFileMimeTypes: string[] };
  /** Per-path wording for the accepts-mismatch error message. */
  mimeDescription: string;
}): Promise<
  | {
      ok: true;
      artifactId: string;
      representationRevisionId: string;
      deduped: boolean;
    }
  | { ok: false; error: string }
> {
  const acceptedMimes = input.resolvedTarget.acceptedFileMimeTypes;
  if (!acceptedMimes.includes(input.mime)) {
    return {
      ok: false,
      error:
        `object type "${input.resolvedTarget.objectTypeId}" (extension "${input.extension}") accepts ` +
        `[${acceptedMimes.join(", ")}]; ${input.mimeDescription} "${input.mime}"`,
    };
  }
  if (!(await isArtifactExtensionWriteAllowed(input.extension, input.orgId))) {
    return {
      ok: false,
      error: `artifact extension "${input.extension}" is not write-allowed for this org (archived/ungoverned-denied install state)`,
    };
  }

  // ------------------------------------------------------------------
  // Ledger claim → write-through (finalize atomic with the write).
  // ------------------------------------------------------------------
  const contentHash = createHash("sha256").update(input.content, "utf8").digest("hex");
  const claim = await claimMaterialization({
    orgId: input.orgId,
    runId: input.runId,
    outputId: input.outputId,
    nodeId: input.nodeId,
    path: input.path,
    extension: input.extension,
    contentHash,
  });
  if (claim.kind === "finalized") {
    return {
      ok: true,
      artifactId: claim.artifactId,
      representationRevisionId: claim.representationRevisionId,
      deduped: true,
    };
  }

  let created: { artifactId: string; representationRevisionId: string };
  try {
    created = await createSemanticArtifact({
      orgId: input.orgId,
      // The EXACT declared object type resolved from the binding/produces
      // discriminator (cinatra#1454) — no longer discarded (epic #1785 wave A3).
      objectType: input.resolvedTarget.objectTypeId,
      // The resolved accepts so the writer enforces the MIME even for a
      // claim-backed host type that carries no `isArtifact.accepts` on its def.
      expectedAcceptMimes: input.resolvedTarget.acceptedFileMimeTypes,
      createdBy: input.createdBy,
      // Scope-derived ownership (#1885 C1 / D10) — the run's anchor tuple,
      // no longer hard-coded organization-wide.
      ownerLevel: input.ownership.ownerLevel,
      ownerId: input.ownership.ownerId,
      visibility: input.ownership.visibility,
      title: input.title,
      declaredMime: input.mime,
      originKind: "agent_generated",
      stream: asUtf8Stream(input.content),
      // Server-side provenance: the actually-executing run id. The
      // existing cross-org validation inside the creation path yields
      // validatedRunId:null on any mismatch — never a caller-smuggled id.
      createdByRunId: input.runId,
      // The producer assertion is the deterministic classification;
      // scoped to THIS extension (multi-produce agents must not stamp
      // every declared type onto every output).
      producerAssertionExtension: input.extension,
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
        return {
          ok: true,
          artifactId: winner.artifactId,
          representationRevisionId: winner.representationRevisionId,
          deduped: true,
        };
      }
    }
    throw err;
  }

  // cinatra#1891 scope 7: enqueue the MEANING-matcher after agent-emit
  // materialization. The create above set `skipFallbackClassification: true` so
  // the matcher did NOT race the producer assertion — that assertion is now
  // committed (atomic in the create's Tx2), so we enqueue EXPLICITLY here,
  // post-commit. The matcher layers a meaning DRAFT on top of the producer's
  // structural type (a suggestion chip below the producer's classic assertion,
  // or an auto-surface if it out-confidences at/above threshold on a DIFFERENT
  // meaning extension). Best-effort — never fails the materialized write.
  const { enqueueArtifactMatchRun } = await import("./matcher-enqueue");
  await enqueueArtifactMatchRun({
    orgId: input.orgId,
    artifactId: created.artifactId,
    representationRevisionId: created.representationRevisionId,
    createdByRunId: input.runId,
  });

  return {
    ok: true,
    artifactId: created.artifactId,
    representationRevisionId: created.representationRevisionId,
    deduped: false,
  };
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
  let producesRefs: SemanticArtifactProducesRef[] = [];
  const outcomes: RunArtifactMaterializationOutcome[] = [];
  try {
    const packageName = await resolveTemplatePackageName(input.templateId);
    if (packageName === null) return [];
    const loaded = await loadRunPackageBindings({
      packageName,
      packageVersion: input.packageVersion,
    });
    bindings = loaded.bindings;
    producesRefs = loaded.producesRefs;
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

  // Warm the registry once so the declared-type resolution below sees every
  // installed type (the resolver reads `objectTypeRegistry.resolve`).
  registerAllObjectTypes();

  // Scope-derived ownership for every output of this run (#1885 C1 / D10) —
  // resolved once from the run's anchor, applied to each materialized row.
  const ownership = await resolveRunScopeOwnership({
    templateId: input.templateId,
    runId: input.runId,
    orgId: input.orgId,
  });

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
      // Resolve the binding to its DECLARED object type (cinatra#1454) — the
      // umbrella `${extension}:artifact` (#1824) is retired. Eligibility is the
      // org-chain winner-arbitrated artifact-safe claim set ∩ registered host
      // type; a binding objectTypeId (or the typed produces entry) pins the
      // exact type, else the single-artifact-safe-type fallback.
      // ------------------------------------------------------------------
      const resolved = await resolveBoundArtifactTarget({
        orgId: input.orgId,
        extension: binding.extension,
        bindingObjectTypeId: binding.objectTypeId,
        producesObjectTypeId:
          producesObjectTypeIdForExtension(producesRefs, binding.extension) ?? undefined,
      });
      if (!resolved.ok) {
        fail(resolved.error);
        continue;
      }

      // ------------------------------------------------------------------
      // Accepts/write-gate validation + ledger claim → write-through (finalize
      // atomic with the write) — the shared core (writeClaimedArtifact, also
      // driving the #925 tool path).
      // ------------------------------------------------------------------
      const result = await writeClaimedArtifact({
        runId: input.runId,
        orgId: input.orgId,
        createdBy: input.createdBy,
        outputId,
        nodeId,
        path: "end_node_binding",
        extension: binding.extension,
        title,
        mime,
        content,
        ownership,
        resolvedTarget: resolved.target,
        mimeDescription: "the binding resolved MIME",
      });
      if (!result.ok) {
        fail(result.error);
        continue;
      }
      outcomes.push({
        ok: true,
        outputId,
        nodeId,
        extension: binding.extension,
        artifactId: result.artifactId,
        representationRevisionId: result.representationRevisionId,
        deduped: result.deduped,
      });
    } catch (err) {
      fail(
        `materialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Deterministic `artifact_materialize` passthrough tool (cinatra#925).
// ---------------------------------------------------------------------------

export type ToolArtifactMaterialization =
  | {
      ok: true;
      artifactId: string;
      representationRevisionId: string;
      /** true when the idempotency ledger already held finalized refs. */
      deduped: boolean;
    }
  | { ok: false; error: string };

/**
 * Materialize ONE artifact for a mid-flow `artifact_materialize` passthrough
 * call (`src/app/api/agents/passthrough/route.ts`). Same write core and same
 * idempotency ledger as the run-completion path — `path:'materialize_tool'`,
 * ledger `output_id` = the calling node id, so a run retry re-hitting the
 * node with the same bytes returns the finalized refs instead of writing a
 * second artifact.
 *
 * FAIL-CLOSED produces parity at run time (defense-in-depth over the
 * compile-time collector): the extension must be declared in the run's
 * template package `cinatra.produces`; an empty/absent produces block
 * rejects. Never throws — every failure is a returned error the route
 * surfaces as an HTTP error to the calling node.
 */
export async function materializeToolArtifact(input: {
  runId: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  /** The run's runBy principal — persisted as the artifact's createdBy. */
  createdBy: string | null;
  /** The calling ApiNode's id — the ledger output identity. */
  nodeId: string;
  extension: string;
  /** OPTIONAL declared-type discriminator (cinatra#1454) — the exact
   *  `@scope/pkg:local-id` the tool materializes into. */
  objectTypeId?: string;
  title: string;
  mime: string;
  content: string;
}): Promise<ToolArtifactMaterialization> {
  try {
    const packageName = await resolveTemplatePackageName(input.templateId);
    if (packageName === null) {
      return {
        ok: false,
        error: `run template ${input.templateId} has no package name — cannot resolve cinatra.produces`,
      };
    }
    const loaded = await loadRunPackageBindings({
      packageName,
      packageVersion: input.packageVersion,
    });
    if (!loaded.produces.includes(input.extension)) {
      return {
        ok: false,
        error:
          `extension "${input.extension}" is not declared in ${packageName}'s ` +
          `cinatra.produces ([${loaded.produces.join(", ")}]) — declared ` +
          "production and materialization must agree",
      };
    }

    if (!TEXT_AUTHORING_COMPATIBLE_MIMES.has(input.mime)) {
      return {
        ok: false,
        error: `declaredMime "${input.mime}" is not text-authorable — artifact_materialize is v1-scoped to ${[...TEXT_AUTHORING_COMPATIBLE_MIMES].join(", ")}`,
      };
    }
    const title = input.title.trim();
    if (title.length === 0) {
      return { ok: false, error: "title must be a non-empty string" };
    }
    const contentBytes = new TextEncoder().encode(input.content).byteLength;
    if (contentBytes > MAX_AUTHORED_CONTENT_BYTES) {
      return {
        ok: false,
        error: `content (${contentBytes} bytes) exceeds the ${MAX_AUTHORED_CONTENT_BYTES}-byte cap`,
      };
    }

    // Warm the registry so declared-type resolution sees every installed type.
    registerAllObjectTypes();

    // Resolve the tool call to its DECLARED object type (cinatra#1454).
    const resolved = await resolveBoundArtifactTarget({
      orgId: input.orgId,
      extension: input.extension,
      bindingObjectTypeId: input.objectTypeId,
      producesObjectTypeId:
        producesObjectTypeIdForExtension(loaded.producesRefs, input.extension) ?? undefined,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };

    // Scope-derived ownership (#1885 C1 / D10) — the run's anchor tuple.
    const ownership = await resolveRunScopeOwnership({
      templateId: input.templateId,
      runId: input.runId,
      orgId: input.orgId,
    });

    return await writeClaimedArtifact({
      runId: input.runId,
      orgId: input.orgId,
      createdBy: input.createdBy,
      outputId: input.nodeId,
      nodeId: input.nodeId,
      path: "materialize_tool",
      extension: input.extension,
      title,
      mime: input.mime,
      content: input.content,
      ownership,
      resolvedTarget: resolved.target,
      mimeDescription: "the call declared MIME",
    });
  } catch (err) {
    return {
      ok: false,
      error: `materialization failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
