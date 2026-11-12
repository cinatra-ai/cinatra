import { createHash } from "node:crypto";
import { readAgentRunById } from "@cinatra-ai/agents/store";
import { producesObjectTypeIdForExtension } from "@cinatra-ai/agents/artifact-binding";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { createSemanticArtifact } from "@/lib/artifacts/artifact-creation";
import { isArtifactExtensionWriteAllowed } from "@/lib/artifacts/artifact-extension-access";
import { resolveBoundArtifactTarget } from "@/lib/artifacts/resolve-bound-artifact-type";
import { loadRunDerivationContext, resolveRunScopeOwnership } from "@/lib/artifacts/run-artifact-materializer";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { resolveProducerAssertionPlan } from "@/lib/artifacts/producer-assertions";
import {
  claimMaterialization, buildFinalizeMaterializationQuery,
  isMaterializationFinalizeConflict, readFinalizedMaterialization,
} from "@/lib/artifacts/materialization-ledger";
import { assertScreenshotFixtureRuntime, type CapturedScreenshot } from "./screenshot-capture";

const extension = "@cinatra-ai/screenshot-artifact";

/** Preflight before opening a browser. Uses the executed package, not main. */
export async function prepareScreenshotProducer(runId: string, orgId: string) {
  assertScreenshotFixtureRuntime();
  const run = await readAgentRunById(runId);
  if (!run || run.orgId !== orgId) throw new Error("No screenshot-producing run in the requested organization");
  if (run.status !== "completed") throw new Error("The development capture fixture requires a completed real run");
  const { producesRefs } = await loadRunDerivationContext(run);
  if (!producesRefs.some((ref) => ref.extension === extension)) {
    throw new Error(`The executed run package must declare ${extension} in cinatra.produces`);
  }
  const assertion = await resolveProducerAssertionPlan({ createdByRunId: runId, orgId });
  if (assertion.validatedRunId !== runId || !assertion.produces.includes(extension)) {
    throw new Error("The pinned producer manifest must be available to the canonical writer and declare screenshots");
  }
  registerAllObjectTypes();
  const resolved = await resolveBoundArtifactTarget({
    orgId, extension,
    producesObjectTypeId: producesObjectTypeIdForExtension(producesRefs, extension) ?? undefined,
  });
  if (!resolved.ok) throw new Error(resolved.error);
  if (!(await isArtifactExtensionWriteAllowed(extension, orgId))) {
    throw new Error("The screenshot extension is not writable in this organization");
  }
  if (!resolved.target.acceptedFileMimeTypes.includes("image/png")) throw new Error("The screenshot type must accept PNG");
  const ownership = await resolveRunScopeOwnership({ templateId: run.templateId, runId, orgId });

  return async (capture: CapturedScreenshot, outputId: string, title: string) => {
    assertScreenshotFixtureRuntime();
    if (!outputId.trim() || !title.trim()) throw new Error("Output identity and title must be nonempty");
    const contentHash = createHash("sha256").update(capture.bytes).digest("hex");
    const claim = await claimMaterialization({
      orgId, runId, outputId, nodeId: outputId, path: "materialize_tool", extension, contentHash,
    });
    if (claim.path !== undefined && claim.path !== "materialize_tool") throw new Error("Screenshot ledger identity belongs to a different materialization path");
    if (claim.kind === "finalized") return { ...claim, runId, contentHash, deduped: true };
    try {
      // Preserve project inheritance just as the run worker does. The canonical
      // writer validates the schema, writes real bytes and finalizes atomically.
      const result = await mcpRequestContextStorage.run({
        ...(run.projectId ? { projectContext: { projectId: run.projectId } } : {}),
      }, () => createSemanticArtifact({
        orgId, objectType: resolved.target.objectTypeId,
        expectedAcceptMimes: resolved.target.acceptedFileMimeTypes,
        createdBy: run.runBy, ...ownership, title: title.trim(),
        declaredMime: "image/png", originKind: "agent_generated",
        stream: (async function* () { yield capture.bytes; })(),
        createdByRunId: runId, producerAssertionExtension: extension,
        skipFallbackClassification: true, typedData: capture.facts,
        additionalTx2Queries: (ids) => [buildFinalizeMaterializationQuery({
          ledgerId: claim.ledgerId, orgId,
          artifactId: ids.artifactId, representationRevisionId: ids.representationRevisionId,
        })],
      }));
      return { artifactId: result.artifactId, representationRevisionId: result.representationRevisionId, runId, contentHash, deduped: false };
    } catch (error) {
      if (isMaterializationFinalizeConflict(error)) {
        const winner = await readFinalizedMaterialization({ orgId, ledgerId: claim.ledgerId });
        if (winner) return { ...winner, runId, contentHash, deduped: true };
      }
      throw error;
    }
  };
}
