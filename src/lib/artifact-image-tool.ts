import "server-only";
import { createHash } from "node:crypto";

import {
  producesObjectTypeIdForExtension,
  type SemanticArtifactProducesRef,
} from "@cinatra-ai/agents/artifact-binding";

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesAsync } from "@/lib/postgres-async";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { createSemanticArtifact } from "@/lib/artifacts/artifact-creation";
import { isArtifactExtensionWriteAllowed } from "@/lib/artifacts/artifact-extension-access";
import { appendArtifactRevision } from "@/lib/artifacts/artifact-revision-append";
import {
  buildFinalizeMaterializationQuery,
  buildImageGenerationProvenanceQuery,
  claimMaterialization,
  isMaterializationFinalizeConflict,
  readFinalizedMaterialization,
  readRevisionImageProvenance,
  type ImageGenerationProvenance,
} from "@/lib/artifacts/materialization-ledger";
import { resolveBoundArtifactTarget } from "@/lib/artifacts/resolve-bound-artifact-type";
import { mimeAcceptedByAccepts } from "@/lib/artifacts/upload-artifact-type-map";
import {
  loadRunDerivationContext,
  resolveRunScopeOwnership,
  type ScopeDerivedOwnership,
} from "@/lib/artifacts/run-artifact-materializer";

// ---------------------------------------------------------------------------
// THE IMAGE TOOL (plan (C) item 0.28, cinatra#3032, epic #3023 W8).
//
//   item 0.28: "Image generation for agents: one tool on the passthrough and
//   the self-served set — a prompt in, a picture filed — through the
//   deployment's configured image provider [...] The caller names the extension
//   the picture belongs to and the data the picture carries [...] and the tool
//   streams the bytes into the store the way an upload does and files the
//   artifact under that extension with that data in one write with a ledger row
//   [...] Regenerating a picture appends a revision to the same picture
//   artifact under the rule of item 0.30 [...] it refuses with a stated reason
//   when no provider is configured, and it is capped per run."
//
// WHY THIS IS A MODULE OF ITS OWN, beside the text materializer.
//
// The deterministic `artifact_materialize` road takes a STRING: it hashes the
// string as UTF-8, streams the string as UTF-8, and its write authorization
// refuses every form that is not text-authorable. A picture is none of those
// things — its bytes are not text, and UTF-8-encoding them would file a
// mangling of the picture rather than the picture. So this module takes the
// SAME ledger dance (claim by the run's own identity, write and finalize in one
// transaction, a re-drive of the same node with the same bytes returning the
// finalized refs) over BYTES, and asks the same questions of the caller that the
// text road asks: the extension must be one the run's package declared it
// produces, the call must resolve to exactly one declared object type, and the
// type must accept the form.
//
// The regeneration road is NOT re-implemented here either: it is the same
// `appendArtifactRevision` the mid-run revision uses, which is the ONE
// compare-and-set on the store. This module hands it bytes instead of text.
//
// NEVER THROWS. Every failure is a returned refusal with the reason it was
// refused, so the calling node fails visibly with a sentence rather than a
// stack.
//
// NO EXCEPTION TEXT IN A REFUSAL (cinatra#4223). A refusal reaches the calling
// node, and through the passthrough the flow. A provider's or a store's
// exception can name a credential, a schema, a table or a connection, so a
// failure that comes from a throw answers a fixed sentence and its detail is
// logged on the server, against the run and the node, and nowhere else.
// ---------------------------------------------------------------------------

/**
 * THE PER-RUN CAP (item 0.28: "and it is capped per run").
 *
 * A picture costs a provider call and a blob; a run that can ask for an
 * unbounded number of them can spend an unbounded amount on one brief. The
 * count is over the run's own FINALIZED picture writes — the ledger rows that
 * carry an image provider — so a refused call and a de-duplicated re-drive
 * never consume the budget.
 */
export const MAX_IMAGES_PER_RUN = 8;

/**
 * The forms a picture may take. Deliberately narrower than "anything the target
 * type accepts": the tool must know it is filing a picture, and a type that
 * accepts a picture may also accept text.
 */
export const IMAGE_TOOL_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** The maximum a single generated picture may weigh, mirroring the store's
 *  own per-representation soft default. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export type ArtifactImageRefusal =
  /** No image provider is configured for this deployment. */
  | "no_provider"
  /** The configured provider answered with nothing, or threw. */
  | "provider_failed"
  /** The extension is not in the run package's declared `cinatra.produces`. */
  | "not_produced"
  /** The provider answered with a form that is not a picture. */
  | "not_an_image"
  /** This run has already filed its allowance of pictures. */
  | "run_cap_exceeded"
  /** The call resolves to no single declared object type. */
  | "type_unresolved"
  /** The typed data does not satisfy the target type's declared schema. */
  | "data_rejected"
  /** The write itself was refused (accepts, write-eligibility, the ledger). */
  | "write_refused"
  /** A regeneration named a base another write has already built on. */
  | "stale_base";

export type ArtifactImageResult =
  | {
      ok: true;
      artifactId: string;
      representationRevisionId: string;
      /** The revision this write produced — 1 on a first generation. */
      revision: number;
      provider: string;
      model: string | null;
      mime: string;
      /** true when this exact node already filed these exact bytes. */
      deduped: boolean;
    }
  | { ok: false; reason: ArtifactImageRefusal; error: string };

/** The deployment's configured image provider, named, with the call it serves. */
export type ResolvedImageProvider = {
  provider: string;
  generateImage: (input: {
    prompt: string;
    model?: string;
  }) => Promise<{ imageData: string; mimeType: string; model?: string | null } | null>;
};

/**
 * The seams a caller may replace. The production set below is what the
 * passthrough wires; a suite replaces the provider (a real provider call proves
 * a provider, not this road) and the run package's registry read, exactly as
 * the run-completion road's own suites do.
 */
export type ArtifactImageToolDeps = {
  resolveImageProvider: () => Promise<ResolvedImageProvider | null>;
  loadProducesRefs: (input: {
    templateId: string;
    packageVersion: string | null;
  }) => Promise<readonly SemanticArtifactProducesRef[]>;
  resolveOwnership: (input: {
    templateId: string;
    runId: string;
    orgId: string;
  }) => Promise<ScopeDerivedOwnership>;
  countRunImages: (input: { orgId: string; runId: string }) => Promise<number>;
};

function schemaId(): string {
  return postgresSchema.replaceAll('"', '""');
}

async function countFinalizedRunImages(input: {
  orgId: string;
  runId: string;
}): Promise<number> {
  ensurePostgresSchema();
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT count(*)::int AS n FROM "${schemaId()}"."artifact_materializations"
                WHERE org_id = $1 AND run_id = $2 AND image_provider IS NOT NULL`,
        values: [input.orgId, input.runId],
      },
    ],
  });
  return Number((res?.rows?.[0] as { n?: number } | undefined)?.n ?? 0);
}

/** The production seam set — what the deterministic passthrough dispatches with. */
export function artifactImageToolDeps(): ArtifactImageToolDeps {
  return {
    resolveImageProvider: async () => {
      // Dynamic import keeps the provider graph out of this module's static
      // graph (same posture as the materializer's registry reads).
      const { resolveDefaultImageProvider, resolveScriptedImageProvider } = await import(
        "@cinatra-ai/llm"
      );
      const resolved = await resolveDefaultImageProvider();
      // No keyed provider can make a picture: the scripted image provider is
      // the last resort. It resolves only under the scripted test flag in an
      // explicit development runtime and answers a constant placeholder PNG
      // under its own provider and model names, which the provenance below
      // records; everywhere else it is null and the call is refused as
      // `no_provider`.
      if (!resolved?.adapter.generateImage) return resolveScriptedImageProvider();
      const adapter = resolved.adapter;
      return {
        provider: resolved.provider,
        generateImage: (call) =>
          adapter.generateImage!({
            prompt: call.prompt,
            ...(call.model ? { model: call.model } : {}),
            logLabel: "artifact_image_generate",
          }),
      };
    },
    loadProducesRefs: async (i) =>
      (await loadRunDerivationContext(i)).producesRefs,
    resolveOwnership: (i) => resolveRunScopeOwnership(i),
    countRunImages: (i) => countFinalizedRunImages(i),
  };
}

async function* asImageStream(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export type GenerateArtifactImageInput = {
  runId: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  /** The run's runBy principal — persisted as the artifact's createdBy. */
  createdBy: string | null;
  /** The calling node's id — the ledger's output identity. */
  nodeId: string;
  /** The artifact extension the picture belongs to. */
  extension: string;
  /** OPTIONAL declared-type discriminator — the exact `@scope/pkg:local-id`. */
  objectTypeId?: string;
  /** The picture's title. Empty on a regeneration: the artifact already has one. */
  title: string;
  /** What the picture is of. Recorded on the ledger row of THIS write. */
  prompt: string;
  /** An image model the caller names; the adapter may address another. */
  model?: string;
  /**
   * THE DATA THE PICTURE CARRIES (item 0.28) — the object's own fields, for a
   * blog picture its post and its placement. Validated against the target
   * type's declared schema by the one write path, so a field the type does not
   * declare refuses the write before a byte is written.
   */
  data?: Record<string, unknown>;
  /**
   * THE REGENERATION (item 0.28 through item 0.30). Present together, they name
   * the picture to revise and the revision the caller read — the compare-and-set's
   * expected base — and the write appends the next revision of THAT artifact
   * instead of filing a second picture.
   */
  artifactId?: string;
  baseRepresentationRevisionId?: string;
};

export async function generateArtifactImage(
  input: GenerateArtifactImageInput,
  deps: ArtifactImageToolDeps = artifactImageToolDeps(),
): Promise<ArtifactImageResult> {
  try {
    const prompt = input.prompt.trim();
    if (prompt.length === 0) {
      return {
        ok: false,
        reason: "provider_failed",
        error: "prompt must be a non-empty string — a picture is made from what it is asked for",
      };
    }

    // ------------------------------------------------------------------
    // THE PROVIDER FIRST (item 0.28: "it refuses with a stated reason when no
    // provider is configured"). Asked before anything is read or written, so a
    // deployment that cannot make a picture says so at once and costs nothing.
    // ------------------------------------------------------------------
    const provider = await deps.resolveImageProvider();
    if (!provider) {
      return {
        ok: false,
        reason: "no_provider",
        error:
          "no image provider is configured for this deployment — set the default image " +
          "provider, or configure a provider whose adapter can generate an image; " +
          "no picture was made",
      };
    }

    // ------------------------------------------------------------------
    // The write authorization, asked of the SAME facts the text road asks of:
    // the extension is one the run's package DECLARED it produces, and the call
    // resolves to exactly one declared object type.
    // ------------------------------------------------------------------
    const producesRefs = await deps.loadProducesRefs({
      templateId: input.templateId,
      packageVersion: input.packageVersion,
    });
    const declared = producesRefs.map((r) => r.extension);
    if (!declared.includes(input.extension)) {
      return {
        ok: false,
        reason: "not_produced",
        error:
          `extension "${input.extension}" is not declared in this run package's ` +
          `cinatra.produces ([${declared.join(", ")}]) — declared production and ` +
          "picture-filing must agree",
      };
    }
    // ------------------------------------------------------------------
    // THE PER-RUN CAP, asked as soon as the run is known to be allowed to file
    // this extension at all — before any type resolution and before the provider
    // is asked for a picture nobody may keep.
    // ------------------------------------------------------------------
    const already = await deps.countRunImages({ orgId: input.orgId, runId: input.runId });
    if (already >= MAX_IMAGES_PER_RUN) {
      return {
        ok: false,
        reason: "run_cap_exceeded",
        error:
          `this run has already filed ${already} pictures, which is its allowance of ` +
          `${MAX_IMAGES_PER_RUN} — no picture was made`,
      };
    }

    registerAllObjectTypes();
    const resolvedTarget = await resolveBoundArtifactTarget({
      orgId: input.orgId,
      extension: input.extension,
      bindingObjectTypeId: input.objectTypeId,
      producesObjectTypeId:
        producesObjectTypeIdForExtension(producesRefs, input.extension) ?? undefined,
    });
    if (!resolvedTarget.ok) {
      return { ok: false, reason: "type_unresolved", error: resolvedTarget.error };
    }
    if (!(await isArtifactExtensionWriteAllowed(input.extension, input.orgId))) {
      return {
        ok: false,
        reason: "write_refused",
        error:
          `artifact extension "${input.extension}" is not write-allowed for this org ` +
          "(archived/ungoverned-denied install state)",
      };
    }

    // ------------------------------------------------------------------
    // The picture itself.
    // ------------------------------------------------------------------
    let generated: { imageData: string; mimeType: string; model?: string | null } | null;
    try {
      generated = await provider.generateImage({
        prompt,
        ...(input.model ? { model: input.model } : {}),
      });
    } catch (err) {
      logFilingFailure("artifact_image_generate", input, err);
      return {
        ok: false,
        reason: "provider_failed",
        error: `the ${provider.provider} image provider failed; ${PROVIDER_FAILED_DETAIL}`,
      };
    }
    if (!generated || typeof generated.imageData !== "string" || generated.imageData.length === 0) {
      return {
        ok: false,
        reason: "provider_failed",
        error: `the ${provider.provider} image provider returned no image for this prompt`,
      };
    }
    const mime = String(generated.mimeType ?? "").toLowerCase();
    if (!IMAGE_TOOL_MIME_TYPES.has(mime)) {
      return {
        ok: false,
        reason: "not_an_image",
        error:
          `the ${provider.provider} image provider answered with "${generated.mimeType}", which is ` +
          `not a picture form this tool files (${[...IMAGE_TOOL_MIME_TYPES].join(", ")})`,
      };
    }
    // THE WILDCARD-AWARE MATCHER, the one the canonical writer and the
    // revision-append road both use. A literal `includes` refuses a PNG for a
    // type that declares `image/*` — a picture the writer beside it would have
    // accepted, refused only after the provider had already been paid for it.
    if (!mimeAcceptedByAccepts(resolvedTarget.target.acceptedFileMimeTypes, mime)) {
      return {
        ok: false,
        reason: "write_refused",
        error:
          `object type "${resolvedTarget.target.objectTypeId}" (extension "${input.extension}") ` +
          `accepts [${resolvedTarget.target.acceptedFileMimeTypes.join(", ")}]; the generated ` +
          `picture is "${mime}"`,
      };
    }
    const bytes = Buffer.from(generated.imageData, "base64");
    if (bytes.byteLength === 0) {
      return {
        ok: false,
        reason: "provider_failed",
        error: `the ${provider.provider} image provider returned an empty picture`,
      };
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: "write_refused",
        error: `the generated picture (${bytes.byteLength} bytes) exceeds the ${MAX_IMAGE_BYTES}-byte cap`,
      };
    }
    const provenance: ImageGenerationProvenance = {
      prompt,
      provider: provider.provider,
      model: typeof generated.model === "string" && generated.model.length > 0 ? generated.model : null,
    };

    // ------------------------------------------------------------------
    // THE REGENERATION (item 0.28 through item 0.30): the same picture gains a
    // revision. The ONE compare-and-set on the store does it — this road only
    // hands it the bytes and the provenance of the write.
    // ------------------------------------------------------------------
    if (
      typeof input.artifactId === "string" &&
      typeof input.baseRepresentationRevisionId === "string"
    ) {
      const appended = await appendArtifactRevision({
        orgId: input.orgId,
        runId: input.runId,
        nodeId: input.nodeId,
        artifactId: input.artifactId,
        baseRepresentationRevisionId: input.baseRepresentationRevisionId,
        content: bytes,
        mime,
        createdBy: input.createdBy,
        extension: input.extension,
        expectedObjectTypeId: resolvedTarget.target.objectTypeId,
        imageProvenance: provenance,
      });
      if (!appended.ok) {
        return {
          ok: false,
          reason: appended.reason === "stale_base" ? "stale_base" : "write_refused",
          error: appended.error,
        };
      }
      // A re-drive of this exact append is served by the write that landed:
      // it reports the facts stored with that revision.
      if (appended.deduped) {
        return storedPictureResult(input, {
          artifactId: appended.artifactId,
          representationRevisionId: appended.representationRevisionId,
          revision: appended.revision,
          mime,
        });
      }
      return {
        ok: true,
        artifactId: appended.artifactId,
        representationRevisionId: appended.representationRevisionId,
        revision: appended.revision,
        provider: provenance.provider,
        model: provenance.model,
        mime,
        deduped: appended.deduped,
      };
    }

    // ------------------------------------------------------------------
    // THE FIRST GENERATION: the same ledger claim the text road takes, over
    // bytes, with the picture's own data on the object.
    // ------------------------------------------------------------------
    const title = input.title.trim();
    if (title.length === 0) {
      return { ok: false, reason: "write_refused", error: "title must be a non-empty string" };
    }
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const claim = await claimMaterialization({
      orgId: input.orgId,
      runId: input.runId,
      outputId: input.nodeId,
      nodeId: input.nodeId,
      path: "materialize_tool",
      extension: input.extension,
      contentHash,
    });
    if (claim.path !== undefined && claim.path !== "materialize_tool") {
      return {
        ok: false,
        reason: "write_refused",
        error:
          `the materialization ledger identity collided with a different path ("${claim.path}") ` +
          `for run ${input.runId} node "${input.nodeId}" extension "${input.extension}" — ` +
          "refusing to alias",
      };
    }
    if (claim.kind === "finalized") {
      // A re-drive of this node with these bytes: the first write serves it,
      // with the facts stored with that write — never this attempt's.
      return storedPictureResult(input, {
        artifactId: claim.artifactId,
        representationRevisionId: claim.representationRevisionId,
        revision: 1,
        mime,
      });
    }

    const ownership = await deps.resolveOwnership({
      templateId: input.templateId,
      runId: input.runId,
      orgId: input.orgId,
    });

    let created: { artifactId: string; representationRevisionId: string };
    try {
      created = await createSemanticArtifact({
        orgId: input.orgId,
        objectType: resolvedTarget.target.objectTypeId,
        expectedAcceptMimes: resolvedTarget.target.acceptedFileMimeTypes,
        createdBy: input.createdBy,
        ownerLevel: ownership.ownerLevel,
        ownerId: ownership.ownerId,
        visibility: ownership.visibility,
        title,
        declaredMime: mime,
        originKind: "agent_generated",
        stream: asImageStream(bytes),
        createdByRunId: input.runId,
        producerAssertionExtension: input.extension,
        skipFallbackClassification: true,
        // The picture's own data, validated against the type's schema by the
        // write path itself (item 0.28).
        ...(input.data ? { typedData: input.data } : {}),
        additionalTx2Queries: (ids) => [
          buildFinalizeMaterializationQuery({
            ledgerId: claim.ledgerId,
            orgId: input.orgId,
            artifactId: ids.artifactId,
            representationRevisionId: ids.representationRevisionId,
          }),
          buildImageGenerationProvenanceQuery({
            schema: schemaId(),
            ledgerId: claim.ledgerId,
            orgId: input.orgId,
            provenance,
          }),
        ],
      });
    } catch (err) {
      // The concurrent-double-drive loser, exactly as the text road recovers it.
      if (isMaterializationFinalizeConflict(err)) {
        const winner = await readFinalizedMaterialization({
          orgId: input.orgId,
          ledgerId: claim.ledgerId,
        });
        if (winner) {
          // The winner's facts, as stored with its write.
          return storedPictureResult(input, {
            artifactId: winner.artifactId,
            representationRevisionId: winner.representationRevisionId,
            revision: 1,
            mime,
          });
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      logFilingFailure("artifact_image_generate", input, err);
      // A payload the type's schema rejects is a DIFFERENT answer from a write
      // that failed: the caller sent data the picture's type does not declare,
      // and restating it correctly is the fix. Both answers are fixed texts.
      return /does not satisfy the declared schema/.test(message)
        ? { ok: false, reason: "data_rejected", error: FILING_DATA_REJECTED_ERROR }
        : { ok: false, reason: "write_refused", error: FILING_WRITE_FAILED_ERROR };
    }

    // The meaning matcher, post-commit and best-effort — the same enqueue the
    // text road makes after an agent-emitted write.
    try {
      const { enqueueArtifactMatchRun } = await import("@/lib/artifacts/matcher-enqueue");
      await enqueueArtifactMatchRun({
        orgId: input.orgId,
        artifactId: created.artifactId,
        representationRevisionId: created.representationRevisionId,
        createdByRunId: input.runId,
      });
    } catch {
      /* best-effort — never fails a filed picture. */
    }

    return {
      ok: true,
      artifactId: created.artifactId,
      representationRevisionId: created.representationRevisionId,
      revision: 1,
      provider: provenance.provider,
      model: provenance.model,
      mime,
      deduped: false,
    };
  } catch (err) {
    logFilingFailure("artifact_image_generate", input, err);
    return { ok: false, reason: "write_refused", error: FILING_UNEXPECTED_ERROR };
  }
}

/** The fixed second half of a provider failure's sentence. */
export const PROVIDER_FAILED_DETAIL =
  "the detail is logged on the server, and no picture was made";

/**
 * THE FIXED REFUSAL TEXTS OF A FAILED FILING (cinatra#4223).
 *
 * THE WRITE FAILURE SAYS WHAT IS KEPT. The artifact write runs in two
 * transactions: the stored bytes and their content record commit first, and
 * the artifact itself, with its ledger finalize, second. When the second fails
 * no artifact exists, but the bytes, their record and this node's unfinalized
 * claim stay, by the writer's contract, so that a retry of the same node with
 * the same bytes re-uses them instead of storing them twice. The sentence says
 * so instead of claiming that nothing was kept.
 */
export const FILING_WRITE_FAILED_ERROR =
  "filing the picture failed: the write did not complete and no artifact was filed; " +
  "bytes it had already stored and this node's claim are kept, and a retry of this " +
  "node with the same picture re-uses them";

/** The fixed text of a tool that stopped on an error outside the write itself. */
export const FILING_UNEXPECTED_ERROR =
  "filing the picture failed on an unexpected error; the detail is logged on the server";

/** The fixed text of a filing whose typed data the target type's schema refused. */
export const FILING_DATA_REJECTED_ERROR =
  "filing the picture failed: the object payload does not satisfy the declared schema " +
  "of the target type, and no artifact was filed";

/** The fixed text of a re-drive whose first write's stored facts do not read. */
export const FILING_STORED_FACTS_UNREADABLE_ERROR =
  "this node already filed this picture, but the provider and model stored with that " +
  "revision could not be read; no second picture was filed";

/** Log a failure's own detail on the server, never in the refusal. */
export function logFilingFailure(
  tool: string,
  input: { orgId: string; runId: string; nodeId: string; extension: string },
  err: unknown,
): void {
  console.error(
    `[${tool}] failed`,
    { orgId: input.orgId, runId: input.runId, nodeId: input.nodeId, extension: input.extension },
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * THE ANSWER TO A RE-DRIVE (cinatra#4223). The ledger key is the run, the
 * node and the bytes, so a re-drive can reach the provider again, get the same
 * bytes from another provider or model, and be served by the revision the
 * first write filed. That revision's facts are the ones stored with it: the
 * answer reads them from its finalized ledger row and never reports this
 * attempt's provider and model against an older revision. A row that does not
 * read is a fixed refusal; the facts are never guessed.
 */
async function storedPictureResult(
  input: { orgId: string; runId: string; nodeId: string; extension: string },
  filed: { artifactId: string; representationRevisionId: string; revision: number; mime: string },
): Promise<ArtifactImageResult> {
  let stored: { provider: string; model: string | null } | null;
  try {
    stored = await readRevisionImageProvenance({
      orgId: input.orgId,
      artifactId: filed.artifactId,
      representationRevisionId: filed.representationRevisionId,
    });
  } catch (err) {
    logFilingFailure("artifact_image_generate", input, err);
    stored = null;
  }
  if (!stored) {
    return { ok: false, reason: "write_refused", error: FILING_STORED_FACTS_UNREADABLE_ERROR };
  }
  return {
    ok: true,
    artifactId: filed.artifactId,
    representationRevisionId: filed.representationRevisionId,
    revision: filed.revision,
    provider: stored.provider,
    model: stored.model,
    mime: filed.mime,
    deduped: true,
  };
}
