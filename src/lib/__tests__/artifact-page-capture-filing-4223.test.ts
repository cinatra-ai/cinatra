/**
 * cinatra#4223: THE PAGE CAPTURE TOOL'S FIRST WRITE READS ITS FIELDS WHERE IT
 * READ THEM BEFORE THE ROAD WAS SHARED.
 *
 * The creator and the title are read only on the writer road, after the
 * ledger claim, so a re-drive served by the first write never reads them. A
 * failed write is logged with the tool's own log fields, so a field that is
 * not a string is logged as "unreadable".
 *
 * PURE TIER. The ledger claim and the artifact write are spies; the capture is
 * a supplied seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resolveBoundArtifactTarget: vi.fn(),
  isArtifactExtensionWriteAllowed: vi.fn(async () => true),
  claimMaterialization: vi.fn(),
  readFinalizedMaterialization: vi.fn(),
  createSemanticArtifact: vi.fn(),
  enqueueArtifactMatchRun: vi.fn(async () => undefined),
}));

vi.mock("@/lib/artifacts/resolve-bound-artifact-type", () => ({
  resolveBoundArtifactTarget: h.resolveBoundArtifactTarget,
}));
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: h.isArtifactExtensionWriteAllowed,
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));
vi.mock("@/lib/artifacts/materialization-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/materialization-ledger")>()),
  claimMaterialization: h.claimMaterialization,
  readFinalizedMaterialization: h.readFinalizedMaterialization,
}));
vi.mock("@/lib/artifacts/artifact-creation", () => ({ createSemanticArtifact: h.createSemanticArtifact }));
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({ enqueueArtifactMatchRun: h.enqueueArtifactMatchRun }));

import {
  captureArtifactPage,
  PAGE_CAPTURE_WRITE_FAILED_ERROR,
  type ArtifactPageCaptureToolDeps,
} from "@/lib/artifact-page-capture-tool";

const EXT = "@cinatra-ai/screenshot-artifact";
const SHOT_TYPE = "@cinatra-ai/screenshot-artifact:screenshot";
const PAGE_URL = "https://blog.example.com/about/";
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const OLD = { capturedUrl: PAGE_URL, viewport: { width: 1280, height: 900 }, capturedAt: "2026-10-16T08:00:00.000Z" };

const call = {
  runId: "run-1",
  orgId: "org-1",
  templateId: "tpl-1",
  packageVersion: "1.0.0",
  createdBy: "user-1",
  nodeId: "capture_page",
  extension: EXT,
  title: "The about page",
  url: PAGE_URL,
};

function toolDeps(): ArtifactPageCaptureToolDeps {
  return {
    loadProducesRefs: async () => [{ extension: EXT, objectTypeId: SHOT_TYPE }],
    resolveOwnership: async () => ({
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
      projectId: null,
    }),
    capturePage: async () => ({
      ok: true,
      png: PNG,
      viewport: { width: 1280, height: 900 },
      capturedAt: "2026-10-17T16:30:00.000Z",
    }),
    acquireLease: async () => ({ ok: true, lease: { leaseId: "lease-1", release: async () => undefined } }),
    readRecordedFacts: () => ({ status: "recorded", facts: OLD }),
  };
}

let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
  h.resolveBoundArtifactTarget.mockResolvedValue({
    ok: true,
    target: { objectTypeId: SHOT_TYPE, acceptedFileMimeTypes: ["image/png"] },
  });
  h.isArtifactExtensionWriteAllowed.mockResolvedValue(true);
  h.claimMaterialization.mockResolvedValue({ kind: "claimed", ledgerId: "ledger-1" });
});

afterEach(() => {
  logged.mockRestore();
  vi.clearAllMocks();
});

describe("cinatra#4223 page capture: the shared first write reads the tool's fields where the tool read them", () => {
  it("reads no writer-only field on a re-drive: a createdBy or title getter that throws is not reached", async () => {
    h.claimMaterialization.mockResolvedValueOnce({
      kind: "finalized",
      artifactId: "art-0",
      representationRevisionId: "rev-0",
      path: "materialize_tool",
    });
    const input: typeof call = { ...call };
    for (const key of ["createdBy", "title"] as const) {
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          throw new Error("connect ECONNREFUSED writer-field-secret-host:5432");
        },
      });
    }
    const outcome = await captureArtifactPage(input, toolDeps());
    expect(outcome).toEqual({ ok: true, artifactId: "art-0", representationRevisionId: "rev-0", ...OLD, deduped: true });
    expect(h.createSemanticArtifact).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });

  it("a write failure logs a node id that is not a string as unreadable, through the tool's own log fields", async () => {
    const input = { ...call, nodeId: new Error("node-field-secret") as unknown as string };
    h.createSemanticArtifact.mockRejectedValueOnce(new Error("write failed"));
    const outcome = await captureArtifactPage(input, toolDeps());
    expect(outcome).toEqual({ ok: false, reason: "write_refused", error: PAGE_CAPTURE_WRITE_FAILED_ERROR });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("[artifact_page_capture] failed; the error's own text is not logged", {
      orgId: "org-1",
      runId: "run-1",
      nodeId: "unreadable",
      extension: EXT,
      errorClass: "Error",
    });
  });
});
