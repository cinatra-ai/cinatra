/**
 * cinatra#4264 slice B1b: the PRODUCTION repair reader of the segment
 * classification and of the resume refusal (no injected reader).
 *
 * `classifyRegenerateSegmentRun` and `refuseRegenerateSegmentResume`, called
 * without deps, read the repair row through `readRepair` of the repair store.
 * The row's `regenerate_node_id` must reach the decision: a set one is a
 * segment (never resumed), a NULL one is an ordinary repair, and a missing row
 * leaves the segment identity unknown, so the run is unreadable and is never
 * resumed. A reader that always exposed a NULL intent fails the first case.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  readRepair: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../lifecycle-repair-store", () => ({
  readRepair: store.readRepair,
}));
vi.mock("@/lib/artifacts/regenerate-provenance", () => ({
  readVerifiedFilingNode: vi.fn(async () => null),
}));
vi.mock("../db", () => ({ db: {} }));

import {
  REGENERATE_SEGMENT_NOT_RESUMABLE,
  classifyRegenerateSegmentRun,
  refuseRegenerateSegmentResume,
} from "../regenerate-segment";

const RUN = "lifecycle-repair-run:repair-1";
const REPAIR_RUN = { id: RUN, sourceType: "lifecycle_repair" };

function repairRow(regenerateNodeId: string | null): Record<string, unknown> {
  return {
    id: "repair-1",
    orgId: "org-1",
    regenerateNodeId,
    baseArtifactId: "artifact-1",
    baseRepresentationRevisionId: "revision-1",
  };
}

beforeEach(() => {
  store.row = null;
  store.readRepair.mockReset();
  store.readRepair.mockImplementation(async () => store.row);
});

describe("the production repair reader of the segment classification", () => {
  it("reads the named repair and exposes its Regenerate intent", async () => {
    store.row = repairRow("file_image");
    expect(await classifyRegenerateSegmentRun(REPAIR_RUN)).toBe("segment");
    expect(store.readRepair).toHaveBeenCalledWith("repair-1");
    await expect(refuseRegenerateSegmentResume(RUN)).rejects.toThrow(REGENERATE_SEGMENT_NOT_RESUMABLE);
  });

  it("keeps a readable repair with a NULL intent ordinary and resumable", async () => {
    store.row = repairRow(null);
    expect(await classifyRegenerateSegmentRun(REPAIR_RUN)).toBe("ordinary");
    await expect(refuseRegenerateSegmentResume(RUN)).resolves.toBeUndefined();
  });

  it("fails closed on a missing repair row", async () => {
    store.row = null;
    expect(await classifyRegenerateSegmentRun(REPAIR_RUN)).toBe("unreadable");
    await expect(refuseRegenerateSegmentResume(RUN)).rejects.toThrow(REGENERATE_SEGMENT_NOT_RESUMABLE);
  });

  it("answers a run that is not a repair run without a read", async () => {
    expect(await classifyRegenerateSegmentRun({ id: "run-plain", sourceType: "lifecycle_repair" })).toBe("ordinary");
    await expect(refuseRegenerateSegmentResume("run-plain")).resolves.toBeUndefined();
    expect(store.readRepair).not.toHaveBeenCalled();
  });
});
