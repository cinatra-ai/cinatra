import "server-only";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  firstLineTitle,
  isFileSourcedBinding,
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
  type MaterializationDecidedVerdict,
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
// Failure posture: `materializeRunArtifacts` NEVER throws. Every failure is a
// per-output `ok:false` outcome the caller records into stepResults, and that
// outcome is LOAD-BEARING (cinatra#2486): BOTH terminal branches — WayFlow
// (`handleWayflowTaskState`) and external-A2A (`finalizeExternalA2ARun`,
// cinatra#2497) — land the run `failed` with the reason in `agent_runs.error`
// and the full outcome list in the same stepResults payload, instead of
// reporting a clean success for a run that produced nothing. `[]` (no package,
// or a package declaring no bindings) stays a clean success; only a real
// `ok:false` fails the run. ONE documented asymmetry: the external-A2A branch
// does not treat the WHOLESALE `(binding-resolution)` outcome as fatal, because
// an external template's package name is a connector-derived routing key that
// resolves only when the remote peer really is a published cinatra package —
// see that function for the full rationale.
//
// Registry-outage narrowing (cinatra#2498): #2486 fails closed on a wholesale
// binding-resolution failure (registry unreachable) because it cannot prove
// the run owed no artifact. That fail-closed posture used to cover EVERY run,
// including ones whose packages declare no bindings at all. This module now
// consults `agent_templates.has_artifact_bindings` — the locally-persisted
// fact the OAS compiler derives at install/recompile time — BEFORE ever
// calling the registry; a locally-provable `false` returns `[]` straight
// away, so a registry outage only fails runs whose packages actually declare
// a binding (or predate the column, where the prior fail-closed behavior is
// preserved exactly). It runs BEFORE the wholesale-failure classification
// above, and BOTH terminal branches inherit it through this one function: an
// external-A2A run whose pinned template provably owes nothing now completes
// cleanly during an outage instead of failing on `unavailable`, and every path
// the flag cannot prove keeps #2497's classification untouched.
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
      /**
       * cinatra#2497 — set ONLY on the WHOLESALE binding-resolution outcome
       * (the run's package could not be read at all), and then always. A
       * POSITIVE classification, so a caller never has to infer intent from an
       * error string or from the synthetic `outputId`:
       *
       *   "package-not-found" — the registry answered a DEFINITIVE 404: this
       *     package does not exist, therefore the run demonstrably declared no
       *     artifact binding. The only outcome a caller may treat as "nothing
       *     was owed".
       *   "unavailable" — anything else (registry outage, auth/config failure,
       *     5xx, a failed template read). EVIDENCE-FREE: the package may well
       *     declare bindings, so a caller must NOT read this as "nothing was
       *     owed" — that is exactly the #2486 silent success.
       */
      bindingResolution?: "package-not-found" | "unavailable";
    };

/** pacote reports a registry 404 as `code: "E404"` / `statusCode: 404`. */
function isRegistryNotFound(err: unknown): boolean {
  const candidate = err as { code?: unknown; statusCode?: unknown } | null;
  return candidate?.code === "E404" || candidate?.statusCode === 404;
}

/**
 * cinatra#2497 — positively classify a wholesale binding-resolution failure.
 *
 * Fail-closed by default: `unavailable` unless absence is PROVEN. A connection
 * refusal, a 5xx, an auth or config failure, a failed template read — all stay
 * `unavailable`, because a caller must never read them as "this run declared no
 * artifact binding".
 *
 * A 404 out of `getAgentPackage` is NOT proof on its own: that call does a
 * packument read AND a tarball extraction, so a PRESENT package whose tarball
 * 404s is indistinguishable from an absent one. Absence is therefore confirmed
 * with a NAME-level, metadata-only packument probe — the only read that can
 * prove it. Runs on the FAILURE path only, never on the hot path.
 */
async function classifyBindingResolutionFailure(
  err: unknown,
  packageName: string | null,
): Promise<"package-not-found" | "unavailable"> {
  if (packageName === null || !isRegistryNotFound(err)) return "unavailable";
  try {
    const [{ getPublishedExtensionSummary }, { loadVerdaccioConfigForReads }] =
      await Promise.all([
        import("@cinatra-ai/registries"),
        import("@/lib/verdaccio-config"),
      ]);
    await getPublishedExtensionSummary(
      { packageName },
      await loadVerdaccioConfigForReads(),
    );
    // The packument resolves: the package EXISTS, so the 404 came from the
    // tarball (or a moved dist) — evidence-free, fail closed.
    return "unavailable";
  } catch (probeErr) {
    return isRegistryNotFound(probeErr) ? "package-not-found" : "unavailable";
  }
}

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

/** What the post-terminal pickup needs to know about the run's package. */
export type RunDerivationContext = {
  producesRefs: SemanticArtifactProducesRef[];
  hasBindings: boolean;
  /** The COLLECTED bindings themselves (cinatra#3030, item 0.22). The file half
   *  of the pickup needs the grammar, not just the fact that one exists: a
   *  binding may name a file of the run folder as its content source, and only
   *  the pickup — which runs where the folder is — can resolve that. OPTIONAL,
   *  so a caller that only ever supplies end-node outputs states nothing about
   *  files rather than an empty claim about them. */
  bindings?: CollectedArtifactBinding[];
};

/**
 * cinatra#1893 (epic #1883 A5): the run-derivation context the post-terminal
 * unbound-output job needs — the run agent's validated typed `produces` refs and
 * whether the package declared ANY artifact binding. Reuses the cached binding
 * loader (a pinned re-load is a cache hit). `packageName===null` (a template with
 * no package) yields an empty-produces / no-binding context, which the job
 * settles as `no_produces`.
 */
export async function loadRunDerivationContext(input: {
  templateId: string;
  packageVersion: string | null;
}): Promise<RunDerivationContext> {
  const packageName = await resolveTemplatePackageName(input.templateId);
  if (packageName === null) return { producesRefs: [], hasBindings: false, bindings: [] };
  const loaded = await loadRunPackageBindings({
    packageName,
    packageVersion: input.packageVersion,
  });
  return {
    producesRefs: loaded.producesRefs,
    hasBindings: loaded.bindings.length > 0,
    bindings: loaded.bindings,
  };
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

/**
 * cinatra#2498 — the run-completion terminal edge's read of the
 * locally-persisted binding-presence authority
 * (`agent_templates.has_artifact_bindings`), alongside the package name a
 * registry read still needs when that authority does not rule the registry
 * out. Kept separate from `resolveTemplatePackageName` (used by
 * `loadRunDerivationContext` and `materializeToolArtifact`, neither of which
 * benefits from the flag: the derivation job's own settlement already treats
 * "no binding" as a legitimate outcome, and the mid-flow tool call always
 * needs live produces data regardless) so this materializer's own terminal
 * gate stays the only caller that special-cases `false`.
 *
 * VERSION-PINNED, not template-scoped (codex round-1 finding). `agent_templates`
 * is a MUTABLE row a reinstall/recompile overwrites in place, but a run is
 * PINNED to the `packageVersion` it was created against. Trusting the
 * template's CURRENT `has_artifact_bindings` unconditionally would let an
 * in-flight run silently under-materialize the moment a concurrent reinstall
 * moves the template on to a different version: v1 declares a binding
 * (`true`), a run starts pinned to v1, a reinstall to v2 (no binding) flips
 * the row to `false` before the v1 run completes, and the v1 run would wrongly
 * skip a binding it still owes. So the flag is trusted ONLY when the row's
 * CURRENT `package_version` still equals `forPackageVersion` — otherwise the
 * template has moved on since the run started and the flag describes a
 * different version, so this returns `null` (unknown) and the caller falls
 * through to the registry, exactly as it did before this column existed. An
 * unpinned run (`forPackageVersion === null`, the floating dist-tag case)
 * always falls through too — mirrors `loadRunPackageBindings`'s own "never
 * cache an unpinned lookup" rule (the floating tag can move, so nothing
 * associated with "the template's current row" is safe to trust for it).
 */
async function resolveTemplatePackageAndBindingsFlag(
  templateId: string,
  forPackageVersion: string | null,
): Promise<{
  packageName: string | null;
  hasArtifactBindings: boolean | null;
}> {
  ensurePostgresSchema();
  const s = postgresSchema.replaceAll('"', '""');
  const res = await pool().query(
    `SELECT package_name, package_version, has_artifact_bindings FROM "${s}"."agent_templates" WHERE id = $1 LIMIT 1`,
    [templateId],
  );
  const row = res.rows[0] as
    | {
        package_name?: string | null;
        package_version?: string | null;
        has_artifact_bindings?: boolean | null;
      }
    | undefined;
  const versionPinMatches =
    forPackageVersion !== null &&
    typeof row?.package_version === "string" &&
    row.package_version === forPackageVersion;
  return {
    packageName:
      typeof row?.package_name === "string" && row.package_name.length > 0
        ? row.package_name
        : null,
    hasArtifactBindings:
      versionPinMatches && typeof row?.has_artifact_bindings === "boolean"
        ? row.has_artifact_bindings
        : null,
  };
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
export async function resolveRunScopeOwnership(input: {
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
 * WHY a refusal is a refusal (cinatra#3029, convergence).
 *
 * A caller that SETTLES on a refusal has to know whether the refusal is a fact
 * about the WORK or a fact about the MOMENT:
 *   - `accepts_mismatch` — the resolved type does not accept this form. A
 *     permanent property of the content and the installed type; re-driving
 *     changes nothing.
 *   - `not_write_allowed` — the install-state gate said no. That gate is
 *     FAIL-CLOSED on a canonical-store read error, so this value covers both a
 *     genuinely archived extension AND a database that was briefly unreachable.
 *     A caller must NOT settle permanently on it.
 *   - `path_collision` — the ledger identity is already held by a different
 *     materialization path; aliasing it would hand back a different-typed
 *     artifact.
 */
export type WriteClaimedRefusalReason =
  | "accepts_mismatch"
  | "not_write_allowed"
  | "path_collision";

/**
 * Shared write core for both materialization paths (cinatra#923 EndNode
 * bindings, cinatra#925 `artifact_materialize` tool): registry/accepts/
 * write-gate validation on an ALREADY-RESOLVED {extension, title, mime,
 * content}, then sha256 → ledger claim → write-through with the tx-composed
 * finalize → concurrent-loser recovery. Throws only on infra failure (both
 * callers wrap); every validation failure is a returned error string.
 */
export async function writeClaimedArtifact(input: {
  runId: string;
  orgId: string;
  createdBy: string | null;
  /** Ledger identity: the EndNode output name (bindings), the node id (tool), or
   *  a member of the reserved `cinatra:run-output:<name>` family (the default
   *  road, cinatra#3029). */
  outputId: string;
  /** The calling node id, or null on the post-terminal paths (no node). */
  nodeId: string | null;
  path: "end_node_binding" | "materialize_tool" | "derived_output" | "default_road";
  extension: string;
  /** The PINNED version of `extension`, recorded on the produced event beside
   *  the run (cinatra#3029, plan §8.2). */
  extensionVersion?: string | null;
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
  /** The DEFAULT ROAD's detection verdict (cinatra#3029, plan §8.2): the rung
   *  that decided the form, and the verdict it decided on. Written on the
   *  ledger CLAIM, so the decision is recorded even when the write that follows
   *  never commits. Absent on every declarative path — no ladder ran there. */
  decidedRung?: string;
  decidedVerdict?: MaterializationDecidedVerdict;
  /** OPTIONAL extra Tx2 queries composed into the SAME transaction as the
   *  artifact write + the ledger finalize (cinatra#1893). The derived_output
   *  path passes its token-guarded outbox `done`-settle here so the settle and
   *  the artifact commit atomically — a stale lease aborts the whole write. Runs
   *  ONLY on a fresh create (not on a dedupe short-circuit, where no Tx2 runs).
   *  Other callers omit it (behaviour unchanged). */
  extraTx2Queries?: (ids: {
    artifactId: string;
    representationRevisionId: string;
  }) => Array<{ text: string; values: unknown[] }>;
}): Promise<
  | {
      ok: true;
      artifactId: string;
      representationRevisionId: string;
      deduped: boolean;
    }
  | { ok: false; reason: WriteClaimedRefusalReason; error: string }
> {
  const acceptedMimes = input.resolvedTarget.acceptedFileMimeTypes;
  if (!acceptedMimes.includes(input.mime)) {
    return {
      ok: false,
      reason: "accepts_mismatch",
      error:
        `object type "${input.resolvedTarget.objectTypeId}" (extension "${input.extension}") accepts ` +
        `[${acceptedMimes.join(", ")}]; ${input.mimeDescription} "${input.mime}"`,
    };
  }
  if (!(await isArtifactExtensionWriteAllowed(input.extension, input.orgId))) {
    return {
      ok: false,
      reason: "not_write_allowed",
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
    decidedRung: input.decidedRung,
    decidedVerdict: input.decidedVerdict,
  });
  // cinatra#1893 Q3: the 4-part unique key (run, output_id, extension,
  // content_hash) excludes `path`. A same-key row whose `path` DIFFERS from this
  // write's path is a FOREIGN row (a different materialization intent that
  // aliased the key) — reusing/aliasing it could hand back or finalize a
  // different-typed artifact. Fail closed rather than alias. This covers BOTH a
  // finalized hit AND a re-used unfinalized claim (a fresh insert carries no
  // path — always this write's own — so the guard skips it). The reserved
  // `derived_output` sentinel output id makes a real collision practically
  // unreachable; this is the belt-and-suspenders codex asked for.
  if (claim.path !== undefined && claim.path !== input.path) {
    return {
      ok: false,
      reason: "path_collision",
      error:
        `materialization ledger identity collided with a different path ` +
        `("${claim.path}" vs "${input.path}") for run ${input.runId} ` +
        `output "${input.outputId}" extension "${input.extension}" — refusing to alias`,
    };
  }
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
      // cinatra#3029 (plan §8.2): the produced event records the producing
      // extension AND its pinned version beside the run.
      producerAssertionExtensionVersion: input.extensionVersion ?? null,
      skipFallbackClassification: true,
      additionalTx2Queries: (ids) => [
        buildFinalizeMaterializationQuery({
          ledgerId: claim.ledgerId,
          orgId: input.orgId,
          artifactId: ids.artifactId,
          representationRevisionId: ids.representationRevisionId,
        }),
        // cinatra#1893: the derived_output path's token-guarded outbox settle,
        // committed atomically with the artifact + finalize (a stale lease aborts
        // the whole Tx). Empty for every other caller.
        ...(input.extraTx2Queries?.(ids) ?? []),
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
 *
 * cinatra#2498 — the registry read below (`loadRunPackageBindings`) is the
 * ONLY way a registry outage can reach this function; its wholesale-failure
 * catch turns that outage into a synthetic `(binding-resolution)` failure
 * that fails the run (materialization-honesty gate, cinatra#2486). Before
 * that read, this function first consults the locally-persisted
 * `agent_templates.has_artifact_bindings` authority (compiled at
 * install/recompile time — see oas-compiler.ts step 10b). When it is
 * PROVABLY `false`, the run owes no artifact regardless of registry
 * reachability, so the function returns `[]` WITHOUT ever calling the
 * registry — a registry outage can no longer fail a binding-less run. `true`
 * and `null` (unknown — a legacy row with no backfill, cinatra#2498
 * acceptance item 3) both cannot be locally proven safe and fall through to
 * the registry read, preserving the exact pre-#2498 fail-closed behavior. The
 * flag is trusted ONLY when it still describes THIS run's pinned
 * `packageVersion` (`resolveTemplatePackageAndBindingsFlag`'s version-pin
 * guard) — a template row is mutable and a concurrent reinstall can move it
 * to a different version while this run is still in flight, so a flag that no
 * longer matches the pin is treated as unknown, never as a stale `false`.
 */
export async function materializeRunArtifacts(input: {
  runId: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  /** The run's runBy principal — persisted as the artifact's createdBy. */
  createdBy: string | null;
  /**
   * The run's structured declared output values — WayFlow's sentinel-surfaced
   * EndNode outputs, or (cinatra#2497, external-A2A) the merged artifact DATA
   * parts the proxy captured, which are the same channel by another name.
   * `null`: the run surfaced none.
   */
  endNodeOutputs: Record<string, unknown> | null;
}): Promise<RunArtifactMaterializationOutcome[]> {
  let bindings: CollectedArtifactBinding[];
  let producesRefs: SemanticArtifactProducesRef[] = [];
  const outcomes: RunArtifactMaterializationOutcome[] = [];
  // Hoisted so the catch below can run its name-level absence probe. `null` in
  // the catch means we never got as far as a registry read (the template read
  // itself failed) — evidence-free by construction.
  let resolvedPackageName: string | null = null;
  try {
    const { packageName, hasArtifactBindings } = await resolveTemplatePackageAndBindingsFlag(
      input.templateId,
      input.packageVersion,
    );
    if (packageName === null) return [];
    // Locally-provable "no bindings" — skip the registry entirely. This is
    // the ONLY branch that short-circuits; `true` and `null` both still need
    // the registry (to resolve the actual binding grammar, or because we
    // cannot prove the run owes nothing) and keep the existing posture below.
    // Deliberately BEFORE the `resolvedPackageName` hoist: this branch can
    // never reach the catch's classifier (cinatra#2497), because it never
    // performs a read that can fail. Ordering it first is the whole point of
    // cinatra#2498 — a template provably owing no binding at THIS run's pin
    // must not touch the registry at all, so no outage, 404 or probe can even
    // be observed for it. Every other path keeps #2497's classification.
    if (hasArtifactBindings === false) return [];
    resolvedPackageName = packageName;
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
    // template gone). One synthetic failure outcome, carrying the POSITIVE
    // classification (cinatra#2497) callers need to tell "this package does not
    // exist" apart from "the registry did not answer".
    return [
      {
        ok: false,
        outputId: "(binding-resolution)",
        nodeId: null,
        extension: null,
        bindingResolution: await classifyBindingResolutionFailure(
          err,
          resolvedPackageName,
        ),
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
    const failAt = (failedOutputId: string, error: string): void => {
      outcomes.push({
        ok: false,
        outputId: failedOutputId,
        nodeId,
        extension: binding.extension,
        error,
      });
    };
    const fail = (error: string): void => failAt(outputId, error);
    try {
      // ------------------------------------------------------------------
      // Resolve content / title / mime from the sentinel-declared outputs.
      // ------------------------------------------------------------------
      // A FILE-SOURCED binding belongs to the PICKUP, not to this pass
      // (item 0.22): the file it names lives in the run folder, which is read at
      // terminal success by the process the folder lives with. Skipping it here
      // is not dropping it — `pickUpDefaultRoadItems` writes it, under this same
      // binding, with `path: "end_node_binding"`.
      if (isFileSourcedBinding(binding)) continue;

      const outputs = input.endNodeOutputs;
      if (outputs === null) {
        fail(
          "run surfaced no structured declared outputs (no WayFlow EndNode sentinel / no external-A2A data part) — cannot resolve the binding",
        );
        continue;
      }

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

      const contentSource = binding.contentFrom;
      if (contentSource === undefined) {
        fail("the binding names no end-node output as its content source");
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

      /** One artifact of this binding — the shared tail of the single write and
       *  of every member of a fan-out. */
      const writeOne = async (member: {
        memberOutputId: string;
        title: string;
        content: string;
      }): Promise<void> => {
        const contentBytes = new TextEncoder().encode(member.content).byteLength;
        if (contentBytes > MAX_AUTHORED_CONTENT_BYTES) {
          failAt(
            member.memberOutputId,
            `resolved content (${contentBytes} bytes) exceeds the ${MAX_AUTHORED_CONTENT_BYTES}-byte cap`,
          );
          return;
        }
        const result = await writeClaimedArtifact({
          runId: input.runId,
          orgId: input.orgId,
          createdBy: input.createdBy,
          outputId: member.memberOutputId,
          nodeId,
          path: "end_node_binding",
          extension: binding.extension,
          title: member.title,
          mime,
          content: member.content,
          ownership,
          resolvedTarget: resolved.target,
          mimeDescription: "the binding resolved MIME",
        });
        if (!result.ok) {
          failAt(member.memberOutputId, result.error);
          return;
        }
        outcomes.push({
          ok: true,
          outputId: member.memberOutputId,
          nodeId,
          extension: binding.extension,
          artifactId: result.artifactId,
          representationRevisionId: result.representationRevisionId,
          deduped: result.deduped,
        });
      };

      /** One member of a list output, as bytes the write path stores. */
      const memberContent = (value: unknown): string | null => {
        if (typeof value === "string") return value;
        if (value === undefined || value === null) return null;
        if (mime === "application/json") return JSON.stringify(value);
        return null;
      };

      // ------------------------------------------------------------------
      // THE FAN-OUT (item 0.27): "a binding may declare that its output is a
      // list whose members are each an artifact [...] the materializer writes
      // one artifact per member [...] a member's ledger identity is the list
      // output's id with the member's position, so the ledger's key of run,
      // output, extension and content still holds; every member is its own
      // artifact, duplicates included — two identical members are two artifacts
      // over one blob, as the content-addressed store already works".
      //
      // Two identical members therefore need NO special case here: distinct
      // ledger identities give two claims, two writes and two artifacts, while
      // the store's substance key gives them one resource and one blob.
      // ------------------------------------------------------------------
      if (binding.membersAreArtifacts === true) {
        const list = outputs[contentSource];
        if (!Array.isArray(list)) {
          fail(
            `contentFrom output "${contentSource}" is declared a list of artifacts ` +
              `(membersAreArtifacts) but did not resolve to an array` +
              (list === undefined || list === null
                ? " (output missing from the run's declared outputs)"
                : ` (got ${typeof list})`),
          );
          continue;
        }
        for (let index = 0; index < list.length; index += 1) {
          const memberOutputId = `${outputId}#${index}`;
          const member = list[index];
          const content = memberContent(member);
          if (content === null) {
            failAt(
              memberOutputId,
              `member ${index} of "${contentSource}" did not resolve to a string` +
                ` (structured members are only accepted for application/json bindings)`,
            );
            continue;
          }
          let title: string;
          if (binding.titleFromMemberField !== undefined) {
            const field = binding.titleFromMemberField;
            const raw =
              typeof member === "object" && member !== null && !Array.isArray(member)
                ? (member as Record<string, unknown>)[field]
                : undefined;
            if (typeof raw !== "string" || raw.trim().length === 0) {
              failAt(
                memberOutputId,
                `titleFromMemberField "${field}" did not resolve to a non-empty string on ` +
                  `member ${index} of "${contentSource}"`,
              );
              continue;
            }
            title = raw.trim();
          } else {
            title = firstLineTitle(content);
            if (title.length === 0) {
              failAt(
                memberOutputId,
                `titleFromFirstLine found no first line on member ${index} of "${contentSource}"`,
              );
              continue;
            }
          }
          await writeOne({ memberOutputId, title, content });
        }
        continue;
      }

      // ---- the single artifact -------------------------------------------
      const contentRaw = outputs[contentSource];
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
          `contentFrom output "${contentSource}" did not resolve to a string` +
            (contentRaw === undefined || contentRaw === null
              ? " (output missing from the run's declared outputs)"
              : ` (got ${Array.isArray(contentRaw) ? "array" : typeof contentRaw}; structured values are only accepted for application/json bindings)`),
        );
        continue;
      }

      let title: string;
      if (binding.titleFrom !== undefined) {
        const titleRaw = outputs[binding.titleFrom];
        if (typeof titleRaw !== "string" || titleRaw.trim().length === 0) {
          fail(
            `titleFrom output "${binding.titleFrom}" did not resolve to a non-empty string`,
          );
          continue;
        }
        title = titleRaw.trim();
      } else {
        // The new title source of item 0.27, on a single artifact too.
        title = firstLineTitle(content);
        if (title.length === 0) {
          fail(`titleFromFirstLine found no first line in "${contentSource}"`);
          continue;
        }
      }

      await writeOne({ memberOutputId: outputId, title, content });
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
