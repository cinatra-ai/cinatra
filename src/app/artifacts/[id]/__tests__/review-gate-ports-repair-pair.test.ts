/**
 * cinatra#2286 S10 (PR1) — `loadPinnedRepairPair`'s SECURITY-SHAPE unit tests.
 *
 * The acceptance criteria's load-bearing invariant: the repair pair's SECOND
 * (successor) target is DERIVED from the repair row `readRepairBySuccessorGateId`
 * resolves off the successor gate id — never supplied by the caller — and is
 * refused (never widened) whenever a caller-passed target disagrees with what
 * that row itself recorded, including a same-org, otherwise-valid, but
 * UNRELATED capture pair. Org+lineage sharing is enforced BY CONSTRUCTION (both
 * targets come off the one `RepairRow`), not by an independent field
 * comparison — so proving the refusal on artifact-id/revision-id mismatch is
 * exactly the negative test the AC calls for.
 *
 * Mocks the two stores this port calls
 * (`@cinatra-ai/agents/lifecycle-repair-store`'s `readRepairBySuccessorGateId`
 * and `@/lib/artifacts/cms-preview-capture-store`'s `readPinnedPreviewCaptures`)
 * so this proves the PORT's own derive/refuse logic, not the underlying stores
 * (already proven by their own suites) — matching the style of
 * `cms-preview-capture-view.test.ts`, which proves the pure pair projection the
 * same way (mocked reads, real pure logic).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cinatra-ai/agents/lifecycle-repair-store", () => ({
  readRepairBySuccessorGateId: vi.fn(),
}));
vi.mock("@/lib/artifacts/cms-preview-capture-store", () => ({
  readPinnedPreviewCaptures: vi.fn(),
}));

import { readRepairBySuccessorGateId, type RepairRow } from "@cinatra-ai/agents/lifecycle-repair-store";
import {
  readPinnedPreviewCaptures,
  type CmsPreviewCaptureRecordData,
  type StoredPreviewCapture,
} from "@/lib/artifacts/cms-preview-capture-store";
import { loadPinnedRepairPair } from "../review-gate-ports";

const readRepair = vi.mocked(readRepairBySuccessorGateId);
const readCaptures = vi.mocked(readPinnedPreviewCaptures);

const ORG = "org-2286";
const OTHER_ORG = "org-other";
const SUCCESSOR_GATE_ID = "gate-successor-1";
const BASE_ARTIFACT = "art-base";
const BASE_REV = "rev-base";
const SUCCESSOR_ARTIFACT = "art-successor";
const SUCCESSOR_REV = "rev-successor";

function repairRow(overrides: Partial<RepairRow> = {}): RepairRow {
  return {
    id: "repair-1",
    lineageId: "lineage-1",
    gateId: "gate-base-1",
    orgId: ORG,
    attempt: 1,
    route: "cms-producer",
    status: "repaired",
    baseArtifactId: BASE_ARTIFACT,
    baseRepresentationRevisionId: BASE_REV,
    expectedBaseRevisionId: BASE_REV,
    findings: [],
    successorGateId: SUCCESSOR_GATE_ID,
    successorArtifactId: SUCCESSOR_ARTIFACT,
    successorRepresentationRevisionId: SUCCESSOR_REV,
    findingOutcomes: null,
    changeSummary: null,
    ...overrides,
  };
}

const baseCaptureData: CmsPreviewCaptureRecordData = {
  role: "current",
  status: "captured",
  degradedReason: null,
  boundArtifactId: BASE_ARTIFACT,
  boundSnapshotRevisionId: BASE_REV,
  sourceOrigin: "https://blog.example.com",
  postId: 42,
  capturedAt: "2026-07-30T10:00:00.000Z",
  geometry: null,
  sanitization: null,
  network: null,
  captureDigest: "a".repeat(64),
  title: "Reviewed post",
};

const successorCaptureData: CmsPreviewCaptureRecordData = {
  ...baseCaptureData,
  role: "repaired",
  boundArtifactId: SUCCESSOR_ARTIFACT,
  boundSnapshotRevisionId: SUCCESSOR_REV,
  title: "Repaired post",
};

function stored(data: CmsPreviewCaptureRecordData, id: string): StoredPreviewCapture {
  return { captureArtifactId: id, representationRevisionId: `png-${id}`, data };
}

/** Route the mocked store read by the bound target — mirrors the real store's
 * per-target keying without needing a real DB. */
function wireCaptures(map: Record<string, StoredPreviewCapture[]>) {
  readCaptures.mockImplementation(({ boundArtifactId }) => map[boundArtifactId] ?? []);
}

beforeEach(() => {
  readRepair.mockReset();
  readCaptures.mockReset();
});

describe("cinatra#2286 S10 — loadPinnedRepairPair security shape", () => {
  it("derives the base target from the repair row and pairs base.current with successor.repaired", async () => {
    readRepair.mockResolvedValue(repairRow());
    wireCaptures({
      [BASE_ARTIFACT]: [stored(baseCaptureData, "cap-base")],
      [SUCCESSOR_ARTIFACT]: [stored(successorCaptureData, "cap-successor")],
    });

    const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, {
      artifactId: SUCCESSOR_ARTIFACT,
      representationRevisionId: SUCCESSOR_REV,
    });

    expect(readRepair).toHaveBeenCalledWith(SUCCESSOR_GATE_ID);
    expect(pair).not.toBeNull();
    expect(pair!.kind).toBe("repair");
    expect(pair!.left!.role).toBe("current");
    expect(pair!.left!.captureArtifactId).toBe("cap-base");
    expect(pair!.right!.role).toBe("repaired");
    expect(pair!.right!.captureArtifactId).toBe("cap-successor");
    // The two reads are independent, single-target, unwidened calls keyed on
    // the row's own coordinates — never a new/combined query shape.
    expect(readCaptures).toHaveBeenCalledTimes(2);
    expect(readCaptures).toHaveBeenCalledWith({
      orgId: ORG,
      boundArtifactId: BASE_ARTIFACT,
      boundSnapshotRevisionId: BASE_REV,
    });
    expect(readCaptures).toHaveBeenCalledWith({
      orgId: ORG,
      boundArtifactId: SUCCESSOR_ARTIFACT,
      boundSnapshotRevisionId: SUCCESSOR_REV,
    });
  });

  it("refuses when the repair row's org disagrees with the caller's org (never trusts a caller-supplied org)", async () => {
    readRepair.mockResolvedValue(repairRow({ orgId: OTHER_ORG }));

    const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, {
      artifactId: SUCCESSOR_ARTIFACT,
      representationRevisionId: SUCCESSOR_REV,
    });

    expect(pair).toBeNull();
    // Refused before either capture read runs — no widened/loosened lookup.
    expect(readCaptures).not.toHaveBeenCalled();
  });

  it("refuses a hand-supplied successor target whose artifactId disagrees with the repair row (same-org, unrelated capture)", async () => {
    readRepair.mockResolvedValue(repairRow());

    const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, {
      artifactId: "art-unrelated",
      representationRevisionId: SUCCESSOR_REV,
    });

    expect(pair).toBeNull();
    expect(readCaptures).not.toHaveBeenCalled();
  });

  it("refuses a hand-supplied successor target whose revision disagrees with the repair row", async () => {
    readRepair.mockResolvedValue(repairRow());

    const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, {
      artifactId: SUCCESSOR_ARTIFACT,
      representationRevisionId: "rev-unrelated",
    });

    expect(pair).toBeNull();
    expect(readCaptures).not.toHaveBeenCalled();
  });

  it("refuses (returns null) when no repair row exists for the successor gate id", async () => {
    readRepair.mockResolvedValue(null);

    const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, {
      artifactId: SUCCESSOR_ARTIFACT,
      representationRevisionId: SUCCESSOR_REV,
    });

    expect(pair).toBeNull();
    expect(readCaptures).not.toHaveBeenCalled();
  });

  it("honest one-sided degrade: only the base has a capture — the pair still renders, right is null", async () => {
    readRepair.mockResolvedValue(repairRow());
    wireCaptures({ [BASE_ARTIFACT]: [stored(baseCaptureData, "cap-base")] });

    const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, {
      artifactId: SUCCESSOR_ARTIFACT,
      representationRevisionId: SUCCESSOR_REV,
    });

    expect(pair).not.toBeNull();
    expect(pair!.left!.role).toBe("current");
    expect(pair!.right).toBeNull();
  });

  it("honest one-sided degrade: only the successor has a capture — the pair still renders, left is null", async () => {
    readRepair.mockResolvedValue(repairRow());
    wireCaptures({ [SUCCESSOR_ARTIFACT]: [stored(successorCaptureData, "cap-successor")] });

    const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, {
      artifactId: SUCCESSOR_ARTIFACT,
      representationRevisionId: SUCCESSOR_REV,
    });

    expect(pair).not.toBeNull();
    expect(pair!.left).toBeNull();
    expect(pair!.right!.role).toBe("repaired");
  });

  it("neither side has a capture at all ⇒ no pair (renders nothing, not an empty frame)", async () => {
    readRepair.mockResolvedValue(repairRow());
    wireCaptures({});

    const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, {
      artifactId: SUCCESSOR_ARTIFACT,
      representationRevisionId: SUCCESSOR_REV,
    });

    expect(pair).toBeNull();
  });

  it("degrades to null on a store read failure (the review is unaffected) — mirrors loadPinnedCapturePair's contract", async () => {
    readRepair.mockResolvedValue(repairRow());
    readCaptures.mockImplementation(() => {
      throw new Error("simulated store failure");
    });

    const pair = await loadPinnedRepairPair(ORG, SUCCESSOR_GATE_ID, {
      artifactId: SUCCESSOR_ARTIFACT,
      representationRevisionId: SUCCESSOR_REV,
    });

    expect(pair).toBeNull();
  });
});
