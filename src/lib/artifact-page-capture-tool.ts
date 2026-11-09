import "server-only";
import { createHash } from "node:crypto";

import {
  producesObjectTypeIdForExtension,
  type SemanticArtifactProducesRef,
} from "@cinatra-ai/agents/artifact-binding";

import { postgresSchema } from "@/lib/database";
import { logFailure, logFixedLine } from "@/lib/failure-log";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { createSemanticArtifact } from "@/lib/artifacts/artifact-creation";
import { isArtifactExtensionWriteAllowed } from "@/lib/artifacts/artifact-extension-access";
import { captureDegradeCopy, type CaptureDegradeReason } from "@/lib/artifacts/cms-preview-capture";
import {
  buildFinalizeMaterializationQuery,
  claimMaterialization,
  isMaterializationFinalizeConflict,
  readFinalizedMaterialization,
} from "@/lib/artifacts/materialization-ledger";
import {
  acquirePageCaptureLease,
  MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN,
  MAX_PAGE_CAPTURES_PER_RUN,
  type PageCaptureBudgetAnswer,
  type PageCaptureBudgetRefusal,
  type PageCaptureLease,
} from "@/lib/artifacts/page-capture-budget";
import {
  buildPageCaptureFactsRecordOp,
  parsePageCaptureFacts,
  readPageCaptureFactsForRevision,
  type RecordedPageCaptureFacts,
} from "@/lib/artifacts/page-capture-facts-record";
import {
  captureRegisteredPage,
  type CaptureRegisteredPageOutcome,
} from "@/lib/artifacts/registered-page-capture";
import { resolveBoundArtifactTarget } from "@/lib/artifacts/resolve-bound-artifact-type";
import { mimeAcceptedByAccepts } from "@/lib/artifacts/upload-artifact-type-map";
import {
  loadRunDerivationContext,
  resolveRunScopeOwnership,
  type ScopeDerivedOwnership,
} from "@/lib/artifacts/run-artifact-materializer";

// ---------------------------------------------------------------------------
// THE PAGE CAPTURE TOOL (cinatra#4223): a page url in, a PNG of that page filed.
//
// The page must be on one of the organisation's active connect-registered sites
// (`captureRegisteredPage`). The PNG is filed as the one object type the named
// extension resolves to (the tool names no type), with the three facts as its
// object data: `capturedUrl`, `viewport` (the renderer's report) and `capturedAt`
// (when the renderer returned). The write authorization and the ledger road are
// the image tool's, with no image provenance on the ledger row.
//
// The shared Postgres budget (page-capture-budget.ts) leases one capture of the
// organisation and run the caller passes. The lease's release is called on every
// exit after the lease is taken. The budget's release never throws: when its
// update fails, the lease stays in flight until its TTL ends. A capture is always
// image/png, so the type's accepts are read before the lease, with the other write
// questions. The facts record (page-capture-facts-record.ts) commits with the
// revision; a re-drive answers the facts recorded with the revision that serves
// it. NEVER THROWS, and no refusal or log line of this module carries text of an
// exception. A capture refusal keeps its own reason name and its existing sentence.
// ---------------------------------------------------------------------------

const CAPTURE_MIME = "image/png";
const TOOL = "artifact_page_capture";

/** At most this many bytes per captured PNG (10 MB). */
export const MAX_PAGE_CAPTURE_PNG_BYTES = 10 * 1024 * 1024;

/** The image tool's refusal names, the size cap, the budget's refusals and the capture's own. */
export type ArtifactPageCaptureRefusal =
  | "not_produced"
  | "type_unresolved"
  | "write_refused"
  | "data_rejected"
  | "capture_too_large"
  | PageCaptureBudgetRefusal
  | CaptureDegradeReason;

type CapturedFacts = { capturedUrl: string; viewport: { width: number; height: number }; capturedAt: string };

export type ArtifactPageCaptureResult =
  | ({ ok: true; artifactId: string; representationRevisionId: string; deduped: boolean } & CapturedFacts)
  | { ok: false; reason: ArtifactPageCaptureRefusal; error: string };

/** The seams a caller may replace; `artifactPageCaptureToolDeps()` is the production set. */
export type ArtifactPageCaptureToolDeps = {
  loadProducesRefs: (input: {
    templateId: string;
    packageVersion: string | null;
  }) => Promise<readonly SemanticArtifactProducesRef[]>;
  resolveOwnership: (input: { templateId: string; runId: string; orgId: string }) => Promise<ScopeDerivedOwnership>;
  capturePage: (input: { orgId: string; url: string }) => Promise<CaptureRegisteredPageOutcome>;
  acquireLease: (input: { orgId: string; runId: string }) => Promise<PageCaptureBudgetAnswer>;
  readRecordedFacts: (input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    objectType: string;
  }) => RecordedPageCaptureFacts;
};

export function artifactPageCaptureToolDeps(): ArtifactPageCaptureToolDeps {
  return {
    loadProducesRefs: async (i) => (await loadRunDerivationContext(i)).producesRefs,
    resolveOwnership: (i) => resolveRunScopeOwnership(i),
    capturePage: (i) => captureRegisteredPage(i),
    acquireLease: (i) => acquirePageCaptureLease(i),
    readRecordedFacts: (i) => readPageCaptureFactsForRevision(i),
  };
}

export type CaptureArtifactPageInput = {
  runId: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  /** The run's runBy principal, persisted as the artifact's createdBy. */
  createdBy: string | null;
  /** The calling node's id: the ledger's node and output identity. */
  nodeId: string;
  extension: string;
  title: string;
  /** The absolute http(s) url of the page to capture. */
  url: string;
};

export const BUDGET_REFUSAL_ERRORS: Record<PageCaptureBudgetRefusal, string> = {
  run_cap_exceeded: `this run already took ${MAX_PAGE_CAPTURES_PER_RUN} page captures, the most one run may take; the page was not captured`,
  concurrency_exceeded:
    `this run already has ${MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN} page captures in flight, the most one run may ` +
    "have at once; the page was not captured",
  budget_unavailable: "the page capture budget could not be read, and the page was not captured",
};

export const PAGE_CAPTURE_URL_UNRECORDABLE_ERROR =
  "the url cannot be recorded as a capture fact: it carries user information or a control character, or it is " +
  "longer than 2048 characters; the page was not captured";
export const PAGE_CAPTURE_WRITE_FAILED_ERROR =
  "filing the page capture failed: the write did not complete and no artifact was filed; bytes it had already " +
  "stored and this node's claim are kept, and a retry of this node with the same capture re-uses them";
export const PAGE_CAPTURE_DATA_REJECTED_ERROR =
  "filing the page capture failed: the object payload does not satisfy the declared schema of the target type, " +
  "and no artifact was filed";
export const PAGE_CAPTURE_UNEXPECTED_ERROR = "filing the page capture failed on an unexpected error";
export const PAGE_CAPTURE_STORED_FACTS_UNREADABLE_ERROR =
  "this node already filed this capture, but the facts recorded with that revision could not be read; no " +
  "second capture was filed";

export function pageCaptureInstallStateError(extension: string): string {
  return (
    `no artifact-safe claim resolved for extension "${extension}" in this organisation: its install state is ` +
    "incomplete or could not be read, and the page was not captured"
  );
}

export async function captureArtifactPage(
  input: CaptureArtifactPageInput,
  deps: ArtifactPageCaptureToolDeps = artifactPageCaptureToolDeps(),
): Promise<ArtifactPageCaptureResult> {
  try {
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
          `extension "${input.extension}" is not declared in this run package's cinatra.produces ` +
          `([${declared.join(", ")}]); declared production and page-capture filing must agree`,
      };
    }
    registerAllObjectTypes();
    const resolved = await resolveBoundArtifactTarget({
      orgId: input.orgId,
      extension: input.extension,
      producesObjectTypeId: producesObjectTypeIdForExtension(producesRefs, input.extension) ?? undefined,
      // The install-state explanation quotes the store's read errors; this road answers a fixed sentence.
      deps: { explainAbsentClaims: () => explainAbsentClaimsFixed(input) },
    });
    if (!resolved.ok) return { ok: false, reason: "type_unresolved", error: resolved.error };
    if (!(await isArtifactExtensionWriteAllowed(input.extension, input.orgId))) {
      return {
        ok: false,
        reason: "write_refused",
        error:
          `artifact extension "${input.extension}" is not write-allowed for this org ` +
          "(archived/ungoverned-denied install state)",
      };
    }
    if (!mimeAcceptedByAccepts(resolved.target.acceptedFileMimeTypes, CAPTURE_MIME)) {
      return {
        ok: false,
        reason: "write_refused",
        error:
          `object type "${resolved.target.objectTypeId}" (extension "${input.extension}") accepts ` +
          `[${resolved.target.acceptedFileMimeTypes.join(", ")}]; a page capture is "${CAPTURE_MIME}", and the page was not captured`,
      };
    }
    // The facts record takes only some http(s) urls (page-capture-facts-record.ts); a url it cannot record is
    // refused here, before a lease is taken or a byte is sent. The viewport and time are fixed valid values.
    if (parsePageCaptureFacts({ capturedUrl: input.url, viewport: { width: 1, height: 1 }, capturedAt: "2000-01-01T00:00:00Z" }) === null) {
      return { ok: false, reason: "write_refused", error: PAGE_CAPTURE_URL_UNRECORDABLE_ERROR };
    }
    const lease = await deps.acquireLease({ orgId: input.orgId, runId: input.runId });
    if (!lease.ok) return { ok: false, reason: lease.reason, error: BUDGET_REFUSAL_ERRORS[lease.reason] };
    try {
      return await captureAndFile(input, deps, resolved.target);
    } finally {
      await releaseLease(input, lease.lease);
    }
  } catch (err) {
    logToolFailure(input, err);
    return { ok: false, reason: "write_refused", error: PAGE_CAPTURE_UNEXPECTED_ERROR };
  }
}

async function captureAndFile(
  input: CaptureArtifactPageInput,
  deps: ArtifactPageCaptureToolDeps,
  target: { objectTypeId: string; acceptedFileMimeTypes: string[] },
): Promise<ArtifactPageCaptureResult> {
  const captured = await deps.capturePage({ orgId: input.orgId, url: input.url });
  if (!captured.ok) return { ok: false, reason: captured.reason, error: captureDegradeCopy(captured.reason) };
  if (captured.png.byteLength > MAX_PAGE_CAPTURE_PNG_BYTES) {
    return {
      ok: false,
      reason: "capture_too_large",
      error: `the captured page is ${captured.png.byteLength} bytes; a page capture may be at most ${MAX_PAGE_CAPTURE_PNG_BYTES} bytes`,
    };
  }
  const facts: CapturedFacts = { capturedUrl: input.url, viewport: captured.viewport, capturedAt: captured.capturedAt };
  const claim = await claimMaterialization({
    orgId: input.orgId,
    runId: input.runId,
    outputId: input.nodeId,
    nodeId: input.nodeId,
    path: "materialize_tool",
    extension: input.extension,
    contentHash: createHash("sha256").update(captured.png).digest("hex"),
  });
  if (claim.path !== undefined && claim.path !== "materialize_tool") {
    return {
      ok: false,
      reason: "write_refused",
      error:
        `the materialization ledger identity collided with a different path ("${claim.path}") for run ` +
        `${input.runId} node "${input.nodeId}" extension "${input.extension}"; refusing to alias`,
    };
  }
  // A re-drive of this node with these bytes: the first write serves it, with the facts recorded with it.
  if (claim.kind === "finalized") return storedCaptureResult(input, deps, target.objectTypeId, claim);
  const ownership = await deps.resolveOwnership({ templateId: input.templateId, runId: input.runId, orgId: input.orgId });
  let created: { artifactId: string; representationRevisionId: string };
  try {
    const written = await createSemanticArtifact({
      orgId: input.orgId,
      objectType: target.objectTypeId,
      expectedAcceptMimes: target.acceptedFileMimeTypes,
      createdBy: input.createdBy,
      ownerLevel: ownership.ownerLevel,
      ownerId: ownership.ownerId,
      visibility: ownership.visibility,
      title: input.title,
      declaredMime: CAPTURE_MIME,
      originKind: "agent_generated",
      stream: (async function* () {
        yield captured.png;
      })(),
      createdByRunId: input.runId,
      producerAssertionExtension: input.extension,
      skipFallbackClassification: true,
      typedData: { ...facts },
      additionalTx2Queries: (ids) => [
        buildFinalizeMaterializationQuery({ ledgerId: claim.ledgerId, orgId: input.orgId, ...ids }),
        buildPageCaptureFactsRecordOp({ schema: postgresSchema, orgId: input.orgId, objectType: target.objectTypeId, facts, ...ids }),
      ],
    });
    created = { artifactId: written.artifactId, representationRevisionId: written.representationRevisionId };
  } catch (err) {
    // The concurrent double-drive loser, recovered as the image tool recovers it.
    if (isMaterializationFinalizeConflict(err)) {
      const winner = await readFinalizedMaterialization({ orgId: input.orgId, ledgerId: claim.ledgerId });
      if (winner) return storedCaptureResult(input, deps, target.objectTypeId, winner);
    }
    const schemaRefusal = isSchemaRefusal(err);
    logToolFailure(input, err);
    return schemaRefusal
      ? { ok: false, reason: "data_rejected", error: PAGE_CAPTURE_DATA_REJECTED_ERROR }
      : { ok: false, reason: "write_refused", error: PAGE_CAPTURE_WRITE_FAILED_ERROR };
  }
  try {
    const { enqueueArtifactMatchRun } = await import("@/lib/artifacts/matcher-enqueue");
    await enqueueArtifactMatchRun({
      orgId: input.orgId,
      artifactId: created.artifactId,
      representationRevisionId: created.representationRevisionId,
      createdByRunId: input.runId,
    });
  } catch {
    /* best-effort: never fails a filed capture. */
  }
  return { ok: true, ...created, ...facts, deduped: false };
}

/** The answer to a re-drive: the facts recorded with the revision that serves it, or a fixed refusal. */
function storedCaptureResult(
  input: CaptureArtifactPageInput,
  deps: ArtifactPageCaptureToolDeps,
  objectType: string,
  filed: { artifactId: string; representationRevisionId: string },
): ArtifactPageCaptureResult {
  let recorded: RecordedPageCaptureFacts;
  try {
    recorded = deps.readRecordedFacts({
      orgId: input.orgId,
      artifactId: filed.artifactId,
      representationRevisionId: filed.representationRevisionId,
      objectType,
    });
  } catch (err) {
    logToolFailure(input, err);
    recorded = { status: "unreadable" };
  }
  if (recorded.status !== "recorded") {
    return { ok: false, reason: "write_refused", error: PAGE_CAPTURE_STORED_FACTS_UNREADABLE_ERROR };
  }
  return {
    ok: true,
    artifactId: filed.artifactId,
    representationRevisionId: filed.representationRevisionId,
    ...recorded.facts,
    deduped: true,
  };
}

/**
 * Calls the lease's release, and never lets it change the answer. The production release never throws (a failed
 * update leaves the lease in flight until its TTL); a release that throws anyway is logged by its class word only.
 */
async function releaseLease(input: CaptureArtifactPageInput, lease: PageCaptureLease): Promise<void> {
  try {
    await lease.release();
  } catch (err) {
    logToolFailure(input, err);
  }
}

/**
 * The resolver's explainer seam, answered with the fixed sentence; the explanation is never logged. It throws only when
 * reading the input's extension for the sentence throws.
 */
async function explainAbsentClaimsFixed(input: CaptureArtifactPageInput): Promise<string> {
  logFixedLine(`[${TOOL}] the install state is incomplete or unreadable; the explanation is not logged`, logFields(input));
  return pageCaptureInstallStateError(input.extension);
}

const LOG_FIELD_KEYS = ["orgId", "runId", "nodeId", "extension"] as const;

/**
 * The input's identifiers for a log line. A field whose read throws or is not a string is logged as "unreadable",
 * so building the fields never throws.
 */
function logFields(input: CaptureArtifactPageInput): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of LOG_FIELD_KEYS) {
    let value: unknown;
    try {
      value = input[key];
    } catch {
      value = undefined;
    }
    fields[key] = typeof value === "string" ? value : "unreadable";
  }
  return fields;
}

/** The tool, the run, the node and the error's class word; never text taken from the error. */
function logToolFailure(input: CaptureArtifactPageInput, err: unknown): void {
  logFailure(`[${TOOL}] failed; the error's own text is not logged`, logFields(input), err);
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
