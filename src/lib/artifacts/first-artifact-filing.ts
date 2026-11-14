import "server-only";
import { createHash } from "node:crypto";

import { logFailure } from "@/lib/failure-log";
import { createSemanticArtifact } from "@/lib/artifacts/artifact-creation";
import {
  buildFinalizeMaterializationQuery,
  claimMaterialization,
  isMaterializationFinalizeConflict,
  readFinalizedMaterialization,
} from "@/lib/artifacts/materialization-ledger";
import type { ResolvedArtifactTarget } from "@/lib/artifacts/resolve-bound-artifact-type";
import type { ScopeDerivedOwnership } from "@/lib/artifacts/run-artifact-materializer";

// ---------------------------------------------------------------------------
// THE FIRST WRITE OF A TOOL-FILED ARTIFACT (cinatra#4223), shared by the image
// tool and the page capture tool.
//
// The caller asks the write-authorization questions first and hands this road
// the bytes. It claims the materialization ledger by the run's own identity
// (run, node, extension and the bytes' hash), reads the owner, files the bytes
// through the one writer `createSemanticArtifact` with the ledger finalize and
// the caller's own ops in the writer's second transaction, and queues the
// matcher. A re-drive of the same node with the same bytes, and the loser of a
// concurrent double drive, are served by the revision the first write filed:
// the caller's `readStored` reads the facts stored with it.
//
// A failed write answers the caller's fixed texts; the log line carries the
// tool, the caller's own log fields and the error's class word, never text
// taken from the error. A throw of the claim, the owner read or the winner read
// reaches the caller's own catch.
//
// The road reads the caller's fields where the tools read them before it was
// shared: the run's identity from the caller's own input at each use, and the
// writer's fields (the creator, the title, the object data) only on the writer
// road, after the claim and the owner read. A re-drive or a claim another path
// owns therefore never reads them.
// ---------------------------------------------------------------------------

/** The run's identity, read from the caller's own input at each use. nodeId is the ledger's node and output identity. */
export type FirstArtifactFilingRun = {
  readonly orgId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly extension: string;
  /** cinatra#4264: the runtime's signed step of the call, when it verified; the
   *  ledger records it as the filing step only when it equals nodeId. */
  readonly verifiedStepId?: string;
};

export type FirstArtifactFilingInput<S> = {
  /** The tool's name, the tag of its log lines. */
  tool: string;
  run: FirstArtifactFilingRun;
  bytes: Uint8Array;
  mime: string;
  target: ResolvedArtifactTarget;
  /**
   * The writer's own fields, read only on the writer road: the run's runBy principal (persisted as the
   * artifact's createdBy), the title and, optionally, the origin (default agent_generated; cinatra#3035:
   * a reviewed mid-run write takes live_generator). A throw here is a failed write.
   */
  writerFields: () => {
    createdBy: string | null;
    title: string;
    originKind?: "agent_generated" | "live_generator";
  };
  /** The object's own fields, validated against the type's schema by the writer; read after writerFields. */
  typedData?: () => Record<string, unknown> | undefined;
  /** The caller's ops for the writer's second transaction, after the finalize. */
  additionalTx2Ops: (ids: {
    ledgerId: string;
    artifactId: string;
    representationRevisionId: string;
  }) => Array<{ text: string; values: unknown[] }>;
  resolveOwnership: () => Promise<ScopeDerivedOwnership>;
  /** The answer of a revision another write filed: a re-drive, or the winner of a double drive. */
  readStored: (filed: { artifactId: string; representationRevisionId: string }) => Promise<S> | S;
  texts: { pathCollision: (path: string) => string; dataRejected: string; writeFailed: string };
  /** The caller's identifiers for a failure's log line, through the caller's own sanitizer. Never a throw. */
  logFields: () => Record<string, string>;
};

export type FirstArtifactFiling<S> =
  | { kind: "filed"; artifactId: string; representationRevisionId: string }
  | { kind: "served"; answer: S }
  | { kind: "refused"; reason: "write_refused" | "data_rejected"; error: string };

export async function fileFirstArtifactWrite<S>(input: FirstArtifactFilingInput<S>): Promise<FirstArtifactFiling<S>> {
  const run = input.run;
  const claim = await claimMaterialization({
    orgId: run.orgId,
    runId: run.runId,
    outputId: run.nodeId,
    nodeId: run.nodeId,
    path: "materialize_tool",
    extension: run.extension,
    contentHash: createHash("sha256").update(input.bytes).digest("hex"),
    ...(run.verifiedStepId !== undefined ? { verifiedStepId: run.verifiedStepId } : {}),
  });
  if (claim.path !== undefined && claim.path !== "materialize_tool") {
    return { kind: "refused", reason: "write_refused", error: input.texts.pathCollision(claim.path) };
  }
  if (claim.kind === "finalized") return { kind: "served", answer: await input.readStored(refsOf(claim)) };

  const ownership = await input.resolveOwnership();
  let created: { artifactId: string; representationRevisionId: string };
  try {
    const orgId = run.orgId;
    const writer = input.writerFields();
    const createdByRunId = run.runId;
    const producerAssertionExtension = run.extension;
    const typedData = input.typedData?.();
    created = refsOf(
      await createSemanticArtifact({
        orgId,
        objectType: input.target.objectTypeId,
        expectedAcceptMimes: input.target.acceptedFileMimeTypes,
        createdBy: writer.createdBy,
        ownerLevel: ownership.ownerLevel,
        ownerId: ownership.ownerId,
        visibility: ownership.visibility,
        title: writer.title,
        declaredMime: input.mime,
        originKind: writer.originKind ?? "agent_generated",
        stream: (async function* () {
          yield input.bytes;
        })(),
        createdByRunId,
        producerAssertionExtension,
        skipFallbackClassification: true,
        ...(typedData ? { typedData } : {}),
        additionalTx2Queries: (ids) => [
          buildFinalizeMaterializationQuery({ ledgerId: claim.ledgerId, orgId: run.orgId, ...ids }),
          ...input.additionalTx2Ops({ ledgerId: claim.ledgerId, ...ids }),
        ],
      }),
    );
  } catch (err) {
    // The concurrent double-drive loser, exactly as the text road recovers it.
    if (isMaterializationFinalizeConflict(err)) {
      const winner = await readFinalizedMaterialization({ orgId: run.orgId, ledgerId: claim.ledgerId });
      if (winner) return { kind: "served", answer: await input.readStored(refsOf(winner)) };
    }
    // A payload the type's schema rejects is a different answer from a write that failed: restating
    // the data is the fix. Both answers are the caller's fixed texts.
    const schemaRefusal = isSchemaRefusal(err);
    logFailure(`[${input.tool}] failed; the error's own text is not logged`, input.logFields(), err);
    return schemaRefusal
      ? { kind: "refused", reason: "data_rejected", error: input.texts.dataRejected }
      : { kind: "refused", reason: "write_refused", error: input.texts.writeFailed };
  }

  // The meaning matcher, post-commit and best-effort: the same enqueue the text road makes.
  try {
    const { enqueueArtifactMatchRun } = await import("@/lib/artifacts/matcher-enqueue");
    await enqueueArtifactMatchRun({ orgId: run.orgId, ...created, createdByRunId: run.runId });
  } catch {
    /* best-effort: never fails a filed artifact. */
  }
  return { kind: "filed", ...created };
}

function refsOf(filed: { artifactId: string; representationRevisionId: string }) {
  return { artifactId: filed.artifactId, representationRevisionId: filed.representationRevisionId };
}

/** The caller's own identifiers a failure's log line carries. Never a throw. */
export function filingLogFields(input: {
  orgId: string;
  runId: string;
  nodeId: string;
  extension: string;
}): Record<string, string> {
  try {
    return { orgId: input.orgId, runId: input.runId, nodeId: input.nodeId, extension: input.extension };
  } catch {
    return {};
  }
}

/**
 * Log a failure on the server: the tool, the run, the node and the error's
 * class word, never text taken from the error. Never a throw (src/lib/failure-log.ts).
 */
export function logFilingFailure(
  tool: string,
  input: { orgId: string; runId: string; nodeId: string; extension: string },
  err: unknown,
): void {
  logFailure(`[${tool}] failed; the error's own text is not logged`, filingLogFields(input), err);
}

/** A writer's schema refusal, read from a plain message only. Never a throw. */
function isSchemaRefusal(err: unknown): boolean {
  try {
    const message: unknown = typeof err === "string" ? err : err instanceof Error ? err.message : undefined;
    return typeof message === "string" && /does not satisfy the declared schema/.test(message);
  } catch {
    return false;
  }
}
