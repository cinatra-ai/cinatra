import "server-only";
import type { Pool } from "pg";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { isPackageRequiredInProd } from "@cinatra-ai/extensions/required-in-prod";
import {
  producesObjectTypeIdForExtension,
  type SemanticArtifactProducesRef,
} from "@cinatra-ai/agents/artifact-binding";
import { withActorContext } from "@cinatra-ai/llm/actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";
import { getPooledDb } from "@/lib/db/pooled";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { resolveBoundArtifactTarget } from "./resolve-bound-artifact-type";
import { writeClaimedArtifact, resolveRunScopeOwnership } from "./run-artifact-materializer";
import type { ScopeDerivedOwnership } from "@cinatra-ai/mcp-server/obo-ceiling";
import {
  claimMaterialization,
  finalizeMaterializationAgainstExistingArtifact,
} from "./materialization-ledger";
import {
  detectOutputForm,
  type DetectionVerdict,
  type ModelRungAsk,
} from "./output-detection-ladder";
import {
  resolveDefaultRoadTarget,
  type DefaultRoadTargetCandidate,
  type DefaultRoadTargetRung,
} from "./default-road-target";

// ---------------------------------------------------------------------------
// The default road's pickup (Agents Lifecycle (C) item 0.17).
//
//   "The default road: the post-terminal pickup stops dropping undeclared work.
//    Today an output with no declared target is advised and dropped, the job
//    reads only the final response text, and one bound output switches
//    derivation off for the whole agent. After: the pickup runs once per emitted
//    file and once per end-node output at or above the document floor, applies
//    the per-output ladder of section 3 — binding, then the agent's declared
//    kind, then the form's base, then the binary base — writes through the one
//    path with one ledger row per item under a reserved id that cannot collide
//    with a node id, dedupes identical bytes within the run, emits the produced
//    event and enqueues the meaning match; the response-text derivation and the
//    'not captured' advisory retire."
//
// SCOPE. This slice takes the END-NODE OUTPUT half only. "once per emitted file"
// is #3030's (W6): the item shape already carries the `source` discriminator, so
// W6 extends this drive rather than replacing it.
//
// The write goes through the ONE path (`writeClaimedArtifact` →
// `createSemanticArtifact`): bytes streamed, resource + blob, then the object,
// the revision, the audit witness, the producer assertion, the ledger finalize
// and the produced event, all in the write's own Tx2 (plan §8.3). Nothing here
// re-implements any of it.
// ---------------------------------------------------------------------------

function pool(): Pool {
  return getPooledDb({
    name: "default-road-pickup",
    connectionString: () => getPostgresConnectionString(),
  });
}

function schema(): string {
  return postgresSchema.replaceAll('"', '""');
}

/** One item the pickup drains — structurally `EndNodeOutputPickupItem` from
 *  `@cinatra-ai/agents/end-node-output-pickup`, restated here so the host module
 *  does not depend on the agents package's shape at the type level. */
export type DefaultRoadItem = {
  outputId: string;
  outputName: string;
  source: "end_node_output" | "file";
  content: string;
  contentIsJson: boolean;
  contentHash: string;
  byteLength: number;
};

/** What the pickup did with ONE item. Every outcome carries the ladder's
 *  verdict, so "took no road" is as readable as "became this artifact". */
export type DefaultRoadItemOutcome = {
  outputId: string;
  outputName: string;
  status: "written" | "deduped" | "no_target";
  verdict: DetectionVerdict;
  targetRung: DefaultRoadTargetRung | null;
  extension?: string;
  objectTypeId?: string;
  artifactId?: string;
  representationRevisionId?: string;
  /** Present on `no_target`: why no rung could claim the item. */
  refusal?: { reason: string; detail: string };
};

export type DefaultRoadPickupDeps = {
  /** The model rung. Injected by the suite; production resolves the
   *  organisation's configured runtime. */
  ask?: ModelRungAsk;
  /** Override the per-organisation switch (the suite; production reads it). */
  modelRungEnabled?: boolean;
};

// ---------------------------------------------------------------------------
// The per-organisation switch for the model rung (item 0.18).
// ---------------------------------------------------------------------------

/**
 * Whether the detection ladder's model rung is on for an organisation. ABSENT
 * ROW ⇒ ON: a deployment that has never touched the setting behaves as the plan
 * describes, and a row with `model_rung_enabled = false` turns the rung off and
 * yields plain text. A read failure is treated as OFF — a form decision must
 * never depend on a settings table being reachable, and plain text is the
 * documented degraded answer.
 */
export async function readModelRungEnabled(orgId: string): Promise<boolean> {
  try {
    ensurePostgresSchema();
    const res = await pool().query(
      `SELECT model_rung_enabled FROM "${schema()}"."artifact_detection_settings" WHERE org_id = $1 LIMIT 1`,
      [orgId],
    );
    const row = res.rows[0] as { model_rung_enabled?: boolean } | undefined;
    if (!row) return true;
    return row.model_rung_enabled !== false;
  } catch {
    return false;
  }
}

/**
 * The pickup's actor frame. The pickup runs on a background job with
 * `inheritActorContext: false` (it must not inherit the run principal), so the
 * model rung has to anchor its OWN org-scoped System frame or the runtime
 * resolution throws `ACTOR_CONTEXT_MISSING`. Mirrors the artifact matcher's
 * `buildArtifactMatcherActorContext` — the hardening item 0.18 points at.
 */
export function buildDefaultRoadActorContext(orgId: string): ActorContext {
  return {
    principalType: "System",
    principalId: "default-road-pickup",
    organizationId: orgId,
    teamIds: [],
    projectIds: [],
    authSource: "worker",
    policyVersion: "v2",
  };
}

/** The model rung's production implementation: the organisation's CONFIGURED
 *  runtime — the same one the meaning matcher and the pickup's own type
 *  classifier already send content to, so no new class of data leaves the
 *  deployment (plan §8.7) — asked the fixed question at zero temperature. */
export const defaultModelRungAsk: ModelRungAsk = async ({ text, question, answers }) => {
  const { resolveConfiguredLlmRuntime, runResolvedDeterministicLlmTask, parseStructuredJson } =
    await import("@cinatra-ai/llm");
  const runtime = await resolveConfiguredLlmRuntime();
  if (!runtime) return null;
  const response = await runResolvedDeterministicLlmTask({
    runtime,
    system:
      "You name the form of a text. Answer with JSON only. " +
      `The only legal values for "form" are: ${answers.join(", ")}.`,
    user: `${question}\n\n---\n${text}`,
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["form", "confidence"],
      properties: {
        form: { type: "string", enum: [...answers] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    maxSteps: 1,
    maxOutputTokens: 128,
    // ZERO TEMPERATURE is what `runResolvedDeterministicLlmTask` IS — the
    // deterministic task API carries no temperature knob precisely because it
    // pins one. Item 0.18's "at zero temperature" is satisfied by taking this
    // entry point rather than the general generate path, not by a field here.
    logLabel: "default-road-detect-form",
  });
  const parsed = parseStructuredJson<{ form?: unknown; confidence?: unknown }>(
    typeof response?.text === "string" ? response.text : "",
  );
  if (!parsed || typeof parsed.form !== "string") return null;
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  return { answer: parsed.form, confidence };
};

// ---------------------------------------------------------------------------
// The candidates the per-output ladder chooses between.
// ---------------------------------------------------------------------------

/**
 * The installed REQUIRED-base artifact types, each with the extension that
 * DEFINES it. The same domain the upload road resolves against
 * (`selectRequiredArtifactUploadCandidates`) — core never names a pack; the
 * required set is manifest data.
 */
export function readDefaultRoadBaseCandidates(): DefaultRoadTargetCandidate[] {
  const out: DefaultRoadTargetCandidate[] = [];
  for (const def of objectTypeRegistry.listArtifacts()) {
    const definer = objectTypeRegistry.getRegisteringPackage(def.type);
    if (definer == null || !isPackageRequiredInProd(definer)) continue;
    const accepts = def.isArtifact?.accepts?.file?.mimeTypes;
    if (!Array.isArray(accepts) || accepts.length === 0) continue;
    // The retired generic floor is never a home (the upload map's own rule).
    if (accepts.some((a) => {
      const t = String(a).trim().toLowerCase();
      return t === "*" || t === "*/*";
    })) continue;
    out.push({ objectTypeId: def.type, extension: definer, acceptMimes: accepts });
  }
  return out;
}

/** The agent's declared `produces`, resolved to artifact-safe targets. */
async function readDeclaredKindCandidates(
  orgId: string,
  producesRefs: readonly SemanticArtifactProducesRef[],
): Promise<DefaultRoadTargetCandidate[]> {
  const out: DefaultRoadTargetCandidate[] = [];
  for (const ref of producesRefs) {
    const producesObjectTypeId =
      ref.objectTypeId ??
      producesObjectTypeIdForExtension(producesRefs, ref.extension) ??
      undefined;
    const resolved = await resolveBoundArtifactTarget({
      orgId,
      extension: ref.extension,
      bindingObjectTypeId: undefined,
      producesObjectTypeId,
    });
    if (!resolved.ok) continue;
    out.push({
      objectTypeId: resolved.target.objectTypeId,
      extension: ref.extension,
      acceptMimes: resolved.target.acceptedFileMimeTypes,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The drive.
// ---------------------------------------------------------------------------

/**
 * Run the default road over one run's item family.
 *
 * NEVER throws for a per-item refusal — a run that produced an output nothing
 * can type is not a failed run, it is a run with a recorded verdict. An
 * infrastructure failure DOES throw, so the caller's lease machinery re-drives.
 */
export async function pickUpDefaultRoadItems(
  input: {
    runId: string;
    orgId: string;
    templateId: string;
    packageVersion: string | null;
    createdBy: string | null;
    templateName: string | null;
    items: readonly DefaultRoadItem[];
    producesRefs: readonly SemanticArtifactProducesRef[];
  },
  deps?: DefaultRoadPickupDeps,
): Promise<DefaultRoadItemOutcome[]> {
  if (input.items.length === 0) return [];

  registerAllObjectTypes();
  const bases = readDefaultRoadBaseCandidates();
  const declaredKinds = await readDeclaredKindCandidates(input.orgId, input.producesRefs);
  const ownership: ScopeDerivedOwnership = await resolveRunScopeOwnership({
    templateId: input.templateId,
    runId: input.runId,
    orgId: input.orgId,
  });

  // The model rung's switch and its actor frame are resolved ONCE per run, and
  // its answers are cached by content hash for the run (item 0.18).
  const modelRungEnabled =
    deps?.modelRungEnabled ?? (await readModelRungEnabled(input.orgId));
  const ask = deps?.ask ?? defaultModelRungAsk;
  const cache = new Map<string, DetectionVerdict>();

  // "Two outputs with the same bytes in one run are one artifact with two
  // ledger rows" (§3): the first item's refs, by content hash.
  const writtenByHash = new Map<
    string,
    { artifactId: string; representationRevisionId: string; extension: string; objectTypeId: string }
  >();

  const outcomes: DefaultRoadItemOutcome[] = [];
  for (const item of input.items) {
    const bytes = new TextEncoder().encode(item.content);
    const verdict = await withActorContext(
      buildDefaultRoadActorContext(input.orgId),
      () =>
        detectOutputForm(
          { bytes, contentHash: item.contentHash, name: item.outputName },
          { ask, modelRungEnabled, cache },
        ),
    );

    const target = resolveDefaultRoadTarget({
      form: verdict.form,
      declaredKinds,
      bases,
    });
    if (!target.ok) {
      outcomes.push({
        outputId: item.outputId,
        outputName: item.outputName,
        status: "no_target",
        verdict,
        targetRung: target.rung,
        refusal: { reason: target.reason, detail: target.detail },
      });
      continue;
    }

    // ---- the same-bytes case: one artifact, a ledger row per item ---------
    const already = writtenByHash.get(item.contentHash);
    if (already && already.extension === target.extension) {
      const claim = await claimMaterialization({
        orgId: input.orgId,
        runId: input.runId,
        outputId: item.outputId,
        nodeId: null,
        path: "default_road",
        extension: target.extension,
        contentHash: item.contentHash,
        decidedRung: verdict.rung,
        decidedVerdict: verdict,
      });
      if (claim.kind === "claimed") {
        await finalizeMaterializationAgainstExistingArtifact({
          orgId: input.orgId,
          ledgerId: claim.ledgerId,
          artifactId: already.artifactId,
          representationRevisionId: already.representationRevisionId,
        });
      }
      outcomes.push({
        outputId: item.outputId,
        outputName: item.outputName,
        status: "deduped",
        verdict,
        targetRung: target.rung,
        extension: target.extension,
        objectTypeId: target.objectTypeId,
        artifactId: claim.kind === "finalized" ? claim.artifactId : already.artifactId,
        representationRevisionId:
          claim.kind === "finalized"
            ? claim.representationRevisionId
            : already.representationRevisionId,
      });
      continue;
    }

    const write = await writeClaimedArtifact({
      runId: input.runId,
      orgId: input.orgId,
      createdBy: input.createdBy,
      outputId: item.outputId,
      nodeId: null,
      path: "default_road",
      extension: target.extension,
      extensionVersion: input.packageVersion,
      title: `${input.templateName ?? "Agent"} — ${item.outputName}`,
      mime: verdict.form,
      content: item.content,
      ownership,
      resolvedTarget: {
        objectTypeId: target.objectTypeId,
        acceptedFileMimeTypes: target.acceptedFileMimeTypes,
      },
      mimeDescription: "the detected output form",
      decidedRung: verdict.rung,
      decidedVerdict: verdict,
    });
    if (!write.ok) {
      outcomes.push({
        outputId: item.outputId,
        outputName: item.outputName,
        status: "no_target",
        verdict,
        targetRung: target.rung,
        extension: target.extension,
        objectTypeId: target.objectTypeId,
        refusal: { reason: "write_refused", detail: write.error },
      });
      continue;
    }
    writtenByHash.set(item.contentHash, {
      artifactId: write.artifactId,
      representationRevisionId: write.representationRevisionId,
      extension: target.extension,
      objectTypeId: target.objectTypeId,
    });
    outcomes.push({
      outputId: item.outputId,
      outputName: item.outputName,
      status: write.deduped ? "deduped" : "written",
      verdict,
      targetRung: target.rung,
      extension: target.extension,
      objectTypeId: target.objectTypeId,
      artifactId: write.artifactId,
      representationRevisionId: write.representationRevisionId,
    });
  }
  return outcomes;
}
