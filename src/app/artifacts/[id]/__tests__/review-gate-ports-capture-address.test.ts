/**
 * The ADDRESS of a pinned capture's picture on the review gate's two pair
 * loaders: `loadPinnedCapturePair` (the ordinary comparison) and
 * `loadPinnedRepairPair` (the repair's base side and successor side).
 *
 * Each loader hands the capture view the projection module's version-pinned
 * address as the second argument of `buildPinnedCaptureViews`, at each of its
 * three calls. These cases read the `imageUrl` the REAL view produces from
 * mocked store reads, so they pin three things:
 *   - an admitted id, reserved characters included, gets exactly the address
 *     `reviewTargetVersionPath` composes (written out literally below);
 *   - an id the module refuses (empty, `.` or `..`, ill-formed text) gets no
 *     address on a captured side, and the other side keeps its own;
 *   - each of the three calls carries the port's own address: the view's
 *     default is a path (or a throw) for a refused id, so a call that leaves
 *     the default in place turns its own cases red.
 *
 * The two stores are mocked in the style of `review-gate-ports-repair-pair.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cinatra-ai/agents/lifecycle-repair-store", () => ({
  readRepairBySuccessorGateId: vi.fn(),
}));
vi.mock("@/lib/artifacts/cms-preview-capture-store", () => ({
  readPinnedPreviewCaptures: vi.fn(),
}));

import { reviewTargetVersionPath } from "@cinatra-ai/agent-ui-protocol/renderable-views/lifecycle-cards";
import { readRepairBySuccessorGateId, type RepairRow } from "@cinatra-ai/agents/lifecycle-repair-store";
import {
  readPinnedPreviewCaptures,
  type CmsPreviewCaptureRecordData,
  type StoredPreviewCapture,
} from "@/lib/artifacts/cms-preview-capture-store";
import { pinnedCaptureImageUrl } from "@/lib/artifacts/cms-preview-capture-view";
import { loadPinnedCapturePair, loadPinnedRepairPair } from "../review-gate-ports";

const readRepair = vi.mocked(readRepairBySuccessorGateId);
const readCaptures = vi.mocked(readPinnedPreviewCaptures);

const ORG = "org-capture-address";
const SUCCESSOR_GATE_ID = "gate-successor-1";
const TARGET = { artifactId: "art-target", representationRevisionId: "rev-target" };
const BASE = { artifactId: "art-base", representationRevisionId: "rev-base" };
const SUCCESSOR = { artifactId: "art-successor", representationRevisionId: "rev-successor" };

type Bound = { artifactId: string; representationRevisionId: string };

/** Each refusal of the projection module, as [what it is, capture id, capture revision id]. */
const REFUSED_CASES: Array<[string, string, string]> = [
  ["an empty capture id", "", "png-ok"],
  ["a dot segment capture id", ".", "png-ok"],
  ["a dot-dot capture revision id", "cap-ok", ".."],
  ["an ill-formed capture id", "\uD800", "png-ok"],
];

function captureData(role: CmsPreviewCaptureRecordData["role"], bound: Bound): CmsPreviewCaptureRecordData {
  return {
    role,
    status: "captured",
    degradedReason: null,
    boundArtifactId: bound.artifactId,
    boundSnapshotRevisionId: bound.representationRevisionId,
    sourceOrigin: "https://blog.example.com",
    postId: 7,
    capturedAt: "2026-07-30T10:00:00.000Z",
    geometry: null,
    sanitization: null,
    network: null,
    captureDigest: "b".repeat(64),
    title: "A post",
  };
}

function stored(
  role: CmsPreviewCaptureRecordData["role"],
  bound: Bound,
  captureArtifactId: string,
  representationRevisionId: string,
): StoredPreviewCapture {
  return { captureArtifactId, representationRevisionId, data: captureData(role, bound) };
}

function repairRow(): RepairRow {
  return {
    id: "repair-1",
    lineageId: "lineage-1",
    gateId: "gate-base-1",
    orgId: ORG,
    attempt: 1,
    route: "cms-producer",
    status: "repaired",
    baseArtifactId: BASE.artifactId,
    baseRepresentationRevisionId: BASE.representationRevisionId,
    expectedBaseRevisionId: BASE.representationRevisionId,
    findings: [],
    successorGateId: SUCCESSOR_GATE_ID,
    successorArtifactId: SUCCESSOR.artifactId,
    successorRepresentationRevisionId: SUCCESSOR.representationRevisionId,
    findingOutcomes: null,
    changeSummary: null,
  };
}

/** Route the mocked store read by the bound target, as the real store keys it. */
function wireCaptures(map: Record<string, StoredPreviewCapture[]>) {
  readCaptures.mockImplementation(({ boundArtifactId }) => map[boundArtifactId] ?? []);
}

/** The projection module's own address for an admitted pair of ids. */
function versionPath(captureArtifactId: string, representationRevisionId: string): string {
  const path = reviewTargetVersionPath(captureArtifactId, representationRevisionId, "preview");
  if (!path.ok) throw new Error(`the projection module refused ${captureArtifactId} / ${representationRevisionId}`);
  return path.value;
}

beforeEach(() => {
  readRepair.mockReset();
  readCaptures.mockReset();
});

describe("the pinned capture address on the review gate's pair loaders", () => {
  it("the view's default is a path, or a throw, for each id the projection module refuses", () => {
    expect(pinnedCaptureImageUrl("", "png-ok")).toBe("/api/artifacts//versions/png-ok/preview");
    expect(pinnedCaptureImageUrl(".", "png-ok")).toBe("/api/artifacts/./versions/png-ok/preview");
    expect(pinnedCaptureImageUrl("cap-ok", "..")).toBe("/api/artifacts/cap-ok/versions/../preview");
    expect(() => pinnedCaptureImageUrl("\uD800", "png-ok")).toThrow(URIError);
    for (const [name, captureArtifactId, representationRevisionId] of REFUSED_CASES) {
      expect(reviewTargetVersionPath(captureArtifactId, representationRevisionId, "preview").ok, name).toBe(false);
    }
  });

  it("an admitted id with reserved characters gets the module's exact address on both sides of the ordinary pair", () => {
    wireCaptures({
      [TARGET.artifactId]: [
        stored("before", TARGET, "cap/before?1", "png#before%"),
        stored("current", TARGET, "cap current", "png:current&x"),
      ],
    });

    const pair = loadPinnedCapturePair(ORG, TARGET, "review");

    expect(pair).not.toBeNull();
    expect(pair!.left!.imageUrl).toBe("/api/artifacts/cap%2Fbefore%3F1/versions/png%23before%25/preview");
    expect(pair!.right!.imageUrl).toBe("/api/artifacts/cap%20current/versions/png%3Acurrent%26x/preview");
    expect(pair!.left!.imageUrl).toBe(versionPath("cap/before?1", "png#before%"));
    expect(pair!.right!.imageUrl).toBe(versionPath("cap current", "png:current&x"));
  });

  it.each(REFUSED_CASES)(
    "%s leaves a captured side of the ordinary pair without an address, and the other side keeps its own",
    (name, captureArtifactId, representationRevisionId) => {
      wireCaptures({
        [TARGET.artifactId]: [
          stored("before", TARGET, captureArtifactId, representationRevisionId),
          stored("current", TARGET, "cap-current", "png-current"),
        ],
      });

      const pair = loadPinnedCapturePair(ORG, TARGET, "review");

      expect(pair, name).not.toBeNull();
      expect(pair!.left!.status, name).toBe("captured");
      expect(pair!.left!.imageUrl, name).toBeNull();
      expect(pair!.right!.imageUrl, name).toBe("/api/artifacts/cap-current/versions/png-current/preview");
    },
  );

  it("an admitted id with reserved characters gets the module's exact address on the repair's base side and successor side", async () => {
    readRepair.mockResolvedValue(repairRow());
    wireCaptures({
      [BASE.artifactId]: [stored("current", BASE, "cap/base", "png?base")],
      [SUCCESSOR.artifactId]: [stored("repaired", SUCCESSOR, "cap#successor", "png%successor")],
    });

    const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, SUCCESSOR);

    expect(pair).not.toBeNull();
    expect(pair!.left!.imageUrl).toBe("/api/artifacts/cap%2Fbase/versions/png%3Fbase/preview");
    expect(pair!.right!.imageUrl).toBe("/api/artifacts/cap%23successor/versions/png%25successor/preview");
    expect(pair!.left!.imageUrl).toBe(versionPath("cap/base", "png?base"));
    expect(pair!.right!.imageUrl).toBe(versionPath("cap#successor", "png%successor"));
  });

  it.each(REFUSED_CASES)(
    "%s on the repair's base side alone leaves that side without an address, and the successor side keeps its own",
    async (name, captureArtifactId, representationRevisionId) => {
      readRepair.mockResolvedValue(repairRow());
      wireCaptures({
        [BASE.artifactId]: [stored("current", BASE, captureArtifactId, representationRevisionId)],
        [SUCCESSOR.artifactId]: [stored("repaired", SUCCESSOR, "cap-successor", "png-successor")],
      });

      const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, SUCCESSOR);

      expect(pair, name).not.toBeNull();
      expect(pair!.left!.status, name).toBe("captured");
      expect(pair!.left!.imageUrl, name).toBeNull();
      expect(pair!.right!.imageUrl, name).toBe("/api/artifacts/cap-successor/versions/png-successor/preview");
    },
  );

  it.each(REFUSED_CASES)(
    "%s on the repair's successor side alone leaves that side without an address, and the base side keeps its own",
    async (name, captureArtifactId, representationRevisionId) => {
      readRepair.mockResolvedValue(repairRow());
      wireCaptures({
        [BASE.artifactId]: [stored("current", BASE, "cap-base", "png-base")],
        [SUCCESSOR.artifactId]: [stored("repaired", SUCCESSOR, captureArtifactId, representationRevisionId)],
      });

      const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, SUCCESSOR);

      expect(pair, name).not.toBeNull();
      expect(pair!.left!.imageUrl, name).toBe("/api/artifacts/cap-base/versions/png-base/preview");
      expect(pair!.right!.status, name).toBe("captured");
      expect(pair!.right!.imageUrl, name).toBeNull();
    },
  );
});
