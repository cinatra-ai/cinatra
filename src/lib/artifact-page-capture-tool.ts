import "server-only";

import { producesObjectTypeIdForExtension } from "@cinatra-ai/agents/artifact-binding";

import {
  artifactImageToolDeps,
  fileFirstArtifactWrite,
  logFilingFailure,
  type ArtifactImageToolDeps,
} from "@/lib/artifact-image-tool";
import { buildPageCaptureFactsRecordQuery } from "@/lib/artifacts/artifact-read";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { isArtifactExtensionWriteAllowed } from "@/lib/artifacts/artifact-extension-access";
import { captureDegradeCopy, type CaptureDegradeReason } from "@/lib/artifacts/cms-preview-capture";
import {
  captureRegisteredPage,
  type CaptureRegisteredPageOutcome,
} from "@/lib/artifacts/registered-page-capture";
import { resolveBoundArtifactTarget } from "@/lib/artifacts/resolve-bound-artifact-type";
import { mimeAcceptedByAccepts } from "@/lib/artifacts/upload-artifact-type-map";

// ---------------------------------------------------------------------------
// THE PAGE CAPTURE TOOL (cinatra#4223, parent #3023).
//
// One deterministic passthrough tool, `artifact_page_capture`: a page url
// in, a PNG of that page filed. The page must belong to one of the org's ACTIVE
// connect-registered sites; it is fetched through the guarded GET, sanitized and
// re-checked, and rendered in the isolated subprocess (`captureRegisteredPage`).
// The PNG is filed as the object type the calling extension declares,
// carrying the three facts the display shows:
// `capturedUrl`, `viewport` and `capturedAt`. The tool names no type itself; the
// target's accepts and its declared schema decide what may be filed.
//
// The write authorization is the image tool's own, asked in the same order: the
// extension is one the run's package declared it produces, the call resolves to
// exactly one declared object type, and the extension is write-allowed for the
// org. The first write is the image tool's ledger road (`fileFirstArtifactWrite`)
// with no image provenance, so a page capture never counts against the per-run
// picture cap.
//
// THE CAPTURE BUDGETS. A capture makes no provider call, but each one renders a
// page in a subprocess and stores its bytes, so a run's captures are bounded on
// their own: at most MAX_PAGE_CAPTURES_PER_RUN captures per run, at most
// MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN of them at once, and at most
// MAX_PAGE_CAPTURE_PNG_BYTES per PNG. Past each limit the call is refused with
// its own reason, before the render (the two run limits) or before the write
// (the size limit). The run limits are counted in this server process.
//
// THE FACTS OF EACH REVISION. The three facts are filed as the object's data
// AND as the revision's own record, in the same transaction, so a view pinned to
// that revision shows the facts it was filed with, whatever the live data says
// later.
//
// NEVER THROWS. Every failure is a returned refusal with its reason. A capture
// refusal keeps the capture's own reason name.
// ---------------------------------------------------------------------------

/** The form a capture produces. */
const CAPTURE_MIME = "image/png";

export type ArtifactPageCaptureRefusal =
  /** The extension is not in the run package's declared `cinatra.produces`. */
  | "not_produced"
  /** The call resolves to no single declared object type. */
  | "type_unresolved"
  /** The write itself was refused (accepts, write-eligibility, the ledger). */
  | "write_refused"
  /** The typed data does not satisfy the target type's declared schema. */
  | "data_rejected"
  /** The run already made MAX_PAGE_CAPTURES_PER_RUN captures. */
  | "run_cap_exceeded"
  /** The run already has MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN captures in flight. */
  | "concurrency_exceeded"
  /** The captured PNG is larger than MAX_PAGE_CAPTURE_PNG_BYTES. */
  | "capture_too_large"
  /** The capture's own named refusal, unchanged. */
  | CaptureDegradeReason;

/** At most this many page captures per run. */
export const MAX_PAGE_CAPTURES_PER_RUN = 20;
/** At most this many page captures of one run at once. */
export const MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN = 2;
/** At most this many bytes per captured PNG (10 MB). */
export const MAX_PAGE_CAPTURE_PNG_BYTES = 10 * 1024 * 1024;

/** How many runs the budget remembers before it forgets the oldest idle one. */
const BUDGET_RUNS_REMEMBERED = 10_000;

export type PageCaptureRunBudget = {
  /** Take one capture of the run's budget, or the limit that refuses it. */
  acquire(
    runId: string,
  ):
    | { ok: true; release: () => void }
    | { ok: false; reason: "run_cap_exceeded" | "concurrency_exceeded" };
};

/** A run budget of its own — one per server process in production. */
export function createPageCaptureRunBudget(
  limits: { perRun: number; concurrent: number } = {
    perRun: MAX_PAGE_CAPTURES_PER_RUN,
    concurrent: MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN,
  },
): PageCaptureRunBudget {
  const runs = new Map<string, { started: number; inFlight: number }>();
  return {
    acquire(runId) {
      let run = runs.get(runId);
      if (!run) {
        if (runs.size >= BUDGET_RUNS_REMEMBERED) {
          for (const [id, r] of runs) {
            if (r.inFlight === 0) {
              runs.delete(id);
              break;
            }
          }
        }
        run = { started: 0, inFlight: 0 };
        runs.set(runId, run);
      }
      if (run.started >= limits.perRun) return { ok: false, reason: "run_cap_exceeded" };
      if (run.inFlight >= limits.concurrent) return { ok: false, reason: "concurrency_exceeded" };
      run.started += 1;
      run.inFlight += 1;
      const held = run;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          held.inFlight -= 1;
        },
      };
    },
  };
}

const processPageCaptureRunBudget = createPageCaptureRunBudget();

const BUDGET_REFUSAL_COPY: Record<"run_cap_exceeded" | "concurrency_exceeded", string> = {
  run_cap_exceeded:
    `this run already made ${MAX_PAGE_CAPTURES_PER_RUN} page captures, the most one run may make`,
  concurrency_exceeded:
    `this run already has ${MAX_CONCURRENT_PAGE_CAPTURES_PER_RUN} page captures in flight, ` +
    "the most one run may have at once; capture the page after one of them ends",
};

/** The fixed text of a capture that stopped on an error outside the write. */
export const PAGE_CAPTURE_UNEXPECTED_ERROR =
  "filing the page capture failed on an unexpected error; the detail is logged on the server";

export type ArtifactPageCaptureResult =
  | {
      ok: true;
      artifactId: string;
      representationRevisionId: string;
      capturedUrl: string;
      viewport: { width: number; height: number };
      capturedAt: string;
      /** true when this exact node already filed these exact bytes. */
      deduped: boolean;
    }
  | { ok: false; reason: ArtifactPageCaptureRefusal; error: string };

/** The seams a caller may replace: the run package's two reads and the capture. */
export type ArtifactPageCaptureToolDeps = Pick<
  ArtifactImageToolDeps,
  "loadProducesRefs" | "resolveOwnership"
> & {
  capturePage: (input: { orgId: string; url: string }) => Promise<CaptureRegisteredPageOutcome>;
  /** The run budget; the server process's own when omitted. */
  budget?: PageCaptureRunBudget;
};

/** The production seam set — what the deterministic passthrough dispatches with. */
export function artifactPageCaptureToolDeps(): ArtifactPageCaptureToolDeps {
  const imageDeps = artifactImageToolDeps();
  return {
    loadProducesRefs: imageDeps.loadProducesRefs,
    resolveOwnership: imageDeps.resolveOwnership,
    capturePage: (i) => captureRegisteredPage({ orgId: i.orgId, url: i.url }),
  };
}

export type CaptureArtifactPageInput = {
  runId: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  /** The run's runBy principal — persisted as the artifact's createdBy. */
  createdBy: string | null;
  /** The calling node's id — the ledger's output identity. */
  nodeId: string;
  /** The artifact extension the filed picture belongs to. */
  extension: string;
  /** The filed picture's title. */
  title: string;
  /** The absolute url of the page to capture, on a connect-registered site. */
  url: string;
};

export async function captureArtifactPage(
  input: CaptureArtifactPageInput,
  deps: ArtifactPageCaptureToolDeps = artifactPageCaptureToolDeps(),
): Promise<ArtifactPageCaptureResult> {
  try {
    // ------------------------------------------------------------------
    // The write authorization, asked of the SAME facts the image tool asks of.
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
          "page-capture filing must agree",
      };
    }

    registerAllObjectTypes();
    const resolvedTarget = await resolveBoundArtifactTarget({
      orgId: input.orgId,
      extension: input.extension,
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
    // The run's capture budget, taken before the render and held until the
    // capture is filed or refused.
    // ------------------------------------------------------------------
    const slot = (deps.budget ?? processPageCaptureRunBudget).acquire(input.runId);
    if (!slot.ok) {
      return { ok: false, reason: slot.reason, error: BUDGET_REFUSAL_COPY[slot.reason] };
    }
    try {
      return await captureAndFile(input, deps, resolvedTarget.target);
    } finally {
      slot.release();
    }
  } catch (err) {
    logFilingFailure("artifact_page_capture", input, err);
    return { ok: false, reason: "write_refused", error: PAGE_CAPTURE_UNEXPECTED_ERROR };
  }
}

async function captureAndFile(
  input: CaptureArtifactPageInput,
  deps: ArtifactPageCaptureToolDeps,
  target: Parameters<typeof fileFirstArtifactWrite>[0]["target"],
): Promise<ArtifactPageCaptureResult> {
  // ------------------------------------------------------------------
  // The capture itself. A refusal keeps the capture's own reason name.
  // ------------------------------------------------------------------
  const captured = await deps.capturePage({ orgId: input.orgId, url: input.url });
  if (!captured.ok) {
    return { ok: false, reason: captured.reason, error: captureDegradeCopy(captured.reason) };
  }
  if (captured.png.byteLength > MAX_PAGE_CAPTURE_PNG_BYTES) {
    return {
      ok: false,
      reason: "capture_too_large",
      error:
        `the captured page is ${captured.png.byteLength} bytes; a page capture may be at ` +
        `most ${MAX_PAGE_CAPTURE_PNG_BYTES} bytes (10 MB)`,
    };
  }

  // The wildcard-aware matcher the canonical writer uses.
  if (!mimeAcceptedByAccepts(target.acceptedFileMimeTypes, CAPTURE_MIME)) {
    return {
      ok: false,
      reason: "write_refused",
      error:
        `object type "${target.objectTypeId}" (extension "${input.extension}") ` +
        `accepts [${target.acceptedFileMimeTypes.join(", ")}]; the captured ` +
        `page is "${CAPTURE_MIME}"`,
    };
  }

  // ------------------------------------------------------------------
  // THE FIRST WRITE: the image tool's ledger road, with the capture's
  // three facts as the object's data and no image provenance on the row.
  // ------------------------------------------------------------------
  const facts = {
    capturedUrl: input.url,
    viewport: captured.viewport,
    capturedAt: captured.capturedAt,
  };
  const filed = await fileFirstArtifactWrite(
    {
      orgId: input.orgId,
      runId: input.runId,
      templateId: input.templateId,
      nodeId: input.nodeId,
      extension: input.extension,
      createdBy: input.createdBy,
      title: input.title,
      bytes: captured.png,
      mime: CAPTURE_MIME,
      target,
      typedData: facts,
      // The revision's own record of its facts, in the transaction that files it.
      extraFinalizeQueries: (_ledgerId, ids) => [
        buildPageCaptureFactsRecordQuery({
          orgId: input.orgId,
          artifactId: ids.artifactId,
          representationRevisionId: ids.representationRevisionId,
          facts,
        }),
      ],
    },
    deps,
  );
  if (!filed.ok) return filed;
  return {
    ok: true,
    artifactId: filed.artifactId,
    representationRevisionId: filed.representationRevisionId,
    capturedUrl: input.url,
    viewport: captured.viewport,
    capturedAt: captured.capturedAt,
    deduped: filed.deduped,
  };
}
