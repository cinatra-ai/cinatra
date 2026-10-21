import "server-only";

import { producesObjectTypeIdForExtension } from "@cinatra-ai/agents/artifact-binding";

import {
  artifactImageToolDeps,
  fileFirstArtifactWrite,
  type ArtifactImageToolDeps,
} from "@/lib/artifact-image-tool";
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
// There is no per-run cap here: the picture cap bounds provider spend, and a
// capture makes no provider call.
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
  /** The capture's own named refusal, unchanged. */
  | CaptureDegradeReason;

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
    // The capture itself. A refusal keeps the capture's own reason name.
    // ------------------------------------------------------------------
    const captured = await deps.capturePage({ orgId: input.orgId, url: input.url });
    if (!captured.ok) {
      return { ok: false, reason: captured.reason, error: captureDegradeCopy(captured.reason) };
    }

    // The wildcard-aware matcher the canonical writer uses.
    if (!mimeAcceptedByAccepts(resolvedTarget.target.acceptedFileMimeTypes, CAPTURE_MIME)) {
      return {
        ok: false,
        reason: "write_refused",
        error:
          `object type "${resolvedTarget.target.objectTypeId}" (extension "${input.extension}") ` +
          `accepts [${resolvedTarget.target.acceptedFileMimeTypes.join(", ")}]; the captured ` +
          `page is "${CAPTURE_MIME}"`,
      };
    }

    // ------------------------------------------------------------------
    // THE FIRST WRITE: the image tool's ledger road, with the capture's
    // three facts as the object's data and no image provenance on the row.
    // ------------------------------------------------------------------
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
        target: resolvedTarget.target,
        typedData: {
          capturedUrl: input.url,
          viewport: captured.viewport,
          capturedAt: captured.capturedAt,
        },
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
  } catch (err) {
    return {
      ok: false,
      reason: "write_refused",
      error: `filing the page capture failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
